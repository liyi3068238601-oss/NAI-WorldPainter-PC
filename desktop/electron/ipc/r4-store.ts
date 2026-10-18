import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AgentWorkspaceData } from "../../src/agent/types";
import {
  createEmptyR4AgentState,
  normalizeR4AgentState,
  type R4AgentState,
} from "../../src/agent/r4-types";
import { validateR4ExecutionSemantics } from "../../src/agent/r4-execution-semantics";

const DATABASE_VERSION = 1;
const WORKSPACE_ROW_ID = 1;

export interface AgentSqlInitialState {
  workspace: AgentWorkspaceData;
  r4State?: R4AgentState;
}

export interface AgentSqlStoreOptions {
  filename: string;
  /** The JSON file and its two recovery generations are immutable migration sources. */
  legacyFiles: string[];
  loadInitialState: () => AgentSqlInitialState;
  normalizeWorkspace: (value: unknown, preserveRuntimeStatus?: boolean) => AgentWorkspaceData;
}

export interface AgentSqlTransaction {
  getWorkspace(): AgentWorkspaceData;
  setWorkspace(workspace: AgentWorkspaceData): void;
  getR4State(): R4AgentState;
  setR4State(state: R4AgentState): void;
}

interface StoreRow {
  workspace_json: string;
  workspace_revision: number;
  r4_json: string;
  r4_revision: number;
}

function stableJson(value: unknown) {
  return JSON.stringify(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function fileFingerprint(files: string[]) {
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    hash.update(path.basename(file));
    hash.update("\0");
    try {
      const bytes = fs.readFileSync(file);
      hash.update(String(bytes.length));
      hash.update("\0");
      hash.update(bytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      hash.update("missing");
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

function fsyncFile(file: string) {
  const fd = fs.openSync(file, "r+");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function setupDatabase(db: DatabaseSync) {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA busy_timeout = 5000");
  // DELETE journaling leaves a single portable database file for workspace
  // migration snapshots; SQLite still recovers an interrupted transaction.
  db.exec("PRAGMA journal_mode = DELETE");
}

function createSchema(db: DatabaseSync, initial: AgentSqlInitialState, fingerprint: string) {
  const workspaceJson = stableJson(initial.workspace);
  const r4 = normalizeR4AgentState(initial.r4State ?? createEmptyR4AgentState());
  db.exec("BEGIN EXCLUSIVE");
  try {
    db.exec(`
      CREATE TABLE agent_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        workspace_json TEXT NOT NULL,
        workspace_revision INTEGER NOT NULL,
        r4_json TEXT NOT NULL,
        r4_revision INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE store_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE r4_submission_keys (
        submission_key TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL UNIQUE,
        input_fingerprint TEXT NOT NULL
      );
      CREATE TABLE r4_output_slots (
        execution_id TEXT NOT NULL,
        output_index INTEGER NOT NULL CHECK (output_index >= 0),
        status TEXT NOT NULL,
        PRIMARY KEY (execution_id, output_index)
      );
      PRAGMA user_version = ${DATABASE_VERSION};
    `);
    db.prepare(`INSERT INTO agent_state
      (id, workspace_json, workspace_revision, r4_json, r4_revision, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(WORKSPACE_ROW_ID, workspaceJson, 1, stableJson(r4), 1, new Date().toISOString());
    db.prepare("INSERT INTO store_meta (key, value) VALUES (?, ?)")
      .run("legacy_workspace_fingerprint", fingerprint);
    rebuildExecutionIndexes(db, r4);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* keep the original error */ }
    throw error;
  }
}

function rebuildExecutionIndexes(db: DatabaseSync, state: R4AgentState) {
  db.exec("DELETE FROM r4_submission_keys; DELETE FROM r4_output_slots;");
  const keyInsert = db.prepare(`INSERT INTO r4_submission_keys
    (submission_key, execution_id, input_fingerprint) VALUES (?, ?, ?)`);
  const outputInsert = db.prepare(`INSERT INTO r4_output_slots
    (execution_id, output_index, status) VALUES (?, ?, ?)`);
  for (const [recordId, execution] of Object.entries(state.executions)) {
    if (execution.id !== recordId) throw new Error("R4 execution 映射键与 ID 不一致。");
    const semantic = validateR4ExecutionSemantics(execution);
    if (!semantic.valid) {
      throw new Error(`Execution ${execution.id} 不满足持久语义 ${semantic.issues[0].code}：${semantic.issues[0].message}`);
    }
    keyInsert.run(execution.submissionKey, execution.id, execution.inputFingerprint);
    if (execution.outputs.length !== execution.expectedOutputCount) {
      throw new Error(`Execution ${execution.id} 的输出槽数量与 expectedOutputCount 不一致。`);
    }
    const seen = new Set<number>();
    for (const output of execution.outputs) {
      if (!Number.isSafeInteger(output.outputIndex) || output.outputIndex < 0 || output.outputIndex >= execution.expectedOutputCount || seen.has(output.outputIndex)) {
        throw new Error(`Execution ${execution.id} 的 outputIndex 无效或重复。`);
      }
      seen.add(output.outputIndex);
      outputInsert.run(execution.id, output.outputIndex, output.status);
    }
    if (seen.size !== execution.expectedOutputCount) throw new Error(`Execution ${execution.id} 的输出槽未连续预分配。`);
  }
}

function assertExpectedSchema(db: DatabaseSync) {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  if (row?.user_version !== DATABASE_VERSION) {
    throw new Error(`Agent SQLite 数据库版本 ${String(row?.user_version)} 暂不支持，原数据库与 JSON 备份均已保留。`);
  }
  const integrity = db.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
  if (integrity?.quick_check !== "ok") throw new Error("Agent SQLite 完整性检查失败，原数据库与 JSON 备份均已保留。");
  const rowExists = db.prepare("SELECT 1 AS present FROM agent_state WHERE id = ?").get(WORKSPACE_ROW_ID);
  if (!rowExists) throw new Error("Agent SQLite 状态行缺失，原数据库与 JSON 备份均已保留。");
}

function readStoreRow(db: DatabaseSync): StoreRow {
  const row = db.prepare(`SELECT workspace_json, workspace_revision, r4_json, r4_revision
    FROM agent_state WHERE id = ?`).get(WORKSPACE_ROW_ID) as StoreRow | undefined;
  if (!row) throw new Error("Agent SQLite 状态行缺失，原数据库与 JSON 备份均已保留。");
  return row;
}

function validatePersistedSnapshot(
  db: DatabaseSync,
  normalizeWorkspace: AgentSqlStoreOptions["normalizeWorkspace"],
) {
  const row = readStoreRow(db);
  normalizeWorkspace(JSON.parse(row.workspace_json), true);
  const state = normalizeR4AgentState(JSON.parse(row.r4_json));
  for (const [recordId, execution] of Object.entries(state.executions)) {
    if (execution.id !== recordId) throw new Error("R4 execution 映射键与 ID 不一致，原数据库与 JSON 均已保留。");
    const semantic = validateR4ExecutionSemantics(execution);
    if (!semantic.valid) {
      throw new Error(`Execution ${execution.id} 不满足持久语义 ${semantic.issues[0].code}：${semantic.issues[0].message}`);
    }
  }
  const expectedKeys = Object.values(state.executions).length;
  const keys = db.prepare("SELECT COUNT(*) AS count FROM r4_submission_keys").get() as { count: number };
  const slots = db.prepare("SELECT COUNT(*) AS count FROM r4_output_slots").get() as { count: number };
  const expectedSlots = Object.values(state.executions).reduce((sum, execution) => sum + execution.expectedOutputCount, 0);
  if (keys.count !== expectedKeys || slots.count !== expectedSlots) {
    throw new Error("Agent SQLite execution 索引与状态快照不一致，原数据库与 JSON 均保留。");
  }
}

function validateExistingDatabase(
  db: DatabaseSync,
  options: AgentSqlStoreOptions,
  normalizeWorkspace: AgentSqlStoreOptions["normalizeWorkspace"],
) {
  assertExpectedSchema(db);
  const saved = db.prepare("SELECT value FROM store_meta WHERE key = ?").get("legacy_workspace_fingerprint") as { value?: string } | undefined;
  const currentFingerprint = fileFingerprint(options.legacyFiles);
  if (!saved?.value || saved.value !== currentFingerprint) {
    throw new Error("原 Agent JSON 在 SQLite 迁移后发生变化；为避免覆盖任一版本的数据，数据库和 JSON 均保留且已停止写入。");
  }
  validatePersistedSnapshot(db, normalizeWorkspace);
}

/**
 * The transaction is synchronous and serializes Agent workspace plus R4 state
 * in one SQLite commit. Do not call store-level write helpers from inside the
 * callback; mutate the transaction values and set them before returning.
 */
export class AgentSqlStore {
  readonly filename: string;
  private readonly db: DatabaseSync;
  private readonly normalizeWorkspace: AgentSqlStoreOptions["normalizeWorkspace"];
  private transactionActive = false;

  constructor(options: AgentSqlStoreOptions) {
    this.filename = path.resolve(options.filename);
    this.normalizeWorkspace = options.normalizeWorkspace;
    fs.mkdirSync(path.dirname(this.filename), { recursive: true });
    if (!fs.existsSync(this.filename)) {
      const staleInitializations = fs.readdirSync(path.dirname(this.filename))
        .filter((name) => name.startsWith(`${path.basename(this.filename)}.initializing-`));
      if (staleInitializations.length) {
        throw new Error("发现未完成的 Agent SQLite 初始化文件；数据库与旧 JSON 均已保留，请先检查恢复文件。");
      }
      this.initializeAtomically(options);
    }
    // Do not run writable SQLite pragmas against a future or corrupt database.
    // Validate it through a read-only handle first so fail-closed startup does
    // not rewrite user bytes merely by trying to open the application.
    const validationDb = new DatabaseSync(this.filename, { readOnly: true });
    try {
      validateExistingDatabase(validationDb, options, this.normalizeWorkspace);
    } finally {
      validationDb.close();
    }
    this.db = new DatabaseSync(this.filename);
    setupDatabase(this.db);
    try {
      validateExistingDatabase(this.db, options, this.normalizeWorkspace);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private initializeAtomically(options: AgentSqlStoreOptions) {
    const initial = options.loadInitialState();
    const fingerprint = fileFingerprint(options.legacyFiles);
    const staging = `${this.filename}.initializing-${crypto.randomUUID()}`;
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(staging);
      setupDatabase(db);
      createSchema(db, initial, fingerprint);
      assertExpectedSchema(db);
      db.close();
      db = undefined;
      fsyncFile(staging);
      // Never replace an existing database; another instance may have won startup.
      fs.renameSync(staging, this.filename);
    } catch (error) {
      try { db?.close(); } catch { /* preserve initialization error */ }
      try { if (fs.existsSync(staging)) fs.unlinkSync(staging); } catch { /* retain a failed recovery file */ }
      throw error;
    }
  }

  private readRow(): StoreRow {
    return readStoreRow(this.db);
  }

  readWorkspace(): AgentWorkspaceData {
    const row = this.readRow();
    // Snapshots were normalized on import/write. Re-normalizing on every read
    // would regenerate derived timestamps and make reads observably mutating.
    return clone(JSON.parse(row.workspace_json) as AgentWorkspaceData);
  }

  writeWorkspace(workspace: AgentWorkspaceData): AgentWorkspaceData {
    return this.transaction((tx) => {
      tx.setWorkspace(workspace);
      return tx.getWorkspace();
    });
  }

  readR4State(): R4AgentState {
    return normalizeR4AgentState(JSON.parse(this.readRow().r4_json));
  }

  writeR4State(state: R4AgentState): R4AgentState {
    return this.transaction((tx) => {
      tx.setR4State(state);
      return tx.getR4State();
    });
  }

  transaction<T>(callback: (tx: AgentSqlTransaction) => T): T {
    if (this.transactionActive) throw new Error("AgentSqlStore.transaction 不能嵌套；请在同一个 tx 中读写 workspace 与 R4 state。");
    this.transactionActive = true;
    let began = false;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      began = true;
      let workspace = this.readWorkspace();
      let r4State = this.readR4State();
      let workspaceChanged = false;
      let r4Changed = false;
      const tx: AgentSqlTransaction = {
        getWorkspace: () => clone(workspace),
        setWorkspace: (next) => {
          workspace = clone(this.normalizeWorkspace(next, true));
          workspaceChanged = true;
        },
        getR4State: () => clone(r4State),
        setR4State: (next) => {
          r4State = normalizeR4AgentState(next);
          r4State.updatedAt = new Date().toISOString();
          r4Changed = true;
        },
      };
      const result = callback(tx);
      if (result && typeof (result as { then?: unknown }).then === "function") {
        throw new Error("AgentSqlStore.transaction 回调必须同步完成，不能跨 await 保持写锁。");
      }
      if (workspaceChanged || r4Changed) {
        const current = this.readRow();
        this.db.prepare(`UPDATE agent_state SET
          workspace_json = ?, workspace_revision = ?, r4_json = ?, r4_revision = ?, updated_at = ?
          WHERE id = ?`)
          .run(
            workspaceChanged ? stableJson(workspace) : current.workspace_json,
            current.workspace_revision + (workspaceChanged ? 1 : 0),
            r4Changed ? stableJson(r4State) : current.r4_json,
            current.r4_revision + (r4Changed ? 1 : 0),
            new Date().toISOString(),
            WORKSPACE_ROW_ID,
          );
        if (r4Changed) rebuildExecutionIndexes(this.db, r4State);
      }
      this.db.exec("COMMIT");
      began = false;
      return result;
    } catch (error) {
      if (began) {
        try { this.db.exec("ROLLBACK"); } catch { /* preserve the operation error */ }
      }
      throw error;
    } finally {
      this.transactionActive = false;
    }
  }

  findExecutionBySubmissionKey(submissionKey: string) {
    const row = this.db.prepare("SELECT execution_id, input_fingerprint FROM r4_submission_keys WHERE submission_key = ?")
      .get(submissionKey) as { execution_id: string; input_fingerprint: string } | undefined;
    return row ? { executionId: row.execution_id, inputFingerprint: row.input_fingerprint } : undefined;
  }

  close() {
    if (this.transactionActive) throw new Error("不能在 Agent SQLite 事务期间关闭数据库。");
    this.db.close();
  }
}

export function createAgentSqlStore(options: AgentSqlStoreOptions) {
  return new AgentSqlStore(options);
}

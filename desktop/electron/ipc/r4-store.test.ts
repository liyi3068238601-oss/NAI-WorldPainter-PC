import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSqlStore } from "./r4-store";
import type { AgentWorkspaceData } from "../../src/agent/types";
import { createEmptyR4AgentState, type R4Execution } from "../../src/agent/r4-types";

const tempRoot = path.resolve(process.cwd(), ".tmp");
let fixtureRoot = "";

function workspace(title = "fixture") {
  return {
    version: 4 as const,
    conversations: [],
    skills: [],
    memories: [],
    characters: [],
    personas: [],
    lorebooks: [],
    samplerPresets: [],
    defaultGenerationMode: "confirm" as const,
    updatedAt: "2026-10-18T00:00:00.000Z",
    fixtureTitle: title,
  } as unknown as AgentWorkspaceData;
}

function execution(id: string, submissionKey: string): R4Execution {
  return {
    id, conversationId: "conversation-1", creationId: "creation-1", operationKey: "generate_image",
    submissionKey, userIntentRef: "intent-1", inputRevision: 1, inputFingerprint: "fingerprint-1",
    expectedOutputCount: 1, requestGranularity: "per_output", providerRef: { providerId: "fake" },
    approvedInput: {
      inputRevision: 1, positivePrompt: "fixture", negativePrompt: "", stylePrompt: "",
      publicParameters: {}, references: [],
    },
    conversationConfig: {
      version: 1, providerRef: { providerId: "fake" }, modelId: "fake-model", presetId: null,
      enabled: false, publicParameters: {}, capturedAt: "2026-10-18T00:00:00.000Z", source: "preview",
    },
    status: "queued", pauseReason: "none", outputs: [{ outputIndex: 0, status: "not_dispatched" }],
    providerReceiptStatus: "not_applicable", providerCancellation: "not_sent", receiptRevision: 0,
    createdAt: "2026-10-18T00:00:00.000Z", updatedAt: "2026-10-18T00:00:00.000Z", events: [],
  };
}

function makeStore(filename: string, legacyFile: string) {
  return new AgentSqlStore({
    filename,
    legacyFiles: [legacyFile, `${legacyFile}.bak`, `${legacyFile}.bak2`],
    loadInitialState: () => ({ workspace: workspace(), r4State: createEmptyR4AgentState() }),
    normalizeWorkspace: (value) => value as AgentWorkspaceData,
  });
}

beforeEach(() => {
  fs.mkdirSync(tempRoot, { recursive: true });
  fixtureRoot = fs.mkdtempSync(path.join(tempRoot, "r4-store-test-"));
});

afterEach(() => {
  if (!fixtureRoot) return;
  if (path.dirname(fixtureRoot) !== tempRoot || !path.basename(fixtureRoot).startsWith("r4-store-test-")) {
    throw new Error("Refusing to remove an unexpected R4 store fixture directory.");
  }
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = "";
});

describe("AgentSqlStore durable transactions", () => {
  it("keeps the legacy JSON bytes untouched and reads committed snapshots after reopening", () => {
    const legacyFile = path.join(fixtureRoot, "agent-workspace.json");
    const original = Buffer.from('{"version":4,"fixture":"preserve exact source"}\n');
    fs.writeFileSync(legacyFile, original);
    const database = path.join(fixtureRoot, "agent-state.sqlite");
    const store = makeStore(database, legacyFile);
    expect(store.readWorkspace()).toMatchObject({ fixtureTitle: "fixture" });
    store.transaction((tx) => {
      tx.setWorkspace(workspace("committed"));
      const state = tx.getR4State();
      state.executions["execution-1"] = execution("execution-1", "submission-1");
      tx.setR4State(state);
    });
    store.close();
    expect(fs.readFileSync(legacyFile)).toEqual(original);

    const reopened = makeStore(database, legacyFile);
    expect(reopened.readWorkspace()).toMatchObject({ fixtureTitle: "committed" });
    expect(reopened.readR4State().executions["execution-1"]?.outputs).toEqual([{ outputIndex: 0, status: "not_dispatched" }]);
    expect(reopened.findExecutionBySubmissionKey("submission-1")).toEqual({
      executionId: "execution-1", inputFingerprint: "fingerprint-1",
    });
    reopened.close();
  });

  it("rolls workspace and creative state back together when an execution uniqueness invariant fails", () => {
    const legacyFile = path.join(fixtureRoot, "agent-workspace.json");
    fs.writeFileSync(legacyFile, "synthetic immutable source");
    const store = makeStore(path.join(fixtureRoot, "agent-state.sqlite"), legacyFile);
    const beforeWorkspace = store.readWorkspace();
    const beforeState = store.readR4State();

    expect(() => store.transaction((tx) => {
      tx.setWorkspace(workspace("must roll back"));
      const state = tx.getR4State();
      state.executions.first = execution("first", "duplicate");
      state.executions.second = execution("second", "duplicate");
      tx.setR4State(state);
    })).toThrow();

    expect(store.readWorkspace()).toEqual(beforeWorkspace);
    expect(store.readR4State()).toEqual(beforeState);
    expect(store.findExecutionBySubmissionKey("duplicate")).toBeUndefined();
    store.close();
  });

  it("fails closed when the original JSON changes after its one-time migration", () => {
    const legacyFile = path.join(fixtureRoot, "agent-workspace.json");
    fs.writeFileSync(legacyFile, "synthetic source v1");
    const database = path.join(fixtureRoot, "agent-state.sqlite");
    const store = makeStore(database, legacyFile);
    store.close();
    fs.writeFileSync(legacyFile, "synthetic source v2");
    expect(() => makeStore(database, legacyFile)).toThrow(/JSON.*发生变化/);
    expect(fs.readFileSync(legacyFile, "utf8")).toBe("synthetic source v2");
  });

  it("does not initialize over an unknown SQLite schema version", () => {
    const legacyFile = path.join(fixtureRoot, "agent-workspace.json");
    fs.writeFileSync(legacyFile, "synthetic source");
    const database = path.join(fixtureRoot, "agent-state.sqlite");
    const db = new DatabaseSync(database);
    db.exec("PRAGMA user_version = 77");
    db.close();
    const originalBytes = fs.readFileSync(database);
    expect(() => makeStore(database, legacyFile)).toThrow(/版本 77 暂不支持/);
    expect(fs.readFileSync(database)).toEqual(originalBytes);
    const reopened = new DatabaseSync(database);
    expect((reopened.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(77);
    reopened.close();
  });
});

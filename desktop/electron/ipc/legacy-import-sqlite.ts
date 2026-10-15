import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import type { LegacyWorkspaceSnapshot } from "./legacy-import-converter";

const MAX_DATABASE_BYTES = 256 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 96 * 1024 * 1024;
const MAX_GALLERY_ROWS = 25_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function parseObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_PAYLOAD_BYTES) throw Error("旧工作区 " + field + " 内容无效或过大。");
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw Error("旧工作区 " + field + " JSON 无效。"); }
  const record = asRecord(parsed);
  if (!record) throw Error("旧工作区 " + field + " 必须是 JSON 对象。");
  return record;
}
function pick(record: Record<string, unknown>, keys: readonly string[]) {
  return Object.fromEntries(keys.filter((key) => key in record).map((key) => [key, record[key]]));
}
function safeDraft(raw: Record<string, unknown>) {
  const draft = pick(raw, ["prompt", "negative", "model", "provider", "width", "height", "steps", "cfg", "seedText", "batchCount"]);
  const generation = asRecord(raw.generation);
  const keys = ["operation", "model", "prompt", "negativePrompt", "negative_prompt", "width", "height", "steps", "scale", "cfgScale", "cfgRescale", "cfg_rescale", "sampler", "noiseSchedule", "noise_schedule", "seed", "useCoords", "use_coords", "characters", "vibeReferences", "vibe_references", "preciseReferences", "precise_references", "sourceImageId", "source_image_id", "maskImageId", "mask_image_id", "img2imgSourceImageId", "img2img_source_image_id", "img2imgStrength", "img2img_strength", "inpaintStrength", "inpaint_strength"];
  if (generation) draft.generation = pick(generation, keys);
  return draft;
}
function safePromptLibrary(raw: unknown) {
  const library = asRecord(raw) ?? {};
  const styles = ["id", "name", "prompt", "negative", "category", "preview_asset_ref", "created_at", "updated_at"];
  const artists = ["id", "name", "prompt", "categories", "default_weight", "use_count", "last_used_at", "danbooru_count", "created_at", "updated_at"];
  return {
    schema: library.schema,
    styles: Array.isArray(library.styles) ? library.styles.map((item) => { const row = asRecord(item); return row ? pick(row, styles) : item; }) : [],
    artists: Array.isArray(library.artists) ? library.artists.map((item) => { const row = asRecord(item); return row ? pick(row, artists) : item; }) : [],
    groups: Array.isArray(library.groups) ? library.groups.filter((item) => typeof item === "string") : [],
  };
}
function safeAssistant(raw: unknown) {
  const assistant = asRecord(raw) ?? {};
  const sourceMemory = asRecord(assistant.memories) ?? {};
  const memoryKeys = ["id", "trigger", "content", "kind", "source", "hitCount", "lastHitAt", "createdAt", "updatedAt", "supersededBy"];
  const memories = {
    schema: sourceMemory.schema,
    entries: Array.isArray(sourceMemory.entries) ? sourceMemory.entries.map((item) => { const row = asRecord(item); return row ? pick(row, memoryKeys) : item; }) : [],
  };
  const sessions = Array.isArray(assistant.sessions) ? assistant.sessions.map((rawSession) => {
    const session = asRecord(rawSession);
    if (!session) return rawSession;
    const turns = Array.isArray(session.turns) ? session.turns.map((rawTurn) => {
      const turn = asRecord(rawTurn);
      if (!turn) return rawTurn;
      const messages = Array.isArray(turn.messages) ? turn.messages.map((rawMessage) => {
        const message = asRecord(rawMessage);
        if (!message) return rawMessage;
        return message.role === "assistant" ? pick(message, ["role", "content"]) : pick(message, ["role"]);
      }) : [];
      return { ...pick(turn, ["id", "userText", "attachments", "status"]), messages };
    }) : [];
    return { ...pick(session, ["id", "title", "input", "attachments"]), turns };
  }) : [];
  return { memories, sessions, activeSessionId: assistant.activeSessionId };
}
function safeGalleryItem(raw: Record<string, unknown>) {
  return pick(raw, ["id", "title", "prompt", "negative", "width", "height", "seed", "variant", "favorite", "isDemo", "model", "provider", "steps", "cfg", "assetRef", "parameters", "editMetadata", "createdAt"]);
}

/** Opens only the Flutter v1 schema; both the OS handle and SQLite are read-only. */
export function readLegacyWorkspaceReadOnly(filePath: string): LegacyWorkspaceSnapshot {
  if (path.basename(filePath).toLocaleLowerCase() !== "workspace.sqlite") throw Error("请选择 Flutter PC 工作区中的 workspace.sqlite 文件。");
  const absolute = path.resolve(filePath);
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 100 || stat.size > MAX_DATABASE_BYTES) throw Error("旧 SQLite 文件无效或超过 256 MiB。");
  const db = new DatabaseSync(absolute, { readOnly: true });
  try {
    db.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF; BEGIN;");
    const versionRow = db.prepare("PRAGMA user_version").get() as { user_version?: unknown } | undefined;
    const schemaVersion = Number(versionRow?.user_version);
    if (schemaVersion !== 1) throw Error("不支持旧工作区 SQLite schema " + String(versionRow?.user_version) + "；当前仅支持 schema 1。");
    const required: Record<string, string[]> = {
      meta: ["id", "revision"], draft: ["id", "payload"], gallery: ["id", "ordinal", "payload"], workspace: ["id", "extra_json"],
    };
    for (const [table, columns] of Object.entries(required)) {
      const rows = db.prepare("PRAGMA table_info(" + table + ")").all() as Array<{ name?: unknown }>;
      if (!columns.every((column) => rows.some((item) => item.name === column))) throw Error("旧工作区 SQLite 表 " + table + " 列结构不完整。");
    }
    const meta = db.prepare("SELECT id, revision FROM meta").all() as Array<{ id?: unknown; revision?: unknown }>;
    const drafts = db.prepare("SELECT id, payload FROM draft").all() as Array<{ id?: unknown; payload?: unknown }>;
    const workspaces = db.prepare("SELECT id, extra_json FROM workspace").all() as Array<{ id?: unknown; extra_json?: unknown }>;
    if (meta.length !== 1 || meta[0].id !== 1 || !Number.isSafeInteger(meta[0].revision) || Number(meta[0].revision) < 1) throw Error("旧工作区 revision 元数据无效。");
    if (drafts.length !== 1 || drafts[0].id !== 1 || workspaces.length !== 1 || workspaces[0].id !== 1) throw Error("旧工作区缺少唯一 draft/workspace 快照。");
    const rows = db.prepare("SELECT id, ordinal, payload FROM gallery ORDER BY ordinal ASC").all() as Array<{ id?: unknown; ordinal?: unknown; payload?: unknown }>;
    if (rows.length > MAX_GALLERY_ROWS) throw Error("旧工作区图库记录超过导入上限。");
    const gallery: unknown[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (typeof row.id !== "string" || !row.id || row.ordinal !== i || typeof row.payload !== "string" || !seen.add(row.id)) throw Error("旧工作区图库序号或 ID 索引无效。");
      const item = safeGalleryItem(parseObject(row.payload, "图库 " + row.id));
      if (item.id !== row.id) throw Error("旧工作区图库 " + row.id + " 与 payload ID 不匹配。");
      gallery.push(item);
    }
    const rawDraft = parseObject(drafts[0].payload, "draft");
    const rawExtra = parseObject(workspaces[0].extra_json, "workspace root");
    if ("draft" in rawExtra || "gallery" in rawExtra) throw Error("旧工作区根 JSON 重复包含独立存储字段。");
    if (!asRecord(rawExtra.preferences) || !asRecord(rawExtra.editor) || typeof rawExtra.selectedId !== "string" || !Number.isInteger(rawExtra.demoSequence)) throw Error("旧工作区根字段校验失败。");
    const preferences = rawExtra.preferences as Record<string, unknown>;
    const extra: Record<string, unknown> = {
      preferences: pick(preferences, ["darkTheme", "reduceMotion"]),
      editor: rawExtra.editor, selectedId: rawExtra.selectedId, demoSequence: rawExtra.demoSequence,
      promptLibrary: safePromptLibrary(rawExtra.promptLibrary), assistant: safeAssistant(rawExtra.assistant),
      ...(rawExtra.vibeLibrary === undefined ? {} : { vibeLibrary: rawExtra.vibeLibrary }),
    };
    const draft = safeDraft(rawDraft);
    db.exec("COMMIT;");
    return { schemaVersion, revision: Number(meta[0].revision), draft, extra, gallery };
  } finally {
    try { db.exec("ROLLBACK;"); } catch { /* committed transaction */ }
    db.close();
  }
}

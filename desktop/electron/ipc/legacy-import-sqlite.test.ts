import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { readLegacyWorkspaceReadOnly } from "./legacy-import-sqlite";

const roots: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "worldpainter-legacy-sqlite-"));
  roots.push(root);
  const file = path.join(root, "workspace.sqlite");
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA user_version = 1;
    CREATE TABLE meta (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL);
    CREATE TABLE draft (id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE gallery (id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE workspace (id INTEGER PRIMARY KEY, extra_json TEXT NOT NULL);
  `);
  db.prepare("INSERT INTO meta (id, revision) VALUES (1, 7)").run();
  db.prepare("INSERT INTO draft (id, payload) VALUES (1, ?)").run(JSON.stringify({
    prompt: "synthetic prompt", negative: "blur", generation: { width: 768 },
    connections: [{ token: "SYNTHETIC_PROVIDER_TOKEN_MUST_NOT_LEAK" }],
  }));
  db.prepare("INSERT INTO gallery (id, ordinal, payload) VALUES (?, 0, ?)").run("g-1", JSON.stringify({
    id: "g-1", prompt: "synthetic gallery", assetRef: "sha256/00/" + "0".repeat(64) + ".png",
    providerSecret: "SYNTHETIC_GALLERY_SECRET_MUST_NOT_LEAK",
  }));
  db.prepare("INSERT INTO workspace (id, extra_json) VALUES (1, ?)").run(JSON.stringify({
    preferences: { darkTheme: true, reduceMotion: false, apiKey: "SYNTHETIC_PREF_SECRET_MUST_NOT_LEAK" },
    editor: { zoom: 1, selectedTool: "brush" }, selectedId: "g-1", demoSequence: 0,
    promptLibrary: { styles: [{ id: "s-1", name: "Ink", prompt: "ink", providerSecret: "SYNTHETIC_STYLE_SECRET_MUST_NOT_LEAK" }], artists: [], groups: [] },
    assistant: {
      providers: [{ id: "provider", apiKey: "SYNTHETIC_ASSISTANT_SECRET_MUST_NOT_LEAK" }],
      memories: { entries: [{ id: "m-1", trigger: "blue eyes", content: "clear blue", privateField: "drop" }] },
      sessions: [{ id: "chat-1", title: "Synthetic chat", providerContext: "SYNTHETIC_TRACE_MUST_NOT_LEAK", turns: [{
        id: "turn-1", userText: "describe this", messages: [
          { role: "assistant", content: "A blue portrait.", privateField: "drop" },
          { role: "tool", content: "SYNTHETIC_TOOL_OUTPUT_MUST_NOT_LEAK" },
        ],
      }] }],
    },
  }));
  db.close();
  return { root, file };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("worldpainter-legacy-sqlite-")) throw Error("Unexpected synthetic test fixture root");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("read-only Flutter SQLite projection", () => {
  it("reads only supported safe fields and leaves the selected database byte-identical", () => {
    const { root, file } = fixture();
    const before = fs.readFileSync(file);
    const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
    const snapshot = readLegacyWorkspaceReadOnly(file);

    expect(snapshot).toMatchObject({ schemaVersion: 1, revision: 7, draft: { prompt: "synthetic prompt", generation: { width: 768 } } });
    expect(snapshot.gallery).toHaveLength(1);
    expect(snapshot.extra.promptLibrary).toMatchObject({ styles: [{ id: "s-1", prompt: "ink" }] });
    expect(snapshot.extra.assistant).toMatchObject({
      memories: { entries: [{ id: "m-1", trigger: "blue eyes", content: "clear blue" }] },
      sessions: [{ id: "chat-1", turns: [{ messages: [{ role: "assistant", content: "A blue portrait." }, { role: "tool" }] }] }],
    });
    expect(JSON.stringify(snapshot)).not.toContain("SYNTHETIC_");
    expect(hash(fs.readFileSync(file))).toBe(hash(before));
    expect(fs.readdirSync(root).sort()).toEqual(["workspace.sqlite"]);
  });

  it("rejects an unsupported schema without modifying it", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "worldpainter-legacy-sqlite-"));
    roots.push(root);
    const file = path.join(root, "workspace.sqlite");
    const db = new DatabaseSync(file);
    db.exec("PRAGMA user_version = 99; CREATE TABLE marker (id INTEGER);");
    db.close();
    const before = fs.readFileSync(file);

    expect(() => readLegacyWorkspaceReadOnly(file)).toThrow("不支持旧工作区 SQLite schema 99");
    expect(fs.readFileSync(file)).toEqual(before);
    expect(fs.readdirSync(root)).toEqual(["workspace.sqlite"]);
  });
});

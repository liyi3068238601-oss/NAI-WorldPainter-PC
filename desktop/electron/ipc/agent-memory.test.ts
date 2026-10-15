import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ root: "", snapshot: "" }));
vi.mock("electron", () => ({ dialog: {} }));
vi.mock("./agent-workspace-location", () => ({
  agentWorkspaceDirectory: () => fixture.root,
  rebaseAgentWorkspaceFile: (value: string) => value,
}));
vi.mock("./store", () => ({
  getSettings: () => ({ agentContextWindow: 128_000, agentAutoCompactThreshold: 0.8, outputDir: "" }),
  getHistoryReferenceItems: () => [],
  fileExistsWithDirectoryCache: () => false,
  atomicWriteFileSync: (_file: string, value: string) => { fixture.snapshot = value; },
  readWithBackupRecoverySync: (_file: string, parse: (value: string) => unknown) => fixture.snapshot
    ? { value: parse(fixture.snapshot) }
    : null,
  rotateBackupsSync: vi.fn(),
}));

import {
  createEmptyAgentWorkspace,
  normalizeAgentWorkspace,
  readAgentWorkspace,
  resetAgentStoreCacheForTests,
  retrieveAgentMemories,
  upsertAgentMemory,
  writeAgentWorkspace,
} from "./agent-store";
import { AGENT_WORKSPACE_VERSION } from "../../src/agent/types";

let tempRoot = "";
beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nai-agent-memory-"));
  fixture.root = tempRoot;
  fixture.snapshot = "";
  resetAgentStoreCacheForTests();
  writeAgentWorkspace(createEmptyAgentWorkspace());
});
afterEach(() => {
  resetAgentStoreCacheForTests();
  if (tempRoot) {
    if (path.dirname(tempRoot) !== os.tmpdir() || !path.basename(tempRoot).startsWith("nai-agent-memory-")) throw new Error("Unexpected memory test directory");
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  tempRoot = "";
});

describe("Agent memory persistence and tools", () => {
  it("loads schema-1 workspace memories with defaults and preserves ordinary text", () => {
    const raw = {
      version: AGENT_WORKSPACE_VERSION,
      memories: [{ id: "legacy", title: "旧记忆", content: "  用户喜欢暖色光照。\n保持原文。  ", scope: "global", createdAt: "2024-01-01", updatedAt: "2024-01-02" }],
    };
    const normalized = normalizeAgentWorkspace(raw);
    expect(normalized.memories[0]).toMatchObject({
      id: "legacy", trigger: "旧记忆", type: "other", source: "manual",
      content: raw.memories[0].content, scope: "global", hitCount: 0, weight: 1,
    });
  });

  it("does not leak malformed unbound conversation memories into a global query", () => {
    const base = readAgentWorkspace();
    const unbound = {
      id: "unbound", title: "Private trigger", trigger: "Private trigger", content: "private content",
      scope: "conversation" as const, type: "other" as const, source: "manual" as const,
      createdAt: "2024-01-01", updatedAt: "2024-01-01",
    };
    writeAgentWorkspace({ ...base, memories: [unbound] });
    expect(retrieveAgentMemories("private content", undefined)).toEqual([]);
  });

  it("normalizes tag classes, creates pending candidates, and rejects candidate overwrite requests", () => {
    const old = upsertAgentMemory({ title: "Nahida", content: "喜欢电影光照", scope: "global", type: "preference", source: "manual" });
    expect(old.ok).toBe(true);
    const candidate = upsertAgentMemory({ title: "Nahida", trigger: "Nahida", content: "Long Hair, GREEN EYES", scope: "global", type: "characterFeature", source: "pendingLlmCandidate" });
    expect(candidate.ok).toBe(true);
    expect(candidate.workspace.memories.find((item) => item.source === "pendingLlmCandidate")?.content).toBe("long_hair, green_eyes");
    const id = candidate.workspace.memories.find((item) => item.source === "pendingLlmCandidate")!.id;
    const unsafeRequest = {
      id, title: "Nahida", trigger: "Nahida", content: "long_hair, green_eyes", scope: "global",
      type: "characterFeature" as const, source: "pendingLlmCandidate" as const, supersedeIds: [old.workspace.memories[0].id],
    };
    const rejected = upsertAgentMemory(unsafeRequest);
    expect(rejected.ok).toBe(false);
    expect(rejected.workspace.memories.find((item) => item.id === old.workspace.memories[0].id)?.supersededBy).toBeUndefined();
  });

  it("approves a pending candidate atomically with explicit replace, then retrieves only that active record", () => {
    const old = upsertAgentMemory({ title: "Nahida", content: "green eyes", scope: "global", type: "characterFeature", source: "manual" });
    const oldId = old.workspace.memories[0].id;
    const candidate = upsertAgentMemory({ title: "Nahida", trigger: "Nahida", content: "long hair", scope: "global", type: "characterFeature", source: "pendingLlmCandidate" });
    const candidateId = candidate.workspace.memories.find((item) => item.source === "pendingLlmCandidate")!.id;
    const approvalRequest = {
      id: candidateId, title: "Nahida", trigger: "Nahida", content: "long hair", scope: "global",
      type: "characterFeature", source: "llmCandidate",
      supersedeIds: [oldId],
    };
    const approved = upsertAgentMemory(approvalRequest);
    expect(approved.ok).toBe(true);
    expect(approved.workspace.memories.find((item) => item.id === oldId)?.supersededBy).toBe(candidateId);
    expect(approved.workspace.memories.find((item) => item.id === candidateId)?.source).toBe("llmCandidate");
    const results = retrieveAgentMemories("Please use Nahida long hair", undefined);
    expect(results.map((item) => item.id)).toEqual([candidateId]);
    expect(results[0].hitCount).toBe(1);
    expect(readAgentWorkspace().memories.find((item) => item.id === candidateId)?.hitCount).toBe(1);
  });

  it("bounds tool retrieval by eight records, session scope and character budget", () => {
    const base = createEmptyAgentWorkspace();
    const long = "a".repeat(8_000);
    for (let index = 0; index < 10; index += 1) {
      const result = upsertAgentMemory({ title: `Style ${index}`, trigger: `Style ${index}`, content: long, scope: "global", type: "style", source: "manual" });
      expect(result.ok).toBe(true);
    }
    upsertAgentMemory({ title: "Style private", trigger: "Style private", content: "private", scope: "conversation", conversationId: "chat-a", type: "style", source: "manual" });
    const globalResults = retrieveAgentMemories("style", "chat-b");
    expect(globalResults.length).toBeLessThanOrEqual(8);
    expect(globalResults.every((item) => item.scope === "global")).toBe(true);
    expect(globalResults.some((item) => item.contentTruncated)).toBe(true);
    expect(globalResults.reduce((sum, item) => sum + item.content.length, 0)).toBeLessThanOrEqual(12_000);
    expect(JSON.stringify(globalResults).length).toBeLessThanOrEqual(12_000);
    const privateResults = retrieveAgentMemories("private", "chat-a");
    expect(privateResults.map((item) => item.trigger)).toEqual(["Style private"]);
    expect(retrieveAgentMemories("private", "chat-b")).toEqual([]);
    expect(base.memories).toHaveLength(0);
  });

  it("keeps an invalid tag candidate intact when approval validation fails", () => {
    const candidate = upsertAgentMemory({ title: "Ná́shida", trigger: "角色特征", content: "绿色眼睛", scope: "global", type: "characterFeature", source: "pendingLlmCandidate" });
    expect(candidate.ok).toBe(true);
    const pending = candidate.workspace.memories.find((item) => item.source === "pendingLlmCandidate")!;
    expect(pending.content).toBe("绿色眼睛");
    const failed = upsertAgentMemory({
      id: pending.id, title: pending.title, trigger: pending.trigger, content: pending.content,
      scope: pending.scope, type: pending.type, source: "llmCandidate",
    });
    expect(failed.ok).toBe(false);
    expect(failed.workspace.memories.find((item) => item.id === pending.id)).toMatchObject({
      source: "pendingLlmCandidate", content: "绿色眼睛",
    });
  });
});

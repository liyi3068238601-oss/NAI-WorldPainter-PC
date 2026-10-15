import { describe, expect, it } from "vitest";
import {
  findAgentMemoryConflicts,
  isRetrievableAgentMemory,
  isStaleAgentMemory,
  mergeAgentMemoryContent,
  normalizeAgentMemoryContent,
  normalizeAgentMemorySnapshot,
  normalizePromptMemoryTags,
  scoreAgentMemoryQuery,
} from "./memory";
import type { AgentMemory } from "./types";

function memory(overrides: Partial<AgentMemory> = {}): AgentMemory {
  return {
    id: "memory-1",
    title: "Nahida",
    trigger: "Nahida",
    content: "green_eyes, long_hair",
    scope: "global",
    type: "characterFeature",
    source: "manual",
    hitCount: 0,
    weight: 1,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("M4 prompt memory normalization and retrieval rules", () => {
  it("normalizes only the three prompt-tag types and retains NovelAI weight/wildcard syntax", () => {
    expect(normalizePromptMemoryTags(
      "Long Hair, GREEN EYES\n{Blue Eyes}, [Soft Light], 1.5::Bright Hair::, {Miku|Hatsune Miku}, ${Hair.Color}, <lora:InkStyle:0.8>, 長髮",
    )).toBe("long_hair, green_eyes, {blue_eyes}, [soft_light], 1.5::bright_hair::, {Miku|Hatsune Miku}, ${Hair.Color}, <lora:InkStyle:0.8>");
    expect(normalizeAgentMemoryContent("style", "Watercolor, watercolor, warm light")).toBe("watercolor, warm_light");
  });

  it("preserves ordinary descriptions exactly and rejects invalid tag-only content", () => {
    const ordinary = "  用户偏好暖色光照。\n角色性格温柔。  ";
    expect(normalizeAgentMemoryContent("preference", ordinary)).toBe(ordinary);
    expect(normalizeAgentMemoryContent("other", "  explanatory prose  ")).toBe("  explanatory prose  ");
    expect(normalizePromptMemoryTags("绿眼睛, long hair")).toBe("long_hair");
  });

  it("does not confuse a literal tag with the wildcard-protection marker", () => {
    expect(normalizePromptMemoryTags("zzmemorywildcard0zz, {Color|Hair}"))
      .toBe("zzmemorywildcard0zz, {Color|Hair}");
    expect(normalizePromptMemoryTags("zzmemorywildcard0zz {Color|Hair}"))
      .toBe("zzmemorywildcard0zz_{Color|Hair}");
  });

  it("loads schema-1 records as approved other/manual memories without rewriting content", () => {
    const raw = {
      id: "old-memory", title: "旧标题", content: "  用户喜欢电影光照。  ", scope: "conversation",
      conversationId: "chat-old", createdAt: "2024-01-01", updatedAt: "2024-02-01",
    };
    const restored = normalizeAgentMemorySnapshot(raw, "2026-10-15T00:00:00.000Z");
    expect(restored).toMatchObject({
      id: "old-memory", title: "旧标题", trigger: "旧标题", content: raw.content,
      type: "other", source: "manual", scope: "conversation", conversationId: "chat-old", hitCount: 0, weight: 1,
    });
    expect(isRetrievableAgentMemory(restored!)).toBe(true);
  });

  it("keeps pending and superseded entries out of retrieval and detects scope-local conflicts", () => {
    const pending = memory({ id: "pending", source: "pendingLlmCandidate" });
    const old = memory({ id: "old", supersededBy: "new" });
    expect(isRetrievableAgentMemory(pending)).toBe(false);
    expect(isRetrievableAgentMemory(old)).toBe(false);
    expect(findAgentMemoryConflicts([
      memory({ id: "same-global" }),
      memory({ id: "other-chat", scope: "conversation", conversationId: "elsewhere" }),
      pending,
      old,
    ], memory({ id: "new" }))).toEqual([memory({ id: "same-global" })]);
  });

  it("merges tags without turning the separator into a prompt tag and ranks related records", () => {
    expect(mergeAgentMemoryContent("characterFeature", "long hair", "green eyes")).toBe("long_hair, green_eyes");
    expect(mergeAgentMemoryContent("preference", "warm lighting", "soft shadows")).toBe("warm lighting\n---\nsoft shadows");
    expect(scoreAgentMemoryQuery("Please use green eyes for Nahida", memory())).toBeGreaterThan(0);
    expect(scoreAgentMemoryQuery("unrelated spaceship", memory())).toBe(0);
  });

  it("only marks old, never-hit, approved records stale", () => {
    const now = Date.parse("2026-10-15T00:00:00.000Z");
    expect(isStaleAgentMemory(memory(), now)).toBe(true);
    expect(isStaleAgentMemory(memory({ hitCount: 1 }), now)).toBe(false);
    expect(isStaleAgentMemory(memory({ source: "pendingLlmCandidate" }), now)).toBe(false);
    expect(isStaleAgentMemory(memory({ createdAt: "2026-09-01T00:00:00.000Z" }), now)).toBe(false);
  });
});

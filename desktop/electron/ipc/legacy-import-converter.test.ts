import { describe, expect, it } from "vitest";
import { convertLegacySnapshot, legacyAgentWorkspace, legacyDraftParams, legacyStableId, type LegacyAsset, type LegacyWorkspaceSnapshot } from "./legacy-import-converter";

const fingerprint = "a".repeat(64);
const image: LegacyAsset = {
  ref: "sha256/11/" + "1".repeat(64) + ".png",
  filePath: "C:/target/legacy-import-assets/1.png",
  fileUrl: "nai-local://file/test",
  sha256: "1".repeat(64), width: 4, height: 3, byteLength: 48, mime: "image/png",
};

function snapshot(): LegacyWorkspaceSnapshot {
  return {
    schemaVersion: 1,
    revision: 7,
    draft: {
      prompt: "cat, blue eyes", negative: "lowres", model: "nai-diffusion-4-5-full",
      width: 832, height: 1216, steps: 30, cfg: 5.5, seedText: "42",
      generation: { sampler: "k_euler", noiseSchedule: "karras" },
      connections: [{ token: "MUST_NOT_IMPORT_OR_ARCHIVE" }],
    },
    extra: {
      preferences: { darkTheme: true, reduceMotion: false },
      editor: { zoom: 1 },
      selectedId: "gallery-1", demoSequence: 0,
      promptLibrary: {
        schema: 1, groups: ["old group"],
        styles: [{ id: "style-1", name: "Ink", prompt: "ink wash", negative: "photo", category: "Watercolor", preview_asset_ref: image.ref, created_at: "2024-01-02T00:00:00Z" }],
        artists: [{ id: "artist-1", name: "Artist", prompt: "artist:sample", categories: ["ink"], default_weight: 0.8, use_count: 3, danbooru_count: 8, created_at: "2024-01-02T00:00:00Z" }],
      },
      assistant: {
        memories: { schema: 1, entries: [
          { id: "m1", trigger: "blue eyes", content: "bright blue", kind: "character_feature", source: "userInstruction", hitCount: 2, createdAt: "2024-01-02T00:00:00Z", updatedAt: "2024-01-02T00:00:00Z" },
          { id: "m2", trigger: "new idea", content: "review first", kind: "other", source: "pendingLlmCandidate", hitCount: 0, createdAt: "2024-01-02T00:00:00Z", updatedAt: "2024-01-02T00:00:00Z" },
        ] },
        sessions: [{ id: "session-1", title: "Sketch chat", input: "unfinished", attachments: [image.ref], turns: [
          { id: "turn-1", userText: "Make it softer", attachments: [], messages: [
            { role: "assistant", content: "Use a soft watercolor wash." },
            { role: "tool", content: "tool output is not an active message" },
          ] },
        ] }],
      },
      vibeLibrary: { schema: 1, entries: [] },
    },
    gallery: [{
      id: "gallery-1", title: "Blue cat", prompt: "cat, blue eyes", negative: "lowres", width: 832, height: 1216,
      seed: 42, variant: 0, favorite: true, isDemo: false, model: "nai-diffusion-4-5-full", provider: "NovelAI",
      steps: 30, cfg: 5.5, assetRef: image.ref, createdAt: "2024-01-02T00:00:00Z",
    }],
  };
}

describe("Flutter desktop snapshot conversion", () => {
  it("maps the supported draft, gallery, prompt materials, memories, and safe chat text", () => {
    const source = snapshot();
    const converted = convertLegacySnapshot(source, fingerprint, new Map([[image.ref, image]]));
    expect(legacyDraftParams(source.draft)).toMatchObject({
      model: "nai-diffusion-4-5-full", positivePrompt: "cat, blue eyes", negativePrompt: "lowres",
      width: 832, height: 1216, steps: 30, seed: 42, seedMode: "fixed",
    });
    expect(converted.history).toHaveLength(1);
    expect(converted.history[0]).toMatchObject({ generatedImageSha256: image.sha256, actualSeed: 42, feature: "legacy-gallery" });
    expect(converted.styles[0]).toMatchObject({ name: "Ink", prompt: "ink wash", group: "Watercolor" });
    expect(converted.archive["style-extra:style-1"]).toMatchObject({ negative: "photo" });
    expect(converted.artists[0]).toMatchObject({ name: "Artist", tag: "artist:sample", danbooruCount: 8 });
    expect(converted.memories.map((item) => item.source)).toEqual(["userInstruction", "pendingLlmCandidate"]);
    expect(converted.memories[0].type).toBe("characterFeature");
    expect(converted.conversations[0].messages.map((item) => [item.role, item.content])).toEqual([
      ["user", "Make it softer"], ["assistant", "Use a soft watercolor wash."],
    ]);
    expect(converted.conversations[0].draftAttachments[0].filePath).toBe(image.filePath);
    expect(JSON.stringify(converted.archive)).not.toContain("MUST_NOT_IMPORT_OR_ARCHIVE");
    expect(legacyAgentWorkspace(converted).memories[1].source).toBe("pendingLlmCandidate");
  });

  it("namespaces ids deterministically and archives demo rows without importing them as history", () => {
    const original = snapshot();
    original.gallery.push({ id: "demo-1", isDemo: true, variant: 2, favorite: false });
    const first = convertLegacySnapshot(original, fingerprint, new Map([[image.ref, image]]));
    const second = convertLegacySnapshot(original, fingerprint, new Map([[image.ref, image]]));
    expect(legacyStableId(fingerprint, "gallery", "gallery-1")).toBe(first.history[0].id);
    expect(first.history).toHaveLength(1);
    expect(first.history.map((item) => item.id)).toEqual(second.history.map((item) => item.id));
    expect(first.archive["gallery-demo:demo-1"]).toEqual({ variant: 2, favorite: false });
  });
});

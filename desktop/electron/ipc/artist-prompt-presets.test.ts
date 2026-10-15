import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  appendArtistPromptPresets,
  artistPromptPresetLibraryPath,
  loadArtistPromptPresetLibrary,
  mergeArtistPromptPresetLibrary,
} from "./artist-prompt-presets";
import type { ArtistPromptPreset } from "../../src/worldpainter-material-import";

const roots: string[] = [];

async function makeRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wp-artist-prompt-library-"));
  roots.push(root);
  return root;
}

function entry(id: string, patch: Partial<ArtistPromptPreset> = {}): ArtistPromptPreset {
  return {
    id,
    name: `Artist ${id}`,
    tag: `artist_${id}`,
    categories: ["style"],
    danbooruCount: 12,
    createdAt: "2026-10-15T00:00:00.000Z",
    previewImages: [],
    ...patch,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("artist prompt preset sidecar", () => {
  it("persists user imports additively and makes re-import idempotent", async () => {
    const root = await makeRoot();
    const first = entry("wp-artist-1");
    const initial = await loadArtistPromptPresetLibrary(root);
    expect(initial.entries).toEqual([]);

    const saved = await appendArtistPromptPresets(root, [first, first]);
    expect(saved.entries).toEqual([first]);
    expect((await appendArtistPromptPresets(root, [first])).entries).toEqual([first]);
    expect(JSON.parse(await fs.readFile(artistPromptPresetLibraryPath(root), "utf8")).entries)
      .toHaveLength(1);
  });

  it("preserves existing content on id conflict instead of replacing it", async () => {
    const root = await makeRoot();
    const original = entry("wp-artist-1", { name: "Existing" });
    await appendArtistPromptPresets(root, [original]);

    await expect(appendArtistPromptPresets(root, [entry("wp-artist-1", { name: "Incoming" })]))
      .rejects.toThrow("Artist prompt preset id conflict");
    expect((await loadArtistPromptPresetLibrary(root)).entries).toEqual([original]);
    expect(mergeArtistPromptPresetLibrary([original], [entry("wp-artist-2")])).toHaveLength(2);
  });

  it("adds newly restored preview metadata to an identical record without replacing its existing preview", () => {
    const existingPreview = {
      id: "preview-existing",
      name: "existing.png",
      filePath: path.resolve("existing.png"),
      fileUrl: "nai-local://existing.png",
      createdAt: "2026-10-15T00:00:00.000Z",
    };
    const importedPreview = {
      id: "preview-imported",
      name: "imported.png",
      filePath: path.resolve("imported.png"),
      fileUrl: "nai-local://imported.png",
      createdAt: "2026-10-15T00:01:00.000Z",
    };
    const original = entry("wp-artist-1", { name: "Artist", tag: "artist", previewImages: [existingPreview] });
    const incoming = entry("wp-artist-1", { name: "Artist", tag: "artist", previewImages: [importedPreview] });

    const merged = mergeArtistPromptPresetLibrary([original], [incoming]);
    expect(merged[0].name).toBe("Artist");
    expect(merged[0].previewImages).toEqual([existingPreview, importedPreview]);
    expect(original.previewImages).toEqual([existingPreview]);
  });

  it("serializes concurrent imports so neither independent entry is lost", async () => {
    const root = await makeRoot();
    await Promise.all([
      appendArtistPromptPresets(root, [entry("wp-artist-1")]),
      appendArtistPromptPresets(root, [entry("wp-artist-2")]),
    ]);
    const saved = await loadArtistPromptPresetLibrary(root);
    expect(saved.entries.map((item) => item.id).sort()).toEqual(["wp-artist-1", "wp-artist-2"]);
  });

  it("recovers from the last valid backup after a damaged primary write", async () => {
    const root = await makeRoot();
    const first = entry("wp-artist-1");
    const second = entry("wp-artist-2");
    await appendArtistPromptPresets(root, [first]);
    await appendArtistPromptPresets(root, [second]);
    await fs.writeFile(artistPromptPresetLibraryPath(root), "{ damaged", "utf8");
    expect((await loadArtistPromptPresetLibrary(root)).entries).toEqual([first]);
  });
});

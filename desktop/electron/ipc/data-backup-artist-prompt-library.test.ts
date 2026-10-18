import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import JSZip from "jszip";

const fixture = vi.hoisted(() => ({
  root: "",
  store: { settings: {} as any, history: [] as any[], historyGroups: [] as any[], reverseHistory: [] as any[], convertHistory: [] as any[] },
}));
const roots: string[] = [];

vi.mock("electron", () => ({
  app: { getPath: () => fixture.root, getVersion: () => "test" },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
}));
vi.mock("./store", () => ({
  credentialIssues: () => [],
  defaultSettings: {},
  readStore: () => fixture.store,
  writeStore: (value: unknown) => { fixture.store = value as typeof fixture.store; },
  ensureOutputDir: () => fixture.root,
}));
vi.mock("./agent-store", async () => ({
  ...(await import("./data-backup-agent-store-test-helper")).dataBackupAgentStoreStub(),
  agentAttachmentsDirectory: () => fixture.root,
  mergeImportedAgentWorkspace: vi.fn(() => ({ imported: 0, skipped: 0, renamed: 0 })),
}));
vi.mock("./artist-favorites", () => ({
  ARTIST_FAVORITE_COLLECTIONS: ["random", "v5-repair", "artist-string-draw"],
  loadArtistFavoriteLibrary: vi.fn(async () => ({ collections: { random: [], "v5-repair": [], "artist-string-draw": [] } })),
  importArtistFavoriteLibrary: vi.fn(),
}));
vi.mock("./reference-presets", () => ({
  listReferencePresets: async () => ({ groups: [], presets: [] }),
  importReferencePresets: vi.fn(),
}));

import { exportDataBackup, importDataBackup } from "./data-backup";
import {
  appendArtistPromptPresets,
  artistPromptPresetLibraryPath,
  loadArtistPromptPresetLibrary,
} from "./artist-prompt-presets";

function artist(id: string, name = `Artist ${id}`, tag = `artist_${id}`, filePath?: string) {
  return {
    id,
    name,
    tag,
    categories: ["artist"],
    danbooruCount: 21,
    createdAt: "2026-10-15T00:00:00.000Z",
    previewImages: filePath ? [{
      id: `preview-${id}`,
      name: "portrait.png",
      filePath,
      fileUrl: `file://${filePath}`,
      createdAt: "2026-10-15T00:01:00.000Z",
    }] : [],
  };
}

function style(id: string, name: string, prompt: string, filePath?: string) {
  return {
    id,
    name,
    prompt,
    group: "Default",
    createdAt: "2026-10-15T00:00:00.000Z",
    rating: 0,
    usageCount: 0,
    previewImages: filePath ? [{
      id: `preview-${id}`,
      name: "portrait.png",
      filePath,
      fileUrl: `file://${filePath}`,
      createdAt: "2026-10-15T00:01:00.000Z",
    }] : [],
  };
}

async function makeRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wp-prompt-backup-"));
  roots.push(root);
  return root;
}

async function importArchive(filePath: string) {
  return importDataBackup({
    path: filePath,
    categories: ["promptPresets"],
    confirmConfigurationOverwrite: false,
  });
}

beforeEach(async () => {
  fixture.root = await makeRoot();
  fixture.store = {
    settings: { outputDir: fixture.root, promptTemplates: [], stylePromptPresetGroups: ["Default"], stylePromptPresets: [], positivePromptPresets: [], promptChunks: [] },
    history: [], historyGroups: [], reverseHistory: [], convertHistory: [],
  };
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("artist prompt library backup integration", () => {
  it("exports, imports and re-exports prompt entries with preview bytes while preserving receiver data", async () => {
    const sourceRoot = fixture.root;
    const sourceImage = path.join(sourceRoot, "portrait.png");
    const imageBytes = Buffer.from("synthetic preview image bytes");
    await fs.writeFile(sourceImage, imageBytes);
    fixture.store.settings.stylePromptPresets = [style("wp-style-donor", "Donor style", "soft watercolor", sourceImage)];
    await appendArtistPromptPresets(sourceRoot, [artist("wp-artist-donor", "Donor artist", "donor_artist", sourceImage)]);

    const exported = await exportDataBackup({ categories: ["promptPresets"], destination: "internal" });
    expect(exported.ok, exported.message).toBe(true);
    const archive = await JSZip.loadAsync(await fs.readFile(exported.path!));
    const payload = JSON.parse(await archive.file("data/prompt-presets.json")!.async("string"));
    expect(payload.artistPromptPresets).toHaveLength(1);
    expect(payload.artistPromptPresets[0]).not.toHaveProperty("filePath");
    const sourceAsset = payload.artistPromptPresets[0].previewImages[0].asset;
    expect(await archive.file(sourceAsset.asset)!.async("nodebuffer")).toEqual(imageBytes);

    const receiverRoot = await makeRoot();
    fixture.root = receiverRoot;
    const existingImage = path.join(receiverRoot, "keep.png");
    await fs.writeFile(existingImage, "receiver image");
    fixture.store.settings.stylePromptPresets = [style("user-style", "My style", "keep this")];
    await appendArtistPromptPresets(receiverRoot, [artist("wp-artist-local", "Local artist", "local_artist", existingImage)]);

    const firstImport = await importArchive(exported.path!);
    expect(firstImport.ok, firstImport.message).toBe(true);
    expect(fixture.store.settings.stylePromptPresets.map((item: any) => item.id)).toEqual(["user-style", "wp-style-donor"]);
    const firstLibrary = await loadArtistPromptPresetLibrary(receiverRoot);
    expect(firstLibrary.entries.map((item) => item.id).sort()).toEqual(["wp-artist-donor", "wp-artist-local"]);
    const importedArtist = firstLibrary.entries.find((item) => item.id === "wp-artist-donor")!;
    expect(importedArtist.previewImages).toHaveLength(1);
    expect(await fs.readFile(importedArtist.previewImages[0].filePath)).toEqual(imageBytes);

    const secondImport = await importArchive(exported.path!);
    expect(secondImport.ok, secondImport.message).toBe(true);
    const afterRepeat = await loadArtistPromptPresetLibrary(receiverRoot);
    expect(afterRepeat.entries).toHaveLength(2);
    expect(afterRepeat.entries.find((item) => item.id === "wp-artist-donor")!.previewImages).toHaveLength(1);

    const reExported = await exportDataBackup({ categories: ["promptPresets"], destination: "internal" });
    expect(reExported.ok, reExported.message).toBe(true);
    const roundTrip = await JSZip.loadAsync(await fs.readFile(reExported.path!));
    const roundTripPayload = JSON.parse(await roundTrip.file("data/prompt-presets.json")!.async("string"));
    const roundTripArtist = roundTripPayload.artistPromptPresets.find((item: any) => item.id === "wp-artist-donor");
    const roundTripAsset = roundTripArtist.previewImages[0].asset;
    expect(roundTripAsset.sha256).toBe(crypto.createHash("sha256").update(imageBytes).digest("hex"));
    expect(await roundTrip.file(roundTripAsset.asset)!.async("nodebuffer")).toEqual(imageBytes);
    expect(JSON.parse(await fs.readFile(artistPromptPresetLibraryPath(receiverRoot), "utf8")).entries).toHaveLength(2);
  });

  it("renames a conflicting artist id deterministically and never replaces the receiver entry", async () => {
    const sourceRoot = fixture.root;
    await appendArtistPromptPresets(sourceRoot, [artist("shared-id", "Imported", "imported_artist")]);
    const exported = await exportDataBackup({ categories: ["promptPresets"], destination: "internal" });
    expect(exported.ok, exported.message).toBe(true);

    const receiverRoot = await makeRoot();
    fixture.root = receiverRoot;
    const original = artist("shared-id", "Keep this", "keep_this_artist");
    await appendArtistPromptPresets(receiverRoot, [original]);
    const first = await importArchive(exported.path!);
    expect(first.ok, first.message).toBe(true);
    const saved = await loadArtistPromptPresetLibrary(receiverRoot);
    expect(saved.entries).toHaveLength(2);
    expect(saved.entries.find((item) => item.id === "shared-id")).toEqual(original);
    const renamed = saved.entries.find((item) => item.id !== "shared-id")!;
    expect(renamed.id).toMatch(/^backup-artist-[a-f0-9]{64}$/);

    const repeat = await importArchive(exported.path!);
    expect(repeat.ok, repeat.message).toBe(true);
    const afterRepeat = await loadArtistPromptPresetLibrary(receiverRoot);
    expect(afterRepeat.entries).toHaveLength(2);
    expect(afterRepeat.entries.find((item) => item.id === "shared-id")).toEqual(original);
  });

  it("keeps importing legacy prompt preset archives without artist prompt data", async () => {
    const original = artist("wp-artist-local", "Local artist", "local_artist");
    await appendArtistPromptPresets(fixture.root, [original]);
    const zip = new JSZip();
    zip.file("manifest.json", JSON.stringify({
      format: "langbai-novelai-studio-backup",
      version: 1,
      categories: [{ category: "promptPresets", items: 0, bytes: 0 }],
    }));
    zip.file("data/prompt-presets.json", JSON.stringify({ stylePromptPresets: [] }));
    const filePath = path.join(fixture.root, "legacy.naisbackup");
    await fs.writeFile(filePath, await zip.generateAsync({ type: "nodebuffer" }));

    const result = await importArchive(filePath);
    expect(result.ok, result.message).toBe(true);
    expect((await loadArtistPromptPresetLibrary(fixture.root)).entries).toEqual([original]);
  });
});

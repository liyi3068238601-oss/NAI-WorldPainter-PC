import fs from "node:fs/promises";
import path from "node:path";
import {
  phoneArtistFingerprint,
  type ArtistPromptPreset,
} from "../../src/worldpainter-material-import";
import type { StylePromptPreviewImage } from "../../src/types";

export interface ArtistPromptPresetLibrarySnapshot {
  version: 1;
  updatedAt: string;
  entries: ArtistPromptPreset[];
}

const FILE_NAME = "artist-prompt-presets.v1.json";
const writeQueues = new Map<string, Promise<void>>();

function emptyLibrary(): ArtistPromptPresetLibrarySnapshot {
  return { version: 1, updatedAt: new Date(0).toISOString(), entries: [] };
}

function normalizePreviewImage(value: unknown): StylePromptPreviewImage | null {
  if (!value || typeof value !== "object") return null;
  const image = value as Record<string, unknown>;
  if (!["id", "name", "filePath", "fileUrl", "createdAt"].every(
    (key) => typeof image[key] === "string" && (image[key] as string).trim(),
  )) return null;
  return {
    id: (image.id as string).trim(),
    name: (image.name as string).trim(),
    filePath: image.filePath as string,
    fileUrl: image.fileUrl as string,
    createdAt: image.createdAt as string,
  };
}

function normalizeEntry(value: unknown): ArtistPromptPreset | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  const id = typeof entry.id === "string" ? entry.id.trim() : "";
  const name = typeof entry.name === "string" ? entry.name.trim() : "";
  const tag = typeof entry.tag === "string" ? entry.tag.trim() : "";
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(id) || !name || !tag) return null;
  const categories = Array.isArray(entry.categories)
    ? [...new Set(entry.categories.filter((item): item is string => typeof item === "string")
      .map((item) => item.trim()).filter(Boolean))]
    : [];
  const count = Number(entry.danbooruCount ?? 0);
  const createdAt = typeof entry.createdAt === "string" && Number.isFinite(Date.parse(entry.createdAt))
    ? entry.createdAt
    : new Date(0).toISOString();
  const previewImages = Array.isArray(entry.previewImages)
    ? entry.previewImages.map(normalizePreviewImage).filter((image): image is StylePromptPreviewImage => !!image)
    : [];
  return {
    id,
    name,
    tag,
    categories,
    danbooruCount: Number.isFinite(count) && count >= 0 ? Math.trunc(count) : 0,
    createdAt,
    previewImages,
  };
}

function normalizeLibrary(value: unknown): ArtistPromptPresetLibrarySnapshot | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  if (source.version !== 1 || !Array.isArray(source.entries)) return null;
  const entries = source.entries.map(normalizeEntry).filter((entry): entry is ArtistPromptPreset => !!entry);
  const unique: ArtistPromptPreset[] = [];
  const seenIds = new Set<string>();
  for (const entry of entries) {
    if (seenIds.has(entry.id)) continue;
    seenIds.add(entry.id);
    unique.push(entry);
  }
  return {
    version: 1,
    updatedAt: typeof source.updatedAt === "string" && Number.isFinite(Date.parse(source.updatedAt))
      ? source.updatedAt
      : new Date(0).toISOString(),
    entries: unique,
  };
}

export function artistPromptPresetLibraryPath(userDataRoot: string) {
  return path.join(userDataRoot, FILE_NAME);
}

async function readJson(filePath: string): Promise<ArtistPromptPresetLibrarySnapshot | null> {
  try {
    return normalizeLibrary(JSON.parse(await fs.readFile(filePath, "utf8")));
  } catch {
    return null;
  }
}

/** Load the user-owned tag library, recovering from its rolling backup if needed. */
export async function loadArtistPromptPresetLibrary(
  userDataRoot: string,
): Promise<ArtistPromptPresetLibrarySnapshot> {
  const target = artistPromptPresetLibraryPath(userDataRoot);
  return await readJson(target)
    ?? await readJson(`${target}.bak`)
    ?? emptyLibrary();
}

async function writeLibrary(userDataRoot: string, snapshot: ArtistPromptPresetLibrarySnapshot) {
  await fs.mkdir(userDataRoot, { recursive: true });
  const target = artistPromptPresetLibraryPath(userDataRoot);
  const temporary = `${target}.${process.pid}.tmp`;
  if (await readJson(target)) {
    await fs.copyFile(target, `${target}.bak`).catch(() => undefined);
  }
  await fs.writeFile(temporary, `${JSON.stringify(snapshot)}\n`, "utf8");
  try {
    await fs.rename(temporary, target);
  } catch {
    await fs.copyFile(temporary, target);
    await fs.unlink(temporary).catch(() => undefined);
  }
}

function sameEntry(left: ArtistPromptPreset, right: ArtistPromptPreset) {
  return phoneArtistFingerprint(left) === phoneArtistFingerprint(right);
}

/**
 * Add imported entries without replacing an existing record. Re-imports are
 * idempotent; an id collision with different content fails closed.
 */
export function mergeArtistPromptPresetLibrary(
  current: readonly ArtistPromptPreset[],
  incoming: readonly unknown[],
): ArtistPromptPreset[] {
  const merged = [...current];
  const byId = new Map(merged.map((entry) => [entry.id, entry]));
  for (const raw of incoming) {
    const entry = normalizeEntry(raw);
    if (!entry) throw new TypeError("An artist prompt preset is malformed.");
    const existing = byId.get(entry.id);
    if (existing) {
      if (!sameEntry(existing, entry)) {
        throw new Error(`Artist prompt preset id conflict: ${entry.id}`);
      }
      const previews = new Map(existing.previewImages.map((image) => [image.id, image]));
      const existingPaths = new Set(existing.previewImages.map((image) => path.resolve(image.filePath)));
      for (const image of entry.previewImages) {
        if (previews.has(image.id) || existingPaths.has(path.resolve(image.filePath))) continue;
        previews.set(image.id, image);
        existingPaths.add(path.resolve(image.filePath));
      }
      if (previews.size !== existing.previewImages.length) {
        const index = merged.findIndex((item) => item.id === entry.id);
        merged[index] = { ...existing, previewImages: [...previews.values()] };
        byId.set(entry.id, merged[index]);
      }
      continue;
    }
    merged.push(entry);
    byId.set(entry.id, entry);
  }
  return merged;
}

/** Serialized append-only writes prevent two simultaneous imports from losing entries. */
export function appendArtistPromptPresets(
  userDataRoot: string,
  incoming: readonly unknown[],
): Promise<ArtistPromptPresetLibrarySnapshot> {
  const root = path.resolve(userDataRoot);
  const previous = writeQueues.get(root) ?? Promise.resolve();
  let result: ArtistPromptPresetLibrarySnapshot | undefined;
  const next = previous.catch(() => undefined).then(async () => {
    const current = await loadArtistPromptPresetLibrary(root);
    result = {
      version: 1,
      updatedAt: new Date().toISOString(),
      entries: mergeArtistPromptPresetLibrary(current.entries, incoming),
    };
    await writeLibrary(root, result);
  });
  writeQueues.set(root, next);
  const cleanup = () => {
    if (writeQueues.get(root) === next) writeQueues.delete(root);
  };
  void next.then(cleanup, cleanup);
  return next.then(() => result!);
}

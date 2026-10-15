import type { StylePromptPreviewImage } from "./types";

/**
 * Read-only parser and merge helpers for user-selected WorldPainter mobile
 * prompt-library JSON. Nothing in this module bundles or fetches the source
 * data; callers must explicitly choose the JSON and any preview images.
 */

export interface PhonePromptImportIssue {
  row?: number;
  field?: string;
  message: string;
}

export interface PhonePromptImportResult<T> {
  items: T[];
  sourceRows: number;
  issues: PhonePromptImportIssue[];
}

export interface ImportedPhoneStyle {
  id: string;
  name: string;
  prompt: string;
  /** Safe basename only; the caller must match it to a user-selected file. */
  assetImage: string | null;
}

export interface ImportedPhoneArtist {
  id: string;
  name: string;
  tag: string;
  categories: string[];
  danbooruCount: number;
  createdAt: string;
  /** Safe basename only; the caller must match it to a user-selected file. */
  assetImage: string | null;
}

/** User-owned persistent artist prompt entry, stored apart from result favorites. */
export interface ArtistPromptPreset {
  id: string;
  name: string;
  tag: string;
  categories: string[];
  danbooruCount: number;
  createdAt: string;
  previewImages: StylePromptPreviewImage[];
}

export type PhoneImportConflict = "none" | "exact-duplicate" | "name-or-tag-conflict";
export type PhoneAssetMatch =
  | { status: "no-reference" | "missing" }
  | { status: "matched"; filename: string }
  | { status: "ambiguous"; filenames: string[] };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new TypeError(`${label} JSON is invalid: ${detail}`);
  }
}

function nonEmptyText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizedText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function stableHash(value: string): string {
  // FNV-1a 64-bit gives deterministic namespaced ids in both Chromium and
  // Node without requiring Node crypto in the renderer bundle.
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function importAssetBasename(value: unknown): { basename: string | null; issue?: string } {
  if (value === undefined || value === null || value === "") return { basename: null };
  if (typeof value !== "string") return { basename: null, issue: "assetImage must be a relative image path." };
  const normalized = value.trim().replace(/\\/g, "/");
  const segments = normalized.split("/");
  const basename = segments.at(-1) ?? "";
  if (
    !normalized
    || normalized.startsWith("/")
    || /^[a-z]:/i.test(normalized)
    || segments.some((segment) => segment === "..")
    || !basename
  ) {
    return { basename: null, issue: "assetImage must not be absolute or traverse parent folders." };
  }
  if (!/\.(?:jpe?g|png|webp)$/i.test(basename)) {
    return { basename: null, issue: "assetImage is not a supported JPG, PNG, or WebP file." };
  }
  return { basename };
}

/** Match only a safe JSON basename against filenames the user explicitly chose. */
export function matchPhoneAssetFilename(
  assetImage: string | null,
  selectedFilenames: readonly string[],
): PhoneAssetMatch {
  if (!assetImage) return { status: "no-reference" };
  const matches = selectedFilenames.filter((filename) => filename.toLocaleLowerCase() === assetImage.toLocaleLowerCase());
  if (matches.length === 0) return { status: "missing" };
  if (matches.length > 1) return { status: "ambiguous", filenames: matches };
  return { status: "matched", filename: matches[0] };
}

function distinctStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const text = nonEmptyText(entry);
    if (!text) continue;
    const key = normalizedText(text);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

export function phoneStyleFingerprint(value: Pick<ImportedPhoneStyle, "name" | "prompt">): string {
  return `${normalizedText(value.name)}\u0000${value.prompt.trim()}`;
}

export function phoneArtistTagKey(value: Pick<ImportedPhoneArtist, "tag">): string {
  return normalizedText(value.tag.replace(/\s+/g, "_"));
}

export function phoneArtistFingerprint(
  value: Pick<ImportedPhoneArtist, "name" | "tag" | "categories" | "danbooruCount">,
): string {
  return JSON.stringify([
    normalizedText(value.name),
    phoneArtistTagKey(value),
    [...value.categories].map(normalizedText).sort(),
    value.danbooruCount,
  ]);
}

export function parsePhoneStylePresetsJson(text: string): PhonePromptImportResult<ImportedPhoneStyle> {
  const parsed = readJson(text, "Style presets");
  const root = asRecord(parsed);
  const rows = Array.isArray(parsed)
    ? parsed
    : Array.isArray(root?.styles)
      ? root.styles
      : null;
  if (!rows) throw new TypeError("Style presets must be a JSON array (or an object with a styles array).");

  const issues: PhonePromptImportIssue[] = [];
  const items: ImportedPhoneStyle[] = [];
  const seen = new Set<string>();
  rows.forEach((raw, index) => {
    const row = asRecord(raw);
    const name = nonEmptyText(row?.title ?? row?.name);
    const prompt = nonEmptyText(row?.prompt);
    if (!row || !name || !prompt) {
      issues.push({ row: index + 1, message: "Skipped: each style needs a non-empty title/name and prompt." });
      return;
    }
    const image = importAssetBasename(row.assetImage);
    if (image.issue) issues.push({ row: index + 1, field: "assetImage", message: image.issue });
    const item: ImportedPhoneStyle = {
      id: `wp-style-${stableHash(phoneStyleFingerprint({ name, prompt }))}`,
      name,
      prompt,
      assetImage: image.basename,
    };
    const fingerprint = phoneStyleFingerprint(item);
    if (seen.has(fingerprint)) {
      issues.push({ row: index + 1, message: "Duplicate style row skipped." });
      return;
    }
    seen.add(fingerprint);
    items.push(item);
  });
  return { items, sourceRows: rows.length, issues };
}

export function parsePhoneArtistPromptsJson(text: string): PhonePromptImportResult<ImportedPhoneArtist> {
  const parsed = readJson(text, "Artist prompts");
  const root = asRecord(parsed);
  const rows = Array.isArray(parsed) ? parsed : Array.isArray(root?.artists) ? root.artists : null;
  if (!rows) throw new TypeError("Artist prompts must be a JSON array or an object with an artists array.");

  const issues: PhonePromptImportIssue[] = [];
  const items: ImportedPhoneArtist[] = [];
  const seen = new Set<string>();
  rows.forEach((raw, index) => {
    const row = asRecord(raw);
    const tag = nonEmptyText(row?.tag);
    const name = nonEmptyText(row?.name) ?? tag;
    if (!row || !name || !tag) {
      issues.push({ row: index + 1, message: "Skipped: each artist needs a non-empty name and tag." });
      return;
    }
    if (row.categories !== undefined && !Array.isArray(row.categories)) {
      issues.push({ row: index + 1, field: "categories", message: "Invalid categories were ignored." });
    }
    const countValue = Number(row.danbooruCount ?? 0);
    const danbooruCount = Number.isFinite(countValue) && countValue >= 0
      ? Math.trunc(countValue)
      : 0;
    if (row.danbooruCount !== undefined && danbooruCount !== countValue) {
      issues.push({ row: index + 1, field: "danbooruCount", message: "Invalid count was normalized to 0." });
    }
    const createdAtValue = Number(row.createdAt);
    const sourceDate = Number.isFinite(createdAtValue) && createdAtValue > 0
      ? new Date(createdAtValue)
      : new Date(0);
    const createdAt = Number.isFinite(sourceDate.getTime())
      ? sourceDate.toISOString()
      : new Date(0).toISOString();
    const image = importAssetBasename(row.assetImage);
    if (image.issue) issues.push({ row: index + 1, field: "assetImage", message: image.issue });
    const item: ImportedPhoneArtist = {
      id: `wp-artist-${stableHash(phoneArtistFingerprint({ name, tag, categories: distinctStrings(row.categories), danbooruCount }))}`,
      name,
      tag,
      categories: distinctStrings(row.categories),
      danbooruCount,
      createdAt,
      assetImage: image.basename,
    };
    const fingerprint = phoneArtistFingerprint(item);
    if (seen.has(fingerprint)) {
      issues.push({ row: index + 1, message: "Duplicate artist row skipped." });
      return;
    }
    seen.add(fingerprint);
    items.push(item);
  });
  return { items, sourceRows: rows.length, issues };
}

export function classifyPhoneStyleConflict<T extends { name: string; prompt: string }>(
  incoming: ImportedPhoneStyle,
  existing: readonly T[],
): PhoneImportConflict {
  if (existing.some((item) => phoneStyleFingerprint(item) === phoneStyleFingerprint(incoming))) {
    return "exact-duplicate";
  }
  if (existing.some((item) => normalizedText(item.name) === normalizedText(incoming.name))) {
    return "name-or-tag-conflict";
  }
  return "none";
}

export function classifyPhoneArtistConflict<T extends {
  name: string;
  tag: string;
  categories: string[];
  danbooruCount: number;
}>(incoming: ImportedPhoneArtist, existing: readonly T[]): PhoneImportConflict {
  if (existing.some((item) => phoneArtistFingerprint(item) === phoneArtistFingerprint(incoming))) {
    return "exact-duplicate";
  }
  if (existing.some((item) => phoneArtistTagKey(item) === phoneArtistTagKey(incoming))) {
    return "name-or-tag-conflict";
  }
  return "none";
}

export function appendPhoneStyleImports<T extends { id: string; name: string; prompt: string }>(
  existing: readonly T[],
  incoming: readonly T[],
): T[] {
  const result = [...existing];
  const ids = new Set(result.map((item) => item.id));
  const fingerprints = new Set(result.map(phoneStyleFingerprint));
  for (const item of incoming) {
    const fingerprint = phoneStyleFingerprint(item);
    if (ids.has(item.id) || fingerprints.has(fingerprint)) continue;
    result.push(item);
    ids.add(item.id);
    fingerprints.add(fingerprint);
  }
  return result;
}

export function appendPhoneArtistImports<T extends {
  id: string;
  name: string;
  tag: string;
  categories: string[];
  danbooruCount: number;
}>(existing: readonly T[], incoming: readonly T[]): T[] {
  const result = [...existing];
  const ids = new Set(result.map((item) => item.id));
  const fingerprints = new Set(result.map(phoneArtistFingerprint));
  for (const item of incoming) {
    const fingerprint = phoneArtistFingerprint(item);
    if (ids.has(item.id) || fingerprints.has(fingerprint)) continue;
    result.push(item);
    ids.add(item.id);
    fingerprints.add(fingerprint);
  }
  return result;
}

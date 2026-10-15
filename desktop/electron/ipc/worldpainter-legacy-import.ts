import { app, dialog, ipcMain } from "electron";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { LegacyImportPreview, LegacyImportResult } from "../../src/agent/legacy-import-types";
import { convertLegacySnapshot, legacyAgentWorkspace, legacyLastGenerationState, type LegacyAsset, type LegacyWorkspaceSnapshot } from "./legacy-import-converter";
import { readLegacyWorkspaceReadOnly } from "./legacy-import-sqlite";
import { readStore, writeStore } from "./store";
import { mergeImportedAgentWorkspace, readAgentWorkspace } from "./agent-store";
import { appendArtistPromptPresets, loadArtistPromptPresetLibrary } from "./artist-prompt-presets";
import { toLocalMediaUrl } from "./local-media-protocol";

const MAX_ROWS = 25_000;
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 100_000_000;
const previews = new Map<string, { filePath: string; fingerprint: string; expiresAt: number }>();

interface ValidatedImage { ref: string; digest: string; extension: string; bytes: Buffer; width: number; height: number; mime: string; }
const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

function safeDraft(draft: Record<string, unknown>) {
  const fields = ["prompt", "negative", "model", "provider", "width", "height", "steps", "cfg", "seedText", "generation", "batchCount"];
  return Object.fromEntries(fields.filter((key) => key in draft).map((key) => [key, draft[key]]));
}
function safeSession(raw: unknown) {
  const session = asRecord(raw);
  if (!session) return null;
  return {
    id: session.id, title: session.title, input: session.input, attachments: session.attachments,
    turns: Array.isArray(session.turns) ? session.turns.map((rawTurn) => {
      const turn = asRecord(rawTurn);
      if (!turn) return null;
      return {
        id: turn.id, userText: turn.userText, attachments: turn.attachments,
        messages: Array.isArray(turn.messages) ? turn.messages.map((rawMessage) => {
          const message = asRecord(rawMessage);
          return message && message.role === "assistant" ? { role: message.role, content: message.content } : { role: message?.role };
        }) : [],
      };
    }) : [],
  };
}
function safeMemories(raw: unknown) {
  const library = asRecord(raw);
  if (!library) return null;
  return {
    schema: library.schema,
    entries: Array.isArray(library.entries) ? library.entries.map((rawEntry) => {
      const entry = asRecord(rawEntry);
      if (!entry) return null;
      return Object.fromEntries(["id", "trigger", "content", "kind", "source", "hitCount", "lastHitAt", "createdAt", "updatedAt", "supersededBy"]
        .filter((key) => key in entry).map((key) => [key, entry[key]]));
    }) : [],
  };
}
function fingerprint(snapshot: LegacyWorkspaceSnapshot): string {
  const draft = asRecord(snapshot.draft) ?? {};
  const assistant = asRecord(snapshot.extra.assistant) ?? {};
  const library = asRecord(snapshot.extra.promptLibrary) ?? {};
  const safe = {
    schemaVersion: snapshot.schemaVersion, revision: snapshot.revision, draft: safeDraft(draft),
    gallery: snapshot.gallery, preferences: snapshot.extra.preferences, editor: snapshot.extra.editor,
    promptLibrary: { styles: library.styles, artists: library.artists, groups: library.groups },
    vibeLibrary: snapshot.extra.vibeLibrary,
    assistant: {
      memories: safeMemories(assistant.memories),
      sessions: Array.isArray(assistant.sessions) ? assistant.sessions.map(safeSession) : [],
      activeSessionId: assistant.activeSessionId,
    },
  };
  return createHash("sha256").update(JSON.stringify(safe)).digest("hex");
}
function collectRefs(snapshot: LegacyWorkspaceSnapshot): Set<string> {
  const refs = new Set<string>();
  const add = (value: unknown) => { if (typeof value === "string" && value) refs.add(value); };
  for (const raw of snapshot.gallery) add(asRecord(raw)?.assetRef);
  const library = asRecord(snapshot.extra.promptLibrary);
  if (Array.isArray(library?.styles)) for (const raw of library.styles) {
    const item = asRecord(raw); add(item?.preview_asset_ref ?? item?.previewAssetRef);
  }
  const assistant = asRecord(snapshot.extra.assistant);
  if (Array.isArray(assistant?.sessions)) for (const raw of assistant.sessions) {
    const session = asRecord(raw);
    for (const ref of Array.isArray(session?.attachments) ? session.attachments : []) add(ref);
    if (Array.isArray(session?.turns)) for (const rawTurn of session.turns) {
      const turn = asRecord(rawTurn);
      for (const ref of Array.isArray(turn?.attachments) ? turn.attachments : []) add(ref);
    }
  }
  return refs;
}

function parseRef(ref: string) {
  const match = /^sha256\/([a-f0-9]{2})\/([a-f0-9]{64})\.(png|jpe?g|webp)$/i.exec(ref);
  if (!match || match[1].toLowerCase() !== match[2].slice(0, 2).toLowerCase()) return null;
  return { digest: match[2].toLowerCase(), extension: match[3].toLowerCase() };
}
async function readAssetPath(databaseFile: string, ref: string) {
  const parsed = parseRef(ref);
  if (!parsed) throw Error("图片引用不是受管 SHA-256 路径。");
  const root = path.join(path.dirname(databaseFile), "image_assets");
  let current = root;
  for (const part of ["sha256", parsed.digest.slice(0, 2), parsed.digest + "." + parsed.extension]) {
    current = path.join(current, part);
    const entry = await fs.lstat(current).catch(() => null);
    if (!entry || entry.isSymbolicLink() || (part.includes(".") ? !entry.isFile() : !entry.isDirectory())) throw Error("图片资产不存在或路径不安全。");
  }
  const actual = await fs.realpath(current);
  const relative = path.relative(root, actual);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw Error("图片资产路径越出旧工作区。");
  return actual;
}
async function validateAsset(databaseFile: string, ref: string): Promise<ValidatedImage> {
  const parsed = parseRef(ref);
  if (!parsed) throw Error("图片引用格式无效。");
  const bytes = await fs.readFile(await readAssetPath(databaseFile, ref));
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw Error("图片资产为空或超过 64 MiB。");
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== parsed.digest) throw Error("图片内容与 SHA-256 不匹配。");
  const metadata = await sharp(bytes, { limitInputPixels: MAX_IMAGE_PIXELS }).metadata();
  const matches = metadata.format === "png" && parsed.extension === "png"
    || metadata.format === "jpeg" && ["jpg", "jpeg"].includes(parsed.extension)
    || metadata.format === "webp" && parsed.extension === "webp";
  if (!matches || !metadata.width || !metadata.height || metadata.width * metadata.height > MAX_IMAGE_PIXELS) throw Error("图片格式、扩展名或尺寸校验失败。");
  return { ref, digest, extension: parsed.extension, bytes, width: metadata.width, height: metadata.height, mime: metadata.format === "jpeg" ? "image/jpeg" : "image/" + metadata.format };
}
function targetAssetPath(root: string, image: ValidatedImage) {
  return path.join(root, "legacy-import-assets", "sha256", image.digest.slice(0, 2), image.digest + "." + image.extension);
}
async function copyAsset(root: string, image: ValidatedImage): Promise<LegacyAsset> {
  const target = targetAssetPath(root, image);
  await fs.mkdir(path.dirname(target), { recursive: true });
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(target, "wx", 0o600);
    await handle.writeFile(image.bytes);
    await handle.sync();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const oldBytes = await fs.readFile(target);
    if (createHash("sha256").update(oldBytes).digest("hex") !== image.digest) throw Error("目标图片已有同名但哈希不同的文件，已停止导入。");
  } finally { await handle?.close(); }
  return { ref: image.ref, filePath: target, fileUrl: toLocalMediaUrl(target, image.digest), sha256: image.digest,
    width: image.width, height: image.height, byteLength: image.bytes.length, mime: image.mime };
}
async function inspectAssets(filePath: string, refs: Set<string>) {
  if (refs.size > MAX_ROWS) throw Error("旧工作区图片引用超过导入上限。");
  const images = new Map<string, ValidatedImage>();
  const failed = new Set<string>();
  for (const ref of refs) {
    try { images.set(ref, await validateAsset(filePath, ref)); } catch { failed.add(ref); }
  }
  return { images, failed };
}

function makePreview(filePath: string, snapshot: LegacyWorkspaceSnapshot, fingerprintValue: string, data: ReturnType<typeof convertLegacySnapshot>, assetCount: number, failed: number): LegacyImportPreview {
  const draft = data.params ? {
    positivePromptCharacters: data.params.positivePrompt.length, negativePromptCharacters: data.params.negativePrompt.length,
    width: data.params.width, height: data.params.height, model: data.params.model,
  } : undefined;
  return {
    previewId: randomUUID(), sourceFile: path.basename(filePath), schemaVersion: snapshot.schemaVersion, revision: snapshot.revision,
    counts: {
      draft: data.params ? 1 : 0, gallery: data.history.length, styles: data.styles.length, artists: data.artists.length,
      approvedMemories: data.memories.filter((item) => item.source !== "pendingLlmCandidate").length,
      pendingMemories: data.memories.filter((item) => item.source === "pendingLlmCandidate").length,
      sessions: data.conversations.length, assets: assetCount,
      archivedFields: Object.values(data.archivedFieldCounts).reduce((sum, count) => sum + count, 0),
      invalidRows: data.invalidRows, duplicateRows: data.duplicateRows, missingAssets: failed,
    },
    archivedFieldCounts: data.archivedFieldCounts, ...(draft ? { draft } : {}),
    samples: {
      gallery: data.history.slice(0, 5).map((item) => item.params.positivePrompt.slice(0, 48) || item.model),
      styles: data.styles.slice(0, 5).map((item) => item.name), artists: data.artists.slice(0, 5).map((item) => item.name),
      memories: data.memories.slice(0, 5).map((item) => item.title), sessions: data.conversations.slice(0, 5).map((item) => item.title),
    },
    warnings: [
      "预览只读取所选 SQLite 与受管图片，不会修改旧工作区。",
      "旧连接、提供商配置、凭据和诊断内容不会导入或写入归档。",
      ...(data.params ? ["草稿仅在新端没有已保存草稿且草稿恢复开启时导入。"] : []),
      ...(failed ? [failed + " 个图片引用缺失或未通过路径、格式、尺寸、哈希校验，将跳过。"] : []),
    ],
  };
}
async function saveArchive(root: string, fingerprintValue: string, archive: Record<string, unknown>) {
  const directory = path.join(root, "legacy-import-archive");
  await fs.mkdir(directory, { recursive: true });
  const content = JSON.stringify({ format: "worldpainter-flutter-import-v1", sourceFingerprint: fingerprintValue, createdAt: new Date().toISOString(), unconverted: archive }, null, 2) + "\n";
  const base = "flutter-import-" + fingerprintValue.slice(0, 16);
  for (let suffix = 0; suffix < 100; suffix++) {
    const fileName = base + (suffix ? "-" + (suffix + 1) : "") + ".json";
    const filePath = path.join(directory, fileName);
    try { await fs.writeFile(filePath, content, { encoding: "utf8", flag: "wx", mode: 0o600 }); return fileName; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await fs.readFile(filePath, "utf8") === content) return fileName;
    }
  }
  throw Error("无法分配不覆盖的导入归档文件名。");
}

export async function selectAndPreviewLegacyWorkspace(): Promise<LegacyImportPreview | null> {
  const selection = await dialog.showOpenDialog({ title: "选择 Flutter PC 工作区快照（只读）", properties: ["openFile"], filters: [{ name: "Flutter PC 工作区", extensions: ["sqlite"] }] });
  if (selection.canceled || !selection.filePaths[0]) return null;
  const filePath = selection.filePaths[0];
  const snapshot = readLegacyWorkspaceReadOnly(filePath);
  const fingerprintValue = fingerprint(snapshot);
  const checked = await inspectAssets(filePath, collectRefs(snapshot));
  const root = app.getPath("userData");
  const assets = new Map<string, LegacyAsset>();
  for (const image of checked.images.values()) assets.set(image.ref, {
    ref: image.ref, filePath: targetAssetPath(root, image), fileUrl: toLocalMediaUrl(targetAssetPath(root, image), image.digest),
    sha256: image.digest, width: image.width, height: image.height, byteLength: image.bytes.length, mime: image.mime,
  });
  const data = convertLegacySnapshot(snapshot, fingerprintValue, assets);
  const preview = makePreview(filePath, snapshot, fingerprintValue, data, assets.size, checked.failed.size);
  previews.set(preview.previewId, { filePath, fingerprint: fingerprintValue, expiresAt: Date.now() + 600_000 });
  for (const [id, item] of previews) if (item.expiresAt <= Date.now()) previews.delete(id);
  return preview;
}

export async function confirmLegacyWorkspaceImport(previewId: string): Promise<LegacyImportResult> {
  if (typeof previewId !== "string" || !previewId) throw Error("请先读取并检查旧工作区预览。");
  const selected = previews.get(previewId);
  previews.delete(previewId);
  if (!selected || selected.expiresAt <= Date.now()) throw Error("导入预览已失效，请重新选择文件。");
  const filePath = selected.filePath;
  const snapshot = readLegacyWorkspaceReadOnly(filePath);
  const fingerprintValue = fingerprint(snapshot);
  if (fingerprintValue !== selected.fingerprint) throw Error("旧工作区在预览后发生变化，请重新预览再导入。");

  const root = app.getPath("userData");
  const checked = await inspectAssets(filePath, collectRefs(snapshot));
  const assets = new Map<string, LegacyAsset>();
  for (const image of checked.images.values()) assets.set(image.ref, await copyAsset(root, image));
  const data = convertLegacySnapshot(snapshot, fingerprintValue, assets);
  const artistsBefore = await loadArtistPromptPresetLibrary(root);
  const artistsAfter = await appendArtistPromptPresets(root, data.artists);
  const artistIdsBefore = new Set(artistsBefore.entries.map((item) => item.id));
  const importedArtists = artistsAfter.entries.filter((item) => !artistIdsBefore.has(item.id) && data.artists.some((incoming) => incoming.id === item.id)).length;

  const oldAgent = readAgentWorkspace();
  const oldMemoryIds = new Set(oldAgent.memories.map((item) => item.id));
  const oldConversationIds = new Set(oldAgent.conversations.map((item) => item.id));
  const mergedAgent = mergeImportedAgentWorkspace(legacyAgentWorkspace(data));
  const newMemoryIds = new Set(mergedAgent.workspace.memories.filter((item) => !oldMemoryIds.has(item.id)).map((item) => item.id));
  const newConversationIds = new Set(mergedAgent.workspace.conversations.filter((item) => !oldConversationIds.has(item.id)).map((item) => item.id));

  // Artist and Agent persistence awaited above. Re-read immediately before the
  // synchronous store merge so concurrent settings/history updates are kept.
  const persisted = readStore();
  const skippedDraft = Boolean(data.params && (persisted.settings.lastGenerationState !== null || !persisted.settings.persistGenerateParams));
  const historyIds = new Set(persisted.history.map((item) => item.id));
  const addedHistory = data.history.filter((item) => !historyIds.has(item.id));
  const styleIds = new Set(persisted.settings.stylePromptPresets.map((item) => item.id));
  const addedStyles = data.styles.filter((item) => !styleIds.has(item.id));
  const groups = new Set(persisted.settings.stylePromptPresetGroups);
  const nextStore = {
    ...persisted,
    settings: {
      ...persisted.settings,
      stylePromptPresets: [...persisted.settings.stylePromptPresets, ...addedStyles],
      stylePromptPresetGroups: [...persisted.settings.stylePromptPresetGroups, ...addedStyles.map((item) => item.group).filter((group) => !groups.has(group))],
      ...(data.params && !skippedDraft ? { lastGenerationState: legacyLastGenerationState(data.params) } : {}),
    },
    history: [...addedHistory, ...persisted.history],
  };
  const unconverted = { ...data.archive };
  if (skippedDraft) unconverted["draft-current-state-preserved"] = {
    reason: persisted.settings.lastGenerationState !== null ? "已有新端草稿，保留不覆盖。" : "新端关闭了草稿恢复，保留设置。",
    legacyDraft: unconverted["draft-source"],
  };
  writeStore(nextStore);
  const archiveFileName = await saveArchive(root, fingerprintValue, unconverted);

  return {
    sourceFile: path.basename(filePath),
    imported: {
      draft: data.params && !skippedDraft ? 1 : 0,
      gallery: addedHistory.length, styles: addedStyles.length, artists: importedArtists,
      approvedMemories: data.memories.filter((item) => item.source !== "pendingLlmCandidate" && newMemoryIds.has(item.id)).length,
      pendingMemories: data.memories.filter((item) => item.source === "pendingLlmCandidate" && newMemoryIds.has(item.id)).length,
      sessions: data.conversations.filter((item) => newConversationIds.has(item.id)).length,
      assets: assets.size,
    },
    skipped: {
      draft: skippedDraft ? 1 : 0, invalidRows: data.invalidRows,
      duplicateRows: data.duplicateRows + data.history.length - addedHistory.length + data.styles.length - addedStyles.length
        + data.artists.length - importedArtists
        + data.memories.length - newMemoryIds.size
        + data.conversations.length - newConversationIds.size,
      missingAssets: checked.failed.size,
    },
    archiveFileName,
  };
}
export function cancelLegacyWorkspaceImport(previewId?: string) {
  if (previewId) previews.delete(previewId); else previews.clear();
}
export function registerWorldpainterLegacyImportIpc() {
  ipcMain.handle("worldpainter:legacy-import:preview", () => selectAndPreviewLegacyWorkspace());
  ipcMain.handle("worldpainter:legacy-import:confirm", (_event, previewId: string) => confirmLegacyWorkspaceImport(previewId));
  ipcMain.handle("worldpainter:legacy-import:cancel", (_event, previewId?: string) => cancelLegacyWorkspaceImport(previewId));
}

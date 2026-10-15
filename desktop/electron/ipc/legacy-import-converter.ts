import { createHash } from "node:crypto";
import {
  DEFAULT_PARAMS,
  normalizeGenerateParams,
  type GenerateParams,
  type HistoryItem,
  type LastGenerationState,
  type StylePromptPreset,
} from "../../src/types";
import {
  AGENT_WORKSPACE_VERSION,
  type AgentAttachment,
  type AgentConversation,
  type AgentMemory,
  type AgentMessage,
  type AgentWorkspaceData,
} from "../../src/agent/types";
import type { ArtistPromptPreset } from "../../src/worldpainter-material-import";

export interface LegacyWorkspaceSnapshot {
  schemaVersion: number;
  revision: number;
  draft: unknown;
  extra: Record<string, unknown>;
  gallery: unknown[];
}

export interface LegacyAsset {
  ref: string;
  filePath: string;
  fileUrl: string;
  sha256: string;
  width: number;
  height: number;
  byteLength: number;
  mime: string;
}

export interface LegacyConvertedData {
  params: GenerateParams | null;
  styles: StylePromptPreset[];
  artists: ArtistPromptPreset[];
  memories: AgentMemory[];
  conversations: AgentConversation[];
  history: HistoryItem[];
  archive: Record<string, unknown>;
  archivedFieldCounts: Record<string, number>;
  invalidRows: number;
  duplicateRows: number;
  missingAssets: number;
}

const EPOCH = new Date(0).toISOString();
const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
const text = (value: unknown, fallback = "") => typeof value === "string" ? value : fallback;
const finite = (value: unknown, fallback: number) => {
  const result = typeof value === "number" ? value : Number(value);
  return Number.isFinite(result) ? result : fallback;
};
const safeTime = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : EPOCH;
const list = (value: unknown) => Array.isArray(value) ? value : [];

export function legacyStableId(sourceFingerprint: string, kind: string, oldId: string): string {
  return `legacy-${createHash("sha256").update(`${sourceFingerprint}\0${kind}\0${oldId}`).digest("hex").slice(0, 28)}`;
}

export function legacyDraftParams(raw: unknown): GenerateParams | null {
  const draft = asRecord(raw);
  if (!draft) return null;
  const old = asRecord(draft.generation) ?? {};
  const seedText = text(draft.seedText).trim();
  const parsedSeed = /^\d{1,10}$/.test(seedText) ? Number(seedText) : undefined;
  const combined = {
    ...old,
    model: text(draft.model, text(old.model, DEFAULT_PARAMS.model)),
    positivePrompt: text(draft.prompt, text(old.prompt, text(old.positivePrompt))),
    negativePrompt: text(draft.negative, text(old.negativePrompt, text(old.negative_prompt))),
    width: finite(draft.width, finite(old.width, DEFAULT_PARAMS.width)),
    height: finite(draft.height, finite(old.height, DEFAULT_PARAMS.height)),
    steps: finite(draft.steps, finite(old.steps, DEFAULT_PARAMS.steps)),
    cfgScale: finite(draft.cfg, finite(old.scale, finite(old.cfgScale, DEFAULT_PARAMS.cfgScale))),
    cfgRescale: finite(old.cfgRescale, finite(old.cfg_rescale, DEFAULT_PARAMS.cfgRescale)),
    sampler: text(old.sampler, DEFAULT_PARAMS.sampler),
    noiseSchedule: text(old.noiseSchedule, text(old.noise_schedule, DEFAULT_PARAMS.noiseSchedule)),
    seed: parsedSeed ?? finite(old.seed, DEFAULT_PARAMS.seed),
    seedMode: parsedSeed === undefined && old.seed == null ? "random" : "fixed",
  } as Partial<GenerateParams>;
  return normalizeGenerateParams(combined);
}

export function legacyLastGenerationState(params: GenerateParams): LastGenerationState {
  return {
    params,
    charCaptions: [],
    batchCount: 1,
    batchIntervalSeconds: 0,
    i2iParams: { strength: 0.7, noise: 0, extraNoiseSeed: 0 },
    inpaintModel: "nai-diffusion-5-full-inpainting",
    inpaintSizeMode: "original",
    inpaintCustomSize: { width: 1024, height: 1024 },
    inpaintStrength: 1,
    inpaintNoise: 0,
    inpaintPositivePrompt: "",
    brushSize: 4,
    brushOpacity: 0.55,
    brushColor: "#ffffff",
    brushShape: "round",
    brushSizeUnit: "grid8",
    upscaleScale: 4,
    directorTool: "bg-removal",
    augmentOptions: { defry: 1, colorizePrompt: "", emotion: "neutral", emotionLevel: 1 },
  };
}

function attachment(asset: LegacyAsset, name: string, id: string): AgentAttachment {
  return {
    id,
    name: name || `${asset.sha256.slice(0, 12)}.${asset.mime.split("/")[1]}`,
    mime: asset.mime,
    size: asset.byteLength,
    kind: "image",
    filePath: asset.filePath,
    fileUrl: asset.fileUrl,
    width: asset.width,
    height: asset.height,
    createdAt: EPOCH,
  };
}

function assetFor(raw: unknown, assets: ReadonlyMap<string, LegacyAsset>): LegacyAsset | null {
  return typeof raw === "string" ? assets.get(raw) ?? null : null;
}

function message(role: AgentMessage["role"], id: string, content: string, attachments: AgentAttachment[] = []): AgentMessage {
  return { id, role, content, attachments, tools: [], status: "complete", createdAt: EPOCH, completedAt: EPOCH };
}

function convertConversation(raw: unknown, source: string, assets: ReadonlyMap<string, LegacyAsset>): AgentConversation | null {
  const session = asRecord(raw);
  if (!session || typeof session.id !== "string" || !session.id.trim()) return null;
  const messages: AgentMessage[] = [];
  let order = 0;
  for (const rawTurn of list(session.turns)) {
    const turn = asRecord(rawTurn);
    if (!turn) continue;
    const turnId = text(turn.id, `turn-${order}`);
    const attached: AgentAttachment[] = [];
    for (const ref of list(turn.attachments)) {
      const asset = assetFor(ref, assets);
      if (asset) attached.push(attachment(asset, "", legacyStableId(source, "attachment", `${turnId}:${ref}`)));
    }
    const userText = text(turn.userText);
    if (userText.trim() || attached.length) messages.push(message("user", legacyStableId(source, "message", `${turnId}:user`), userText, attached));
    for (const rawMessage of list(turn.messages)) {
      const oldMessage = asRecord(rawMessage);
      // Only user-visible assistant text is migrated. Tool messages and traces
      // are not made executable or copied into the active conversation.
      if (oldMessage?.role === "assistant" && typeof oldMessage.content === "string" && oldMessage.content.trim()) {
        messages.push(message("assistant", legacyStableId(source, "message", `${turnId}:assistant:${order++}`), oldMessage.content));
      }
    }
  }
  const draftAttachments: AgentAttachment[] = [];
  for (const ref of list(session.attachments)) {
    const asset = assetFor(ref, assets);
    if (asset) draftAttachments.push(attachment(asset, "", legacyStableId(source, "attachment", `draft:${ref}`)));
  }
  return {
    id: legacyStableId(source, "conversation", session.id),
    title: text(session.title, "旧版对话").trim().slice(0, 100) || "旧版对话",
    messages,
    draftAttachments,
    status: "idle",
    context: { used: 0, limit: 1, percent: 0, danger: false, estimated: true, updatedAt: EPOCH },
    compactCount: 0,
    createdAt: EPOCH,
    updatedAt: EPOCH,
    characterIds: [],
    lorebookIds: [],
    generationMode: "confirm",
    autoPlayGroup: false,
    pinned: false,
  };
}

export function convertLegacySnapshot(
  snapshot: LegacyWorkspaceSnapshot,
  sourceFingerprint: string,
  assets: ReadonlyMap<string, LegacyAsset>,
): LegacyConvertedData {
  let invalidRows = 0;
  let duplicateRows = 0;
  let missingAssets = 0;
  const archive: Record<string, unknown> = {};
  const archivedFieldCounts: Record<string, number> = {};
  const recordArchive = (key: string, value: unknown, count = Array.isArray(value) ? value.length : value == null ? 0 : 1) => {
    if (value == null || count < 1) return;
    archive[key] = value;
    archivedFieldCounts[key] = count;
  };
  const draft = asRecord(snapshot.draft);
  const params = legacyDraftParams(draft);
  if (draft) {
    // Explicit allowlist intentionally excludes the legacy `connections` tree.
    const safeDraft = Object.fromEntries(["prompt", "negative", "model", "provider", "width", "height", "steps", "cfg", "seedText", "generation", "batchCount"]
      .filter((key) => key in draft).map((key) => [key, draft[key]]));
    recordArchive("draft-source", safeDraft);
  }

  const library = asRecord(snapshot.extra.promptLibrary) ?? {};
  const rawStyles = list(library.styles);
  const styles: StylePromptPreset[] = [];
  const styleIds = new Set<string>();
  for (let styleIndex = 0; styleIndex < rawStyles.length; styleIndex++) {
    const raw = rawStyles[styleIndex];
    const item = asRecord(raw);
    const id = text(item?.id).trim();
    const name = text(item?.name).trim();
    const prompt = text(item?.prompt);
    if (!item || !id || !name || !prompt.trim()) {
      invalidRows++;
      // A style may carry a useful negative prompt even when the new schema
      // cannot represent it. Keep only the source fields we explicitly allow.
      if (item) recordArchive(`style-unconverted:${id || styleIndex}`, {
        id, name, prompt, negative: text(item.negative), category: text(item.category),
      });
      continue;
    }
    const importedId = legacyStableId(sourceFingerprint, "style", id);
    if (styleIds.has(importedId)) { duplicateRows++; continue; }
    styleIds.add(importedId);
    const previewRef = item.preview_asset_ref ?? item.previewAssetRef;
    const previewAsset = assetFor(previewRef, assets);
    if (previewRef && !previewAsset) missingAssets++;
    styles.push({
      id: importedId,
      name: name.slice(0, 100),
      prompt,
      group: text(item.category, "Default").trim() || "Default",
      createdAt: safeTime(item.created_at ?? item.createdAt),
      ...(previewAsset ? { previewImages: [{
        id: legacyStableId(sourceFingerprint, "style-preview", id),
        name: `${name} 预览图`, filePath: previewAsset.filePath, fileUrl: previewAsset.fileUrl, createdAt: EPOCH,
      }] } : {}),
    });
    recordArchive(`style-extra:${id}`, {
      negative: text(item.negative),
      updatedAt: safeTime(item.updated_at ?? item.updatedAt),
      ...(previewRef && !previewAsset ? { missingPreviewAsset: text(previewRef) } : {}),
    });
  }

  const artists: ArtistPromptPreset[] = [];
  const artistIds = new Set<string>();
  for (const raw of list(library.artists)) {
    const item = asRecord(raw);
    const id = text(item?.id).trim();
    const name = text(item?.name).trim();
    const tag = text(item?.prompt).trim();
    if (!item || !id || !name || !tag) { invalidRows++; continue; }
    const importedId = legacyStableId(sourceFingerprint, "artist", id);
    if (artistIds.has(importedId)) { duplicateRows++; continue; }
    artistIds.add(importedId);
    const categories = list(item.categories).filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim()).slice(0, 40);
    artists.push({ id: importedId, name: name.slice(0, 100), tag, categories,
      danbooruCount: Math.max(0, Math.trunc(finite(item.danbooru_count ?? item.danbooruCount, 0))), createdAt: safeTime(item.created_at ?? item.createdAt), previewImages: [] });
    recordArchive(`artist-extra:${id}`, {
      defaultWeight: finite(item.default_weight ?? item.defaultWeight, 1),
      useCount: Math.max(0, Math.trunc(finite(item.use_count ?? item.useCount, 0))),
      lastUsedAt: safeTime(item.last_used_at ?? item.lastUsedAt),
      updatedAt: safeTime(item.updated_at ?? item.updatedAt),
    });
  }
  recordArchive("prompt-library-groups", list(library.groups));

  const assistant = asRecord(snapshot.extra.assistant) ?? {};
  const memoryLibrary = asRecord(assistant.memories) ?? {};
  const rawMemories = list(memoryLibrary.entries);
  const memories: AgentMemory[] = [];
  const memoryIds = new Set<string>();
  for (const raw of rawMemories) {
    const item = asRecord(raw);
    const id = text(item?.id).trim();
    const trigger = text(item?.trigger).trim();
    const content = text(item?.content).trim();
    if (!item || !id || !trigger || !content) { invalidRows++; continue; }
    const importedId = legacyStableId(sourceFingerprint, "memory", id);
    if (memoryIds.has(importedId)) { duplicateRows++; continue; }
    memoryIds.add(importedId);
    const memoryType = text(item.kind).replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
    const validTypes = new Set(["characterName", "characterFeature", "style", "other", "fact", "preference", "observation", "decision"]);
    const sourceText = text(item.source);
    const source = new Set(["manual", "userInstruction", "llmCandidate", "pendingLlmCandidate"]).has(sourceText)
      ? sourceText as AgentMemory["source"] : "manual";
    memories.push({
      id: importedId,
      title: trigger.slice(0, 120), content: content.slice(0, 8000), trigger: trigger.slice(0, 200),
      scope: "global", type: validTypes.has(memoryType) ? memoryType as AgentMemory["type"] : "other", source,
      hitCount: Math.max(0, Math.trunc(finite(item.hitCount, 0))),
      ...(typeof item.lastHitAt === "string" && Number.isFinite(Date.parse(item.lastHitAt)) ? { lastHitAt: item.lastHitAt } : {}),
      ...(typeof item.supersededBy === "string" ? { supersededBy: legacyStableId(sourceFingerprint, "memory", item.supersededBy) } : {}),
      createdAt: safeTime(item.createdAt), updatedAt: safeTime(item.updatedAt),
    });
  }

  const conversations: AgentConversation[] = [];
  const conversationIds = new Set<string>();
  const rawSessions = list(assistant.sessions);
  for (const raw of rawSessions) {
    const item = asRecord(raw);
    if (!item || typeof item.id !== "string") { invalidRows++; continue; }
    const converted = convertConversation(item, sourceFingerprint, assets);
    if (!converted) { invalidRows++; continue; }
    if (conversationIds.has(converted.id)) { duplicateRows++; continue; }
    conversationIds.add(converted.id);
    conversations.push(converted);
    if (text(item.input).trim()) recordArchive(`session-draft:${item.id}`, { input: text(item.input) });
    let skippedToolMessages = 0;
    for (const turn of list(item.turns)) for (const oldMessage of list(asRecord(turn)?.messages)) {
      if (asRecord(oldMessage)?.role !== "assistant") skippedToolMessages++;
    }
    if (skippedToolMessages) recordArchive(`session-tool-messages:${item.id}`, { count: skippedToolMessages });
  }

  const history: HistoryItem[] = [];
  const historyIds = new Set<string>();
  for (const raw of snapshot.gallery) {
    const item = asRecord(raw);
    const oldId = text(item?.id).trim();
    if (!item || !oldId) { invalidRows++; continue; }
    // Demo records are reproducible UI fixtures, not user-owned image files.
    if (item.isDemo === true) {
      recordArchive(`gallery-demo:${oldId}`, { variant: finite(item.variant, 0), favorite: item.favorite === true });
      continue;
    }
    const asset = assetFor(item.assetRef, assets);
    if (!asset) { missingAssets++; recordArchive(`gallery-unresolved:${oldId}`, { assetRef: text(item.assetRef) }); continue; }
    const name = legacyStableId(sourceFingerprint, "gallery", oldId);
    if (historyIds.has(name)) { duplicateRows++; continue; }
    historyIds.add(name);
    const createdAt = safeTime(item.createdAt);
    const oldParams = asRecord(item.parameters) ?? {};
    const params = normalizeGenerateParams({
      ...oldParams,
      model: text(item.model, text(oldParams.model, DEFAULT_PARAMS.model)) as GenerateParams["model"],
      positivePrompt: text(item.prompt, text(oldParams.prompt)),
      negativePrompt: text(item.negative, text(oldParams.negativePrompt, text(oldParams.negative_prompt))),
      width: finite(item.width, asset.width), height: finite(item.height, asset.height),
      steps: finite(item.steps, finite(oldParams.steps, DEFAULT_PARAMS.steps)),
      cfgScale: finite(item.cfg, finite(oldParams.scale, finite(oldParams.cfgScale, DEFAULT_PARAMS.cfgScale))),
      seed: finite(item.seed, 0), seedMode: "fixed",
    });
    history.push({
      id: name, filePath: asset.filePath, fileUrl: asset.fileUrl,
      date: createdAt.slice(0, 10), createdAt, params, actualSeed: Math.max(0, Math.trunc(finite(item.seed, 0))),
      model: params.model, width: params.width, height: params.height, feature: "legacy-gallery",
      generatedImageSha256: asset.sha256,
    });
    recordArchive(`gallery-extra:${oldId}`, {
      title: text(item.title), variant: finite(item.variant, 0), favorite: item.favorite === true,
      provider: text(item.provider), isDemo: false,
      ...(item.editMetadata != null ? { editMetadata: item.editMetadata } : {}),
    });
  }

  const safePreferences = asRecord(snapshot.extra.preferences);
  if (safePreferences) recordArchive("preferences", {
    darkTheme: safePreferences.darkTheme === true,
    reduceMotion: safePreferences.reduceMotion === true,
  });
  const editor = asRecord(snapshot.extra.editor);
  if (editor) recordArchive("editor", editor);
  recordArchive("vibe-library", snapshot.extra.vibeLibrary);
  // Provider and credential settings, connection records, prompts, traces,
  // provider diagnostics and token-bearing error text are never accessed or archived.

  return { params, styles, artists, memories, conversations, history, archive, archivedFieldCounts, invalidRows, duplicateRows, missingAssets };
}

export function legacyAgentWorkspace(data: LegacyConvertedData): AgentWorkspaceData {
  return {
    version: AGENT_WORKSPACE_VERSION,
    conversations: data.conversations,
    skills: [], memories: data.memories,
    characters: [], personas: [], lorebooks: [], samplerPresets: [],
    defaultGenerationMode: "confirm", updatedAt: EPOCH,
    ...(data.conversations[0] ? { selectedConversationId: data.conversations[0].id } : {}),
  };
}

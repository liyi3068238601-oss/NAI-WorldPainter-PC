import {normalizeStudioDefaults} from '../../src/agent/preferences';
import {
  findAgentMemoryConflicts,
  isAgentMemorySource,
  isAgentMemoryType,
  isRetrievableAgentMemory,
  normalizeAgentMemoryContent,
  normalizeAgentMemorySnapshot,
  scoreAgentMemoryQuery,
} from '../../src/agent/memory';
import { normalizeStudioComposerActions } from '../../src/agent/composer-actions';
import {createBuiltinAgentSkills,studioBuiltinPreset,STUDIO_DEFAULT_PRESET_ID,STUDIO_LYRA_PRESET_ID,STUDIO_SKILL_LIMITS,type StudioConversationOptions} from '../../src/agent/workspace-controls';
import {decodeSystemPromptFile,importImageSystemPrompt,MAX_SYSTEM_PROMPT_IMPORT_BYTES,SystemPromptImportError} from '../../src/tavern/system-prompt-import';
import {systemPromptImportErrorText,systemPromptImportText} from '../../src/tavern/system-prompt-import-text';
import { recoverInterruptedImageRepairs } from "../../src/tavern/image-repair";
import { readSceneBindings } from "../../src/tavern/scene-bindings";
import { dialog } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  AgentAttachment,
  AgentConversation,
  AgentMemory,
  AgentMessage,
  AgentSkill,
  AgentWorkspaceData,
  AgentWorkspaceMutationResult,
  TavernImageProposal,
  TavernLorebook,
  TavernPersona,
  TavernSamplerPreset,
} from "../../src/agent/types";
import { AGENT_WORKSPACE_VERSION } from "../../src/agent/types";
import { createContextSnapshot, effectiveContextMessages } from "../../src/agent/context";
import { mergeAgentWorkspaces } from "../../src/agent/merge";
import {
  normalizeTavernCharacter,
  normalizeTavernLorebook,
  normalizeTavernPersona,
  normalizeTavernSamplerPreset,
} from "../../src/tavern/compat";
import {
  createSoftwareImageStarterKit,
  createTavernBuiltinSamplerPresets,
  SOFTWARE_IMAGE_CHARACTER_ID,
  SOFTWARE_IMAGE_LOREBOOK_ID,
  SOFTWARE_IMAGE_PERSONA_ID,
  TAVERN_PRESET_LIBRARY_VERSION,
} from "../../src/tavern/builtins";
import { toLocalMediaUrl } from "./local-media-protocol";
import { getSettings, getHistoryReferenceItems, fileExistsWithDirectoryCache } from "./store";
import { invalidateHistoryAttachments, reconcileHistoryAttachments } from "./agent-attachment-lifecycle";
import { agentWorkspaceDirectory, rebaseAgentWorkspaceFile } from "./agent-workspace-location";
import {
  createAgentSqlStore,
  type AgentSqlStore,
} from "./r4-store";
import {
  createEmptyR4AgentState,
  normalizeR4AgentState,
  projectR4Conversation,
  type R4AgentState,
  type R4ConversationConfigSnapshot,
  type R4CreationInputSnapshot,
  type R4AssistantPresetBinding,
  type R4ConversationCreativeState,
} from "../../src/agent/r4-types";
import { STUDIO_BUILTIN_PRESETS } from "../../src/agent/workspace-controls";

const MAX_FILE_BYTES = 48 * 1024 * 1024;
const MAX_IMPORT_BYTES = 192 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif",
  ".pdf", ".txt", ".md", ".json", ".jsonl", ".csv", ".tsv", ".yaml", ".yml",
]);

let sqlStore: AgentSqlStore | null = null;

export function agentWorkspacePath() {
  return path.join(agentWorkspaceDirectory(), "agent-workspace.json");
}

export function agentAttachmentsDirectory() {
  return path.join(agentWorkspaceDirectory(), "attachments");
}

function now() {
  return new Date().toISOString();
}

function defaultSkills(): AgentSkill[] {
  return createBuiltinAgentSkills(now());
}

export function createEmptyAgentWorkspace(): AgentWorkspaceData {
  const createdAt = now();
  const { character, persona, lorebook } = createSoftwareImageStarterKit();
  const samplerPresets = createTavernBuiltinSamplerPresets();
  const sampler = samplerPresets[0]!;
  const settings = getSettings();
  const conversation: AgentConversation = {
    id: crypto.randomUUID(),
    title: character.name,
    messages: [],
    draftAttachments: [],
    status: "idle",
    context: createContextSnapshot([], settings.agentContextWindow, settings.agentAutoCompactThreshold),
    compactCount: 0,
    createdAt,
    updatedAt: createdAt,
    characterIds: [character.id],
    activeCharacterId: character.id,
    personaId: persona.id,
    lorebookIds: [lorebook.id],
    samplerPresetId: sampler.id,
    generationMode: "confirm",
    studioApprovalMode: "confirm",
    studioWebSearchEnabled: true,
    selectedSkillIds: [],
    reasoningEffort: "auto",
    autoPlayGroup: false,
    pinned: false,
  };
  return {
    version: AGENT_WORKSPACE_VERSION,
    selectedConversationId: conversation.id,
    conversations: [conversation],
    skills: defaultSkills(),
    memories: [],
    characters: [character],
    personas: [persona],
    lorebooks: [lorebook],
    samplerPresets,
    presetLibraryVersion: TAVERN_PRESET_LIBRARY_VERSION,
    selectedCharacterId: character.id,
    selectedPersonaId: persona.id,
    defaultGenerationMode: "confirm",
    studioDefaults: { studioApprovalMode: "confirm", studioWebSearchEnabled: true },
    updatedAt: createdAt,
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function restoreProtectedStarterKit(
  characters: ReturnType<typeof normalizeTavernCharacter>[],
  personas: TavernPersona[],
  lorebooks: TavernLorebook[],
) {
  const kit = createSoftwareImageStarterKit();
  const characterIndex = characters.findIndex((item) => item.id === SOFTWARE_IMAGE_CHARACTER_ID);
  if (characterIndex >= 0) {
    const existing = characters[characterIndex];
    characters[characterIndex] = {
      ...kit.character,
      // Visual generation defaults are runtime-facing parameters. Preserve
      // them while restoring every protected role-card field from source.
      visual: clone(existing.visual),
      createdAt: existing.createdAt,
      updatedAt: existing.updatedAt,
    };
  } else {
    characters.unshift(kit.character);
  }

  const lorebookIndex = lorebooks.findIndex((item) => item.id === SOFTWARE_IMAGE_LOREBOOK_ID);
  if (lorebookIndex >= 0) {
    const existing = lorebooks[lorebookIndex];
    const enabledById = new Map(existing.entries.map((entry) => [entry.id, entry.enabled]));
    lorebooks[lorebookIndex] = {
      ...kit.lorebook,
      entries: kit.lorebook.entries.map((entry) => ({
        ...entry,
        enabled: enabledById.get(entry.id) ?? entry.enabled,
      })),
      createdAt: existing.createdAt,
      updatedAt: existing.updatedAt,
    };
  } else {
    lorebooks.unshift(kit.lorebook);
  }

  const personaIndex = personas.findIndex((item) => item.id === SOFTWARE_IMAGE_PERSONA_ID);
  if (personaIndex >= 0) {
    personas[personaIndex] = {
      ...personas[personaIndex],
      name: kit.persona.name,
      description: kit.persona.description,
    };
  } else {
    personas.unshift(kit.persona);
  }
}

function attachmentKind(extension: string): AgentAttachment["kind"] {
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif"].includes(extension)) return "image";
  if ([".txt", ".md", ".json", ".jsonl", ".csv", ".tsv", ".yaml", ".yml"].includes(extension)) return "text";
  if (extension === ".pdf") return "document";
  return "other";
}

function mimeFor(extension: string) {
  const values: Record<string, string> = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
    ".gif": "image/gif", ".bmp": "image/bmp", ".avif": "image/avif", ".pdf": "application/pdf",
    ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json", ".jsonl": "application/x-ndjson",
    ".csv": "text/csv", ".tsv": "text/tab-separated-values", ".yaml": "application/yaml", ".yml": "application/yaml",
  };
  return values[extension] ?? "application/octet-stream";
}

function rehydrateAttachment(raw: Partial<AgentAttachment>): AgentAttachment | null {
  if (typeof raw.id !== "string" || typeof raw.name !== "string" || typeof raw.filePath !== "string") return null;
  const extension = path.extname(raw.name).toLowerCase();
  const filePath = rebaseAgentWorkspaceFile(raw.filePath);
  return {
    id: raw.id,
    name: raw.name,
    mime: typeof raw.mime === "string" ? raw.mime : mimeFor(extension),
    size: Math.max(0, Number(raw.size) || 0),
    kind: raw.kind === "image" || raw.kind === "document" || raw.kind === "text" ? raw.kind : attachmentKind(extension),
    filePath,
    fileUrl: !raw.unavailable && fs.existsSync(filePath) ? toLocalMediaUrl(filePath, raw.id) : undefined,
    ...(["deleted", "missing", "replaced"].includes(String(raw.unavailable)) ? { unavailable: raw.unavailable } : {}),
    ...(Number.isFinite(raw.width) ? { width: raw.width } : {}),
    ...(Number.isFinite(raw.height) ? { height: raw.height } : {}),
    ...(Number.isSafeInteger(raw.revision) && Number(raw.revision) >= 0 ? { revision: raw.revision } : {}),
    ...(typeof raw.sha256 === "string" ? { sha256: raw.sha256 } : {}),
    ...(typeof raw.creationId === "string" ? { creationId: raw.creationId } : {}),
    ...(raw.role === "source" || raw.role === "reference" || raw.role === "mask" || raw.role === "artwork" ? { role: raw.role } : {}),
    ...(raw.referencePurpose === "color" || raw.referencePurpose === "composition" || raw.referencePurpose === "character" || raw.referencePurpose === "atmosphere" ? { referencePurpose: raw.referencePurpose } : {}),
    ...(typeof raw.includeInGeneration === "boolean" ? { includeInGeneration: raw.includeInGeneration } : {}),
    ...(raw.authorizationStatus === "authorized" || raw.authorizationStatus === "not_authorized" || raw.authorizationStatus === "revoked" || raw.authorizationStatus === "unknown" ? { authorizationStatus: raw.authorizationStatus } : {}),
    ...(typeof raw.authorizationReceiptId === "string" ? { authorizationReceiptId: raw.authorizationReceiptId } : {}),
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : now(),
  };
}

function cloneOptionalRecord<T extends object>(value: unknown): T | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? structuredClone(value) as T
    : undefined;
}

function normalizeImageProposal(raw: unknown): TavernImageProposal | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Partial<TavernImageProposal>;
  const positivePrompt = typeof value.positivePrompt === "string" ? value.positivePrompt.slice(0, 100_000) : "";
  if (!positivePrompt.trim() && !value.continuity?.bindingError) return undefined;
  const status = ["pending", "running", "completed", "cancelled", "error"].includes(String(value.status))
    ? value.status as TavernImageProposal["status"]
    : "pending";
  const finite = (input: unknown, fallback: number, minimum: number, maximum: number) => {
    const parsed = Number(input);
    return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
  };
  return {
    id: typeof value.id === "string" && value.id ? value.id : crypto.randomUUID(),
    status,
    positivePrompt,
    ...(value.scene !== undefined ? {scene: readSceneBindings(value.scene) ?? value.scene, ...(readSceneBindings(value.scene) ? {} : {status: "error" as const, error: "SCENE_INVALID"})} : {}),
    ...(value.continuity && typeof value.continuity === "object" ? { continuity: {
      baseImageId: typeof value.continuity.baseImageId === "string" ? value.continuity.baseImageId : undefined,
      previousPrompt: typeof value.continuity.previousPrompt === "string" ? value.continuity.previousPrompt.slice(0, 100_000) : undefined,
      suggestedPrompt: typeof value.continuity.suggestedPrompt === "string" ? value.continuity.suggestedPrompt.slice(0, 100_000) : undefined,
      reviewRequired: value.continuity.reviewRequired === true,
      ...(["repairing", "repaired", "failed"].includes(value.continuity.repairStatus ?? "") ? { repairStatus: value.continuity.repairStatus } : {}),
      ...(typeof value.continuity.bindingError === "string" ? {bindingError:value.continuity.bindingError.slice(0,160)} : {}),
      changes: Array.isArray(value.continuity.changes) ? value.continuity.changes.filter((c) => c && typeof c.from === "string" && typeof c.to === "string").slice(0, 64).map((c) => ({ from: c.from.slice(0, 100_000), to: c.to.slice(0, 100_000) })) : [],
    } } : {}),
    negativePrompt: typeof value.negativePrompt === "string" ? value.negativePrompt.slice(0, 100_000) : "",
    stylePrompt: typeof value.stylePrompt === "string" ? value.stylePrompt.slice(0, 100_000) : "",
    ...(typeof value.model === "string" && value.model.trim() ? { model: value.model.trim() } : {}),
    ...(Number.isFinite(Number(value.width)) ? { width: Math.round(finite(value.width, 1024, 64, 4096)) } : {}),
    ...(Number.isFinite(Number(value.height)) ? { height: Math.round(finite(value.height, 1024, 64, 4096)) } : {}),
    ...(Number.isFinite(Number(value.steps)) ? { steps: Math.round(finite(value.steps, 28, 1, 50)) } : {}),
    ...(Number.isFinite(Number(value.scale)) ? { scale: finite(value.scale, 5, 0, 10) } : {}),
    ...(typeof value.sampler === "string" && value.sampler.trim() ? { sampler: value.sampler.trim() } : {}),
    count: Math.round(finite(value.count, 1, 1, 8)),
    ...(typeof value.error === "string" ? { error: value.error.slice(0, 2_000) } : {}),
    createdAt: typeof value.createdAt === "string" ? value.createdAt : now(),
  };
}

function normalizeMessage(raw: Partial<AgentMessage>): AgentMessage | null {
  if (typeof raw.id !== "string" || !["user", "assistant", "system"].includes(String(raw.role))) return null;
  const imageProposal = normalizeImageProposal(raw.imageProposal);
  return {
    id: raw.id,
    ...(typeof raw.runtimeMessageId === "string" ? { runtimeMessageId: raw.runtimeMessageId } : {}),
    role: raw.role as AgentMessage["role"],
    content: typeof raw.content === "string" ? raw.content : "",
    ...(raw.role === "user" && Array.isArray(raw.actions) ? {actions: normalizeStudioComposerActions(raw.actions)} : {}),
    ...(typeof raw.reasoning === "string" ? { reasoning: raw.reasoning } : {}),
    attachments: (Array.isArray(raw.attachments) ? raw.attachments : [])
      .map((item) => rehydrateAttachment(item))
      .filter((item): item is AgentAttachment => Boolean(item)),
    tools: (Array.isArray(raw.tools) ? raw.tools : []).filter((tool) => tool && typeof tool === "object").map((tool) => ({
      ...tool,
      ...(Array.isArray(tool.generatedImages) ? { generatedImages: tool.generatedImages.map(rehydrateAttachment).filter((a): a is AgentAttachment => Boolean(a)) } : {}),
    })),
    ...(raw.usage ? { usage: raw.usage } : {}),
    status: ["complete", "streaming", "error", "aborted"].includes(String(raw.status))
      ? raw.status as AgentMessage["status"]
      : "complete",
    ...(typeof raw.error === "string" ? { error: raw.error } : {}),
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : now(),
    ...(typeof raw.completedAt === "string" ? { completedAt: raw.completedAt } : {}),
    ...(typeof raw.characterId === "string" ? { characterId: raw.characterId } : {}),
    ...(typeof raw.creationId === "string" ? { creationId: raw.creationId } : {}),
    ...(cloneOptionalRecord<R4ConversationConfigSnapshot>(raw.conversationConfig) ? { conversationConfig: cloneOptionalRecord<R4ConversationConfigSnapshot>(raw.conversationConfig) } : {}),
    ...(cloneOptionalRecord<R4CreationInputSnapshot>(raw.originalInputSnapshot) ? { originalInputSnapshot: cloneOptionalRecord<R4CreationInputSnapshot>(raw.originalInputSnapshot) } : {}),
    ...(typeof raw.queuedMessageId === "string" ? { queuedMessageId: raw.queuedMessageId } : {}),
    ...(typeof raw.userIntentRef === "string" ? { userIntentRef: raw.userIntentRef } : {}),
    ...(typeof raw.critiqueForExecutionId === "string" ? { critiqueForExecutionId: raw.critiqueForExecutionId } : {}),
    ...(raw.r4LegacyStatus === "legacy_unversioned" || raw.r4LegacyStatus === "migration_conflict" ? { r4LegacyStatus: raw.r4LegacyStatus } : {}),
    ...(Array.isArray(raw.swipes)
      ? { swipes: raw.swipes.filter((item): item is string => typeof item === "string").map((item) => item.slice(0, 200_000)).slice(0, 100) }
      : {}),
    ...(Number.isFinite(Number(raw.swipeIndex)) ? { swipeIndex: Math.max(0, Math.trunc(Number(raw.swipeIndex))) } : {}),
    ...(imageProposal ? { imageProposal } : {}),
    ...(Array.isArray(raw.imageProposalSwipes) ? { imageProposalSwipes: raw.imageProposalSwipes.slice(0, 100).map((p) => normalizeImageProposal(p) ?? null) } : {}),
    ...(Array.isArray(raw.swipeAttachments) ? { swipeAttachments: raw.swipeAttachments.slice(0, 100).map((items) => Array.isArray(items) ? items.map(rehydrateAttachment).filter((a): a is AgentAttachment => Boolean(a)) : []) } : {}),
  };
}

export function normalizeAgentWorkspace(raw: unknown, preserveRuntimeStatus = false): AgentWorkspaceData {
  const input = raw && typeof raw === "object" ? raw as Partial<AgentWorkspaceData> : {};
  if (Number(input.version) !== AGENT_WORKSPACE_VERSION) {
    throw new Error(`Agent workspace 版本 ${String(input.version)} 暂不支持；原文件与备份均已保留。`);
  }
  const settings = getSettings();
  const characters = (Array.isArray(input.characters) ? input.characters : [])
    .map((item) => normalizeTavernCharacter(item));
  const personas: TavernPersona[] = (Array.isArray(input.personas) ? input.personas : [])
    .map((item) => normalizeTavernPersona(item));
  const lorebooks: TavernLorebook[] = (Array.isArray(input.lorebooks) ? input.lorebooks : [])
    .map((item) => normalizeTavernLorebook(item));
  const samplerPresets: TavernSamplerPreset[] = (Array.isArray(input.samplerPresets) ? input.samplerPresets : [])
    .map((item) => normalizeTavernSamplerPreset(item));
  restoreProtectedStarterKit(characters, personas, lorebooks);
  const incomingPresetLibraryVersion = Math.max(0, Math.trunc(Number(input.presetLibraryVersion) || 0));
  if (incomingPresetLibraryVersion > TAVERN_PRESET_LIBRARY_VERSION) {
    throw new Error(`Tavern 预设库版本 ${incomingPresetLibraryVersion} 暂不支持；原文件与备份均已保留。`);
  }
  if (incomingPresetLibraryVersion < TAVERN_PRESET_LIBRARY_VERSION) {
    samplerPresets.splice(0, samplerPresets.length, ...createTavernBuiltinSamplerPresets());
  }
  if (!samplerPresets.length) samplerPresets.push(createTavernBuiltinSamplerPresets()[0]);
  const defaultCharacterId = characters.some((item) => item.id === input.selectedCharacterId)
    ? input.selectedCharacterId
    : characters[0].id;
  const defaultPersonaId = personas.some((item) => item.id === input.selectedPersonaId)
    ? input.selectedPersonaId
    : personas[0].id;
  const conversations: AgentConversation[] = (Array.isArray(input.conversations) ? input.conversations : [])
    .filter((item): item is AgentConversation => Boolean(item && typeof item === "object" && typeof item.id === "string"))
    .map((conversation) => {
      const messages = (Array.isArray(conversation.messages) ? conversation.messages : [])
        .map((message) => normalizeMessage(message))
        .filter((message): message is AgentMessage => Boolean(message));
      const lastCompactedAt = typeof conversation.lastCompactedAt === "string" ? conversation.lastCompactedAt : undefined;
      const lastSummary = typeof conversation.lastSummary === "string" ? conversation.lastSummary : undefined;
      const contextMessages = effectiveContextMessages(messages, lastSummary, lastCompactedAt);
      const latestUsage = [...contextMessages].reverse().find((message) => message.role === "assistant" && message.usage)?.usage;
      const characterIds = (Array.isArray(conversation.characterIds) ? conversation.characterIds : [])
        .filter((id): id is string => typeof id === "string" && characters.some((item) => item.id === id));
      if (!characterIds.length && defaultCharacterId) characterIds.push(defaultCharacterId);
      const activeCharacterId = typeof conversation.activeCharacterId === "string" && characterIds.includes(conversation.activeCharacterId)
        ? conversation.activeCharacterId
        : characterIds[0];
      const personaId = typeof conversation.personaId === "string" && personas.some((item) => item.id === conversation.personaId)
        ? conversation.personaId
        : defaultPersonaId;
      const lorebookIds = (Array.isArray(conversation.lorebookIds) ? conversation.lorebookIds : [])
        .filter((id): id is string => typeof id === "string" && lorebooks.some((item) => item.id === id));
      const samplerPresetId = typeof conversation.samplerPresetId === "string" && samplerPresets.some((item) => item.id === conversation.samplerPresetId)
        ? conversation.samplerPresetId
        : samplerPresets[0]?.id;
      return {
        id: conversation.id,
        ...(typeof conversation.runtimeSessionId === "string" ? { runtimeSessionId: conversation.runtimeSessionId } : {}),
        title: typeof conversation.title === "string" && conversation.title.trim() ? conversation.title.trim().slice(0, 100) : "新对话",
        ...(typeof conversation.archivedAt === "string" && Number.isFinite(Date.parse(conversation.archivedAt)) ? { archivedAt: conversation.archivedAt } : {}),
        messages,
        draftAttachments: (Array.isArray(conversation.draftAttachments) ? conversation.draftAttachments : [])
          .map((item) => rehydrateAttachment(item))
          .filter((item): item is AgentAttachment => Boolean(item)),
        // Disk recovery resets transient work; writes during a live turn must not.
        status: (preserveRuntimeStatus && ["running", "waiting-permission"].includes(String(conversation.status))
          ? conversation.status : conversation.status === "error" ? "error" : "idle") as AgentConversation["status"],
        context: createContextSnapshot(contextMessages, settings.agentContextWindow, settings.agentAutoCompactThreshold, latestUsage),
        ...(latestUsage ? { lastTurnUsage: latestUsage } : {}),
        compactCount: Math.max(0, Math.trunc(Number(conversation.compactCount) || 0)),
        ...(lastCompactedAt ? { lastCompactedAt } : {}),
        ...(lastSummary ? { lastSummary } : {}),
        ...(typeof conversation.imageStateResetAt === "string" ? { imageStateResetAt: conversation.imageStateResetAt } : {}),
        createdAt: typeof conversation.createdAt === "string" ? conversation.createdAt : now(),
        updatedAt: typeof conversation.updatedAt === "string" ? conversation.updatedAt : now(),
        characterIds,
        ...(activeCharacterId ? { activeCharacterId } : {}),
        ...(personaId ? { personaId } : {}),
        lorebookIds,
        ...(samplerPresetId ? { samplerPresetId } : {}),
        generationMode: (conversation.generationMode === "auto" ? "auto" : "confirm") as AgentConversation["generationMode"],
        studioApprovalMode: conversation.studioApprovalMode==='auto'?'auto' as const:'confirm' as const,
        studioWebSearchEnabled: conversation.studioWebSearchEnabled!==false,
        studioTemplateEnabled: conversation.studioTemplateEnabled!==false,
        // Keep a missing/unknown reference visible for repair. The R4 binding
        // carries migration_conflict and blocks execution until the user picks
        // a real preset; silently replacing the ID here would hide that state.
        studioPresetId: typeof conversation.studioPresetId === 'string'
          ? conversation.studioPresetId
          : STUDIO_DEFAULT_PRESET_ID,
        selectedSkillIds: Array.isArray(conversation.selectedSkillIds)
          ? [...new Set(conversation.selectedSkillIds.filter((id): id is string => typeof id === 'string' && id.length <= 200))]
          : [],
        reasoningEffort: (["low", "medium", "high"].includes(String(conversation.reasoningEffort))
          ? conversation.reasoningEffort
          : "auto") as AgentConversation["reasoningEffort"],
        autoPlayGroup: conversation.autoPlayGroup === true,
        ...(typeof conversation.backgroundDataUrl === "string" && conversation.backgroundDataUrl
          ? { backgroundDataUrl: conversation.backgroundDataUrl }
          : {}),
        pinned: conversation.pinned === true,
      };
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const builtIns = defaultSkills();
  const inputSkills = Array.isArray(input.skills) ? input.skills : [];
  const storedSkillById = new Map(inputSkills
    .filter((skill): skill is AgentSkill => Boolean(skill && typeof skill.id === "string"))
    .map(skill => [skill.id, skill]));
  const builtInIds = new Set(builtIns.map(skill => skill.id));
  const skillById = new Map<string, AgentSkill>();
  for (const builtin of builtIns) {
    const stored = storedSkillById.get(builtin.id);
    skillById.set(builtin.id, {
      ...builtin,
      enabled: stored?.enabled !== false,
      createdAt: typeof stored?.createdAt === "string" ? stored.createdAt : builtin.createdAt,
      updatedAt: typeof stored?.updatedAt === "string" ? stored.updatedAt : builtin.updatedAt,
    });
  }
  for (const skill of inputSkills) {
    if (!skill || typeof skill.id !== "string" || !skill.id || builtInIds.has(skill.id)
      || typeof skill.name !== "string" || typeof skill.instructions !== "string") continue;
    const triggerKeywords = Array.isArray(skill.triggerKeywords)
      ? skill.triggerKeywords.filter((item): item is string => typeof item === "string")
      : [];
    skillById.set(skill.id, {
      id: skill.id,
      name: skill.name,
      description: typeof skill.description === "string" ? skill.description : "",
      instructions: skill.instructions,
      enabled: skill.enabled !== false,
      autoSelect: skill.autoSelect === true,
      triggerKeywords,
      createdAt: typeof skill.createdAt === "string" ? skill.createdAt : now(),
      updatedAt: typeof skill.updatedAt === "string" ? skill.updatedAt : now(),
    });
  }
  for (const conversation of conversations) {
    conversation.selectedSkillIds = (conversation.selectedSkillIds ?? []).filter(id => skillById.has(id));
  }
  const selectedConversationId = typeof input.selectedConversationId === "string" && conversations.some((item) => item.id === input.selectedConversationId)
    ? input.selectedConversationId
    : conversations.find(item => !item.archivedAt)?.id;
  const studioDefaults = normalizeStudioDefaults(input.studioDefaults ?? conversations.find(c => c.id === selectedConversationId));
  if (studioDefaults.selectedSkillIds) studioDefaults.selectedSkillIds = studioDefaults.selectedSkillIds.filter(id => skillById.has(id));
  const memories: AgentMemory[] = (Array.isArray(input.memories) ? input.memories : [])
    .map((item) => normalizeAgentMemorySnapshot(item, now()))
    .filter((item): item is AgentMemory => Boolean(item));
  return {
    version: AGENT_WORKSPACE_VERSION,
    studioDefaults,
    ...(selectedConversationId ? { selectedConversationId } : {}),
    conversations,
    skills: [...skillById.values()],
    memories,
    characters,
    personas,
    lorebooks,
    samplerPresets,
    presetLibraryVersion: TAVERN_PRESET_LIBRARY_VERSION,
    ...(defaultCharacterId ? { selectedCharacterId: defaultCharacterId } : {}),
    ...(defaultPersonaId ? { selectedPersonaId: defaultPersonaId } : {}),
    defaultGenerationMode: input.defaultGenerationMode === "auto" ? "auto" : "confirm",
    updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : now(),
  };
}

function workspaceForSql(value: unknown, preserveRuntimeStatus = false) {
  return resolvedWorkspace(normalizeAgentWorkspace(value, preserveRuntimeStatus));
}

function sha256(value: string) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readLegacyWorkspace(): { raw: Record<string, unknown>; sourceFile: string } | undefined {
  const primary = agentWorkspacePath();
  const candidates = [primary, `${primary}.bak`, `${primary}.bak2`];
  let found = false;
  let lastParseError: unknown;
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    found = true;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(candidate, "utf8"));
    } catch (error) {
      lastParseError = error;
      continue;
    }
    const raw = asRecord(parsed);
    if (!raw) {
      lastParseError = new Error("Agent workspace JSON root must be an object.");
      continue;
    }
    // A syntactically valid but unsupported version is authoritative. Falling
    // back to an older snapshot here could silently roll back user data.
    if (Number(raw.version) !== AGENT_WORKSPACE_VERSION) {
      throw new Error(`Agent workspace 版本 ${String(raw.version)} 暂不支持；原文件与备份均已保留。`);
    }
    const presetLibraryVersion = Math.max(0, Math.trunc(Number(raw.presetLibraryVersion) || 0));
    if (presetLibraryVersion > TAVERN_PRESET_LIBRARY_VERSION) {
      throw new Error(`Tavern 预设库版本 ${presetLibraryVersion} 暂不支持；原文件与备份均已保留。`);
    }
    return { raw: structuredClone(raw), sourceFile: path.basename(candidate) };
  }
  if (found) {
    throw new Error(`Agent workspace 与两个备份均无法读取；原文件均已保留。${lastParseError instanceof Error ? ` ${lastParseError.message}` : ""}`);
  }
  return undefined;
}

function legacyBinding(value: unknown, availablePresetIds: Set<string>): R4AssistantPresetBinding {
  const conversation = asRecord(value) ?? {};
  const rawId = typeof conversation.studioPresetId === "string" ? conversation.studioPresetId : undefined;
  const hasKnownId = rawId === undefined
    || STUDIO_BUILTIN_PRESETS.some((preset) => preset.id === rawId)
    || (rawId.startsWith("tavern:") && availablePresetIds.has(rawId.slice("tavern:".length)));
  const oldAlias = rawId === "studio-director" || rawId === "studio-prompts" || rawId === "studio-reference" || rawId === `tavern:${STUDIO_LYRA_PRESET_ID}`;
  const enabled = typeof conversation.studioTemplateEnabled === "boolean"
    ? conversation.studioTemplateEnabled
    : true; // Fixed workspace v4 runtime treats a missing flag as enabled.
  return {
    // Preserve an unknown ID exactly. R4 host configuration capture treats the
    // migration_conflict marker as repair-required instead of silently using a
    // built-in prompt. Known legacy aliases keep their established mapping.
    presetId: rawId && !oldAlias ? rawId : STUDIO_DEFAULT_PRESET_ID,
    enabled,
    ...(!hasKnownId && !oldAlias ? { legacyStatus: "migration_conflict" as const } : {}),
  };
}

function seedR4FromLegacyWorkspace(raw: Record<string, unknown>, sourceFile: string, sourceKind: "legacy" | "new-workspace" = "legacy"): R4AgentState {
  const state = createEmptyR4AgentState();
  const samplerPresets = Array.isArray(raw.samplerPresets) ? raw.samplerPresets : [];
  const availablePresetIds = new Set(samplerPresets
    .map(asRecord)
    .filter((preset): preset is Record<string, unknown> => Boolean(preset && typeof preset.id === "string"))
    .map((preset) => String(preset.id)));

  for (const preset of STUDIO_BUILTIN_PRESETS) {
    state.assistantPresets[preset.id] = {
      id: preset.id,
      name: preset.name,
      body: preset.body,
      revision: 1,
      hash: sha256(preset.body),
      source: "builtin",
    };
  }
  for (const candidate of samplerPresets) {
    const preset = asRecord(candidate);
    if (!preset || typeof preset.id !== "string" || !preset.id) continue;
    const systemPrompt = typeof preset.systemPrompt === "string" ? preset.systemPrompt : "";
    const jailbreakPrompt = typeof preset.jailbreakPrompt === "string" ? preset.jailbreakPrompt : "";
    const body = [systemPrompt, jailbreakPrompt].filter(Boolean).join("\n\n");
    const id = `tavern:${preset.id}`;
    state.assistantPresets[id] = {
      id,
      name: typeof preset.name === "string" ? preset.name : preset.id,
      body,
      revision: 1,
      hash: sha256(body),
      source: "legacy_tavern",
      legacyRecord: structuredClone(preset),
    };
  }

  const conversationRecords = Array.isArray(raw.conversations) ? raw.conversations : [];
  for (const candidate of conversationRecords) {
    const conversation = asRecord(candidate);
    if (!conversation || typeof conversation.id !== "string" || !conversation.id) continue;
    const binding = legacyBinding(conversation, availablePresetIds);
    const stateConversation = {
      conversationId: conversation.id,
      messageCreationIds: {},
      ...(binding.legacyStatus ? { legacyStatus: binding.legacyStatus } : sourceKind === "legacy" ? { legacyStatus: "legacy_unversioned" as const } : {}),
      assistantPresetBinding: binding,
      selectionRevision: 0,
      updatedAt: typeof conversation.updatedAt === "string" ? conversation.updatedAt : now(),
    };
    state.conversations[conversation.id] = stateConversation;
  }

  const rawDefaults = asRecord(raw.studioDefaults);
  const selectedId = typeof raw.selectedConversationId === "string" ? raw.selectedConversationId : undefined;
  const selectedConversation = conversationRecords.find((candidate) => asRecord(candidate)?.id === selectedId);
  const defaultSource = rawDefaults ?? asRecord(selectedConversation);
  state.assistantPresetDefaultBinding = legacyBinding(defaultSource, availablePresetIds);
  if (sourceKind === "legacy") {
    state.compatibility = {
      legacyWorkspace: {
        version: raw.version,
        presetLibraryVersion: raw.presetLibraryVersion ?? null,
        sourceFile,
        // Retain exact field names, custom prompt bodies and unknown extensions.
        raw: structuredClone(raw),
      },
    };
  }
  return state;
}

/** Mirror deliberate legacy resource-preset edits into versioned R4 history. */
function syncLegacyAssistantPresets(state: R4AgentState, workspace: AgentWorkspaceData) {
  let changed = false;
  const history = asRecord(state.compatibility.presetRevisionHistory)
    ?? (state.compatibility.presetRevisionHistory = {} as Record<string, unknown>) as Record<string, unknown>;
  for (const samplerPreset of workspace.samplerPresets) {
    const id = `tavern:${samplerPreset.id}`;
    const body = [samplerPreset.systemPrompt, samplerPreset.jailbreakPrompt].filter(Boolean).join("\n\n");
    const legacyRecord = structuredClone(samplerPreset) as unknown as Record<string, unknown>;
    const existing = state.assistantPresets[id];
    if (!existing) {
      state.assistantPresets[id] = {
        id,
        name: samplerPreset.name,
        body,
        revision: 1,
        hash: sha256(body),
        source: "legacy_tavern",
        legacyRecord,
      };
      changed = true;
      continue;
    }
    // R4 users may have edited the copied assistant body independently. The
    // legacy resource should advance it only when that source record itself
    // changes, never on an unrelated workspace write.
    if (existing.source !== "legacy_tavern" || JSON.stringify(existing.legacyRecord) === JSON.stringify(legacyRecord)) continue;
    history[`${id}@${existing.revision}`] ??= structuredClone(existing);
    existing.name = samplerPreset.name;
    existing.body = body;
    existing.hash = sha256(body);
    existing.revision++;
    existing.updatedAt = now();
    existing.legacyRecord = legacyRecord;
    changed = true;
  }
  if (changed) state.updatedAt = now();
  return changed;
}

/**
 * Preserve legacy per-chat preset selection when an old archive or workspace
 * merge introduces conversations that have no R4 row yet. Existing R4
 * bindings and the current new-chat default always win.
 */
export function syncLegacyAgentWorkspaceR4(state: R4AgentState, workspace: AgentWorkspaceData) {
  let changed = syncLegacyAssistantPresets(state, workspace);
  const availablePresetIds = new Set(workspace.samplerPresets.map((preset) => preset.id));
  for (const chat of workspace.conversations) {
    if (state.conversations[chat.id]) continue;
    const binding = legacyBinding(chat, availablePresetIds);
    state.conversations[chat.id] = {
      conversationId: chat.id,
      messageCreationIds: {},
      ...(binding.legacyStatus ? { legacyStatus: binding.legacyStatus } : { legacyStatus: "legacy_unversioned" as const }),
      assistantPresetBinding: binding,
      selectionRevision: 0,
      updatedAt: typeof chat.updatedAt === "string" ? chat.updatedAt : now(),
    };
    changed = true;
  }
  if (changed) state.updatedAt = now();
  return changed;
}

function loadInitialSqlState() {
  const legacy = readLegacyWorkspace();
  if (!legacy) {
    const workspace = createEmptyAgentWorkspace();
    return { workspace, r4State: seedR4FromLegacyWorkspace(workspace as unknown as Record<string, unknown>, "new-workspace", "new-workspace") };
  }
  // The pre-R4 baseline migrated its sampler preset library destructively.
  // Keep source records by lifting only the normalized version marker; the
  // original JSON, both backup generations and an exact copy in compatibility
  // remain untouched for later versioned repair or export.
  const normalizationInput = {
    ...structuredClone(legacy.raw),
    presetLibraryVersion: TAVERN_PRESET_LIBRARY_VERSION,
  };
  const workspace = workspaceForSql(normalizationInput);
  workspace.conversations.forEach((conversation) => { recoverInterruptedImageRepairs(conversation); });
  return {
    workspace,
    r4State: seedR4FromLegacyWorkspace(legacy.raw, legacy.sourceFile),
  };
}

export function getAgentSqlStore() {
  if (!sqlStore) {
    sqlStore = createAgentSqlStore({
      filename: path.join(agentWorkspaceDirectory(), "agent-state.sqlite"),
      legacyFiles: [agentWorkspacePath(), `${agentWorkspacePath()}.bak`, `${agentWorkspacePath()}.bak2`],
      loadInitialState: loadInitialSqlState,
      normalizeWorkspace: workspaceForSql,
    });
  }
  return sqlStore;
}

export function closeAgentSqlStore() {
  if (!sqlStore) return;
  try { sqlStore.close(); } finally { sqlStore = null; }
}

export function readAgentWorkspace(): AgentWorkspaceData {
  const workspace = resolvedWorkspace(getAgentSqlStore().readWorkspace());
  const recoveredRepairs = workspace.conversations.map(recoverInterruptedImageRepairs).some(Boolean);
  if (recoveredRepairs) return writeAgentWorkspace(workspace);
  return workspace;
}

function resolvedWorkspace(workspace: AgentWorkspaceData): AgentWorkspaceData {
  const next = clone(workspace);
  const directories = new Map<string, Set<string> | null>();
  reconcileHistoryAttachments(next, getHistoryReferenceItems(), getSettings().outputDir,
    file => fileExistsWithDirectoryCache(file, directories), toLocalMediaUrl);
  return next;
}

/** Persist before unlink, so restart and alternate swipes cannot resurrect a path. */
export function invalidateAgentHistoryImage(id: string | readonly string[]): void {
  const workspace = readAgentWorkspace();
  let changed = false;
  for (const selected of typeof id === 'string' ? [id] : id) {
    if (invalidateHistoryAttachments(workspace, selected)) changed = true;
  }
  if (changed) writeAgentWorkspace(workspace);
}

export function writeAgentWorkspace(workspace: AgentWorkspaceData, presetSelection?: {conversationId:string;presetId:string}) {
  // A still-open renderer editor may save a snapshot from before deletion.
  // Resolve identities at the write boundary too, not only on the next read.
  const normalized = resolvedWorkspace(normalizeAgentWorkspace({ ...workspace, updatedAt: now() }, true));
  return getAgentSqlStore().transaction((tx) => {
    const state = tx.getR4State();
    let changed = syncLegacyAgentWorkspaceR4(state, normalized);
    if (presetSelection) {
      const conversation = state.conversations[presetSelection.conversationId];
      if (!conversation || !state.assistantPresets[presetSelection.presetId]) throw new Error('导入预设的会话或正文不存在。');
      conversation.assistantPresetBinding = {
        presetId: presetSelection.presetId,
        enabled: conversation.assistantPresetBinding?.enabled ?? state.assistantPresetDefaultBinding?.enabled ?? true,
      };
      // Import selection affects future captures; existing queued snapshots stay intact.
      delete conversation.config;
      delete conversation.configurationIssue;
      changed = true;
    }
    tx.setWorkspace(normalized);
    if (changed) tx.setR4State(state);
    return tx.getWorkspace();
  });
}

export function readAgentR4State() {
  return normalizeR4AgentState(getAgentSqlStore().readR4State());
}

export function writeAgentR4State(state: R4AgentState) {
  return getAgentSqlStore().writeR4State(state);
}

function workspaceAttachments(workspace: AgentWorkspaceData) {
  const attachments: AgentAttachment[] = [];
  for (const conversation of workspace.conversations) {
    attachments.push(...conversation.draftAttachments);
    for (const message of conversation.messages) {
      attachments.push(...message.attachments);
      attachments.push(...(message.swipeAttachments ?? []).flat());
      for (const tool of message.tools) attachments.push(...(tool.generatedImages ?? []));
      for (const swipe of message.imageProposalSwipes ?? []) {
        if (swipe?.continuity?.baseImageId) {
          const found = conversation.messages.flatMap((item) => item.attachments).find((item) => item.id === swipe.continuity?.baseImageId);
          if (found) attachments.push(found);
        }
      }
    }
  }
  return attachments;
}

const R4_CONVERSATION_COLLECTIONS = [
  "creations", "proposals", "artworks", "preparations", "executions",
  "messageQueue", "gates", "operations", "critiqueQueue",
] as const;

function hasDurableR4ConversationData(state: R4AgentState, conversationId: string) {
  if (R4_CONVERSATION_COLLECTIONS.some((collection) =>
    Object.values(state[collection]).some((item) => item.conversationId === conversationId))) return true;
  const conversation = state.conversations[conversationId];
  return Boolean(conversation && (
    conversation.currentCreationId
    || conversation.selectedArtworkId
    || Object.keys(conversation.messageCreationIds).length
    || conversation.composerDraft?.text
    || conversation.composerDraft?.attachmentIds.length
  ));
}

function hasR4AttachmentReference(value: unknown, attachmentId: string): boolean {
  if (Array.isArray(value)) return value.some((item) => hasR4AttachmentReference(item, attachmentId));
  if (!value || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if ((key === "attachmentId" || key === "parentAttachmentId") && child === attachmentId) return true;
    if (key === "attachmentIds" && Array.isArray(child) && child.includes(attachmentId)) return true;
    if (hasR4AttachmentReference(child, attachmentId)) return true;
  }
  return false;
}

export function getAgentCreativeState(conversationId: string): R4ConversationCreativeState {
  const store = getAgentSqlStore();
  const state = projectR4Conversation(store.readR4State(), conversationId);
  const attachments = new Map(workspaceAttachments(resolvedWorkspace(store.readWorkspace())).map((item) => [item.id, item]));
  for (const artwork of Object.values(state.artworks)) {
    const attachment = attachments.get(artwork.attachmentId);
    if (!attachment || attachment.unavailable) continue;
    if (attachment.fileUrl) artwork.url = attachment.fileUrl;
    else if (fs.existsSync(attachment.filePath)) artwork.url = toLocalMediaUrl(attachment.filePath, attachment.id);
  }
  return state;
}

function mutation(workspace: AgentWorkspaceData, message?: string): AgentWorkspaceMutationResult {
  return { ok: true, ...(message ? { message } : {}), workspace: writeAgentWorkspace(workspace) };
}

function uniqueConversationTitle(workspace: AgentWorkspaceData, requested = "新对话") {
  const base = requested.trim().slice(0, 100) || "新对话";
  const occupied = new Set(workspace.conversations.map((item) => item.title.toLocaleLowerCase()));
  if (!occupied.has(base.toLocaleLowerCase())) return base;
  let index = 1;
  while (occupied.has(`${base} (${index})`.toLocaleLowerCase())) index += 1;
  return `${base} (${index})`;
}

export function createAgentConversation(title?: string): AgentWorkspaceMutationResult {
  return getAgentSqlStore().transaction((tx) => {
    // Read the default binding and insert the new conversation in one commit.
    // Otherwise a preference change between the legacy workspace write and
    // lazy R4 conversation creation could retroactively change this chat.
    const workspace = resolvedWorkspace(tx.getWorkspace());
    const r4State = tx.getR4State();
    const createdAt = now();
    const settings = getSettings();
    const characterId = workspace.selectedCharacterId ?? workspace.characters[0]?.id;
    const personaId = workspace.selectedPersonaId ?? workspace.personas[0]?.id;
    const linkedLorebookIds = [
      workspace.characters.find((item) => item.id === characterId)?.lorebookId,
      workspace.personas.find((item) => item.id === personaId)?.lorebookId,
    ].filter((id): id is string => Boolean(id && workspace.lorebooks.some((item) => item.id === id)));
    const samplerPresetId = workspace.samplerPresets[0]?.id;
    const conversation: AgentConversation = {
      id: crypto.randomUUID(),
      title: uniqueConversationTitle(workspace, title),
      messages: [],
      draftAttachments: [],
      status: "idle",
      context: createContextSnapshot([], settings.agentContextWindow, settings.agentAutoCompactThreshold),
      compactCount: 0,
      createdAt,
      updatedAt: createdAt,
      characterIds: characterId ? [characterId] : [],
      ...(characterId ? { activeCharacterId: characterId } : {}),
      ...(personaId ? { personaId } : {}),
      lorebookIds: [...new Set(linkedLorebookIds)],
      ...(samplerPresetId ? { samplerPresetId } : {}),
      generationMode: workspace.defaultGenerationMode,
      studioApprovalMode: "confirm",
      studioWebSearchEnabled: true,
      selectedSkillIds: [],
      reasoningEffort: "auto",
      autoPlayGroup: false,
      pinned: false,
    };
    const defaults = normalizeStudioDefaults(workspace.studioDefaults);
    const defaultCharacters = defaults.characterIds?.filter(id => workspace.characters.some(c => c.id === id));
    if (defaultCharacters?.length) {
      conversation.characterIds = defaultCharacters;
      conversation.activeCharacterId = defaultCharacters.includes(defaults.activeCharacterId ?? '')
        ? defaults.activeCharacterId : defaultCharacters[0];
    }
    if (defaults.lorebookIds) conversation.lorebookIds = defaults.lorebookIds.filter(id => workspace.lorebooks.some(b => b.id === id));
    if (defaults.studioApprovalMode) conversation.studioApprovalMode = defaults.studioApprovalMode;
    if (defaults.studioWebSearchEnabled !== undefined) conversation.studioWebSearchEnabled = defaults.studioWebSearchEnabled;
    if (defaults.selectedSkillIds) conversation.selectedSkillIds = defaults.selectedSkillIds.filter(id => workspace.skills.some(skill => skill.id === id));
    if (defaults.studioTemplateEnabled !== undefined) conversation.studioTemplateEnabled = defaults.studioTemplateEnabled;
    if (defaults.studioPresetId && (studioBuiltinPreset(defaults.studioPresetId) || workspace.samplerPresets.some(p => 'tavern:' + p.id === defaults.studioPresetId))) {
      conversation.studioPresetId = defaults.studioPresetId;
    }

    workspace.conversations.unshift(conversation);
    workspace.selectedConversationId = conversation.id;
    const normalizedWorkspace = resolvedWorkspace(normalizeAgentWorkspace({ ...workspace, updatedAt: createdAt }, true));
    syncLegacyAssistantPresets(r4State, normalizedWorkspace);

    const availablePresetIds = new Set(normalizedWorkspace.samplerPresets.map((preset) => preset.id));
    if (!r4State.assistantPresetDefaultBinding) {
      r4State.assistantPresetDefaultBinding = legacyBinding(normalizedWorkspace.studioDefaults, availablePresetIds);
    }
    const binding = structuredClone(r4State.assistantPresetDefaultBinding);
    r4State.conversations[conversation.id] = {
      conversationId: conversation.id,
      messageCreationIds: {},
      assistantPresetBinding: binding,
      ...(binding.legacyStatus ? { legacyStatus: binding.legacyStatus } : {}),
      selectionRevision: 0,
      updatedAt: createdAt,
    };
    tx.setWorkspace(normalizedWorkspace);
    tx.setR4State(r4State);
    return { ok: true, workspace: tx.getWorkspace() };
  });
}

export function selectAgentConversation(conversationId: string): AgentWorkspaceMutationResult {
  const workspace = readAgentWorkspace();
  if (!workspace.conversations.some((item) => item.id === conversationId)) {
    return { ok: false, message: "对话不存在。", workspace };
  }
  workspace.selectedConversationId = conversationId;
  return mutation(workspace);
}

export function renameAgentConversation(conversationId: string, title: string): AgentWorkspaceMutationResult {
  const workspace = readAgentWorkspace();
  const conversation = workspace.conversations.find((item) => item.id === conversationId);
  if (!conversation) return { ok: false, message: "对话不存在。", workspace };
  const trimmed = title.trim().slice(0, 100);
  if (!trimmed) return { ok: false, message: "名称不能为空。", workspace };
  conversation.title = trimmed;
  conversation.updatedAt = now();
  return mutation(workspace);
}

/** Archive only metadata. Messages, memories and attachment bytes are never deleted. */
export function setAgentConversationArchived(conversationId: string, archived: boolean): AgentWorkspaceMutationResult {
  const workspace = readAgentWorkspace();
  const conversation = workspace.conversations.find(item => item.id === conversationId);
  if (!conversation || typeof archived !== "boolean") return { ok: false, message: "对话不存在或归档状态无效。", workspace };
  if (["running", "waiting-permission"].includes(conversation.status)) return { ok: false, message: "请等待当前任务结束后再归档或恢复。", workspace };
  if (archived) conversation.archivedAt ??= now();
  else delete conversation.archivedAt;
  conversation.updatedAt = now();
  if (!archived) workspace.selectedConversationId = conversation.id;
  else if (workspace.selectedConversationId === conversation.id) workspace.selectedConversationId = workspace.conversations.find(item => !item.archivedAt)?.id;
  const result = mutation(workspace);
  return archived && result.ok && !result.workspace.conversations.some(item => !item.archivedAt) ? createAgentConversation() : result;
}

export function deleteAgentConversation(conversationId: string): AgentWorkspaceMutationResult {
  const store = getAgentSqlStore();
  let removed = false;
  const result = store.transaction((tx) => {
    const workspace = resolvedWorkspace(tx.getWorkspace());
    const deleting = workspace.conversations.find((item) => item.id === conversationId);
    if (!deleting) return { ok: false, message: "对话不存在或已经删除。", workspace };
    if (["running", "waiting-permission"].includes(deleting.status)) {
      return { ok: false, message: "请先停止该对话的任务再删除。", workspace };
    }
    const state = tx.getR4State();
    if (hasDurableR4ConversationData(state, conversationId)) {
      return {
        ok: false,
        message: "该对话仍关联 R4 创作、任务或作品记录。请先处理任务并保留或归档对话；当前不会物理删除这些记录。",
        workspace,
      };
    }
    workspace.conversations = workspace.conversations.filter((item) => item.id !== conversationId);
    workspace.memories = workspace.memories.filter((item) => item.conversationId !== conversationId);
    if (workspace.selectedConversationId === conversationId) {
      workspace.selectedConversationId = workspace.conversations.find((item) => !item.archivedAt)?.id;
    }
    const nextWorkspace = resolvedWorkspace(normalizeAgentWorkspace({ ...workspace, updatedAt: now() }, true));
    tx.setWorkspace(nextWorkspace);
    if (state.conversations[conversationId]) {
      delete state.conversations[conversationId];
      state.updatedAt = now();
      tx.setR4State(state);
    }
    removed = true;
    return { ok: true, workspace: nextWorkspace };
  });
  if (removed) {
    try {
      const base = path.resolve(agentAttachmentsDirectory()), target = path.resolve(base, conversationId);
      if (target.startsWith(base + path.sep)) fs.rmSync(target, { recursive: true, force: true });
    } catch {
      // Metadata deletion is committed first; an antivirus may leave harmless orphan bytes.
    }
  }
  return result;
}

export function updateAgentConversation(
  conversationId: string,
  updater: (conversation: AgentConversation, workspace: AgentWorkspaceData) => void,
): AgentWorkspaceData {
  const workspace = readAgentWorkspace();
  const conversation = workspace.conversations.find((item) => item.id === conversationId);
  if (!conversation) throw new Error("对话不存在。");
  updater(conversation, workspace);
  conversation.updatedAt = now();
  const settings = getSettings();
  const inFlight = conversation.status === "running" || conversation.status === "waiting-permission";
  const contextMessages = effectiveContextMessages(
    conversation.messages,
    conversation.lastSummary,
    conversation.lastCompactedAt,
  );
  conversation.context = createContextSnapshot(
    contextMessages,
    settings.agentContextWindow,
    settings.agentAutoCompactThreshold,
    inFlight ? undefined : conversation.lastTurnUsage,
  );
  workspace.conversations.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return writeAgentWorkspace(workspace);
}

export function conversationForRuntimeSession(runtimeSessionId: string) {
  return readAgentWorkspace().conversations.find((item) => item.runtimeSessionId === runtimeSessionId);
}

export function findAgentConversationById(conversationId: string) {
  return readAgentWorkspace().conversations.find((item) => item.id === conversationId);
}

export function saveTavernWorkspace(input: AgentWorkspaceData): AgentWorkspaceMutationResult {
  return {
    ok: true,
    workspace: writeAgentWorkspace(normalizeAgentWorkspace(input)),
  };
}

/** Merge a narrow UI patch into the latest store; never replace messages with renderer snapshots. */
export function setStudioConversationOptions(conversationId:string,patch:Partial<StudioConversationOptions>):AgentWorkspaceMutationResult{
 const workspace=readAgentWorkspace(),chat=workspace.conversations.find(c=>c.id===conversationId);
 if(!chat||chat.archivedAt)return {ok:false,message:'对话不存在或已归档。',workspace};
 if(['running','waiting-permission'].includes(chat.status))return {ok:false,message:'请先停止当前任务再修改执行模式或资源。',workspace};
 if(!patch||typeof patch!=='object'||Array.isArray(patch))return {ok:false,message:'无效的对话选项。',workspace};
 if(patch.studioApprovalMode!==undefined){if(!['confirm','auto'].includes(patch.studioApprovalMode))return {ok:false,message:'无效的执行模式。',workspace};chat.studioApprovalMode=patch.studioApprovalMode;}
 if(patch.studioWebSearchEnabled!==undefined&&typeof patch.studioWebSearchEnabled==='boolean')chat.studioWebSearchEnabled=patch.studioWebSearchEnabled;
 if(patch.studioTemplateEnabled!==undefined&&typeof patch.studioTemplateEnabled==='boolean')chat.studioTemplateEnabled=patch.studioTemplateEnabled;
 if(patch.studioPresetId!==undefined){const id=patch.studioPresetId;if(typeof id!=='string'||!studioBuiltinPreset(id)&&!workspace.samplerPresets.some(p=>'tavern:'+p.id===id))return {ok:false,message:'预设不存在。',workspace};chat.studioPresetId=id;}
  if(patch.selectedSkillIds!==undefined){if(!Array.isArray(patch.selectedSkillIds))return {ok:false,message:'无效的技能选择。',workspace};const selectedSkillIds=[...new Set(patch.selectedSkillIds.filter(id=>typeof id==='string'&&workspace.skills.some(skill=>skill.id===id)))];if(selectedSkillIds.length>STUDIO_SKILL_LIMITS.maxSelected)return {ok:false,message:`每个会话最多选择${STUDIO_SKILL_LIMITS.maxSelected}个技能。`,workspace};chat.selectedSkillIds=selectedSkillIds;}
 if(patch.characterIds!==undefined){if(!Array.isArray(patch.characterIds))return {ok:false,message:'无效的角色选择。',workspace};const ids=[...new Set(patch.characterIds.filter(id=>workspace.characters.some(c=>c.id===id)))];if(!ids.length)return {ok:false,message:'请选择一个角色卡。',workspace};chat.characterIds=ids;chat.activeCharacterId=ids.includes(patch.activeCharacterId??'')?patch.activeCharacterId:ids[0];}
 if(patch.lorebookIds!==undefined){if(!Array.isArray(patch.lorebookIds))return {ok:false,message:'无效的世界书选择。',workspace};chat.lorebookIds=[...new Set(patch.lorebookIds.filter(id=>workspace.lorebooks.some(b=>b.id===id)))];}
 workspace.studioDefaults=normalizeStudioDefaults({studioApprovalMode:chat.studioApprovalMode,studioWebSearchEnabled:chat.studioWebSearchEnabled,studioTemplateEnabled:chat.studioTemplateEnabled,studioPresetId:chat.studioPresetId,characterIds:chat.characterIds,activeCharacterId:chat.activeCharacterId,lorebookIds:chat.lorebookIds,selectedSkillIds:chat.selectedSkillIds});
 return mutation(workspace);
}

function safeFileName(name: string) {
  const cleaned = path.basename(name).replace(/[\u0000-\u001f<>:"/\\|?*]+/g, "_").trim();
  return cleaned.slice(0, 160) || "attachment";
}

/** Explicit UI file picker; imported instructions remain declarative preset data. */
export async function importStudioPresetFiles():Promise<AgentWorkspaceMutationResult & {cancelled?:boolean}>{
 const language=getSettings().language;
 const picked=await dialog.showOpenDialog({title:systemPromptImportText(language).import,properties:['openFile','multiSelections'],filters:[{name:'UTF-8 JSON / Markdown / Text',extensions:['json','md','txt']}]});
 // Read after the asynchronous picker: do not overwrite intervening chat output.
 const workspace=readAgentWorkspace();
 if(picked.canceled)return {ok:true,cancelled:true,workspace};
 const errors:string[]=[],warnings:string[]=[],imported:TavernSamplerPreset[]=[];
 for(const file of picked.filePaths){try{
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.size<=0)throw new SystemPromptImportError('empty');
  if(stat.size>MAX_SYSTEM_PROMPT_IMPORT_BYTES)throw new SystemPromptImportError('bytes');
  const bytes=fs.readFileSync(file);
  const result=importImageSystemPrompt(decodeSystemPromptFile(bytes),{filename:path.basename(file),sourceHash:crypto.createHash('sha256').update(bytes).digest('hex')});
  const preset=result.preset;preset.id=crypto.randomUUID();
  warnings.push(...result.warnings);
  imported.push(preset);
 }catch(error){errors.push(path.basename(file)+'：'+systemPromptImportErrorText(error,language));}}
 // Reject the batch before writing any profile when any file is invalid.
 if(errors.length||!imported.length)return {ok:false,message:errors.join('\n')||systemPromptImportText(language).empty,workspace};
 const selectedIds:string[]=[];
 for(const preset of imported){
  const duplicate=workspace.samplerPresets.findIndex(item=>item.source!=='builtin'&&item.sourceHash?.toLowerCase()===preset.sourceHash?.toLowerCase());
  // A matching raw-file hash does not authorize undoing the user's edits.
  if(duplicate>=0){selectedIds.push(workspace.samplerPresets[duplicate].id);}
  else {workspace.samplerPresets.push(preset);selectedIds.push(preset.id);}
 }
 const chat=workspace.conversations.find(item=>item.id===workspace.selectedConversationId&&!item.archivedAt);
 if(chat)chat.studioPresetId='tavern:'+selectedIds[0];
 return {ok:true,workspace:writeAgentWorkspace(workspace,chat?{conversationId:chat.id,presetId:chat.studioPresetId!}:undefined),message:`${systemPromptImportText(language).import}: ${imported.length}${warnings.length?'\n'+warnings.join('\n'):''}`};
}

function uniquePath(directory: string, fileName: string) {
  const parsed = path.parse(fileName);
  let candidate = path.join(directory, fileName);
  let index = 1;
  while (fs.existsSync(candidate)) candidate = path.join(directory, `${parsed.name} (${index++})${parsed.ext}`);
  return candidate;
}

export async function importAgentFiles(conversationId: string, sourcePaths?: string[]) {
  if (!readAgentWorkspace().conversations.some(item=>item.id===conversationId&&!item.archivedAt)) return {ok:false,message:"对话不存在或已归档。",attachments:[]};
  let paths = Array.isArray(sourcePaths) ? sourcePaths.filter((item): item is string => typeof item === "string") : [];
  if (!paths.length) {
    const result = await dialog.showOpenDialog({
      title: "添加 Agent 附件",
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "支持的图片与文档", extensions: [...ALLOWED_EXTENSIONS].map((item) => item.slice(1)) },
        { name: "所有文件", extensions: ["*"] },
      ],
    });
    if (result.canceled) return { ok: true, cancelled: true, attachments: [] };
    paths = result.filePaths;
  }
  // The picker is asynchronous: never overwrite streaming changes with its old snapshot.
  const workspace=readAgentWorkspace();
  const conversation=workspace.conversations.find(item=>item.id===conversationId&&!item.archivedAt);
  if(!conversation)return {ok:false,message:"对话不存在或已归档。",attachments:[]};
  const targetDirectory = path.join(agentAttachmentsDirectory(), conversationId);
  fs.mkdirSync(targetDirectory, { recursive: true });
  const imported: AgentAttachment[] = [];
  let totalBytes = 0;
  for (const source of paths) {
    try {
      const resolved = path.resolve(source);
      const stat = fs.statSync(resolved);
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_FILE_BYTES) continue;
      totalBytes += stat.size;
      if (totalBytes > MAX_IMPORT_BYTES) break;
      const extension = path.extname(resolved).toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(extension)) continue;
      const destination = uniquePath(targetDirectory, safeFileName(path.basename(resolved)));
      fs.copyFileSync(resolved, destination, fs.constants.COPYFILE_EXCL);
      imported.push({
        id: crypto.randomUUID(),
        name: path.basename(destination),
        mime: mimeFor(extension),
        size: stat.size,
        kind: attachmentKind(extension),
        filePath: destination,
        fileUrl: toLocalMediaUrl(destination),
        createdAt: now(),
      });
    } catch {
      // Continue importing the remaining explicit user-selected files.
    }
  }
  if (!imported.length) return { ok: false, message: "没有可导入的文件（单文件上限 48 MB）。", attachments: [] };
  conversation.draftAttachments.push(...imported);
  conversation.updatedAt = now();
  writeAgentWorkspace(workspace);
  return { ok: true, attachments: imported };
}

/** File bytes originate from an explicit composer paste/drop, never from model tools. */
export function importAgentFileData(conversationId:string,raw:unknown) {
  const workspace=readAgentWorkspace(),conversation=workspace.conversations.find(c=>c.id===conversationId&&!c.archivedAt);
  if(!conversation||!Array.isArray(raw)||!raw.length||raw.length>64)return {ok:false,message:"附件输入无效或对话只读。",attachments:[]};
  let total=0;
  const files:Array<{name:string;bytes:Buffer}>=[];
  for(const item of raw){
    if(!item||typeof item.name!=='string'||!(item.bytes instanceof Uint8Array))return {ok:false,message:"附件输入无效。",attachments:[]};
    const name=safeFileName(item.name),bytes=Buffer.from(item.bytes);
    total+=bytes.length;
    if(!ALLOWED_EXTENSIONS.has(path.extname(name).toLowerCase())||!bytes.length||bytes.length>MAX_FILE_BYTES||total>MAX_IMPORT_BYTES)return {ok:false,message:"不支持的附件或超过大小限制（单文件 48 MB，总计 192 MB）。",attachments:[]};
    files.push({name,bytes});
  }
  const directory=path.join(agentAttachmentsDirectory(),conversationId),imported:AgentAttachment[]=[];
  fs.mkdirSync(directory,{recursive:true});
  try {
    for(const file of files){const destination=uniquePath(directory,file.name),extension=path.extname(file.name).toLowerCase();fs.writeFileSync(destination,file.bytes,{flag:'wx'});imported.push({id:crypto.randomUUID(),name:path.basename(destination),mime:mimeFor(extension),size:file.bytes.length,kind:attachmentKind(extension),filePath:destination,fileUrl:toLocalMediaUrl(destination),createdAt:now()});}
    conversation.draftAttachments.push(...imported);conversation.updatedAt=now();writeAgentWorkspace(workspace);
    return {ok:true,attachments:imported};
  }catch{for(const item of imported)try{fs.unlinkSync(item.filePath)}catch{}return {ok:false,message:"附件未保存，请检查本地存储。",attachments:[]};}
}

export function deleteAgentAttachment(conversationId: string, attachmentId: string): AgentWorkspaceMutationResult {
  const store = getAgentSqlStore();
  let removedPath: string | undefined;
  const result = store.transaction((tx) => {
    const workspace = resolvedWorkspace(tx.getWorkspace());
    const conversation = workspace.conversations.find((item) => item.id === conversationId);
    if (!conversation) return { ok: false, message: "对话不存在。", workspace };
    const attachment = conversation.draftAttachments.find((item) => item.id === attachmentId);
    if (!attachment) return { ok: false, message: "草稿附件不存在。", workspace };
    const state = tx.getR4State();
    if (hasR4AttachmentReference(state, attachmentId)) {
      return { ok: false, message: "该附件仍被 R4 创作、预览、排队任务或作品引用，已保留原文件。", workspace };
    }
    conversation.draftAttachments = conversation.draftAttachments.filter((item) => item.id !== attachmentId);
    const nextWorkspace = resolvedWorkspace(normalizeAgentWorkspace({ ...workspace, updatedAt: now() }, true));
    tx.setWorkspace(nextWorkspace);
    removedPath = attachment.filePath;
    return { ok: true, workspace: nextWorkspace };
  });
  if (result.ok && removedPath) {
    try {
      const base = path.resolve(agentAttachmentsDirectory()), target = path.resolve(removedPath);
      if (target.startsWith(base + path.sep)) fs.rmSync(target, { force: true });
    } catch { /* best effort after durable metadata commit */ }
  }
  return result;
}

export async function exportAgentAttachment(
  conversationId: string,
  messageId: string,
  attachmentId: string,
): Promise<{ ok: boolean; cancelled?: boolean; message: string; filePath?: string }> {
  const workspace = readAgentWorkspace();
  const conversation = workspace.conversations.find((item) => item.id === conversationId);
  const message = conversation?.messages.find((item) => item.id === messageId);
  const attachment = message?.attachments.find((item) => item.id === attachmentId);
  if (!attachment || attachment.unavailable || attachment.kind !== "image") {
    return { ok: false, message: "生成图片不存在。" };
  }
  const sourcePath = path.resolve(attachment.filePath);
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
    return { ok: false, message: "本地图片文件已移动或删除。" };
  }
  const extension = path.extname(sourcePath).toLowerCase();
  const result = await dialog.showSaveDialog({
    title: "保存生成图片",
    defaultPath: safeFileName(attachment.name || path.basename(sourcePath)),
    filters: [
      { name: "图片", extensions: [extension.slice(1) || "png"] },
      { name: "所有文件", extensions: ["*"] },
    ],
  });
  if (result.canceled || !result.filePath) {
    return { ok: true, cancelled: true, message: "已取消保存。" };
  }
  await fs.promises.copyFile(sourcePath, result.filePath);
  return { ok: true, message: "图片已保存。", filePath: result.filePath };
}

export function upsertAgentSkill(input: Partial<AgentSkill> & Pick<AgentSkill, "name" | "instructions">): AgentWorkspaceMutationResult {
  const workspace = readAgentWorkspace();
  if (!input || typeof input.name !== "string" || typeof input.instructions !== "string") {
    return { ok: false, message: "技能名称和指令无效。", workspace };
  }
  const existing = input.id ? workspace.skills.find((item) => item.id === input.id) : undefined;
  if (!existing && workspace.skills.length >= STUDIO_SKILL_LIMITS.maxSkills) {
    return { ok: false, message: `技能数量已达上限（${STUDIO_SKILL_LIMITS.maxSkills}）。`, workspace };
  }
  if(existing&&!existing.builtIn&&typeof input.enabled==='boolean'){
    const inputKeywords=Array.isArray(input.triggerKeywords)?input.triggerKeywords:existing.triggerKeywords??[];
    const sameKeywords=JSON.stringify(inputKeywords)===JSON.stringify(existing.triggerKeywords??[]);
    const enabledOnly=input.name===existing.name&&input.instructions===existing.instructions
      &&(input.description??existing.description)===existing.description
      &&(input.autoSelect??existing.autoSelect??false)===(existing.autoSelect??false)&&sameKeywords;
    if(enabledOnly){
      if(existing.enabled!==input.enabled){existing.enabled=input.enabled;existing.updatedAt=now();return mutation(workspace);}
      return {ok:true,workspace};
    }
  }
  if (existing?.builtIn) {
    // Built-in instructions are part of the product safety/tool contract, but
    // users must still be able to opt individual skills out of the system
    // prompt. Ignore all attempted content edits and persist only `enabled`.
    if (typeof input.enabled === "boolean" && input.enabled !== existing.enabled) {
      existing.enabled = input.enabled;
      existing.updatedAt = now();
      return mutation(workspace);
    }
    return { ok: false, message: "内置技能只能启用或停用，不能覆盖内容。", workspace };
  }
  const timestamp = now();
  const name=input.name.trim(),description=String(input.description ?? existing?.description ?? "").trim();
  const instructions=input.instructions;
  const triggerSource=Array.isArray(input.triggerKeywords)?input.triggerKeywords:existing?.triggerKeywords??[];
  const triggerKeywords=[...new Set(triggerSource.filter((item):item is string=>typeof item==='string').map(item=>item.trim()).filter(Boolean))];
  if(!name||name.length>STUDIO_SKILL_LIMITS.maxNameLength)return {ok:false,message:`技能名称不能为空且不能超过${STUDIO_SKILL_LIMITS.maxNameLength}个字符。`,workspace};
  if(description.length>STUDIO_SKILL_LIMITS.maxDescriptionLength)return {ok:false,message:`技能简介不能超过${STUDIO_SKILL_LIMITS.maxDescriptionLength}个字符。`,workspace};
  if(instructions.length>STUDIO_SKILL_LIMITS.maxInstructionsLength)return {ok:false,message:`技能指令不能超过${STUDIO_SKILL_LIMITS.maxInstructionsLength}个字符；现有内容已保留，请缩短后再保存。`,workspace};
  if(triggerKeywords.length>STUDIO_SKILL_LIMITS.maxTriggerKeywords||triggerKeywords.some(item=>item.length>STUDIO_SKILL_LIMITS.maxTriggerKeywordLength))return {ok:false,message:`触发词最多${STUDIO_SKILL_LIMITS.maxTriggerKeywords}个，每个不能超过${STUDIO_SKILL_LIMITS.maxTriggerKeywordLength}个字符。`,workspace};
  const skill: AgentSkill = {
    id: existing?.id ?? crypto.randomUUID(),
    name,
    description,
    instructions,
    enabled: typeof input.enabled === "boolean" ? input.enabled : existing?.enabled ?? true,
    triggerKeywords,
    autoSelect: typeof input.autoSelect === "boolean" ? input.autoSelect : existing?.autoSelect ?? false,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
  workspace.skills = existing
    ? workspace.skills.map((item) => item.id === existing.id ? skill : item)
    : [...workspace.skills, skill];
  return mutation(workspace);
}

export function deleteAgentSkill(skillId: string): AgentWorkspaceMutationResult {
  const workspace = readAgentWorkspace();
  if (workspace.skills.some((item) => item.id === skillId && item.builtIn)) {
    return { ok: false, message: "内置技能不能删除，可将其关闭。", workspace };
  }
  workspace.skills = workspace.skills.filter((item) => item.id !== skillId);
  for (const conversation of workspace.conversations) {
    conversation.selectedSkillIds = (conversation.selectedSkillIds ?? []).filter((id) => id !== skillId);
  }
  if (workspace.studioDefaults?.selectedSkillIds) {
    workspace.studioDefaults.selectedSkillIds = workspace.studioDefaults.selectedSkillIds.filter((id) => id !== skillId);
  }
  return mutation(workspace);
}

export function upsertAgentMemory(input: Partial<AgentMemory> & Pick<AgentMemory, "title" | "content" | "scope">): AgentWorkspaceMutationResult {
  const workspace = readAgentWorkspace();
  const existing = input.id ? workspace.memories.find((item) => item.id === input.id) : undefined;
  if (input.id && !existing) return { ok: false, message: "记忆不存在或已被清理。", workspace };
  if (existing?.supersededBy) return { ok: false, message: "该记忆已被覆盖，不能再修改。", workspace };
  const timestamp = now();
  const trigger = String(input.trigger ?? input.title ?? existing?.trigger ?? existing?.title ?? "").trim().slice(0, 200);
  const type = isAgentMemoryType(input.type) ? input.type : existing?.type ?? "other";
  const source = isAgentMemorySource(input.source) ? input.source : existing?.source ?? "manual";
  const normalizedContent = normalizeAgentMemoryContent(type, input.content);
  // Preserve an invalid tag candidate for review/editing. Promotion to an
  // approved source still fails closed and leaves the pending row untouched.
  const content = (source === "pendingLlmCandidate" && !normalizedContent.trim()
    ? input.content
    : normalizedContent).slice(0, 8_000);
  if (!trigger) return { ok: false, message: "记忆触发词不能为空。", workspace };
  if (!content.trim() || (source !== "pendingLlmCandidate" && !normalizedContent.trim())) return { ok: false, message: type === "characterName" || type === "characterFeature" || type === "style"
    ? "标签类记忆需要有效的英文提示词标签。"
    : "记忆内容不能为空。", workspace };
  const scope = input.scope === "conversation" ? "conversation" : "global";
  const conversationId = scope === "conversation"
    ? (typeof input.conversationId === "string" && input.conversationId ? input.conversationId : existing?.conversationId)
    : undefined;
  if (scope === "conversation" && !conversationId) return { ok: false, message: "会话记忆需要指定会话。", workspace };
  const memory: AgentMemory = {
    id: existing?.id ?? crypto.randomUUID(),
    title: trigger.slice(0, 100),
    trigger,
    content,
    type,
    source,
    scope,
    ...(conversationId ? { conversationId } : {}),
    hitCount: existing?.hitCount ?? 0,
    ...(existing?.lastHitAt ? { lastHitAt: existing.lastHitAt } : {}),
    weight: existing?.weight ?? 1,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };

  // The existing preload mutation API transports this private action hint with
  // the upsert request; normalizeAgentMemorySnapshot never persists it.
  const action = input as typeof input & { supersedeIds?: unknown };
  const supersedeIds = Array.isArray(action.supersedeIds)
    ? [...new Set(action.supersedeIds.filter((id): id is string => typeof id === "string" && id !== memory.id))].slice(0, 50)
    : [];
  if (source === "pendingLlmCandidate" && supersedeIds.length) {
    return { ok: false, message: "待审核候选不能覆盖已批准记忆。", workspace };
  }
  const conflictIds = new Set(findAgentMemoryConflicts(workspace.memories, memory, memory.id).map((item) => item.id));
  if (supersedeIds.some((id) => !conflictIds.has(id))) {
    return { ok: false, message: "冲突记忆已变化，请刷新后重新处理。", workspace };
  }
  if (!existing && source === "pendingLlmCandidate") {
    const duplicate = workspace.memories.find((item) => item.source === "pendingLlmCandidate"
      && item.type === type && item.trigger?.toLocaleLowerCase() === trigger.toLocaleLowerCase()
      && item.content === content && item.scope === scope && item.conversationId === conversationId);
    if (duplicate) return { ok: true, message: "相同的候选记忆已在待审核列表中。", workspace };
  }
  if (supersedeIds.length) {
    workspace.memories = workspace.memories.map((item) => supersedeIds.includes(item.id)
      ? { ...item, supersededBy: memory.id, updatedAt: timestamp }
      : item);
  }
  workspace.memories = existing
    ? workspace.memories.map((item) => item.id === existing.id ? memory : item)
    : [...workspace.memories, memory];
  return mutation(workspace);
}

export function retrieveAgentMemories(query: string, conversationId: string | undefined, options: { limit?: number; characterBudget?: number } = {}) {
  const normalizedQuery = typeof query === "string" ? query.trim().slice(0, 1_000) : "";
  if (!normalizedQuery) return [];
  const workspace = readAgentWorkspace();
  const matches = workspace.memories
    .filter((memory) => isRetrievableAgentMemory(memory)
      && (memory.scope === "global" || Boolean(conversationId && memory.conversationId === conversationId)))
    .map((memory) => ({ memory, score: scoreAgentMemoryQuery(normalizedQuery, memory) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score
      || (a.memory.weight ?? 1) - (b.memory.weight ?? 1)
      || b.memory.updatedAt.localeCompare(a.memory.updatedAt));
  const limit = Math.max(1, Math.min(8, Math.trunc(options.limit ?? 8)));
  let remaining = Math.max(1_000, Math.min(12_000, Math.trunc(options.characterBudget ?? 12_000)));
  const timestamp = now();
  const selected: Array<AgentMemory & { contentTruncated?: boolean }> = [];
  for (const { memory } of matches) {
    if (selected.length >= limit || remaining <= 0) break;
    const base = { ...memory, hitCount: (memory.hitCount ?? 0) + 1, lastHitAt: timestamp, updatedAt: timestamp };
    let low = 0;
    let high = memory.content.length;
    let best: (AgentMemory & { contentTruncated?: boolean }) | undefined;
    while (low <= high) {
      const size = Math.floor((low + high) / 2);
      const content = memory.content.slice(0, size);
      const candidate = {
        ...base,
        content,
        ...(size < memory.content.length ? { contentTruncated: true } : {}),
      };
      if (JSON.stringify([...selected, candidate]).length <= remaining) {
        best = candidate;
        low = size + 1;
      } else {
        high = size - 1;
      }
    }
    if (!best) break;
    selected.push(best);
  }
  if (!selected.length) return [];
  const hitIds = new Set(selected.map((memory) => memory.id));
  workspace.memories = workspace.memories.map((memory) => hitIds.has(memory.id)
    ? { ...memory, hitCount: (memory.hitCount ?? 0) + 1, lastHitAt: timestamp, updatedAt: timestamp }
    : memory);
  writeAgentWorkspace(workspace);
  return selected;
}

export function deleteAgentMemory(memoryId: string): AgentWorkspaceMutationResult {
  const workspace = readAgentWorkspace();
  workspace.memories = workspace.memories.filter((item) => item.id !== memoryId);
  return mutation(workspace);
}

export function mergeImportedAgentWorkspace(incoming: AgentWorkspaceData) {
  const result = mergeAgentWorkspaces(readAgentWorkspace(), normalizeAgentWorkspace(incoming));
  result.workspace = writeAgentWorkspace(result.workspace);
  return result;
}

export function resetAgentStoreCacheForTests() {
  closeAgentSqlStore();
}

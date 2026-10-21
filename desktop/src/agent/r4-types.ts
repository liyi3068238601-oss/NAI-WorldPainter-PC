/** Shared durable model for the R4 Agent creative and execution workflow. */

export const R4_AGENT_STATE_VERSION = 1 as const;

export type R4LegacyStatus = "legacy_unversioned" | "migration_conflict";

export interface R4ProviderRef {
  /** Public provider/profile identity only. Credentials must never be stored here. */
  providerId: string;
  profileId?: string;
  accountRef?: string;
  revision?: string | number;
}

export interface R4AssistantPresetBinding {
  presetId: string;
  enabled: boolean;
  /** Missing on a versioned migration source is not interpreted as false. */
  legacyStatus?: R4LegacyStatus;
}

export interface R4ConversationConfigSnapshot {
  version: 1;
  providerRef: R4ProviderRef;
  modelId: string;
  modelRevision?: string | number;
  presetId: string | null;
  enabled: boolean;
  body?: string;
  revision?: string | number;
  hash?: string;
  /** Safe public request parameters; credential fields are forbidden. */
  publicParameters: Record<string, unknown>;
  capturedAt: string;
  source: "message_send" | "preview" | "legacy_unversioned";
  legacyStatus?: R4LegacyStatus;
}

export interface R4AssistantPreset {
  id: string;
  name: string;
  body: string;
  revision: number;
  hash: string;
  source: "builtin" | "user" | "legacy_tavern" | "legacy_pi";
  createdAt?: string;
  updatedAt?: string;
  /** Original data stays available when a legacy mapping is not lossless. */
  legacyStatus?: R4LegacyStatus;
  legacyRecord?: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

export type R4ReferenceRole = "reference" | "discussion";
export type R4ReferencePurpose = "color" | "composition" | "character" | "atmosphere";
export type R4ReferenceAuthorizationStatus = "authorized" | "not_authorized" | "revoked" | "unknown";

export interface R4AttachmentBinding {
  attachmentId: string;
  revision: number;
  hash?: string;
  name?: string;
  mime?: string;
  width?: number;
  height?: number;
}

export interface R4ReferenceBinding extends R4AttachmentBinding {
  role: R4ReferenceRole;
  purpose?: R4ReferencePurpose;
  includeInGeneration: boolean;
  authorizationStatus: R4ReferenceAuthorizationStatus;
  authorizationReceiptId?: string;
  authorizedUserIntentRef?: string;
  legacyStatus?: R4LegacyStatus;
}

export interface R4CreationInputSnapshot {
  inputRevision: number;
  positivePrompt: string;
  negativePrompt: string;
  stylePrompt: string;
  requirements?: string;
  publicParameters: Record<string, unknown>;
  editSource?: R4AttachmentBinding | null;
  mask?: R4AttachmentBinding | null;
  references: R4ReferenceBinding[];
  /** Frozen renderer-selected inputs not represented by R4 proposal attachments. */
  workbenchAssets?: R4WorkbenchAssetBinding[];
  proposalRef?: string | null;
  conversationConfig?: R4ConversationConfigSnapshot;
  fingerprint?: string;
  legacyStatus?: R4LegacyStatus;
}

export interface R4Creation {
  id: string;
  conversationId: string;
  title: string;
  inputRevision: number;
  selectionRevision: number;
  requirements?: string;
  positivePrompt: string;
  negativePrompt: string;
  stylePrompt: string;
  publicParameters: Record<string, unknown>;
  currentProposalRef?: string | null;
  editSource?: R4AttachmentBinding | null;
  references: R4ReferenceBinding[];
  mask?: R4AttachmentBinding | null;
  artworkIds: string[];
  currentInput: R4CreationInputSnapshot;
  createdAt: string;
  updatedAt: string;
  legacyStatus?: R4LegacyStatus;
  extensions?: Record<string, unknown>;
}

export interface R4Proposal {
  id: string;
  conversationId: string;
  creationId: string;
  revision: number;
  title: string;
  summary: string;
  change: string;
  keywords: string[];
  positivePrompt: string;
  negativePrompt: string;
  stylePrompt: string;
  requirements?: string;
  publicParameters: Record<string, unknown>;
  sourceMessageId?: string;
  sourceInputRevision?: number;
  createdAt: string;
  isCurrent?: boolean;
  legacyStatus?: R4LegacyStatus;
  extensions?: Record<string, unknown>;
}

export interface R4Artwork {
  id: string;
  attachmentId: string;
  revision: number;
  conversationId: string;
  creationId: string;
  executionId?: string;
  batchId?: string;
  outputIndex?: number;
  name: string;
  mime: string;
  /** Host-generated local-media URL for rendering; never a provider URL. */
  url?: string;
  readableHandle?: string;
  hash?: string;
  width?: number;
  height?: number;
  parentAttachmentId?: string;
  resolvedSeed?: number | null;
  resolvedSeedSource?: "provider_receipt" | "verified_embedded_metadata" | null;
  createdAt: string;
  legacyStatus?: R4LegacyStatus;
  /** Workbench inputs are managed source assets, not generated gallery outputs. */
  sourceKind?: 'workbench';
}

export interface R4WorkbenchAssetBinding extends R4AttachmentBinding {
  role: 'vibe' | 'precise';
}

export type R4PreparationStatus = "ready" | "blocked" | "approved" | "consumed" | "expired" | "invalidated";

export interface R4Preparation {
  id: string;
  conversationId: string;
  creationId: string;
  inputRevision: number;
  fingerprint: string;
  preview: Record<string, unknown>;
  inputSnapshot: R4CreationInputSnapshot;
  conversationConfig: R4ConversationConfigSnapshot;
  userIntentRef?: string;
  sourceMessageId?: string;
  providerRef?: R4ProviderRef;
  status: R4PreparationStatus;
  blockedReason?: string;
  approvalReceiptId?: string;
  approvedAt?: string;
  expiresAt?: string;
  consumedByExecutionId?: string;
  createdAt: string;
  legacyStatus?: R4LegacyStatus;
}

export type R4ExecutionStatus =
  | "queued" | "dispatching" | "running" | "cancel_requested"
  | "completed" | "partial" | "error" | "cancelled" | "unknown" | "blocked" | "denied";
export type R4OutputStatus = "not_dispatched" | "pending" | "completed" | "failed" | "cancelled" | "unknown";
export type R4ProviderCancellation = "not_sent" | "requested" | "confirmed" | "unsupported" | "unknown";
export type R4ProviderReceiptStatus = "not_applicable" | "pending" | "confirmed" | "unknown";
export type R4RequestGranularity = "per_output" | "batch";

export interface R4ProviderReceipt {
  status: R4ProviderReceiptStatus;
  requestId?: string;
  serviceTaskId?: string;
  receivedAt?: string;
  rawStatus?: string;
  message?: string;
}

export interface R4ExecutionOutput {
  outputIndex: number;
  status: R4OutputStatus;
  errorCode?: string;
  errorMessage?: string;
  artwork?: R4Artwork;
  providerReceipt?: R4ProviderReceipt;
  resolvedSeed?: number | null;
  resolvedSeedSource?: "provider_receipt" | "verified_embedded_metadata" | null;
  updatedAt?: string;
}

export interface R4ExecutionEvent {
  id: string;
  kind: string;
  at: string;
  outputIndex?: number;
  detail?: Record<string, unknown>;
}

export interface R4Execution {
  id: string;
  conversationId: string;
  creationId: string;
  preparationId?: string;
  operationKey: string;
  submissionKey: string;
  userIntentRef: string;
  inputRevision: number;
  inputFingerprint: string;
  expectedOutputCount: number;
  requestGranularity: R4RequestGranularity;
  providerRef: R4ProviderRef;
  providerAccountRef?: string;
  approvedInput: R4CreationInputSnapshot;
  conversationConfig: R4ConversationConfigSnapshot;
  status: R4ExecutionStatus;
  outputs: R4ExecutionOutput[];
  providerReceiptStatus: R4ProviderReceiptStatus;
  providerCancellation: R4ProviderCancellation;
  receiptRevision: number;
  providerServiceTaskId?: string;
  blockedReason?: string;
  pauseReason?: string;
  /** Explicitly released independent work may pass listed global unknown gates. */
  releasedGateIds?: string[];
  cancelRequestedAt?: string;
  approvalReceiptId?: string;
  dispatchClaimId?: string;
  createdAt: string;
  updatedAt: string;
  events: R4ExecutionEvent[];
  legacyStatus?: R4LegacyStatus;
}

export type R4QueueStatus = "queued" | "running" | "waiting_execution" | "paused" | "completed" | "cancelled" | "error";

export interface R4ComposerDraft {
  text: string;
  revision: number;
  attachmentIds: string[];
  updatedAt: string;
  /** A restored turn keeps its original config until the user confirms it. */
  restoredConversationConfig?: R4ConversationConfigSnapshot;
  requiresConfigConfirmation?: boolean;
  restoredConfigFingerprint?: string;
}

export interface R4DraftRecoveryCondition {
  draftId?: string;
  draftRevision?: number;
  inputFingerprint?: string;
  status: "unchanged" | "changed" | "conflict" | "legacy_unversioned";
}

export interface R4QueuedMessage {
  id: string;
  conversationId: string;
  messageId: string;
  sequence: number;
  text: string;
  /** Provider-facing text expanded at admission; never regenerated at run time. */
  providerText?: string;
  attachmentIds?: string[];
  actions?: Array<Record<string, unknown>>;
  creationId?: string;
  assistantMessageId?: string;
  startedAt?: string;
  steeringStatus?: "requested" | "consumed" | "none";
  predecessorIds?: string[];
  userIntentRef: string;
  /** Explicit UI continuation applies only to this new message and these old gates. */
  releasedGateIds?:string[];
  bypassPausedPredecessorIds?:string[];
  conversationConfig: R4ConversationConfigSnapshot;
  originalInputSnapshot?: R4CreationInputSnapshot;
  draftRecovery?: R4DraftRecoveryCondition;
  status: R4QueueStatus;
  /** Explains an explicit pause/recovery boundary; never implies safe replay. */
  pauseReason?: string;
  createdAt: string;
  updatedAt: string;
  legacyStatus?: R4LegacyStatus;
}

export interface R4DispatchGate {
  id: string;
  conversationId: string;
  turnId?: string;
  batchId?: string;
  executionId?: string;
  active: boolean;
  reason: string;
  sourceExecutionId?: string;
  createdAt: string;
  releasedAt?: string;
  releasedBy?: string;
  legacyStatus?: R4LegacyStatus;
}

export interface R4OperationReceipt {
  id: string;
  conversationId: string;
  creationId: string;
  operationKey: string;
  operation: string;
  status: "applied" | "conflict" | "denied" | "rejected";
  beforeInputRevision?: number;
  afterInputRevision?: number;
  userIntentRef?: string;
  targetAttachmentId?: string;
  receipt: Record<string, unknown>;
  createdAt: string;
  legacyStatus?: R4LegacyStatus;
}

export interface R4CritiqueQueueItem {
  id: string;
  conversationId: string;
  creationId: string;
  executionId: string;
  uniqueKey: string;
  conversationConfig: R4ConversationConfigSnapshot;
  status: "pending" | "running" | "delivered" | "blocked" | "unknown" | "cancelled";
  dispatchStartedAt?:string;
  messageId?: string;
  createdAt: string;
  updatedAt: string;
  legacyStatus?: R4LegacyStatus;
}

export interface R4ConversationState {
  conversationId: string;
  currentCreationId?: string;
  selectedArtworkId?: string;
  composerDraft?: R4ComposerDraft;
  messageCreationIds: Record<string, string>;
  config?: R4ConversationConfigSnapshot;
  configurationIssue?:string;
  assistantPresetBinding?: R4AssistantPresetBinding;
  selectionRevision: number;
  updatedAt: string;
  legacyStatus?: R4LegacyStatus;
}

export interface R4AgentState {
  schemaVersion: typeof R4_AGENT_STATE_VERSION;
  conversations: Record<string, R4ConversationState>;
  creations: Record<string, R4Creation>;
  proposals: Record<string, R4Proposal>;
  artworks: Record<string, R4Artwork>;
  preparations: Record<string, R4Preparation>;
  executions: Record<string, R4Execution>;
  messageQueue: Record<string, R4QueuedMessage>;
  gates: Record<string, R4DispatchGate>;
  operations: Record<string, R4OperationReceipt>;
  critiqueQueue: Record<string, R4CritiqueQueueItem>;
  assistantPresets: Record<string, R4AssistantPreset>;
  assistantPresetDefaultBinding?: R4AssistantPresetBinding;
  /** Preserves fields that a supported source version cannot yet map losslessly. */
  compatibility: Record<string, unknown>;
  updatedAt: string;
}

/** Conversation-scoped projection intended for UI reads. Records retain their stable IDs. */
export interface R4ConversationCreativeState {
  schemaVersion: typeof R4_AGENT_STATE_VERSION;
  conversationId: string;
  /** Changes whenever the durable R4 snapshot commits; useful for stale-read suppression. */
  updatedAt: string;
  currentCreationId?: string;
  selectedArtworkId?: string;
  composerDraft?: R4ComposerDraft;
  messageCreationIds: Record<string, string>;
  config?: R4ConversationConfigSnapshot;
  configurationIssue?:string;
  assistantPresetBinding?: R4AssistantPresetBinding;
  creations: Record<string, R4Creation>;
  proposals: Record<string, R4Proposal>;
  artworks: Record<string, R4Artwork>;
  preparations: Record<string, R4Preparation>;
  executions: Record<string, R4Execution>;
  messageQueue: Record<string, R4QueuedMessage>;
  gates: Record<string, R4DispatchGate>;
  operations: Record<string, R4OperationReceipt>;
  critiqueQueue: Record<string, R4CritiqueQueueItem>;
  assistantPresets: Record<string, R4AssistantPreset>;
  assistantPresetDefaultBinding?: R4AssistantPresetBinding;
  legacyStatus?: R4LegacyStatus;
}

export function createEmptyR4AgentState(): R4AgentState {
  return {
    schemaVersion: R4_AGENT_STATE_VERSION,
    conversations: {}, creations: {}, proposals: {}, artworks: {}, preparations: {},
    executions: {}, messageQueue: {}, gates: {}, operations: {}, critiqueQueue: {},
    assistantPresets: {}, compatibility: {}, updatedAt: new Date().toISOString(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** Rejects unknown schema versions; missing v1 collections are safe empty additions. */
export function normalizeR4AgentState(value: unknown): R4AgentState {
  if (value == null) return createEmptyR4AgentState();
  if (!isRecord(value)) throw new Error("R4 Agent 状态格式无效，原数据已保留。");
  if (value.schemaVersion !== R4_AGENT_STATE_VERSION) {
    throw new Error(`R4 Agent 状态版本 ${String(value.schemaVersion)} 暂不支持，原数据已保留。`);
  }
  const empty = createEmptyR4AgentState();
  const normalized: Record<string, unknown> = { ...empty, ...structuredClone(value) };
  for (const key of ["conversations", "creations", "proposals", "artworks", "preparations", "executions", "messageQueue", "gates", "operations", "critiqueQueue", "assistantPresets", "compatibility"]) {
    const collection = normalized[key];
    if (collection == null) normalized[key] = {};
    else if (!isRecord(collection)) throw new Error(`R4 Agent ${key} 数据格式无效，原数据已保留。`);
  }
  if (normalized.assistantPresetDefaultBinding != null && !isRecord(normalized.assistantPresetDefaultBinding)) {
    throw new Error("R4 助手预设默认绑定格式无效，原数据已保留。");
  }
  if (typeof normalized.updatedAt !== "string") normalized.updatedAt = empty.updatedAt;
  return normalized as unknown as R4AgentState;
}

export function projectR4Conversation(
  state: R4AgentState,
  conversationId: string,
): R4ConversationCreativeState {
  const conversation = state.conversations[conversationId];
  const belongs = <T extends { conversationId: string }>(items: Record<string, T>) => Object.fromEntries(
    Object.entries(items).filter(([, item]) => item.conversationId === conversationId),
  );
  const creationIds = new Set(Object.keys(belongs(state.creations)));
  const artworks = belongs(state.artworks);
  const proposals = belongs(state.proposals);
  const executions = belongs(state.executions);
  return {
    schemaVersion: R4_AGENT_STATE_VERSION,
    conversationId,
    updatedAt: state.updatedAt,
    ...(conversation?.currentCreationId ? { currentCreationId: conversation.currentCreationId } : {}),
    ...(conversation?.selectedArtworkId ? { selectedArtworkId: conversation.selectedArtworkId } : {}),
    ...(conversation?.composerDraft ? { composerDraft: structuredClone(conversation.composerDraft) } : {}),
    messageCreationIds: structuredClone(conversation?.messageCreationIds ?? {}),
    ...(conversation?.config ? { config: structuredClone(conversation.config) } : {}),
    ...(conversation?.configurationIssue?{configurationIssue:conversation.configurationIssue}:{}),
    ...(conversation?.assistantPresetBinding ? { assistantPresetBinding: structuredClone(conversation.assistantPresetBinding) } : {}),
    creations: Object.fromEntries(Object.entries(state.creations).filter(([id]) => creationIds.has(id))),
    proposals,
    artworks,
    preparations: Object.fromEntries(Object.entries(state.preparations).filter(([, item]) => item.conversationId === conversationId)),
    executions,
    messageQueue: Object.fromEntries(Object.entries(state.messageQueue).filter(([, item]) => item.conversationId === conversationId)),
    gates: Object.fromEntries(Object.entries(state.gates).filter(([, item]) => item.conversationId === conversationId)),
    operations: Object.fromEntries(Object.entries(state.operations).filter(([, item]) => item.conversationId === conversationId)),
    critiqueQueue: Object.fromEntries(Object.entries(state.critiqueQueue).filter(([, item]) => item.conversationId === conversationId)),
    assistantPresets: structuredClone(state.assistantPresets),
    ...(state.assistantPresetDefaultBinding ? { assistantPresetDefaultBinding: structuredClone(state.assistantPresetDefaultBinding) } : {}),
    ...(conversation?.legacyStatus ? { legacyStatus: conversation.legacyStatus } : {}),
  };
}

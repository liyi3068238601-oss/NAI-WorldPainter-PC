import type {I2IParams} from '../types';
/** Public, non-secret workbench CAS data shared by the Electron bridge and UI. */
export interface R4WorkbenchPromptFields {
  positivePrompt: string;
  negativePrompt: string;
  stylePrompt: string;
}

export interface R4WorkbenchPromptDiff {
  positivePromptChanged: boolean;
  negativePromptChanged: boolean;
  stylePromptChanged: boolean;
  characterPromptsChanged?: boolean;
}

export interface R4WorkbenchSnapshot {
  /** Renderer-owned live workbench identity. It is not a creation ID. */
  draftId: string;
  /** Monotonic for changes to the current renderer workbench snapshot. */
  draftRevision: number;
  /** Same live-input revision while workbench params and references share one Zustand draft. */
  inputRevision: number;
  draftSource: 'workbench';
  params: Record<string, unknown>;
  /** Host-only renderer snapshot. Contains local paths and image payloads; never project directly to a model. */
  workbench?: {
    mode?: string;
    /** Renderer-owned generation history group, used when outputs return to the active workbench. */
    historyGroupId?: string;
    /** Current renderer model mode, frozen with the rest of the Generate draft. */
    modelMode?: 'anime' | 'furry';
    imageProvider?: 'novelai' | 'openai-images';
    batchCount?: number;
    batchIntervalSeconds?: number;
    charCaptions?: unknown[];
    i2iParams?: I2IParams | Record<string, unknown>;
    i2iSizeMode?: string;
    sourceMode?: string;
    source?: { filePath?: string; fileUrl?: string; width?: number; height?: number } | null;
    inpaintPositivePrompt?: string;
    inpaintModel?: string;
    inpaintStrength?: number;
    inpaintNoise?: number;
    inpaintSizeMode?: string;
    inpaintCustomSize?: { width: number; height: number };
    inpaintSourceMode?: string;
    maskRevision?: number;
    mask?: string | null;
    region?: Record<string, unknown> | null;
    vibeImages?: unknown[];
    preciseReferences?: unknown[];
    busy?: { isGenerating?: boolean; isGenerateQueueRunning?: boolean; batchRunning?: boolean };
  };
}

export interface R4WorkbenchPromptWriteResult {
  resultKind: 'business';
  status: 'completed';
  conversationId: string;
  creationId: string;
  data: {
    writeStatus: 'written' | 'unchanged' | 'conflict';
    draftId: string;
    draftRevision: number;
    changedFields: R4WorkbenchPromptDiff;
  };
}

export interface R4WorkbenchPromptPreview {
  previewId: string;
  conversationId: string;
  creationId: string;
  proposalId: string;
  proposalRevision: number;
  draftId: string;
  draftRevision: number;
  inputRevision: number;
  before: R4WorkbenchPromptFields;
  after: R4WorkbenchPromptFields;
  diff: R4WorkbenchPromptDiff;
}

export interface R4WorkbenchPromptPreviewRequest {
  conversationId: string;
  creationId: string;
  proposalId: string;
  proposalRevision: number;
}

export interface R4WorkbenchPromptApplyRequest extends R4WorkbenchPromptPreviewRequest {
  previewId: string;
  draftId: string;
  draftRevision: number;
}

export interface R4ApplyPromptResult {
  resultKind: 'business';
  status: 'completed';
  conversationId: string;
  creationId: string;
  data: {
    applyStatus: 'applied' | 'conflict' | 'not_found' | 'invalid';
    draftId: string;
    draftRevision: number | null;
    diff?: R4WorkbenchPromptDiff;
  };
}

export type R4WorkbenchIpcReply<T> = { ok: true; data: T } | { ok: false; message: string };

export type R4WorkbenchRendererAction = 'r4-workbench-read' | 'r4-workbench-apply' | 'r4-workbench-parameters' | 'r4-workbench-result';

export interface R4WorkbenchRendererRequest {
  id: string;
  action: R4WorkbenchRendererAction;
  args: Record<string, unknown>;
}

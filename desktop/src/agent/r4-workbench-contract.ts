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

export type R4WorkbenchRendererAction = 'r4-workbench-read' | 'r4-workbench-apply';

export interface R4WorkbenchRendererRequest {
  id: string;
  action: R4WorkbenchRendererAction;
  args: Record<string, unknown>;
}

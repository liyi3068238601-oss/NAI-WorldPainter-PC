export interface MobileInpaintPromptDrafts {
  prompt: string;
  negative: string;
}

export interface MobileInpaintDraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface MobileInpaintWorkspaceDrafts {
  output: { width: number; height: number };
  customOutputs: { width: number; height: number }[];
}

const PROMPT_KEY = "worldpainter.mobile-inpaint.prompt-draft.v1";
const NEGATIVE_KEY = "worldpainter.mobile-inpaint.negative-draft.v1";
const WORKSPACE_KEY = "worldpainter.mobile-inpaint.workspace-draft.v1";
const EMPTY: MobileInpaintPromptDrafts = { prompt: "", negative: "" };
const DEFAULT_WORKSPACE: MobileInpaintWorkspaceDrafts = { output: { width: 832, height: 1216 }, customOutputs: [] };

export function isMobileInpaintOutputSize(value: unknown): value is { width: number; height: number } {
  if (!value || typeof value !== "object") return false;
  const size = value as { width?: unknown; height?: unknown };
  return [size.width, size.height].every(item => typeof item === "number" && Number.isSafeInteger(item) && item >= 64 && item <= 1920 && item % 64 === 0);
}

function normalizeCustomOutputs(value: unknown) {
  if (!Array.isArray(value)) return [];
  const unique = new Map<string, { width: number; height: number }>();
  for (const item of value) {
    if (isMobileInpaintOutputSize(item)) unique.set(`${item.width}x${item.height}`, { width: item.width, height: item.height });
  }
  return [...unique.values()];
}

function browserStorage(): MobileInpaintDraftStorage | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}

function readDraft(storage: MobileInpaintDraftStorage, key: string): string {
  try {
    const raw = storage.getItem(key);
    if (raw === null) return "";
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return "";
    const record = parsed as { version?: unknown; value?: unknown };
    return record.version === 1 && typeof record.value === "string" ? record.value : "";
  } catch { return ""; }
}

export function loadMobileInpaintPromptDrafts(storage = browserStorage()): MobileInpaintPromptDrafts {
  if (!storage) return { ...EMPTY };
  return { prompt: readDraft(storage, PROMPT_KEY), negative: readDraft(storage, NEGATIVE_KEY) };
}

export function loadMobileInpaintWorkspaceDrafts(storage = browserStorage()): MobileInpaintWorkspaceDrafts {
  if (!storage) return { output: { ...DEFAULT_WORKSPACE.output }, customOutputs: [] };
  try {
    const raw = storage.getItem(WORKSPACE_KEY);
    if (raw === null) return { output: { ...DEFAULT_WORKSPACE.output }, customOutputs: [] };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { output: { ...DEFAULT_WORKSPACE.output }, customOutputs: [] };
    const record = parsed as { version?: unknown; output?: unknown; customOutputs?: unknown };
    if (record.version !== 1) return { output: { ...DEFAULT_WORKSPACE.output }, customOutputs: [] };
    return {
      output: isMobileInpaintOutputSize(record.output) ? { ...record.output } : { ...DEFAULT_WORKSPACE.output },
      customOutputs: normalizeCustomOutputs(record.customOutputs),
    };
  } catch { return { output: { ...DEFAULT_WORKSPACE.output }, customOutputs: [] }; }
}

/** Saves each field independently so an unavailable key does not lose the other draft. */
export function saveMobileInpaintPromptDrafts(
  drafts: MobileInpaintPromptDrafts,
  storage = browserStorage(),
) {
  if (!storage) return;
  try { storage.setItem(PROMPT_KEY, JSON.stringify({ version: 1, value: drafts.prompt })); } catch { /* Draft persistence is best effort. */ }
  try { storage.setItem(NEGATIVE_KEY, JSON.stringify({ version: 1, value: drafts.negative })); } catch { /* Keep the positive draft even if this key fails. */ }
}

export function saveMobileInpaintWorkspaceDrafts(
  drafts: MobileInpaintWorkspaceDrafts,
  storage = browserStorage(),
) {
  if (!storage) return;
  try {
    storage.setItem(WORKSPACE_KEY, JSON.stringify({
      version: 1,
      output: isMobileInpaintOutputSize(drafts.output) ? drafts.output : DEFAULT_WORKSPACE.output,
      customOutputs: normalizeCustomOutputs(drafts.customOutputs),
    }));
  } catch { /* Workspace preferences must never block the canvas. */ }
}

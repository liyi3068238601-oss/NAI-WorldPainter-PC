import { create } from "zustand";
import type { WorkingImage } from "./types";
import type { MobileLayer, MobilePixels, MobileRect, MobileStroke, MobileTransform } from "./mobile-inpaint";
import { isMobileInpaintOutputSize, loadMobileInpaintPromptDrafts, loadMobileInpaintWorkspaceDrafts, saveMobileInpaintPromptDrafts, saveMobileInpaintWorkspaceDrafts } from "./mobile-inpaint-draft-storage";

export interface MobileCandidate {
  id: string;
  batchId: string;
  image: MobilePixels;
  worldRect: MobileRect;
  dataUrl?: string;
  beforeUrl?: string;
  generatedUrl?: string;
  seed?: number;
  mask?: MobilePixels;
  base?: MobilePixels;
}
export interface MobileResultLayer extends MobileLayer {
  id: string;
  batchId: string;
  name: string;
  dataUrl: string;
}
type Size = { width: number; height: number };
export type MobileTool = "view" | "frame" | "image" | "brush" | "erase";
interface MobileInpaintState {
  mode: "legacy" | "mobile";
  source: WorkingImage | null;
  pixels: MobilePixels | null;
  frame: MobileRect;
  transform: MobileTransform;
  viewport: Size;
  output: Size;
  customOutputs: Size[];
  strokes: MobileStroke[];
  layers: MobileResultLayer[];
  candidates: MobileCandidate[];
  selectedCandidateId: string | null;
  reviewOpen: boolean;
  tool: MobileTool;
  target: "mask" | "image";
  brushSize: number;
  brushColor: string;
  squareBrush: boolean;
  showMask: boolean;
  expand: number;
  outwardFeather: number;
  scope: "region" | "full";
  prompt: string;
  negative: string;
  strength: number;
  noise: number;
  ignoreSource: boolean;
  colorCorrection: boolean;
  busy: boolean;
  error: string;
  undoStack: MobileStroke[][];
  redoStack: MobileStroke[][];
  maskUndoStack: MobileStroke[][];
  maskRedoStack: MobileStroke[][];
  update: (patch: Partial<MobileInpaintState>) => void;
  importSource: (image: WorkingImage) => Promise<void>;
  setOutput: (output: Size) => void;
  addCustomOutput: (output: Size) => boolean;
  setViewport: (viewport: Size) => void;
  setCandidates: (candidates: MobileCandidate[]) => void;
  checkpoint: () => void;
  undo: () => void;
  redo: () => void;
  undoMask: () => void;
  redoMask: () => void;
  clearStrokes: (target?: "mask" | "image") => void;
  resetFrame: () => void;
  fit: () => void;
  zoom: (factor: number, anchor?: { x: number; y: number }) => void;
  pan: (dx: number, dy: number, global?: boolean) => void;
  snap: () => void;
  scaleImage: (factor: 2 | 3) => Promise<void>;
  applyCandidate: (id: string) => void;
  removeLayer: (id: string) => void;
  toggleLayer: (id: string) => void;
  discardCandidate: (id: string) => void;
}

export function pixelsToDataUrl(pixels: MobilePixels): string {
  const canvas = document.createElement("canvas");
  canvas.width = pixels.width;
  canvas.height = pixels.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw Error("图像画布不可用。");
  const image = ctx.createImageData(pixels.width, pixels.height);
  image.data.set(pixels.data);
  ctx.putImageData(image, 0, 0);
  return canvas.toDataURL("image/png");
}

export async function decodeMobilePixels(url: string): Promise<MobilePixels> {
  const image = new Image();
  image.crossOrigin = "anonymous";
  image.src = url;
  await image.decode();
  const width = image.naturalWidth, height = image.naturalHeight;
  if (width <= 0 || height <= 0 || width * height > 32 * 1024 * 1024) {
    throw Error("图片尺寸无效或超过 32 MP 工作区限制。");
  }
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw Error("图像画布不可用。");
  ctx.drawImage(image, 0, 0);
  return { width, height, data: ctx.getImageData(0, 0, width, height).data };
}

const centeredFrame = (source: Size, output: Size, transform: MobileTransform): MobileRect => ({
  x: transform.offsetX + (source.width - output.width) * transform.scale / 2,
  y: transform.offsetY + (source.height - output.height) * transform.scale / 2,
  width: output.width * transform.scale,
  height: output.height * transform.scale,
});
function fitted(source: Size, output: Size, viewport: Size) {
  const scale = Math.max(0.05, Math.min(viewport.width * 0.9 / source.width, viewport.height * 0.9 / source.height, 12));
  const transform = { scale, offsetX: (viewport.width - source.width * scale) / 2, offsetY: (viewport.height - source.height * scale) / 2 };
  return { transform, frame: centeredFrame(source, output, transform) };
}
const nearestSnap = (offsets: number[]) => offsets.filter(n => Math.abs(n) <= 8).sort((a, b) => Math.abs(a) - Math.abs(b))[0] ?? 0;
const sameStrokes = (a: MobileStroke[], b: MobileStroke[]) => a.length === b.length && a.every((stroke, index) => stroke === b[index]);
let sourceRevision = 0;
const promptDrafts = loadMobileInpaintPromptDrafts();
const workspaceDrafts = loadMobileInpaintWorkspaceDrafts();

export const useMobileInpaintStore = create<MobileInpaintState>((set, get) => ({
  mode: "legacy", source: null, pixels: null,
  frame: { x: 0, y: 0, width: 512, height: 512 },
  transform: { scale: 1, offsetX: 0, offsetY: 0 },
  viewport: { width: 600, height: 500 }, output: workspaceDrafts.output, customOutputs: workspaceDrafts.customOutputs,
  strokes: [], layers: [], candidates: [], selectedCandidateId: null, reviewOpen: false,
  tool: "view", target: "mask", brushSize: 48, brushColor: "#ff4d4f", squareBrush: false,
  showMask: true, expand: 8, outwardFeather: 8,
  scope: "region", prompt: promptDrafts.prompt, negative: promptDrafts.negative, strength: 0.96, noise: 0,
  ignoreSource: false, colorCorrection: true, busy: false, error: "",
  undoStack: [], redoStack: [], maskUndoStack: [], maskRedoStack: [],
  update: patch => set(state => {
    const next = { ...patch };
    if (patch.tool === "brush" || patch.tool === "erase") next.showMask = true;
    if (Object.prototype.hasOwnProperty.call(patch, "prompt") || Object.prototype.hasOwnProperty.call(patch, "negative")) {
      saveMobileInpaintPromptDrafts({
        prompt: typeof patch.prompt === "string" ? patch.prompt : state.prompt,
        negative: typeof patch.negative === "string" ? patch.negative : state.negative,
      });
    }
    return next;
  }),
  async importSource(source) {
    if (get().busy) return;
    const revision = ++sourceRevision;
    set({ error: "", busy: true });
    try {
      const pixels = await decodeMobilePixels(source.fileUrl);
      if (revision !== sourceRevision) return;
      const state = get();
      set({ source: { ...source, width: pixels.width, height: pixels.height }, pixels,
        ...fitted(pixels, state.output, state.viewport), strokes: [], layers: [], candidates: [],
        selectedCandidateId: null, reviewOpen: false, undoStack: [], redoStack: [], maskUndoStack: [], maskRedoStack: [],
        showMask: true, tool: "view", busy: false });
    } catch (error) { if (revision === sourceRevision) set({ busy: false, error: String((error as Error).message) }); }
  },
  setOutput(output) {
    const state = get();
    if (state.busy || !isMobileInpaintOutputSize(output)) return;
    const frame = state.frame, height = frame.width * output.height / output.width;
    set({ output, frame: { ...frame, y: frame.y + (frame.height - height) / 2, height } });
    saveMobileInpaintWorkspaceDrafts({ output, customOutputs: state.customOutputs });
  },
  addCustomOutput(output) {
    const state = get();
    if (!isMobileInpaintOutputSize(output) || state.customOutputs.some(item => item.width === output.width && item.height === output.height)) return false;
    const customOutputs = [...state.customOutputs, { width: output.width, height: output.height }];
    set({ customOutputs });
    saveMobileInpaintWorkspaceDrafts({ output: state.output, customOutputs });
    return true;
  },
  setViewport(viewport) {
    const old = get().viewport;
    if (old.width === viewport.width && old.height === viewport.height) return;
    const { frame, transform, pixels } = get();
    if (pixels && old.width === 600 && old.height === 500) set({ viewport, ...fitted(pixels, get().output, viewport) });
    else set({ viewport, frame: { ...frame, x: frame.x + (viewport.width - old.width) / 2, y: frame.y + (viewport.height - old.height) / 2 },
      transform: { ...transform, offsetX: transform.offsetX + (viewport.width - old.width) / 2, offsetY: transform.offsetY + (viewport.height - old.height) / 2 } });
  },
  setCandidates(candidates) {
    const normalized = candidates.map(candidate => ({ ...candidate, dataUrl: candidate.dataUrl || pixelsToDataUrl(candidate.image) }));
    set({ candidates: normalized, selectedCandidateId: normalized.at(-1)?.id ?? null, reviewOpen: normalized.length > 0 });
  },
  checkpoint() {
    const { strokes, undoStack, maskUndoStack, target } = get();
    set({ undoStack: [...undoStack.slice(-59), strokes], redoStack: [],
      ...(target === "mask" ? { maskUndoStack: [...maskUndoStack.slice(-79), strokes.filter(s => s.target === "mask")], maskRedoStack: [] } : {}) });
  },
  undo() {
    const state = get();
    if (state.busy || !state.undoStack.length) return;
    const previous = state.undoStack.at(-1)!, before = state.strokes.filter(s => s.target === "mask"), after = previous.filter(s => s.target === "mask");
    set({ strokes: previous, undoStack: state.undoStack.slice(0, -1), redoStack: [...state.redoStack, state.strokes],
      ...(!sameStrokes(before, after) ? { maskRedoStack: [...state.maskRedoStack.slice(-79), before], maskUndoStack: [...state.maskUndoStack.slice(-79), after] } : {}) });
  },
  redo() {
    const state = get();
    if (state.busy || !state.redoStack.length) return;
    const next = state.redoStack.at(-1)!, before = state.strokes.filter(s => s.target === "mask"), after = next.filter(s => s.target === "mask");
    set({ strokes: next, redoStack: state.redoStack.slice(0, -1), undoStack: [...state.undoStack, state.strokes],
      ...(!sameStrokes(before, after) ? { maskUndoStack: [...state.maskUndoStack.slice(-79), before], maskRedoStack: [...state.maskRedoStack.slice(-79), after] } : {}) });
  },
  undoMask() {
    const state = get();
    if (state.busy || !state.maskUndoStack.length) return;
    const current = state.strokes.filter(s => s.target === "mask"), stack = [...state.maskUndoStack]; let target = stack.pop()!;
    while (stack.length && sameStrokes(current, target)) target = stack.pop()!;
    set({ maskUndoStack: stack, ...(!sameStrokes(current, target) ? { strokes: [...state.strokes.filter(s => s.target !== "mask"), ...target], maskRedoStack: [...state.maskRedoStack.slice(-79), current] } : {}) });
  },
  redoMask() {
    const state = get();
    if (state.busy || !state.maskRedoStack.length) return;
    const current = state.strokes.filter(s => s.target === "mask"), stack = [...state.maskRedoStack]; let target = stack.pop()!;
    while (stack.length && sameStrokes(current, target)) target = stack.pop()!;
    set({ maskRedoStack: stack, ...(!sameStrokes(current, target) ? { strokes: [...state.strokes.filter(s => s.target !== "mask"), ...target], maskUndoStack: [...state.maskUndoStack.slice(-79), current] } : {}) });
  },
  clearStrokes(target) {
    const state = get();
    if (state.busy || !state.strokes.length) return;
    state.checkpoint();
    set({ strokes: target ? state.strokes.filter(s => s.target !== target) : [],
      ...(!target && state.target !== "mask" && state.strokes.some(s => s.target === "mask") ? { maskUndoStack: [...state.maskUndoStack.slice(-79), state.strokes.filter(s => s.target === "mask")], maskRedoStack: [] } : {}) });
  },
  resetFrame() { const state = get(); if (state.pixels && !state.busy) set({ frame: centeredFrame(state.pixels, state.output, state.transform) }); },
  fit() { const state = get(); if (state.pixels && !state.busy) set(fitted(state.pixels, state.output, state.viewport)); },
  zoom(factor, anchor) {
    const state = get();
    if (!state.pixels || state.busy) return;
    const point = anchor ?? (state.tool === "frame" ? { x: state.frame.x + state.frame.width / 2, y: state.frame.y + state.frame.height / 2 } : { x: state.viewport.width / 2, y: state.viewport.height / 2 });
    const patch: Partial<MobileInpaintState> = {};
    if (state.tool !== "frame") {
      const scale = Math.max(0.05, Math.min(12, state.transform.scale * factor));
      patch.transform = { scale, offsetX: point.x - (point.x - state.transform.offsetX) * scale / state.transform.scale, offsetY: point.y - (point.y - state.transform.offsetY) * scale / state.transform.scale };
    }
    if (state.tool === "view" || state.tool === "frame") {
      const width = Math.min(8192, Math.max(48, state.frame.width * factor)), height = width * state.output.height / state.output.width;
      const cx = point.x + (state.frame.x + state.frame.width / 2 - point.x) * factor;
      const cy = point.y + (state.frame.y + state.frame.height / 2 - point.y) * factor;
      patch.frame = { x: cx - width / 2, y: cy - height / 2, width, height };
    }
    set(patch);
  },
  pan(dx, dy, global) {
    const state = get();
    if (!state.pixels || state.busy) return;
    if (state.tool === "frame" && !global) set({ frame: { ...state.frame, x: state.frame.x + dx, y: state.frame.y + dy } });
    else set({ transform: { ...state.transform, offsetX: state.transform.offsetX + dx, offsetY: state.transform.offsetY + dy },
      ...(state.tool === "view" || global ? { frame: { ...state.frame, x: state.frame.x + dx, y: state.frame.y + dy } } : {}) });
  },
  snap() {
    const state = get(); if (!state.pixels) return;
    const { frame: box, transform: t, pixels: p } = state;
    const left = t.offsetX, right = left + p.width * t.scale, top = t.offsetY, bottom = top + p.height * t.scale;
    if (state.tool === "frame") set({ frame: { ...box,
      x: box.x + nearestSnap([left - box.x, right - box.x - box.width, left - box.x - box.width, right - box.x]),
      y: box.y + nearestSnap([top - box.y, bottom - box.y - box.height, top - box.y - box.height, bottom - box.y]) } });
    else if (state.tool === "image") set({ transform: { ...t,
      offsetX: t.offsetX + nearestSnap([box.x - left, box.x + box.width - right, box.x - right, box.x + box.width - left]),
      offsetY: t.offsetY + nearestSnap([box.y - top, box.y + box.height - bottom, box.y - bottom, box.y + box.height - top]) } });
  },
  async scaleImage(factor) {
    const state = get(); if (!state.pixels || !state.source || state.busy) return;
    const width = state.pixels.width * factor, height = state.pixels.height * factor;
    if (width * height > 32 * 1024 * 1024) { set({ error: "放大后的图片超过 32 MP 工作区限制。" }); return; }
    set({ busy: true, error: "" });
    try {
      const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext("2d"); if (!ctx) throw Error("图像画布不可用。");
      const source = new Image(); source.src = pixelsToDataUrl(state.pixels); await source.decode();
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high"; ctx.drawImage(source, 0, 0, width, height);
      const dataUrl = canvas.toDataURL("image/png");
      const pixels = { width, height, data: ctx.getImageData(0, 0, width, height).data };
      set({ source: { ...state.source, fileUrl: dataUrl, width, height }, pixels, ...fitted(pixels, state.output, state.viewport),
        strokes: [], layers: [], candidates: [], reviewOpen: false, selectedCandidateId: null,
        undoStack: [], redoStack: [], maskUndoStack: [], maskRedoStack: [], busy: false });
    } catch (error) { set({ busy: false, error: (error as Error).message }); }
  },
  applyCandidate(id) {
    const state = get(), candidate = state.candidates.find(c => c.id === id);
    if (!candidate || state.busy || state.layers.some(l => l.id === id)) return;
    const index = state.layers.findIndex(l => l.batchId === candidate.batchId);
    const name = index < 0 ? `重绘 ${state.layers.length + 1}` : state.layers[index].name;
    const layers = state.layers.filter(l => l.batchId !== candidate.batchId);
    layers.splice(index < 0 ? layers.length : index, 0, { id, batchId: candidate.batchId, name, image: candidate.image,
      worldRect: { ...candidate.worldRect }, visible: true, dataUrl: candidate.dataUrl || pixelsToDataUrl(candidate.image) });
    set({ layers, reviewOpen: false, showMask: false, tool: "view" });
  },
  removeLayer(id) { if (!get().busy) set({ layers: get().layers.filter(l => l.id !== id) }); },
  toggleLayer(id) { if (!get().busy) set({ layers: get().layers.map(l => l.id === id ? { ...l, visible: !l.visible } : l) }); },
  discardCandidate(id) {
    const state = get(); if (state.busy || state.layers.some(l => l.id === id)) return;
    const candidates = state.candidates.filter(c => c.id !== id);
    set({ candidates, selectedCandidateId: candidates.at(-1)?.id ?? null, reviewOpen: candidates.length > 0 && state.reviewOpen });
  },
}));

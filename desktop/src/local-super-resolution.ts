export const LOCAL_SR_MAX_PIXELS = 32 * 1024 * 1024;
export const LOCAL_SR_MAX_INPUT_BYTES = 64 * 1024 * 1024;
export const LOCAL_SR_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export const LOCAL_SR_MODELS = [
  {
    id: "realesrganAnime4x",
    label: "Real-ESRGAN Anime 4×",
    engine: "realesrgan",
    scale: 4,
  },
  {
    id: "realcuganConservative2x",
    label: "Real-CUGAN 保守 2×",
    engine: "realcugan",
    scale: 2,
  },
  {
    id: "realcuganConservative4x",
    label: "Real-CUGAN 保守 4×",
    engine: "realcugan",
    scale: 4,
  },
] as const;

export type LocalSrModelId = (typeof LOCAL_SR_MODELS)[number]["id"];

export interface LocalSrRuntimeStatus {
  available: boolean;
  runtimeRoot: string | null;
  configuredByUser: boolean;
  models: LocalSrModelId[];
  reason?: string;
}

export interface LocalSrSourceSelection {
  selectionId: string;
  fileName: string;
  width: number;
  height: number;
  bytes: number;
  previewUrl: string;
}

export interface LocalSrProgress {
  message: string;
  percent: number;
}

export type LocalSrRunResult =
  | { ok: true; outputPath: string; outputUrl: string; fileName: string; width: number; height: number; modelId: LocalSrModelId }
  | { ok: false; cancelled?: boolean; message: string };

export interface LocalSrPlan {
  modelId: LocalSrModelId;
  modelLabel: string;
  scale: 2 | 4;
  inputWidth: number;
  inputHeight: number;
  inputPixels: number;
  outputWidth: number;
  outputHeight: number;
  outputPixels: number;
  withinPixelLimit: boolean;
}

export function getLocalSrModel(modelId: string) {
  return LOCAL_SR_MODELS.find((model) => model.id === modelId) ?? null;
}

export function planLocalSuperResolution(
  width: number,
  height: number,
  modelId: string,
): LocalSrPlan {
  const model = getLocalSrModel(modelId);
  if (!model) throw new TypeError("Unsupported local super-resolution model.");
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
    throw new TypeError("Image dimensions must be positive integers.");
  }
  const inputPixels = width * height;
  const outputWidth = width * model.scale;
  const outputHeight = height * model.scale;
  const outputPixels = outputWidth * outputHeight;
  return {
    modelId: model.id,
    modelLabel: model.label,
    scale: model.scale,
    inputWidth: width,
    inputHeight: height,
    inputPixels,
    outputWidth,
    outputHeight,
    outputPixels,
    withinPixelLimit: inputPixels <= LOCAL_SR_MAX_PIXELS && outputPixels <= LOCAL_SR_MAX_PIXELS,
  };
}

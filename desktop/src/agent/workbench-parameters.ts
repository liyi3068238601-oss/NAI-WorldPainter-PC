import {
  DEFAULT_I2I_PARAMS,
  MAX_NAI_SEED,
  NAI_MODELS,
  NAI_SAMPLERS,
  effectiveNAIEffortParams,
  isNAIV4PlusModel,
  isNAIV5Model,
  isNAIMediumEffort,
  maxNAICharacterPrompts,
  normalizeGenerateParams,
  supportsNAIMediumEffort,
  supportsNAIModelMode,
  supportsNAINoiseScheduleControl,
  supportsNAIPreciseReference,
  supportsNAIVariety,
  supportsNAIVibeTransfer,
  type GenerateParams,
  type I2IParams,
  type ModelMode,
} from "../types";
import {
  adaptiveNAIImageSize,
  isNAIImageSize,
  NAI_MAX_DIMENSION,
  NAI_DIMENSION_STEP,
  NAI_MAX_PIXEL_AREA,
} from "../nai-dimensions";
import type { R4WorkbenchSnapshot } from "./r4-workbench-contract";
import { normalizeMetadataReplay } from "../metadata-replay";

/**
 * Parameter-only fields an assistant may propose for the live Generate
 * workbench. Prompt text and source/reference bindings have separate contracts.
 */
export const WORKBENCH_PARAMETER_KEYS = [
  "model",
  "effort",
  "width",
  "height",
  "steps",
  "cfgScale",
  "cfgRescale",
  "sampler",
  "noiseSchedule",
  "seed",
  "seedMode",
  "batchCount",
  "batchIntervalSeconds",
  "ucPreset",
  "qualityPreset",
  "transparentBackground",
  "smea",
  "smeaDyn",
  "variety",
  "strength",
  "i2iSizeMode",
] as const;

type WorkbenchParameterKey = (typeof WORKBENCH_PARAMETER_KEYS)[number];
type GenerateParameterKey = Exclude<
  WorkbenchParameterKey,
  "batchCount" | "batchIntervalSeconds" | "strength" | "i2iSizeMode"
>;
type ImageProvider = "novelai" | "openai-images";
type SupportedMode = "generate:t2i" | "generate:i2i";

const PARAMETER_KEYS = WORKBENCH_PARAMETER_KEYS.filter(
  (key): key is GenerateParameterKey =>
    key !== "batchCount" && key !== "batchIntervalSeconds"
    && key !== "strength" && key !== "i2iSizeMode",
);

const MAX_BATCH_COUNT = 999;
const MAX_ASSISTANT_GENERATION_COUNT = 8;
const MAX_BATCH_INTERVAL_SECONDS = 3600;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function supportedMode(snapshot: R4WorkbenchSnapshot): SupportedMode | undefined {
  const mode = snapshot.workbench?.mode;
  return mode === "generate:t2i" || mode === "generate:i2i" ? mode : undefined;
}

function provider(snapshot: R4WorkbenchSnapshot): ImageProvider | undefined {
  const value = snapshot.workbench?.imageProvider as unknown;
  if (value === undefined || value === "novelai") return "novelai";
  return value === "openai-images" ? "openai-images" : undefined;
}

function modelMode(snapshot: R4WorkbenchSnapshot): ModelMode | undefined {
  const value = snapshot.workbench?.modelMode;
  if (value === undefined || value === "anime") return "anime";
  return value === "furry" ? "furry" : undefined;
}

function rawParams(snapshot: R4WorkbenchSnapshot): Record<string, unknown> {
  return isRecord(snapshot.params) ? snapshot.params : {};
}

function workbenchSettings(snapshot: R4WorkbenchSnapshot): Record<string, unknown> {
  return isRecord(snapshot.workbench) ? snapshot.workbench : {};
}

function validPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value));
}

function safeCurrentParameters(snapshot: R4WorkbenchSnapshot): Record<string, unknown> {
  const params = rawParams(snapshot);
  const workbench = workbenchSettings(snapshot);
  const output: Record<string, unknown> = {};

  for (const key of PARAMETER_KEYS) {
    const value = params[key];
    if (validPrimitive(value)) output[key] = value;
  }

  const batchCount = workbench.batchCount;
  output.batchCount = Number.isSafeInteger(batchCount) ? batchCount : 1;
  const interval = workbench.batchIntervalSeconds;
  output.batchIntervalSeconds = Number.isSafeInteger(interval) ? interval : 0;

  if (supportedMode(snapshot) === "generate:i2i") {
    const i2i = isRecord(workbench.i2iParams) ? workbench.i2iParams : {};
    const strength = i2i.strength;
    output.strength = typeof strength === "number" && Number.isFinite(strength)
      ? strength
      : DEFAULT_I2I_PARAMS.strength;
    output.i2iSizeMode = workbench.i2iSizeMode === "custom" ? "custom" : "adaptive";
  }

  return output;
}

/** Return only non-secret scalar parameter state; never expose paths or image bytes. */
export function workbenchParameters(snapshot: R4WorkbenchSnapshot): Record<string, unknown> {
  return safeCurrentParameters(snapshot);
}

function effectiveParams(snapshot: R4WorkbenchSnapshot): GenerateParams {
  const normalized = normalizeGenerateParams(
    rawParams(snapshot) as Partial<GenerateParams>,
  );
  const effective = effectiveNAIEffortParams(normalized) as GenerateParams;
  const mode = supportedMode(snapshot);
  const workbench = workbenchSettings(snapshot);
  if (
    mode === "generate:i2i"
    && workbench.i2iSizeMode === "adaptive"
    && isRecord(workbench.source)
    && typeof workbench.source.width === "number"
    && typeof workbench.source.height === "number"
    && workbench.source.width > 0
    && workbench.source.height > 0
  ) {
    return {
      ...effective,
      ...adaptiveNAIImageSize(
        workbench.source.width,
        workbench.source.height,
        effective,
      ),
    };
  }
  return effective;
}

function effectiveMetadataReplay(snapshot: R4WorkbenchSnapshot) {
  const params = normalizeGenerateParams(rawParams(snapshot) as Partial<GenerateParams>);
  const effective = effectiveNAIEffortParams(params);
  const replay = normalizeMetadataReplay(rawParams(snapshot).metadataReplay);
  return !isNAIMediumEffort(effective) && replay?.model === effective.model ? replay : undefined;
}

function effectiveParameterProjection(snapshot: R4WorkbenchSnapshot): Record<string, unknown> {
  const params = effectiveParams(snapshot);
  const baseModel = normalizeGenerateParams(rawParams(snapshot) as Partial<GenerateParams>).model;
  const current = safeCurrentParameters(snapshot);
  const replay = effectiveMetadataReplay(snapshot);
  const v5 = isNAIV5Model(baseModel);
  const legacyModel = !isNAIV4PlusModel(baseModel);
  const effectiveEffort = supportsNAIMediumEffort(baseModel)
    && params.effort === "medium"
    ? "medium"
    : "high";

  return {
    model: params.model,
    effort: effectiveEffort,
    width: params.width,
    height: params.height,
    steps: params.steps,
    cfgScale: params.cfgScale,
    cfgRescale: params.cfgRescale,
    sampler: params.sampler,
    noiseSchedule: v5 ? "karras" : params.noiseSchedule,
    seed: params.seed,
    seedMode: params.seedMode,
    batchCount: current.batchCount,
    batchIntervalSeconds: current.batchIntervalSeconds,
    ucPreset: params.ucPreset,
    qualityPreset: params.qualityPreset,
    transparentBackground: v5 && (typeof replay?.parameters.straight_alpha === "boolean"
      ? replay.parameters.straight_alpha
      : params.transparentBackground),
    smea: legacyModel && params.smea,
    smeaDyn: legacyModel && params.smea && params.smeaDyn,
    variety: supportsNAIVariety(baseModel) && params.variety,
    ...(supportedMode(snapshot) === "generate:i2i"
      ? {
          strength: current.strength,
          i2iSizeMode: current.i2iSizeMode,
        }
      : {}),
  };
}

function editableFields(snapshot: R4WorkbenchSnapshot): WorkbenchParameterKey[] {
  const mode = supportedMode(snapshot);
  const params = normalizeGenerateParams(rawParams(snapshot) as Partial<GenerateParams>);
  const model = params.model;
  const result: WorkbenchParameterKey[] = WORKBENCH_PARAMETER_KEYS.filter((key) =>
    mode === "generate:i2i" || (key !== "strength" && key !== "i2iSizeMode"),
  ) as WorkbenchParameterKey[];

  if (!supportsNAIMediumEffort(model)) remove(result, "effort");
  if (params.effort === "medium" && supportsNAIMediumEffort(model)) {
    remove(result, "steps");
    remove(result, "sampler");
    remove(result, "cfgRescale");
    remove(result, "ucPreset");
  }
  if (!supportsNAINoiseScheduleControl(model)) remove(result, "noiseSchedule");
  if (!isNAIV5Model(model)) remove(result, "transparentBackground");
  if (!supportsNAIVariety(model)) remove(result, "variety");
  if (isNAIV4PlusModel(model)) {
    remove(result, "smea");
    remove(result, "smeaDyn");
  }
  return result;
}

function remove<T>(values: T[], value: T) {
  const index = values.indexOf(value);
  if (index >= 0) values.splice(index, 1);
}

export interface WorkbenchParameterControls {
  writeSupported: boolean;
  reason?: string;
  editableFields: WorkbenchParameterKey[];
  parameters: Record<string, unknown>;
  effectiveParameters: Record<string, unknown>;
  metadataReplayOverrides?: Record<string, boolean | number | string | null>;
  limits: {
    dimensionStep: number;
    maxPixelArea: number;
    maxBatchCount: number;
    maxAssistantGenerationCount: number;
  };
  models: Array<{ value: string; label: string }>;
}

function unsupportedReason(snapshot: R4WorkbenchSnapshot): string | undefined {
  const selectedProvider = provider(snapshot);
  if (selectedProvider === "openai-images") {
    return "当前图片服务使用 OpenAI Images 参数契约；不能用 NovelAI 工作台参数写入。";
  }
  if (selectedProvider !== "novelai") {
    return "当前图片服务无法确认；未开放参数写入。";
  }
  if (!supportedMode(snapshot)) {
    return "参数写入仅支持当前文生图或图生图工作模式。";
  }
  if (!modelMode(snapshot)) {
    return "当前模型模式无效；请先在工作台选择 anime 或 furry。";
  }
  return undefined;
}

export function workbenchParameterControls(
  snapshot: R4WorkbenchSnapshot,
): WorkbenchParameterControls {
  const reason = unsupportedReason(snapshot);
  const mode = supportedMode(snapshot);
  const selectedMode = modelMode(snapshot) ?? "anime";
  const parameters = workbenchParameters(snapshot);
  const replayOverrides = reason ? undefined : effectiveMetadataReplay(snapshot)?.parameters;
  return {
    writeSupported: reason === undefined,
    ...(reason ? { reason } : {}),
    editableFields: reason || !mode ? [] : editableFields(snapshot),
    parameters,
    effectiveParameters: reason ? {} : effectiveParameterProjection(snapshot),
    ...(replayOverrides && Object.keys(replayOverrides).length > 0
      ? { metadataReplayOverrides: replayOverrides }
      : {}),
    limits: {
      dimensionStep: NAI_DIMENSION_STEP,
      maxPixelArea: NAI_MAX_PIXEL_AREA,
      maxBatchCount: MAX_BATCH_COUNT,
      maxAssistantGenerationCount: MAX_ASSISTANT_GENERATION_COUNT,
    },
    models: reason ? [] : NAI_MODELS
      .filter((item) => supportsNAIModelMode(item.value, selectedMode))
      .map(({ value, label }) => ({ value, label })),
  };
}

function fail(message: string): never {
  throw new Error(message);
}

function numeric(
  patch: Record<string, unknown>,
  key: WorkbenchParameterKey,
  min: number,
  max: number,
  integer = false,
): number | undefined {
  if (!hasOwn(patch, key)) return undefined;
  const value = patch[key];
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || value < min
    || value > max
    || (integer && !Number.isSafeInteger(value))
  ) {
    fail("工作台参数 " + key + " 必须是范围内的" + (integer ? "整数" : "有限数字") + "。");
  }
  return value;
}

function enumValue(
  patch: Record<string, unknown>,
  key: WorkbenchParameterKey,
  allowed: readonly unknown[],
  description: string,
): unknown {
  if (!hasOwn(patch, key)) return undefined;
  if (!allowed.includes(patch[key])) fail("工作台参数 " + key + " 必须是" + description + "。");
  return patch[key];
}

function booleanValue(patch: Record<string, unknown>, key: WorkbenchParameterKey): boolean | undefined {
  if (!hasOwn(patch, key)) return undefined;
  if (typeof patch[key] !== "boolean") fail("工作台参数 " + key + " 必须是布尔值。");
  return patch[key] as boolean;
}

function parsedGeneratePatch(
  patch: Record<string, unknown>,
): Partial<GenerateParams> {
  const result: Partial<GenerateParams> = {};
  const model = enumValue(patch, "model", NAI_MODELS.map(({ value }) => value), "支持目录中的模型");
  if (model !== undefined) result.model = model as GenerateParams["model"];
  const effort = enumValue(patch, "effort", ["medium", "high"], "medium 或 high");
  if (effort !== undefined) result.effort = effort as GenerateParams["effort"];

  const numericFields = [
    ["width", 64, NAI_MAX_DIMENSION, true],
    ["height", 64, NAI_MAX_DIMENSION, true],
    ["steps", 1, 50, true],
    ["cfgScale", 0, 10, false],
    ["cfgRescale", 0, 1, false],
    ["seed", 0, MAX_NAI_SEED, true],
    ["ucPreset", 0, 3, true],
  ] as const;
  for (const [key, min, max, integer] of numericFields) {
    const value = numeric(patch, key, min, max, integer);
    if (value !== undefined) Object.assign(result, { [key]: value });
  }

  const enumFields = [
    ["sampler", NAI_SAMPLERS.map(({ value }) => value), "支持目录中的采样器"],
    ["noiseSchedule", ["native", "karras", "exponential"], "native、karras 或 exponential"],
    ["seedMode", ["fixed", "random"], "fixed 或 random"],
    ["qualityPreset", ["standard", "light", "none"], "standard、light 或 none"],
  ] as const;
  for (const [key, allowed, description] of enumFields) {
    const value = enumValue(patch, key, allowed, description);
    if (value !== undefined) Object.assign(result, { [key]: value });
  }

  for (const key of ["transparentBackground", "smea", "smeaDyn", "variety"] as const) {
    const value = booleanValue(patch, key);
    if (value !== undefined) Object.assign(result, { [key]: value });
  }
  return result;
}

function validateChangedModelCapabilities(
  snapshot: R4WorkbenchSnapshot,
  model: GenerateParams["model"],
) {
  const chars = Array.isArray(snapshot.workbench?.charCaptions)
    ? snapshot.workbench!.charCaptions!
    : [];
  const activeCharacters = chars.filter((value) =>
    isRecord(value)
    && value.enabled !== false
    && typeof value.prompt === "string"
    && value.prompt.trim().length > 0,
  );
  if (activeCharacters.length > maxNAICharacterPrompts(model)) {
    fail(
      "模型 " + model + " 最多支持 "
        + maxNAICharacterPrompts(model)
        + " 条当前已启用角色提示；请先在工作台处理角色。未丢弃角色。",
    );
  }
  if ((snapshot.workbench?.vibeImages?.length ?? 0) > 0 && !supportsNAIVibeTransfer(model)) {
    fail("当前工作台仍有 Vibe 参考图，目标模型不支持；请先在工作台移除或切换模型。");
  }
  if ((snapshot.workbench?.preciseReferences?.length ?? 0) > 0 && !supportsNAIPreciseReference(model)) {
    fail("当前工作台仍有精准参考图，目标模型不支持；请先在工作台移除或切换模型。");
  }
}

function validateModelDependentFields(
  snapshot: R4WorkbenchSnapshot,
  patch: Record<string, unknown>,
  params: GenerateParams,
  parsed: Partial<GenerateParams>,
) {
  const previous = normalizeGenerateParams(rawParams(snapshot) as Partial<GenerateParams>);
  const modelChanged = parsed.model !== undefined && parsed.model !== previous.model;
  const touched = (key: GenerateParameterKey) => hasOwn(patch, key);
  const legacyModel = !isNAIV4PlusModel(params.model);
  const v5 = isNAIV5Model(params.model);
  if (parsed.model !== undefined) {
    const mode = modelMode(snapshot);
    if (!mode || !supportsNAIModelMode(params.model, mode)) {
      fail("模型与当前 anime/furry 模式不兼容；不会自动更改工作台模式。");
    }
  }

  if (!supportsNAIMediumEffort(params.model) && params.effort === "medium"
    && (touched("effort") || modelChanged)) {
    fail("Medium 档仅支持 NAI Diffusion V5 Full；切换模型时请同时设为 High。");
  }
  if (supportsNAIMediumEffort(params.model) && params.effort === "medium") {
    const fixed: Partial<Record<GenerateParameterKey, unknown>> = {
      steps: 14,
      sampler: "k_euler_ancestral",
      cfgRescale: 0,
      ucPreset: 0,
    };
    for (const [key, value] of Object.entries(fixed) as [GenerateParameterKey, unknown][]) {
      if (touched(key) && params[key] !== value) {
        fail("V5 Full Medium 固定 " + key + "=" + String(value) + "；该字段不会按其它值生效。");
      }
    }
  }

  if (v5 && params.noiseSchedule !== "karras" && (touched("noiseSchedule") || modelChanged)) {
    fail(touched("noiseSchedule")
      ? "V5 请求固定使用 karras 噪声计划；其它值不会生效。"
      : "切换到 V5 会使当前噪声计划失效；请在同一修改中明确设为 karras。");
  }
  if (touched("variety") && params.variety && !supportsNAIVariety(params.model)) {
    fail("当前模型不支持 Variety+。");
  }
  if (touched("smea") && params.smea && !legacyModel) {
    fail("SMEA 仅支持 NAI Diffusion 3 系列。");
  }
  if (touched("smeaDyn") && params.smeaDyn && !legacyModel) {
    fail("SMEA Dyn 仅支持 NAI Diffusion 3 系列。");
  }
  if (touched("smeaDyn") && params.smeaDyn && !params.smea) {
    fail("启用 SMEA Dyn 时必须同时启用 SMEA。");
  }
  if (touched("smea") && params.smea === false && params.smeaDyn) {
    fail("关闭 SMEA 时必须同时关闭 SMEA Dyn。");
  }
  if (touched("qualityPreset") && params.qualityPreset === "light" && !v5) {
    fail("Light 质量预设仅支持 V5。");
  }
  if (touched("transparentBackground") && params.transparentBackground && !v5) {
    fail("透明背景仅支持 V5。");
  }

  if (!modelChanged) return;
  validateChangedModelCapabilities(snapshot, params.model);

  const oldQuality = rawParams(snapshot).qualityPreset;
  const oldQualityPreset = oldQuality === "light"
    ? "light"
    : oldQuality === "none" || rawParams(snapshot).qualityToggle === false
      ? "none"
      : "standard";
  if (!isNAIV5Model(params.model)) {
    if (
      oldQualityPreset === "light"
      && (!touched("qualityPreset") || params.qualityPreset === "light")
    ) {
      fail("切换到非 V5 模型会清除当前 Light 质量预设；请在同一修改中明确设为 standard 或 none。");
    }
    if (
      rawParams(snapshot).transparentBackground === true
      && (!touched("transparentBackground") || params.transparentBackground)
    ) {
      fail("切换到非 V5 模型会关闭透明背景；请在同一修改中明确设为 false。");
    }
  }
  if (isNAIV5Model(params.model) && params.variety && !touched("variety")) {
    fail("切换到 V5 会使当前 Variety+ 无效；请在同一修改中明确设为 false。");
  }
  if (!legacyModel && (params.smea || params.smeaDyn)) {
    if (!touched("smea") || params.smea || !touched("smeaDyn") || params.smeaDyn) {
      fail("目标模型不支持当前 SMEA 设置；请在同一修改中明确关闭 SMEA 和 SMEA Dyn。");
    }
  }
}

function validateSize(params: GenerateParams, patch: Record<string, unknown>) {
  if ((hasOwn(patch, "width") || hasOwn(patch, "height")) && !isNAIImageSize(params)) {
    fail("宽高必须是 64 的倍数、至少 64，且总像素不超过 3,145,728。");
  }
}

function currentI2I(snapshot: R4WorkbenchSnapshot): I2IParams {
  const input = isRecord(snapshot.workbench?.i2iParams)
    ? snapshot.workbench!.i2iParams!
    : {};
  return {
    ...DEFAULT_I2I_PARAMS,
    ...(typeof input.upscaledEnhance === "boolean" ? { upscaledEnhance: input.upscaledEnhance } : {}),
    ...(typeof input.strength === "number" && Number.isFinite(input.strength)
      ? { strength: input.strength }
      : {}),
    ...(typeof input.noise === "number" && Number.isFinite(input.noise)
      ? { noise: input.noise }
      : {}),
    ...(typeof input.extraNoiseSeed === "number" && Number.isFinite(input.extraNoiseSeed)
      ? { extraNoiseSeed: input.extraNoiseSeed }
      : {}),
  };
}

/**
 * Strictly validate a parameter patch against the current workbench snapshot.
 * Only supplied fields are returned; callers remain responsible for CAS and
 * applying the partial patch to the renderer-owned store.
 */
export function prepareWorkbenchParameterPatch(
  snapshot: R4WorkbenchSnapshot,
  rawPatch: unknown,
): {
  params: Partial<GenerateParams>;
  workbench: {
    batchCount?: number;
    batchIntervalSeconds?: number;
    i2iParams?: I2IParams;
    i2iSizeMode?: "adaptive" | "custom";
  };
  changedFields: string[];
  parameters: Record<string, unknown>;
} {
  const reason = unsupportedReason(snapshot);
  if (reason) fail(reason);
  if (!isRecord(rawPatch)) fail("参数修改必须是对象。");
  const keys = Object.keys(rawPatch);
  if (keys.length === 0) fail("至少指定一个工作台参数。");
  for (const key of keys) {
    if (!(WORKBENCH_PARAMETER_KEYS as readonly string[]).includes(key)) {
      fail("工作台参数不支持独立修改字段 " + key + "。");
    }
  }

  const mode = supportedMode(snapshot)!;
  const current = normalizeGenerateParams(rawParams(snapshot) as Partial<GenerateParams>);
  const parsed = parsedGeneratePatch(rawPatch);
  const proposed: GenerateParams = { ...current, ...parsed };

  const requestedWidthOrHeight = hasOwn(rawPatch, "width") || hasOwn(rawPatch, "height");
  if (mode !== "generate:i2i" && (hasOwn(rawPatch, "strength") || hasOwn(rawPatch, "i2iSizeMode"))) {
    fail("strength 和 i2iSizeMode 仅可用于当前图生图工作模式。");
  }
  const i2iSizeMode = rawPatch.i2iSizeMode;
  if (hasOwn(rawPatch, "i2iSizeMode") && i2iSizeMode !== "adaptive" && i2iSizeMode !== "custom") {
    fail("i2iSizeMode 必须是 adaptive 或 custom。");
  }
  if (mode === "generate:i2i" && requestedWidthOrHeight
    && hasOwn(rawPatch, "i2iSizeMode") && i2iSizeMode !== "custom") {
    fail("明确设置图生图宽高时必须选择 custom 尺寸模式。");
  }

  const batchCount = numeric(rawPatch, "batchCount", 1, MAX_BATCH_COUNT, true);
  const batchIntervalSeconds = numeric(
    rawPatch,
    "batchIntervalSeconds",
    0,
    MAX_BATCH_INTERVAL_SECONDS,
    true,
  );
  const strength = numeric(rawPatch, "strength", 0, 1);
  validateSize(proposed, rawPatch);
  validateModelDependentFields(snapshot, rawPatch, proposed, parsed);

  const normalized = normalizeGenerateParams(proposed);
  for (const key of Object.keys(parsed) as GenerateParameterKey[]) {
    if (normalized[key] !== proposed[key]) {
      fail("工作台参数 " + key + " 会被标准化为其它值；请明确提供有效值。");
    }
  }

  const resultParams: Partial<GenerateParams> = { ...parsed };
  if (hasOwn(rawPatch, "qualityPreset")) {
    resultParams.qualityToggle = proposed.qualityPreset !== "none";
  }
  if (hasOwn(rawPatch, "seed") && !hasOwn(rawPatch, "seedMode")) {
    resultParams.seedMode = "fixed";
  }

  const resultWorkbench: {
    batchCount?: number;
    batchIntervalSeconds?: number;
    i2iParams?: I2IParams;
    i2iSizeMode?: "adaptive" | "custom";
  } = {};
  if (batchCount !== undefined) resultWorkbench.batchCount = batchCount;
  if (batchIntervalSeconds !== undefined) {
    resultWorkbench.batchIntervalSeconds = batchIntervalSeconds;
  }
  if (mode === "generate:i2i" && strength !== undefined) {
    resultWorkbench.i2iParams = { ...currentI2I(snapshot), strength };
  }
  if (mode === "generate:i2i" && (requestedWidthOrHeight || hasOwn(rawPatch, "i2iSizeMode"))) {
    resultWorkbench.i2iSizeMode = requestedWidthOrHeight
      ? "custom"
      : rawPatch.i2iSizeMode as "adaptive" | "custom";
  }
  const before = safeCurrentParameters(snapshot);
  const nextValues: Record<string, unknown> = { ...parsed };
  if (batchCount !== undefined) nextValues.batchCount = batchCount;
  if (batchIntervalSeconds !== undefined) nextValues.batchIntervalSeconds = batchIntervalSeconds;
  if (strength !== undefined) nextValues.strength = strength;
  if (resultWorkbench.i2iSizeMode !== undefined) nextValues.i2iSizeMode = resultWorkbench.i2iSizeMode;
  if (hasOwn(rawPatch, "seed") && !hasOwn(rawPatch, "seedMode")) nextValues.seedMode = "fixed";
  const changedFields = keys.filter((key) => before[key] !== nextValues[key]);
  if (!keys.includes("seedMode") && nextValues.seedMode === "fixed" && before.seedMode !== "fixed") {
    changedFields.push("seedMode");
  }
  if (!keys.includes("i2iSizeMode") && resultWorkbench.i2iSizeMode === "custom"
    && before.i2iSizeMode !== "custom") changedFields.push("i2iSizeMode");
  if (
    parsed.qualityPreset !== undefined
    && rawParams(snapshot).qualityToggle !== (proposed.qualityPreset !== "none")
  ) {
    changedFields.push("qualityToggle");
  }

  // Metadata replay is narrow and version-bound, but its allowed wire fields
  // can still override these specific controls. Remove only the overlapping
  // keys; preserve unrelated replay values and prompt flags.
  const replayKeysByParameter: Partial<Record<WorkbenchParameterKey, string[]>> = {
    cfgRescale: ["cfg_rescale", "dynamic_thresholding"],
    qualityPreset: ["quality_boost"],
    transparentBackground: ["straight_alpha"],
  };
  const oldReplay = rawParams(snapshot).metadataReplay;
  if (isRecord(oldReplay) && isRecord(oldReplay.parameters)) {
    const parametersToRemove = new Set<string>();
    for (const key of keys as WorkbenchParameterKey[]) {
      for (const replayKey of replayKeysByParameter[key] ?? []) {
        parametersToRemove.add(replayKey);
      }
    }
    const replayParameters = { ...oldReplay.parameters };
    for (const replayKey of parametersToRemove) {
      if (hasOwn(replayParameters, replayKey)) {
        delete replayParameters[replayKey];
        changedFields.push(`metadataReplay.parameters.${replayKey}`);
      }
    }
    if (parametersToRemove.size > 0) {
      resultParams.metadataReplay = { ...oldReplay, parameters: replayParameters } as GenerateParams["metadataReplay"];
    }
  }

  const parameters = { ...safeCurrentParameters(snapshot) };
  for (const key of PARAMETER_KEYS) parameters[key] = proposed[key];
  if (nextValues.seedMode !== undefined) parameters.seedMode = nextValues.seedMode;
  if (batchCount !== undefined) parameters.batchCount = batchCount;
  if (batchIntervalSeconds !== undefined) parameters.batchIntervalSeconds = batchIntervalSeconds;
  if (mode === "generate:i2i") {
    parameters.strength = resultWorkbench.i2iParams?.strength
      ?? safeCurrentParameters(snapshot).strength;
    parameters.i2iSizeMode = resultWorkbench.i2iSizeMode
      ?? safeCurrentParameters(snapshot).i2iSizeMode;
  }
  return {
    params: resultParams,
    workbench: resultWorkbench,
    changedFields: [...new Set(changedFields)],
    parameters,
  };
}

import { app, ipcMain, safeStorage, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import axios from 'axios';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MAX_NAI_SEED, isNAIV5Model, normalizeGenerateParams, normalizeNAIBaseModel, type GenerateParams, type HistoryItem, type MobileInpaintRequest, type ModelMode } from '../../src/types';
import type { GatewayMobileInpaintPlanRequest, GatewayPlanPreview, GatewayPlanRequest, GatewayProfileInput, GatewayProtocol, GatewayJobResult } from '../../src/gateway-workbench';
import { buildPayload } from './nai';
import { prepareMobileInpaintRequest } from './mobile-inpaint';
import { buildMobileInpaintGatewayRequest } from './mobile-inpaint-gateway-codec';
import { getSettings, addHistory } from './store';
import { toLocalMediaUrl } from './local-media-protocol';
import { proxyConfigForUrl } from './proxy';
import { validateImage, MAX_IMAGE_BYTES } from './image-codec';
import { writeUniqueImageFile } from './image-output';
import { buildGatewayGenerationRequest } from './gateway-generation-codec';
import { GatewayWorkbenchVault, gatewayCipherAvailable, type GatewayVaultDocument } from './gateway-workbench-vault';

interface GatewayPostResponse { status: number; data: unknown }
interface GatewayPostOptions { headers: Record<string, string>; timeout: number; signal: AbortSignal; maxRedirects: number }
interface GatewayWorkbenchDependencies {
  vault: GatewayWorkbenchVault;
  post: (url: string, payload: Record<string, unknown>, options: GatewayPostOptions, onSubmitted: () => void) => Promise<GatewayPostResponse>;
  outputDir: () => string;
  appendHistory: (item: HistoryItem) => void;
  now?: () => Date;
  randomSeed?: () => number;
}
interface PlannedRun {
  preview: GatewayPlanPreview;
  profileRevision: string;
  params: GenerateParams;
  /** Kept in the main process so large source/mask bytes are not echoed to the renderer. */
  requestPayload?: Record<string, unknown>;
  state: 'ready' | 'running' | 'cancelled' | 'finished';
  controller?: AbortController;
  submitted?: boolean;
  responseReceived?: boolean;
}

const MAX_PROMPT_CHARS = 30_000;
const PLAN_LIFETIME_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 180_000;
const GATEWAY_SAMPLERS: Record<GatewayProtocol, ReadonlySet<string>> = {
  gateway7877: new Set(['k_euler', 'k_euler_ancestral', 'k_dpm_2', 'k_dpm_2_ancestral', 'k_dpmpp_2m', 'k_dpmpp_2m_sde', 'k_dpmpp_2s_ancestral', 'k_dpmpp_sde', 'ddim']),
  ikun: new Set(['k_euler', 'k_euler_ancestral', 'k_dpmpp_2s_ancestral', 'k_dpmpp_2m', 'k_dpmpp_2m_sde', 'k_dpmpp_sde', 'ddim_v3']),
};

function protocolName(protocol: GatewayProtocol) { return protocol === 'gateway7877' ? '7877' : 'ikun'; }
function dateStamp(date: Date) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
function isObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function deepClone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

function validateDraftRequest(raw: GatewayPlanRequest): { profileId: string; params: GenerateParams; modelMode: ModelMode } {
  if (!isObject(raw) || typeof raw.profileId !== 'string' || !isObject(raw.draft) || JSON.stringify(raw).length > 1_000_000) {
    throw new Error('当前绘世文生图草稿无效，请回到工作台重新读取。');
  }
  const features = raw.features;
  if (raw.operation !== 'textToImage') {
    throw new Error('此入口只支持纯文生图；图生图与局部重绘必须回到绘世主工作台。');
  }
  if (features && (Number(features.characterPrompts) > 0 || Number(features.vibeReferences) > 0 || Number(features.preciseReferences) > 0)) {
    throw new Error('此网关工作台首版只执行纯文生图；请先移除角色提示、Vibe 或精准参考，或使用绘世官方工作台。');
  }
  const source = raw.draft as Partial<GenerateParams>;
  for (const key of ['stylePrompt', 'positivePrompt', 'negativePrompt'] as const) {
    if (typeof source[key] !== 'string' || source[key].length > MAX_PROMPT_CHARS) throw new Error('提示词为空或超过 30,000 字符。');
  }
  if (source.transparentBackground === true) throw new Error('当前网关工作台不支持透明背景生成，请关闭透明背景后再预览。');
  if (source.smea === true || source.smeaDyn === true) throw new Error('当前网关工作台不支持 SMEA；请关闭 SMEA 后再预览。');
  if (source.variety === true) throw new Error('当前网关工作台不支持 Variety+；请关闭后再预览。');
  if (source.effort === 'medium' || String(source.model ?? '').includes('-medium')) throw new Error('中等算力模式暂不支持网关；请切换到高算力后再预览。');
  if (source.metadataReplay) throw new Error('含导入参数回放的草稿暂不支持网关；请清除参数回放后再预览。');
  const params = normalizeGenerateParams(source);
  if (source.model !== params.model || source.sampler !== params.sampler || source.noiseSchedule !== params.noiseSchedule ||
      source.seedMode !== params.seedMode || source.width !== params.width || source.height !== params.height ||
      source.steps !== params.steps || source.cfgScale !== params.cfgScale || source.cfgRescale !== params.cfgRescale ||
      source.seed !== params.seed || source.ucPreset !== params.ucPreset) {
    throw new Error('当前草稿包含绘世已修复的参数值；请回到主工作台确认修复后的参数，再重新预览。');
  }
  if (params.transparentBackground) throw new Error('当前网关工作台不支持透明背景生成，请关闭透明背景后再预览。');
  if (params.smea || params.smeaDyn) throw new Error('当前网关工作台不支持 SMEA；请关闭 SMEA 后再预览。');
  if (params.variety) throw new Error('当前网关工作台不支持 Variety+；请关闭后再预览。');
  if (params.effort === 'medium') throw new Error('中等算力模式暂不支持网关；请切换到高算力后再预览。');
  if (params.qualityPreset !== 'standard') throw new Error('网关工作台首版只支持标准质量标签；请切换为“标准”。');
  if (params.metadataReplay) throw new Error('含导入参数回放的草稿暂不支持网关；请清除参数回放后再预览。');
  if (!params.positivePrompt.trim() && !params.stylePrompt.trim()) throw new Error('请先填写正向提示词。');
  const modelMode = raw.modelMode === 'furry' ? 'furry' : 'anime';
  return { profileId: raw.profileId, params, modelMode };
}

function decodedGatewayImage(data: unknown): Buffer {
  let body: unknown = data;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { throw new Error('网关已响应，但返回内容不是受支持的 JSON 图片结果。'); }
  }
  if (!isObject(body)) throw new Error('网关已响应，但图片结果格式无效。');
  const entries = Array.isArray(body.data) ? body.data : Array.isArray(body.images) ? body.images : [];
  const first = isObject(entries[0]) ? entries[0] : undefined;
  const encoded = first?.b64_json ?? first?.image ?? body.image;
  if (typeof encoded !== 'string' || !encoded.trim()) {
    if (typeof first?.url === 'string' || typeof first?.image_url === 'string') {
      throw new Error('网关已返回图片地址，但本版只接收 b64_json 图片；请核对服务端结果后再决定是否重试。');
    }
    throw new Error('网关已响应，但没有提供 b64_json 图片；请核对服务端结果后再决定是否重试。');
  }
  const base64 = encoded.trim().replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '');
  if (base64.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 8 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
    throw new Error('网关图片数据无效或超过 32 MiB；请核对服务端结果。');
  }
  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('网关图片为空或超过 32 MiB；请核对服务端结果。');
  return bytes;
}

class PartialHistoryFailure extends Error {
  constructor(readonly item: HistoryItem) { super('图片已保存，但绘世历史未能更新。'); }
}

async function persistGatewayImage(
  bytes: Buffer, params: GenerateParams, model: string, seed: number,
  outputDir: string, now: Date, appendHistory: (item: HistoryItem) => void,
  expectedSize?: { width: number; height: number },
): Promise<HistoryItem> {
  const image = await validateImage(bytes);
  if (expectedSize && (image.width !== expectedSize.width || image.height !== expectedSize.height)) {
    throw new GatewayOutputSizeMismatch(expectedSize, image);
  }
  const date = dateStamp(now);
  const directory = path.join(outputDir, date);
  await fs.promises.mkdir(directory, { recursive: true });
  const id = crypto.randomUUID();
  const prefix = params.fileNamePrefix.trim().replace(/[^\w.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 36);
  const name = `${prefix ? `${prefix}-` : ''}gateway-${date}-${seed}`;
  const filePath = await writeUniqueImageFile(directory, name, image.extension, bytes);
  const item: HistoryItem = {
    id, filePath, fileUrl: toLocalMediaUrl(filePath, id), date,
    createdAt: now.toISOString(), generatedAt: now.toISOString(), generatedAtSource: 'local-completion',
    generatedImageSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    params: { ...params, seed, seedMode: 'fixed' }, actualSeed: seed, model,
    width: image.width, height: image.height,
  };
  try { appendHistory(item); }
  catch { throw new PartialHistoryFailure(item); }
  return item;
}

class GatewayOutputSizeMismatch extends Error {
  constructor(expected: { width: number; height: number }, actual: { width: number; height: number }) {
    super(`网关返回 ${actual.width}×${actual.height} 图片，与本次重绘输出 ${expected.width}×${expected.height} 不一致；图片未保存。请核对网关记录后再决定是否重试。`);
  }
}

interface ValidatedMobileInpaintPlan {
  profileId: string;
  request: MobileInpaintRequest;
  model: string;
  prompt: string;
  negativePrompt: string;
  width: number;
  height: number;
  steps: number;
  scale: number;
  cfgRescale: number;
  sampler: string;
  noiseSchedule: string;
  seed: number;
  params: GenerateParams;
  imageBase64: string;
  maskBase64: string;
  strength: number;
}

function validateMobileInpaintPlan(raw: GatewayMobileInpaintPlanRequest, protocol: GatewayProtocol, randomSeed: () => number): ValidatedMobileInpaintPlan {
  if (!isObject(raw) || typeof raw.profileId !== 'string' || !isObject(raw.request)) {
    throw new Error('当前新版重绘请求无效，请回到工作区重新预览。');
  }
  const request = raw.request as MobileInpaintRequest;
  // This validates model, PNG inputs, source/mask dimensions and a non-empty mask
  // without consulting or inheriting the official NovelAI account snapshot.
  const prepared = prepareMobileInpaintRequest(request);
  const source = request.params as Partial<GenerateParams> | undefined;
  if (!isObject(source)) throw new Error('新版重绘参数无效，请回到工作区重新读取。');
  const prompt = typeof source.positivePrompt === 'string' ? source.positivePrompt.trim() : '';
  const negativePrompt = typeof source.negativePrompt === 'string' ? source.negativePrompt.trim() : '';
  if (!prompt || prompt.length > MAX_PROMPT_CHARS || negativePrompt.length > MAX_PROMPT_CHARS) {
    throw new Error('请填写正向重绘词，且正负提示词各不超过 30,000 字符。');
  }
  if (typeof source.stylePrompt === 'string' && source.stylePrompt.trim()) {
    throw new Error('新版重绘不使用文生图画师串；请清除画师串后重新预览。');
  }
  const width = prepared.width;
  const height = prepared.height;
  const model = request.model;
  const baseModel = normalizeNAIBaseModel(model);
  const v5 = isNAIV5Model(baseModel);
  // Keep only the inpaint input-safety bounds from prepareMobileInpaintRequest.
  // _generateInner's Ikun/V5 guards belong to the regular generation flow and
  // are bypassed by the phone's dedicated inpaint workspace pipeline.
  const steps = source.steps;
  const scale = source.cfgScale;
  const cfgRescale = source.cfgRescale;
  if (!Number.isInteger(steps) || (steps as number) < 1 || (steps as number) > (v5 ? 28 : 50) ||
      !Number.isFinite(scale) || (scale as number) < 0 || (scale as number) > 10 ||
      !Number.isFinite(cfgRescale) || (cfgRescale as number) < 0 || (cfgRescale as number) > 1) {
    throw new Error('新版重绘步数、CFG 或 CFG 重标定参数无效。');
  }
  if (typeof request.ignoreSource !== 'boolean' || typeof request.colorCorrection !== 'boolean') {
    throw new Error('新版重绘选项无效，请回到工作区重新预览。');
  }
  const rawSampler = request.sampling?.sampler ?? source.sampler;
  if (typeof rawSampler !== 'string' || !rawSampler.trim()) throw new Error('新版重绘采样器无效。');
  const sampler = rawSampler.trim().toLowerCase();
  const rawNoiseSchedule = request.sampling?.noiseSchedule ?? source.noiseSchedule;
  const noiseSchedule = typeof rawNoiseSchedule === 'string' ? rawNoiseSchedule.trim().toLowerCase() : '';
  const seedMode = source.seedMode;
  const sourceSeed = source.seed;
  const seed = seedMode === 'fixed'
    ? sourceSeed
    : seedMode === 'random' ? randomSeed() : undefined;
  if (!Number.isInteger(seed) || (seed as number) < 0 || (seed as number) > MAX_NAI_SEED) {
    throw new Error('新版重绘 Seed 无效。');
  }
  // Avoid the general image-size fitting used by normalizeGenerateParams: the
  // inpaint workspace owns its custom 64-pixel-multiple output dimensions.
  const normalized = normalizeGenerateParams({
    ...source,
    model: normalizeNAIBaseModel(model) as GenerateParams['model'],
    width,
    height,
    steps: steps as number,
    cfgScale: scale as number,
    cfgRescale: cfgRescale as number,
    sampler: sampler as GenerateParams['sampler'],
    noiseSchedule,
    positivePrompt: prompt,
    negativePrompt,
    stylePrompt: '',
    seed: seed as number,
    seedMode: 'fixed',
    metadataReplay: undefined,
    qualityPreset: 'none',
    qualityToggle: false,
    ucPreset: 3,
    transparentBackground: false,
    smea: false,
    smeaDyn: false,
    variety: false,
    effort: 'high',
    preservePromptText: true,
  });
  const params: GenerateParams = {
    ...normalized,
    model: normalizeNAIBaseModel(model) as GenerateParams['model'],
    width,
    height,
    steps: steps as number,
    cfgScale: scale as number,
    cfgRescale: cfgRescale as number,
    sampler: sampler as GenerateParams['sampler'],
    noiseSchedule,
    positivePrompt: prompt,
    negativePrompt,
    stylePrompt: '',
    seed: seed as number,
    seedMode: 'fixed',
  };
  return {
    profileId: raw.profileId,
    request,
    model,
    prompt,
    negativePrompt,
    width,
    height,
    steps: steps as number,
    scale: scale as number,
    cfgRescale: cfgRescale as number,
    sampler,
    noiseSchedule,
    seed: seed as number,
    params,
    imageBase64: prepared.imageBase64,
    maskBase64: prepared.maskBase64,
    strength: prepared.strength,
  };
}

/** Testable isolated gateway workbench service. It never reads a NovelAI account token. */
export class GatewayWorkbenchService {
  private readonly plans = new Map<string, PlannedRun>();
  private readonly now: () => Date;
  private readonly randomSeed: () => number;

  constructor(private readonly dependencies: GatewayWorkbenchDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.randomSeed = dependencies.randomSeed ?? (() => crypto.randomInt(0, MAX_NAI_SEED + 1));
  }

  listProfiles() { return this.dependencies.vault.list(); }
  addProfile(input: GatewayProfileInput) { return this.dependencies.vault.add(input); }
  selectProfile(id: unknown) { return this.dependencies.vault.select(id); }
  removeProfile(id: unknown) { return this.dependencies.vault.remove(id); }

  prepare(raw: GatewayPlanRequest): GatewayPlanPreview {
    this.expirePlans();
    const { profileId, params, modelMode } = validateDraftRequest(raw);
    const binding = this.dependencies.vault.bind(profileId);
    if (!binding.profile.selected) throw new Error('该网关档案尚未选中，请先选择后再预览。');
    if (!GATEWAY_SAMPLERS[binding.profile.protocol].has(params.sampler)) {
      throw new Error(`${protocolName(binding.profile.protocol)} 网关不支持采样器 ${params.sampler}；请在绘世工作台选择兼容采样器。`);
    }
    let noiseSchedule = params.noiseSchedule;
    if (binding.profile.protocol === 'gateway7877' && noiseSchedule === 'native') noiseSchedule = 'karras';
    if (binding.profile.protocol === 'gateway7877' && !['karras', 'exponential'].includes(noiseSchedule) ||
        binding.profile.protocol === 'ikun' && !['native', 'karras', 'exponential'].includes(noiseSchedule)) {
      throw new Error(`${protocolName(binding.profile.protocol)} 网关不支持噪声计划 ${noiseSchedule}。`);
    }
    const seed = params.seedMode === 'random' ? this.randomSeed() : params.seed;
    const normalized = { ...params, noiseSchedule, seed, seedMode: 'fixed' as const };
    const v5 = normalized.model.includes('diffusion-5');
    const pixels = normalized.width * normalized.height;
    if (normalized.width < 64 || normalized.height < 64 || normalized.width > 4096 || normalized.height > 4096 ||
        normalized.width % 64 !== 0 || normalized.height % 64 !== 0 || pixels > 4096 * 4096 ||
        normalized.steps < 1 || normalized.steps > (v5 ? 28 : 50) || normalized.cfgScale < 1 || normalized.cfgScale > 10) {
      throw new Error('当前图像尺寸或生成参数超出网关可用范围。');
    }
    if (binding.profile.protocol === 'ikun' && (normalized.width > 1600 || normalized.height > 1600)) {
      throw new Error('ikun 网关单边尺寸上限为 1600；请调整绘世画布尺寸。');
    }
    if (v5 && pixels > 1024 * 1024) throw new Error(`${protocolName(binding.profile.protocol)} 网关的 V5 尺寸上限为 1,048,576 像素。`);

    // Reuse the live workbench's prompt/quality projection, then freeze exactly
    // the request the user will review and explicitly confirm.
    const official = buildPayload(normalized, seed, { modelMode, charCaptions: [], vibeImages: [] });
    const parameters = official.parameters as Record<string, unknown>;
    const negativePrompt = typeof parameters.uc === 'string' ? parameters.uc : normalized.negativePrompt;
    const request = buildGatewayGenerationRequest({
      protocol: binding.profile.protocol,
      operation: 'textToImage',
      model: official.model,
      prompt: official.input,
      negativePrompt,
      width: Number(parameters.width),
      height: Number(parameters.height),
      steps: Number(parameters.steps),
      scale: Number(parameters.scale),
      cfgRescale: Number(parameters.cfg_rescale),
      sampler: String(parameters.sampler),
      noiseSchedule: String(parameters.noise_schedule),
      seed,
    });
    const endpoint = new URL(request.path, binding.profile.baseUrl).toString();
    const planId = crypto.randomUUID();
    const expiresAt = new Date(this.now().getTime() + PLAN_LIFETIME_MS).toISOString();
    const preview: GatewayPlanPreview = {
      planId, expiresAt, profileId, profileName: binding.profile.name,
      protocol: binding.profile.protocol, endpoint,
      model: official.model, prompt: official.input, negativePrompt,
      width: Number(parameters.width), height: Number(parameters.height),
      steps: Number(parameters.steps), scale: Number(parameters.scale),
      cfgRescale: Number(parameters.cfg_rescale), sampler: String(parameters.sampler),
      noiseSchedule: String(parameters.noise_schedule), seed,
      requestPayload: deepClone(request.payload),
    };
    this.plans.set(planId, {
      preview, profileRevision: binding.secretRevision, params: normalized, state: 'ready',
    });
    this.trimPlans();
    return deepClone(preview);
  }

  prepareMobileInpaint(raw: GatewayMobileInpaintPlanRequest): GatewayPlanPreview {
    this.expirePlans();
    if (!isObject(raw) || typeof raw.profileId !== 'string') {
      throw new Error('请先选择网关档案，再预览新版重绘。');
    }
    const profile = this.dependencies.vault.list().find(item => item.id === raw.profileId);
    if (!profile) throw new Error('网关档案已删除，请重新选择。');
    if (!profile.selected) throw new Error('该网关档案尚未选中，请先选择后再预览。');
    const validated = validateMobileInpaintPlan(raw, profile.protocol, this.randomSeed);
    const binding = this.dependencies.vault.bind(profile.id);
    if (!binding.profile.selected) throw new Error('该网关档案已切换，请重新选择后再预览。');
    const gatewayRequest = buildMobileInpaintGatewayRequest({
      protocol: profile.protocol,
      model: validated.model,
      prompt: validated.prompt,
      negativePrompt: validated.negativePrompt,
      imageBase64: validated.imageBase64,
      maskBase64: validated.maskBase64,
      strength: validated.strength,
      disabledOriginalImage: validated.request.ignoreSource,
      colorCorrect: validated.request.colorCorrection,
      width: validated.width,
      height: validated.height,
      steps: validated.steps,
      scale: validated.scale,
      cfgRescale: validated.cfgRescale,
      sampler: validated.sampler,
      noiseSchedule: validated.noiseSchedule,
      seed: validated.seed,
    });
    const endpoint = new URL(gatewayRequest.path, binding.profile.baseUrl).toString();
    const planId = crypto.randomUUID();
    const expiresAt = new Date(this.now().getTime() + PLAN_LIFETIME_MS).toISOString();
    const previewPayload = { ...gatewayRequest.payload };
    // Source pixels are frozen in the main-process plan, but never echoed back
    // into UI state or confirmation-card snapshots.
    if (typeof previewPayload.image === 'string') previewPayload.image = '[本轮源图已绑定]';
    if (typeof previewPayload.mask === 'string') previewPayload.mask = '[本轮蒙版已绑定]';
    const preview: GatewayPlanPreview = {
      planId,
      expiresAt,
      profileId: profile.id,
      profileName: profile.name,
      profileRevision: binding.secretRevision,
      protocol: profile.protocol,
      endpoint,
      model: validated.model,
      prompt: validated.prompt,
      negativePrompt: validated.negativePrompt,
      width: validated.width,
      height: validated.height,
      steps: validated.steps,
      scale: validated.scale,
      cfgRescale: validated.cfgRescale,
      sampler: validated.sampler,
      noiseSchedule: validated.noiseSchedule,
      seed: validated.seed,
      operation: 'mobileInpaint',
      requestPayload: previewPayload,
    };
    this.plans.set(planId, {
      preview,
      profileRevision: binding.secretRevision,
      params: validated.params,
      requestPayload: gatewayRequest.payload,
      state: 'ready',
    });
    this.trimPlans();
    return deepClone(preview);
  }

  async generate(input: { planId: string; confirmed: true }): Promise<GatewayJobResult> {
    if (!isObject(input) || input.confirmed !== true || typeof input.planId !== 'string') {
      throw new Error('请先查看并确认参数计划。');
    }
    const plan = this.plans.get(input.planId);
    if (!plan || plan.state !== 'ready') throw new Error('该计划已过期、已取消或已执行；请重新预览，绘世不会自动重试。');
    if (new Date(plan.preview.expiresAt).getTime() <= this.now().getTime()) {
      plan.state = 'finished';
      throw new Error('参数计划已过期；请重新预览。');
    }
    const binding = this.dependencies.vault.bind(plan.preview.profileId);
    if (!binding.profile.selected || binding.secretRevision !== plan.profileRevision) {
      plan.state = 'finished';
      throw new Error('网关档案或令牌在预览后发生变化；请重新预览确认。');
    }
    plan.state = 'running';
    const controller = new AbortController();
    plan.controller = controller;
    let submitted = false;
    let responseReceived = false;
    plan.submitted = false;
    plan.responseReceived = false;
    try {
      const response = await this.dependencies.post(plan.preview.endpoint,
        plan.requestPayload ?? deepClone(plan.preview.requestPayload), {
        headers: {
          Authorization: `Bearer ${binding.token}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        timeout: REQUEST_TIMEOUT_MS,
        signal: controller.signal,
        maxRedirects: 0,
      }, () => {
        submitted = true;
        plan.submitted = true;
      });
      responseReceived = true;
      plan.responseReceived = true;
      if (response.status < 200 || response.status >= 300) {
        const status = response.status;
        plan.state = 'finished';
        return status >= 400 && status < 500 && status !== 408
          ? { status: 'failed', message: `网关返回 HTTP ${status}；本次没有保存图片。` }
          : { status: 'uncertain', message: `网关返回 HTTP ${status}。请求可能已被接收，先核对网关生成记录再决定是否重试。` };
      }
      let bytes: Buffer;
      try { bytes = decodedGatewayImage(response.data); }
      catch (error) {
        plan.state = 'finished';
        return { status: 'uncertain', message: error instanceof Error ? error.message : '网关返回内容无法识别；请核对服务端结果后再决定是否重试。' };
      }
      const item = await persistGatewayImage(bytes, plan.params, plan.preview.model, plan.preview.seed,
        this.dependencies.outputDir(), this.now(), this.dependencies.appendHistory,
        plan.preview.operation === 'mobileInpaint'
          ? { width: plan.preview.width, height: plan.preview.height }
          : undefined);
      plan.state = 'finished';
      return { status: 'succeeded', message: '网关生成完成，图片已写入绘世输出目录并加入历史记录。', items: [item] };
    } catch (error) {
      plan.state = 'finished';
      if (error instanceof PartialHistoryFailure) {
        return { status: 'uncertain', message: `图片已保存到 ${error.item.filePath}，但历史记录更新失败；请核对文件后再决定是否重试。`, items: [error.item] };
      }
      if (error instanceof GatewayOutputSizeMismatch) {
        return { status: 'uncertain', message: error.message };
      }
      const status = Number((error as any)?.response?.status);
      if (status >= 400 && status < 500 && status !== 408) return { status: 'failed', message: `网关返回 HTTP ${status}；本次没有保存图片。` };
      if (submitted || responseReceived) {
        return { status: 'uncertain', message: controller.signal.aborted
          ? '已停止本地等待；取消不能撤回已发出的网关请求。请先核对服务端生成记录，不要直接重复提交。'
          : '请求已发出，但连接或保存环节未能确认完成。请先核对网关记录和绘世输出目录，再决定是否重试。' };
      }
      if (controller.signal.aborted) return { status: 'failed', message: '已在请求送达网关前取消；网关尚未收到请求。' };
      return { status: 'failed', message: '请求尚未送达网关；请检查网关地址、代理或连接后重新预览。' };
    } finally {
      plan.controller = undefined;
      plan.submitted = submitted;
      plan.responseReceived = responseReceived;
    }
  }

  cancel(planId: unknown) {
    if (typeof planId !== 'string') throw new Error('生成计划无效。');
    const plan = this.plans.get(planId);
    if (!plan) return { accepted: false, message: '此计划已不在运行。' };
    if (plan.state === 'ready') {
      plan.state = 'cancelled';
      return { accepted: true, message: '已取消待执行计划；网关尚未收到请求。' };
    }
    if (plan.state !== 'running' || plan.responseReceived) return { accepted: false, message: '网关已响应，无法撤回；请检查结果状态。' };
    plan.controller?.abort();
    return { accepted: true, message: plan.submitted
      ? '已停止本地等待；网关可能仍在处理本次请求，请核对记录后再决定是否重试。'
      : '已取消请求；网关尚未收到请求。' };
  }

  private expirePlans() {
    const now = this.now().getTime();
    for (const [id, plan] of this.plans) if (plan.state !== 'running' && new Date(plan.preview.expiresAt).getTime() <= now) this.plans.delete(id);
  }
  private trimPlans() {
    if (this.plans.size <= 32) return;
    for (const [id, plan] of this.plans) {
      if (plan.state !== 'running') this.plans.delete(id);
      if (this.plans.size <= 32) break;
    }
  }
}

let vault: GatewayWorkbenchVault | undefined;
let service: GatewayWorkbenchService | undefined;
function getService() {
  if (service) return service;
  const file = path.join(app.getPath('userData'), 'gateway-workbench-v1.json');
  let document: GatewayVaultDocument = { version: 1, profiles: [] };
  if (fs.existsSync(file)) {
    try { document = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { throw new Error('网关凭据文件无法读取；原文件已保留，未发送任何请求。'); }
  }
  vault = new GatewayWorkbenchVault(document, safeStorage, next => {
    if (!gatewayCipherAvailable(safeStorage)) throw new Error('系统凭据加密不可用，未保存网关令牌。');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(next), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, file);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  });
  service = new GatewayWorkbenchService({
    vault,
    post: async (url, payload, options, onSubmitted) => {
      const settings = getSettings();
      const proxy = await proxyConfigForUrl('nai', url, settings);
      if (options.signal.aborted) throw Object.assign(new Error('cancelled before submit'), { code: 'ERR_CANCELED' });
      onSubmitted();
      const response = await axios.post(url, payload, { ...proxy, headers: options.headers,
        timeout: options.timeout, signal: options.signal, maxRedirects: options.maxRedirects });
      return { status: response.status, data: response.data };
    },
    outputDir: () => getSettings().outputDir,
    appendHistory: item => addHistory([item]),
  });
  return service;
}

/** Main-window-only IPC; credentials and network access stay in the main process. */
export function registerGatewayWorkbenchIpc(getWindow: () => BrowserWindow | null) {
  const trusted = (event: IpcMainInvokeEvent) => {
    const win = getWindow();
    return !!win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame;
  };
  const run = <T>(event: IpcMainInvokeEvent, action: (workbench: GatewayWorkbenchService) => T): T => {
    if (!trusted(event)) throw new Error('仅绘世主窗口可使用网关工作台。');
    return action(getService());
  };
  ipcMain.handle('gatewayWorkbench:listProfiles', event => run(event, workbench => workbench.listProfiles()));
  ipcMain.handle('gatewayWorkbench:addProfile', (event, input: GatewayProfileInput) => run(event, workbench => workbench.addProfile(input)));
  ipcMain.handle('gatewayWorkbench:selectProfile', (event, id: unknown) => run(event, workbench => workbench.selectProfile(id)));
  ipcMain.handle('gatewayWorkbench:removeProfile', (event, id: unknown) => run(event, workbench => workbench.removeProfile(id)));
  ipcMain.handle('gatewayWorkbench:prepare', (event, request: GatewayPlanRequest) => run(event, workbench => workbench.prepare(request)));
  ipcMain.handle('gatewayWorkbench:prepareMobileInpaint', (event, request: GatewayMobileInpaintPlanRequest) => run(event, workbench => workbench.prepareMobileInpaint(request)));
  ipcMain.handle('gatewayWorkbench:generate', (event, input: { planId: string; confirmed: true }) => run(event, workbench => workbench.generate(input)));
  ipcMain.handle('gatewayWorkbench:cancel', (event, id: unknown) => run(event, workbench => workbench.cancel(id)));
}

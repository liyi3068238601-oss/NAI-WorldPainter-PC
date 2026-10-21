import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { DEFAULT_PARAMS, type MobileInpaintRequest } from '../../src/types';

const fixture = vi.hoisted(() => ({ root: '' }));
vi.mock('electron', () => ({
  app: { getPath: () => fixture.root, isPackaged: false, getAppPath: () => fixture.root },
  ipcMain: { handle: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'dpapi',
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
  dialog: {},
  nativeImage: {},
}));

import { GatewayWorkbenchService } from './gateway-workbench';
import { GatewayWorkbenchVault, type GatewayVaultDocument } from './gateway-workbench-vault';

const cipher = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'dpapi',
  encryptString: (value: string) => Buffer.from(`sealed:${value}`),
  decryptString: (value: Buffer) => value.toString().replace(/^sealed:/, ''),
};

function makeVault(document: GatewayVaultDocument = { version: 1, profiles: [] }) {
  return new GatewayWorkbenchVault(document, cipher, () => {});
}

async function makeRequest(options: {
  width?: number;
  height?: number;
  model?: MobileInpaintRequest['model'];
  sampler?: string;
  noiseSchedule?: string;
} = {}): Promise<MobileInpaintRequest> {
  const width = options.width ?? 64;
  const height = options.height ?? 64;
  const source = await sharp({ create: { width, height, channels: 4, background: { r: 120, g: 90, b: 200, alpha: 1 } } }).png().toBuffer();
  const mask = await sharp({ create: { width, height, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } }).png().toBuffer();
  return {
    expectedAccountId: 'official-account-must-not-be-used',
    expectedAccountRevision: 'official-revision-must-not-be-used',
    params: {
      ...DEFAULT_PARAMS,
      positivePrompt: ' 1girl, portrait ',
      negativePrompt: ' lowres ',
      stylePrompt: '',
      width,
      height,
      steps: options.model?.includes('diffusion-5') === false ? 40 : 28,
      cfgScale: 5,
      cfgRescale: 0.2,
      sampler: 'k_euler_ancestral',
      noiseSchedule: options.noiseSchedule ?? 'karras',
      seedMode: 'random',
      seed: 0,
    },
    model: options.model ?? 'nai-diffusion-5-full-inpainting',
    imageBase64: source.toString('base64'),
    maskBase64: mask.toString('base64'),
    strength: 0.96,
    noise: 0.9,
    ignoreSource: true,
    colorCorrection: false,
    ...(options.sampler ? { sampling: { sampler: options.sampler, noiseSchedule: options.noiseSchedule ?? 'karras' } } : {}),
  };
}

function makeService(options: {
  protocol?: 'gateway7877' | 'ikun';
  baseUrl?: string;
  token?: string;
  post?: ReturnType<typeof vi.fn>;
  outputDir?: () => string;
  appendHistory?: (item: any) => void;
  now?: () => Date;
} = {}) {
  const vault = makeVault();
  const profiles = vault.add({
    name: '测试网关',
    protocol: options.protocol ?? 'gateway7877',
    baseUrl: options.baseUrl ?? 'http://127.0.0.1:8765',
    token: options.token ?? 'gateway-only-token',
  });
  const history: any[] = [];
  const post = options.post ?? vi.fn(async () => ({ status: 200, data: { data: [] } }));
  const service = new GatewayWorkbenchService({
    vault,
    post: post as any,
    outputDir: options.outputDir ?? (() => path.join(fixture.root, 'outputs')),
    appendHistory: options.appendHistory ?? (item => history.unshift(item)),
    now: options.now,
    randomSeed: () => 1234,
  });
  return { vault, profile: profiles[0], service, post, history };
}

async function outputImage(format: 'png' | 'jpeg' | 'webp', width = 64, height = 64) {
  const pipeline = sharp({ create: { width, height, channels: 4, background: { r: 255, g: 0, b: 255, alpha: 1 } } });
  const bytes = format === 'jpeg' ? await pipeline.jpeg().toBuffer()
    : format === 'webp' ? await pipeline.webp().toBuffer()
      : await pipeline.png().toBuffer();
  return bytes.toString('base64');
}

describe('gateway workbench mobile inpaint plans', () => {
  beforeEach(() => {
    fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), 'worldpainter-gateway-mobile-inpaint-'));
  });
  afterEach(() => {
    if (fixture.root && fs.existsSync(fixture.root)) fs.rmSync(fixture.root, { recursive: true, force: true });
    fixture.root = '';
  });

  it('previews a redacted 7877 plan, uses only the selected vault token, and persists matching PNG/JPEG/WebP outputs once', async () => {
    for (const format of ['png', 'jpeg', 'webp'] as const) {
      const payloadImage = await outputImage(format);
      let authorization = '';
      let sentPayload: Record<string, any> | undefined;
      const post = vi.fn(async (_url: string, payload: Record<string, any>, options: any, onSubmitted: () => void) => {
        authorization = options.headers.Authorization;
        sentPayload = payload;
        onSubmitted();
        return { status: 200, data: { data: [{ b64_json: payloadImage }] } };
      });
      const { service, profile, history } = makeService({ post });
      const request = await makeRequest({ sampler: 'ddim', noiseSchedule: 'polyexponential' });
      const preview = service.prepareMobileInpaint({ profileId: profile.id, request });

      expect(post).not.toHaveBeenCalled();
      expect(preview).toMatchObject({
        operation: 'mobileInpaint', protocol: 'gateway7877',
        endpoint: 'http://127.0.0.1:8765/v1/images/generations',
        model: 'nai-diffusion-5-full-inpainting', width: 64, height: 64,
        sampler: 'ddim', noiseSchedule: 'polyexponential', seed: 1234,
      });
      expect(preview.requestPayload.image).toBe('[本轮源图已绑定]');
      expect(preview.requestPayload.mask).toBe('[本轮蒙版已绑定]');
      expect(JSON.stringify(preview)).not.toContain(request.imageBase64);
      expect(JSON.stringify(preview)).not.toContain('gateway-only-token');

      const result = await service.generate({ planId: preview.planId, confirmed: true });
      expect(result.status, result.message).toBe('succeeded');
      expect(authorization).toBe('Bearer gateway-only-token');
      expect(sentPayload).toMatchObject({ model: 'nai-diffusion-5-full', params: { sampler: 'ddim', noise_schedule: 'polyexponential' } });
      expect(sentPayload).not.toHaveProperty('noise');
      expect(sentPayload).not.toHaveProperty('color_correct');
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ actualSeed: 1234, width: 64, height: 64, model: request.model });
      expect(path.extname(history[0].filePath)).toBe(format === 'jpeg' ? '.jpg' : `.${format}`);
      await expect(service.generate({ planId: preview.planId, confirmed: true })).rejects.toThrow(/不会自动重试/);
      expect(post).toHaveBeenCalledTimes(1);
    }
  });

  it('sends the Ikun mobile inpainting fields without T2I quality projection', async () => {
    const post = vi.fn(async (_url: string, payload: Record<string, any>, _options: any, onSubmitted: () => void) => {
      onSubmitted();
      return { status: 200, data: { data: [{ b64_json: await outputImage('png') }] } };
    });
    const { service, profile } = makeService({ protocol: 'ikun', baseUrl: 'https://ikun.example', post });
    const request = await makeRequest({ sampler: 'ddim_v3' });
    const preview = service.prepareMobileInpaint({ profileId: profile.id, request });
    expect(preview.requestPayload).toMatchObject({
      novelai_operation: 'inpainting',
      noise: 0,
      add_original_image: false,
      color_correct: false,
      width: 64,
      height: 64,
      sampler: 'ddim_v3',
    });
    expect(preview.requestPayload).not.toHaveProperty('quality');
    expect(preview.requestPayload).not.toHaveProperty('uc_preset');
    const result = await service.generate({ planId: preview.planId, confirmed: true });
    expect(result.status, result.message).toBe('succeeded');
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('does not send cancelled, expired, or profile-switched plans', async () => {
    let now = new Date('2026-10-21T00:00:00.000Z');
    const post = vi.fn(async () => ({ status: 200, data: { data: [] } }));
    const { vault, profile, service } = makeService({ post, now: () => now });
    const request = await makeRequest();

    const cancelled = service.prepareMobileInpaint({ profileId: profile.id, request });
    expect(service.cancel(cancelled.planId).accepted).toBe(true);
    await expect(service.generate({ planId: cancelled.planId, confirmed: true })).rejects.toThrow(/已过期、已取消或已执行/);

    const switched = service.prepareMobileInpaint({ profileId: profile.id, request });
    vault.add({ name: '另一个网关', protocol: 'gateway7877', baseUrl: 'http://127.0.0.1:8766', token: 'other-token' });
    await expect(service.generate({ planId: switched.planId, confirmed: true })).rejects.toThrow(/档案或令牌在预览后发生变化/);

    const secondProfile = vault.list().find(item => item.id === profile.id)!;
    vault.select(secondProfile.id);
    const expired = service.prepareMobileInpaint({ profileId: profile.id, request });
    now = new Date(now.getTime() + 5 * 60_000 + 1);
    await expect(service.generate({ planId: expired.planId, confirmed: true })).rejects.toThrow(/已过期/);
    expect(post).not.toHaveBeenCalled();
  });

  it('cancels an in-flight request without retrying or hiding its uncertain result', async () => {
    const post = vi.fn((_url: string, _payload: Record<string, unknown>, options: any, onSubmitted: () => void) => {
      onSubmitted();
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'ERR_CANCELED' })), { once: true });
      });
    });
    const { service, profile } = makeService({ post });
    const preview = service.prepareMobileInpaint({ profileId: profile.id, request: await makeRequest() });
    const run = service.generate({ planId: preview.planId, confirmed: true });
    expect(service.cancel(preview.planId).accepted).toBe(true);
    const result = await run;
    expect(result.status).toBe('uncertain');
    expect(result.message).toMatch(/核对服务端生成记录/);
    await expect(service.generate({ planId: preview.planId, confirmed: true })).rejects.toThrow(/不会自动重试/);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('rejects returned size mismatches before writing and does not repeat a paid request', async () => {
    const outputDir = path.join(fixture.root, 'outputs');
    const wrongSize = await outputImage('png', 128, 64);
    const post = vi.fn(async (_url: string, _payload: Record<string, unknown>, _options: any, onSubmitted: () => void) => {
      onSubmitted();
      return { status: 200, data: { data: [{ b64_json: wrongSize }] } };
    });
    const { service, profile, history } = makeService({ post, outputDir: () => outputDir });
    const preview = service.prepareMobileInpaint({ profileId: profile.id, request: await makeRequest() });
    const result = await service.generate({ planId: preview.planId, confirmed: true });
    expect(result).toMatchObject({ status: 'uncertain' });
    expect(result.message).toMatch(/128×64.*64×64.*图片未保存/);
    expect(history).toHaveLength(0);
    expect(fs.existsSync(outputDir)).toBe(false);
    await expect(service.generate({ planId: preview.planId, confirmed: true })).rejects.toThrow(/不会自动重试/);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('does not resend after the remote image succeeded but local disk persistence failed', async () => {
    const blockedOutput = path.join(fixture.root, 'not-a-directory');
    fs.writeFileSync(blockedOutput, 'fixture');
    const post = vi.fn(async (_url: string, _payload: Record<string, unknown>, _options: any, onSubmitted: () => void) => {
      onSubmitted();
      return { status: 200, data: { data: [{ b64_json: await outputImage('webp') }] } };
    });
    const { service, profile, history } = makeService({ post, outputDir: () => blockedOutput });
    const preview = service.prepareMobileInpaint({ profileId: profile.id, request: await makeRequest() });
    const result = await service.generate({ planId: preview.planId, confirmed: true });
    expect(result.status).toBe('uncertain');
    expect(result.message).toMatch(/核对网关记录和绘世输出目录/);
    expect(history).toHaveLength(0);
    await expect(service.generate({ planId: preview.planId, confirmed: true })).rejects.toThrow(/不会自动重试/);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('preserves the phone inpaint workspace resolution range past text-to-image guards', async () => {
    const { service, profile } = makeService();
    const v5Request = await makeRequest({
      width: 1920,
      height: 1088,
    });
    const v5Preview = service.prepareMobileInpaint({ profileId: profile.id, request: v5Request });
    expect(v5Preview).toMatchObject({ width: 1920, height: 1088 });

    const ikunVault = makeVault();
    const ikunProfile = ikunVault.add({ name: 'Ikun', protocol: 'ikun', baseUrl: 'https://ikun.example', token: 'ikun-token' })[0];
    const ikunService = new GatewayWorkbenchService({
      vault: ikunVault,
      post: vi.fn(async () => ({ status: 200, data: {} })) as any,
      outputDir: () => path.join(fixture.root, 'ikun-output'),
      appendHistory: () => {},
    });
    const ikunWallpaper = await makeRequest({ width: 1920, height: 1088 });
    const ikunPreview = ikunService.prepareMobileInpaint({ profileId: ikunProfile.id, request: ikunWallpaper });
    expect(ikunPreview).toMatchObject({ width: 1920, height: 1088, protocol: 'ikun' });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { DEFAULT_PARAMS } from '../../src/types';

const fixture = vi.hoisted(() => ({ root: '' }));
vi.mock('electron', () => ({
  app: { getPath: () => fixture.root, isPackaged: false, getAppPath: () => fixture.root },
  ipcMain: { handle: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'dpapi', encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() },
  dialog: {}, nativeImage: {},
}));

import { GatewayWorkbenchService, registerGatewayWorkbenchIpc } from './gateway-workbench';
import { GatewayWorkbenchVault, normalizeGatewayBaseUrl, type GatewayVaultDocument } from './gateway-workbench-vault';

let png = '';
const cipher = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'dpapi',
  encryptString: (value: string) => Buffer.from(`sealed:${value}`),
  decryptString: (value: Buffer) => value.toString().replace(/^sealed:/, ''),
};

function makeVault(document: GatewayVaultDocument = { version: 1, profiles: [] }) {
  let persisted = document;
  const vault = new GatewayWorkbenchVault(document, cipher, (next) => { persisted = structuredClone(next); });
  return { vault, readPersisted: () => persisted };
}

describe('gateway workbench vault and isolated text-to-image workflow', () => {
  beforeEach(async () => {
    fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), 'worldpainter-gateway-'));
    png = (await sharp({ create: { width: 1, height: 1, channels: 4, background: '#ff00ffff' } }).png().toBuffer()).toString('base64');
  });
  afterEach(() => { fs.rmSync(fixture.root, { recursive: true, force: true }); });

  it('rejects gateway IPC calls outside the live main frame before constructing the service', () => {
    const handle = vi.mocked(ipcMain.handle);
    handle.mockClear();
    const webContents = { mainFrame: {} };
    registerGatewayWorkbenchIpc(() => ({ isDestroyed: () => false, webContents } as any));
    const listProfiles = handle.mock.calls.find(([channel]) => channel === 'gatewayWorkbench:listProfiles')?.[1] as ((event: unknown) => unknown) | undefined;
    expect(listProfiles).toBeTypeOf('function');
    expect(() => listProfiles!({ sender: webContents, senderFrame: {} } as any)).toThrow(/仅绘世主窗口可使用网关工作台/);
    expect(() => listProfiles!({ sender: {}, senderFrame: webContents.mainFrame } as any)).toThrow(/仅绘世主窗口可使用网关工作台/);
  });

  it('keeps gateway credentials encrypted and isolates profiles by protocol plus canonical base', () => {
    const { vault, readPersisted } = makeVault();
    const first = vault.add({ name: 'local 7877', protocol: 'gateway7877', baseUrl: 'http://127.0.0.1:8765/', token: 'secret-7877' });
    const second = vault.add({ name: 'local ikun', protocol: 'ikun', baseUrl: 'http://127.0.0.1:8765', token: 'secret-ikun' });
    expect(first[0].id).not.toBe(second.find((item) => item.protocol === 'ikun')?.id);
    expect(second.find((item) => item.selected)?.protocol).toBe('ikun');
    expect(JSON.stringify(vault.list())).not.toMatch(/secret-/);
    expect(JSON.stringify(readPersisted())).not.toContain('secret-ikun');
    expect(vault.bind(first[0].id).token).toBe('secret-7877');
    expect(() => normalizeGatewayBaseUrl('ikun', 'http://gateway.example')).toThrow(/回环 IP/);
    expect(() => normalizeGatewayBaseUrl('ikun', 'https://gateway.example/v1')).toThrow(/不含路径/);
  });

  it('rejects encrypted credential swaps between protocol/base profiles and migrates legacy ciphertext before use', () => {
    const { vault, readPersisted } = makeVault();
    const first = vault.add({ name: 'local 7877', protocol: 'gateway7877', baseUrl: 'http://127.0.0.1:8765', token: 'secret-7877' });
    const second = vault.add({ name: 'local ikun', protocol: 'ikun', baseUrl: 'http://127.0.0.1:8765', token: 'secret-ikun' });
    const doc = readPersisted();
    const firstStored = doc.profiles.find(profile => profile.id === first[0].id)!;
    const secondStored = doc.profiles.find(profile => profile.id === second.find(item => item.protocol === 'ikun')?.id)!;
    const swapped = new GatewayWorkbenchVault({
      ...doc,
      profiles: doc.profiles.map(profile => profile.id === firstStored.id
        ? { ...profile, encryptedToken: secondStored.encryptedToken }
        : profile),
    }, cipher, () => {});
    expect(() => swapped.bind(firstStored.id)).toThrow(/与当前协议或服务根地址不匹配/);

    const legacyDoc = {
      ...doc,
      profiles: doc.profiles.map(profile => ({
        ...profile,
        encryptedToken: cipher.encryptString('legacy-token').toString('base64'),
      })),
    };
    let migrated: GatewayVaultDocument | undefined;
    const legacyVault = new GatewayWorkbenchVault(legacyDoc, cipher, next => { migrated = structuredClone(next); });
    expect(legacyVault.bind(firstStored.id).token).toBe('legacy-token');
    expect(migrated).toBeDefined();
    expect(new GatewayWorkbenchVault(migrated!, cipher, () => {}).bind(firstStored.id).token).toBe('legacy-token');
  });

  it('previews without network access, then sends only the confirmed 7877 plan and indexes a saved result', async () => {
    const { vault } = makeVault();
    const profiles = vault.add({ name: '本地测试网关', protocol: 'gateway7877', baseUrl: 'http://localhost:8765', token: 'fixture-token' });
    const post = vi.fn(async (_url: string, payload: Record<string, any>, options: any, onSubmitted: () => void) => {
      onSubmitted();
      expect(options.headers.Authorization).toBe('Bearer fixture-token');
      expect(payload.params).toBeDefined();
      return { status: 200, data: { data: [{ b64_json: png }] } };
    });
    const history: any[] = [];
    const service = new GatewayWorkbenchService({ vault, post, outputDir: () => path.join(fixture.root, 'outputs'), appendHistory: (item) => history.unshift(item), now: () => new Date('2026-10-15T10:11:12.000Z'), randomSeed: () => 456 });
    const preview = service.prepare({ profileId: profiles[0].id, operation: 'textToImage', draft: { ...DEFAULT_PARAMS, positivePrompt: '1girl, portrait', seedMode: 'fixed', seed: 42 } });
    expect(post).not.toHaveBeenCalled();
    expect(preview.endpoint).toBe('http://localhost:8765/v1/images/generations');
    expect(preview.seed).toBe(42);
    expect(preview.requestPayload.params).toBeDefined();
    expect(JSON.stringify(preview)).not.toContain('fixture-token');
    await expect(service.generate({ planId: preview.planId, confirmed: false as true })).rejects.toThrow(/确认/);
    const result = await service.generate({ planId: preview.planId, confirmed: true });
    expect(result.status, result.message).toBe('succeeded');
    expect(post).toHaveBeenCalledTimes(1);
    expect(history).toHaveLength(1);
    expect(fs.existsSync(history[0].filePath)).toBe(true);
    expect(history[0]).toMatchObject({ actualSeed: 42, model: 'nai-diffusion-5-full', generatedAtSource: 'local-completion', width: 1, height: 1 });
    await expect(service.generate({ planId: preview.planId, confirmed: true })).rejects.toThrow(/不会自动重试/);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('sends an Ikun text-to-image plan with direct fields and the isolated Ikun token', async () => {
    const { vault } = makeVault();
    const profiles = vault.add({ name: 'Ikun direct fields', protocol: 'ikun', baseUrl: 'https://gateway.example', token: 'ikun-only-token' });
    let sentPayload: Record<string, any> | undefined;
    let authorization = '';
    const post = vi.fn(async (_url: string, payload: Record<string, any>, options: any, onSubmitted: () => void) => {
      sentPayload = payload;
      authorization = options.headers.Authorization;
      onSubmitted();
      return { status: 200, data: { data: [{ b64_json: png }] } };
    });
    const history: any[] = [];
    const service = new GatewayWorkbenchService({ vault, post, outputDir: () => path.join(fixture.root, 'ikun-output'), appendHistory: item => history.unshift(item) });
    const plan = service.prepare({ profileId: profiles[0].id, operation: 'textToImage', draft: { ...DEFAULT_PARAMS, positivePrompt: '1girl, portrait', negativePrompt: 'lowres', seedMode: 'fixed', seed: 73 } });
    expect(plan.protocol).toBe('ikun');
    expect(plan.requestPayload).not.toHaveProperty('params');
    const result = await service.generate({ planId: plan.planId, confirmed: true });
    expect(result.status, result.message).toBe('succeeded');
    expect(authorization).toBe('Bearer ikun-only-token');
    expect(sentPayload).toMatchObject({ negative_prompt: expect.any(String), n: 1, response_format: 'b64_json' });
    expect(sentPayload).not.toHaveProperty('params');
    expect(history).toHaveLength(1);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('invalidates a prepared plan when its selected profile token is replaced', async () => {
    const { vault } = makeVault();
    const profiles = vault.add({ name: '7877', protocol: 'gateway7877', baseUrl: 'http://127.0.0.1:8765', token: 'old-token' });
    const post = vi.fn();
    const service = new GatewayWorkbenchService({ vault, post, outputDir: () => fixture.root, appendHistory: () => {} });
    const plan = service.prepare({ profileId: profiles[0].id, operation: 'textToImage', draft: { ...DEFAULT_PARAMS, positivePrompt: 'test', seedMode: 'fixed' } });
    vault.add({ name: '7877 refreshed', protocol: 'gateway7877', baseUrl: 'http://127.0.0.1:8765', token: 'new-token' });
    await expect(service.generate({ planId: plan.planId, confirmed: true })).rejects.toThrow(/档案或令牌在预览后发生变化/);
    expect(post).not.toHaveBeenCalled();
  });

  it('blocks unsupported active features before creating a network request', () => {
    const { vault } = makeVault();
    const profiles = vault.add({ name: 'Ikun', protocol: 'ikun', baseUrl: 'https://gateway.example', token: 'secret' });
    const post = vi.fn();
    const service = new GatewayWorkbenchService({ vault, post, outputDir: () => fixture.root, appendHistory: () => {} });
    expect(() => service.prepare({ profileId: profiles[0].id, operation: 'imageToImage', draft: { ...DEFAULT_PARAMS, positivePrompt: 'test' } }))
      .toThrow(/图生图与局部重绘/);
    expect(() => service.prepare({ profileId: profiles[0].id, operation: 'textToImage', draft: { ...DEFAULT_PARAMS, positivePrompt: 'test' }, features: { vibeReferences: 1 } }))
      .toThrow(/Vibe/);
    expect(() => service.prepare({ profileId: profiles[0].id, operation: 'textToImage', draft: { ...DEFAULT_PARAMS, positivePrompt: 'test', transparentBackground: true } }))
      .toThrow(/透明背景/);
    expect(post).not.toHaveBeenCalled();
  });

  it('reports cancellation after submission as uncertain and does not retry', async () => {
    const { vault } = makeVault();
    const profiles = vault.add({ name: '本地测试网关', protocol: 'ikun', baseUrl: 'http://127.0.0.1:8765', token: 'fixture-token' });
    const post = vi.fn((_url: string, _payload: Record<string, unknown>, options: any, onSubmitted: () => void) => new Promise((_resolve, reject) => {
      onSubmitted();
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'ERR_CANCELED' })), { once: true });
    }));
    const service = new GatewayWorkbenchService({ vault, post, outputDir: () => fixture.root, appendHistory: () => {} });
    const plan = service.prepare({ profileId: profiles[0].id, operation: 'textToImage', draft: { ...DEFAULT_PARAMS, positivePrompt: 'test', seedMode: 'fixed' } });
    const run = service.generate({ planId: plan.planId, confirmed: true });
    await Promise.resolve();
    expect(service.cancel(plan.planId).accepted).toBe(true);
    const result = await run;
    expect(result.status).toBe('uncertain');
    expect(result.message).toMatch(/核对服务端生成记录/);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('reports cancellation before submission as failed without marking a request delivered', async () => {
    const { vault } = makeVault();
    const profiles = vault.add({ name: 'Ikun', protocol: 'ikun', baseUrl: 'http://127.0.0.1:8765', token: 'fixture-token' });
    let markEntered!: () => void;
    let releasePost!: () => void;
    const entered = new Promise<void>(resolve => { markEntered = resolve; });
    const gate = new Promise<void>(resolve => { releasePost = resolve; });
    let submitted = false;
    const post = vi.fn(async (_url: string, _payload: Record<string, unknown>, options: any, onSubmitted: () => void) => {
      markEntered();
      await gate;
      if (options.signal.aborted) throw Object.assign(new Error('cancelled before submit'), { code: 'ERR_CANCELED' });
      submitted = true;
      onSubmitted();
      return { status: 200, data: { data: [{ b64_json: png }] } };
    });
    const service = new GatewayWorkbenchService({ vault, post, outputDir: () => fixture.root, appendHistory: () => {} });
    const plan = service.prepare({ profileId: profiles[0].id, operation: 'textToImage', draft: { ...DEFAULT_PARAMS, positivePrompt: 'test', seedMode: 'fixed' } });
    const run = service.generate({ planId: plan.planId, confirmed: true });
    await entered;
    expect(service.cancel(plan.planId)).toMatchObject({ accepted: true, message: expect.stringMatching(/尚未收到请求/) });
    releasePost();
    const result = await run;
    expect(result.status).toBe('failed');
    expect(result.message).toMatch(/请求送达网关前取消/);
    expect(submitted).toBe(false);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('does not retry uncertain gateway failures and distinguishes a definitive authorization rejection', async () => {
    const { vault } = makeVault();
    const profiles = vault.add({ name: 'Ikun', protocol: 'ikun', baseUrl: 'https://gateway.example', token: 'fixture-token' });
    const post = vi.fn(async (_url: string, _payload: Record<string, unknown>, _options: any, onSubmitted: () => void) => {
      onSubmitted();
      return { status: 503, data: { message: 'sensitive upstream response details' } };
    });
    const service = new GatewayWorkbenchService({ vault, post, outputDir: () => fixture.root, appendHistory: () => {} });
    const plan = service.prepare({ profileId: profiles[0].id, operation: 'textToImage', draft: { ...DEFAULT_PARAMS, positivePrompt: 'test', seedMode: 'fixed' } });
    const uncertain = await service.generate({ planId: plan.planId, confirmed: true });
    expect(uncertain.status).toBe('uncertain');
    expect(uncertain.message).not.toContain('sensitive upstream');
    expect(post).toHaveBeenCalledTimes(1);

    const unauthorizedPost = vi.fn(async (_url: string, _payload: Record<string, unknown>, _options: any, onSubmitted: () => void) => {
      onSubmitted();
      throw Object.assign(new Error('HTTP 401'), { response: { status: 401, data: { token: 'do-not-echo' } } });
    });
    const unauthorizedService = new GatewayWorkbenchService({ vault, post: unauthorizedPost, outputDir: () => fixture.root, appendHistory: () => {} });
    const secondPlan = unauthorizedService.prepare({ profileId: profiles[0].id, operation: 'textToImage', draft: { ...DEFAULT_PARAMS, positivePrompt: 'test', seedMode: 'fixed' } });
    const failed = await unauthorizedService.generate({ planId: secondPlan.planId, confirmed: true });
    expect(failed.status).toBe('failed');
    expect(failed.message).not.toContain('do-not-echo');
    expect(unauthorizedPost).toHaveBeenCalledTimes(1);
  });
});

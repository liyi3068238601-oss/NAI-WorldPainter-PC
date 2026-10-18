import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { currentR4PaidTextState, withR4PaidTextContext } from './r4-paid-text-context';

const host = vi.hoisted(() => ({ root: '', outbound: [] as string[] }));
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: (name: string) => name === 'exe' ? host.root + '/not-installed/Studio.exe'
      : name === 'userData' ? host.root : host.root + '/' + name,
    getAppPath: () => host.root,
  },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  shell: { openPath: async () => '' },
  nativeImage: {},
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() },
}));
vi.mock('./logger', () => ({ logInfo: vi.fn(), logError: vi.fn(), appendLog: vi.fn() }));
vi.mock('./proxy', () => ({
  proxyConfig: () => ({ proxy: false }),
  proxyConfigForUrl: async (_kind: string, url: string) => {
    host.outbound.push(url);
    if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(url)) throw new Error('EXTERNAL_TRANSPORT_BLOCKED');
    return { proxy: false };
  },
}));

const imageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGZkAAAAASUVORK5CYII=';
const services = ['convert_prompt', 'edit_prompt', 'reverse_prompt'] as const;
type ServiceName = typeof services[number];
type ResponseKind = 'ok' | 'empty_length' | 'invalid' | 'drop';
const servers: Server[] = [];
const profileRoot = path.resolve('.tmp/r4-paid-text-boundary');
let store: typeof import('./store');
let nai: typeof import('./nai');

async function endpoint(responses: ResponseKind[]) {
  let posts = 0;
  const server = createServer(async (request, response) => {
    for await (const _ of request) { /* consume the bounded fixture request */ }
    const kind = responses[posts] ?? responses.at(-1) ?? 'ok';
    posts += 1;
    if (kind === 'drop') { request.socket.destroy(); return; }
    const content = kind === 'empty_length' ? '' : kind === 'invalid' ? 'not a structured template response' : 'A girl stands in a quiet room.';
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: kind === 'empty_length' ? 'length' : 'stop' }] }));
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/v1';
  return { url, posts: () => posts };
}

async function configure(url: string, patch: Record<string, unknown> = {}) {
  const data = store.readStore();
  store.writeStore({ ...data, settings: {
    ...data.settings,
    convertApiUrl: url, convertApiKey: 'fixture-only', convertApiModel: 'fixture',
    visionApiUrl: url, visionApiKey: 'fixture-only', visionApiModel: 'fixture',
    proxyMode: 'direct', mcpForConvert: false,
    reverseConvertDshEnabled: false,
    promptAssistantMode: 'natural',
    convertPromptTemplates: { natural: '', tags: '', mixed: '' },
    convertPromptTemplatesV45: { natural: '', tags: '', mixed: '' },
    reversePromptTemplates: { natural: '', tags: '', mixed: '' },
    reversePromptTemplatesV45: { natural: '', tags: '', mixed: '' },
    ...patch,
  } as typeof data.settings });
}

function invoke(tool: ServiceName) {
  if (tool === 'convert_prompt') return () => nai.convertPromptText('一名女孩站在安静的房间里', 'natural', false, 'v5');
  if (tool === 'edit_prompt') return () => nai.convertPromptText('one girl in a quiet room', 'natural', false, 'v5', { kind: 'custom', instruction: 'Keep the subject and scene.' });
  return () => nai.reversePromptImage(imageBase64, 'natural', 'full', '', false, 'v5');
}

async function withinR4(tool: ServiceName, run: () => Promise<unknown>) {
  const beforePost = vi.fn();
  const afterReceipt = vi.fn();
  let state: ReturnType<typeof currentR4PaidTextState> = undefined;
  const value = await withR4PaidTextContext({
    canonicalTool: tool,
    signal: new AbortController().signal,
    beforePost,
    afterReceipt,
  }, async () => {
    const result = await run();
    state = currentR4PaidTextState();
    return result;
  });
  return { value, beforePost, afterReceipt, state: state! };
}

beforeAll(async () => {
  fs.mkdirSync(profileRoot, { recursive: true });
  host.root = fs.realpathSync.native(fs.mkdtempSync(path.join(profileRoot, 'profile-')));
  store = await import('./store');
  nai = await import('./nai');
});
beforeEach(() => { host.outbound = []; });
afterAll(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  if (host.root && path.relative(profileRoot, host.root).startsWith('..')) throw new Error('Unsafe test profile cleanup.');
  if (host.root) fs.rmSync(host.root, { recursive: true, force: true });
});

describe('R4 paid text HTTP boundary', () => {
  it('rechecks the gate and abort signal before a paid POST', async () => {
    const server = await endpoint(['ok']);
    await configure(server.url);

    const deniedBeforePost = vi.fn(async () => { throw new Error('R4_GATE_CLOSED'); });
    const deniedAfterReceipt = vi.fn();
    const denied = await withR4PaidTextContext({
      canonicalTool: 'convert_prompt', signal: new AbortController().signal,
      beforePost: deniedBeforePost, afterReceipt: deniedAfterReceipt,
    }, () => invoke('convert_prompt')());
    expect((denied as { ok: boolean }).ok).toBe(false);
    expect(deniedBeforePost).toHaveBeenCalledTimes(1);
    expect(deniedAfterReceipt).not.toHaveBeenCalled();
    expect(server.posts()).toBe(0);

    const controller = new AbortController();
    const abortBeforePost = vi.fn(() => controller.abort(new Error('R4_ABORTED_BEFORE_POST')));
    const abortedAfterReceipt = vi.fn();
    const aborted = await withR4PaidTextContext({
      canonicalTool: 'convert_prompt', signal: controller.signal,
      beforePost: abortBeforePost, afterReceipt: abortedAfterReceipt,
    }, () => invoke('convert_prompt')());
    expect((aborted as { ok: boolean }).ok).toBe(false);
    expect(abortBeforePost).toHaveBeenCalledTimes(1);
    expect(abortedAfterReceipt).not.toHaveBeenCalled();
    expect(server.posts()).toBe(0);
  });

  it('blocks callConvertApi empty-length retry within R4 while retaining legacy workbench retry behavior', async () => {
    const server = await endpoint(['empty_length', 'empty_length', 'ok']);
    await configure(server.url);
    const r4 = await withinR4('convert_prompt', invoke('convert_prompt'));
    expect((r4.value as { ok: boolean }).ok).toBe(false);
    expect(server.posts()).toBe(1);
    expect(r4.beforePost).toHaveBeenCalledTimes(1);
    expect(r4.afterReceipt).toHaveBeenCalledTimes(1);
    expect(r4.state).toMatchObject({ canonicalTool: 'convert_prompt', attempted: true, receipt: { certainty: 'received', httpStatus: 200 } });

    const legacy = await invoke('convert_prompt')();
    expect((legacy as { ok: boolean }).ok).toBe(true);
    expect(server.posts()).toBe(3);
  });

  it.each(services)('%s sends one POST when template validation asks for a paid correction', async tool => {
    const server = await endpoint(['invalid', 'invalid', 'invalid']);
    await configure(server.url, tool === 'reverse_prompt'
      ? { reversePromptTemplates: { natural: '', tags: '计数口径：2–3 个有效 Tag。', mixed: '' } }
      : { convertPromptTemplatesV45: { natural: '', tags: '', mixed: '有效语义单元 1–3；Tag 70%。' } });
    const work = tool === 'reverse_prompt'
      ? () => nai.reversePromptImage(imageBase64, 'tags', 'full', '', false, 'v5')
      : tool === 'convert_prompt'
        ? () => nai.convertPromptText('一名女孩站在安静的房间里', 'mixed', false, 'v4.5')
        : () => nai.convertPromptText('one girl in a quiet room', 'mixed', false, 'v4.5', { kind: 'custom', instruction: 'Keep the subject and scene.' });
    const result = await withinR4(tool, work);
    expect((result.value as { ok: boolean }).ok).toBe(false);
    expect(result.state.receipt).toMatchObject({ certainty: 'received', httpStatus: 200 });
    expect(result.beforePost).toHaveBeenCalledTimes(1);
    expect(result.afterReceipt).toHaveBeenCalledTimes(1);
    expect(server.posts()).toBe(1);
  });

  it.each(services)('%s completes a normal response with one receipt callback', async tool => {
    const server = await endpoint(['ok']);
    await configure(server.url);
    const result = await withinR4(tool, invoke(tool));
    expect((result.value as { ok: boolean }).ok).toBe(true);
    expect(result.state).toMatchObject({ attempted: true, receipt: { certainty: 'received', httpStatus: 200 } });
    expect(result.afterReceipt).toHaveBeenCalledTimes(1);
    expect(server.posts()).toBe(1);
  });

  it.each(services)('%s keeps a connection loss as unknown and never retries it', async tool => {
    const server = await endpoint(['drop', 'ok', 'ok']);
    await configure(server.url);
    const result = await withinR4(tool, invoke(tool));
    expect((result.value as { ok: boolean }).ok).toBe(false);
    expect(result.state).toMatchObject({ attempted: true, receipt: { certainty: 'unknown', rawStatus: 'transport_unknown' } });
    expect(result.afterReceipt).toHaveBeenCalledTimes(1);
    expect(server.posts()).toBe(1);
  });
});

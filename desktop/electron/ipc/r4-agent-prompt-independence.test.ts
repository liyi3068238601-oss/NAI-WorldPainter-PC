import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentWorkspaceData } from '../../src/agent/types';
import { DEFAULT_PARAMS, type AppSettings } from '../../src/types';
import {NAI_RELAY_MODEL_IDS} from '../../src/nai-accounts';
import { AgentSqlStore } from './r4-store';

const fixture = vi.hoisted(() => ({ dir: '', store: null as AgentSqlStore | null, settings: null as AppSettings | null }));
vi.mock('./agent-workspace-location', () => ({ agentWorkspaceDirectory: () => fixture.dir }));
vi.mock('./agent-store', () => ({
  getAgentSqlStore: () => fixture.store,
  readAgentWorkspace: () => fixture.store!.readWorkspace(),
}));
vi.mock('./store', () => ({
  getSettings: () => fixture.settings,
  getToken: () => 'fixture-token',
  getHistory: () => [],
  getAccountSummary: () => ({ hasToken: true, tierLevel: 0, hasActiveSubscription: false }),
}));
vi.mock('./nai-accounts-runtime', () => ({ currentNaiAccount: () => ({ id: 'fixture-account', method: 'relay' }) }));
vi.mock('./local-media-protocol', () => ({ toLocalMediaUrl: (file: string) => `local:${path.basename(file)}` }));
vi.mock('../../src/agent/provider-profiles', () => ({
  getAgentProviderRegistry: () => ({ activeProviderId: 'text-provider', providers: [{
    id: 'text-provider', protocol: 'openai-compatible', baseUrl: 'https://fixture.invalid/v1', modelId: 'fixture-model', models: [],
  },{id:'provider-b',protocol:'anthropic-messages',baseUrl:'https://other.invalid',apiKey:'public-fixture-key-b',modelId:'model-b',models:[{id:'model-b',contextWindow:64000,maxOutputTokens:2048,vision:true,reasoningEffort:'high'}]}] }),
}));
vi.mock('../../src/agent/workspace-controls', () => ({
  studioSessionOptions: () => ({ presetId: 'fixture-assistant-preset', templateEnabled: false, approvalMode: 'auto', webSearchEnabled: false }),
  STUDIO_BUILTIN_PRESETS: [{ id: 'fixture-assistant-preset', body: 'fixture assistant preset' }],
  studioSelectedSystemPrompt: () => '',
}));
vi.mock('./harness-prompt-templates', async importOriginal => ({
  ...await importOriginal<typeof import('./harness-prompt-templates')>(),
  templateSelection: () => undefined,
}));

import { captureR4ConversationConfig,getR4CreativeHost } from './r4-agent-service';

const tempRoot = path.resolve(process.cwd(), '.tmp', 'r4-agent-prompt-tests');
let fixtureRoot = '';

beforeEach(() => {
  fs.mkdirSync(tempRoot, { recursive: true });
  fixtureRoot = fs.mkdtempSync(path.join(tempRoot, 'case-'));
  fixture.dir = fixtureRoot;
  fixture.settings = {
    ...({} as AppSettings),
    agentApiProtocol: 'openai-compatible', agentApiBaseUrl: 'https://fixture.invalid/v1', agentApiKey: 'fixture-key', agentApiModel: 'fixture-model',
    agentVisionEnabled: false, agentContextWindow: 128_000, agentMaxOutputTokens: 4096, agentReasoningEffort: 'auto',
    agentAutoCompact: false, agentAutoCompactThreshold: 0.8, imageProvider: 'novelai', outputDir: fixtureRoot,
    proxyMode: 'direct', proxyUrl: '', modelMode: 'anime', generationGroupId: '',
    lastGenerationState: { params: {
      ...DEFAULT_PARAMS, positivePrompt: 'workbench-positive-lock', negativePrompt: 'workbench-negative-lock', stylePrompt: 'workbench-style-lock',
    } },
    lockNegativePrompt: true, savedNegativePrompt: 'saved-negative-lock', lockStylePrompt: true, savedStylePrompt: 'saved-style-lock',
  } as AppSettings;
  const workspace = {
    version: 4,
    conversations: [{ id: 'chat', title: 'fixture', messages: [], draftAttachments: [], status: 'idle', characterIds: [], lorebookIds: [], selectedSkillIds: [],
      studioApprovalMode: 'auto', compactCount: 0 }],
    characters: [], personas: [], lorebooks: [], skills: [], memories: [], samplerPresets: [],
    defaultGenerationMode: 'confirm', updatedAt: new Date().toISOString(),
  } as unknown as AgentWorkspaceData;
  fixture.store = new AgentSqlStore({
    filename: path.join(fixtureRoot, 'agent.sqlite'), legacyFiles: [],
    loadInitialState: () => ({ workspace }),
    normalizeWorkspace: value => structuredClone(value) as AgentWorkspaceData,
  });
});

afterEach(() => {
  fixture.store?.close();
  fixture.store = null;
  const relative = path.relative(tempRoot, fixtureRoot);
  if (!relative || relative.startsWith('..')) throw new Error('Refusing cleanup outside R4 prompt fixture root.');
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = '';
});

describe('R4 assistant prompt is independent from workbench retained prompts', () => {
  it('prepares the exact assistant-supplied prompts and empty omitted negative/style values', async () => {
    const host = getR4CreativeHost();
    const state = host.read('chat');
    const result = await host.invoke('prepare_generation', {
      positivePrompt: 'assistant chose this scene', count: 1,
    }, {
      conversationId: 'chat', creationId: state.currentCreationId!, userIntentRef: 'intent-1', operationKey: 'prepare-1',
      inputCursor: { inputRevision: 0 },
    });

    expect(result).toMatchObject({ resultKind: 'business', status: 'completed' });
    const data = result.data as { preparationId: string; preview: Record<string, unknown> };
    const preparation = fixture.store!.readR4State().preparations[data.preparationId]!;
    const params = preparation.inputSnapshot.publicParameters.params as Record<string, unknown>;
    expect(preparation.inputSnapshot.positivePrompt).toBe('assistant chose this scene');
    expect(preparation.inputSnapshot.negativePrompt).toBe('');
    expect(preparation.inputSnapshot.stylePrompt).toBe('');
    expect(params.positivePrompt).toBe('assistant chose this scene');
    expect(params.negativePrompt).toBe('');
    expect(params.stylePrompt).toBe('');
    expect(data.preview).toMatchObject({ positivePrompt: 'assistant chose this scene', negativePrompt: '', stylePrompt: '' });
    expect(JSON.stringify(preparation.inputSnapshot)).not.toContain('workbench-');
    expect(JSON.stringify(preparation.inputSnapshot)).not.toContain('saved-');
  });

  it('keeps history readable with an unknown preset but blocks send and generation preparation', async () => {
    fixture.store!.transaction(tx => {
      const state = tx.getR4State();
      state.assistantPresetDefaultBinding = { presetId: 'missing-preset', enabled: false };
      tx.setR4State(state);
      const workspace = tx.getWorkspace();
      workspace.conversations[0].messages.push({
        id: 'legacy-message', role: 'user', content: 'synthetic readable history', attachments: [], tools: [], status: 'complete',
        createdAt: new Date().toISOString(),
      } as AgentWorkspaceData['conversations'][number]['messages'][number]);
      tx.setWorkspace(workspace);
    });

    const host = getR4CreativeHost();
    const state = host.read('chat');
    expect(state.configurationIssue).toMatch(/预设绑定需要修复/);
    expect(state.messageCreationIds['legacy-message']).toBeTruthy();
    const read = await host.invoke('read_creation', {}, {
      conversationId: 'chat', creationId: state.currentCreationId!, userIntentRef: 'intent-repair', operationKey: 'read-repair',
    });
    expect(read).toMatchObject({ resultKind: 'business', data: { readStatus: 'ok' } });

    const { R4AgentRuntime } = await import('./r4-agent-runtime');
    const completeTurn = vi.fn(async () => ({ content: 'should not run' }));
    const runtime = new R4AgentRuntime({
      emit: vi.fn(), activeRequests: new Map(), approvals: {} as never, images: messages => messages,
      smoothEmitter: () => ({ push: vi.fn(), flush: vi.fn() }), completeTurn: completeTurn as never,
    });
    expect(runtime.send({ conversationId: 'chat', text: 'synthetic blocked send' })).toMatchObject({ ok: false });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(completeTurn).not.toHaveBeenCalled();
    await expect(host.invoke('prepare_generation', { positivePrompt: 'synthetic blocked preview', count: 1 }, {
      conversationId: 'chat', creationId: state.currentCreationId!, userIntentRef: 'intent-repair', operationKey: 'prepare-repair',
    })).rejects.toThrow(/修复/);
    expect(Object.keys(fixture.store!.readR4State().preparations)).toHaveLength(0);
  });
  it('overrides retained compatible-service negative words with the AI supplied value, including empty',async()=>{
    fixture.settings!.imageProvider='openai-images';fixture.settings!.imageApiKey='fixture-image-key';
    fixture.settings!.compatibleImage={baseUrl:'https://image.invalid/v1',model:NAI_RELAY_MODEL_IDS[0],size:'1024x1024',extensions:{negative_prompt:'retained-service-negative',steps:28}};
    const host=getR4CreativeHost(),state=host.read('chat');
    for(const [index,negativePrompt] of ['', 'AI negative words'].entries()){
      const result=await host.invoke('prepare_generation',{positivePrompt:'AI positive words',...(negativePrompt?{negativePrompt}:{}),count:1},{conversationId:'chat',creationId:state.currentCreationId!,userIntentRef:`intent-${index}`,operationKey:`prepare-compatible-${index}`});
      const prepared=fixture.store!.readR4State().preparations[String((result.data as any).preparationId)];
      expect(prepared.inputSnapshot.negativePrompt).toBe(negativePrompt);
      expect((prepared.inputSnapshot.publicParameters.compatibleConfig as any).extensions).toEqual({negative_prompt:negativePrompt,steps:28});
      expect(JSON.stringify(prepared)).not.toContain('retained-service-negative');
    }
    expect(fixture.settings!.compatibleImage.extensions!.negative_prompt).toBe('retained-service-negative');
  });
  it('freezes the selected provider/model capabilities and old preset body while future previews refresh',async()=>{
    const host=getR4CreativeHost(),initial=host.read('chat');
    fixture.store!.transaction(tx=>{const state=tx.getR4State();state.assistantPresets['shared']={id:'shared',name:'Shared',body:'first body',revision:1,hash:'first hash',updatedAt:new Date().toISOString()};state.conversations.chat.assistantPresetBinding={presetId:'shared',enabled:true};delete state.conversations.chat.config;tx.setR4State(state);});
    const frozen=captureR4ConversationConfig(fixture.store!.readWorkspace(),fixture.store!.readR4State(),'chat','message_send');
    expect((await host.command({conversationId:'chat',type:'set_model_binding',args:{providerId:'provider-b',modelId:'model-b'}})).ok).toBe(true);
    expect((await host.command({conversationId:'chat',type:'update_preset',args:{presetId:'shared',expectedRevision:1,body:'second body'}})).ok).toBe(true);
    const current=host.read('chat');
    expect(current.config).toMatchObject({providerRef:{providerId:'provider-b'},modelId:'model-b',body:'second body',revision:2,publicParameters:{contextWindow:64000,maxOutputTokens:2048,visionEnabled:true,reasoningEffort:'high'}});
    const oldPreview=await host.invoke('prepare_generation',{positivePrompt:'frozen request'}, {conversationId:'chat',creationId:initial.currentCreationId!,userIntentRef:'old-message',operationKey:'old-preview',conversationConfig:frozen,inputCursor:{inputRevision:0}});
    const original=fixture.store!.readR4State().preparations[String((oldPreview.data as any).preparationId)];
    expect(original.conversationConfig).toMatchObject({modelId:'fixture-model',body:'first body',revision:1});
    expect(frozen.body).toBe('first body');
  });
});

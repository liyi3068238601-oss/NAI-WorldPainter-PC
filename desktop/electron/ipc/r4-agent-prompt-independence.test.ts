import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentWorkspaceData } from '../../src/agent/types';
import { DEFAULT_PARAMS, type AppSettings } from '../../src/types';
import {NAI_RELAY_MODEL_IDS} from '../../src/nai-accounts';
import { AgentSqlStore } from './r4-store';

const fixture = vi.hoisted(() => ({ dir: '', store: null as AgentSqlStore | null, settings: null as AppSettings | null, workbench: null as any, providerSubmissions: [] as any[] }));
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
vi.mock('./r4-workbench',()=>({getR4WorkbenchService:()=>({readR4WorkbenchSnapshot:async()=>structuredClone(fixture.workbench),publishCompletedResults:async()=>{}})}));
vi.mock('./r4-image-provider',()=>({R4ImageProvider:class {async submit(execution:any){fixture.providerSubmissions.push(structuredClone(execution));return {requestDisposition:'not_sent',outputs:[]};}}}));
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
  fixture.providerSubmissions=[];
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
  fixture.workbench={draftId:'workbench-fixture',draftRevision:1,inputRevision:1,draftSource:'workbench',
    params:{...DEFAULT_PARAMS,positivePrompt:'workbench-positive-lock',negativePrompt:'workbench-negative-lock',stylePrompt:'workbench-style-lock'},
    workbench:{mode:'generate:t2i',historyGroupId:'live-generation-group',batchCount:1,batchIntervalSeconds:0,charCaptions:[],vibeImages:[],preciseReferences:[],
      busy:{isGenerating:false,isGenerateQueueRunning:false,batchRunning:false}}};
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
  it('creates a validated user preset once and keeps its exact body hash',async()=>{
    const host=getR4CreativeHost();host.read('chat');
    const result=await host.command({conversationId:'chat',type:'create_preset',operationId:'create-preset-once',args:{presetId:'new-preset',name:'  New preset  ',body:'\n prompt body \n'}});
    expect(result).toMatchObject({ok:true,data:{presetId:'new-preset'}});
    const created=fixture.store!.readR4State().assistantPresets['new-preset'];
    expect(created).toMatchObject({id:'new-preset',name:'New preset',body:'\n prompt body \n',revision:1,source:'user'});
    expect(created.hash).toBe(createHash('sha256').update('\n prompt body \n').digest('hex'));
    expect(await host.command({conversationId:'chat',type:'create_preset',operationId:'create-preset-once',args:{presetId:'new-preset',name:'New preset',body:'\n prompt body \n'}})).toMatchObject({ok:true,data:{presetId:'new-preset'}});
    expect(fixture.store!.readR4State().assistantPresets['new-preset'].revision).toBe(1);
    expect(await host.command({conversationId:'chat',type:'create_preset',args:{presetId:'new-preset',name:'Different',body:'different body'}})).toMatchObject({ok:false,message:expect.stringMatching(/已存在/)});
    expect(await host.command({conversationId:'chat',type:'create_preset',args:{presetId:'empty-body',name:'Empty body',body:' \n\t '}})).toMatchObject({ok:false});
    expect(fixture.store!.readR4State().assistantPresets['empty-body']).toBeUndefined();
  });

  it('allows editing built-ins with revision CAS while retaining revision history and queued config snapshots',async()=>{
    const initialConfig={version:1 as const,providerRef:{providerId:'text-provider'},modelId:'fixture-model',presetId:'fixture-assistant-preset',enabled:true,body:'fixture assistant preset',revision:1,hash:createHash('sha256').update('fixture assistant preset').digest('hex'),publicParameters:{},capturedAt:new Date().toISOString(),source:'message_send' as const};
    getR4CreativeHost().read('chat');
    fixture.store!.transaction(tx=>{
      const state=tx.getR4State();
      state.assistantPresets['fixture-assistant-preset']={id:'fixture-assistant-preset',name:'Fixture built-in',body:'fixture assistant preset',revision:1,hash:initialConfig.hash,source:'builtin'};
      state.conversations.chat.assistantPresetBinding={presetId:'fixture-assistant-preset',enabled:true};
      state.conversations.chat.config=structuredClone(initialConfig);
      state.messageQueue['queued-snapshot']={id:'queued-snapshot',conversationId:'chat',conversationConfig:structuredClone(initialConfig)} as never;
      tx.setR4State(state);
    });
    const result=await getR4CreativeHost().command({conversationId:'chat',type:'update_preset',args:{presetId:'fixture-assistant-preset',expectedRevision:1,name:'Edited built-in',body:'updated body'}});
    expect(result.ok).toBe(true);
    const state=fixture.store!.readR4State(),edited=state.assistantPresets['fixture-assistant-preset'];
    expect(edited).toMatchObject({name:'Edited built-in',body:'updated body',revision:2,source:'builtin'});
    expect(edited.hash).toBe(createHash('sha256').update('updated body').digest('hex'));
    expect(state.compatibility.presetRevisionHistory).toMatchObject({'fixture-assistant-preset@1':{body:'fixture assistant preset',revision:1,source:'builtin'}});
    expect(state.messageQueue['queued-snapshot'].conversationConfig).toEqual(initialConfig);
    expect(await getR4CreativeHost().command({conversationId:'chat',type:'update_preset',args:{presetId:'fixture-assistant-preset',expectedRevision:1,name:'Stale edit',body:'stale body'}})).toMatchObject({ok:false,message:expect.stringMatching(/已更新/)});
    expect(fixture.store!.readR4State().assistantPresets['fixture-assistant-preset']).toMatchObject({body:'updated body',revision:2});
  });

  it('prepares empty arguments from the exact live Generate workbench snapshot', async () => {
    const host = getR4CreativeHost();
    const state = host.read('chat');
    const result = await host.invoke('prepare_generation', {}, {
      conversationId: 'chat', creationId: state.currentCreationId!, userIntentRef: 'intent-1', operationKey: 'prepare-1',
      inputCursor: { inputRevision: 0 },
    });

    expect(result).toMatchObject({ resultKind: 'business', status: 'completed' });
    const data = result.data as { preparationId: string; preview: Record<string, unknown> };
    const preparation = fixture.store!.readR4State().preparations[data.preparationId]!;
    const params = preparation.inputSnapshot.publicParameters.params as Record<string, unknown>;
    expect(preparation.inputSnapshot.positivePrompt).toBe('workbench-positive-lock');
    expect(preparation.inputSnapshot.negativePrompt).toBe('workbench-negative-lock');
    expect(preparation.inputSnapshot.stylePrompt).toBe('workbench-style-lock');
    expect(params.positivePrompt).toBe('workbench-positive-lock');
    expect(params.negativePrompt).toBe('workbench-negative-lock');
    expect(params.stylePrompt).toBe('workbench-style-lock');
    expect(data.preview).toMatchObject({ positivePrompt: 'workbench-positive-lock', negativePrompt: 'workbench-negative-lock', stylePrompt: 'workbench-style-lock' });
    expect(preparation.inputSnapshot.publicParameters.workbenchDraftId).toBe('workbench-fixture');
    expect(preparation.inputSnapshot.publicParameters.historyGroupId).toBe('live-generation-group');
    expect(preparation.inputSnapshot.publicParameters.workbenchMode).toBe('generate:t2i');
    expect(preparation.inputSnapshot.publicParameters.count).toBe(1);
    expect(JSON.stringify(preparation.inputSnapshot)).not.toContain('settings.lastGenerationState');
    expect(JSON.stringify(preparation.inputSnapshot)).not.toContain('saved-');
  });

  it('rejects approval after the live workbench changes without creating an execution',async()=>{
    const host=getR4CreativeHost(),state=host.read('chat');
    const prepared=await host.invoke('prepare_generation',{}, {conversationId:'chat',creationId:state.currentCreationId!,userIntentRef:'stale-workbench',operationKey:'stale-preview'});
    const data=prepared.data as {preparationId:string;inputFingerprint:string};
    fixture.workbench={...fixture.workbench,draftRevision:2,inputRevision:2,params:{...fixture.workbench.params,positivePrompt:'manual edit after preview'}};
    const approval=await host.command({conversationId:'chat',creationId:state.currentCreationId!,type:'approve_generation',operationId:'stale-approval',args:{preparationId:data.preparationId,fingerprint:data.inputFingerprint}});
    expect(approval).toMatchObject({ok:false,message:expect.stringMatching(/工作台已变化/)});
    expect(fixture.store!.readR4State().executions).toEqual({});
    expect(fixture.providerSubmissions).toHaveLength(0);
  });

  it('prepares changed model, wide dimensions, sampling, seed and batch from the live parameter draft',async()=>{
    const host=getR4CreativeHost(),state=host.read('chat');
    fixture.workbench={...fixture.workbench,draftRevision:9,inputRevision:9,
      params:{...fixture.workbench.params,model:'nai-diffusion-4-5-full',width:3072,height:1024,steps:35,cfgScale:5,cfgRescale:.3,
        sampler:'k_euler',noiseSchedule:'native',seed:0xffffffff,seedMode:'fixed'},
      workbench:{...fixture.workbench.workbench,batchCount:3,batchIntervalSeconds:4}};
    const prepared=await host.invoke('prepare_generation',{}, {conversationId:'chat',creationId:state.currentCreationId!,userIntentRef:'parameter-edit',operationKey:'parameter-preview'});
    expect(prepared).toMatchObject({resultKind:'business',data:{preview:{model:'nai-diffusion-4-5-full',width:3072,height:1024,count:3,requestedSeed:0xffffffff,batchIntervalSeconds:4}}});
    const data=prepared.data as {preparationId:string};
    const frozen=fixture.store!.readR4State().preparations[data.preparationId].inputSnapshot.publicParameters;
    expect(frozen).toMatchObject({count:3,batchIntervalSeconds:4,workbenchDraftRevision:9,params:{steps:35,cfgScale:5,cfgRescale:.3,sampler:'k_euler',noiseSchedule:'native',seed:0xffffffff,seedMode:'fixed'}});
    fixture.workbench.params.steps=20;fixture.workbench.workbench.batchCount=1;
    expect(fixture.store!.readR4State().preparations[data.preparationId].inputSnapshot.publicParameters).toEqual(frozen);
    expect(fixture.providerSubmissions).toEqual([]);
  });

  it('enqueues the previewed snapshot after approval and ignores later live workbench edits',async()=>{
    const host=getR4CreativeHost(),state=host.read('chat');
    const prepared=await host.invoke('prepare_generation',{}, {conversationId:'chat',creationId:state.currentCreationId!,userIntentRef:'approved-workbench',operationKey:'approved-preview'});
    const data=prepared.data as {preparationId:string;inputFingerprint:string};
    const approval=await host.command({conversationId:'chat',creationId:state.currentCreationId!,type:'approve_generation',operationId:'approved-enqueue',args:{preparationId:data.preparationId,fingerprint:data.inputFingerprint}});
    expect(approval.ok).toBe(true);
    fixture.workbench={...fixture.workbench,draftRevision:2,inputRevision:2,params:{...fixture.workbench.params,positivePrompt:'new words after enqueue'}};
    await vi.waitFor(()=>expect(fixture.providerSubmissions).toHaveLength(1));
    const dispatched=fixture.providerSubmissions[0];
    expect(dispatched.approvedInput.positivePrompt).toBe('workbench-positive-lock');
    expect(dispatched.approvedInput.publicParameters).toMatchObject({workbenchDraftId:'workbench-fixture',workbenchDraftRevision:1,historyGroupId:'live-generation-group',workbenchMode:'generate:t2i'});
    expect(dispatched.expectedOutputCount).toBe(1);
    expect(fixture.providerSubmissions).toHaveLength(1);
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
      fixture.workbench={...fixture.workbench,params:{...fixture.workbench.params,positivePrompt:'AI positive words',negativePrompt,stylePrompt:''}};
      const result=await host.invoke('prepare_generation',{}, {conversationId:'chat',creationId:state.currentCreationId!,userIntentRef:`intent-${index}`,operationKey:`prepare-compatible-${index}`});
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
    fixture.workbench={...fixture.workbench,params:{...fixture.workbench.params,positivePrompt:'frozen request'}};
    const oldPreview=await host.invoke('prepare_generation',{}, {conversationId:'chat',creationId:initial.currentCreationId!,userIntentRef:'old-message',operationKey:'old-preview',conversationConfig:frozen,inputCursor:{inputRevision:0}});
    const original=fixture.store!.readR4State().preparations[String((oldPreview.data as any).preparationId)];
    expect(original.conversationConfig).toMatchObject({modelId:'fixture-model',body:'first body',revision:1});
    expect(frozen.body).toBe('first body');
  });
});

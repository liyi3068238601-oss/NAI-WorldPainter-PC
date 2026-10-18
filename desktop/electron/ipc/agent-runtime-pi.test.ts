import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fixture = vi.hoisted(() => ({
  workspace: null as any, r4: null as any, host: null as any, store: null as any,
  turn: vi.fn(),
  summary: vi.fn(),
  settings: { agentAutoCompact: false, agentAutoCompactThreshold: 0.8, agentContextWindow: 8192 },
}));
vi.mock('./store', () => ({ getToken:()=>'',getHistory:()=>[],getSettings: () => ({
  agentApiBaseUrl: 'https://fixture.invalid/v1', agentApiModel: 'fixture',
  agentApiKey: 'fixture-key', agentApiProtocol: 'openai-compatible',
  agentVisionEnabled: false, ...fixture.settings,
}) }));
vi.mock('./agent-store', () => ({
  getAgentSqlStore:()=>fixture.store,
  readAgentWorkspace: () => structuredClone(fixture.workspace),
  updateAgentConversation: (id: string, update: (chat: any) => void) => {
    const chat = fixture.workspace.conversations.find((item: any) => item.id === id);
    if (chat) update(chat);
  },
}));
vi.mock('./r4-agent-service',()=>({
 getR4CreativeHost:()=>fixture.host,getR4ExecutionCoordinator:()=>({worker:{recover:()=>{}}}),
 prepareR4ImageOperation:vi.fn(),setR4AdditionalCommand:vi.fn(),onR4CreativeChanged:()=>()=>{},hasActiveR4Executions:()=>false,
 captureR4ConversationConfig:()=>({version:1,providerRef:{providerId:'fixture'},modelId:'fixture',presetId:'fixture-preset',enabled:true,body:'frozen task system preset',revision:1,hash:'fixture',
  publicParameters:{visionEnabled:(fixture.settings as any).agentVisionEnabled===true,autoCompact:fixture.settings.agentAutoCompact,autoCompactThreshold:fixture.settings.agentAutoCompactThreshold,contextWindow:fixture.settings.agentContextWindow},capturedAt:new Date().toISOString(),source:'message_send'}),
 settingsForR4Config:(config:any)=>({agentApiBaseUrl:'https://fixture.invalid/v1',agentApiModel:config.modelId,agentApiKey:'fixture-key',agentApiProtocol:'openai-compatible',...fixture.settings,
  agentVisionEnabled:config.publicParameters.visionEnabled,agentAutoCompact:config.publicParameters.autoCompact,agentAutoCompactThreshold:config.publicParameters.autoCompactThreshold,agentContextWindow:config.publicParameters.contextWindow}),
}));
vi.mock('./pi-agent-turn', () => ({ completeStudioPiTurn: fixture.turn, completeStudioPiSummary: fixture.summary }));
vi.mock('./agent-tools', () => ({ executeAgentTool: vi.fn() }));
vi.mock('./proxy', () => ({ proxyConfig: () => ({}) }));
vi.mock('./worldpainter-knowledge', () => ({ worldpainterKnowledgeContext: async () => ({ prompt: 'bounded-fixture-knowledge', version: 'v45' }) }));
import { compactAgentConversation, sendAgentMessage as enqueueAgentMessage, getAgentPendingPermissions, respondAgentPermission, abortAgentMessage, hasActiveAgentRequests, stopAgentRuntime, setAgentEventSink } from './agent-runtime';

import {R4CreativeHost} from './r4-creative-host';
import {createEmptyR4AgentState} from '../../src/agent/r4-types';
import {captureR4ConversationConfig} from './r4-agent-service';

// These outgoing-payload/streaming regressions use an explicit in-memory store
// double. Real SQLite queue/CAS/restart coverage is in r4-conversation-queue.
async function sendAgentMessage(request:any){
 const accepted=await enqueueAgentMessage(request);if(!accepted.ok)return accepted;
 const row=Object.values(fixture.r4.messageQueue).find((row:any)=>row.messageId===(accepted as any).messageId) as any;
 await vi.waitFor(()=>expect(['completed','error','cancelled'].includes(row.status)||row.status==='paused'&&!row.startedAt).toBe(true));
 return row.status==='completed'?{ok:true}:{ok:false,message:row.pauseReason};
}
afterEach(()=>{stopAgentRuntime();});
beforeEach(() => {
  delete process.env.LANGBAI_PI_AGENT;
  fixture.workspace = { memories:[],personas:[],characters: [], lorebooks: [], samplerPresets: [], skills: [], conversations: [{
    id: 'studio', title: '新对话', messages: [], characterIds: [], lorebookIds: [], draftAttachments: [], status: 'idle', compactCount: 0,
  }] };
  fixture.r4=createEmptyR4AgentState();
  fixture.store={readWorkspace:()=>structuredClone(fixture.workspace),readR4State:()=>structuredClone(fixture.r4),transaction:(work:any)=>work({
   getWorkspace:()=>fixture.workspace,setWorkspace:(value:any)=>{fixture.workspace=value;},getR4State:()=>fixture.r4,setR4State:(value:any)=>{fixture.r4=value;}
  })};
  fixture.host=new R4CreativeHost(fixture.store,{captureConfig:captureR4ConversationConfig,resolveAttachment:()=>{throw Error('not used in this unit fixture');}});
  stopAgentRuntime();
  fixture.settings.agentAutoCompact = false;
  fixture.settings.agentVisionEnabled = false;
  fixture.summary.mockReset();
  fixture.turn.mockReset();
});

it('defaults to Pi without requiring a Tavern character or sampler', async () => {
  fixture.turn.mockResolvedValue({ content: '已整理提示词。', reasoning: '',
    usage: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 } });
  const result = await sendAgentMessage({ conversationId: 'studio', text: '整理猫的提示词' });
  expect(result.ok).toBe(true);
  expect(fixture.turn).toHaveBeenCalledTimes(1);
  expect(fixture.turn.mock.calls[0][0].sessionOptions).toMatchObject({ approvalMode: 'confirm' });
  expect(fixture.turn.mock.calls[0][0].worldpainterKnowledge).toEqual({prompt:'bounded-fixture-knowledge',version:'v45'});
  const prompt = fixture.turn.mock.calls[0][0].prompt;
  expect(prompt.at(-1)).toMatchObject({ role: 'user', content: '整理猫的提示词' });
  expect(fixture.workspace.conversations[0].messages.at(-1)).toMatchObject({
    role: 'assistant', content: '已整理提示词。', status: 'complete',
  });
});

it('keeps an explicitly saved full-auto choice for Pi turns', async () => {
  fixture.workspace.conversations[0].studioApprovalMode = 'auto';
  fixture.turn.mockResolvedValue({ content: '已整理提示词。', reasoning: '', usage: {} });
  const result = await sendAgentMessage({ conversationId: 'studio', text: '整理猫的提示词' });
  expect(result.ok).toBe(true);
  expect(fixture.turn.mock.calls[0][0].sessionOptions).toMatchObject({ approvalMode: 'auto' });
});

it('persists the final result instead of intermediate promises and never invents empty-turn success', async()=>{
  for (const final of ['已完成查词，来源见工具记录。','']) {
    fixture.turn.mockImplementation(async(options)=>{
      options.onText('我会马上生成图片。');
      return {content:final,reasoning:'',usage:{}};
    });
    expect((await sendAgentMessage({conversationId:'studio',text:'仅检查词条'})).ok).toBe(true);
    const reply=fixture.workspace.conversations[0].messages.at(-1);
    expect(reply.content).toBe(final||'本轮未返回最终说明，请查看操作回执。');
    expect(reply.content).not.toContain('我会马上生成');
  }
});

it('flushes streamed text before tool snapshots so the renderer never appends it twice',async()=>{
  let rendered:any;
  const contents:string[]=[];
  setAgentEventSink(event=>{
    if(event.kind==='workspace')rendered=structuredClone(event.workspace);
    if(event.kind==='message-delta'){
      const message=rendered?.conversations[0].messages.find((item:any)=>item.id===event.messageId);
      if(message)message.content+=event.delta;
    }
    const reply=rendered?.conversations[0].messages.at(-1);
    if(reply?.role==='assistant')contents.push(reply.content);
  });
  try{
    fixture.turn.mockImplementation(async options=>{
      options.onText('准备读取设置。');
      options.onTool({id:'read',name:'read',title:'读取',status:'pending'});
      await new Promise(resolve=>setTimeout(resolve,45));
      options.onTool({id:'read',name:'read',title:'读取',status:'completed',output:'read result'});
      return {content:'已读取设置。',reasoning:'',usage:{}};
    });
    expect((await sendAgentMessage({conversationId:'studio',text:'检查设置'})).ok).toBe(true);
    expect(contents).toContain('准备读取设置。');
    expect(contents).not.toContain('准备读取设置。准备读取设置。');
    expect(contents.at(-1)).toBe('已读取设置。');
  }finally{setAgentEventSink(()=>{});}
});

it('sends Skill summaries only, resolves bodies freshly, keeps presets and excludes legacy worldbooks',async()=>{
  const chat=fixture.workspace.conversations[0];
  chat.selectedSkillIds=['selected'];chat.lorebookIds=['legacy'];
  fixture.workspace.skills=[{id:'selected',name:'绘世查词',description:'用于查词',enabled:true,instructions:'SKILL_BODY_SENTINEL'}];
  fixture.workspace.lorebooks=[{id:'legacy',name:'WORLD_BOOK_SENTINEL',entries:[{id:'entry',content:'WORLD_BODY_SENTINEL',enabled:true,constant:true}]}];
  fixture.turn.mockImplementation(async options=>{
    expect(options.skillDirectory).toEqual([{id:'selected',name:'绘世查词',description:'用于查词'}]);
    expect(options.resourceContext).not.toContain('WORLD_');
    expect(options.configuredSystemPrompt).toBeTruthy();
    expect(JSON.stringify(options.prompt)).not.toContain('SKILL_BODY_SENTINEL');
    expect(options.readSkill('selected').instructions).toBe('SKILL_BODY_SENTINEL');
    fixture.workspace.skills[0].instructions='fresh body';
    expect(options.readSkill('selected').instructions).toBe('fresh body');
    fixture.workspace.skills[0].enabled=false;
    expect(options.readSkill('selected')).toBeNull();
    return {content:'done',reasoning:'',usage:{}};
  });
  expect((await sendAgentMessage({conversationId:'studio',text:'查词'})).ok).toBe(true);
  expect(fixture.workspace.lorebooks[0].name).toBe('WORLD_BOOK_SENTINEL');
});

it('persists a tool result and generated image without legacy proposal parsing', async () => {
  fixture.turn.mockImplementation(async (options) => {
    options.onTool({ id: 'tool-1', name: 'langbai_generate_image', title: '生图',
      status: 'completed', generatedImages: [{ id: 'image-1', kind: 'image', name: 'a.png', fileUrl: 'local://a.png' }] });
    return { content: '已生成。', reasoning: '',
      usage: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 2 } };
  });
  const result = await sendAgentMessage({ conversationId: 'studio', text: '生图' });
  expect(result.ok).toBe(true);
  const message = fixture.workspace.conversations[0].messages.at(-1);
  expect(message.tools[0].name).toBe('langbai_generate_image');
  expect(message.attachments[0].id).toBe('image-1');
  expect(message.imageProposal).toBeUndefined();
});

it('persists completed usage and tool receipts when the final Pi model call fails', async () => {
  const usage = { input: 14, output: 3, reasoning: 5, cacheRead: 0, cacheWrite: 0, total: 22 };
  const failure = new Error('Final model request failed');
  Object.defineProperty(failure, 'agentTokenUsage', { value: usage });
  fixture.turn.mockImplementation(async options => {
    options.onTool({ id: 'completed-read', name: 'langbai_get_generation_state', title: '读取状态',
      status: 'completed', output: 'tool receipt saved' });
    throw failure;
  });

  const result = await sendAgentMessage({ conversationId: 'studio', text: '读取状态后汇报' });
  const conversation = fixture.workspace.conversations[0];
  const assistant = conversation.messages.at(-1);
  expect(result).toEqual({ ok: false, message: 'Final model request failed' });
  expect(assistant).toMatchObject({ status: 'error', error: 'Final model request failed', usage });
  expect(assistant.tools).toMatchObject([{ status: 'completed', output: 'tool receipt saved' }]);
  expect(conversation.lastTurnUsage).toEqual(usage);
  expect(conversation.status).toBe('error');
});

it('gives the model bounded current-chat image IDs without requiring vision and omits local paths', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worldpainter-agent-image-'));
  try {
    const filePath = path.join(root, 'source.png');
    fs.writeFileSync(filePath, Buffer.from('synthetic image bytes'));
    fixture.settings.agentVisionEnabled = false;
    fixture.workspace.conversations[0].draftAttachments = [{
      id: 'current-upload', name: `private-folder${path.sep}source.png`, mime: 'image/png',
      size: 21, kind: 'image', filePath, fileUrl: 'local://private-source', createdAt: new Date().toISOString(),
    }];
    fixture.workspace.conversations[0].messages = [{ id: 'foreign-message', role: 'user', content: 'same local message ID',
      attachments: [], tools: [], status: 'complete', createdAt: new Date().toISOString() }];
    fixture.workspace.conversations.push({
      ...fixture.workspace.conversations[0], id: 'other-chat', title: 'other', draftAttachments: [],
      messages: [{ id: 'foreign-message', role: 'user', content: 'foreign',
        attachments: [{ id: 'foreign-secret-id', name: 'foreign.png', mime: 'image/png', size: 1,
          kind: 'image', filePath, fileUrl: 'local://foreign', createdAt: new Date().toISOString() }],
        tools: [], status: 'complete', createdAt: new Date().toISOString() }],
    });
    fixture.turn.mockImplementation(async () => ({ content: '可以放大这张图。', reasoning: '', usage: {} }));

    await sendAgentMessage({ conversationId: 'studio', text: '请放大附件图片' });
    const prompt = fixture.turn.mock.calls[0][0].prompt as Array<{ role: string; content: any }>;
    const content = prompt.at(-1)?.content;
    expect(typeof content).toBe('string');
    expect(content).toContain('current-upload');
    expect(content).toContain('"availableForImageTools":true');
    expect(content).toContain('"visualContext":"not included"');
    expect(content).toContain('"name":"source.png"');
    expect(content).not.toContain(filePath);
    expect(content).not.toContain('local://private-source');
    expect(JSON.stringify(prompt)).not.toContain('foreign-secret-id');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('marks unavailable images explicitly and only sends vision bytes for available listed images', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worldpainter-agent-vision-'));
  try {
    const availablePath = path.join(root, 'available.png');
    fs.writeFileSync(availablePath, Buffer.from('synthetic image bytes'));
    fixture.settings.agentVisionEnabled = true;
    fixture.workspace.conversations[0].draftAttachments = [
      { id: 'available-image', name: 'available.png', mime: 'image/png', size: 21,
        kind: 'image', filePath: availablePath, createdAt: new Date().toISOString() },
      { id: 'missing-image', name: 'missing.png', mime: 'image/png', size: 21,
        kind: 'image', filePath: path.join(root, 'missing.png'), unavailable: 'missing', createdAt: new Date().toISOString() },
    ];
    fixture.turn.mockImplementation(async () => ({ content: '已收到。', reasoning: '', usage: {} }));

    await sendAgentMessage({ conversationId: 'studio', text: '检查这两张图片' });
    const prompt = fixture.turn.mock.calls[0][0].prompt as Array<{ role: string; content: any }>;
    const content = prompt.at(-1)?.content;
    expect(Array.isArray(content)).toBe(true);
    const text = content.find((part: any) => part.type === 'text').text as string;
    expect(text).toContain('"attachmentId":"available-image"');
    expect(text).toContain('"availableForImageTools":true');
    expect(text).toContain('"visualContext":"included"');
    expect(text).toContain('"attachmentId":"missing-image"');
    expect(text).toContain('"availableForImageTools":false');
    expect(text).toContain('"visualContext":"not included"');
    expect(content.filter((part: any) => part.type === 'image_url')).toHaveLength(1);
    expect(JSON.stringify(prompt)).not.toContain(availablePath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('caps provider attachment identities and reports omitted image references', async () => {
  fixture.workspace.conversations[0].draftAttachments = Array.from({ length: 17 }, (_, index) => ({
    id: `image-${index + 1}`, name: `image-${index + 1}.png`, mime: 'image/png', size: 1,
    kind: 'image', filePath: `missing-image-${index + 1}.png`, unavailable: 'missing', createdAt: new Date().toISOString(),
  }));
  fixture.turn.mockImplementation(async () => ({ content: '收到。', reasoning: '', usage: {} }));

  await sendAgentMessage({ conversationId: 'studio', text: '处理附件' });
  const prompt = fixture.turn.mock.calls[0][0].prompt as Array<{ role: string; content: any }>;
  const content = prompt.at(-1)?.content as string;
  expect(content).toContain('"attachmentId":"image-1"');
  expect(content).toContain('"attachmentId":"image-16"');
  expect(content).not.toContain('"attachmentId":"image-17"');
  expect(content).toContain('"omittedImages":1');
});

it('pauses on an application-owned approval and consumes only a one-shot user answer', async () => {
  fixture.workspace.conversations[0].studioApprovalMode = 'confirm';
  let authorized: boolean | undefined;
  fixture.turn.mockImplementation(async (options) => {
    authorized = await options.authorize('langbai_apply_prompt', { positivePrompt: 'cat' }, options.signal);
    return { content: authorized ? '已应用' : '已取消', reasoning: '', usage: {} };
  });
  const turn = sendAgentMessage({ conversationId: 'studio', text: '应用猫的提示词' });
  await vi.waitFor(() => expect(getAgentPendingPermissions()).toHaveLength(1));
  const request = getAgentPendingPermissions()[0];
  expect(fixture.workspace.conversations[0].status).toBe('waiting-permission');
  expect(authorized).toBeUndefined();
  expect(request.metadata).toMatchObject({ positivePrompt: 'cat', paid: false });
  expect(respondAgentPermission(request.id, 'always').ok).toBe(false);
  expect(respondAgentPermission(request.id, 'once').ok).toBe(true);
  expect((await turn).ok).toBe(true);
  expect(authorized).toBe(true);
  expect(getAgentPendingPermissions()).toEqual([]);
  expect(respondAgentPermission(request.id, 'once').ok).toBe(false);
});

it('stopping during confirmation clears the gate without executing the pending tool', async () => {
  fixture.workspace.conversations[0].studioApprovalMode = 'confirm';
  let authorized = false;
  fixture.turn.mockImplementation(async (options) => {
    authorized = await options.authorize('langbai_apply_prompt', { positivePrompt: 'cat' }, options.signal);
    return { content: '', reasoning: '', usage: {} };
  });
  const turn = sendAgentMessage({ conversationId: 'studio', text: '应用提示词' });
  await vi.waitFor(() => expect(getAgentPendingPermissions()).toHaveLength(1));
  const request = getAgentPendingPermissions()[0];
  expect(abortAgentMessage('studio').ok).toBe(true);
  await turn;
  expect(authorized).toBe(false);
  expect(getAgentPendingPermissions()).toEqual([]);
  expect(respondAgentPermission(request.id, 'once').ok).toBe(false);
  expect(fixture.workspace.conversations[0].messages.at(-1).status).toBe('aborted');
});

it('tracks real in-flight Pi turns and stops them without executing pending actions',async()=>{
 fixture.turn.mockImplementation(options=>new Promise(resolve=>{
  options.signal.addEventListener('abort',()=>resolve({content:'',reasoning:'',usage:{}}),{once:true});
 }));
 expect(hasActiveAgentRequests()).toBe(false);
 const turn=sendAgentMessage({conversationId:'studio',text:'整理猫的提示词'});
 await vi.waitFor(()=>expect(hasActiveAgentRequests()).toBe(true));
 stopAgentRuntime();expect(hasActiveAgentRequests()).toBe(false);
 await turn;expect(fixture.workspace.conversations[0].messages.at(-1).status).toBe('aborted');
});

function seedHistory(count = 20) {
  const chat = fixture.workspace.conversations[0];
  chat.messages = Array.from({ length: count }, (_, i) => ({
    id: `old-${i}`, role: i % 2 ? 'assistant' : 'user', content: `record-${i} ` + 'important established detail '.repeat(20),
    status: 'complete', attachments: [], tools: [], createdAt: new Date(1_000 + i * 1_000).toISOString(),
  }));
  fixture.summary.mockResolvedValue({ content: 'Compressed established facts.' });
  fixture.turn.mockResolvedValue({ content: 'Next reply', reasoning: '', usage: {} });
  return chat;
}

it('manual Pi compression keeps history and sends summary plus recent turns, not hidden old content', async () => {
  const chat = seedHistory();
  const before = structuredClone(chat.messages);
  expect((await compactAgentConversation('studio')).ok).toBe(true);
  expect(chat.messages).toEqual(before);
  expect(chat.compactCount).toBe(1);
  expect(chat.lastSummary).toBe('Compressed established facts.');
  expect(chat.context.used).toBeGreaterThan(0);
  expect(fixture.summary.mock.calls[0][0].transcript).toContain('record-0');
  await sendAgentMessage({ conversationId: 'studio', text: 'continue' });
  const prompt = fixture.turn.mock.calls[0][0].prompt;
  expect(prompt.some((m: any) => m.role === 'system' && m.content.includes(chat.lastSummary))).toBe(true);
  expect(JSON.stringify(prompt)).not.toContain('record-0 ');
  expect(JSON.stringify(prompt)).toContain('record-14 ');
  expect(prompt.at(-1).content).toBe('continue');
});

it('auto compacts before the Pi provider turn without consuming draft or deleting old messages', async () => {
  const chat = seedHistory(60);
  const oldIds = chat.messages.map((m: any) => m.id);
  fixture.settings.agentAutoCompact = true;
  expect((await sendAgentMessage({ conversationId: 'studio', text: 'continue' })).ok).toBe(true);
  expect(chat.compactCount).toBe(1);
  expect(chat.messages.slice(0, 60).map((m: any) => m.id)).toEqual(oldIds);
  expect(fixture.turn.mock.calls[0][0].prompt.some((m: any) => m.content === chat.lastSummary)).toBe(true);
});

it('does not silently truncate uncompressed history to forty messages', async () => {
  seedHistory(60);
  await sendAgentMessage({ conversationId: 'studio', text: 'continue' });
  expect(JSON.stringify(fixture.turn.mock.calls[0][0].prompt)).toContain('record-0 ');
});

it('abort during summary never commits fallback or advances the boundary', async () => {
  const chat = seedHistory();
  const before = structuredClone(chat.messages);
  fixture.summary.mockImplementation(({ signal }) => new Promise(resolve => signal.addEventListener('abort', () => resolve({ content: 'late summary' }), { once: true })));
  const pending = compactAgentConversation('studio');
  await vi.waitFor(()=>expect(fixture.summary).toHaveBeenCalledTimes(1));
  expect((await compactAgentConversation('studio')).ok).toBe(false);
  expect((await enqueueAgentMessage({ conversationId: 'studio', text: 'racing' })).ok).toBe(true);
  expect(abortAgentMessage('studio').ok).toBe(true);
  expect((await pending).ok).toBe(false);
  expect(chat.messages.slice(0,before.length)).toEqual(before);
  expect(chat.messages.at(-1).content).toBe('racing');
  expect(Object.values(fixture.r4.messageQueue).some((row:any)=>row.text==='racing'&&row.status==='paused')).toBe(true);
  expect(chat.lastSummary).toBeUndefined();
  expect(chat.compactCount).toBe(0);
  expect(chat.status).toBe('idle');
});

it('rejects a stale summary if durable history changes while the provider is pending', async () => {
  const chat = seedHistory();
  let resolve!: (value: any) => void;
  fixture.summary.mockImplementation(() => new Promise(r => { resolve = r; }));
  const pending = compactAgentConversation('studio');
  await vi.waitFor(()=>expect(resolve).toBeTypeOf('function'));
  chat.messages[0].content = 'edited meanwhile';
  resolve({ content: 'stale' });
  expect((await pending).ok).toBe(false);
  expect(chat.messages[0].content).toBe('edited meanwhile');
  expect(chat.compactCount).toBe(0);
});

it('preserves image and uncertain/cancelled paid receipts for native tool history', async () => {
  const chat = seedHistory();
  chat.messages[8].attachments = [{ id: 'generated', kind: 'image', name: 'image.png' }];
  chat.messages[9].status = 'aborted';
  chat.messages[9].tools = [{ id: 'paid', name: 'langbai_generate_image', status: 'error', output: 'uncertain; do not retry' }];
  const before = structuredClone(chat.messages);
  expect((await compactAgentConversation('studio')).ok).toBe(true);
  expect(chat.messages).toEqual(before);
  await sendAgentMessage({ conversationId: 'studio', text: 'what happened?' });
  const prompt = JSON.stringify(fixture.turn.mock.calls[0][0].prompt);
  expect(prompt).toContain('record-8');
  expect(prompt).toContain('aborted');
  expect(prompt).not.toContain('uncertain; do not retry');
  expect(fixture.turn.mock.calls[0][0].toolHistory[chat.messages[9].id][0]).toMatchObject({status:'error',output:'uncertain; do not retry'});
});

it('empty/error/oversized summary leaves the original history and previous summary intact', async () => {
  const chat = seedHistory();
  chat.lastSummary = 'previous facts';
  const before = structuredClone(chat.messages);
  for (const content of ['', 'x'.repeat(100_001)]) {
    fixture.summary.mockResolvedValue({ content });
    expect((await compactAgentConversation('studio')).ok).toBe(false);
    expect(chat.lastSummary).toBe('previous facts');
    expect(chat.messages).toEqual(before);
  }
  fixture.summary.mockRejectedValue(new Error('fixture unavailable'));
  expect((await compactAgentConversation('studio')).ok).toBe(false);
  expect(chat.compactCount).toBe(0);
});

it('stopped stale compaction cannot clear the lock or status of a replacement turn', async () => {
  const chat = seedHistory();
  let finishSummary!: (value: any) => void;
  let finishTurn!: (value: any) => void;
  fixture.summary.mockImplementation(() => new Promise(r => { finishSummary = r; }));
  const pending = compactAgentConversation('studio');
  await vi.waitFor(()=>expect(finishSummary).toBeTypeOf('function'));
  stopAgentRuntime();
  fixture.turn.mockImplementation(() => new Promise(r => { finishTurn = r; }));
  const next = sendAgentMessage({ conversationId: 'studio', text: 'new turn' });
  finishSummary({ content: 'late stale summary' });
  expect((await pending).ok).toBe(false);
  await vi.waitFor(()=>expect(finishTurn).toBeTypeOf('function'));
  expect(chat.status).toBe('running');
  expect(hasActiveAgentRequests()).toBe(true);
  expect(chat.compactCount).toBe(0);
  finishTurn({ content: 'new result', reasoning: '', usage: {} });
  expect((await next).ok).toBe(true);
});

it('auto summary abort preserves accepted input and original history without starting a provider turn', async () => {
  const chat = seedHistory(60);
  const before = structuredClone(chat.messages);
  chat.draftAttachments = [{ id: 'draft', kind: 'image', name: 'draft.png' }];
  fixture.settings.agentAutoCompact = true;
  fixture.summary.mockImplementation(({ signal }) => new Promise(resolve => signal.addEventListener('abort', () => resolve({ content: 'late' }), { once: true })));
  const pending = sendAgentMessage({ conversationId: 'studio', text: 'new request' });
  await vi.waitFor(()=>expect(fixture.summary).toHaveBeenCalledTimes(1));
  expect(abortAgentMessage('studio').ok).toBe(true);
  expect((await pending).ok).toBe(false);
  expect(chat.messages.slice(0,before.length)).toEqual(before);
  expect(chat.messages.find((message:any)=>message.role==='user'&&message.content==='new request').attachments[0].id).toBe('draft');
  expect(Object.values(fixture.r4.messageQueue).some((row:any)=>row.text==='new request'&&row.status==='error')).toBe(true);
  expect(chat.compactCount).toBe(0);
  expect(fixture.turn).not.toHaveBeenCalled();
});

it('repeated compaction includes previous summary and only advances after new safe history exists', async () => {
  const chat = seedHistory();
  expect((await compactAgentConversation('studio')).ok).toBe(true);
  expect((await compactAgentConversation('studio')).ok).toBe(true);
  expect(fixture.summary).toHaveBeenCalledTimes(1);
  const last = chat.messages.at(-1);
  chat.messages.push(...Array.from({ length: 8 }, (_, i) => ({ ...last, id: `added-${i}`, content: 'fresh detail '.repeat(30), createdAt: new Date(30_000 + i * 1000).toISOString() })));
  fixture.summary.mockResolvedValue({ content: 'Merged facts.' });
  expect((await compactAgentConversation('studio')).ok).toBe(true);
  expect(fixture.summary.mock.calls[1][0].transcript).toContain('Previous summary:\nCompressed established facts.');
  expect(chat.compactCount).toBe(2);
  expect(chat.messages).toHaveLength(28);
});

it('upserts a lifecycle tool row and never duplicates generated attachments on progress updates', async () => {
  fixture.turn.mockImplementation(async options => {
    const base = { id: 'stable-call', name: 'fixture', title: 'fixture' };
    options.onTool({ ...base, status: 'pending' });
    options.onTool({ ...base, status: 'running' });
    options.onTool({ ...base, status: 'running', generatedImages: [{ id: 'generated', kind: 'image' }] });
    options.onTool({ ...base, status: 'completed', generatedImages: [{ id: 'generated', kind: 'image' }] });
    return { content: 'done', reasoning: '', usage: {} };
  });
  expect((await sendAgentMessage({ conversationId: 'studio', text: 'fixture' })).ok).toBe(true);
  const reply = fixture.workspace.conversations[0].messages.at(-1);
  expect(reply.tools).toHaveLength(1);
  expect(reply.tools[0].status).toBe('completed');
  expect(reply.attachments).toHaveLength(1);
});

it('abort retains completed image receipts and marks in-flight paid records uncertain without deleting them', async () => {
  const usage = { input: 8, output: 2, reasoning: 1, cacheRead: 0, cacheWrite: 0, total: 10 };
  fixture.turn.mockImplementation(options => new Promise((_resolve, reject) => {
    options.onTool({ id: 'completed', name: 'langbai_generate_image', title: 'fixture', status: 'completed', output: 'saved receipt', generatedImages: [{ id: 'saved-image', kind: 'image' }] });
    options.onTool({ id: 'inflight', name: 'langbai_upscale_image', title: 'fixture', status: 'running', output: 'request submitted' });
    options.onTool({ id: 'waiting', name: 'langbai_apply_prompt', title: 'fixture', status: 'pending' });
    const failure = new Error('fixture aborted');
    Object.defineProperty(failure, 'agentTokenUsage', { value: usage });
    options.signal.addEventListener('abort', () => reject(failure), { once: true });
  }));
  const pending = sendAgentMessage({ conversationId: 'studio', text: 'fixture' });
  await vi.waitFor(() => expect(fixture.workspace.conversations[0].messages.at(-1)?.tools).toHaveLength(3));
  expect(abortAgentMessage('studio').ok).toBe(true);
  expect((await pending).ok).toBe(false);
  const chat = fixture.workspace.conversations[0];
  const reply = chat.messages.at(-1);
  expect(reply.status).toBe('aborted'); expect(reply.tools).toHaveLength(3);
  expect(reply.usage).toEqual(usage); expect(chat.lastTurnUsage).toEqual(usage);
  expect(reply.tools[0]).toMatchObject({ status: 'completed', output: 'saved receipt' });
  expect(reply.tools[1]).toMatchObject({ status: 'error', output: 'request submitted' });
  expect(reply.tools[1].error).toContain('勿自动重试');
  expect(reply.tools[2].status).toBe('error'); expect(reply.attachments[0].id).toBe('saved-image');
  fixture.turn.mockResolvedValue({ content: 'review existing receipts', reasoning: '', usage: {} });
  await sendAgentMessage({ conversationId: 'studio', text: 'show results only' });
  const receipts = fixture.turn.mock.calls[1][0].toolHistory[reply.id];
  expect(receipts[0]).toMatchObject({status:'completed',output:'saved receipt'});
  expect(receipts[1]).toMatchObject({status:'error',output:'request submitted'});
  expect(receipts[1].error).toContain('勿自动重试');
});

it('actual post-compaction Pi prompt retains every exact image proposal field, not a summary snapshot label', async () => {
  const chat = seedHistory();
  const proposal = { id: 'exact-image', status: 'error', positivePrompt: 'red coat, 1.25::exact tag::',
    stylePrompt: '0.8::watercolor::', negativePrompt: 'blur', width: 832, height: 1216, count: 1,
    error: 'provider outcome uncertain; do not retry', continuity: { reviewRequired: true, changes: [] } };
  chat.messages[2].imageProposal = structuredClone(proposal);
  const before = structuredClone(chat.messages);
  expect((await compactAgentConversation('studio')).ok).toBe(true);
  expect(chat.messages).toEqual(before);
  expect(fixture.summary.mock.calls[0][0].transcript).not.toContain(proposal.positivePrompt);
  await sendAgentMessage({ conversationId: 'studio', text: 'inspect existing results only' });
  const prompt = fixture.turn.mock.calls[0][0].prompt;
  const protectedMessage = prompt.find((item: any) => item.content.includes(proposal.id));
  expect(protectedMessage.content).toContain(JSON.stringify(proposal));
  expect(prompt.some((item: any) => item.role === 'system' && item.content === chat.lastSummary)).toBe(true);
  expect(JSON.stringify(prompt)).not.toContain('record-0 ');
});

it.each(['aborted','error'] as const)('retains partial Pi text when a turn is %s',async state=>{
 let entered!:()=>void;const ready=new Promise<void>(r=>entered=r);
 fixture.turn.mockImplementation(async options=>{
  options.onText('保留半截回复。');entered();
  if(state==='aborted')await new Promise<void>(resolve=>options.signal.addEventListener('abort',()=>resolve(),{once:true}));
  throw Error('synthetic interrupted response');
 });
 const job=sendAgentMessage({conversationId:'studio',text:'synthetic partial response'});
 await ready;if(state==='aborted')expect(abortAgentMessage('studio').ok).toBe(true);
 expect((await job).ok).toBe(false);
 expect(fixture.workspace.conversations[0].messages.at(-1)).toMatchObject({status:state,content:'保留半截回复。'});
});

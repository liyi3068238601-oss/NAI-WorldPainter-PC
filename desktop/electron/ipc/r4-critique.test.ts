import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {AgentSqlStore} from './r4-store';
import {R4ConversationQueue} from './r4-conversation-queue';
import {R4CritiqueConsumer} from './r4-critique';
import {createEmptyR4AgentState,type R4Execution,type R4ConversationConfigSnapshot} from '../../src/agent/r4-types';
import type {AgentWorkspaceData} from '../../src/agent/types';
vi.mock('./r4-agent-service',()=>({settingsForR4Config:()=>({agentVisionEnabled:true})}));
const cleanup:Array<()=>void>=[];
afterEach(()=>{for(const close of cleanup.splice(0).reverse())close();});
function fixture(){
  const root=path.resolve('.tmp/r4-critique-tests');fs.mkdirSync(root,{recursive:true});const dir=fs.mkdtempSync(path.join(root,'case-'));cleanup.push(()=>{if(path.relative(root,dir).startsWith('..'))throw Error('Unsafe cleanup');fs.rmSync(dir,{recursive:true,force:true});});
  const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0u0AAAAASUVORK5CYII=','base64'),file=path.join(dir,'result.png');fs.writeFileSync(file,bytes);
  const config:R4ConversationConfigSnapshot={version:1,providerRef:{providerId:'original-model'},modelId:'original-model',presetId:'original-preset',enabled:true,body:'original preset body',revision:3,hash:'original-body-hash',publicParameters:{visionEnabled:true},source:'preview',capturedAt:'2026-10-18T00:00:00Z'};
  const state=createEmptyR4AgentState();state.conversations.chat={conversationId:'chat',currentCreationId:'other-creation',messageCreationIds:{},selectionRevision:0,updatedAt:config.capturedAt};
  const execution:R4Execution={id:'execution',conversationId:'chat',creationId:'origin-creation',operationKey:'op',submissionKey:'submit',userIntentRef:'intent',inputRevision:0,inputFingerprint:'fp',expectedOutputCount:1,requestGranularity:'per_output',
    providerRef:{providerId:'image-fixture'},approvedInput:{inputRevision:0,positivePrompt:'rainy bookshop',negativePrompt:'',stylePrompt:'watercolor',publicParameters:{requestedSeedPolicy:'random',requestedSeed:null},references:[]},conversationConfig:config,
    status:'completed',outputs:[{outputIndex:0,status:'completed',providerReceipt:{status:'confirmed'},artwork:{id:'art',attachmentId:'art',revision:1,conversationId:'chat',creationId:'origin-creation',name:'result.png',mime:'image/png',readableHandle:file,hash:createHash('sha256').update(bytes).digest('hex'),width:1,height:1,createdAt:config.capturedAt},resolvedSeed:null,resolvedSeedSource:null}],providerReceiptStatus:'confirmed',providerCancellation:'not_sent',receiptRevision:1,createdAt:config.capturedAt,updatedAt:config.capturedAt,events:[]};
  state.executions.execution=execution;
  state.critiqueQueue.critique={id:'critique',conversationId:'chat',creationId:'origin-creation',executionId:'execution',uniqueKey:'critique:execution',conversationConfig:config,status:'pending',createdAt:config.capturedAt,updatedAt:config.capturedAt};
  const workspace={version:4,conversations:[{id:'chat',messages:[],draftAttachments:[]}],skills:[],memories:[],characters:[],personas:[],lorebooks:[],samplerPresets:[]} as unknown as AgentWorkspaceData;
  const store=new AgentSqlStore({filename:path.join(dir,'agent.sqlite'),legacyFiles:[],loadInitialState:()=>({workspace,r4State:state}),normalizeWorkspace:value=>value as AgentWorkspaceData});cleanup.push(()=>store.close());
  const queue=new R4ConversationQueue({store,captureConfig:()=>config,snapshotCreation:creation=>creation.currentInput},{run:async()=>{}});
  const review=vi.fn(async(_item:any,_execution:any,images:any[],_signal:AbortSignal,beforeModelCall:()=>void)=>{beforeModelCall();return {text:`已看 ${images.length} 张：暖光与雨景形成对比。可尝试收紧构图。`};});
  const consumer=new R4CritiqueConsumer(store,queue,{changed:()=>{},assertDispatch:()=>{},review});
  const idle=()=>queue.withConversation('chat',async()=>{});
  return {store,queue,review,consumer,idle,bytes};
}
describe('durable automatic visual review',()=>{
  it('sends actual original bytes under the frozen config once, with origin creation ownership',async()=>{
    const {store,consumer,review,idle,bytes}=fixture();
    consumer.schedule('chat');consumer.schedule('chat');await idle();consumer.schedule('chat');await idle();
    expect(review).toHaveBeenCalledTimes(1);expect(Buffer.from(review.mock.calls[0][2][0].data,'base64')).toEqual(bytes);
    expect(review.mock.calls[0][0].conversationConfig).toMatchObject({modelId:'original-model',body:'original preset body',revision:3});
    const state=store.readR4State(),chat=store.readWorkspace().conversations[0];expect(state.critiqueQueue.critique.status).toBe('delivered');
    expect(chat.messages).toHaveLength(1);expect(chat.messages[0].creationId).toBe('origin-creation');expect(state.conversations.chat.currentCreationId).toBe('other-creation');
  });
  it('waits for the same conversation consumer instead of starting a concurrent model request',async()=>{
    const {queue,consumer,review,idle}=fixture();let release!:()=>void;const held=queue.withConversation('chat',()=>new Promise<void>(resolve=>{release=resolve;}));
    await vi.waitFor(()=>expect(release).toBeTypeOf('function'));consumer.schedule('chat');await Promise.resolve();expect(review).not.toHaveBeenCalled();release();await held;await idle();expect(review).toHaveBeenCalledTimes(1);
  });
  it('records an uncertain model result once and never retries it automatically',async()=>{
    const {store,consumer,review,idle}=fixture();review.mockImplementationOnce(async(_item,_execution,_images,_signal,beforeModelCall)=>{beforeModelCall();throw Error('connection dropped after request');});
    consumer.schedule('chat');await idle();consumer.schedule('chat');await idle();
    expect(review).toHaveBeenCalledTimes(1);expect(store.readR4State().critiqueQueue.critique.status).toBe('unknown');
    expect(Object.values(store.readR4State().gates)).toMatchObject([{active:true,reason:'unknown_prior_receipt'}]);
  });
  it('does not dispatch after a related paid failure, and restart never replays a running review',async()=>{
    const {store,queue,review,idle}=fixture();const blocked=new R4CritiqueConsumer(store,queue,{changed:()=>{},assertDispatch:()=>{throw Error('related paid failure');},review});
    blocked.schedule('chat');await idle();expect(review).not.toHaveBeenCalled();expect(store.readR4State().critiqueQueue.critique.status).toBe('blocked');
    store.transaction(tx=>{const state=tx.getR4State();state.critiqueQueue.critique.status='running';state.critiqueQueue.critique.dispatchStartedAt=new Date().toISOString();tx.setR4State(state);});blocked.recover();blocked.schedule('chat');await idle();
    expect(store.readR4State().critiqueQueue.critique.status).toBe('unknown');expect(review).not.toHaveBeenCalled();
  });
  it('a claim without a durable model boundary is paused as definitely unsent on recovery',()=>{
    const {store,consumer,review}=fixture();store.transaction(tx=>{const state=tx.getR4State();state.critiqueQueue.critique.status='running';tx.setR4State(state);});
    consumer.recover();expect(store.readR4State().critiqueQueue.critique.status).toBe('blocked');expect(Object.values(store.readR4State().gates)).toHaveLength(0);expect(review).not.toHaveBeenCalled();
  });
  it('a gate raised at the final model boundary blocks without an unknown receipt',async()=>{
    const {store,queue,review,idle}=fixture();let checks=0;
    const consumer=new R4CritiqueConsumer(store,queue,{changed:()=>{},assertDispatch:()=>{if(++checks===3)throw Error('new gate');},review});
    consumer.schedule('chat');await idle();
    expect(store.readR4State().critiqueQueue.critique.status).toBe('blocked');
    expect(Object.values(store.readR4State().gates)).toHaveLength(0);
  });
  it('stopping a pending review behind a held conversation prevents its later dispatch',async()=>{
    const {store,queue,consumer,review,idle}=fixture();let release!:()=>void;
    const held=queue.withConversation('chat',()=>new Promise<void>(resolve=>{release=resolve;}));
    await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
    consumer.schedule('chat');consumer.pausePending('chat');release();await held;await idle();
    expect(review).not.toHaveBeenCalled();expect(store.readR4State().critiqueQueue.critique.status).toBe('blocked');
  });
  it('a failed delivery transaction commits neither the review message nor a delivered receipt and never replays the paid call',async()=>{
    const {store,consumer,review,idle}=fixture();
    const injector=new DatabaseSync(store.filename);
    injector.exec("CREATE TRIGGER reject_review_delivery BEFORE UPDATE OF workspace_json ON agent_state WHEN NEW.workspace_json LIKE '%暖光与雨景形成对比%' BEGIN SELECT RAISE(ABORT,'synthetic delivery failure'); END;");injector.close();
    consumer.schedule('chat');await idle();
    const state=store.readR4State();expect(state.critiqueQueue.critique.status).toBe('unknown');
    expect(store.readWorkspace().conversations[0].messages.some(row=>row.content.includes('暖光与雨景形成对比'))).toBe(false);
    expect(state.critiqueQueue.critique.messageId).toBeUndefined();expect(state.critiqueQueue.critique.dispatchStartedAt).toBeTruthy();
    consumer.recover();consumer.schedule('chat');await idle();expect(review).toHaveBeenCalledTimes(1);
  });
});

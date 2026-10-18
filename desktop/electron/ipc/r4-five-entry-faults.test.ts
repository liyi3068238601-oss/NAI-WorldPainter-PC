import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import JSZip from 'jszip';
import sharp from 'sharp';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {DEFAULT_PARAMS,type AppSettings, type HistoryItem} from '../../src/types';
import type {AgentWorkspaceData} from '../../src/agent/types';
import type {R4Execution} from '../../src/agent/r4-types';
import {AgentSqlStore} from './r4-store';

const fixture=vi.hoisted(()=>({
  dir:'',store:null as AgentSqlStore|null,settings:null as AppSettings|null,
  history:[] as HistoryItem[],httpMode:'success' as 'success'|'hold'|'http_502',
  posts:[] as Array<{url:string;body:Buffer}>,holdStarted:null as (()=>void)|null,
  releaseHold:null as (()=>void)|null,
}));

vi.mock('./agent-workspace-location',()=>({agentWorkspaceDirectory:()=>fixture.dir}));
vi.mock('./local-media-protocol',()=>({toLocalMediaUrl:(file:string,id?:string)=>`local-media://r4-fixture/${id??path.basename(file)}`}));
vi.mock('./store',()=>({
  getSettings:()=>fixture.settings,getToken:()=> 'local-only-fixture-token',
  getAccountSummary:()=>({hasToken:true,tierLevel:0,hasActiveSubscription:false}),
  setAccountSummary:()=>{},getHistory:()=>fixture.history,getHistoryGroups:()=>[],
  addHistory:(items:HistoryItem[])=>{fixture.history.push(...items);},
  updateHistoryItem:(id:string,patch:Partial<HistoryItem>)=>{const index=fixture.history.findIndex(item=>item.id===id);if(index<0)return undefined;fixture.history[index]={...fixture.history[index],...patch};return fixture.history[index];},
  ensureHistoryGroup:(name:string,id?:string)=>({id:id??'fixture-group',name}),
}));
vi.mock('./agent-store',()=>({
  getAgentSqlStore:()=>fixture.store!,readAgentWorkspace:()=>fixture.store!.readWorkspace(),
  updateAgentConversation:(id:string,update:(chat:any)=>void)=>fixture.store!.transaction(tx=>{const workspace=tx.getWorkspace(),chat=workspace.conversations.find(row=>row.id===id);if(chat){update(chat);tx.setWorkspace(workspace);}}),
}));
vi.mock('./nai-accounts-runtime',()=>({currentNaiAccount:()=>undefined,withNaiAccountOperation:<T>(run:()=>Promise<T>)=>run(),getNaiAccountSummary:()=>({hasToken:true})}));
vi.mock('./proxy',()=>({proxyConfig:()=>({}),proxyConfigForUrl:async()=>({})}));
vi.mock('./logger',()=>({logError:()=>{},logInfo:()=>{},appendLog:()=>{}}));
vi.mock('electron',async()=>{
  const {PNG}=await import('pngjs');
  const nativeImage={createFromBuffer:(bytes:Buffer)=>{
    let source:InstanceType<typeof PNG>;
    try{source=PNG.sync.read(bytes);}catch{return {isEmpty:()=>true,getSize:()=>({width:0,height:0}),toPNG:()=>Buffer.alloc(0),resize:()=>({toPNG:()=>Buffer.alloc(0)})};}
    const toPNG=()=>PNG.sync.write(source);
    return {isEmpty:()=>false,getSize:()=>({width:source.width,height:source.height}),toPNG,
      resize:({width,height}:{width:number;height:number})=>{const output=new PNG({width,height});
        for(let y=0;y<height;y++)for(let x=0;x<width;x++){const sx=Math.min(source.width-1,Math.floor(x*source.width/width)),sy=Math.min(source.height-1,Math.floor(y*source.height/height));
          const from=(sy*source.width+sx)*4,to=(y*width+x)*4;source.data.copy(output.data,to,from,from+4);}
        return {toPNG:()=>PNG.sync.write(output)};}};
  }};
  return {app:{getPath:()=>fixture.dir},dialog:{},nativeImage};
});

import {getR4CreativeHost,getR4ExecutionCoordinator,prepareR4ImageOperation} from './r4-agent-service';
import {STUDIO_BUILTIN_PRESETS} from '../../src/agent/workspace-controls';

const root=path.resolve('.tmp/r4-five-entry-faults');
const operations=[
  ['generate_image',{}],
  ['redraw_image',{positivePrompt:'synthetic redraw',strength:0.65}],
  ['inpaint_image',{positivePrompt:'synthetic inpaint',maskAttachmentId:'mask',strength:0.7}],
  ['upscale_image',{scale:2}],
  ['process_image',{operation:'lineart'}],
] as const;

let server:http.Server;
let endpoint='';
let sourceBytes=Buffer.alloc(0);
let maskBytes=Buffer.alloc(0);

function makeWorkspace():AgentWorkspaceData{
  return {version:4,conversations:[{id:'chat',title:'synthetic fault matrix',messages:[],draftAttachments:[],status:'idle',characterIds:[],lorebookIds:[],selectedSkillIds:[],studioApprovalMode:'auto',compactCount:0}],
    characters:[],personas:[],lorebooks:[],skills:[],memories:[],samplerPresets:[],defaultGenerationMode:'confirm',updatedAt:new Date().toISOString()} as unknown as AgentWorkspaceData;
}

function createStore(filename=path.join(fixture.dir,'agent.sqlite')){
  return new AgentSqlStore({filename,legacyFiles:[],loadInitialState:()=>({workspace:makeWorkspace()}),normalizeWorkspace:value=>structuredClone(value) as AgentWorkspaceData});
}

function resetHttp(mode:'success'|'hold'|'http_502'='success'){
  fixture.httpMode=mode;fixture.posts=[];fixture.holdStarted=null;fixture.releaseHold=null;
}

async function imageZip(width:number,height:number){
  const png=await sharp({create:{width,height,channels:4,background:{r:10,g:40,b:80,alpha:1}}}).png().toBuffer();
  const zip=new JSZip();zip.file('synthetic.png',png);return zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
}

async function listenLocalServer(){
  server=http.createServer(async(req,res)=>{
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
    if(req.method==='GET'&&req.url==='/user/data'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({trainingStepsLeft:100}));return;}
    if(req.method!=='POST'||!['/ai/generate-image','/ai/upscale','/ai/augment-image'].includes(String(req.url))){res.writeHead(404);res.end('not found');return;}
    fixture.posts.push({url:String(req.url),body:Buffer.concat(chunks)});
    if(fixture.httpMode==='hold'){
      await new Promise<void>(resolve=>{fixture.holdStarted=resolve;fixture.releaseHold=resolve;});
    }
    if(fixture.httpMode==='http_502'){
      res.writeHead(502,{'content-type':'application/json'});res.end(JSON.stringify({message:'synthetic ambiguous gateway failure'}));return;
    }
    const isUpscale=req.url==='/ai/upscale';
    const bytes=await imageZip(isUpscale?128:64,isUpscale?128:64);
    if(!res.destroyed){res.writeHead(200,{'content-type':'application/zip'});res.end(bytes);}
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();if(!address||typeof address==='string')throw Error('Local test server did not bind TCP.');
  endpoint=`http://127.0.0.1:${address.port}`;
}

function seedWorkspaceAttachment(id:string,bytes:Buffer){
  const file=path.join(fixture.dir,`${id}.png`);fs.writeFileSync(file,bytes);
  fixture.store!.transaction(tx=>{const workspace=tx.getWorkspace(),chat=workspace.conversations[0];
    chat.draftAttachments.push({id,name:`${id}.png`,mime:'image/png',kind:'image',size:bytes.length,width:64,height:64,filePath:file,createdAt:new Date().toISOString()});tx.setWorkspace(workspace);});
}

async function waitFor(predicate:()=>boolean,label:string,timeout=8_000){
  const until=Date.now()+timeout;while(Date.now()<until){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}
  throw Error(`Timed out waiting for ${label}`);
}

function currentExecution(id:string){return fixture.store!.readR4State().executions[id];}

function scopeFor(creationId:string,operation:string,suffix=randomUUID()){
  return {conversationId:'chat',creationId,userIntentRef:`intent:${operation}:${suffix}`,turnLineageRef:`lineage:${operation}:${suffix}`,operationKey:`operation:${operation}:${suffix}`};
}

async function prepare(operation:string,args:Record<string,unknown>,scope:ReturnType<typeof scopeFor>){
  const host=getR4CreativeHost();
  if(operation==='generate_image'){
    const result=await host.prepare({positivePrompt:String(args.positivePrompt??'synthetic generation'),negativePrompt:'',stylePrompt:'',count:1,width:64,height:64},scope);
    return {preparationId:String(result.data?.preparationId),fingerprint:String(result.data?.inputFingerprint)};
  }
  return prepareR4ImageOperation(operation as 'redraw_image'|'inpaint_image'|'upscale_image'|'process_image',{...args,attachmentId:'source'},scope,new AbortController().signal);
}

function submit(coordinator:ReturnType<typeof getR4ExecutionCoordinator>,prepared:{preparationId:string;fingerprint:string},scope:ReturnType<typeof scopeFor>){
  const result=coordinator.submit(prepared.preparationId,prepared.fingerprint,scope,true) as {data:{executionId:string|null;submissionStatus:string}};
  return result;
}

beforeEach(async()=>{
  await listenLocalServer();
  fs.mkdirSync(root,{recursive:true});fixture.dir=fs.mkdtempSync(path.join(root,'case-'));
  sourceBytes=await sharp({create:{width:64,height:64,channels:4,background:{r:30,g:60,b:90,alpha:1}}}).png().toBuffer();
  maskBytes=await sharp({create:{width:64,height:64,channels:4,background:{r:255,g:255,b:255,alpha:1}}}).png().toBuffer();
  fixture.settings={agentApiProtocol:'openai-compatible',agentApiBaseUrl:'https://fixture.invalid/v1',agentApiKey:'local-model-key',agentApiModel:'local-model',agentVisionEnabled:false,
    agentContextWindow:128000,agentMaxOutputTokens:4096,agentAutoCompact:false,agentAutoCompactThreshold:0.8,savedAgentModels:[],imageProvider:'novelai',proxyMode:'direct',proxyUrl:'',modelMode:'anime',
    outputDir:path.join(fixture.dir,'output'),imageBaseUrl:endpoint,apiBaseUrl:endpoint,allowCustomEndpoint:false,generationGroupId:'',imageNameTemplate:'{date}_{seq}_{model}',keepImageMetadata:false,
    lastGenerationState:{params:{...DEFAULT_PARAMS,model:'nai-diffusion-4-5-curated',width:64,height:64,positivePrompt:'fixture',negativePrompt:'',stylePrompt:'',seedMode:'random',seed:0}},
    stylePromptPresets:[],positivePromptPresets:[],promptChunks:[]} as unknown as AppSettings;
  fixture.history=[];fixture.store=createStore();resetHttp();
  fixture.store.transaction(tx=>{const state=tx.getR4State(),preset=STUDIO_BUILTIN_PRESETS[0];
    if(preset)state.assistantPresetDefaultBinding={presetId:preset.id,enabled:false};tx.setR4State(state);});
  const host=getR4CreativeHost(),state=host.read('chat');
  seedWorkspaceAttachment('source',sourceBytes);seedWorkspaceAttachment('mask',maskBytes);
  if(!state.currentCreationId)throw Error('Fixture host did not create an initial creation.');
});

afterEach(async()=>{
  try{await getR4ExecutionCoordinator().worker.kick();}catch{/* fixture cleanup still closes storage */}
  fixture.store?.close();fixture.store=null;
  if(server){await new Promise<void>(resolve=>server.close(()=>resolve()));}
  const relative=path.relative(root,fixture.dir);if(!relative||relative.startsWith('..'))throw Error('Unsafe fixture cleanup path');fs.rmSync(fixture.dir,{recursive:true,force:true});
});

describe('R4 Final five image-entry durable fault matrix with actual local native HTTP provider',()=>{
  it.each(operations)('%s: exact replay, changed-payload rejection, unknown no-resend, and late success after unsupported cancel',async(operation,args)=>{
    const creationId=getR4CreativeHost().read('chat').currentCreationId!;

    // A queued cancellation is local and must not cross the network boundary.
    resetHttp();
    const queuedScope=scopeFor(creationId,operation,'queued-cancel');
    const queuedPrep=await prepare(operation,{...args,positivePrompt:'queued cancel fixture'},queuedScope);
    const queuedReceipt=submit(getR4ExecutionCoordinator(),queuedPrep,queuedScope);
    const queuedId=String(queuedReceipt.data.executionId);
    await getR4ExecutionCoordinator().cancel(queuedId,{conversationId:'chat',creationId});
    await new Promise<void>(resolve=>setImmediate(resolve));
    expect(currentExecution(queuedId).status).toBe('cancelled');
    expect(currentExecution(queuedId).providerCancellation).toBe('not_sent');
    expect(fixture.posts).toHaveLength(0);

    // Claim, then pause immediately before the real provider begins; cancellation
    // aborts the host-owned signal, and the real provider exits before POST.
    resetHttp();
    const boundaryScope=scopeFor(creationId,operation,'claim-cancel');
    const boundaryPrep=await prepare(operation,{...args,positivePrompt:'claim boundary fixture'},boundaryScope);
    const boundaryReceipt=submit(getR4ExecutionCoordinator(),boundaryPrep,boundaryScope);
    const boundaryId=String(boundaryReceipt.data.executionId),coordinator=getR4ExecutionCoordinator();
    const provider=coordinator.worker.provider as {submit:(...input:any[])=>Promise<any>};
    const realSubmit=provider.submit.bind(provider);let releaseProvider!:()=>void,enteredProvider!:()=>void;
    const entered=new Promise<void>(resolve=>{enteredProvider=resolve;});
    const gate=new Promise<void>(resolve=>{releaseProvider=resolve;});
    provider.submit=async(...input:any[])=>{enteredProvider();await gate;return realSubmit(...input);};
    try{
      void coordinator.worker.kick();await entered;
      await coordinator.cancel(boundaryId,{conversationId:'chat',creationId});
      releaseProvider();await coordinator.worker.kick();
    }finally{provider.submit=realSubmit;releaseProvider();}
    expect(currentExecution(boundaryId).status).toBe('cancelled');
    expect(fixture.posts).toHaveLength(0);

    // Hold a genuine native request while submit receipts are replayed. Same
    // preparation is idempotent; same operation key with a different prepared
    // fingerprint is stale and creates no second execution.
    resetHttp('hold');
    const replayScope=scopeFor(creationId,operation,'replay');
    const replayPrep=await prepare(operation,{...args,positivePrompt:'held request fixture'},replayScope);
    const replayCoordinator=getR4ExecutionCoordinator();
    const first=submit(replayCoordinator,replayPrep,replayScope);
    const duplicate=submit(replayCoordinator,replayPrep,replayScope);
    expect(duplicate.data.executionId).toBe(first.data.executionId);
    const changedPrep=await prepare(operation,{...args,positivePrompt:'different operation payload'},replayScope);
    const changed=submit(replayCoordinator,changedPrep,replayScope);
    expect(changed.data.submissionStatus).toBe('stale');
    try{await waitFor(()=>fixture.posts.length===1,'one held native POST');}
    catch(error){console.error(JSON.stringify(fixture.store!.readR4State().executions,null,2));throw error;}
    await getR4ExecutionCoordinator().cancel(String(first.data.executionId),{conversationId:'chat',creationId});
    expect(currentExecution(String(first.data.executionId)).providerCancellation).toBe('unsupported');
    fixture.releaseHold?.();
    await waitFor(()=>['completed','partial','error'].includes(currentExecution(String(first.data.executionId)).status),'late response convergence');
    await replayCoordinator.worker.kick();
    expect(fixture.posts).toHaveLength(1);
    expect(currentExecution(String(first.data.executionId)).status).toBe('completed');

    // A real 502 after the HTTP boundary is ambiguous. Restart/recover/resume
    // must never post the same paid operation a second time.
    resetHttp('http_502');
    const unknownScope=scopeFor(creationId,operation,'unknown');
    const unknownPrep=await prepare(operation,{...args,positivePrompt:'unknown receipt fixture'},unknownScope);
    const unknownReceipt=submit(getR4ExecutionCoordinator(),unknownPrep,unknownScope);
    const unknownId=String(unknownReceipt.data.executionId);
    await waitFor(()=>currentExecution(unknownId).status==='unknown','unknown provider receipt');
    await getR4ExecutionCoordinator().worker.kick();
    expect(fixture.posts).toHaveLength(1);
    fixture.store!.close();fixture.store=createStore();
    const recovered=getR4ExecutionCoordinator();
    expect(currentExecution(unknownId).status).toBe('unknown');
    expect(recovered.worker.resume([unknownId])).toEqual([]);
    await recovered.worker.kick();
    expect(fixture.posts).toHaveLength(1);
  },30_000);

  it.each(operations)('%s: SQL rollback survives close/reopen and only a deliberate retry dispatches',async(operation,args)=>{
    resetHttp();
    const creationId=getR4CreativeHost().read('chat').currentCreationId!;
    const scope=scopeFor(creationId,operation,'rollback');
    const preview=await prepare(operation,{...args,positivePrompt:'rollback fixture'},scope);
    const external=new DatabaseSync(fixture.store!.filename);
    external.exec("CREATE TRIGGER fixture_abort_r4_submit BEFORE UPDATE OF r4_json ON agent_state WHEN NEW.r4_json <> OLD.r4_json BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END;");
    external.close();
    expect(()=>submit(getR4ExecutionCoordinator(),preview,scope)).toThrow();
    expect(Object.keys(fixture.store!.readR4State().executions)).toHaveLength(0);
    fixture.store!.close();
    const dropper=new DatabaseSync(path.join(fixture.dir,'agent.sqlite'));
    dropper.exec('DROP TRIGGER fixture_abort_r4_submit');dropper.close();
    fixture.store=createStore();
    expect(Object.keys(fixture.store!.readR4State().executions)).toHaveLength(0);
    const receipt=submit(getR4ExecutionCoordinator(),preview,scope);
    const id=String(receipt.data.executionId);
    await waitFor(()=>currentExecution(id).status==='completed','post-rollback real provider completion');
    expect(fixture.posts).toHaveLength(1);
    expect(currentExecution(id).status).toBe('completed');
  },30_000);

  it.each(operations)('%s: restart pauses durable queued work until explicit resume',async(operation,args)=>{
    resetHttp();
    const creationId=getR4CreativeHost().read('chat').currentCreationId!;
    const scope=scopeFor(creationId,operation,'restart-queued');
    const preview=await prepare(operation,{...args,positivePrompt:'restart queued fixture'},scope);
    const coordinator=getR4ExecutionCoordinator();
    const kick=vi.spyOn(coordinator.worker,'kick').mockResolvedValue();
    const receipt=submit(coordinator,preview,scope),id=String(receipt.data.executionId);
    await new Promise<void>(resolve=>setImmediate(resolve));kick.mockRestore();
    expect(currentExecution(id).status).toBe('queued');
    fixture.store!.close();fixture.store=createStore();
    const recovered=getR4ExecutionCoordinator();
    expect(currentExecution(id).status).toBe('queued');
    expect(currentExecution(id).pauseReason).toBe('user_pause');
    expect(fixture.posts).toHaveLength(0);
    expect(recovered.worker.resume([id])).toEqual([id]);
    await waitFor(()=>currentExecution(id).status==='completed','manual resume completion');
    expect(fixture.posts).toHaveLength(1);
  },30_000);
});

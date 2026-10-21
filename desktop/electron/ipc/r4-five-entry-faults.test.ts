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
import {validateR4Result} from '../../src/agent/r4-contracts';
import {AgentSqlStore} from './r4-store';

const fixture=vi.hoisted(()=>({
  dir:'',store:null as AgentSqlStore|null,settings:null as AppSettings|null,
  workbench:null as any,
  history:[] as HistoryItem[],historyGroups:[] as Array<{id:string;name:string}>,httpMode:'success' as 'success'|'hold'|'http_502',
  posts:[] as Array<{url:string;body:Buffer}>,holdStarted:null as (()=>void)|null,
  releaseHold:null as (()=>void)|null,
}));

vi.mock('./agent-workspace-location',()=>({agentWorkspaceDirectory:()=>fixture.dir}));
vi.mock('./local-media-protocol',()=>({toLocalMediaUrl:(file:string,id?:string)=>`local-media://r4-fixture/${id??path.basename(file)}`}));
vi.mock('./store',()=>({
  getSettings:()=>fixture.settings,getToken:()=> 'local-only-fixture-token',
  getAccountSummary:()=>({hasToken:true,tierLevel:0,hasActiveSubscription:false}),
  setAccountSummary:()=>{},getHistory:()=>fixture.history,getHistoryGroups:()=>fixture.historyGroups,
  ensureHistoryGroup:(name:string,id?:string)=>{
    const current=fixture.historyGroups.find(item=>item.id===id||item.name===name);
    if(current)return current;
    const group={id:id??'fixture-group',name};fixture.historyGroups.push(group);return group;
  },
  addHistory:(items:HistoryItem[])=>{fixture.history.push(...items);},
  updateHistoryItem:(id:string,patch:Partial<HistoryItem>)=>{const index=fixture.history.findIndex(item=>item.id===id);if(index<0)return undefined;fixture.history[index]={...fixture.history[index],...patch};return fixture.history[index];},
  ensureHistoryGroup:(name:string,id?:string)=>({id:id??'fixture-group',name}),
}));
vi.mock('./agent-store',()=>({
  getAgentSqlStore:()=>fixture.store!,agentAttachmentsDirectory:()=>path.join(fixture.dir,'attachments'),readAgentWorkspace:()=>fixture.store!.readWorkspace(),
  updateAgentConversation:(id:string,update:(chat:any)=>void)=>fixture.store!.transaction(tx=>{const workspace=tx.getWorkspace(),chat=workspace.conversations.find(row=>row.id===id);if(chat){update(chat);tx.setWorkspace(workspace);}}),
}));
vi.mock('./r4-workbench',()=>({getR4WorkbenchService:()=>({
  readR4WorkbenchSnapshot:async()=>structuredClone(fixture.workbench),publishCompletedResults:async()=>{},
})}));
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
import {buildR4ImageProviderExtras} from './r4-image-provider';
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
    fixture.workbench={...fixture.workbench,draftRevision:fixture.workbench.draftRevision+1,inputRevision:fixture.workbench.inputRevision+1,
      params:{...fixture.workbench.params,positivePrompt:String(args.positivePrompt??'synthetic generation')}};
    const result=await host.prepare({},scope);
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
  fixture.workbench={draftId:'fault-matrix-workbench',draftRevision:0,inputRevision:0,draftSource:'workbench',
    params:{...DEFAULT_PARAMS,model:'nai-diffusion-4-5-curated',width:64,height:64,positivePrompt:'fixture',negativePrompt:'',stylePrompt:''},
    workbench:{mode:'generate:t2i',modelMode:'anime',historyGroupId:'fixture-group',batchCount:1,batchIntervalSeconds:0,charCaptions:[],vibeImages:[],preciseReferences:[],
      busy:{isGenerating:false,isGenerateQueueRunning:false,batchRunning:false}}};
  fixture.history=[];fixture.historyGroups=[];fixture.store=createStore();resetHttp();
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
  it('freezes a model-matched encoding-only Vibe as a managed asset without paid encode budget',async()=>{
    const creationId=getR4CreativeHost().read('chat').currentCreationId!,model='nai-diffusion-4-5-curated';
    fixture.workbench={...fixture.workbench,
      params:{...fixture.workbench.params,positivePrompt:'encoding-only vibe fixture'},
      workbench:{...fixture.workbench.workbench,vibeImages:[{name:'encoding-only.vibe',base64:'',infoExtracted:.6,strength:.31,
        encodings:[{model,infoExtracted:.6,encoding:'AQIDBA=='}]}]}};
    const scope=scopeFor(creationId,'generate_image','vibe-encoding-only');
    const result=await getR4CreativeHost().prepare({},scope),checked=validateR4Result('prepare_generation',result);
    expect(checked.valid).toBe(true);
    const data=result.data as {preparationId:string;preview:Record<string,unknown>};
    const preparation=fixture.store!.readR4State().preparations[data.preparationId];
    const references=preparation.inputSnapshot.publicParameters.vibeReferences as Array<Record<string,unknown>>;
    expect(preparation.inputSnapshot.publicParameters.requestBudget).toEqual({image:1,vibe_encode:0,upscale:0});
    expect(preparation.inputSnapshot.workbenchAssets).toEqual([expect.objectContaining({role:'vibe',hash:expect.stringMatching(/^[a-f0-9]{64}$/),mime:'application/vnd.novelai.vibe-transfer-encoding'})]);
    expect(references).toEqual([expect.objectContaining({encodingModel:model,encodingInfoExtracted:.6,infoExtracted:.6,strength:.31})]);
    expect(data.preview.sourceAttachments).toEqual([expect.objectContaining({role:'vibe',includeInGeneration:true,outputIndex:null,hash:expect.stringMatching(/^[a-f0-9]{64}$/)})]);
    const extras=buildR4ImageProviderExtras({conversationId:'chat',creationId,approvedInput:preparation.inputSnapshot} as R4Execution);
    expect(extras.vibeImages).toEqual([{base64:'',encodings:[{model,infoExtracted:.6,encoding:'AQIDBA=='}],infoExtracted:.6,strength:.31}]);
    expect(fixture.posts).toHaveLength(0);
  });

  it('prepares current inpaint source, mask, Vibe and precise workbench references as strict verified bindings',async()=>{
    const creationId=getR4CreativeHost().read('chat').currentCreationId!;
    const sourcePath=path.join(fixture.dir,'workbench-source.png');fs.writeFileSync(sourcePath,sourceBytes);
    const encoded=sourceBytes.toString('base64');
    fixture.workbench={...fixture.workbench,draftRevision:fixture.workbench.draftRevision+1,inputRevision:fixture.workbench.inputRevision+1,
      params:{...fixture.workbench.params,positivePrompt:'inpaint workbench fixture'},
      workbench:{...fixture.workbench.workbench,mode:'inpaint',modelMode:'anime',sourceMode:'latest',
        source:{filePath:sourcePath,width:64,height:64},mask:maskBytes.toString('base64'),maskRevision:7,region:null,
        inpaintPositivePrompt:'inpaint workbench fixture',inpaintModel:'nai-diffusion-5-full-inpainting',inpaintStrength:.72,inpaintNoise:0,
        inpaintSizeMode:'original',inpaintCustomSize:{width:64,height:64},
        vibeImages:[{name:'fixture-vibe.png',base64:encoded,infoExtracted:.6,strength:.8}],
        preciseReferences:[{name:'fixture-precise.png',base64:encoded,type:'character',strength:.7,fidelity:.9}]}};
    const scope=scopeFor(creationId,'generate_image','workbench-inputs');
    const prepared=await getR4CreativeHost().prepare({},scope);
    expect(validateR4Result('prepare_generation',prepared).valid).toBe(true);
    const data=prepared.data as {preparationId:string;preview:Record<string,unknown>};
    const attachments=data.preview.sourceAttachments as Array<Record<string,unknown>>;
    expect(attachments).toHaveLength(4);
    expect(attachments.map(item=>item.role)).toEqual(['edit_source','mask','vibe','precise']);
    for(const item of attachments){
      expect(item).toMatchObject({artifactId:expect.any(String),attachmentId:expect.any(String),attachmentRevision:'1',hash:expect.stringMatching(/^[a-f0-9]{64}$/),
        outputIndex:null,conversationId:'chat',creationId,parentAttachmentId:null});
    }
    expect(attachments.slice(2)).toEqual(expect.arrayContaining([expect.objectContaining({role:'vibe',includeInGeneration:true}),expect.objectContaining({role:'precise',includeInGeneration:true})]));
    const preparation=fixture.store!.readR4State().preparations[data.preparationId];
    expect(preparation.inputSnapshot.editSource?.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(preparation.inputSnapshot.mask?.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(preparation.inputSnapshot.workbenchAssets).toHaveLength(2);
    expect(preparation.inputSnapshot.publicParameters).toMatchObject({workbenchMode:'inpaint',maskRevision:7,modelMode:'anime',historyGroupId:'fixture-group'});
    expect(preparation.inputSnapshot.publicParameters.requestBudget).toEqual({image:1,vibe_encode:1,upscale:0});
    expect(fixture.posts).toHaveLength(0);
  });

  it('saves a Generate-workbench redraw into its snapshotted history group',async()=>{
    const creationId=getR4CreativeHost().read('chat').currentCreationId!,selectedGroup={id:'selected-workbench-group',name:'Selected Generate group'};
    fixture.historyGroups.push(selectedGroup);
    const source=fixture.store!.readWorkspace().conversations[0].draftAttachments.find(item=>item.id==='source')!;
    fixture.workbench={...fixture.workbench,draftRevision:fixture.workbench.draftRevision+1,inputRevision:fixture.workbench.inputRevision+1,
      params:{...fixture.workbench.params,positivePrompt:'redraw current workbench source'},
      workbench:{...fixture.workbench.workbench,mode:'generate:i2i',historyGroupId:selectedGroup.id,source:{filePath:source.filePath,width:64,height:64},
        i2iSizeMode:'original',i2iParams:{strength:.7,noise:0,extraNoiseSeed:17}}};
    const scope=scopeFor(creationId,'generate_image','redraw-live-group');
    const prepared=await getR4CreativeHost().prepare({},scope);
    const receipt=submit(getR4ExecutionCoordinator(),{preparationId:String(prepared.data?.preparationId),fingerprint:String(prepared.data?.inputFingerprint)},scope);
    const executionId=String(receipt.data.executionId);await getR4ExecutionCoordinator().worker.kick();
    expect(fixture.posts.map(item=>item.url)).toEqual(['/ai/generate-image']);
    expect(currentExecution(executionId).status).toBe('completed');
    expect(fixture.history).toHaveLength(1);
    expect(fixture.history[0].groupId).toBe(selectedGroup.id);
    expect(fixture.historyGroups.map(item=>item.name)).not.toContain('Agent 创作');
  });

  it('keeps an explicitly ungrouped Generate redraw out of the current active history group',async()=>{
    const creationId=getR4CreativeHost().read('chat').currentCreationId!,activeGroup={id:'active-generation-group',name:'Current active group'};
    fixture.historyGroups.push(activeGroup);fixture.settings!.generationGroupId=activeGroup.id;
    const source=fixture.store!.readWorkspace().conversations[0].draftAttachments.find(item=>item.id==='source')!;
    fixture.workbench={...fixture.workbench,draftRevision:fixture.workbench.draftRevision+1,inputRevision:fixture.workbench.inputRevision+1,
      params:{...fixture.workbench.params,positivePrompt:'explicitly ungrouped redraw'},
      workbench:{...fixture.workbench.workbench,mode:'generate:i2i',historyGroupId:'__ungrouped',source:{filePath:source.filePath,width:64,height:64},
        i2iSizeMode:'original',i2iParams:{strength:.7,noise:0,extraNoiseSeed:17}}};
    const scope=scopeFor(creationId,'generate_image','redraw-explicit-ungrouped');
    const prepared=await getR4CreativeHost().prepare({},scope);
    const receipt=submit(getR4ExecutionCoordinator(),{preparationId:String(prepared.data?.preparationId),fingerprint:String(prepared.data?.inputFingerprint)},scope);
    const executionId=String(receipt.data.executionId);await getR4ExecutionCoordinator().worker.kick();
    expect(currentExecution(executionId).status).toBe('completed');
    expect(fixture.history).toHaveLength(1);
    expect(fixture.history[0].groupId).toBeUndefined();
    expect(fixture.historyGroups).toEqual([activeGroup]);
  });

  it('keeps inpaint in the prepared Generate history group after selection changes during the request',async()=>{
    const creationId=getR4CreativeHost().read('chat').currentCreationId!,preparedGroup={id:'prepared-inpaint-group',name:'Prepared inpaint'},laterGroup={id:'later-selection-group',name:'Selected after queue'};
    fixture.historyGroups.push(preparedGroup,laterGroup);fixture.httpMode='hold';
    const source=fixture.store!.readWorkspace().conversations[0].draftAttachments.find(item=>item.id==='source')!;
    fixture.workbench={...fixture.workbench,draftRevision:fixture.workbench.draftRevision+1,inputRevision:fixture.workbench.inputRevision+1,
      params:{...fixture.workbench.params,positivePrompt:'inpaint group snapshot'},
      workbench:{...fixture.workbench.workbench,mode:'inpaint',historyGroupId:preparedGroup.id,source:{filePath:source.filePath,width:64,height:64},
        mask:maskBytes.toString('base64'),maskRevision:8,region:null,inpaintPositivePrompt:'inpaint group snapshot',inpaintModel:'nai-diffusion-5-full-inpainting',
        inpaintStrength:.72,inpaintNoise:0,inpaintSizeMode:'original',inpaintCustomSize:{width:64,height:64}}};
    const scope=scopeFor(creationId,'generate_image','inpaint-group-snapshot');
    const prepared=await getR4CreativeHost().prepare({},scope);
    const receipt=submit(getR4ExecutionCoordinator(),{preparationId:String(prepared.data?.preparationId),fingerprint:String(prepared.data?.inputFingerprint)},scope);
    const executionId=String(receipt.data.executionId),running=getR4ExecutionCoordinator().worker.kick();
    await waitFor(()=>fixture.releaseHold!==null,'local inpaint POST');
    fixture.settings!.generationGroupId=laterGroup.id;
    fixture.workbench={...fixture.workbench,draftRevision:fixture.workbench.draftRevision+1,inputRevision:fixture.workbench.inputRevision+1,
      workbench:{...fixture.workbench.workbench,historyGroupId:laterGroup.id}};
    fixture.releaseHold!();await running;
    expect(currentExecution(executionId).status).toBe('completed');
    expect(fixture.history).toHaveLength(1);
    expect(fixture.history[0].groupId).toBe(preparedGroup.id);
  });

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

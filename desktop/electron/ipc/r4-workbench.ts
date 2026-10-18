import {randomUUID} from 'node:crypto';
import {ipcMain,type BrowserWindow,type IpcMainInvokeEvent,type WebContents} from 'electron';
import {validateR4Result} from '../../src/agent/r4-contracts';
import type {R4ApplyPromptResult,R4WorkbenchPromptApplyRequest,R4WorkbenchPromptDiff,R4WorkbenchPromptFields,R4WorkbenchPromptPreview,R4WorkbenchPromptPreviewRequest,R4WorkbenchSnapshot} from '../../src/agent/r4-workbench-contract';
import type {StudioAgentReply} from '../../src/studio-agent-contract';
import type {R4CreativeHost,R4HostScope} from './r4-creative-host';

const PREVIEW_TTL_MS=120_000;
const PROMPT_KEYS=['positivePrompt','negativePrompt','stylePrompt'] as const;
type WindowGetter=()=>BrowserWindow|null;
type RendererAction='r4-workbench-read'|'r4-workbench-apply';

interface RendererPending {
  sender:WebContents;
  action:RendererAction;
  resolve:(reply:StudioAgentReply)=>void;
  reject:(error:Error)=>void;
  timer:ReturnType<typeof setTimeout>;
  cleanup:()=>void;
}

interface PromptPreviewRecord {
  preview:R4WorkbenchPromptPreview;
  scope:R4HostScope;
  patch:R4WorkbenchPromptFields;
  expiresAt:number;
}

export interface R4WorkbenchService {
  ready():boolean;
  readR4WorkbenchSnapshot():Promise<R4WorkbenchSnapshot>;
  previewR4PromptApply(args:Record<string,unknown>,scope:R4HostScope):Promise<R4WorkbenchPromptPreview|Record<string,unknown>>;
  applyR4PromptCAS(previewId:string,draftId:string,draftRevision:number,scope:R4HostScope):Promise<Record<string,unknown>>;
  createR4ApplyPrompt(input:{scope:R4HostScope;authorize:(name:string,args:Record<string,unknown>,signal:AbortSignal)=>Promise<boolean>}):
    (args:Record<string,unknown>,scope:R4HostScope,signal:AbortSignal)=>Promise<Record<string,unknown>>;
  previewFromUI(request:R4WorkbenchPromptPreviewRequest):Promise<{ok:true;data:R4WorkbenchPromptPreview}|{ok:false;message:string}>;
  applyFromUI(request:R4WorkbenchPromptApplyRequest):Promise<{ok:true;data:R4ApplyPromptResult}|{ok:false;message:string}>;
  replyFromRenderer(sender:WebContents,id:unknown,reply:StudioAgentReply):void;
}

export function createR4WorkbenchService(options:{window:WindowGetter;host:()=>R4CreativeHost;rendererRequest?:(action:RendererAction,args:Record<string,unknown>)=>Promise<StudioAgentReply>;timeoutMs?:number;uuid?:()=>string;now?:()=>number}):R4WorkbenchService {
  const pending=new Map<string,RendererPending>(),previews=new Map<string,PromptPreviewRecord>();
  const timeoutMs=options.timeoutMs??15_000,uuid=options.uuid??randomUUID,now=options.now??Date.now;
  const owner=()=>options.window();

  function requestRenderer(action:RendererAction,args:Record<string,unknown>):Promise<StudioAgentReply> {
    if(options.rendererRequest)return options.rendererRequest(action,args);
    const win=owner();
    if(!win||win.isDestroyed()||win.webContents.isDestroyed())return Promise.reject(new Error('Studio 工作台不可用。'));
    return new Promise((resolve,reject)=>{
      const id=uuid(),contents=win.webContents;
      const remove=()=>{contents.removeListener?.('destroyed',destroyed);contents.removeListener?.('render-process-gone',destroyed);contents.removeListener?.('did-start-navigation',navigation);};
      const destroyed=()=>{const item=pending.get(id);if(!item)return;clearTimeout(item.timer);pending.delete(id);remove();reject(new Error(action==='r4-workbench-apply'?'应用结果待核实；请回读工作台，未自动重试。':'Studio 工作台读取失败。'));};
      const navigation=(details:{isMainFrame?:boolean;isSameDocument?:boolean})=>{if(details.isMainFrame&&!details.isSameDocument)destroyed();};
      const timer=setTimeout(()=>{pending.delete(id);remove();reject(new Error(action==='r4-workbench-apply'?'应用结果待核实；请回读工作台，未自动重试。':'Studio 工作台读取超时。'));},timeoutMs);
      pending.set(id,{sender:contents,action,resolve,reject,timer,cleanup:remove});
      contents.once?.('destroyed',destroyed);contents.once?.('render-process-gone',destroyed);contents.on?.('did-start-navigation',navigation);
      try{contents.send('r4-workbench:request',{id,action,args});}
      catch(error){clearTimeout(timer);pending.delete(id);remove();reject(error instanceof Error?error:new Error('Studio 工作台请求失败。'));}
    });
  }

  async function readR4WorkbenchSnapshot():Promise<R4WorkbenchSnapshot> {
    const reply=await requestRenderer('r4-workbench-read',{});
    if(!reply?.ok||!reply.data||typeof reply.data!=='object'||Array.isArray(reply.data))throw new Error(reply?.error||'无法读取 live renderer 工作台。');
    const value=reply.data as Partial<R4WorkbenchSnapshot>;
    if(typeof value.draftId!=='string'||!value.draftId||!Number.isSafeInteger(value.draftRevision)||Number(value.draftRevision)<0
      ||!Number.isSafeInteger(value.inputRevision)||Number(value.inputRevision)<0||!value.params||typeof value.params!=='object'||Array.isArray(value.params))throw new Error('Renderer 返回了不完整的工作台快照。');
    if(value.draftSource!=='workbench')throw new Error('Renderer 工作台来源无效。');
    return value as R4WorkbenchSnapshot;
  }

  function promptPatch(value:unknown):R4WorkbenchPromptFields {
    if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('方案提示词格式无效。');
    const row=value as Record<string,unknown>;
    for(const key of PROMPT_KEYS)if(typeof row[key]!=='string'||String(row[key]).length>100_000)throw new Error(`方案字段 ${key} 无效。`);
    return {positivePrompt:row.positivePrompt as string,negativePrompt:row.negativePrompt as string,stylePrompt:row.stylePrompt as string};
  }

  function diff(before:R4WorkbenchPromptFields,after:R4WorkbenchPromptFields):R4WorkbenchPromptDiff {
    return {positivePromptChanged:before.positivePrompt!==after.positivePrompt,
      negativePromptChanged:before.negativePrompt!==after.negativePrompt,stylePromptChanged:before.stylePrompt!==after.stylePrompt};
  }

  function scopeMatches(a:R4HostScope,b:R4HostScope) {
    return a.conversationId===b.conversationId&&a.creationId===b.creationId
      &&a.userIntentRef===b.userIntentRef&&(a.messageId??'')===(b.messageId??'');
  }

  function preflight(scope:R4HostScope,code:'context_mismatch'|'not_found'|'stale_revision'|'user_denied',message:string,status:'blocked'|'denied'|'cancelled'='blocked') {
    const allowedActions=code==='context_mismatch'?['read_creation','reselect_target_creation']
      :code==='not_found'?['read_proposal']
      :code==='user_denied'?['continue_without_action']
      :['request_user_decision'];
    const result={resultKind:'preflight_failure',status,error:{code,message,allowedActions}};
    const checked=validateR4Result('apply_prompt',result);
    if(!checked.valid)throw new Error(`apply_prompt preflight shape invalid: ${checked.errors.map(item=>item.message).join('; ')}`);
    return result as Record<string,unknown>;
  }

  function business(scope:R4HostScope,data:R4ApplyPromptResult['data']):Record<string,unknown> {
    const result={resultKind:'business',status:'completed',conversationId:scope.conversationId,creationId:scope.creationId,data};
    const checked=validateR4Result('apply_prompt',result);
    if(!checked.valid)throw new Error(`apply_prompt result shape invalid: ${checked.errors.map(item=>item.message).join('; ')}`);
    return result;
  }

  async function readProposal(proposalId:string,proposalRevision:number,scope:R4HostScope):Promise<R4WorkbenchPromptFields|undefined> {
    const result=await options.host().invoke('read_proposal',{proposalId,revision:proposalRevision},scope);
    const checked=validateR4Result('read_proposal',result);
    if(!checked.valid)throw new Error('创作主机返回无效方案回执。');
    const data=(result as {data?:Record<string,unknown>}).data;
    if(data?.proposalReadStatus!=='ok')return undefined;
    return promptPatch(data);
  }

  function prunePreviews() {
    const time=now();
    for(const [id,item] of previews)if(item.expiresAt<=time)previews.delete(id);
    while(previews.size>128)previews.delete(previews.keys().next().value as string);
  }

  async function makePreview(args:Record<string,unknown>,scope:R4HostScope,expected?:{draftId:string;draftRevision:number}) {
    if((args.targetConversationId!==undefined&&args.targetConversationId!==scope.conversationId)
      ||(args.targetCreationId!==undefined&&args.targetCreationId!==scope.creationId))return {failure:preflight(scope,'context_mismatch','方案目标与本次消息授权范围不一致。')};
    const snapshot=await readR4WorkbenchSnapshot();
    if(expected&&(snapshot.draftId!==expected.draftId||snapshot.draftRevision!==expected.draftRevision)){
      return {failure:business(scope,{applyStatus:'conflict',draftId:snapshot.draftId,draftRevision:snapshot.draftRevision})};
    }
    const proposalId=String(args.proposalId??''),proposalRevision=Number(args.proposalRevision);
    const patch=await readProposal(proposalId,proposalRevision,scope);
    if(!patch)return {failure:preflight(scope,'not_found','指定方案修订不存在或不属于本次创作。')};
    const before=promptPatch(snapshot.params),preview:R4WorkbenchPromptPreview={previewId:uuid(),conversationId:scope.conversationId,creationId:scope.creationId,
      proposalId,proposalRevision,draftId:snapshot.draftId,draftRevision:snapshot.draftRevision,inputRevision:snapshot.inputRevision,
      before,after:patch,diff:diff(before,patch)};
    prunePreviews();previews.set(preview.previewId,{preview,scope:{...scope},patch,expiresAt:now()+PREVIEW_TTL_MS});
    return {preview};
  }

  async function previewR4PromptApply(args:Record<string,unknown>,scope:R4HostScope):Promise<R4WorkbenchPromptPreview|Record<string,unknown>> {
    const result=await makePreview(args,scope,{
      draftId:String(args.targetDraftId??''),draftRevision:Number(args.expectedDraftRevision),
    });
    return 'failure'in result?result.failure!:result.preview!;
  }

  async function applyR4PromptCAS(previewId:string,draftId:string,draftRevision:number,scope:R4HostScope):Promise<Record<string,unknown>> {
    prunePreviews();
    const stored=previews.get(previewId);
    if(!stored)return preflight(scope,'not_found','应用预览已失效，请重新读取并比较方案。');
    if(!scopeMatches(stored.scope,scope))return preflight(scope,'context_mismatch','应用预览属于另一条消息或创作，未修改工作台。');
    if(stored.preview.draftId!==draftId||stored.preview.draftRevision!==draftRevision){previews.delete(previewId);return preflight(scope,'stale_revision','确认版本与预览版本不一致，未修改工作台。');}
    previews.delete(previewId);
    const reply=await requestRenderer('r4-workbench-apply',{draftId,draftRevision,patch:stored.patch});
    if(!reply?.ok||!reply.data||typeof reply.data!=='object'||Array.isArray(reply.data))throw new Error(reply?.error||'工作台应用结果待核实；请先重新读取。');
    const outcome=reply.data as {applyStatus?:unknown;draftId?:unknown;draftRevision?:unknown;diff?:unknown};
    if(!['applied','conflict'].includes(String(outcome.applyStatus))||typeof outcome.draftId!=='string'||!Number.isSafeInteger(outcome.draftRevision))throw new Error('工作台 CAS 返回无效结果；请回读确认，不要自动重试。');
    return business(scope,{applyStatus:outcome.applyStatus as 'applied'|'conflict',draftId:outcome.draftId,draftRevision:Number(outcome.draftRevision),diff:stored.preview.diff});
  }

  function createR4ApplyPrompt(input:{scope:R4HostScope;authorize:(name:string,args:Record<string,unknown>,signal:AbortSignal)=>Promise<boolean>}) {
    return async (args:Record<string,unknown>,callScope:R4HostScope,signal:AbortSignal):Promise<Record<string,unknown>>=>{
      signal.throwIfAborted();
      const scope=callScope??input.scope;
      const prepared=await makePreview(args,scope,{draftId:String(args.targetDraftId??''),draftRevision:Number(args.expectedDraftRevision)});
      if('failure'in prepared)return prepared.failure!;
      const preview=prepared.preview!;
      let approved=false;
      try{approved=await input.authorize('apply_prompt',{...args,preview},signal);}
      catch(error){
        const cancelled=signal.aborted||(error instanceof Error&&error.name==='AbortError');
        return preflight(scope,'user_denied',cancelled?'应用确认已取消，工作台未修改。':'用户未批准应用，工作台未修改。',cancelled?'cancelled':'denied');
      }
      if(!approved)return preflight(scope,'user_denied','用户未批准应用，工作台未修改。','denied');
      signal.throwIfAborted();
      return applyR4PromptCAS(preview.previewId,preview.draftId,preview.draftRevision,scope);
    };
  }

  async function previewFromUI(request:R4WorkbenchPromptPreviewRequest) {
    try{
      const conversationId=String(request?.conversationId??''),creationId=String(request?.creationId??''),proposalId=String(request?.proposalId??''),proposalRevision=Number(request?.proposalRevision);
      if(!conversationId||!creationId||!proposalId||!Number.isSafeInteger(proposalRevision)||proposalRevision<1)throw new Error('方案目标无效。');
      const scope:R4HostScope={conversationId,creationId,userIntentRef:`ui:${uuid()}`,operationKey:`ui:${uuid()}`};
      const result=await makePreview({proposalId,proposalRevision},scope);
      if('failure'in result)throw new Error(String((result.failure as {error?:{message?:string}}).error?.message??'无法预览方案。'));
      return {ok:true as const,data:result.preview};
    }catch(error){return {ok:false as const,message:error instanceof Error?error.message:'无法预览工作台变更。'};}
  }

  async function applyFromUI(request:R4WorkbenchPromptApplyRequest) {
    try{
      const stored=previews.get(String(request?.previewId??''));
      if(!stored)throw new Error('预览已过期，请重新比较。');
      const preview=stored.preview;
      if(request.conversationId!==preview.conversationId||request.creationId!==preview.creationId
        ||request.proposalId!==preview.proposalId||request.proposalRevision!==preview.proposalRevision
        ||request.draftId!==preview.draftId||request.draftRevision!==preview.draftRevision)throw new Error('预览目标或版本已变化，未修改工作台。');
      const result=await applyR4PromptCAS(preview.previewId,preview.draftId,preview.draftRevision,stored.scope) as unknown as R4ApplyPromptResult;
      return {ok:true as const,data:result};
    }catch(error){return {ok:false as const,message:error instanceof Error?error.message:'工作台应用结果待核实，请回读确认。'};}
  }

  function replyFromRenderer(sender:WebContents,id:unknown,reply:StudioAgentReply) {
    const item=typeof id==='string'?pending.get(id):undefined;
    const win=owner();
    if(!item||sender!==item.sender||sender!==win?.webContents)throw new Error('Unknown R4 workbench reply sender or request.');
    clearTimeout(item.timer);item.cleanup();pending.delete(id as string);
    if(!reply||typeof reply.ok!=='boolean')item.resolve({ok:false,error:'Invalid renderer workbench reply.'});
    else item.resolve(reply);
  }

  return {ready:()=>{const win=owner();return Boolean(win&&!win.isDestroyed()&&!win.webContents.isDestroyed());},readR4WorkbenchSnapshot,previewR4PromptApply,applyR4PromptCAS,createR4ApplyPrompt,previewFromUI,applyFromUI,replyFromRenderer};
}

let installed=false;
export function registerR4WorkbenchIpc(service:R4WorkbenchService,window:WindowGetter) {
  if(installed)return;installed=true;
  const assertSender=(event:IpcMainInvokeEvent)=>{
    const owner=window();
    if(!owner||owner.isDestroyed()||event.sender!==owner.webContents||event.senderFrame!==owner.webContents.mainFrame)throw new Error('Unknown R4 workbench IPC sender.');
  };
  ipcMain.handle('r4-workbench:reply',(event,id:unknown,reply:StudioAgentReply)=>{assertSender(event);return service.replyFromRenderer(event.sender,id,reply);});
  ipcMain.handle('agent:r4WorkbenchPreview',(event,request:R4WorkbenchPromptPreviewRequest)=>{assertSender(event);return service.previewFromUI(request);});
  ipcMain.handle('agent:r4WorkbenchApply',(event,request:R4WorkbenchPromptApplyRequest)=>{assertSender(event);return service.applyFromUI(request);});
}

let configuredService:R4WorkbenchService|undefined;
/** Configure once with the application's actual main-window and creative-host getters. */
export function configureR4WorkbenchService(window:WindowGetter,host:()=>R4CreativeHost):R4WorkbenchService {
  if(configuredService)return configuredService;
  configuredService=createR4WorkbenchService({window,host});
  registerR4WorkbenchIpc(configuredService,window);
  return configuredService;
}

/** Runtime consumers share the exact service instance registered with Electron IPC. */
export function getR4WorkbenchService():R4WorkbenchService {
  if(!configuredService)throw new Error('R4 workbench service has not been configured.');
  return configuredService;
}

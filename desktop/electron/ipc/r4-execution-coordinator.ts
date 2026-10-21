import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import type {AgentAttachment} from '../../src/agent/types';
import type {R4CreativeCommand,R4CreativeCommandResult} from '../../src/agent/r4-commands';
import type {R4AgentState,R4Execution,R4Preparation,R4ProviderRef} from '../../src/agent/r4-types';
import {validateR4Result} from '../../src/agent/r4-contracts';
import {validateR4ExecutionSemantics} from '../../src/agent/r4-execution-semantics';
import type {AgentSqlTransaction} from './r4-store';
import {R4CreativeHost,r4Hash,type R4HostScope} from './r4-creative-host';
import {R4ExecutionWorker,type R4ExecutionProvider} from './r4-execution-worker';

const terminal=new Set(['completed','partial','error','cancelled','blocked','denied']);
const now=()=>new Date().toISOString();

function checked(name:'generate_image'|'get_execution'|'cancel_execution',scope:Pick<R4HostScope,'conversationId'|'creationId'>,data:Record<string,unknown>,status='completed') {
  const result={resultKind:'business',status,conversationId:scope.conversationId,creationId:scope.creationId,data};
  const valid=validateR4Result(name,result);if(!valid.valid)throw Error(`执行回执合同不一致：${name} ${JSON.stringify(valid.errors.map(item=>({path:item.instancePath,message:item.message})))}`);
  return result;
}

export function r4ExecutionData(execution:R4Execution):Record<string,unknown> {
  const params=execution.approvedInput.publicParameters;
  const seedPolicy=params.requestedSeedPolicy==='fixed'?'fixed':'random';
  const data={readStatus:'ok',executionId:execution.id,executionStatus:execution.status,
    outputs:execution.outputs.map(output=>({outputIndex:output.outputIndex,status:output.status,
      ...(output.errorCode?{errorCode:output.errorCode}:{}),
      ...(output.status==='completed'&&output.artwork?{
        artifactId:output.artwork.id,attachmentId:output.artwork.attachmentId,attachmentRevision:String(output.artwork.revision),hash:output.artwork.hash,
        conversationId:execution.conversationId,creationId:execution.creationId,parentAttachmentId:output.artwork.parentAttachmentId??null,
        resolvedSeed:output.resolvedSeed??null,resolvedSeedSource:output.resolvedSeedSource==='provider_receipt'?'provider':output.resolvedSeedSource==='verified_embedded_metadata'?'verified_embedded':null,
      }:{}),
    })),receiptRevision:execution.receiptRevision,providerReceiptStatus:execution.providerReceiptStatus,
    requestedSeedPolicy:seedPolicy,requestedSeed:seedPolicy==='fixed'?params.requestedSeed:null,
    expectedOutputCount:execution.expectedOutputCount,requestGranularity:execution.requestGranularity,
    ...(execution.blockedReason?{blockedReason:execution.blockedReason}:{}),
    ...(execution.status==='queued'?{pauseReason:execution.pauseReason??'none'}:{}),createdAt:execution.createdAt,updatedAt:execution.updatedAt};
  const semantic=validateR4ExecutionSemantics(data as Parameters<typeof validateR4ExecutionSemantics>[0]);
  if(!semantic.valid)throw Error(`执行状态存在矛盾：${semantic.issues.map(item=>item.message).join(' ')}`);
  return data;
}

export function registerR4ExecutionArtifacts(tx:AgentSqlTransaction,state:R4AgentState,execution:R4Execution) {
  const workspace=tx.getWorkspace(),chat=workspace.conversations.find(item=>item.id===execution.conversationId),creation=state.creations[execution.creationId];
  if(!chat||!creation)throw Error('执行目标聊天或创作已不存在，保留执行结果等待恢复。');
  const images:AgentAttachment[]=[];
  for(const output of execution.outputs){
    if(output.status!=='completed'||!output.artwork)continue;
    const artwork=output.artwork;
    if(!artwork.hash||!artwork.readableHandle||!artwork.width||!artwork.height)throw Error('结果图片缺少可读文件、哈希或尺寸证据。');
    const bytes=fs.readFileSync(artwork.readableHandle);
    if(createHash('sha256').update(bytes).digest('hex')!==artwork.hash)throw Error('结果文件与服务产物登记哈希不一致，未登记为可读作品。');
    const previous=state.artworks[artwork.id];
    if(previous&&(previous.hash!==artwork.hash||previous.attachmentId!==artwork.attachmentId))throw Error('结果身份冲突，未覆盖旧作品。');
    state.artworks[artwork.id]=structuredClone(artwork);
    if(!creation.artworkIds.includes(artwork.id))creation.artworkIds.push(artwork.id);
    images.push({id:artwork.attachmentId,name:artwork.name,mime:artwork.mime,size:bytes.length,kind:'image',filePath:artwork.readableHandle,fileUrl:artwork.url,
      revision:artwork.revision,sha256:artwork.hash,creationId:artwork.creationId,role:'artwork',
      width:artwork.width,height:artwork.height,createdAt:artwork.createdAt});
  }
  if(images.length){
    const messageId=`execution:${execution.id}`;
    const message=chat.messages.find(item=>item.id===messageId);
    const content=execution.status==='completed'?`已生成 ${images.length} 张作品。`:`已有 ${images.length} 张作品可查看。`;
    if(message){message.attachments=images;message.content=content;}
    else chat.messages.push({id:messageId,role:'assistant',content,attachments:images,tools:[],status:'complete',createdAt:now(),completedAt:now(),creationId:creation.id,conversationConfig:execution.conversationConfig});
    const conversation=state.conversations[execution.conversationId];
    if(conversation)conversation.messageCreationIds[messageId]=creation.id;
    // Output selection is independent from persistent edit-source selection.
    if(conversation&&!conversation.selectedArtworkId)conversation.selectedArtworkId=execution.outputs.find(output=>output.artwork)?.artwork?.id;
    if(terminal.has(execution.status)){
      const id=`critique:${execution.id}`;
      if(!state.critiqueQueue[id])state.critiqueQueue[id]={id,uniqueKey:id,conversationId:execution.conversationId,creationId:execution.creationId,executionId:execution.id,
        conversationConfig:structuredClone(execution.conversationConfig),status:execution.conversationConfig.publicParameters.visionEnabled===true?'pending':'blocked',createdAt:now(),updatedAt:now()};
    }
    tx.setWorkspace(workspace);
  }
}

export class R4ExecutionCoordinator {
  readonly worker:R4ExecutionWorker;
  private scheduledKicks=0;
  hasActiveRequests(){return this.scheduledKicks>0||this.worker.hasActiveRequests();}
  constructor(readonly host:R4CreativeHost,provider:R4ExecutionProvider,onError?:(error:unknown)=>void){
    this.worker=new R4ExecutionWorker(host.store,provider,{
      onTransaction:registerR4ExecutionArtifacts,
      onChanged:conversationId=>host.dependencies.onChanged?.(conversationId),onError,
    });
  }

  get(executionId:string,scope:Pick<R4HostScope,'conversationId'|'creationId'>){
    const execution=this.host.store.readR4State().executions[executionId];
    if(!execution||execution.conversationId!==scope.conversationId||execution.creationId!==scope.creationId)return checked('get_execution',scope,{readStatus:'not_found',executionId});
    return checked('get_execution',scope,r4ExecutionData(execution));
  }

  submit(preparationId:string,fingerprint:string,scope:R4HostScope,approvedByUi:boolean){
    const result=this.host.store.transaction(tx=>{
      const state=tx.getR4State(),workspace=tx.getWorkspace(),preparation=state.preparations[preparationId];
      const stale=()=>checked('generate_image',scope,{submissionStatus:'stale',executionId:null,executionStatus:null,inputFingerprint:null,acceptedAt:null});
      const requestHash=r4Hash({preparationId,fingerprint});
      const priorOperation=Object.values(state.operations).find(item=>item.operation==='submit_execution'&&item.operationKey===scope.operationKey&&item.conversationId===scope.conversationId);
      if(priorOperation){
        const original=state.executions[String(priorOperation.receipt.executionId)];
        const originalHash=priorOperation.receipt.argumentHash??(original?r4Hash({preparationId:original.preparationId,fingerprint:original.inputFingerprint}):undefined);
        if(priorOperation.creationId!==scope.creationId||originalHash!==requestHash)return stale();
      }
      if(!preparation||preparation.creationId!==scope.creationId||preparation.conversationId!==scope.conversationId||preparation.fingerprint!==fingerprint)return stale();
      const intent=(preparation as R4Preparation&{userIntentRef?:string}).userIntentRef??scope.userIntentRef;
      if(!approvedByUi&&intent!==scope.userIntentRef)return stale();
      const submissionKey=`${intent}:${preparation.fingerprint}`;
      const previous=Object.values(state.executions).find(item=>item.submissionKey===submissionKey);
      if(previous){
        const saved=Object.values(state.operations).find(item=>item.operation==='submit_execution'&&item.receipt.executionId===previous.id);
        if(!saved)throw Error('已存在任务但原始入队回执缺失，未重复提交。');
        return structuredClone(saved.receipt.result as Record<string,unknown>);
      }
      const creation=state.creations[preparation.creationId];
      if(!creation||!workspace.conversations.some(item=>item.id===scope.conversationId&&!item.archivedAt))return stale();
      if(!['ready','approved'].includes(preparation.status)||creation.inputRevision!==preparation.inputRevision
        ||preparation.expiresAt&&Date.parse(preparation.expiresAt)<=Date.now())return stale();
      if(!approvedByUi&&preparation.status!=='approved')throw Error('这份生成预览尚未批准。');
      for(const binding of [preparation.inputSnapshot.editSource,preparation.inputSnapshot.mask,...preparation.inputSnapshot.references,...(preparation.inputSnapshot.workbenchAssets??[])]){
        if(!binding)continue;
        const current=this.host.dependencies.resolveAttachment(workspace,state,scope.conversationId,scope.creationId,binding.attachmentId);
        if(current.hash!==binding.hash||current.revision!==binding.revision)return stale();
      }
      const providerRef=preparation.inputSnapshot.publicParameters.providerRef as R4ProviderRef;
      if(!providerRef?.providerId||r4Hash({input:preparation.inputSnapshot,config:preparation.conversationConfig,provider:providerRef})!==preparation.fingerprint)return stale();
      const timestamp=now(),id=randomUUID(),count=Number(preparation.preview.count),approvalId=preparation.approvalReceiptId??randomUUID();
      if(!Number.isSafeInteger(count)||count<1||count>8)throw Error('批准数量无效。');
      const execution:R4Execution={id,conversationId:scope.conversationId,creationId:scope.creationId,preparationId:preparation.id,operationKey:scope.operationKey,
        submissionKey,userIntentRef:intent,inputRevision:preparation.inputRevision,inputFingerprint:preparation.fingerprint,expectedOutputCount:count,
        requestGranularity:providerRef.providerId==='openai-images'?'batch':'per_output',providerRef:structuredClone(providerRef),providerAccountRef:providerRef.accountRef,
        approvedInput:structuredClone(preparation.inputSnapshot),conversationConfig:structuredClone(preparation.conversationConfig),status:'queued',
        outputs:Array.from({length:count},(_,index)=>({outputIndex:index,status:'not_dispatched'})),providerReceiptStatus:'not_applicable',providerCancellation:'not_sent',
        receiptRevision:0,pauseReason:'none',approvalReceiptId:approvalId,createdAt:timestamp,updatedAt:timestamp,
        ...(scope.releasedGateIds?.length?{releasedGateIds:structuredClone(scope.releasedGateIds)}:{}),
        events:[{id:randomUUID(),kind:'approved_and_durable_enqueued',at:timestamp,detail:{preparationId:preparation.id,approvalReceiptId:approvalId,inputFingerprint:preparation.fingerprint}}]};
      const semantic=validateR4ExecutionSemantics(execution);if(!semantic.valid)throw Error(semantic.issues[0].message);
      state.executions[id]=execution;preparation.status='consumed';preparation.approvalReceiptId=approvalId;preparation.approvedAt=timestamp;preparation.consumedByExecutionId=id;
      const result=checked('generate_image',scope,{submissionStatus:'accepted',executionId:id,executionStatus:'queued',inputFingerprint:preparation.fingerprint,acceptedAt:timestamp},'accepted');
      const operationId=randomUUID();state.operations[operationId]={id:operationId,conversationId:scope.conversationId,creationId:scope.creationId,operationKey:scope.operationKey,
        operation:'submit_execution',status:'applied',userIntentRef:intent,receipt:{executionId:id,argumentHash:requestHash,result:structuredClone(result)},createdAt:timestamp};
      tx.setR4State(state);return result;
    });
    this.host.dependencies.onChanged?.(scope.conversationId);
    // accepted is a durable receipt. Background work starts after that commit.
    this.scheduledKicks++;
    setImmediate(()=>{this.scheduledKicks--;void this.worker.kick();});
    return result;
  }

  async cancel(executionId:string,scope:Pick<R4HostScope,'conversationId'|'creationId'>){
    const before=this.host.store.readR4State().executions[executionId];
    if(!before||before.conversationId!==scope.conversationId||before.creationId!==scope.creationId)return checked('cancel_execution',scope,{cancelDisposition:'not_found',executionId,providerCancellation:'not_sent'});
    if(terminal.has(before.status))return checked('cancel_execution',scope,{cancelDisposition:'already_terminal',executionId,providerCancellation:before.providerCancellation,
      executionStatus:before.status,receiptRevision:before.receiptRevision});
    const current=await this.worker.cancel(executionId);
    const disposition=current.providerCancellation==='unsupported'?'not_cancellable':'requested';
    return checked('cancel_execution',scope,{cancelDisposition:disposition,executionId,providerCancellation:current.providerCancellation,executionStatus:current.status,receiptRevision:current.receiptRevision});
  }

  async command(request:R4CreativeCommand):Promise<R4CreativeCommandResult|undefined>{
    if(!['approve_generation','deny_preparation','resume_queue','cancel_execution','verify_execution'].includes(request.type))return undefined;
    const state=this.host.read(request.conversationId),args=request.args??{},creationId=request.creationId??state.currentCreationId!;
    const scope={conversationId:request.conversationId,creationId,operationKey:request.operationId??randomUUID(),userIntentRef:`ui:${request.operationId??randomUUID()}`};
    let data:Record<string,unknown>={};
    if(request.type==='approve_generation')data=this.submit(String(args.preparationId),String(args.fingerprint),scope,true);
    else if(request.type==='deny_preparation')this.host.store.transaction(tx=>{
      const state=tx.getR4State(),preparation=state.preparations[String(args.preparationId)];
      if(!preparation||preparation.conversationId!==scope.conversationId||preparation.creationId!==scope.creationId)throw Error('生成预览不存在。');
      if(preparation.status==='consumed')throw Error('该任务已经入队，请使用任务取消。');
      preparation.status='invalidated';tx.setR4State(state);
    });
    else if(request.type==='resume_queue'){
      const ids=Array.isArray(args.executionIds)?args.executionIds.map(String):[];
      if(ids.some(id=>state.executions[id]?.conversationId!==request.conversationId))throw Error('不能恢复其他聊天的未列明任务。');
      data={resumedExecutionIds:this.worker.resume(ids)};
    }else if(request.type==='cancel_execution')data=await this.cancel(String(args.executionId),scope);
    else{
      const execution=state.executions[String(args.executionId)];if(!execution||execution.creationId!==creationId)throw Error('执行任务归属不匹配。');
      await this.worker.verify(execution.id);data=this.get(execution.id,scope);
    }
    this.host.dependencies.onChanged?.(request.conversationId);
    return {ok:true,data,state:this.host.read(request.conversationId)};
  }
}

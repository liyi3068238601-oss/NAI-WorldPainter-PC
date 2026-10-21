import { createHash, randomUUID } from 'node:crypto';
import type { AgentWorkspaceData } from '../../src/agent/types';
import type { R4CreativeCommand, R4CreativeCommandResult } from '../../src/agent/r4-commands';
import {
  projectR4Conversation,
  type R4AgentState, type R4AttachmentBinding, type R4ConversationConfigSnapshot,
  type R4Creation, type R4CreationInputSnapshot, type R4OperationReceipt,
  type R4Preparation, type R4Proposal, type R4ReferenceBinding,
  type R4ConversationCreativeState,
} from '../../src/agent/r4-types';
import { validateR4Input, validateR4Result, type R4ToolName } from '../../src/agent/r4-contracts';
import type {R4WorkbenchSnapshot} from '../../src/agent/r4-workbench-contract';
import type { AgentSqlStore, AgentSqlTransaction } from './r4-store';

export function r4Hash(value: unknown): string {
  const canonical = (item:unknown):unknown => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>[key,canonical(value)])) : item;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

const copy = <T>(value:T):T => structuredClone(value);
const now = () => new Date().toISOString();
const text = (value:unknown,max=20_000) => typeof value === 'string' ? value.slice(0,max) : '';
const proposalKey = (id:unknown,revision:unknown) => `${String(id)}@${String(revision)}`;

export interface R4HostScope {
  conversationId:string;
  creationId:string;
  userIntentRef:string;
  /** Immutable for the active model turn, including all of its consumed steers. */
  turnLineageRef?:string;
  operationKey:string;
  messageId?:string;
  conversationConfig?:R4ConversationConfigSnapshot;
  /** A turn may advance this cursor only through its own committed input patch. */
  inputCursor?:{inputRevision:number};
  /** Exact host-recorded UI/user consent, never taken from tool arguments. */
  referenceOptIns?:Array<{attachmentId:string;attachmentRevision:number;purpose:string}>;
  paidServiceRevision?:string;
  releasedGateIds?:string[];
}

export interface R4CreativeHostDependencies {
  captureConfig: (workspace:AgentWorkspaceData,state:R4AgentState,conversationId:string,source:'message_send'|'preview') => R4ConversationConfigSnapshot;
  resolveAttachment: (workspace:AgentWorkspaceData,state:R4AgentState,conversationId:string,creationId:string,id:string) => R4AttachmentBinding;
  prepare?: (creation:R4Creation,args:Record<string,unknown>,config:R4ConversationConfigSnapshot,scope:R4HostScope,workbenchSnapshot?:R4WorkbenchSnapshot) => Promise<{
    input:R4CreationInputSnapshot;preview:Record<string,unknown>;providerRef:Record<string,unknown>;
  }>;
  onChanged?: (conversationId:string) => void;
  projectState?: (state:R4ConversationCreativeState,workspace:AgentWorkspaceData) => R4ConversationCreativeState;
  command?: (request:R4CreativeCommand,host:R4CreativeHost) => Promise<R4CreativeCommandResult | undefined>;
}

/** Real host commands share one transaction path with canonical tools and UI. */
export class R4CreativeHost {
  constructor(readonly store:AgentSqlStore,readonly dependencies:R4CreativeHostDependencies) {}

  private ensure(tx:AgentSqlTransaction,conversationId:string) {
    const workspace=tx.getWorkspace(),state=tx.getR4State();
    const chat=workspace.conversations.find(item=>item.id===conversationId);
    if(!chat)throw Error('聊天不存在。');
    let conversation=state.conversations[conversationId];
    if(!conversation){
      conversation=state.conversations[conversationId]={conversationId,messageCreationIds:{},selectionRevision:0,updatedAt:now()};
    }
    if(!conversation.currentCreationId || !state.creations[conversation.currentCreationId]){
      const creation=this.newCreation(conversationId,chat.messages.length?'历史创作':'当前创作');
      if(chat.messages.length){
        creation.legacyStatus='legacy_unversioned';
        for(const message of chat.messages)conversation.messageCreationIds[message.id]=creation.id;
      }
      state.creations[creation.id]=creation;conversation.currentCreationId=creation.id;
    }
    if(!conversation.assistantPresetBinding&&state.assistantPresetDefaultBinding)conversation.assistantPresetBinding=copy(state.assistantPresetDefaultBinding);
    if(conversation.assistantPresetBinding?.legacyStatus==='migration_conflict')delete conversation.config;
    if(!conversation.config){
      try{conversation.config=this.dependencies.captureConfig(workspace,state,conversationId,'preview');delete conversation.configurationIssue;}
      catch(error){conversation.configurationIssue=error instanceof Error?error.message:'对话配置需要修复。';}
    }
    if(!conversation.assistantPresetBinding&&conversation.config?.presetId)conversation.assistantPresetBinding={presetId:conversation.config.presetId,enabled:conversation.config.enabled};
    tx.setR4State(state);
    return {workspace,state,chat,conversation};
  }

  private newCreation(conversationId:string,title:string):R4Creation {
    const timestamp=now();
    const input:R4CreationInputSnapshot={inputRevision:0,positivePrompt:'',negativePrompt:'',stylePrompt:'',publicParameters:{},references:[],editSource:null,mask:null};
    return {id:randomUUID(),conversationId,title:title.trim().slice(0,100)||'新创作',inputRevision:0,selectionRevision:0,
      positivePrompt:'',negativePrompt:'',stylePrompt:'',publicParameters:{},references:[],artworkIds:[],
      currentInput:input,createdAt:timestamp,updatedAt:timestamp};
  }

  read(conversationId:string) {
    return this.store.transaction(tx=>{
      const {state,workspace}=this.ensure(tx,conversationId);
      const projected=copy(projectR4Conversation(state,conversationId));
      return this.dependencies.projectState?.(projected,workspace)??projected;
    });
  }

  snapshot(creation:R4Creation):R4CreationInputSnapshot {
    return {inputRevision:creation.inputRevision,positivePrompt:creation.positivePrompt,negativePrompt:creation.negativePrompt,
      stylePrompt:creation.stylePrompt,requirements:creation.requirements,publicParameters:copy(creation.publicParameters),
      editSource:copy(creation.editSource??null),mask:copy(creation.mask??null),references:copy(creation.references)};
  }

  private updateInput(state:R4AgentState,creation:R4Creation) {
    creation.inputRevision++;creation.updatedAt=now();creation.currentInput=this.snapshot(creation);
    for(const preparation of Object.values(state.preparations))if(preparation.creationId===creation.id&&['ready','approved'].includes(preparation.status))preparation.status='invalidated';
  }

  private scopeCreation(state:R4AgentState,scope:R4HostScope) {
    const creation=state.creations[scope.creationId];
    if(!creation||creation.conversationId!==scope.conversationId)throw Error('创作归属不匹配，未执行操作。');
    return creation;
  }

  private checked(name:R4ToolName,scope:R4HostScope,data:Record<string,unknown>,status='completed') {
    const result={resultKind:'business',status,conversationId:scope.conversationId,creationId:scope.creationId,data};
    const checked=validateR4Result(name,result);
    if(!checked.valid)throw Error(`工具结果未通过合同校验：${name} ${JSON.stringify(checked.errors.map(item=>({path:item.instancePath,message:item.message})))}`);
    return result;
  }

  private proposalRef(state:R4AgentState,creation:R4Creation) {
    const proposal=creation.currentProposalRef?state.proposals[creation.currentProposalRef]:undefined;
    return proposal?{proposalId:proposal.id,revision:proposal.revision}:null;
  }

  private references(creation:R4Creation) {
    const map=(binding:R4AttachmentBinding,role:string,extra:Record<string,unknown>={})=>{
      if(!binding.hash)throw Error('图片身份缺少可验证哈希，未建立生成绑定。');
      return {
      artifactId:binding.attachmentId,attachmentId:binding.attachmentId,attachmentRevision:String(binding.revision),
      hash:binding.hash,outputIndex:0,conversationId:creation.conversationId,creationId:creation.id,
      parentAttachmentId:null,role,includeInGeneration:role==='edit_source'||role==='mask',...extra,
    };};
    return [
      ...(creation.editSource?[map(creation.editSource,'edit_source')]:[]),
      ...(creation.mask?[map(creation.mask,'mask')]:[]),
      ...creation.references.map(binding=>map(binding,binding.purpose?'reference':'discussion',{
        includeInGeneration:binding.includeInGeneration,...(binding.purpose?{referencePurpose:binding.purpose}:{}),
      })),
    ];
  }

  private recordOperation(state:R4AgentState,scope:R4HostScope,operation:string,args:unknown,result:Record<string,unknown>,before?:unknown) {
    const id=randomUUID();
    const record:R4OperationReceipt={id,conversationId:scope.conversationId,creationId:scope.creationId,
      operationKey:scope.operationKey,operation,status:'applied',userIntentRef:scope.userIntentRef,
      receipt:{argumentHash:r4Hash(args),result:copy(result),...(before===undefined?{}:{before:copy(before)})},createdAt:now()};
    state.operations[id]=record;
    return record;
  }

  private replay(state:R4AgentState,scope:R4HostScope,name:string,args:unknown) {
    const record=Object.values(state.operations).find(item=>item.operationKey===scope.operationKey&&item.conversationId===scope.conversationId);
    if(!record)return undefined;
    if(record.operation!==name||record.creationId!==scope.creationId||record.receipt.argumentHash!==r4Hash(args))throw Error('同一操作标识对应不同输入，未执行。');
    return copy(record.receipt.result as Record<string,unknown>);
  }

  async invoke(name:R4ToolName,args:Record<string,unknown>,scope:R4HostScope):Promise<Record<string,unknown>> {
    const input=validateR4Input(name,args);
    if(!input.valid)return {resultKind:'preflight_failure',status:'error',error:{code:'invalid_arguments',message:'工具入参不符合当前合同。',allowedActions:['correct_arguments']}};
    if((args.targetConversationId!==undefined&&args.targetConversationId!==scope.conversationId)
      ||(args.targetCreationId!==undefined&&args.targetCreationId!==scope.creationId)){
      return {resultKind:'preflight_failure',status:'denied',error:{code:'invalid_arguments',message:'目标不属于本次用户操作的授权范围。',allowedActions:['correct_arguments']}};
    }
    if(name==='prepare_generation')return this.prepare(args,scope);
    const result=this.store.transaction(tx=>{
      const {workspace,state}=this.ensure(tx,scope.conversationId);
      const creation=this.scopeCreation(state,scope);
      const replay=this.replay(state,scope,name,args);if(replay)return replay;
      if(name==='patch_creation_inputs'&&scope.inputCursor&&scope.inputCursor.inputRevision!==creation.inputRevision)throw Error('创作输入已由其他操作改变，请发送新消息确认当前输入。');
      let data:Record<string,unknown>,before:unknown;
      let actionId:string|undefined;
      if(name==='read_creation'){
        data={readStatus:'ok',conversationId:scope.conversationId,creationId:scope.creationId,currentProposalRef:this.proposalRef(state,creation),
          selectionRevision:creation.selectionRevision,draftId:creation.id,draftRevision:creation.inputRevision,inputRevision:creation.inputRevision,
          references:this.references(creation),proposals:Object.values(state.proposals).filter(item=>item.creationId===creation.id).map(item=>({proposalId:item.id,revision:item.revision})),
          activeExecutionIds:Object.values(state.executions).filter(item=>item.creationId===creation.id&&['queued','dispatching','running','cancel_requested','unknown'].includes(item.status)).map(item=>item.id)};
      }else if(name==='read_proposal'){
        const proposal=state.proposals[proposalKey(args.proposalId,args.revision)];
        data=proposal&&proposal.creationId===creation.id?{proposalReadStatus:'ok',proposalId:proposal.id,revision:proposal.revision,
          positivePrompt:proposal.positivePrompt,negativePrompt:proposal.negativePrompt,stylePrompt:proposal.stylePrompt,
          changeSummary:proposal.summary,currentProposalRef:this.proposalRef(state,creation),selectionRevision:creation.selectionRevision}
          :{proposalReadStatus:'not_found',proposalId:args.proposalId,revision:args.revision};
      }else if(name==='propose_prompt'){
        const previous=args.proposalId?state.proposals[proposalKey(args.proposalId,args.baseRevision)]:undefined;
        const latest=args.proposalId?Math.max(0,...Object.values(state.proposals).filter(item=>item.id===args.proposalId&&item.creationId===creation.id).map(item=>item.revision)):0;
        if(args.proposalId&&(!previous||previous.creationId!==creation.id||latest!==args.baseRevision))data={proposalStatus:previous?'conflict':'not_found'};
        else{
          const id=previous?.id??randomUUID(),revision=latest+1;
          const proposal:R4Proposal={id,revision,conversationId:scope.conversationId,creationId:creation.id,
            title:previous?.title??'创作方案',summary:text(args.changeSummary,2000)||'根据当前创作要求编写',change:text(args.changeSummary,2000),
            keywords:text(args.positivePrompt).split(/[,，\n]/).map(item=>item.trim()).filter(Boolean).slice(0,6),
            positivePrompt:text(args.positivePrompt),negativePrompt:text(args.negativePrompt),stylePrompt:text(args.stylePrompt),
            publicParameters:{...(typeof args.modelVersion==='string'?{modelVersion:args.modelVersion}:{})},sourceMessageId:scope.messageId,sourceInputRevision:scope.inputCursor?.inputRevision??creation.inputRevision,createdAt:now()};
          for(const id of Array.isArray(args.sourceAttachmentIds)?args.sourceAttachmentIds:[])this.dependencies.resolveAttachment(workspace,state,scope.conversationId,creation.id,String(id));
          state.proposals[proposalKey(id,revision)]=proposal;
          data={proposalStatus:previous?'revised':'proposed',proposalId:id,revision,positivePrompt:proposal.positivePrompt,negativePrompt:proposal.negativePrompt,stylePrompt:proposal.stylePrompt,changeSummary:proposal.summary};
        }
      }else if(name==='set_current_proposal'){
        const selected=this.proposalRef(state,creation),revision=creation.selectionRevision;
        const proposal=state.proposals[proposalKey(args.proposalId,args.revision)];
        const same=creation.currentProposalRef===proposalKey(args.proposalId,args.revision);
        const valid=proposal&&proposal.creationId===creation.id;
        const selectionStatus=!valid?'not_found':args.expectedSelectionRevision!==revision?'conflict':same?'unchanged':'applied';
        before={currentProposalRef:creation.currentProposalRef??null,selectionRevision:revision};
        if(selectionStatus==='applied'){creation.currentProposalRef=proposalKey(args.proposalId,args.revision);creation.selectionRevision++;actionId=randomUUID();}
        data={selectionStatus,actionId:actionId??null,beforeRef:valid?selected:null,afterRef:valid?this.proposalRef(state,creation):null,
          beforeSelectionRevision:revision,selectionRevision:valid?creation.selectionRevision:null};
      }else if(name==='patch_creation_inputs'){
        const beforeRefs=this.references(creation);
        const original=this.snapshot(creation);
        const revision=creation.inputRevision;
        let inputStatus='applied';
        if(args.expectedInputRevision!==revision)inputStatus='conflict';
        else if(args.action==='clear_edit_source'){
          if(args.expectedAttachmentId!==undefined&&args.expectedAttachmentId!==creation.editSource?.attachmentId)inputStatus='conflict';
          else if(!creation.editSource&&!creation.mask)inputStatus='unchanged';
          else{creation.editSource=null;creation.mask=null;}
        }else{
          const attachment=this.dependencies.resolveAttachment(workspace,state,scope.conversationId,creation.id,String(args.attachmentId));
          if(String(attachment.revision)!==args.attachmentRevision)inputStatus='conflict';
          else{
            const old=creation.references.find(item=>item.attachmentId===attachment.attachmentId);
            const purpose=args.role==='reference'?args.referencePurpose as R4ReferenceBinding['purpose']:undefined;
            const preserved=old?.revision===attachment.revision&&old.purpose===purpose&&old.authorizationStatus==='authorized'&&old.includeInGeneration;
            const optIn=scope.referenceOptIns?.some(item=>item.attachmentId===attachment.attachmentId&&item.attachmentRevision===attachment.revision&&item.purpose===purpose);
            if(args.includeInGeneration===true&&!preserved&&!optIn)throw Error('这张参考尚未获得针对当前用途的明确参与生成授权。');
            const binding:R4ReferenceBinding={...attachment,role:args.role==='discussion'?'discussion':'reference',purpose,includeInGeneration:args.includeInGeneration===true,
              authorizationStatus:args.includeInGeneration===true?'authorized':'not_authorized',
              ...(args.includeInGeneration===true?{authorizationReceiptId:old?.authorizationReceiptId??randomUUID(),authorizedUserIntentRef:optIn?scope.userIntentRef:old?.authorizedUserIntentRef}:{})};
            if(old&&r4Hash({...old,authorizationReceiptId:undefined})===r4Hash({...binding,authorizationReceiptId:undefined}))inputStatus='unchanged';
            else creation.references=[...creation.references.filter(item=>item.attachmentId!==attachment.attachmentId),binding];
          }
        }
        if(inputStatus==='applied'){this.updateInput(state,creation);actionId=randomUUID();}
        before=original;
        const afterRefs=this.references(creation);
        const affected=[...new Set([...beforeRefs,...afterRefs].map(item=>item.attachmentId))];
        data={inputStatus,actionId:actionId??null,beforeRefs,afterRefs,inputRevision:creation.inputRevision,
          undo:actionId?{undoOfActionId:actionId,expectedInputRevision:creation.inputRevision,affectedAttachmentIds:affected,restoreRefs:beforeRefs}:null};
      }else throw Error(`此命令尚未注册业务处理：${name}`);
      const result=this.checked(name,scope,data);
      if(!['read_creation','read_proposal'].includes(name)){
        const operation=this.recordOperation(state,scope,name,args,result,before);
        if(actionId){delete state.operations[operation.id];operation.id=actionId;state.operations[actionId]=operation;}
      }
      tx.setR4State(state);
      return result;
    });
    if(name==='patch_creation_inputs'&&scope.inputCursor){
      const data=result.data as Record<string,unknown>|undefined;
      if(data&&['applied','unchanged'].includes(String(data.inputStatus)))scope.inputCursor.inputRevision=Number(data.inputRevision);
    }
    this.dependencies.onChanged?.(scope.conversationId);
    return result;
  }

  async prepare(args:Record<string,unknown>,scope:R4HostScope,internalOperation=false,workbenchSnapshot?:R4WorkbenchSnapshot) {
    if(args.targetConversationId!==undefined&&args.targetConversationId!==scope.conversationId||args.targetCreationId!==undefined&&args.targetCreationId!==scope.creationId)throw Error('预览目标与本轮授权范围不一致，未执行。');
    if(!this.dependencies.prepare)throw Error('生成准备服务尚未连接。');
    const initial=this.read(scope.conversationId);
    const creation=initial.creations[scope.creationId];
    if(!creation)throw Error('生成目标创作不存在。');
    if(scope.inputCursor&&scope.inputCursor.inputRevision!==creation.inputRevision)throw Error('原消息之后创作输入已变化，请发送新消息或重新预览，未沿用后来修改的输入。');
    const selectedConfig=scope.conversationConfig??initial.config;
    if(!selectedConfig)throw Error(initial.configurationIssue??'对话模型或助手预设尚未配置，请先选择有效配置。');
    const config=copy(selectedConfig);
    let inputArgs=copy(args);
    if(args.proposalId){
      const proposal=initial.proposals[proposalKey(args.proposalId,args.revision)];
      if(!proposal||proposal.creationId!==creation.id)throw Error('指定方案版本不存在。');
      inputArgs={...inputArgs,positivePrompt:proposal.positivePrompt,negativePrompt:proposal.negativePrompt,stylePrompt:proposal.stylePrompt};
      delete inputArgs.proposalId;delete inputArgs.revision;
    }
    const prepared=await this.dependencies.prepare(copy(creation),inputArgs,config,scope,workbenchSnapshot);
    const result=this.store.transaction(tx=>{
      const state=tx.getR4State(),current=this.scopeCreation(state,scope);
      if(current.inputRevision!==creation.inputRevision)throw Error('输入在准备期间发生变化，请重新预览。');
      const id=randomUUID(),timestamp=now();
      const input=prepared.input;
      input.publicParameters.turnLineageRef=scope.turnLineageRef??scope.userIntentRef;
      if(scope.releasedGateIds?.length)input.publicParameters.releasedGateIds=copy(scope.releasedGateIds);
      if(args.proposalId)input.proposalRef=proposalKey(args.proposalId,args.revision);
      const fingerprint=r4Hash({input,config,provider:prepared.providerRef});
      const preparation:R4Preparation={id,conversationId:scope.conversationId,creationId:scope.creationId,inputRevision:creation.inputRevision,
        fingerprint,inputSnapshot:input,conversationConfig:config,preview:prepared.preview,status:'ready',createdAt:timestamp,
        expiresAt:new Date(Date.now()+600_000).toISOString()};
      Object.assign(preparation,{userIntentRef:scope.userIntentRef,sourceMessageId:scope.messageId,providerRef:prepared.providerRef});
      state.preparations[id]=preparation;
      const data={preparationStatus:'prepared',preparationId:id,inputRevision:creation.inputRevision,
        inputFingerprint:fingerprint,sourceProposal:args.proposalId?{proposalId:args.proposalId,revision:args.revision}:null,preview:prepared.preview,expiresAt:preparation.expiresAt};
      // Direct edit tools return their own enqueue contract. Their host-only
      // preview can show operation-specific fields absent from prepare_generation.
      const result=internalOperation?data:this.checked('prepare_generation',scope,data);
      tx.setR4State(state);return result;
    });
    this.dependencies.onChanged?.(scope.conversationId);return result;
  }

  async command(request:R4CreativeCommand):Promise<R4CreativeCommandResult> {
    try{
      if(!request||typeof request.conversationId!=='string'||!request.conversationId||request.conversationId.length>200)throw Error('聊天标识无效。');
      const initial=this.read(request.conversationId),creationId=request.creationId??initial.currentCreationId!;
      const args=request.args??{},operationKey=request.operationId??randomUUID();
      const scope:R4HostScope={conversationId:request.conversationId,creationId,userIntentRef:`ui:${operationKey}`,operationKey};
      let data:Record<string,unknown>|undefined;
      if(request.type==='set_current_proposal'||request.type==='patch_inputs'||request.type==='prepare_generation'){
        data=await this.invoke(request.type==='patch_inputs'?'patch_creation_inputs':request.type,args,scope);
      }else if(request.type==='set_reference_usage'){
        const binding=this.dependencies.resolveAttachment(this.store.readWorkspace(),this.store.readR4State(),request.conversationId,creationId,String(args.attachmentId));
        if(args.attachmentRevision!==undefined&&args.attachmentRevision!==String(binding.revision))throw Error('附件修订已变化，未修改用途。');
        scope.referenceOptIns=args.includeInGeneration===true?[{attachmentId:binding.attachmentId,attachmentRevision:binding.revision,purpose:String(args.referencePurpose)}]:[];
        data=await this.invoke('patch_creation_inputs',{action:'set_reference_usage',...args,attachmentRevision:String(binding.revision)},scope);
      }else{
        const handled=await this.dependencies.command?.(request,this);
        if(handled)return handled;
        data=this.store.transaction(tx=>{
          const {workspace,state,conversation}=this.ensure(tx,request.conversationId);
          const creation=this.scopeCreation(state,scope);
          const replay=this.replay(state,scope,request.type,args);if(replay)return replay;
          let result:Record<string,unknown>={};
          if(request.type==='create_creation'){
            const created=this.newCreation(request.conversationId,text(args.title,100));created.requirements=text(args.requirements,4000);
            state.creations[created.id]=created;conversation.currentCreationId=created.id;result={creationId:created.id};
          }else if(request.type==='select_creation'){
            const selected=state.creations[String(args.creationId)];if(!selected||selected.conversationId!==request.conversationId)throw Error('目标创作不属于当前聊天。');
            conversation.currentCreationId=selected.id;
          }else if(request.type==='update_creation'){
            if(args.expectedInputRevision!==creation.inputRevision)throw Error('创作输入已变化，保留当前内容。');
            for(const key of ['positivePrompt','negativePrompt','stylePrompt','requirements'] as const)if(args[key]!==undefined)creation[key]=text(args[key],key==='requirements'?4000:20_000);
            if(args.publicParameters){if(typeof args.publicParameters!=='object'||Array.isArray(args.publicParameters))throw Error('生成参数格式无效。');creation.publicParameters=copy(args.publicParameters as Record<string,unknown>);}
            this.updateInput(state,creation);
          }else if(request.type==='set_edit_source'){
            if(args.expectedInputRevision!==creation.inputRevision)throw Error('图片输入已变化，请重新选择源图。');
            const source=this.dependencies.resolveAttachment(workspace,state,request.conversationId,creationId,String(args.attachmentId));
            if(args.attachmentRevision!==undefined&&args.attachmentRevision!==String(source.revision))throw Error('改图源修订已变化，未替换来源。');
            creation.editSource=source;
            creation.mask=args.maskAttachmentId?this.dependencies.resolveAttachment(workspace,state,request.conversationId,creationId,String(args.maskAttachmentId)):null;
            this.updateInput(state,creation);
          }else if(request.type==='remove_reference'){
            if(args.expectedInputRevision!==creation.inputRevision)throw Error('参考输入已变化。');
            const binding=creation.references.find(item=>item.attachmentId===args.attachmentId);
            if(args.attachmentRevision!==undefined&&args.attachmentRevision!==String(binding?.revision))throw Error('附件修订已变化，未移除参考。');
            creation.references=creation.references.filter(item=>item.attachmentId!==args.attachmentId);this.updateInput(state,creation);
          }else if(request.type==='select_artwork'){
            const artwork=state.artworks[String(args.artworkId)];if(!artwork||artwork.creationId!==creationId)throw Error('作品归属不匹配。');conversation.selectedArtworkId=artwork.id;
          }else if(request.type==='save_draft'){
            const previous=conversation.composerDraft??{text:'',revision:0,attachmentIds:[],updatedAt:now()};
            if(args.expectedDraftRevision!==previous.revision)throw Error('文字草稿已有新版本，未覆盖。');
            conversation.composerDraft={...previous,text:text(args.text),revision:previous.revision+1,attachmentIds:Array.isArray(args.attachmentIds)?args.attachmentIds.map(String):previous.attachmentIds,updatedAt:now()};
            result={draftRevision:conversation.composerDraft.revision};
          }else if(request.type==='undo_operation'){
            const previous=state.operations[String(args.operationId)];
            if(!previous||previous.creationId!==creationId||previous.conversationId!==request.conversationId)throw Error('找不到此更改的撤销记录。');
            const before=previous.receipt.before as Record<string,unknown>|undefined;
            if(!before)throw Error('此操作没有可恢复的先前状态。');
            if(previous.operation==='set_current_proposal'){
              const old=previous.receipt.result as {data:{selectionRevision:number}};
              if(creation.selectionRevision!==old.data.selectionRevision)throw Error('当前方案已再次改变，未撤销后续选择。');
              creation.currentProposalRef=before.currentProposalRef as string|null;creation.selectionRevision++;
            }else if(previous.operation==='patch_creation_inputs'){
              const old=previous.receipt.result as {data:{inputRevision:number}};
              if(creation.inputRevision!==old.data.inputRevision)throw Error('图片输入已再次改变，未覆盖后续修改。');
              const input=before as unknown as R4CreationInputSnapshot;
              for(const binding of [input.editSource,input.mask,...input.references])if(binding)this.dependencies.resolveAttachment(workspace,state,request.conversationId,creationId,binding.attachmentId);
              creation.editSource=copy(input.editSource);creation.mask=copy(input.mask);creation.references=copy(input.references);this.updateInput(state,creation);
            }else throw Error('此类操作不能通过此回执撤销。');
            result={undoneOperationId:previous.id};
          }else throw Error(`不支持的创作操作：${request.type}`);
          this.recordOperation(state,scope,request.type,args,result);
          tx.setR4State(state);return result;
        });
      }
      this.dependencies.onChanged?.(request.conversationId);
      return {ok:true,state:this.read(request.conversationId),data};
    }catch(error){return {ok:false,message:error instanceof Error?error.message:String(error)};}
  }
}

import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import {registry,R4_REGISTRY_SHA256,type R4ToolName} from '../../src/agent/r4-contracts';
import type {R4LegacyAdapterDependencies,R4LegacyCapabilitySnapshot} from '../../src/agent/r4-legacy-adapter';
import type {R4Artwork,R4QueuedMessage} from '../../src/agent/r4-types';
import type {AgentWorkspaceData} from '../../src/agent/types';
import type {R4HostScope} from './r4-creative-host';
import {getAgentSqlStore} from './agent-store';
import {getHistory,getSettings,getToken} from './store';
import {toLocalMediaUrl} from './local-media-protocol';
import {templateSelection} from './harness-prompt-templates';
import {NAI_RELAY_MODEL_IDS} from '../../src/nai-accounts';
import {buildCompatibleImageRequest,imageGenerationEndpoint} from '../../src/image-provider-contract';
import {agentWorkspaceDirectory} from './agent-workspace-location';
import {r4BindingRevision} from './r4-bindings';
import {resolveR4Attachment} from './r4-agent-service';

/** Paid gates are durable domain state, shared by model, tool and worker paths. */
export function assertR4DispatchAllowed(scope:R4HostScope,tool='model_call'){
  const state=getAgentSqlStore().readR4State();
  const definition=registry.tools.find(item=>item.canonical===tool);
  if(tool!=='model_call'&&!definition?.cost.mayCharge)return;
  const gate=Object.values(state.gates).find(item=>item.active&&((item.reason==='unknown_prior_receipt'&&!scope.releasedGateIds?.includes(item.id))
    ||item.turnId===(scope.turnLineageRef??scope.userIntentRef)||item.turnId===scope.userIntentRef));
  if(gate)throw Error(gate.reason==='unknown_prior_receipt'
    ?'已有收费任务的回执待核实，自动收费提交已暂停。请先查看队列处理该任务。'
    :'本轮已有收费操作失败，已停止后续收费提交。');
}

/** Conservative proof from the original human text, never from model args. */
export function r4ReferenceOptIns(item:R4QueuedMessage,workspace:AgentWorkspaceData):NonNullable<R4HostScope['referenceOptIns']>{
  const text=item.text;
  if(/仅讨论|只(?:用于|作)?讨论|不(?:要)?(?:用于|参与).{0,8}生成/.test(text))return [];
  if(!/参与生成|允许.{0,12}(?:生成|生图)|(?:用|参考).{0,20}(?:这张|此图|参考图).{0,20}(?:生成|生图)/.test(text))return [];
  const attachments=workspace.conversations.find(row=>row.id===item.conversationId)?.messages.find(row=>row.id===item.messageId)?.attachments??[];
  const candidates=new Map<string,{attachmentId:string;revision:number;name?:string;purpose?:string}>();
  for(const reference of item.originalInputSnapshot?.references??[])candidates.set(reference.attachmentId,reference);
  for(const binding of [item.originalInputSnapshot?.editSource,item.originalInputSnapshot?.mask])if(binding&&!candidates.has(binding.attachmentId))candidates.set(binding.attachmentId,binding);
  for(const attachment of attachments)if(!candidates.has(attachment.id))candidates.set(attachment.id,{attachmentId:attachment.id,revision:attachment.revision??1,name:attachment.name});
  const values=[...candidates.values()];
  const named=values.filter(row=>text.includes(row.attachmentId)||row.name&&text.includes(row.name));
  const selected=named.length===1?named:values.length===1&&/这张|此图|这幅|该参考/.test(text)?values:[];
  const purposes=[['色彩','color'],['构图','composition'],['角色','character'],['氛围','atmosphere']] as const;
  const explicit=purposes.filter(([label])=>text.includes(label));
  return selected.flatMap(reference=>{
    const purpose=explicit.length===1?explicit[0][1]:explicit.length===0?reference.purpose:undefined;
    return purpose?[{attachmentId:reference.attachmentId,attachmentRevision:reference.revision,purpose}]:[];
  });
}

export function r4RuntimeCapabilities(options:{approvalMode:'confirm'|'auto';webSearchEnabled:boolean;hasSkills:boolean;promptingReferenceEnabled:boolean;workbenchReady:boolean}):R4LegacyCapabilitySnapshot{
  const settings=getSettings();
  const groups=new Map<string,{group:string;toolNames:string[];capabilityKeys:string[]}>();
  const denied=new Map<string,string>();
  const nativeReady=settings.imageProvider!=='openai-images'&&Boolean(getToken()?.trim());
  let compatibleReady=false;
  if(settings.imageProvider==='openai-images'&&settings.compatibleImage&&settings.imageApiKey?.trim()){
    try{
      imageGenerationEndpoint(settings.compatibleImage.baseUrl);
      buildCompatibleImageRequest(settings.compatibleImage,{prompt:'capability check',n:1,size:settings.compatibleImage.size,extensions:settings.compatibleImage.extensions});
      compatibleReady=NAI_RELAY_MODEL_IDS.includes(settings.compatibleImage.model as typeof NAI_RELAY_MODEL_IDS[number]);
    }catch{/* Configuration is unavailable; discovery never sends a request. */}
  }
  for(const tool of registry.tools){
    let available=true,reason='disabled';
    if(tool.canonical==='search_web')available=options.webSearchEnabled;
    if(tool.canonical==='read_skill')available=options.hasSkills;
    if(tool.canonical==='read_prompting_reference')available=options.promptingReferenceEnabled;
    if(['apply_prompt','read_generation_state','write_workbench_prompts'].includes(tool.canonical)){available=options.workbenchReady;reason='not_configured';}
    if(tool.availability.group==='image_edit'){available=nativeReady;reason='not_configured';}
    if(['prepare_generation','generate_image'].includes(tool.canonical)){available=nativeReady||compatibleReady;reason='not_configured';}
    if(['convert_prompt','edit_prompt','reverse_prompt'].includes(tool.canonical)){available=paidServiceConfigured(settings,tool.canonical);reason='not_configured';}
    if(!available){denied.set(tool.availability.group,reason);continue;}
    const group=groups.get(tool.availability.group)??{group:tool.availability.group,toolNames:[],capabilityKeys:[]};
    group.toolNames.push(tool.canonical);
    for(const key of tool.availability.requires)if(!group.capabilityKeys.includes(key))group.capabilityKeys.push(key);
    groups.set(group.group,group);
  }
  return {catalogStatus:'ok',catalogVersion:`r4-product-1:${R4_REGISTRY_SHA256.slice(0,16)}`,approvalMode:options.approvalMode,
    available:[...groups.values()],mounted:['get_capabilities'],requestedGroups:[],requestedDenied:[...denied].map(([group,reason])=>({group,reason})),providerProjectionStatus:'host_only'};
}

function paidServiceConfigured(settings:ReturnType<typeof getSettings>,name:string){
  const url=name==='reverse_prompt'?settings.visionApiUrl:settings.convertApiUrl,key=name==='reverse_prompt'?settings.visionApiKey:settings.convertApiKey;
  if(!url?.trim()||!key?.trim())return false;
  try{const endpoint=new URL(url);return ['http:','https:'].includes(endpoint.protocol)&&!endpoint.username&&!endpoint.password&&!endpoint.search&&!endpoint.hash;}catch{return false;}
}

/** Validate explicit template/source dependencies before approval and again after it. */
export function preflightR4LegacyService(name:R4ToolName,args:Record<string,unknown>,scope:R4HostScope){
  if(!['convert_prompt','edit_prompt','reverse_prompt'].includes(name))return;
  const settings=getSettings();if(!paidServiceConfigured(settings,name))throw Error('所需提示词转换或图片反推服务尚未配置，工具未运行。');
  const kind=name==='reverse_prompt'?'reverse':name==='edit_prompt'?(args.kind==='custom'?'assistant':'optimize'):'convert';
  const selected=templateSelection(settings,{...args,kind,templateVersion:args.modelVersion});
  if(args.templateRevision!==undefined&&args.templateRevision!==selected.revision)throw Error('提示词模板修订已变化，请重新读取模板后再执行。');
  const base=name==='edit_prompt'?templateSelection(settings,{...args,kind:'convert',templateVersion:args.modelVersion}):selected;
  const store=getAgentSqlStore();
  const attachment=name==='reverse_prompt'?resolveR4Attachment(store.readWorkspace(),store.readR4State(),scope.conversationId,scope.creationId,String(args.attachmentId)):null;
  const dependencyKeys=['proxyMode','proxyUrl','visionApiUrl','visionApiKey','visionApiModel','convertApiUrl','convertApiKey','convertApiModel','reverseConvertDshEnabled','reverseConvertDshMode','reverseConvertPromptPresets','reverseConvertPromptPresetId','convertSystemPromptPresetId','reverseSystemPromptPresetId','visionSystemPrompt','convertSystemPrompt'];
  const binding=r4BindingRevision(agentWorkspaceDirectory(),[name,selected,base,attachment,...dependencyKeys.map(key=>settings[key as keyof typeof settings])]);
  if(scope.paidServiceRevision&&scope.paidServiceRevision!==binding)throw Error('收费工具的服务、模板或源附件在确认期间发生变化，未发送请求；请发起新操作。');
  scope.paidServiceRevision=binding;
}

/** Maps only managed readable assets, with content identity verified now. */
export function r4LegacyDependencies(scope:R4HostScope,name?:R4ToolName,callArgs:Record<string,unknown>={}):R4LegacyAdapterDependencies{
  const workspace=getAgentSqlStore().readWorkspace();
  const candidateScopes=new Map(workspace.memories.filter(item=>item.source==='pendingLlmCandidate').map(item=>[item.id,item.scope]));
  const templateArgs={...callArgs,templateVersion:callArgs.modelVersion??callArgs.templateVersion,kind:name==='reverse_prompt'?'reverse':name==='edit_prompt'?(callArgs.kind==='custom'?'assistant':'optimize'):callArgs.kind??'convert'};
  const template=['read_prompt_template','convert_prompt','edit_prompt','reverse_prompt'].includes(name??'')?templateSelection(getSettings(),templateArgs):undefined;
  return {
    verifiedTemplateRevision:()=>template?.revision,
    skillMetadata:id=>{
      const skill=workspace.skills.find(item=>item.id===id);
      return skill?{source:skill.builtIn?'builtin':'user-configured-skill',version:createHash('sha256').update(skill.instructions).digest('hex')}:undefined;
    },
    resolveCandidateScope:id=>candidateScopes.get(id),
    resolveAttachment:async input=>{
      if(input.scope.conversationId!==scope.conversationId||input.scope.creationId!==scope.creationId)return undefined;
      const store=getAgentSqlStore(),workspace=store.readWorkspace(),state=store.readR4State();
      const chat=workspace.conversations.find(item=>item.id===scope.conversationId);
      const attachment=[...(chat?.draftAttachments??[]),...(chat?.messages.flatMap(message=>[...message.attachments,...message.tools.flatMap(tool=>tool.generatedImages??[])])??[])].find(item=>item.id===input.attachmentId&&!item.unavailable);
      const existing=Object.values(state.artworks).find(item=>item.attachmentId===input.attachmentId&&item.conversationId===scope.conversationId&&item.creationId===scope.creationId);
      const history=getHistory().find(item=>item.id===input.attachmentId);
      const file=attachment?.filePath??existing?.readableHandle??history?.filePath;
      if(!file||!path.isAbsolute(file))return undefined;
      let bytes:Buffer;
      try{const stat=fs.statSync(file);if(!stat.isFile()||stat.size>48*1024*1024)return undefined;bytes=fs.readFileSync(file);}catch{return undefined;}
      const hash=createHash('sha256').update(bytes).digest('hex');
      if(existing?.hash&&hash!==existing.hash)return undefined;
      const metadata=await sharp(bytes).metadata().catch(()=>null);if(!metadata?.width||!metadata.height)return undefined;
      const artwork:R4Artwork=existing??{id:`${scope.creationId}:${input.attachmentId}`,attachmentId:input.attachmentId,revision:1,
        conversationId:scope.conversationId,creationId:scope.creationId,name:attachment?.name??path.basename(file),mime:metadata.format==='jpeg'?'image/jpeg':'image/png',
        readableHandle:file,url:toLocalMediaUrl(file,input.attachmentId),hash,width:metadata.width,height:metadata.height,createdAt:history?.createdAt??attachment?.createdAt??new Date().toISOString(),resolvedSeed:null,resolvedSeedSource:null};
      // Asset bookkeeping records ownership without selecting it or adding it
      // to the creation's generated-artwork gallery.
      if(!existing)store.transaction(tx=>{const current=tx.getR4State();current.artworks[artwork.id]=artwork;tx.setR4State(current);});
      const creation=state.creations[scope.creationId],reference=creation?.references.find(item=>item.attachmentId===artwork.attachmentId);
      return {artifactId:artwork.id,attachmentId:artwork.attachmentId,attachmentRevision:String(artwork.revision),hash,
        conversationId:scope.conversationId,creationId:scope.creationId,outputIndex:artwork.outputIndex??0,parentAttachmentId:artwork.parentAttachmentId??null,
        resolvedSeed:artwork.resolvedSeed??null,resolvedSeedSource:artwork.resolvedSeedSource==='provider_receipt'?'provider':artwork.resolvedSeedSource==='verified_embedded_metadata'?'verified_embedded':null,
        role:creation?.editSource?.attachmentId===artwork.attachmentId?'edit_source':reference?.purpose?'reference':reference?'discussion':'output',
        includeInGeneration:reference?.includeInGeneration??false,...(reference?.purpose?{referencePurpose:reference.purpose}:{})};
    },
  };
}

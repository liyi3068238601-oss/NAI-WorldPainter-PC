import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import type {AgentAttachment,AgentEvent,AgentWorkspaceData} from '../../src/agent/types';
import type {R4CreativeCommand,R4CreativeCommandResult} from '../../src/agent/r4-commands';
import type {R4AgentState,R4AttachmentBinding,R4ConversationConfigSnapshot,R4Creation,R4CreationInputSnapshot} from '../../src/agent/r4-types';
import {getAgentProviderRegistry} from '../../src/agent/provider-profiles';
import {studioSessionOptions,STUDIO_BUILTIN_PRESETS,studioSelectedSystemPrompt} from '../../src/agent/workspace-controls';
import {buildAgentGenerationInput} from '../../src/agent/generation-input';
import {DEFAULT_PARAMS,DEFAULT_AUGMENT_OPTIONS,effectiveNAIEffortParams,NAI_MODELS,NAI_INPAINT_MODELS,NAI_SAMPLERS,maxNAICharacterPrompts,supportsNAIPreciseReference,supportsNAIVibeTransfer,type AppSettings} from '../../src/types';
import {planUpscale} from '../../src/upscale-plan';
import {NAI_RELAY_MODEL_IDS} from '../../src/nai-accounts';
import {buildCompatibleImageRequest,imageGenerationEndpoint} from '../../src/image-provider-contract';
import {calculateImageGenerationAnlas} from '../../src/anlas';
import {getAgentSqlStore} from './agent-store';
import {getAccountSummary,getSettings,getToken,getHistory} from './store';
import {currentNaiAccount} from './nai-accounts-runtime';
import {agentWorkspaceDirectory} from './agent-workspace-location';
import {R4CreativeHost,type R4HostScope} from './r4-creative-host';
import {r4BindingRevision} from './r4-bindings';
import {R4ExecutionCoordinator} from './r4-execution-coordinator';
import {R4ImageProvider} from './r4-image-provider';
import {toLocalMediaUrl} from './local-media-protocol';

let eventSink:(event:AgentEvent)=>void=()=>{};
type AdditionalCommand=(request:R4CreativeCommand,host:R4CreativeHost)=>Promise<R4CreativeCommandResult|undefined>;
const additionalCommands:AdditionalCommand[]=[];
let host:R4CreativeHost|undefined;
let coordinator:R4ExecutionCoordinator|undefined;
const stateListeners=new Set<(conversationId:string)=>void>();
export function onR4CreativeChanged(listener:(conversationId:string)=>void){stateListeners.add(listener);return()=>stateListeners.delete(listener);}
export function setR4AgentEventSink(sink:(event:AgentEvent)=>void){eventSink=sink;}
export function setR4AdditionalCommand(handler:AdditionalCommand){additionalCommands.push(handler);}
export function hasActiveR4Executions(){return coordinator?.hasActiveRequests()??false;}

export function r4ImageProviderRef(settings=getSettings()){
  const account=currentNaiAccount();
  const providerId=settings.imageProvider==='openai-images'?'openai-images':'novelai';
  return {providerId,accountRef:providerId==='novelai'?(account?.id??'legacy-account'):'image-service',
    revision:r4BindingRevision(agentWorkspaceDirectory(),providerId==='novelai'
      ?[providerId,account?.id??null,getToken(),account?.apiBaseUrl,account?.imageBaseUrl,settings.imageBaseUrl,settings.apiBaseUrl,settings.outputDir,settings.generationGroupId,settings.proxyMode,settings.proxyUrl]
      :[providerId,settings.compatibleImage,settings.imageApiKey,settings.outputDir,settings.generationGroupId,settings.proxyMode,settings.proxyUrl])};
}

export function captureR4ConversationConfig(workspace:AgentWorkspaceData,state:R4AgentState,conversationId:string,source:'message_send'|'preview'):R4ConversationConfigSnapshot {
  const chat=workspace.conversations.find(item=>item.id===conversationId);
  if(!chat)throw Error('聊天不存在。');
  const settings=getSettings(),providers=getAgentProviderRegistry(settings),conversation=state.conversations[conversationId];
  const selectedId=conversation?.config?.providerRef.providerId??providers.activeProviderId;
  const provider=providers.providers.find(item=>item.id===selectedId);
  const modelId=conversation?.config?.modelId??provider?.modelId??settings.agentApiModel;
  if(!provider||!modelId?.trim())throw Error('请先为此聊天选择可用的对话供应商和模型。');
  const selectedModel=provider.models.find(item=>item.id===modelId);
  const binding=conversation?.assistantPresetBinding??state.assistantPresetDefaultBinding??{presetId:studioSessionOptions(chat).presetId,enabled:studioSessionOptions(chat).templateEnabled};
  const preset=state.assistantPresets[binding.presetId];
  if(binding.legacyStatus==='migration_conflict'||!preset&&!STUDIO_BUILTIN_PRESETS.some(item=>item.id===binding.presetId))throw Error('此聊天的助手预设绑定需要修复，请明确选择现有预设；原数据已保留，未换用默认预设。');
  const body=preset?.body??STUDIO_BUILTIN_PRESETS.find(item=>item.id===binding.presetId)?.body??studioSelectedSystemPrompt(workspace,chat);
  return {version:1,providerRef:{providerId:selectedId||'legacy-agent',revision:r4BindingRevision(agentWorkspaceDirectory(),[
    selectedId,provider?.protocol??settings.agentApiProtocol,provider?.baseUrl??settings.agentApiBaseUrl,provider?.apiKey??settings.agentApiKey,settings.proxyMode,settings.proxyUrl,
  ])},modelId,presetId:binding.presetId,enabled:binding.enabled,body,revision:preset?.revision??1,hash:createHash('sha256').update(body).digest('hex'),
    publicParameters:{protocol:provider?.protocol??settings.agentApiProtocol,baseUrl:provider?.baseUrl??settings.agentApiBaseUrl,
      maxOutputTokens:selectedModel?.maxOutputTokens??settings.agentMaxOutputTokens,contextWindow:selectedModel?.contextWindow??settings.agentContextWindow,visionEnabled:selectedModel?.vision??settings.agentVisionEnabled,
      reasoningEffort:chat.reasoningEffort&&chat.reasoningEffort!=='auto'?chat.reasoningEffort:selectedModel?.reasoningEffort??settings.agentReasoningEffort??'auto',
      autoCompact:settings.agentAutoCompact,autoCompactThreshold:settings.agentAutoCompactThreshold},
    capturedAt:new Date().toISOString(),source};
}

/** Resolve frozen public identities against the current protected credential store. */
export function settingsForR4Config(config:R4ConversationConfigSnapshot):AppSettings {
  const settings=getSettings(),registry=getAgentProviderRegistry(settings);
  const provider=registry.providers.find(item=>item.id===config.providerRef.providerId);
  if(!provider&&config.providerRef.providerId!=='legacy-agent')throw Error('原消息的对话供应商已不可用，未切换到其他配置。');
  const protocol=provider?.protocol??settings.agentApiProtocol,baseUrl=provider?.baseUrl??settings.agentApiBaseUrl,key=provider?.apiKey??settings.agentApiKey;
  const revision=r4BindingRevision(agentWorkspaceDirectory(),[config.providerRef.providerId==='legacy-agent'?'':config.providerRef.providerId,protocol,baseUrl,key,settings.proxyMode,settings.proxyUrl]);
  if(revision!==config.providerRef.revision)throw Error('原消息的对话服务配置或凭据已变化，请发起新的操作。');
  return {...settings,agentApiProtocol:protocol,agentApiBaseUrl:baseUrl,agentApiKey:key,agentApiModel:config.modelId,
    agentMaxOutputTokens:Number(config.publicParameters.maxOutputTokens)||settings.agentMaxOutputTokens,
    agentContextWindow:Number(config.publicParameters.contextWindow)||settings.agentContextWindow,
    agentVisionEnabled:config.publicParameters.visionEnabled===true,
    agentReasoningEffort:(config.publicParameters.reasoningEffort??'auto') as AppSettings['agentReasoningEffort'],
    agentAutoCompact:config.publicParameters.autoCompact===true,
    agentAutoCompactThreshold:Number(config.publicParameters.autoCompactThreshold)||settings.agentAutoCompactThreshold};
}

export function resolveR4Attachment(workspace:AgentWorkspaceData,state:R4AgentState,conversationId:string,creationId:string,id:string):R4AttachmentBinding {
  const creation=state.creations[creationId];
  if(!creation||creation.conversationId!==conversationId)throw Error('附件目标创作不存在。');
  const chat=workspace.conversations.find(item=>item.id===conversationId);
  const artwork=Object.values(state.artworks).find(item=>item.attachmentId===id&&item.conversationId===conversationId&&item.creationId===creationId);
  const candidates:AgentAttachment[]=[...(chat?.draftAttachments??[]),...(chat?.messages.flatMap(message=>[
    ...message.attachments,...message.tools.flatMap(tool=>tool.generatedImages??[]),
  ])??[])];
  const attachment=candidates.find(item=>item.id===id);
  if(attachment&&attachment.kind!=='image'&&!attachment.mime.startsWith('image/'))throw Error('此附件不是图片，不能作为改图源或生成参考。');
  const history=artwork?getHistory().find(item=>item.id===id):undefined;
  const file=attachment?.filePath??history?.filePath??artwork?.readableHandle;
  if(attachment?.unavailable||!file||!path.isAbsolute(file))throw Error('图片附件已不可读，请重新选择。');
  const stat=fs.statSync(file);if(!stat.isFile()||stat.size>48*1024*1024)throw Error('附件不存在或超过48MB。');
  const hash=createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const bound=artwork??creation.references.find(item=>item.attachmentId===id)??(creation.editSource?.attachmentId===id?creation.editSource:undefined)??(creation.mask?.attachmentId===id?creation.mask:undefined);
  if(bound?.hash&&bound.hash!==hash)throw Error('图片文件内容已变化，原绑定已失效。');
  return {attachmentId:id,revision:bound?.revision??1,hash,name:attachment?.name??artwork?.name??path.basename(file),mime:attachment?.mime??artwork?.mime??'image/png',
    width:attachment?.width??artwork?.width,height:attachment?.height??artwork?.height};
}

type R4PreparedImage={input:R4CreationInputSnapshot;providerRef:ReturnType<typeof r4ImageProviderRef>;preview:Record<string,unknown>};
async function prepareR4Generation(creation:R4Creation,args:Record<string,unknown>,config:R4ConversationConfigSnapshot,scope:R4HostScope):Promise<R4PreparedImage> {
  if(args.__operation)return prepareR4Edit(creation,args,config,scope);
  const settings=getSettings(),state=getAgentSqlStore().readR4State(),workspace=getAgentSqlStore().readWorkspace();
  const providerRef=r4ImageProviderRef(settings);
  const count=Number(args.count??1);
  if(!Number.isSafeInteger(count)||count<1||count>8)throw Error('生成张数须为1–8。');
  if(!String(args.positivePrompt??'').trim())throw Error('正面提示词不能为空。');
  for(const binding of [creation.editSource,creation.mask,...creation.references])if(binding)resolveR4Attachment(workspace,state,scope.conversationId,scope.creationId,binding.attachmentId);
  const references=creation.references.filter(item=>item.includeInGeneration);
  if(creation.editSource&&Number(args.noise??0)!==0)throw Error('当前改图实现不支持非零 noise，请明确改为 0 后重新预览。');
  for(const binding of references)if(!binding.purpose||binding.role!=='reference'||binding.authorizationStatus!=='authorized'||!binding.authorizationReceiptId)throw Error('参考用途缺少确切的参与生成授权。');
  const input:R4CreationInputSnapshot={...getR4CreativeHost().snapshot(creation),positivePrompt:String(args.positivePrompt),negativePrompt:String(args.negativePrompt??''),stylePrompt:String(args.stylePrompt??''),conversationConfig:config};
  if(providerRef.providerId==='openai-images'){
    if(creation.editSource||references.length||String(args.stylePrompt??'')||Object.keys(creation.publicParameters).length)throw Error('当前图片服务仅接入文生图，不能静默丢弃风格词、改图源、参考或原生参数。');
    for(const key of Object.keys(args))if(!['positivePrompt','negativePrompt','stylePrompt','count','targetConversationId','targetCreationId','model'].includes(key))throw Error(`当前兼容服务不支持参数 ${key}。`);
    if(!settings.compatibleImage||!settings.imageApiKey?.trim())throw Error('图片服务尚未配置。');
    if(!NAI_RELAY_MODEL_IDS.includes(settings.compatibleImage.model as typeof NAI_RELAY_MODEL_IDS[number]))throw Error('当前兼容服务仅支持 NovelAI 模型，未创建生成预览。');
    const compatibleConfig={...structuredClone(settings.compatibleImage),extensions:{...settings.compatibleImage.extensions,negative_prompt:input.negativePrompt}};
    imageGenerationEndpoint(compatibleConfig.baseUrl);
    buildCompatibleImageRequest(compatibleConfig,{prompt:input.positivePrompt,n:count,size:compatibleConfig.size,extensions:compatibleConfig.extensions});
    if(args.model&&args.model!==settings.compatibleImage.model)throw Error('请求模型与当前图片服务配置不符。');
    input.publicParameters={operation:'generate_image',count,providerRef,compatibleConfig,requestBudget:{image:1,vibe_encode:0,upscale:0},requestedSeedPolicy:'random',requestedSeed:null};
    return {input,providerRef,preview:{positivePrompt:input.positivePrompt,negativePrompt:input.negativePrompt,stylePrompt:'',count,imageProvider:'openai-images',estimateSource:'provider-unknown',estimatedAnlas:null,
      warning:'费用以所选服务商为准。',requestedSeedPolicy:'random',requestedSeed:null,resolvedSeed:null,resolvedSeedSource:null}};
  }
  if(!getToken()?.trim())throw Error('当前图片账号尚未配置，未创建生成预览。');
  const model=String(args.model??creation.publicParameters.model??settings.lastGenerationState?.params.model??DEFAULT_PARAMS.model);
  if(!NAI_MODELS.some(item=>item.value===model))throw Error('所选生图模型不在当前支持目录中。');
  if(args.sampler&&!NAI_SAMPLERS.some(item=>item.value===args.sampler))throw Error('不支持所请求的采样器。');
  if(Array.isArray(args.characterPrompts)&&args.characterPrompts.length>maxNAICharacterPrompts(model))throw Error('角色提示词数量超过当前模型能力，未截断后提交。');
  const mapped:Record<string,unknown>={...creation.publicParameters,...args,negativePrompt:String(args.negativePrompt??''),stylePrompt:String(args.stylePrompt??''),seedMode:args.requestedSeedPolicy??creation.publicParameters.seedMode,
    ...(args.requestedSeed!==undefined?{seed:args.requestedSeed}:{}),model};
  const built=buildAgentGenerationInput(mapped,{params:settings.lastGenerationState?.params??DEFAULT_PARAMS,
    extras:{vibeImages:[],preciseReferences:[],charCaptions:[],historyGroupId:settings.generationGroupId||undefined,modelMode:settings.modelMode}},()=> 'host-bound-reference');
  for(const key of ['width','height','steps','cfgScale','cfgRescale','seed','seedMode','sampler','noiseSchedule','smea','smeaDyn','variety','effort','qualityPreset','ucPreset','transparentBackground'] as const)if(mapped[key]!==undefined&&built.params[key]!==mapped[key])throw Error(`参数 ${key} 无法原样生效，请调整后重新预览。`);
  const explicitRefs=[...(Array.isArray(args.vibeReferences)?args.vibeReferences:[]),...(Array.isArray(args.preciseReferences)?args.preciseReferences:[])] as Array<Record<string,unknown>>;
  for(const reference of explicitRefs){
    const binding=references.find(item=>item.attachmentId===reference.attachmentId&&String(item.revision)===reference.attachmentRevision&&item.purpose===reference.referencePurpose);
    if(!binding)throw Error('模型指定的参考不在本次已授权用途范围内。');
  }
  const explicitReferencePlan=Array.isArray(args.vibeReferences)||Array.isArray(args.preciseReferences);
  if(explicitReferencePlan){
    const identities=explicitRefs.map(item=>`${item.attachmentId}@${item.attachmentRevision}`);
    if(new Set(identities).size!==identities.length||references.some(item=>!identities.includes(`${item.attachmentId}@${item.revision}`)))throw Error('本次参考计划与已选择参与生成的图片不一致，不能重复或静默遗漏参考。');
  }
  const referenceInputs=references.map(binding=>({attachmentId:binding.attachmentId,attachmentRevision:String(binding.revision),role:'reference',includeInGeneration:true,referencePurpose:binding.purpose}));
  const usePrecise=supportsNAIPreciseReference(built.params.model),useVibe=supportsNAIVibeTransfer(built.params.model);
  if(referenceInputs.length&&!usePrecise&&!useVibe)throw Error('当前模型不支持所选参考。');
  const effective=effectiveNAIEffortParams(built.params);
  const params={...built.params,...effective};
  const vibeReferences=explicitReferencePlan?(args.vibeReferences??[]):!usePrecise?referenceInputs:[];
  const preciseReferences=explicitReferencePlan?(args.preciseReferences??[]):usePrecise?referenceInputs.map(reference=>({...reference,type:reference.referencePurpose==='character'?'character':'style'})):[];
  input.positivePrompt=params.positivePrompt;input.negativePrompt=params.negativePrompt;input.stylePrompt=params.stylePrompt;
  input.publicParameters={operation:creation.editSource?'redraw_image':'generate_image',count,params:built.params,effectiveParams:params,providerRef,
    vibeReferences,preciseReferences,characterPrompts:args.characterPrompts??[],modelMode:settings.modelMode,historyGroupId:settings.generationGroupId||undefined,
    strength:args.strength??0.7,noise:args.noise??0,
    requestBudget:{image:count,vibe_encode:(vibeReferences as unknown[]).length*count,upscale:0}};
  const advanced=references.length>0||explicitRefs.length>0||Array.isArray(args.characterPrompts)&&args.characterPrompts.length>0;
  const quote=advanced||currentNaiAccount()?.method==='relay'?null:calculateImageGenerationAnlas({params:built.params,account:getAccountSummary(),batchCount:count});
  const requestedSeedPolicy=params.seedMode==='fixed'?'fixed':'random';
  Object.assign(input.publicParameters,{requestedSeedPolicy,requestedSeed:requestedSeedPolicy==='fixed'?params.seed:null});
  return {input,providerRef,preview:{positivePrompt:params.positivePrompt,negativePrompt:params.negativePrompt,stylePrompt:params.stylePrompt,model:params.model,width:params.width,height:params.height,steps:params.steps,count,
    imageProvider:'novelai',estimateSource:quote?'local-estimate':'provider-unknown',estimatedAnlas:quote?.amount??null,
    warning:quote?'本地估算，实际扣费以服务回执为准。':'此渠道或参考参数无法可靠估价，可能收费。',
    requestedSeedPolicy,requestedSeed:requestedSeedPolicy==='fixed'?params.seed:null,resolvedSeed:null,resolvedSeedSource:null,
    sourceAttachmentIds:[...(creation.editSource?[creation.editSource.attachmentId]:[]),...references.map(item=>item.attachmentId)]}};
}

/** Explicit edit tools use this same durable preview/approval/enqueue path. */
export async function prepareR4ImageOperation(name:'redraw_image'|'inpaint_image'|'upscale_image'|'process_image',args:Record<string,unknown>,scope:R4HostScope,signal:AbortSignal){
  signal.throwIfAborted();
  const result=await getR4CreativeHost().prepare({...args,__operation:name},scope,true);
  signal.throwIfAborted();
  const data=result as Record<string,unknown>;
  return {preparationId:String(data.preparationId),fingerprint:String(data.inputFingerprint)};
}

async function prepareR4Edit(creation:R4Creation,args:Record<string,unknown>,config:R4ConversationConfigSnapshot,scope:R4HostScope):Promise<R4PreparedImage>{
  const operation=String(args.__operation),settings=getSettings(),store=getAgentSqlStore();
  if(settings.imageProvider==='openai-images')throw Error('当前兼容图片服务尚未接入此改图操作。');
  if(!getToken()?.trim())throw Error('当前图片账号尚未配置。');
  const workspace=store.readWorkspace(),state=store.readR4State();
  const source=resolveR4Attachment(workspace,state,scope.conversationId,scope.creationId,String(args.attachmentId));
  const chat=workspace.conversations.find(item=>item.id===scope.conversationId);
  const file=chat?.draftAttachments.concat(chat.messages.flatMap(message=>[...message.attachments,...message.tools.flatMap(tool=>tool.generatedImages??[])])).find(item=>item.id===source.attachmentId)?.filePath
    ??Object.values(state.artworks).find(item=>item.attachmentId===source.attachmentId&&item.creationId===creation.id)?.readableHandle;
  if(!file)throw Error('指定源图不可读。');
  const metadata=await sharp(file).metadata();
  if(!metadata.width||!metadata.height)throw Error('指定源图没有有效尺寸。');
  source.width=metadata.width;source.height=metadata.height;
  const bound=structuredClone(creation);bound.editSource=source;bound.mask=null;
  // Processing and upscaling have no generation-reference input. The creation's
  // persistent choices remain available for its next image-generation preview.
  if(operation!=='redraw_image')bound.references=[];
  const clean={...args};delete clean.__operation;delete clean.attachmentId;delete clean.maskAttachmentId;
  if(operation==='redraw_image'||operation==='inpaint_image'){
    if(Number(args.noise??0)!==0)throw Error('当前原生改图实现不支持非零 noise，请明确改为 0 后重新预览。');
    const inpaintModel=String(args.inpaintModel??`${args.model??settings.lastGenerationState?.params.model??DEFAULT_PARAMS.model}-inpainting`);
    delete clean.inpaintModel;
    if(operation==='inpaint_image'){
      if(!NAI_INPAINT_MODELS.some(item=>item.value===inpaintModel))throw Error('局部重绘模型不受支持，请选择明确的兼容模型。');
      bound.mask=resolveR4Attachment(workspace,state,scope.conversationId,scope.creationId,String(args.maskAttachmentId));
    }
    const prepared=await prepareR4Generation(bound,clean,config,scope);
    Object.assign(prepared.input.publicParameters,{operation,noise:0,...(operation==='inpaint_image'?{inpaintModel}:{} )});
    if(bound.mask)prepared.input.mask=bound.mask;
    Object.assign(prepared.preview,{operation,sourceAttachmentIds:[source.attachmentId,...(bound.mask?[bound.mask.attachmentId]:[])],strength:Number(args.strength??0.7),noise:0,...(operation==='inpaint_image'?{inpaintModel}:{})});
    return prepared;
  }
  const providerRef=r4ImageProviderRef(settings);
  const params={...(settings.lastGenerationState?.params??DEFAULT_PARAMS)};
  const input={...getR4CreativeHost().snapshot(bound),conversationConfig:config};
  let width=source.width,height=source.height,passes=1;
  if(operation==='upscale_image'){
    if(args.scale!==2&&args.scale!==4)throw Error('放大倍率须为 2 或 4。');
    const plan=planUpscale(width,height,args.scale);if(plan.exceedsLimit)throw Error('指定倍率超过当前放大限制，请选择更小倍率。');
    width=plan.width;height=plan.height;passes=plan.passes;
    input.publicParameters={operation,count:1,params,providerRef,scale:args.scale,upscalePasses:passes,
      requestBudget:{image:0,vibe_encode:0,upscale:passes},requestedSeedPolicy:'random',requestedSeed:null};
  }else if(operation==='process_image'){
    const processOptions={...DEFAULT_AUGMENT_OPTIONS,...Object.fromEntries(['colorizePrompt','emotion','emotionLevel','defry'].filter(key=>args[key]!==undefined).map(key=>[key,args[key]]))};
    input.publicParameters={operation,count:1,params,providerRef,processOperation:args.operation,processOptions,
      requestBudget:{image:1,vibe_encode:0,upscale:0},requestedSeedPolicy:'random',requestedSeed:null};
  }else throw Error('图片处理类型不受支持。');
  return {input,providerRef,preview:{operation,count:1,imageProvider:'novelai',sourceAttachmentIds:[source.attachmentId],width,height,
    ...(operation==='upscale_image'?{scale:args.scale,requestCount:passes}:{processOperation:args.operation,processOptions:input.publicParameters.processOptions}),
    estimatedAnlas:null,estimateSource:'provider-unknown',warning:'此操作可能收费；费用以服务回执为准。',requestedSeedPolicy:'random',requestedSeed:null,resolvedSeed:null,resolvedSeedSource:null}};
}

export function getR4CreativeHost():R4CreativeHost{
  if(!host||host.store!==getAgentSqlStore())host=new R4CreativeHost(getAgentSqlStore(),{
    captureConfig:captureR4ConversationConfig,resolveAttachment:resolveR4Attachment,prepare:prepareR4Generation,
    projectState:(state,workspace)=>{
      const chat=workspace.conversations.find(item=>item.id===state.conversationId);
      const attachments=new Map([...(chat?.draftAttachments??[]),...(chat?.messages.flatMap(message=>[...message.attachments,...message.tools.flatMap(tool=>tool.generatedImages??[])])??[])].map(item=>[item.id,item]));
      for(const artwork of Object.values(state.artworks)){
        const attachment=attachments.get(artwork.attachmentId),file=artwork.readableHandle??attachment?.filePath;
        if(!attachment?.unavailable&&file&&path.isAbsolute(file)&&fs.existsSync(file))artwork.url=toLocalMediaUrl(file,artwork.attachmentId);
        else delete artwork.url;
      }
      return state;
    },
    onChanged:conversationId=>{eventSink({kind:'creative-state',state:host!.read(conversationId)});for(const listener of stateListeners)listener(conversationId);},
    command:async(request,current)=>{
      if(['set_preset_binding','set_new_chat_defaults','update_preset','set_model_binding'].includes(request.type)){
        const result=current.store.transaction(tx=>{
          const state=tx.getR4State(),workspace=tx.getWorkspace(),conversation=state.conversations[request.conversationId],args=request.args??{};
          if(!conversation)throw Error('聊天状态不存在。');
          if(request.type==='set_model_binding'){
            const providers=getAgentProviderRegistry(getSettings());const provider=providers.providers.find(item=>item.id===args.providerId);
            if(!provider||!provider.models.some(item=>item.id===args.modelId)&&provider.modelId!==args.modelId)throw Error('对话模型不存在于所选供应商。');
            conversation.config={...conversation.config!,providerRef:{providerId:provider.id},modelId:String(args.modelId)};
          }else{
            const preset=state.assistantPresets[String(args.presetId)];if(!preset)throw Error('助手预设不存在。');
            if(request.type==='set_new_chat_defaults')state.assistantPresetDefaultBinding={presetId:preset.id,enabled:args.enabled===true};
            else if(request.type==='set_preset_binding')conversation.assistantPresetBinding={presetId:preset.id,enabled:args.enabled===true};
            else{
              if(args.expectedRevision!==preset.revision)throw Error('共享预设已更新，未覆盖。');
              if(typeof args.body!=='string'||args.body.length>1_000_000)throw Error('预设正文格式或长度无效。');
              const history=state.compatibility.presetRevisionHistory as Record<string,unknown>??{};
              history[`${preset.id}@${preset.revision}`]=structuredClone(preset);state.compatibility.presetRevisionHistory=history;
              preset.body=args.body;preset.hash=createHash('sha256').update(args.body).digest('hex');preset.revision++;preset.updatedAt=new Date().toISOString();
              if(typeof args.name==='string'&&args.name.trim())preset.name=args.name.slice(0,100);
            }
          }
          const affected=request.type==='update_preset'?Object.values(state.conversations).filter(item=>item.assistantPresetBinding?.presetId===String(args.presetId)):[conversation];
          for(const target of affected){
            try{target.config=captureR4ConversationConfig(workspace,state,target.conversationId,'preview');delete target.configurationIssue;}
            catch(error){delete target.config;target.configurationIssue=error instanceof Error?error.message:'对话配置需要修复。';}
          }
          tx.setR4State(state);return {ok:true};
        });
        return {...result,state:current.read(request.conversationId)};
      }
      const executionResult=await getR4ExecutionCoordinator().command(request);if(executionResult)return executionResult;
      for(const handler of additionalCommands){const result=await handler(request,current);if(result)return result;}
      return undefined;
    },
  });
  return host;
}

export function getAgentCreativeState(conversationId:string){return getR4CreativeHost().read(conversationId);}
export async function agentCreativeCommand(request:R4CreativeCommand){return getR4CreativeHost().command(request);}

export function getR4ExecutionCoordinator():R4ExecutionCoordinator{
  const current=getR4CreativeHost();
  if(!coordinator||coordinator.host!==current){
    coordinator=new R4ExecutionCoordinator(current,new R4ImageProvider(),error=>{
      console.warn('[R4 execution]',error instanceof Error?error.message:'execution failed');
    });
    coordinator.worker.recover();
  }
  return coordinator;
}

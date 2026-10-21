import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import type {AgentAttachment,AgentEvent,AgentWorkspaceData} from '../../src/agent/types';
import type {R4CreativeCommand,R4CreativeCommandResult} from '../../src/agent/r4-commands';
import type {R4AgentState,R4AttachmentBinding,R4ConversationConfigSnapshot,R4Creation,R4CreationInputSnapshot,R4WorkbenchAssetBinding} from '../../src/agent/r4-types';
import {getAgentProviderRegistry} from '../../src/agent/provider-profiles';
import {studioSessionOptions,STUDIO_BUILTIN_PRESETS,studioSelectedSystemPrompt} from '../../src/agent/workspace-controls';
import {buildAgentGenerationInput} from '../../src/agent/generation-input';
import {DEFAULT_PARAMS,DEFAULT_AUGMENT_OPTIONS,effectiveNAIEffortParams,NAI_MODELS,NAI_INPAINT_MODELS,NAI_SAMPLERS,maxNAICharacterPrompts,normalizeGenerateParams,supportsNAIPreciseReference,supportsNAIVibeTransfer,type AppSettings,type GenerateParams,type I2IParams} from '../../src/types';
import {matchingVibeEncoding,type VibeEncoding} from '../../src/vibe-file';
import {adaptiveNAIImageSize} from '../../src/nai-dimensions';
import {inpaintSizePlan,type InpaintSize} from '../../src/inpaint-size';
import type {InpaintRegion} from '../../src/focused-inpaint';
import type {R4WorkbenchSnapshot} from '../../src/agent/r4-workbench-contract';
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
import {getR4WorkbenchService} from './r4-workbench';
import {importR4WorkbenchAsset,importR4WorkbenchVibeEncoding} from './r4-workbench-assets';

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

const MAX_ASSISTANT_PRESET_NAME_LENGTH=100;
const MAX_ASSISTANT_PRESET_BODY_LENGTH=1_000_000;
function validatedAssistantPresetName(value:unknown){
  if(typeof value!=='string')throw Error('预设名称格式无效。');
  const name=value.trim();
  if(!name||name.length>MAX_ASSISTANT_PRESET_NAME_LENGTH)throw Error(`预设名称不能为空且最多${MAX_ASSISTANT_PRESET_NAME_LENGTH}个字符。`);
  return name;
}
function validatedAssistantPresetBody(value:unknown){
  if(typeof value!=='string'||!value.trim()||value.length>MAX_ASSISTANT_PRESET_BODY_LENGTH)throw Error(`预设正文不能为空且最多${MAX_ASSISTANT_PRESET_BODY_LENGTH}个字符。`);
  return value;
}

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
function workbenchRecord(value:unknown):value is Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function numeric(value:unknown,fallback:number,min:number,max:number,label:string){
  if(value===undefined||value===null)return fallback;
  if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max)throw Error(`${label} 无效。`);
  return value;
}

function validateWorkbenchArguments(args:Record<string,unknown>,params:GenerateParams,count:number,mode:string,operation:'generate_image'|'redraw_image'|'inpaint_image',strength:number){
  const ignored=new Set(['proposalId','revision','targetConversationId','targetCreationId','expectedDraftRevision']);
  const prompts=new Set(['positivePrompt','negativePrompt','stylePrompt']);
  const mapped:Record<string,unknown>={...params,count,strength,noise:0,requestedSeedPolicy:params.seedMode,requestedSeed:params.seedMode==='fixed'?params.seed:undefined};
  for(const [key,value] of Object.entries(args)){
    if(ignored.has(key))continue;
    if(prompts.has(key)){if(value!==params[key as keyof GenerateParams])throw Error(`工作台 ${key} 已变化；请先用 write_workbench_prompts 写入，再重新读取工作台准备生成。`);continue;}
    if(['vibeReferences','preciseReferences','characterPrompts'].includes(key))throw Error('参考图与多角色必须使用 Generate 工作台中当前已选内容，不能用工具参数覆盖。');
    if(key==='count'||key==='model'||key==='strength'||key==='noise'||key==='requestedSeedPolicy'||key==='requestedSeed'||
      ['width','height','steps','cfgScale','cfgRescale','sampler','noiseSchedule','smea','smeaDyn','variety','effort','qualityPreset','ucPreset','transparentBackground','fileNamePrefix'].includes(key)){
      if(value!==mapped[key])throw Error(`工作台 ${key} 与本次请求不一致；请先在工作台修改并回读，再准备生成。`);
      continue;
    }
    throw Error(`工作台生成不接受独立覆盖字段 ${key}；请直接修改 Generate 工作台。`);
  }
  void mode;void operation;
}

async function prepareR4Generation(creation:R4Creation,args:Record<string,unknown>,config:R4ConversationConfigSnapshot,scope:R4HostScope,workbenchSnapshot?:R4WorkbenchSnapshot):Promise<R4PreparedImage> {
  if(args.__operation)return prepareR4Edit(creation,args,config,scope);
  const snapshot=workbenchSnapshot??await getR4WorkbenchService().readR4WorkbenchSnapshot();
  return prepareR4WorkbenchGeneration(creation,args,config,scope,snapshot);
}

/** Revalidate the exact live workbench revision after approval and immediately before durable enqueue. */
export async function assertR4WorkbenchPreparationCurrent(preparationId:string,conversationId:string,creationId:string):Promise<void>{
  const preparation=getR4CreativeHost().store.readR4State().preparations[preparationId];
  if(!preparation||preparation.conversationId!==conversationId||preparation.creationId!==creationId)return;
  const parameters=preparation.inputSnapshot.publicParameters;
  const expectedId=parameters.workbenchDraftId,expectedRevision=parameters.workbenchDraftRevision;
  if(expectedId===undefined&&expectedRevision===undefined)return; // Legacy preparation, not sourced from the live workbench.
  if(typeof expectedId!=='string'||!Number.isSafeInteger(expectedRevision)||Number(expectedRevision)<0)throw Error('生成准备记录中的工作台版本无效，未入队。');
  let current:R4WorkbenchSnapshot;
  try{current=await getR4WorkbenchService().readR4WorkbenchSnapshot();}
  catch(error){throw Error(`无法确认 Generate 工作台是否仍为预览版本，未入队：${error instanceof Error?error.message:'工作台读取失败'}`);}
  if(current.draftId!==expectedId||current.draftRevision!==expectedRevision)throw Error('确认期间 Generate 工作台已变化；请重新读取并准备，旧预览未入队。');
}

async function prepareR4WorkbenchGeneration(creation:R4Creation,args:Record<string,unknown>,config:R4ConversationConfigSnapshot,scope:R4HostScope,snapshot:R4WorkbenchSnapshot):Promise<R4PreparedImage>{
  if(!snapshot.workbench)throw Error('无法读取 Generate 工作台的完整模式、图片来源和多角色设置。');
  const live=snapshot.workbench,mode=String(live.mode??'generate:t2i');
  if(mode==='inpaint:mobile')throw Error('新版局部重绘使用独立画布，当前助手不支持；请切回 Generate 或旧版局部重绘。');
  if(mode==='generate:enhance')throw Error('增强模式的倍率与参数由局部界面状态管理，尚未纳入安全快照；请切回文生图/图生图。');
  if(mode.startsWith('postprocess:'))throw Error('后处理工具不属于 Generate 生图工作台；请切回文生图/图生图。');
  if(!['generate:t2i','generate:i2i','inpaint'].includes(mode))throw Error(`当前工作台模式 ${mode} 尚未接入 R4，未生成预览。`);
  const busy=live.busy;
  if(busy?.isGenerating||busy?.isGenerateQueueRunning||busy?.batchRunning)throw Error('生成工作台正在运行；请等待完成后重新准备，未入队。');
  if(args.expectedDraftRevision!==undefined&&args.expectedDraftRevision!==snapshot.draftRevision)throw Error('Generate 工作台已变化；请重新读取后再准备，未使用过期草稿。');
  const paramsSource={...DEFAULT_PARAMS,...snapshot.params};
  const baseParams=normalizeGenerateParams(paramsSource as Partial<GenerateParams>);
  const params={...baseParams,...(mode==='inpaint'?{positivePrompt:String(live.inpaintPositivePrompt??baseParams.positivePrompt)}:{})};
  if(!params.positivePrompt.trim())throw Error('工作台正面提示词为空，请先填入正面提示词。');
  if(mode==='inpaint'&&!NAI_INPAINT_MODELS.some(item=>item.value===live.inpaintModel))throw Error('当前局部重绘模型不受支持，未准备请求。');
  if(!NAI_MODELS.some(item=>item.value===params.model))throw Error('当前工作台模型不在支持目录中。');
  const count=mode==='inpaint'?1:Number(live.batchCount??1);
  if(!Number.isSafeInteger(count)||count<1||count>8)throw Error('当前工作台批量数量必须为1–8；未截断数量。');
  const batchIntervalSeconds=Number(live.batchIntervalSeconds??0);
  if(!Number.isFinite(batchIntervalSeconds)||batchIntervalSeconds<0||batchIntervalSeconds>3600)throw Error('当前批次间隔无效。');
  const workbenchParams=mode==='generate:i2i'&&live.i2iSizeMode==='adaptive'&&live.source
    ?{...params,...adaptiveNAIImageSize(Number(live.source.width),Number(live.source.height),params)}:params;
  const inpaintSource=mode==='inpaint'?live.source:null;
  const i2i=mode==='generate:i2i'?(live.i2iParams??{}) as Partial<I2IParams>:undefined;
  const strength=mode==='inpaint'?numeric(live.inpaintStrength,0.7,0,1,'局部重绘强度'):
    mode==='generate:i2i'?numeric(i2i?.strength,0.7,0,1,'图生图强度'):0;
  if(mode==='generate:i2i'&&i2i?.upscaledEnhance===true)throw Error('当前 R4 图生图还不支持 V5「增强」，请先在工作台关闭此选项。');
  if(mode==='generate:i2i'&&Number(i2i?.noise??0)!==0)throw Error('当前 Generate 图生图实现固定 noise=0，请先在工作台将噪声设为0。');
  if(mode==='inpaint'&&Number(live.inpaintNoise??0)!==0)throw Error('当前重绘端点固定 noise=0，请先在工作台将噪声设为0。');
  const inpaintRegion=mode==='inpaint'&&workbenchRecord(live.region)?live.region as unknown as InpaintRegion:undefined;
  const rawChars=Array.isArray(live.charCaptions)?live.charCaptions:[];
  if(rawChars.length>32)throw Error('Generate 工作台多角色项目超过32项。');
  const characterPrompts=rawChars.filter(workbenchRecord).map(item=>({
    ...(typeof item.name==='string'?{name:item.name.slice(0,64)}:{}),prompt:typeof item.prompt==='string'?item.prompt:'',
    negativePrompt:typeof item.negativePrompt==='string'?item.negativePrompt:'',enabled:item.enabled!==false,
    useCoords:item.useCoords===true,x:Number(item.x??0.5),y:Number(item.y??0.5),
  }));
  const enabledChars=characterPrompts.filter(item=>item.enabled&&item.prompt.trim());
  if(enabledChars.length>maxNAICharacterPrompts(params.model))throw Error(`${params.model} 最多支持${maxNAICharacterPrompts(params.model)}条当前角色提示词；未截断。`);
  if(enabledChars.some(item=>![item.x,item.y].every(value=>Number.isFinite(value)&&value>=0&&value<=1)))throw Error('工作台角色坐标无效。');

  const importedAssets:R4WorkbenchAssetBinding[]=[];
  let editSource:R4AttachmentBinding|null=null,mask:R4AttachmentBinding|null=null;
  if(mode==='generate:i2i'||mode==='inpaint'){
    const source=inpaintSource??live.source;
    if(!source||typeof source.filePath!=='string')throw Error(mode==='inpaint'?'局部重绘缺少当前源图。':'图生图缺少当前源图。');
    editSource=await importR4WorkbenchAsset({conversationId:scope.conversationId,creationId:scope.creationId,kind:'source',value:source.filePath});
  }
  if(mode==='inpaint'){
    if(typeof live.mask!=='string'||!live.mask)throw Error('旧版局部重绘缺少蒙版；请先绘制蒙版。');
    if(!Number.isSafeInteger(live.maskRevision)||Number(live.maskRevision)<0)throw Error('旧版局部重绘蒙版版本无效。');
    mask=await importR4WorkbenchAsset({conversationId:scope.conversationId,creationId:scope.creationId,kind:'mask',value:live.mask});
  }
  const state=getAgentSqlStore().readR4State(),workspace=getAgentSqlStore().readWorkspace();
  if(creation.editSource){
    if(!editSource)throw Error('此 R4 创作仍绑定了改图源，但当前 Generate 工作台不是图生图/局部重绘；请加载该源图并切换模式，或先清除改图源。');
    const selected=resolveR4Attachment(workspace,state,scope.conversationId,scope.creationId,creation.editSource.attachmentId);
    if(selected.hash!==editSource.hash)throw Error('R4 创作绑定的改图源与当前 Generate 工作台源图不同；请明确加载该源图或清除旧绑定。');
    editSource=selected;
  }
  if(creation.mask){
    if(!mask)throw Error('此 R4 创作仍绑定了局部重绘蒙版，但当前 Generate 工作台不是局部重绘；请切回局部重绘或清除旧蒙版。');
    const selected=resolveR4Attachment(workspace,state,scope.conversationId,scope.creationId,creation.mask.attachmentId);
    if(selected.hash!==mask.hash)throw Error('R4 创作绑定的蒙版与当前 Generate 工作台蒙版不同；请明确选择该蒙版或清除旧绑定。');
    mask=selected;
  }
  const vibeRefs=Array.isArray(live.vibeImages)?live.vibeImages:[],preciseRefs=Array.isArray(live.preciseReferences)?live.preciseReferences:[];
  if(vibeRefs.length>16||preciseRefs.length>16)throw Error('Generate 工作台参考图片超过每类16张的上限。');
  const vibeReferences:Array<Record<string,unknown>>=[],preciseReferences:Array<Record<string,unknown>>=[];
  let vibeEncodeCount=0;
  for(const value of vibeRefs){
    if(!workbenchRecord(value))throw Error('Vibe Transfer 工作台记录格式无效。');
    const infoExtracted=numeric(value.infoExtracted,1,0,1,'Vibe Transfer 信息提取度');
    const strength=numeric(value.strength,1,0,1,'Vibe Transfer 强度');
    const base64=typeof value.base64==='string'?value.base64:'';
    const encodings=Array.isArray(value.encodings)?value.encodings.filter((item):item is VibeEncoding=>workbenchRecord(item)
      &&typeof item.model==='string'&&typeof item.infoExtracted==='number'&&typeof item.encoding==='string'):[];
    const matching=matchingVibeEncoding({base64,infoExtracted,strength,encodings},params.model);
    let binding:R4WorkbenchAssetBinding;
    let encodingModel:string|undefined;
    if(matching){
      binding=await importR4WorkbenchVibeEncoding({conversationId:scope.conversationId,creationId:scope.creationId,encoding:matching,
        model:params.model,infoExtracted,name:typeof value.name==='string'?value.name:undefined});
      encodingModel=params.model;
    }else{
      if(!base64)throw Error(`工作台 Vibe「${typeof value.name==='string'?value.name:'参考图'}」没有当前模型 ${params.model} 与信息提取度 ${infoExtracted} 的可用编码，也没有原图；请切换至匹配模型/提取度或重新导入原图。`);
      binding=await importR4WorkbenchAsset({conversationId:scope.conversationId,creationId:scope.creationId,kind:'vibe',value:base64,name:typeof value.name==='string'?value.name:undefined});
      vibeEncodeCount++;
    }
    importedAssets.push(binding as R4WorkbenchAssetBinding);
    vibeReferences.push({attachmentId:binding.attachmentId,attachmentRevision:String(binding.revision),role:'reference',includeInGeneration:true,
      infoExtracted,strength,...(encodingModel?{encodingModel,encodingInfoExtracted:infoExtracted}:{})});
  }
  for(const value of preciseRefs){
    if(!workbenchRecord(value))throw Error('精准参考工作台记录格式无效。');
    const binding=await importR4WorkbenchAsset({conversationId:scope.conversationId,creationId:scope.creationId,kind:'precise',value:value.base64??value.filePath,name:typeof value.name==='string'?value.name:undefined});
    importedAssets.push(binding as R4WorkbenchAssetBinding);
    preciseReferences.push({attachmentId:binding.attachmentId,attachmentRevision:String(binding.revision),role:'reference',includeInGeneration:true,
      type:value.type==='style'||value.type==='character&style'?value.type:'character',strength:numeric(value.strength,1,0,1,'精准参考强度'),fidelity:numeric(value.fidelity,1,0,1,'精准参考保真度')});
  }
  const approvedReferences=creation.references.filter(item=>item.includeInGeneration);
  for(const reference of approvedReferences){
    if(reference.role!=='reference'||reference.authorizationStatus!=='authorized'||!reference.authorizationReceiptId||!reference.purpose)throw Error('R4 参考用途缺少确切的参与生成授权回执。');
    const verified=resolveR4Attachment(workspace,state,scope.conversationId,scope.creationId,reference.attachmentId);
    if(verified.hash!==reference.hash||verified.revision!==reference.revision)throw Error('R4 已授权参考内容或版本已变化；请重新选择并授权。');
    if(supportsNAIPreciseReference(params.model))preciseReferences.push({attachmentId:verified.attachmentId,attachmentRevision:String(verified.revision),role:'reference',includeInGeneration:true,
      type:reference.purpose==='character'?'character':'style',strength:1,fidelity:1,referencePurpose:reference.purpose});
    else if(supportsNAIVibeTransfer(params.model)){
      vibeReferences.push({attachmentId:verified.attachmentId,attachmentRevision:String(verified.revision),role:'reference',includeInGeneration:true,
        infoExtracted:1,strength:1,referencePurpose:reference.purpose});
      vibeEncodeCount++;
    }
    else throw Error(`当前模型不支持 R4 创作中已授权的 ${reference.purpose} 参考，未静默忽略。`);
  }
  if(vibeReferences.length>16||preciseReferences.length>16)throw Error('工作台与 R4 已授权参考合并后超过每类16张上限；请移除多余选择。');
  const settings=getSettings();
  const workbenchModelMode=live.modelMode==='furry'?'furry':'anime';
  const providerRef=r4ImageProviderRef(settings),referencesEnabled=vibeReferences.length+preciseReferences.length>0;
  if(providerRef.providerId==='openai-images'){
    if(mode!=='generate:t2i'||referencesEnabled||enabledChars.length||params.stylePrompt)throw Error('当前兼容图片服务只支持无参考、无多角色、无风格的文生图；工作台设置未丢弃。');
    if(!settings.compatibleImage||!settings.imageApiKey?.trim())throw Error('图片服务尚未配置。');
    if(!NAI_RELAY_MODEL_IDS.includes(settings.compatibleImage.model as typeof NAI_RELAY_MODEL_IDS[number]))throw Error('当前兼容图片服务仅支持 NovelAI 模型，未创建生成预览。');
    const compatibleConfig={...structuredClone(settings.compatibleImage),extensions:{...settings.compatibleImage.extensions,negative_prompt:params.negativePrompt}};
    imageGenerationEndpoint(compatibleConfig.baseUrl);
    buildCompatibleImageRequest(compatibleConfig,{prompt:params.positivePrompt,n:count,size:compatibleConfig.size,extensions:compatibleConfig.extensions});
    const input:R4CreationInputSnapshot={...getR4CreativeHost().snapshot(creation),positivePrompt:params.positivePrompt,negativePrompt:params.negativePrompt,stylePrompt:params.stylePrompt,
      editSource:null,mask:null,references:[],workbenchAssets:[],conversationConfig:config,
      publicParameters:{operation:'generate_image',count,providerRef,compatibleConfig,workbenchMode:mode,workbenchDraftId:snapshot.draftId,workbenchDraftRevision:snapshot.draftRevision,
        historyGroupId:live.historyGroupId||undefined,modelMode:workbenchModelMode,
        batchIntervalSeconds,requestBudget:{image:1,vibe_encode:0,upscale:0},requestedSeedPolicy:'random',requestedSeed:null}};
    validateWorkbenchArguments(args,params,count,mode,'generate_image',0);
    return {input,providerRef,preview:{positivePrompt:params.positivePrompt,negativePrompt:params.negativePrompt,stylePrompt:'',count,mode,imageProvider:'openai-images',estimateSource:'provider-unknown',estimatedAnlas:null,
      warning:'费用以所选服务商为准。',requestedSeedPolicy:'random',requestedSeed:null,resolvedSeed:null,resolvedSeedSource:null}};
  }
  if(!getToken()?.trim())throw Error('当前图片账号尚未配置，未创建生成预览。');
  if(!NAI_MODELS.some(item=>item.value===params.model))throw Error('所选生图模型不在当前支持目录中。');
  if(!NAI_SAMPLERS.some(item=>item.value===params.sampler))throw Error('工作台采样器不在支持目录中。');
  if(vibeReferences.length&&!supportsNAIVibeTransfer(params.model))throw Error(`${params.model} 不支持工作台已选 Vibe Transfer；请移除参考或切换模型。`);
  if(preciseReferences.length&&!supportsNAIPreciseReference(params.model))throw Error(`${params.model} 不支持工作台已选精准参考；请移除参考或切换模型。`);
  const currentSnapshot=await getR4WorkbenchService().readR4WorkbenchSnapshot();
  if(currentSnapshot.draftId!==snapshot.draftId||currentSnapshot.draftRevision!==snapshot.draftRevision)throw Error('Generate 工作台在导入源图期间发生变化；请重新读取后准备，未生成预览。');
  const effective=effectiveNAIEffortParams(workbenchParams);
  const actualModel=NAI_MODELS.find(item=>item.value===effective.model)?.value;
  if(!actualModel)throw Error('当前工作台模型在标准化后不受支持。');
  const actualParams:GenerateParams={...workbenchParams,...effective,model:actualModel};
  if(mode==='inpaint'&&!NAI_INPAINT_MODELS.some(item=>item.value===live.inpaintModel))throw Error('当前局部重绘模型不受支持。');
  let sizePlan:ReturnType<typeof inpaintSizePlan>|undefined;
  if(mode==='inpaint'){
    if(!editSource)throw Error('局部重绘源图绑定缺失。');
    const custom=live.inpaintCustomSize as Partial<InpaintSize>|undefined;
    sizePlan=inpaintSizePlan(live.inpaintSizeMode==='custom'?'custom':'original',
      {width:Number(custom?.width),height:Number(custom?.height)},
      {width:Number(editSource.width),height:Number(editSource.height)},inpaintRegion);
    actualParams.width=sizePlan.outputSize.width;actualParams.height=sizePlan.outputSize.height;
  }
  const paramsForArgs={...actualParams,...(mode==='generate:i2i'&&live.i2iSizeMode==='adaptive'?{}:{})};
  const effectiveStrength=mode==='inpaint'?numeric(live.inpaintStrength,0.7,0,1,'局部重绘强度'):mode==='generate:i2i'?strength:0;
  validateWorkbenchArguments(args,paramsForArgs,count,mode,mode==='inpaint'?'inpaint_image':mode==='generate:i2i'?'redraw_image':'generate_image',effectiveStrength);
  const input:R4CreationInputSnapshot={...getR4CreativeHost().snapshot(creation),positivePrompt:actualParams.positivePrompt,negativePrompt:actualParams.negativePrompt,stylePrompt:actualParams.stylePrompt,
    editSource,mask,references:approvedReferences,workbenchAssets:importedAssets,conversationConfig:config};
  input.publicParameters={operation:mode==='inpaint'?'inpaint_image':mode==='generate:i2i'?'redraw_image':'generate_image',count,params:actualParams,effectiveParams:actualParams,providerRef,
    workbenchMode:mode,workbenchDraftId:snapshot.draftId,workbenchDraftRevision:snapshot.draftRevision,batchIntervalSeconds,
    vibeReferences,preciseReferences,characterPrompts,
    modelMode:workbenchModelMode,historyGroupId:live.historyGroupId||undefined,
    ...(mode==='generate:i2i'?{strength,noise:0,extraNoiseSeed:Number(i2i?.extraNoiseSeed??0)}:{}),
    ...(mode==='inpaint'?{strength:effectiveStrength,noise:0,inpaintModel:live.inpaintModel,inpaintRegion:inpaintRegion??null,
      inpaintRequestSize:sizePlan?.requestSize,maskRevision:live.maskRevision}:{}),
    requestBudget:{image:count,vibe_encode:vibeEncodeCount*count,upscale:0}};
  const advanced=referencesEnabled||enabledChars.length>0||mode==='inpaint';
  const quote=advanced||currentNaiAccount()?.method==='relay'?null:calculateImageGenerationAnlas({params:actualParams,account:getAccountSummary(),batchCount:count});
  const requestedSeedPolicy=actualParams.seedMode==='fixed'?'fixed':'random';
  Object.assign(input.publicParameters,{requestedSeedPolicy,requestedSeed:requestedSeedPolicy==='fixed'?actualParams.seed:null});
  const sourceAttachmentIds=[...(editSource?[editSource.attachmentId]:[]),...(mask?[mask.attachmentId]:[]),...approvedReferences.map(item=>item.attachmentId),...importedAssets.map(item=>item.attachmentId)];
  const sourceAttachments:Array<Record<string,unknown>>=[];
  const addSourceAttachment=(binding:R4AttachmentBinding,role:'edit_source'|'mask'|'reference'|'vibe'|'precise',includeInGeneration?:boolean,referencePurpose?:string)=>{
    if(!binding.hash||!/^[a-f0-9]{64}$/i.test(binding.hash)||!Number.isSafeInteger(binding.revision)||binding.revision<1)throw Error('准备预览包含无效的工作台图片绑定。');
    const artwork=Object.values(state.artworks).find(item=>item.attachmentId===binding.attachmentId&&item.conversationId===scope.conversationId&&item.creationId===scope.creationId);
    sourceAttachments.push({artifactId:artwork?.id??binding.attachmentId,attachmentId:binding.attachmentId,attachmentRevision:String(binding.revision),hash:binding.hash,
      outputIndex:artwork?.outputIndex??null,conversationId:scope.conversationId,creationId:scope.creationId,parentAttachmentId:artwork?.parentAttachmentId??null,role,
      ...(includeInGeneration===undefined?{}:{includeInGeneration}),...(referencePurpose?{referencePurpose}:{})});
  };
  if(editSource)addSourceAttachment(editSource,'edit_source');
  if(mask)addSourceAttachment(mask,'mask');
  for(const reference of approvedReferences)addSourceAttachment(reference,'reference',true,reference.purpose);
  for(const reference of importedAssets)addSourceAttachment(reference,reference.role, true);
  return {input,providerRef,preview:{positivePrompt:actualParams.positivePrompt,negativePrompt:actualParams.negativePrompt,stylePrompt:actualParams.stylePrompt,
    model:actualParams.model,width:actualParams.width,height:actualParams.height,count,mode,imageProvider:'novelai',estimateSource:quote?'local-estimate':'provider-unknown',estimatedAnlas:quote?.amount??null,
    warning:quote?'本地估算，实际扣费以服务回执为准。':'此渠道、局部重绘或参考参数无法可靠估价，可能收费。',requestedSeedPolicy,requestedSeed:requestedSeedPolicy==='fixed'?actualParams.seed:null,
    resolvedSeed:null,resolvedSeedSource:null,sourceAttachmentIds,sourceAttachments,...(typeof live.sourceMode==='string'?{sourceMode:live.sourceMode}:{}),...(mode==='inpaint'?{maskRevision:live.maskRevision}:{}),
    batchIntervalSeconds,...(sizePlan?{inpaintOutputSize:sizePlan.outputSize,inpaintRequestSize:sizePlan.requestSize}:{})}};
}

async function prepareR4LegacyGeneration(creation:R4Creation,args:Record<string,unknown>,config:R4ConversationConfigSnapshot,scope:R4HostScope):Promise<R4PreparedImage> {
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
    const prepared=await prepareR4LegacyGeneration(bound,clean,config,scope);
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
    onChanged:conversationId=>{
      eventSink({kind:'creative-state',state:host!.read(conversationId)});for(const listener of stateListeners)listener(conversationId);
      try{void getR4WorkbenchService().publishCompletedResults(conversationId).catch(error=>{
        eventSink({kind:'error',conversationId,message:error instanceof Error?error.message:'图片已生成并保存，但未能更新 Generate 工作台；请从图库打开结果，收费任务不会自动重试。'});
      });}catch{/* Workbench IPC is installed after renderer startup. */}
    },
    command:async(request,current)=>{
      if(['set_preset_binding','set_new_chat_defaults','create_preset','update_preset','set_model_binding'].includes(request.type)){
        const result=current.store.transaction(tx=>{
          const state=tx.getR4State(),workspace=tx.getWorkspace(),conversation=state.conversations[request.conversationId],args=request.args??{};
          if(!conversation)throw Error('聊天状态不存在。');
          if(request.type==='set_model_binding'){
            const providers=getAgentProviderRegistry(getSettings());const provider=providers.providers.find(item=>item.id===args.providerId);
            if(!provider||!provider.models.some(item=>item.id===args.modelId)&&provider.modelId!==args.modelId)throw Error('对话模型不存在于所选供应商。');
            conversation.config={...conversation.config!,providerRef:{providerId:provider.id},modelId:String(args.modelId)};
          }else if(request.type==='create_preset'){
            if(typeof args.presetId!=='string'||!args.presetId.trim()||args.presetId.length>200)throw Error('预设标识格式无效。');
            const presetId=args.presetId.trim(),name=validatedAssistantPresetName(args.name),body=validatedAssistantPresetBody(args.body);
            const existing=state.assistantPresets[presetId];
            if(existing){
              // The renderer keeps one preset ID for a gesture, so a transport
              // retry can safely return the original creation result.
              if(existing.source==='user'&&existing.name===name&&existing.body===body)return {ok:true,data:{presetId}};
              throw Error('预设标识已存在，未覆盖已有预设。');
            }
            const timestamp=new Date().toISOString();
            state.assistantPresets[presetId]={id:presetId,name,body,revision:1,hash:createHash('sha256').update(body).digest('hex'),source:'user',createdAt:timestamp,updatedAt:timestamp};
            tx.setR4State(state);return {ok:true,data:{presetId}};
          }else{
            const preset=state.assistantPresets[String(args.presetId)];if(!preset)throw Error('助手预设不存在。');
            if(request.type==='set_new_chat_defaults')state.assistantPresetDefaultBinding={presetId:preset.id,enabled:args.enabled===true};
            else if(request.type==='set_preset_binding')conversation.assistantPresetBinding={presetId:preset.id,enabled:args.enabled===true};
            else{
              if(!Number.isSafeInteger(args.expectedRevision)||args.expectedRevision!==preset.revision)throw Error('共享预设已更新，未覆盖。');
              const body=validatedAssistantPresetBody(args.body);
              const name=args.name===undefined?undefined:validatedAssistantPresetName(args.name);
              const history=state.compatibility.presetRevisionHistory as Record<string,unknown>??{};
              history[`${preset.id}@${preset.revision}`]=structuredClone(preset);state.compatibility.presetRevisionHistory=history;
              preset.body=body;preset.hash=createHash('sha256').update(body).digest('hex');preset.revision++;preset.updatedAt=new Date().toISOString();
              if(name!==undefined)preset.name=name;
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
      if(request.type==='approve_generation'){
        const preparationId=String(request.args?.preparationId??'');
        try{await assertR4WorkbenchPreparationCurrent(preparationId,request.conversationId,request.creationId??getR4CreativeHost().read(request.conversationId).currentCreationId!);}
        catch(error){return {ok:false,message:error instanceof Error?error.message:'Generate 工作台已变化，旧预览未入队。',state:current.read(request.conversationId)};}
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

import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import sharp from 'sharp';
import type {AgentAttachment} from '../../src/agent/types';
import type {R4Artwork,R4Execution} from '../../src/agent/r4-types';
import type {GenerateExtras,GenerateParams,GenerateResult,HistoryItem,NAIInpaintModel,DirectorTool,AugmentOptions,CompatibleImageSettings} from '../../src/types';
import {DEFAULT_AUGMENT_OPTIONS} from '../../src/types';
import {getAgentSqlStore} from './agent-store';
import {getHistory} from './store';
import {generateImage,redrawImage,inpaintImage,upscaleImg,augmentImg,extractEmbeddedGenerationMetadata} from './nai';
import {generateConfiguredImages} from './compatible-generation';
import {withNaiAccountOperation} from './nai-accounts-runtime';
import {toLocalMediaUrl} from './local-media-protocol';
import {withR4NativeExecution} from './r4-native-context';
import {r4ImageProviderRef} from './r4-agent-service';
import {r4Hash} from './r4-creative-host';
import type {R4ExecutionProvider,R4ProviderSubmitResult,R4ProviderOutputResult} from './r4-execution-worker';

function fileFor(execution:Readonly<R4Execution>,attachmentId:string) {
  const store=getAgentSqlStore(),workspace=store.readWorkspace(),state=store.readR4State();
  const chat=workspace.conversations.find(item=>item.id===execution.conversationId);
  const attachments:AgentAttachment[]=[...(chat?.draftAttachments??[]),...(chat?.messages.flatMap(message=>[...message.attachments,...message.tools.flatMap(tool=>tool.generatedImages??[])])??[])];
  const artwork=Object.values(state.artworks).find(item=>item.attachmentId===attachmentId&&item.conversationId===execution.conversationId&&item.creationId===execution.creationId);
  const file=attachments.find(item=>item.id===attachmentId&&!item.unavailable)?.filePath??artwork?.readableHandle;
  const binding=[execution.approvedInput.editSource,execution.approvedInput.mask,...execution.approvedInput.references].find(item=>item?.attachmentId===attachmentId);
  if(!binding?.hash||!file||!path.isAbsolute(file))throw Error('批准快照中的图片附件不可读。');
  const bytes=fs.readFileSync(file);
  if(bytes.length>48*1024*1024||createHash('sha256').update(bytes).digest('hex')!==binding.hash)throw Error('批准图片的内容已变化，未提交请求。');
  return {file,bytes};
}

function extrasFor(execution:Readonly<R4Execution>):GenerateExtras {
  const p=execution.approvedInput.publicParameters;
  const list=(key:string)=>Array.isArray(p[key])?p[key] as Array<Record<string,unknown>>:[];
  return {vibeImages:list('vibeReferences').map(reference=>({base64:fileFor(execution,String(reference.attachmentId)).bytes.toString('base64'),
      infoExtracted:typeof reference.infoExtracted==='number'?reference.infoExtracted:1,strength:typeof reference.strength==='number'?reference.strength:1})),
    preciseReferences:list('preciseReferences').map(reference=>({base64:fileFor(execution,String(reference.attachmentId)).bytes.toString('base64'),
      type:(reference.type??'style') as 'style'|'character'|'character&style',strength:typeof reference.strength==='number'?reference.strength:1,fidelity:typeof reference.fidelity==='number'?reference.fidelity:1})),
    charCaptions:list('characterPrompts').map(character=>({prompt:String(character.prompt??''),negativePrompt:String(character.negativePrompt??''),
      useCoords:character.useCoords===true,x:Number(character.x??0.5),y:Number(character.y??0.5)})),
    historyGroupId:typeof p.historyGroupId==='string'?p.historyGroupId:undefined,
    modelMode:p.modelMode as GenerateExtras['modelMode']};
}

async function artworkFor(execution:Readonly<R4Execution>,item:HistoryItem,outputIndex:number):Promise<R4Artwork> {
  const bytes=fs.readFileSync(item.filePath),metadata=await sharp(bytes).metadata();
  if(!metadata.width||!metadata.height)throw Error('服务返回图片没有有效尺寸。');
  // HistoryItem.actualSeed is the requested seed in the legacy backend. Only
  // original embedded service metadata supplies the resolved seed here.
  const embedded=extractEmbeddedGenerationMetadata(bytes),candidate=embedded?.imported?.seed;
  const hasSeed=Number.isSafeInteger(candidate)&&Number(candidate)>=0&&Number(candidate)<=4294967295;
  return {id:item.id||randomUUID(),attachmentId:item.id,revision:1,conversationId:execution.conversationId,creationId:execution.creationId,
    executionId:execution.id,batchId:execution.id,outputIndex,name:path.basename(item.filePath),mime:metadata.format==='jpeg'?'image/jpeg':metadata.format==='webp'?'image/webp':'image/png',
    url:toLocalMediaUrl(item.filePath,item.id),readableHandle:item.filePath,hash:createHash('sha256').update(bytes).digest('hex'),width:metadata.width,height:metadata.height,
    parentAttachmentId:execution.approvedInput.editSource?.attachmentId,resolvedSeed:hasSeed?Number(candidate):null,resolvedSeedSource:hasSeed?'verified_embedded_metadata':null,createdAt:item.createdAt};
}

/** Adapts the existing, working backends to one durable R4 execution. */
export class R4ImageProvider implements R4ExecutionProvider {
  async submit(execution:Readonly<R4Execution>,outputIndex:number|null,context:Parameters<R4ExecutionProvider['submit']>[2]):Promise<R4ProviderSubmitResult>{
    const p=execution.approvedInput.publicParameters;
    const expected=p.providerRef;
    const assertProvider=()=>{if(!expected||r4Hash(expected)!==r4Hash(r4ImageProviderRef()))throw Error('原任务的图片服务或账号已变化，未改用当前配置。');};
    let crossed=false,unknown=false,confirmed=false;
    const gate=async(kind:'image'|'vibe_encode'|'upscale')=>{assertProvider();await context.beforeSubmit(kind);crossed=true;};
    let result:GenerateResult;
    try{
      assertProvider();
      if(execution.providerRef.providerId==='openai-images'){
        if(outputIndex!==null)throw Error('兼容服务的批次粒度与批准快照不符。');
        result=await generateConfiguredImages({prompt:execution.approvedInput.positivePrompt,n:execution.expectedOutputCount},
          {signal:context.signal,configSnapshot:p.compatibleConfig as CompatibleImageSettings,beforeSubmit:()=>gate('image'),afterReceipt:async receipt=>{
            if(receipt.status==='unknown')unknown=true;else confirmed=true;
            await context.afterReceipt('image',receipt);
          }});
      }else{
        if(outputIndex===null)throw Error('原生图片服务逐张提交，不能伪装远端批次。');
        const params=p.params as GenerateParams;
        if(!params||!params.model)throw Error('任务缺少已冻结的有效图片参数。');
        const source=execution.approvedInput.editSource?fileFor(execution,execution.approvedInput.editSource.attachmentId):undefined;
        result=await withNaiAccountOperation(()=>withR4NativeExecution({sourcePath:source?.file,signal:context.signal,beforeSubmit:gate,
          afterReceipt:async(kind,receipt)=>{
            const failed=receipt.rawStatus?.startsWith('http_')&&Number(receipt.rawStatus.slice(5))>=400&&Number(receipt.rawStatus.slice(5))<500;
            if(receipt.status==='unknown')unknown=true;else confirmed=true;
            await context.afterReceipt(kind,{...receipt,status:receipt.status==='confirmed'?(failed?'failed':'confirmed'):'unknown'});
          }},async()=>{
          switch(String(p.operation??'generate_image')){
            case 'generate_image': return generateImage(params,extrasFor(execution),{signal:context.signal});
            case 'redraw_image':
              if(!source)throw Error('改图源不可读。');
              return redrawImage({imageBase64:source.bytes.toString('base64'),params,strength:Number(p.strength??0.7),noise:Number(p.noise??0),extras:extrasFor(execution),
                groupName:String(p.historyGroupName??'Agent 创作'),fileNamePrefix:params.fileNamePrefix||'agent-redraw'});
            case 'inpaint_image':
              if(!source||!execution.approvedInput.mask)throw Error('局部重绘缺少明确源图或蒙版。');
              return inpaintImage(params,String(p.inpaintModel) as NAIInpaintModel,fileFor(execution,execution.approvedInput.mask.attachmentId).bytes.toString('base64'),Number(p.strength??0.7),Number(p.noise??0));
            case 'upscale_image': {
              const scaled=await upscaleImg(Number(p.scale)===2?2:4,params.model);
              return {ok:scaled.ok,message:scaled.message,items:scaled.item?[scaled.item]:[]};
            }
            case 'process_image': return augmentImg(String(p.processOperation) as DirectorTool,{...DEFAULT_AUGMENT_OPTIONS,...p.processOptions as Partial<AugmentOptions>});
            default:throw Error('任务操作类型不受支持。');
          }
        }));
      }
    }catch(error){
      if(!crossed)throw error;
      const uncertain=unknown||!confirmed;
      const indexes=outputIndex===null?Array.from({length:execution.expectedOutputCount},(_,i)=>i):[outputIndex];
      return {requestDisposition:uncertain?'unknown':'sent',providerReceiptStatus:uncertain?'unknown':'confirmed',
        outputs:indexes.map(index=>({outputIndex:index,status:uncertain?'unknown':'failed',errorCode:uncertain?'provider_unknown':'attachment_unavailable',errorMessage:error instanceof Error?error.message:'图片操作未完成。',providerReceipt:{status:uncertain?'unknown':'confirmed'}}))};
    }
    const outputs:R4ProviderOutputResult[]=[];
    const indexes=outputIndex===null?Array.from({length:execution.expectedOutputCount},(_,i)=>i):[outputIndex];
    for(let index=0;index<result.items.length&&index<indexes.length;index++){
      try{
        const artwork=await artworkFor(execution,result.items[index],indexes[index]);
        outputs.push({outputIndex:indexes[index],status:'completed',artwork,resolvedSeed:artwork.resolvedSeed,resolvedSeedSource:artwork.resolvedSeedSource,providerReceipt:{status:'confirmed'}});
      }catch(error){outputs.push({outputIndex:indexes[index],status:'failed',errorCode:'attachment_unavailable',errorMessage:error instanceof Error?error.message:String(error),providerReceipt:{status:'confirmed'}});}
    }
    for(const index of indexes.filter(index=>!outputs.some(output=>output.outputIndex===index))){
      if(!crossed)continue;
      const uncertain=unknown||!confirmed;
      outputs.push({outputIndex:index,status:uncertain?'unknown':'failed',errorCode:uncertain?'provider_unknown':result.failureKind==='storage'?'attachment_unavailable':'provider_error',errorMessage:result.message,
        providerReceipt:{status:uncertain?'unknown':'confirmed'}});
    }
    return {requestDisposition:unknown?'unknown':crossed?'sent':'not_sent',providerReceiptStatus:unknown?'unknown':crossed&&confirmed?'confirmed':'not_applicable',outputs};
  }

  async verify(execution:Readonly<R4Execution>){
    // The current image endpoints expose no reliable request-status API. Query
    // only already registered, readable outputs; never resubmit to "verify".
    const outputs:R4ProviderOutputResult[]=[];
    for(const output of execution.outputs)if(output.artwork){
      const history=getHistory().find(item=>item.id===output.artwork!.attachmentId);
      if(history){try{const artwork=await artworkFor(execution,history,output.outputIndex);outputs.push({outputIndex:output.outputIndex,status:'completed',artwork,providerReceipt:{status:'confirmed'}});}catch{/* retain unknown */}}
    }
    return {requestDisposition:'unknown' as const,providerReceiptStatus:'unknown' as const,...(outputs.length?{outputs}:{})};
  }

  async cancel(){return {disposition:'unsupported' as const,message:'当前图片端点不提供可核实的远端取消；已提交请求继续等待真实结果。'};}
}

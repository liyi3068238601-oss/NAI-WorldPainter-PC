import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import sharp from 'sharp';
import type {R4AttachmentBinding,R4Artwork,R4WorkbenchAssetBinding} from '../../src/agent/r4-types';
import {agentAttachmentsDirectory,getAgentSqlStore} from './agent-store';
import {toLocalMediaUrl} from './local-media-protocol';

const MAX_BYTES=48*1024*1024;
export type WorkbenchAssetKind='source'|'mask'|'vibe'|'precise';

function imageBytes(value:unknown,label:string):Buffer {
  if(typeof value!=='string')throw new Error(`${label}图片数据不可用。`);
  const raw=/^data:image\/[a-z0-9.+-]+;base64,([\s\S]+)$/i.exec(value)?.[1]??value;
  if(!raw||raw.length>Math.ceil(MAX_BYTES*4/3)+16||!/^[A-Za-z0-9+/]*={0,2}$/.test(raw))throw new Error(`${label}图片数据无效或超过48MB。`);
  const bytes=Buffer.from(raw,'base64');
  if(!bytes.length||bytes.length>MAX_BYTES)throw new Error(`${label}图片为空或超过48MB。`);
  return bytes;
}

function pathBytes(value:unknown):Buffer {
  if(typeof value!=='string'||!path.isAbsolute(value))throw new Error('工作台源图没有绝对本地路径。');
  const file=path.resolve(value),stat=fs.statSync(file);
  if(!stat.isFile()||stat.size<=0||stat.size>MAX_BYTES)throw new Error('工作台源图不存在、为空或超过48MB。');
  return fs.readFileSync(file);
}

function extension(format:string|undefined) {
  if(format==='jpeg')return 'jpg';
  if(['png','webp','gif','avif','tiff','heif'].includes(format??''))return format!;
  throw new Error('工作台输入不是可支持的图片格式。');
}

/** Copy user-selected live renderer bytes into stable host storage and bind the verified hash into R4 state. */
export function importR4WorkbenchAsset(input:{conversationId:string;creationId:string;kind:'source'|'mask';value:unknown;name?:string}):Promise<R4AttachmentBinding>;
export function importR4WorkbenchAsset(input:{conversationId:string;creationId:string;kind:'vibe'|'precise';value:unknown;name?:string}):Promise<R4WorkbenchAssetBinding>;
export async function importR4WorkbenchAsset(input:{conversationId:string;creationId:string;kind:WorkbenchAssetKind;value:unknown;name?:string}):Promise<R4AttachmentBinding|R4WorkbenchAssetBinding> {
  const bytes=input.kind==='source'?pathBytes(input.value):imageBytes(input.value,`工作台 ${input.kind}`);
  const digest=createHash('sha256').update(bytes).digest('hex');
  const metadata=await sharp(bytes,{limitInputPixels:100_000_000}).metadata();
  if(!metadata.width||!metadata.height)throw new Error('工作台图片没有有效尺寸。');
  const ext=extension(metadata.format),directory=path.join(agentAttachmentsDirectory(),'workbench-assets');
  fs.mkdirSync(directory,{recursive:true});
  const file=path.join(directory,`${digest}.${ext}`);
  if(fs.existsSync(file)){
    const current=createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if(current!==digest)throw new Error('工作台托管图片哈希不符，拒绝覆盖。');
  }else{
    const temporary=`${file}.tmp-${randomUUID()}`;
    try{fs.writeFileSync(temporary,bytes,{flag:'wx'});try{fs.renameSync(temporary,file);}catch(error){if(!fs.existsSync(file))throw error;fs.rmSync(temporary,{force:true});}}
    finally{try{if(fs.existsSync(temporary))fs.rmSync(temporary,{force:true});}catch{/* keep original storage error */}}
  }
  const attachmentId=`workbench:${createHash('sha256').update(`${input.conversationId}\0${input.creationId}\0${input.kind}\0${digest}`).digest('hex')}`;
  const id=attachmentId;
  const mime=metadata.format==='jpeg'?'image/jpeg':`image/${metadata.format}`;
  const store=getAgentSqlStore();
  store.transaction(tx=>{
    const state=tx.getR4State(),previous=state.artworks[id];
    if(previous&&(previous.hash!==digest||previous.attachmentId!==attachmentId||previous.sourceKind!=='workbench'))throw new Error('工作台附件身份冲突，未覆盖已有记录。');
    const artwork:R4Artwork={...(previous??{}),id,attachmentId,revision:previous?.revision??1,conversationId:input.conversationId,creationId:input.creationId,
      name:input.name?.slice(0,200)||`工作台 ${input.kind}.${ext}`,mime,readableHandle:file,url:toLocalMediaUrl(file,attachmentId),hash:digest,width:metadata.width,height:metadata.height,
      createdAt:previous?.createdAt??new Date().toISOString(),sourceKind:'workbench'};
    state.artworks[id]=artwork;tx.setR4State(state);
  });
  const binding={attachmentId,revision:1,hash:digest,name:input.name?.slice(0,200)||`工作台 ${input.kind}.${ext}`,mime,width:metadata.width,height:metadata.height};
  return input.kind==='vibe'||input.kind==='precise'?{...binding,role:input.kind} satisfies R4WorkbenchAssetBinding:binding;
}

/** Store an already-computed NovelAI Vibe encoding as a durable, hash-bound
 * workbench attachment. The file contains the exact base64 text expected by
 * prepareExtras; it is intentionally not treated as an image or decoded via
 * sharp. */
export async function importR4WorkbenchVibeEncoding(input:{conversationId:string;creationId:string;encoding:unknown;model:string;infoExtracted:number;name?:string}):Promise<R4WorkbenchAssetBinding> {
  const encoding=input.encoding;
  if(typeof encoding!=='string'||encoding.length===0||encoding.length>MAX_BYTES||encoding.length%4!==0||!/^[A-Za-z0-9+/]+={0,2}$/.test(encoding))
    throw new Error('工作台 Vibe 编码无效或超过48MB。');
  if(typeof input.model!=='string'||!input.model.trim()||input.model.length>128)throw new Error('工作台 Vibe 编码模型无效。');
  if(!Number.isFinite(input.infoExtracted)||input.infoExtracted<0||input.infoExtracted>1)throw new Error('工作台 Vibe 编码提取值无效。');
  const bytes=Buffer.from(encoding,'ascii');
  const digest=createHash('sha256').update(bytes).digest('hex');
  const attachmentId=`workbench:vibe-encoding:${createHash('sha256').update(`${input.conversationId}\0${input.creationId}\0${input.model}\0${input.infoExtracted}\0${digest}`).digest('hex')}`;
  const directory=path.join(agentAttachmentsDirectory(),'workbench-assets');
  fs.mkdirSync(directory,{recursive:true});
  const file=path.join(directory,`${digest}.vibe`);
  if(fs.existsSync(file)){
    if(createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==digest)throw new Error('工作台 Vibe 编码哈希不符，拒绝覆盖。');
  }else{
    const temporary=`${file}.tmp-${randomUUID()}`;
    try{fs.writeFileSync(temporary,bytes,{flag:'wx'});try{fs.renameSync(temporary,file);}catch(error){if(!fs.existsSync(file))throw error;fs.rmSync(temporary,{force:true});}}
    finally{try{if(fs.existsSync(temporary))fs.rmSync(temporary,{force:true});}catch{/* keep original storage error */}}
  }
  const name=input.name?.slice(0,200)||'工作台 Vibe 编码';
  const mime='application/vnd.novelai.vibe-transfer-encoding';
  const store=getAgentSqlStore();
  store.transaction(tx=>{
    const state=tx.getR4State(),previous=state.artworks[attachmentId];
    if(previous&&(previous.hash!==digest||previous.attachmentId!==attachmentId||previous.sourceKind!=='workbench'))throw new Error('工作台 Vibe 编码身份冲突，未覆盖已有记录。');
    const artwork:R4Artwork={...(previous??{}),id:attachmentId,attachmentId,revision:previous?.revision??1,conversationId:input.conversationId,creationId:input.creationId,
      name,mime,readableHandle:file,hash:digest,createdAt:previous?.createdAt??new Date().toISOString(),sourceKind:'workbench'};
    state.artworks[attachmentId]=artwork;tx.setR4State(state);
  });
  return {attachmentId,revision:1,hash:digest,name,mime,role:'vibe'};
}

/** Read only the exact managed Vibe encoding bound into a prepared R4 snapshot. */
export function readR4WorkbenchVibeEncoding(binding:R4WorkbenchAssetBinding,owner?:{conversationId:string;creationId:string}):string {
  if(binding.role!=='vibe'||!binding.attachmentId.startsWith('workbench:vibe-encoding:')||!binding.hash||!/^[a-f0-9]{64}$/i.test(binding.hash)
    ||!Number.isSafeInteger(binding.revision)||binding.revision<1)throw new Error('批准快照中的 Vibe 编码绑定无效。');
  const artwork=Object.values(getAgentSqlStore().readR4State().artworks).find(item=>item.attachmentId===binding.attachmentId);
  if(!artwork||artwork.sourceKind!=='workbench'||artwork.mime!=='application/vnd.novelai.vibe-transfer-encoding'||artwork.hash!==binding.hash
    ||artwork.revision!==binding.revision||owner&&(artwork.conversationId!==owner.conversationId||artwork.creationId!==owner.creationId)
    ||typeof artwork.readableHandle!=='string'||!path.isAbsolute(artwork.readableHandle))throw new Error('批准快照中的 Vibe 编码托管附件不存在或不匹配。');
  const root=path.resolve(agentAttachmentsDirectory(),'workbench-assets'),file=path.resolve(artwork.readableHandle),relativePath=path.relative(root,file);
  if(relativePath.startsWith('..')||path.isAbsolute(relativePath)||path.basename(file)!==`${binding.hash}.vibe`)throw new Error('批准快照中的 Vibe 编码路径不属于托管附件。');
  const bytes=fs.readFileSync(file);
  if(bytes.length===0||bytes.length>MAX_BYTES||createHash('sha256').update(bytes).digest('hex')!==binding.hash||bytes.some(value=>value>0x7f))
    throw new Error('批准快照中的 Vibe 编码内容已变化或无效。');
  const encoding=bytes.toString('ascii');
  if(encoding.length%4!==0||!/^[A-Za-z0-9+/]+={0,2}$/.test(encoding))throw new Error('批准快照中的 Vibe 编码格式无效。');
  return encoding;
}

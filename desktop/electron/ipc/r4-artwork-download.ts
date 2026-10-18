import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import type {R4Artwork} from '../../src/agent/r4-types';

/** Save verified original bytes; a cancelled chooser creates no output. */
export async function downloadR4Artwork(artwork:R4Artwork,choose:(name:string,extension:string)=>Promise<string|undefined>){
  if(!artwork.readableHandle||!path.isAbsolute(artwork.readableHandle)||!artwork.hash)throw Error('作品原文件不可读。');
  const bytes=await fs.promises.readFile(artwork.readableHandle);
  if(createHash('sha256').update(bytes).digest('hex')!==artwork.hash)throw Error('作品文件内容已变化，未保存其他图片。');
  const extension=path.extname(artwork.readableHandle).slice(1)||'png';
  const name=path.basename(artwork.name).replace(/[<>:"/\\|?*\x00-\x1f]/g,'_');
  const destination=await choose(name,extension);if(!destination)return {saved:false,cancelled:true};
  if(!path.isAbsolute(destination))throw Error('保存路径必须是绝对路径。');
  if(path.resolve(destination).toLocaleLowerCase()===path.resolve(artwork.readableHandle).toLocaleLowerCase())return {saved:true,unchanged:true};
  await fs.promises.writeFile(destination,bytes);
  return {saved:true,byteLength:bytes.length};
}

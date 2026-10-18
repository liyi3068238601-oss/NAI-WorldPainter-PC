import { createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Local keyed revisions reveal no credential value and survive application restart. */
export function r4BindingRevision(directory:string,value:unknown):string {
  fs.mkdirSync(directory,{recursive:true});
  const file=path.join(directory,'agent-binding.key');
  let key:Buffer;
  try{key=fs.readFileSync(file);}catch(error){
    if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
    const candidate=randomBytes(32);
    try{fs.writeFileSync(file,candidate,{flag:'wx',mode:0o600});}catch(writeError){
      if((writeError as NodeJS.ErrnoException).code!=='EEXIST')throw writeError;
    }
    key=fs.readFileSync(file);
  }
  if(key.length!==32)throw Error('Agent 配置绑定密钥格式异常，已保留文件，未自动替换。');
  return createHmac('sha256',key).update(JSON.stringify(value)).digest('hex');
}

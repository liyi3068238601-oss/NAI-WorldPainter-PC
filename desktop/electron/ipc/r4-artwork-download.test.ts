import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {resolve,join,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {afterEach,it,expect} from 'vitest';
import type {R4Artwork} from '../../src/agent/r4-types';
import {downloadR4Artwork} from './r4-artwork-download';
const dirs:string[]=[];
afterEach(()=>{const root=resolve('.tmp/r4-download-tests');for(const dir of dirs.splice(0)){if(relative(root,dir).startsWith('..'))throw Error('Unsafe cleanup');rmSync(dir,{recursive:true,force:true});}});
it('writes original bytes, preserves source and cancelled download writes nothing',async()=>{
  const root=resolve('.tmp/r4-download-tests');mkdirSync(root,{recursive:true});const dir=mkdtempSync(join(root,'case-'));dirs.push(dir);
  const source=join(dir,'original.png'),destination=join(dir,'download.png');const bytes=Buffer.from('original image bytes with embedded metadata');writeFileSync(source,bytes);
  const artwork={readableHandle:source,hash:createHash('sha256').update(bytes).digest('hex'),name:'original.png'} as R4Artwork;
  expect(await downloadR4Artwork(artwork,async()=>undefined)).toEqual({saved:false,cancelled:true});expect(existsSync(destination)).toBe(false);
  expect((await downloadR4Artwork(artwork,async()=>destination)).saved).toBe(true);expect(readFileSync(destination)).toEqual(bytes);expect(readFileSync(source)).toEqual(bytes);
  writeFileSync(source,'changed');await expect(downloadR4Artwork(artwork,async()=>destination)).rejects.toThrow('已变化');expect(readFileSync(destination)).toEqual(bytes);
});

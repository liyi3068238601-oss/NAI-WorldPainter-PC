// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
vi.mock('./store',()=>({getSettings:()=>({proxyMode:'direct'})}));
vi.mock('./proxy',()=>({proxyConfigForUrl:async()=>({proxy:false})}));
import { validateNaiAccountReadOnly } from './nai-accounts-validation';

describe('custom NovelAI relay HTTP probe',()=>{
 const servers:Server[]=[];
 afterEach(async()=>Promise.all(servers.splice(0).map(server=>new Promise<void>(resolve=>{
  server.closeAllConnections();server.close(()=>resolve());
 }))));

 it('sends the read-only probe over the selected HTTP origin without contacting an external host',async()=>{
  const seen:Array<{url?:string;authorization?:string}>=[];
  const server=createServer((request,response)=>{
   seen.push({url:request.url,authorization:request.headers.authorization});
   response.writeHead(200,{'content-type':'application/json'});
   response.end(JSON.stringify({subscription:{tier:0,active:false}}));
  });
  servers.push(server);
  const port=await new Promise<number>(resolve=>server.listen(0,'127.0.0.1',()=>resolve((server.address() as any).port)));
  const baseUrl=`http://127.0.0.1:${port}/relay-prefix`;
  const result=await validateNaiAccountReadOnly({label:'local HTTP relay',method:'relay',token:'local-only-fixture',apiBaseUrl:baseUrl,imageBaseUrl:baseUrl});
  expect(result).toMatchObject({ok:true,code:'passed',status:200});
  expect(seen).toEqual([{url:'/relay-prefix/user/data',authorization:'Bearer local-only-fixture'}]);
 });
});

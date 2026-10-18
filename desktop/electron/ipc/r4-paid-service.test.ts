import fs from 'node:fs';
import path from 'node:path';
import {afterEach,expect,it,vi} from 'vitest';
import {createServer,type Server} from 'node:http';
import type {AgentWorkspaceData} from '../../src/agent/types';
import {AgentSqlStore} from './r4-store';
import {recoverR4PaidServices,runR4PaidService} from './r4-paid-service';
import {postR4PaidText} from './r4-paid-text-context';
import {adaptR4LegacyResult} from '../../src/agent/r4-legacy-adapter';
const cleanup:Array<()=>void>=[],servers:Server[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())close();await Promise.all(servers.splice(0).map(server=>new Promise<void>(resolve=>server.close(()=>resolve()))));});
const scope={conversationId:'chat',creationId:'creation',userIntentRef:'intent',turnLineageRef:'origin',operationKey:'operation'};
function fixture(){
  const root=path.resolve('.tmp/r4-paid-service-tests');fs.mkdirSync(root,{recursive:true});const dir=fs.mkdtempSync(path.join(root,'case-'));
  cleanup.push(()=>{if(path.relative(root,dir).startsWith('..'))throw Error('Unsafe test cleanup');fs.rmSync(dir,{recursive:true,force:true});});
  const options={filename:path.join(dir,'agent.sqlite'),legacyFiles:[],normalizeWorkspace:(value:unknown)=>value as AgentWorkspaceData,loadInitialState:()=>({workspace:{version:4,conversations:[],skills:[],memories:[],characters:[],personas:[],lorebooks:[],samplerPresets:[]} as unknown as AgentWorkspaceData})};
  let store=new AgentSqlStore(options);cleanup.push(()=>store.close());
  return {get store(){return store;},reopen(){store.close();store=new AgentSqlStore(options);return store;}};
}
const success={result:{resultKind:'business',status:'completed',conversationId:'chat',creationId:'creation',data:{serviceStatus:'succeeded',candidateText:'AI candidate'}}};
it('persists one actual HTTP request result and replays the original receipt across SQL reopen',async()=>{
  const fixtureState=fixture();let posts=0;
  const server=createServer(async(request,response)=>{for await(const _ of request){}posts++;response.end(JSON.stringify(success));});servers.push(server);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const run=async()=>await (await postR4PaidText(()=>fetch(`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`,{method:'POST',body:'fixture'}))).json() as typeof success;
  expect(await runR4PaidService(fixtureState.store,'convert_prompt',{prompt:'scene'},scope,run)).toEqual(success);
  fixtureState.reopen();expect(await runR4PaidService(fixtureState.store,'convert_prompt',{prompt:'scene'},scope,run)).toEqual(success);
  await expect(runR4PaidService(fixtureState.store,'convert_prompt',{prompt:'changed'},scope,run)).rejects.toThrow('不同输入');expect(posts).toBe(1);
});
it('records uncertainty durably and blocks duplicate network attempts',async()=>{
  const fixtureState=fixture(),run=vi.fn(async()=>postR4PaidText(async()=>{throw Error('lost connection after POST');}));
  await expect(runR4PaidService(fixtureState.store,'reverse_prompt',{attachmentId:'image'},scope,run)).rejects.toThrow();
  fixtureState.reopen();recoverR4PaidServices(fixtureState.store);
  await expect(runR4PaidService(fixtureState.store,'reverse_prompt',{attachmentId:'image'},scope,run)).rejects.toThrow('未重新发送');
  expect(run).toHaveBeenCalledTimes(1);expect(Object.values(fixtureState.store.readR4State().gates)).toMatchObject([{active:true,reason:'unknown_prior_receipt',turnId:'origin'}]);
});
it('recovery fences a request that was committed pending before the process disappeared',async()=>{
  const fixtureState=fixture();let started!:()=>void;const begun=new Promise<void>(resolve=>{started=resolve;});
  void runR4PaidService(fixtureState.store,'edit_prompt',{prompt:'scene'},scope,async()=>{await postR4PaidText(async()=>{started();return new Promise<{status:number}>(()=>{});});return success;});
  await begun;fixtureState.reopen();recoverR4PaidServices(fixtureState.store);
  const run=vi.fn(async()=>success);await expect(runR4PaidService(fixtureState.store,'edit_prompt',{prompt:'scene'},scope,run)).rejects.toThrow('未重新发送');
  expect(run).not.toHaveBeenCalled();expect(Object.values(fixtureState.store.readR4State().operations)[0].receipt.phase).toBe('unknown');
});
it('an unknown canonical service result is cached and gates every later automatic paid operation',async()=>{
  const fixtureState=fixture(),unknown={result:{...success.result,status:'error',data:{serviceStatus:'unknown',candidateText:null}}};
  await runR4PaidService(fixtureState.store,'convert_prompt',{prompt:'scene'},scope,async()=>unknown);
  expect(Object.values(fixtureState.store.readR4State().gates)).toMatchObject([{reason:'unknown_prior_receipt',active:true}]);
  const run=vi.fn(async()=>success);expect(await runR4PaidService(fixtureState.store,'convert_prompt',{prompt:'scene'},scope,run)).toEqual(unknown);expect(run).not.toHaveBeenCalled();
});
it.each(['convert_prompt','edit_prompt','reverse_prompt'] as const)('%s persists the actual response certainty before canonical failure and never resends it',async name=>{
  for(const httpStatus of [200,503]){
    const fixtureState=fixture();let posts=0;
    const server=createServer(async(request,response)=>{for await(const _ of request){}posts++;response.writeHead(httpStatus,{'content-type':'application/json'});response.end('{}');});servers.push(server);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const args=name==='reverse_prompt'?{attachmentId:'source'}:name==='edit_prompt'?{kind:'optimize',currentPrompt:'scene'}:{text:'scene'};
    const run=async()=>{await postR4PaidText(()=>fetch(`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`,{method:'POST',body:'fixture'}));return adaptR4LegacyResult(name,args,{ok:false,output:'untrusted upstream text and fixture-key'},{conversationId:'chat',creationId:'creation'},{verifiedTemplateRevision:()=> 'template-r1'});};
    const result=await runR4PaidService(fixtureState.store,name,args,scope,run);
    expect(result.result).toMatchObject({status:'error',data:{serviceStatus:httpStatus===200?'failed':'unknown'}});
    expect(JSON.stringify(result.result)).not.toContain('fixture-key');
    const state=fixtureState.reopen().readR4State();expect(Object.values(state.operations)[0].receipt).toMatchObject({providerRequestCount:1,providerReceipt:{httpStatus,certainty:httpStatus===200?'received':'unknown'},phase:'completed'});
    expect(Object.values(state.gates)).toMatchObject([{active:true,reason:httpStatus===200?'prior_paid_failure':'unknown_prior_receipt'}]);
    expect((await runR4PaidService(fixtureState.store,name,args,scope,run)).result).toEqual(result.result);expect(posts).toBe(1);
  }
});
it('a final pre-POST gate commits definitely-unsent blocked state without an unknown receipt',async()=>{
  const fixtureState=fixture(),send=vi.fn(async()=>({status:200}));
  await expect(runR4PaidService(fixtureState.store,'convert_prompt',{text:'scene'},scope,async()=>{await postR4PaidText(send);return success;},{beforePost:()=>{throw Error('new gate');}})).rejects.toThrow('new gate');
  expect(send).not.toHaveBeenCalled();fixtureState.reopen();recoverR4PaidServices(fixtureState.store);
  expect(Object.values(fixtureState.store.readR4State().operations)[0].receipt.phase).toBe('blocked');expect(Object.values(fixtureState.store.readR4State().gates)).toHaveLength(0);
});

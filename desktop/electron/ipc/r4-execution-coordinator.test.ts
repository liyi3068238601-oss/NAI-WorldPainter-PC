import {mkdirSync,mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {resolve,join,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {afterEach,describe,expect,it} from 'vitest';
import type {AgentWorkspaceData} from '../../src/agent/types';
import type {R4Artwork,R4ConversationConfigSnapshot} from '../../src/agent/r4-types';
import {AgentSqlStore} from './r4-store';
import {R4CreativeHost,type R4HostScope} from './r4-creative-host';
import {R4ExecutionCoordinator} from './r4-execution-coordinator';
import type {R4ExecutionProvider} from './r4-execution-worker';

const cleanup:Array<()=>void>=[];
afterEach(()=>{for(const fn of cleanup.splice(0).reverse())fn();});
const config:R4ConversationConfigSnapshot={version:1,providerRef:{providerId:'model-fixture'},modelId:'model-fixture',presetId:null,enabled:false,
  publicParameters:{visionEnabled:false},capturedAt:'2026-10-18T00:00:00Z',source:'preview'};
const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0u0AAAAASUVORK5CYII=','base64');
const sha=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
function fixture(){
  const root=resolve(process.cwd(),'.tmp','r4-coordinator-tests');mkdirSync(root,{recursive:true});
  const dir=mkdtempSync(join(root,'case-'));cleanup.push(()=>{const p=relative(root,dir);if(!p||p.startsWith('..'))throw Error('Unsafe test cleanup');rmSync(dir,{recursive:true,force:true});});
  const workspace={version:4,conversations:[{id:'chat',title:'Fixture',messages:[],draftAttachments:[]}]} as unknown as AgentWorkspaceData;
  const store=new AgentSqlStore({filename:join(dir,'agent.sqlite'),legacyFiles:[],loadInitialState:()=>({workspace}),normalizeWorkspace:value=>structuredClone(value) as AgentWorkspaceData});
  cleanup.push(()=>store.close());
  const host=new R4CreativeHost(store,{captureConfig:()=>structuredClone(config),resolveAttachment:(_w,state,_c,_cr,id)=>{
    const artwork=Object.values(state.artworks).find(item=>item.attachmentId===id);if(!artwork)throw Error('missing fixture attachment');
    return {attachmentId:id,revision:artwork.revision,hash:sha(readFileSync(artwork.readableHandle!))};
  },prepare:async(creation,args,c)=>({input:{...host.snapshot(creation),positivePrompt:String(args.positivePrompt),conversationConfig:c,
      publicParameters:{operation:creation.editSource?'redraw_image':'generate_image',count:Number(args.count??1),providerRef:{providerId:'image-fixture'},requestedSeedPolicy:'random',requestedSeed:null,requestBudget:{image:Number(args.count??1),vibe_encode:0,upscale:0}}},
    providerRef:{providerId:'image-fixture'},preview:{positivePrompt:String(args.positivePrompt),count:Number(args.count??1),imageProvider:'novelai',estimateSource:'local-estimate',estimatedAnlas:0,warning:'fixture',requestedSeedPolicy:'random',requestedSeed:null,resolvedSeed:null,resolvedSeedSource:null}})});
  const state=host.read('chat'),requests:Array<{prompt:string;source?:string;index:number|null}>=[];
  const provider:R4ExecutionProvider={submit:async(execution,index,context)=>{
    await context.beforeSubmit('image');requests.push({prompt:execution.approvedInput.positivePrompt,source:execution.approvedInput.editSource?.attachmentId,index});
    await context.afterReceipt('image',{status:'confirmed',requestId:`request-${requests.length}`});
    const id=`art-${requests.length}`,file=join(dir,`${id}.png`);writeFileSync(file,bytes);
    const artwork:R4Artwork={id,attachmentId:id,revision:1,conversationId:'chat',creationId:execution.creationId,executionId:execution.id,batchId:execution.id,outputIndex:index!,
      name:`${id}.png`,mime:'image/png',readableHandle:file,hash:sha(bytes),width:1,height:1,parentAttachmentId:execution.approvedInput.editSource?.attachmentId,
      resolvedSeed:null,resolvedSeedSource:null,createdAt:new Date().toISOString()};
    return {requestDisposition:'sent',providerReceiptStatus:'confirmed',outputs:[{outputIndex:index!,status:'completed',artwork,providerReceipt:{status:'confirmed'}}]};
  }};
  const errors:unknown[]=[];
  const coordinator=new R4ExecutionCoordinator(host,provider,error=>errors.push(error));
  const scope=(intent:string):R4HostScope=>({conversationId:'chat',creationId:state.currentCreationId!,userIntentRef:intent,operationKey:`${intent}-operation`});
  return {host,store,coordinator,requests,scope,errors};
}
const data=(value:Record<string,unknown>)=>value.data as Record<string,unknown>;
const settle=async(coordinator:R4ExecutionCoordinator)=>{await new Promise<void>(resolve=>setImmediate(resolve));await coordinator.worker.kick();};

describe('R4 first durable host/provider workflow',()=>{
  it('prepares an arbitrary proposal, atomically accepts once, registers outputs and edits the second result',async()=>{
    const {host,store,coordinator,scope,requests,errors}=fixture();
    const proposal=data(await host.invoke('propose_prompt',{positivePrompt:'rainy bookshop'},scope('proposal')));
    const preview=data(await host.invoke('prepare_generation',{proposalId:proposal.proposalId,revision:1,count:2},scope('generate')));
    expect(Object.keys(store.readR4State().executions)).toHaveLength(0);
    const receipt=coordinator.submit(String(preview.preparationId),String(preview.inputFingerprint),scope('generate'),true);
    const replay=coordinator.submit(String(preview.preparationId),String(preview.inputFingerprint),scope('generate'),true);
    expect(replay).toEqual(receipt);
    await settle(coordinator);
    expect(errors).toEqual([]);expect(requests).toHaveLength(2);
    const executionId=String(data(receipt).executionId),state=store.readR4State();
    expect(state.executions[executionId].status).toBe('completed');
    expect(Object.keys(state.artworks)).toHaveLength(2);
    expect(store.readWorkspace().conversations[0].messages.filter(item=>item.id===`execution:${executionId}`)).toHaveLength(1);
    expect(Object.keys(state.critiqueQueue)).toHaveLength(1);
    expect(data(coordinator.get(executionId,scope('query'))).executionStatus).toBe('completed');
    const creation=state.creations[scope('read').creationId];
    expect(creation.currentProposalRef).toBeUndefined();
    await host.command({conversationId:'chat',creationId:creation.id,type:'set_edit_source',args:{attachmentId:'art-2',attachmentRevision:'1',expectedInputRevision:0}});
    const edit=data(await host.invoke('prepare_generation',{positivePrompt:'change background'},scope('edit')));
    coordinator.submit(String(edit.preparationId),String(edit.inputFingerprint),scope('edit'),true);
    await settle(coordinator);
    expect(errors).toEqual([]);expect(requests).toHaveLength(3);expect(requests[2].source).toBe('art-2');
    const final=store.readR4State();expect(final.artworks['art-3'].parentAttachmentId).toBe('art-2');
    expect(final.creations[creation.id].editSource?.attachmentId).toBe('art-2');
    expect(Object.keys(final.artworks)).toHaveLength(3);
  });

  it('rejects an old preview before durable enqueue after a source/input change',async()=>{
    const {host,store,coordinator,scope,requests}=fixture();
    const prepared=data(await host.invoke('prepare_generation',{positivePrompt:'first'},scope('before-change')));
    await host.command({conversationId:'chat',type:'update_creation',args:{expectedInputRevision:0,publicParameters:{seed:123}}});
    const result=coordinator.submit(String(prepared.preparationId),String(prepared.inputFingerprint),scope('before-change'),true);
    await settle(coordinator);
    expect(data(result).submissionStatus).toBe('stale');expect(requests).toHaveLength(0);expect(Object.keys(store.readR4State().executions)).toHaveLength(0);
  });

  it('cancels a queued execution before provider dispatch and retains its durable receipt',async()=>{
    const {host,store,coordinator,scope,requests}=fixture();
    const preview=data(await host.invoke('prepare_generation',{positivePrompt:'cancel me'},scope('cancel')));
    const accepted=data(coordinator.submit(String(preview.preparationId),String(preview.inputFingerprint),scope('cancel'),true));
    const cancelled=data(await coordinator.cancel(String(accepted.executionId),scope('cancel')));
    await settle(coordinator);
    expect(cancelled.executionStatus).toBe('cancelled');expect(cancelled.providerCancellation).toBe('not_sent');
    expect(requests).toHaveLength(0);expect(Object.keys(store.readR4State().executions)).toHaveLength(1);
  });
});

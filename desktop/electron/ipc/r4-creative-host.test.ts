import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {join,resolve,relative} from 'node:path';
import {afterEach,describe,expect,it} from 'vitest';
import type {AgentWorkspaceData} from '../../src/agent/types';
import type {R4ConversationConfigSnapshot} from '../../src/agent/r4-types';
import {AgentSqlStore} from './r4-store';
import {R4CreativeHost,type R4HostScope} from './r4-creative-host';

const resources:Array<()=>void>=[];
afterEach(()=>{for(const dispose of resources.splice(0).reverse())dispose();});
const config:R4ConversationConfigSnapshot={version:1,providerRef:{providerId:'fixture'},modelId:'fixture-model',presetId:null,enabled:false,
  publicParameters:{},capturedAt:'2026-10-18T00:00:00Z',source:'preview'};
function fixture(){
  const testRoot=resolve(process.cwd(),'.tmp','r4-host-tests');mkdirSync(testRoot,{recursive:true});
  const dir=mkdtempSync(join(testRoot,'case-'));resources.push(()=>{
    const subpath=relative(testRoot,resolve(dir));
    if(!subpath||subpath.startsWith('..'))throw Error('Refuse cleanup outside test root');
    rmSync(dir,{recursive:true,force:true});
  });
  const workspace={version:4,conversations:[{id:'chat',title:'Test',messages:[],draftAttachments:[]}]} as unknown as AgentWorkspaceData;
  const store=new AgentSqlStore({filename:join(dir,'agent.sqlite'),legacyFiles:[],loadInitialState:()=>({workspace}),normalizeWorkspace:raw=>structuredClone(raw) as AgentWorkspaceData});
  resources.push(()=>store.close());
  const host=new R4CreativeHost(store,{captureConfig:()=>structuredClone(config),resolveAttachment:(_w,_s,_c,_cr,id)=>({attachmentId:id,revision:1,hash:'a'.repeat(64),name:id}),
    prepare:async(creation,args,c)=>({input:{...host.snapshot(creation),positivePrompt:String(args.positivePrompt),conversationConfig:c},providerRef:{providerId:'image-fixture'},
      preview:{positivePrompt:String(args.positivePrompt),negativePrompt:String(args.negativePrompt??''),stylePrompt:String(args.stylePrompt??''),count:1,imageProvider:'novelai',estimateSource:'local-estimate',estimatedAnlas:0,
        warning:'fixture',requestedSeedPolicy:'random',requestedSeed:null,resolvedSeed:null,resolvedSeedSource:null}})});
  const state=host.read('chat');
  const scope=(key:string):R4HostScope=>({conversationId:'chat',creationId:state.currentCreationId!,operationKey:key,userIntentRef:'user-1'});
  return {host,store,scope,dir};
}
const data=(result:Record<string,unknown>)=>result.data as Record<string,unknown>;

describe('durable R4 creative host',()=>{
  it('versions proposals without implicitly selecting, applying, or generating',async()=>{
    const {host,store,scope}=fixture();
    const first=data(await host.invoke('propose_prompt',{positivePrompt:'quiet bookshop',changeSummary:'warm light'},scope('create')));
    expect(first.proposalStatus).toBe('proposed');
    expect(Object.values(store.readR4State().creations)[0].currentProposalRef).toBeUndefined();
    const second=data(await host.invoke('propose_prompt',{proposalId:first.proposalId,baseRevision:1,positivePrompt:'quiet bookshop, rain'},scope('revise')));
    expect(second.revision).toBe(2);
    expect(Object.keys(store.readR4State().proposals)).toHaveLength(2);
    expect(Object.keys(store.readR4State().executions)).toHaveLength(0);
    const read=data(await host.invoke('read_proposal',{proposalId:first.proposalId,revision:1},scope('read')));
    expect(read.positivePrompt).toBe('quiet bookshop');
  });

  it('replays one operation before CAS but rejects different inputs under the same key',async()=>{
    const {host,scope}=fixture();
    const proposal=data(await host.invoke('propose_prompt',{positivePrompt:'bookshop'},scope('proposal')));
    const args={proposalId:proposal.proposalId,revision:1,expectedSelectionRevision:0};
    const first=await host.invoke('set_current_proposal',args,scope('select'));
    const replay=await host.invoke('set_current_proposal',args,scope('select'));
    expect(replay).toEqual(first);
    expect(data(first).selectionRevision).toBe(1);
    await expect(host.invoke('set_current_proposal',{...args,expectedSelectionRevision:1},scope('select'))).rejects.toThrow('不同输入');
    expect(data(await host.invoke('set_current_proposal',args,scope('new-stale'))).selectionStatus).toBe('conflict');
  });

  it('requires exact host opt-in and resets participation when purpose changes',async()=>{
    const {host,store,scope}=fixture();
    const args={expectedInputRevision:0,action:'set_reference_usage',attachmentId:'reference-a',attachmentRevision:'1',role:'reference',referencePurpose:'color',includeInGeneration:true};
    await expect(host.invoke('patch_creation_inputs',args,scope('model-claim'))).rejects.toThrow('明确参与');
    const confirmed=scope('explicit-optin');confirmed.referenceOptIns=[{attachmentId:'reference-a',attachmentRevision:1,purpose:'color'}];
    expect(data(await host.invoke('patch_creation_inputs',args,confirmed)).inputStatus).toBe('applied');
    expect(Object.values(store.readR4State().creations)[0].references[0].includeInGeneration).toBe(true);
    await expect(host.invoke('patch_creation_inputs',{...args,expectedInputRevision:1,referencePurpose:'composition'},scope('wrong-purpose'))).rejects.toThrow('明确参与');
    await host.invoke('patch_creation_inputs',{...args,expectedInputRevision:1,referencePurpose:'composition',includeInGeneration:false},scope('change-purpose'));
    expect(Object.values(store.readR4State().creations)[0].references[0].includeInGeneration).toBe(false);
  });

  it('clears source and mask together, leaves artworks, and protects undo with CAS',async()=>{
    const {host,store,scope}=fixture();
    expect((await host.command({conversationId:'chat',type:'set_edit_source',args:{attachmentId:'source',maskAttachmentId:'mask',expectedInputRevision:0}})).ok).toBe(true);
    const cleared=data(await host.invoke('patch_creation_inputs',{action:'clear_edit_source',expectedInputRevision:1,expectedAttachmentId:'source'},scope('clear')));
    let creation=Object.values(store.readR4State().creations)[0];
    expect(creation.editSource).toBeNull();expect(creation.mask).toBeNull();
    expect((await host.command({conversationId:'chat',type:'undo_operation',args:{operationId:cleared.actionId}})).ok).toBe(true);
    creation=Object.values(store.readR4State().creations)[0];expect(creation.editSource?.attachmentId).toBe('source');
    expect((await host.command({conversationId:'chat',type:'undo_operation',args:{operationId:cleared.actionId}})).ok).toBe(false);
  });

  it('keeps a fixed proposal preview valid when only discussion selection changes',async()=>{
    const {host,store,scope}=fixture();
    const first=data(await host.invoke('propose_prompt',{positivePrompt:'first'},scope('p1')));
    const second=data(await host.invoke('propose_prompt',{positivePrompt:'second'},scope('p2')));
    const prepared=data(await host.invoke('prepare_generation',{proposalId:first.proposalId,revision:1},scope('preview')));
    await host.invoke('set_current_proposal',{proposalId:second.proposalId,revision:1,expectedSelectionRevision:0},scope('choose-second'));
    const preparation=store.readR4State().preparations[String(prepared.preparationId)];
    expect(preparation.status).toBe('ready');expect(preparation.inputSnapshot.positivePrompt).toBe('first');
    await host.command({conversationId:'chat',type:'update_creation',args:{expectedInputRevision:0,publicParameters:{seed:12}}});
    expect(store.readR4State().preparations[preparation.id].status).toBe('invalidated');
  });
});

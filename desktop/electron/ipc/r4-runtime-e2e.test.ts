import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {createAssistantMessageEventStream,type AssistantMessage,type Model} from '@earendil-works/pi-ai';
import type {AgentWorkspaceData} from '../../src/agent/types';
import type {R4Execution} from '../../src/agent/r4-types';
import {DEFAULT_PARAMS,type AppSettings} from '../../src/types';
import {AgentSqlStore} from './r4-store';

const fixture=vi.hoisted(()=>({dir:'',store:null as AgentSqlStore|null,settings:null as AppSettings|null,workbench:null as any,requests:[] as R4Execution[],modelCalls:[] as any[],step:0}));
vi.mock('./agent-workspace-location',()=>({agentWorkspaceDirectory:()=>fixture.dir}));
vi.mock('./local-media-protocol',()=>({toLocalMediaUrl:(file:string)=>`local-media://fixture/${path.basename(file)}`}));
vi.mock('./store',()=>({getSettings:()=>fixture.settings,getToken:()=> 'public-test-token',getHistory:()=>[],getAccountSummary:()=>({hasToken:true,tierLevel:0,hasActiveSubscription:false})}));
vi.mock('./agent-store',()=>({getAgentSqlStore:()=>fixture.store,readAgentWorkspace:()=>fixture.store!.readWorkspace(),
  updateAgentConversation:(id:string,update:(chat:any)=>void)=>fixture.store!.transaction(tx=>{const workspace=tx.getWorkspace(),chat=workspace.conversations.find(row=>row.id===id);if(chat){update(chat);tx.setWorkspace(workspace);}})}));
vi.mock('./agent-tools',()=>({AGENT_READ_TOOLS:[],AGENT_MUTATING_TOOLS:[],executeAgentTool:vi.fn(async({tool}:any)=>{
  if(tool==='langbai_get_generation_state')return {ok:true,title:'Live Generate workbench',output:'fixture snapshot',data:{imageProvider:'novelai',modelMode:'anime',referenceCapabilities:{maxCharacterPrompts:3,vibeTransfer:true,preciseReference:true,attachmentIdsRequiredForAgentReferences:true}}};
  throw Error(`Unexpected legacy tool ${String(tool)}`);
})}));
vi.mock('./r4-workbench',()=>({getR4WorkbenchService:()=>({
  ready:()=>true,
  readR4WorkbenchSnapshot:async()=>structuredClone(fixture.workbench),
  createR4ApplyPrompt:()=>async()=>({resultKind:'business',status:'completed',conversationId:'chat',creationId:'fixture-creation',data:{applyStatus:'unchanged',draftId:'runtime-workbench',draftRevision:fixture.workbench?.draftRevision??1,diff:{positivePromptChanged:false,negativePromptChanged:false,stylePromptChanged:false}}}),
  writeR4WorkbenchPrompts:async(args:any,scope:any)=>{
    const current=fixture.workbench;
    const changedFields={positivePromptChanged:args.positivePrompt!==undefined&&args.positivePrompt!==current.params.positivePrompt,
      negativePromptChanged:args.negativePrompt!==undefined&&args.negativePrompt!==current.params.negativePrompt,
      stylePromptChanged:args.stylePrompt!==undefined&&args.stylePrompt!==current.params.stylePrompt};
    if(args.expectedDraftRevision!==current.draftRevision)return {resultKind:'business',status:'completed',conversationId:scope.conversationId,creationId:scope.creationId,
      data:{writeStatus:'conflict',draftId:current.draftId,draftRevision:current.draftRevision,changedFields}};
    fixture.workbench={...current,draftRevision:current.draftRevision+1,inputRevision:current.inputRevision+1,
      params:{...current.params,...Object.fromEntries(['positivePrompt','negativePrompt','stylePrompt'].filter(key=>args[key]!==undefined).map(key=>[key,args[key]]))}};
    return {resultKind:'business',status:'completed',conversationId:scope.conversationId,creationId:scope.creationId,
      data:{writeStatus:'written',draftId:fixture.workbench.draftId,draftRevision:fixture.workbench.draftRevision,changedFields}};
  },publishCompletedResults:async()=>{},
})}));
vi.mock('./worldpainter-knowledge',()=>({worldpainterKnowledgeContext:async()=>({version:'v45',prompt:'fixture creative guidance'}),readWorldpainterPromptingReference:vi.fn()}));
vi.mock('./r4-image-provider',()=>({R4ImageProvider:class{
  async submit(execution:R4Execution,index:number,context:any){
    const kind=execution.approvedInput.publicParameters.operation==='upscale_image'?'upscale':'image';
    const passes=kind==='upscale'?Number(execution.approvedInput.publicParameters.upscalePasses):1;
    for(let pass=0;pass<passes;pass++){
      await context.beforeSubmit(kind);fixture.requests.push(structuredClone(execution));
      await context.afterReceipt(kind,{status:'confirmed',requestId:`local-${fixture.requests.length}`});
    }
    const id=`output-${fixture.requests.length}`,file=path.join(fixture.dir,`${id}.png`),bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0u0AAAAASUVORK5CYII=','base64');fs.writeFileSync(file,bytes);
    const artwork={id,attachmentId:id,revision:1,conversationId:execution.conversationId,creationId:execution.creationId,executionId:execution.id,batchId:execution.id,outputIndex:index,
      name:`${id}.png`,mime:'image/png',width:1,height:1,readableHandle:file,hash:createHash('sha256').update(bytes).digest('hex'),createdAt:new Date().toISOString(),resolvedSeed:null,resolvedSeedSource:null,parentAttachmentId:execution.approvedInput.editSource?.attachmentId};
    return {requestDisposition:'sent',providerReceiptStatus:'confirmed',outputs:[{outputIndex:index,status:'completed',artwork,providerReceipt:{status:'confirmed'}}]};
  }
}}));
const model:Model<'openai-completions'>={id:'local-model',name:'local-model',provider:'local-fixture',api:'openai-completions',baseUrl:'https://fixture.invalid',reasoning:false,input:['text'],
  contextWindow:128000,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
vi.mock('./pi-agent-provider',()=>({studioPiModel:()=>model,studioPiStream:()=>((_model:any,context:any)=>{
  fixture.modelCalls.push(JSON.parse(JSON.stringify(context)));
  const step=fixture.step++,stream=createAssistantMessageEventStream();
  const tool=(name:string,args:Record<string,unknown>)=>[{type:'toolCall' as const,id:`call-${step}`,name,arguments:args}];
  const toolResults=context.messages.filter((row:any)=>row.role==='toolResult').flatMap((row:any)=>row.content.filter((part:any)=>part.type==='text').flatMap((part:any)=>{try{return [JSON.parse(part.text)];}catch{return[];}}));
  const preparation=toolResults.map((value:any)=>value.data).reverse().find((data:any)=>data?.preparationId);
  const readState=toolResults.map((value:any)=>value.data).reverse().find((data:any)=>data?.readStatus==='ok');
  const content=step===0?tool('get_capabilities',{requestedGroups:['prompt','generation','creation_context','workbench']})
    :step===1?tool('read_generation_state',{})
    :step===2?tool('write_workbench_prompts',{positivePrompt:'a quiet rainy bookshop',negativePrompt:'blur',stylePrompt:'watercolor',expectedDraftRevision:readState?.draftRevision})
    :step===3?tool('read_generation_state',{})
    :step===4?tool('prepare_generation',{})
    :step===5||step===6?tool('generate_image',{preparationId:preparation?.preparationId})
    :[{type:'text' as const,text:'工作台提示词已更新，图片已入队并收到作品回执。'}];
  const message:AssistantMessage={role:'assistant',content,api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),stopReason:step<7?'toolUse':'stop',
    usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
  queueMicrotask(()=>{stream.push({type:'start',partial:message});stream.push({type:'done',reason:step<5?'toolUse':'stop',message});});return stream;
})}));

import {R4AgentRuntime} from './r4-agent-runtime';
import {getR4CreativeHost,getR4ExecutionCoordinator,prepareR4ImageOperation} from './r4-agent-service';
import {StudioPiApprovals} from './pi-agent-approval';
const runtime=new R4AgentRuntime({emit:()=>{},activeRequests:new Map(),approvals:new StudioPiApprovals(),images:messages=>messages,smoothEmitter:()=>({push:()=>{},flush:()=>{}})});
const root=path.resolve('.tmp/r4-runtime-e2e');
beforeEach(()=>{
  fs.mkdirSync(root,{recursive:true});fixture.dir=fs.mkdtempSync(path.join(root,'case-'));
  fixture.settings={agentApiProtocol:'openai-compatible',agentApiBaseUrl:'https://fixture.invalid/v1',agentApiKey:'public-test-model-key',agentApiModel:'local-model',agentVisionEnabled:false,
    agentContextWindow:128000,agentMaxOutputTokens:4096,agentAutoCompact:false,agentAutoCompactThreshold:.8,imageProvider:'novelai',proxyMode:'direct',proxyUrl:'',modelMode:'anime',
    outputDir:fixture.dir,lastGenerationState:{params:{...DEFAULT_PARAMS,negativePrompt:'',stylePrompt:''}},savedAgentModels:[],stylePromptPresets:[],positivePromptPresets:[],promptChunks:[]} as unknown as AppSettings;
  fixture.workbench={draftId:'runtime-workbench',draftRevision:1,inputRevision:1,draftSource:'workbench',params:{...DEFAULT_PARAMS,positivePrompt:'',negativePrompt:'',stylePrompt:''},
    workbench:{mode:'generate:t2i',historyGroupId:'runtime-generation-group',modelMode:'anime',batchCount:2,batchIntervalSeconds:0,charCaptions:[],vibeImages:[],preciseReferences:[],
      busy:{isGenerating:false,isGenerateQueueRunning:false,batchRunning:false}}};
  const workspace={version:4,conversations:[{id:'chat',title:'fixture',messages:[],draftAttachments:[],status:'idle',characterIds:[],lorebookIds:[],selectedSkillIds:[],studioApprovalMode:'auto',compactCount:0}],
    characters:[],personas:[],lorebooks:[],skills:[],memories:[],samplerPresets:[],defaultGenerationMode:'confirm',updatedAt:new Date().toISOString()} as unknown as AgentWorkspaceData;
  fixture.store=new AgentSqlStore({filename:path.join(fixture.dir,'agent.sqlite'),legacyFiles:[],loadInitialState:()=>({workspace}),normalizeWorkspace:value=>structuredClone(value) as AgentWorkspaceData});
  fixture.requests=[];fixture.modelCalls=[];fixture.step=0;
});
afterEach(async()=>{
  await runtime.queue().kick('chat');await getR4ExecutionCoordinator().worker.kick();
  fixture.store?.close();fixture.store=null;
  const relative=path.relative(root,fixture.dir);if(!relative||relative.startsWith('..'))throw Error('Unsafe cleanup');fs.rmSync(fixture.dir,{recursive:true,force:true});
});

describe('actual R4 Pi / SQL / host / worker integration with local fake providers',()=>{
  it('uses the queued preset snapshot for runtime metadata and body after the current selection changes',async()=>{
    const host=getR4CreativeHost(),initial=host.read('chat');
    const oldPresetId='queued-preset',newPresetId='current-preset',oldBody='frozen queued preset body';
    fixture.store!.transaction(tx=>{
      const state=tx.getR4State();
      state.assistantPresets[oldPresetId]={id:oldPresetId,name:'Queued preset name',body:oldBody,revision:7,hash:'stale-stored-hash',source:'user'};
      state.assistantPresets[newPresetId]={id:newPresetId,name:'Current preset name',body:'current preset body',revision:12,hash:'current-hash',source:'user'};
      state.conversations.chat.assistantPresetBinding={presetId:oldPresetId,enabled:true};
      delete state.conversations.chat.config;
      const workspace=tx.getWorkspace();
      workspace.conversations[0].studioPresetId='dsh-infinite-gen-4';
      workspace.conversations[0].studioTemplateEnabled=true;
      tx.setWorkspace(workspace);tx.setR4State(state);
    });

    const turnOptions:Record<string,any>[]=[];
    const isolatedRuntime=new R4AgentRuntime({
      emit:()=>{},activeRequests:new Map(),approvals:new StudioPiApprovals(),images:messages=>messages,
      smoothEmitter:()=>({push:()=>{},flush:()=>{}}),
      completeTurn:(async (options:unknown)=>{turnOptions.push(options as Record<string,any>);return {content:'queued turn completed'};}) as never,
    });
    const queue=isolatedRuntime.queue();
    let release!:()=>void;
    const heldWork=new Promise<void>(resolve=>{release=resolve;});
    const hold=queue.withConversation('chat',()=>heldWork);
    await Promise.resolve();
    let frozenConfig:unknown;

    try{
      const admitted=isolatedRuntime.send({conversationId:'chat',creationId:initial.currentCreationId,text:'use the selected assistant preset'});
      expect(admitted.ok).toBe(true);
      const queued=fixture.store!.readR4State().messageQueue[admitted.queueId!]!;
      expect(queued.conversationConfig).toMatchObject({presetId:oldPresetId,enabled:true,body:oldBody,revision:7});
      frozenConfig=structuredClone(queued.conversationConfig);

      const changed=await host.command({conversationId:'chat',type:'set_preset_binding',args:{presetId:newPresetId,enabled:true}});
      expect(changed.ok).toBe(true);
      fixture.store!.transaction(tx=>{
        const workspace=tx.getWorkspace();
        workspace.conversations[0].studioPresetId='dsh-infinite-gen-5';
        tx.setWorkspace(workspace);
      });
      expect(getR4CreativeHost().read('chat').assistantPresetBinding).toMatchObject({presetId:newPresetId,enabled:true});
      expect(fixture.store!.readR4State().conversations.chat.config).toMatchObject({presetId:newPresetId,body:'current preset body',revision:12});
    }finally{
      release();
      await hold;
      await queue.kick('chat');
    }

    expect(turnOptions).toHaveLength(1);
    const options=turnOptions[0];
    const resourceContext=JSON.parse(options.resourceContext);
    expect(options.configuredSystemPrompt).toBe(oldBody);
    expect(resourceContext.preset).toEqual({
      id:oldPresetId,enabled:true,revision:7,hash:createHash('sha256').update(oldBody).digest('hex'),
    });
    expect(JSON.stringify(resourceContext.preset)).not.toContain('presetInfinite');
    expect(JSON.stringify(resourceContext.preset)).not.toContain('Current preset name');
    expect(Object.values(fixture.store!.readR4State().messageQueue)[0].conversationConfig).toEqual(frozenConfig);
  });

  it('explicitly continues a fresh task through Pi and the worker without replaying or clearing a prior uncertain paid service',async()=>{
    const host=getR4CreativeHost(),initial=host.read('chat');
    fixture.store!.transaction(tx=>{const state=tx.getR4State();
      state.gates['paid-service:A']={id:'paid-service:A',conversationId:'chat',turnId:'uncertain-old-intent',reason:'unknown_prior_receipt',active:true,createdAt:'2026-10-18T00:00:00Z'};
      state.operations['paid-service:A']={id:'paid-service:A',conversationId:'chat',creationId:initial.currentCreationId!,operationKey:'uncertain-old-operation',operation:'paid_service',status:'applied',userIntentRef:'uncertain-old-intent',receipt:{phase:'unknown',tool:'reverse_prompt',providerRequestCount:1},createdAt:'2026-10-18T00:00:00Z'};tx.setR4State(state);
    });
    const original=structuredClone(fixture.store!.readR4State().operations['paid-service:A']);
    const admitted=runtime.send({conversationId:'chat',creationId:initial.currentCreationId,text:'新的独立任务 B：雨夜书店，生成两张'});expect(admitted.ok).toBe(true);
    await runtime.queue().kick('chat');expect(fixture.modelCalls).toHaveLength(0);expect(fixture.requests).toHaveLength(0);
    expect(fixture.store!.readR4State().messageQueue[admitted.queueId!].status).toBe('paused');
    const continued=await host.command({conversationId:'chat',type:'resume_messages',args:{messageIds:[admitted.messageId],acknowledgedGateIds:['paid-service:A']}});expect(continued.ok).toBe(true);
    await runtime.queue().kick('chat');await new Promise<void>(resolve=>setImmediate(resolve));await getR4ExecutionCoordinator().worker.kick();
    expect(fixture.modelCalls).toHaveLength(8);expect(fixture.requests).toHaveLength(2);
    const state=fixture.store!.readR4State();expect(state.gates['paid-service:A'].active).toBe(true);expect(state.operations['paid-service:A']).toEqual(original);
    expect(Object.values(state.executions)).toMatchObject([{status:'completed',releasedGateIds:['paid-service:A']}]);
    expect(state.messageQueue[admitted.queueId!].status).toBe('completed');
  });
  it('writes the live workbench, durably enqueues exactly once and registers each actual output',async()=>{
    const state=getR4CreativeHost().read('chat');
    const admitted=runtime.send({conversationId:'chat',creationId:state.currentCreationId,text:'为雨夜书店拟词，生成两张'});
    expect(admitted.ok).toBe(true);
    await runtime.queue().kick('chat');await new Promise<void>(resolve=>setImmediate(resolve));await getR4ExecutionCoordinator().worker.kick();
    const current=fixture.store!.readR4State(),chat=fixture.store!.readWorkspace().conversations[0];
    expect(Object.values(current.messageQueue).map(row=>({status:row.status,reason:row.pauseReason}))).toEqual([{status:'completed',reason:undefined}]);
    expect(fixture.modelCalls).toHaveLength(8);
    expect(fixture.modelCalls[0].tools.map((row:any)=>row.name)).toEqual(['get_capabilities']);
    expect(fixture.modelCalls[1].tools.map((row:any)=>row.name)).toContain('read_generation_state');
    expect(fixture.modelCalls[2].tools.map((row:any)=>row.name)).toContain('write_workbench_prompts');
    expect(fixture.modelCalls[2].tools.find((row:any)=>row.name==='write_workbench_prompts').parameters.properties).not.toHaveProperty('args');
    expect(Object.keys(current.proposals)).toHaveLength(0);expect(current.creations[state.currentCreationId!].currentProposalRef).toBeUndefined();
    expect(fixture.workbench.params).toMatchObject({positivePrompt:'a quiet rainy bookshop',negativePrompt:'blur',stylePrompt:'watercolor'});
    expect(fixture.workbench.draftRevision).toBe(2);
    expect(Object.keys(current.executions)).toHaveLength(1);expect(fixture.requests).toHaveLength(2);
    const execution=Object.values(current.executions)[0];expect(execution.status).toBe('completed');
    expect(chat.messages.find(row=>row.id===`execution:${execution.id}`)?.attachments).toEqual(expect.arrayContaining([expect.objectContaining({revision:1,creationId:execution.creationId,role:'artwork',sha256:expect.stringMatching(/^[a-f0-9]{64}$/)})]));
    expect(execution.outputs.map(row=>row.status)).toEqual(['completed','completed']);expect(Object.keys(current.artworks)).toHaveLength(2);
    expect(chat.messages.filter(row=>row.id===`execution:${execution.id}`)).toHaveLength(1);
    expect(chat.messages.find(row=>row.id===Object.values(current.messageQueue)[0].assistantMessageId)?.content).toContain('已入队');
    const results=fixture.modelCalls.at(-1).messages.filter((row:any)=>row.role==='toolResult');
    expect(results.filter((row:any)=>row.toolName==='generate_image')).toHaveLength(2);
    const receipts=results.filter((row:any)=>row.toolName==='generate_image').map((row:any)=>JSON.parse(row.content[0].text));
    expect(receipts[0]).toEqual(receipts[1]);
  });

  it.each([
    ['redraw_image',{positivePrompt:'change lighting',strength:.65},1],
    ['inpaint_image',{positivePrompt:'change sleeve',maskAttachmentId:'mask',strength:.7},1],
    ['upscale_image',{scale:4},2],
    ['process_image',{operation:'lineart'},1],
  ] as const)('%s uses the same durable snapshot/approval/worker path and preserves the selected edit source',async(operation,args,count)=>{
    const host=getR4CreativeHost(),state=host.read('chat'),creationId=state.currentCreationId!;
    const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0u0AAAAASUVORK5CYII=','base64');
    fixture.store!.transaction(tx=>{const workspace=tx.getWorkspace(),chat=workspace.conversations[0];
      for(const id of ['persistent-source','operation-source','mask']){const file=path.join(fixture.dir,`${id}.png`);fs.writeFileSync(file,bytes);chat.draftAttachments.push({id,revision:1,name:`${id}.png`,mime:'image/png',kind:'image',size:bytes.length,width:1,height:1,filePath:file,createdAt:new Date().toISOString()});}
      tx.setWorkspace(workspace);
    });
    const selected=await host.command({conversationId:'chat',creationId,type:'set_edit_source',args:{attachmentId:'persistent-source',expectedInputRevision:0}});
    expect(selected.message).toBeUndefined();expect(selected.ok).toBe(true);
    const scope={conversationId:'chat',creationId,userIntentRef:`intent-${operation}`,operationKey:`operation-${operation}`};
    const preview=await prepareR4ImageOperation(operation,{...args,attachmentId:'operation-source'},scope,new AbortController().signal);
    const prep=fixture.store!.readR4State().preparations[preview.preparationId];
    expect(prep.inputSnapshot.editSource?.attachmentId).toBe('operation-source');expect(prep.preview.count).toBe(1);
    expect(prep.inputSnapshot.publicParameters.requestBudget).toEqual({image:operation==='upscale_image'?0:1,vibe_encode:0,upscale:operation==='upscale_image'?2:0});
    const coordinator=getR4ExecutionCoordinator(),receipt=coordinator.submit(preview.preparationId,preview.fingerprint,scope,true);
    await new Promise<void>(resolve=>setImmediate(resolve));await coordinator.worker.kick();
    const current=fixture.store!.readR4State(),execution=current.executions[String((receipt.data as Record<string,unknown>).executionId)];
    expect(fixture.requests).toHaveLength(count);expect(execution.status).toBe('completed');
    expect(execution.outputs[0].artwork?.parentAttachmentId).toBe('operation-source');
    expect(current.creations[creationId].editSource?.attachmentId).toBe('persistent-source');
    expect(execution.approvedInput.publicParameters.operation).toBe(operation);
  });
});

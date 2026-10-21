import {describe,it,expect,vi} from 'vitest';
vi.mock('./store',()=>({useAppStore:{}}));
import {createStudioAgentService,type StudioAgentDependencies} from './studio-agent';
import {DEFAULT_PARAMS,type HistoryItem} from './types';
import type {StudioAgentRequest} from './studio-agent-contract';

function fixture() {
  let state={bootDone:true,settings:{language:'zh-CN'},params:{...DEFAULT_PARAMS,positivePrompt:'live',stylePrompt:'ink'},
    charCaptions:[],batchCount:3,batchIntervalSeconds:2,activeCanvasSurface:'generate:i2i',i2iSourceMode:'original',
    i2iParams:{strength:.7,noise:0},i2iOriginalImage:{filePath:'source.png',fileUrl:'nai-local://source',width:512,height:512},
    maskRevision:1,inpaintMask:null,vibeImages:[],preciseReferences:[],history:[],currentImage:null,
  } as unknown as ReturnType<StudioAgentDependencies['getState']>;
  const saved={id:'saved',filePath:'saved.png',fileUrl:'nai-local://saved',width:512,height:512,params:{...DEFAULT_PARAMS},createdAt:'2026-10-21',date:'2026-10-21',actualSeed:12,model:DEFAULT_PARAMS.model} satisfies HistoryItem;
  const getHistory=vi.fn(async()=>[saved]);
  state.applyParams=(patch,draft)=>{state={...state,params:{...state.params,...patch},...(draft?.charCaptions?{charCaptions:draft.charCaptions.map((item,index)=>({...item,id:String(index)}))}:{}),...(draft?.inpaintPositivePrompt!==undefined?{inpaintPositivePrompt:draft.inpaintPositivePrompt}:{})};};
  const service=createStudioAgentService({getState:()=>state,setState:patch=>{state={...state,...patch};},
    api:{getHistory} as unknown as StudioAgentDependencies['api'],uuid:()=> 'renderer-draft'});
  return {call:(action:StudioAgentRequest['action'],args:Record<string,unknown>={})=>service.handle({id:'test',action,args}),
    get state(){return state;},change:(patch:Partial<typeof state>)=>{state={...state,...patch};},saved,getHistory};
}

describe('Actual Generate workbench bridge',()=>{
  it('freezes real source, batch, parameters and references independently of later UI changes',async()=>{
    const f=fixture(),snapshot=await f.call('r4-workbench-read');
    expect(snapshot).toMatchObject({ok:true,data:{params:{positivePrompt:'live',stylePrompt:'ink'},workbench:{mode:'generate:i2i',batchCount:3,source:{filePath:'source.png'}}}});
    f.state.i2iOriginalImage!.filePath='changed.png';
    expect((snapshot.data as any).workbench.source.filePath).toBe('source.png');
  });
  it('rejects stale prompt writes after a manual edit; a valid CAS only changes prompt fields',async()=>{
    const f=fixture(),before=(await f.call('r4-workbench-read')).data as any;
    f.change({params:{...f.state.params,positivePrompt:'manual'}});
    const patch={positivePrompt:'assistant',negativePrompt:'bad',stylePrompt:'ink'};
    expect(await f.call('r4-workbench-apply',{draftId:before.draftId,draftRevision:before.draftRevision,patch})).toMatchObject({ok:true,data:{applyStatus:'conflict'}});
    const fresh=(await f.call('r4-workbench-read')).data as any;
    expect(await f.call('r4-workbench-apply',{draftId:fresh.draftId,draftRevision:fresh.draftRevision,patch})).toMatchObject({ok:true,data:{applyStatus:'applied'}});
    expect(f.state.params.positivePrompt).toBe('assistant');expect(f.state.batchCount).toBe(3);expect(f.state.i2iOriginalImage?.filePath).toBe('source.png');
  });
  it('commits character boxes with prompt text and rejects a stale character edit or unsupported model',async()=>{
    const f=fixture(),read=(await f.call('r4-workbench-read')).data as any;
    const patch={positivePrompt:'two people',negativePrompt:'avoid',stylePrompt:'ink'};
    const characterPrompts=[{prompt:'first',useCoords:true,x:0,y:.5},{prompt:'second',useCoords:true,x:1,y:.5}];
    expect(await f.call('r4-workbench-apply',{draftId:read.draftId,draftRevision:read.draftRevision,patch,characterPrompts})).toMatchObject({ok:true,data:{applyStatus:'applied',diff:{characterPromptsChanged:true}}});
    expect(f.state.params.positivePrompt).toBe('two people');expect(f.state.charCaptions.map(item=>item.prompt)).toEqual(['first','second']);
    expect(await f.call('r4-workbench-apply',{draftId:read.draftId,draftRevision:read.draftRevision,patch,characterPrompts:[]})).toMatchObject({ok:true,data:{applyStatus:'conflict'}});
    const fresh=(await f.call('r4-workbench-read')).data as any;
    expect(await f.call('r4-workbench-apply',{draftId:fresh.draftId,draftRevision:fresh.draftRevision,patch,characterPrompts:[]})).toMatchObject({ok:true,data:{applyStatus:'applied'}});
    expect(f.state.charCaptions).toHaveLength(0);
    f.change({params:{...f.state.params,model:'nai-diffusion-3'}});
    const v3=(await f.call('r4-workbench-read')).data as any;
    expect(await f.call('r4-workbench-apply',{draftId:v3.draftId,draftRevision:v3.draftRevision,patch,characterPrompts})).toMatchObject({ok:false});
    expect(f.state.charCaptions).toHaveLength(0);
  });
  it('reads and writes the independent legacy inpaint prompt without replacing the Generate prompt',async()=>{
    const f=fixture();
    f.change({activeCanvasSurface:'inpaint',inpaintPositivePrompt:'old inpaint',setInpaintPositivePrompt:value=>f.change({inpaintPositivePrompt:value})});
    const read=(await f.call('r4-workbench-read')).data as any;
    expect(read.params.positivePrompt).toBe('old inpaint');
    expect(await f.call('r4-workbench-apply',{draftId:read.draftId,draftRevision:read.draftRevision,patch:{positivePrompt:'new inpaint',negativePrompt:'avoid',stylePrompt:'ink'}})).toMatchObject({ok:true,data:{applyStatus:'applied'}});
    expect(f.state.inpaintPositivePrompt).toBe('new inpaint');
    expect(f.state.params.positivePrompt).toBe('live');
    expect(f.state.params.negativePrompt).toBe('avoid');
  });
  it('presents only saved generation results, deduplicates delivery and preserves current draft parameters',async()=>{
    const f=fixture(),args={executionId:'execution-1',outputId:'output-1',image:{id:f.saved.id,filePath:f.saved.filePath}};
    expect(await f.call('r4-workbench-result',args)).toMatchObject({ok:true,data:{presented:true}});
    expect(f.state.currentImage).toEqual(f.saved);expect(f.state.params.positivePrompt).toBe('live');expect(f.state.batchCount).toBe(3);
    expect(await f.call('r4-workbench-result',args)).toMatchObject({ok:true,data:{duplicate:true}});
    expect(f.getHistory).toHaveBeenCalledTimes(1);
    expect(await f.call('r4-workbench-result',{...args,outputId:'unverified',image:{filePath:'arbitrary.png'}})).toMatchObject({ok:false});
    expect(f.state.currentImage).toEqual(f.saved);
  });
});

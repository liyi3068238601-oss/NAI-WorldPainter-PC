import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {useAppStore} from '../../src/store';
import {createStudioAgentService} from '../../src/studio-agent';
import {DEFAULT_PARAMS,type AppSettings} from '../../src/types';
import {validateR4Result} from '../../src/agent/r4-contracts';
import {adaptR4LegacyResult} from '../../src/agent/r4-legacy-adapter';
import {createR4WorkbenchService} from './r4-workbench';
import type {R4HostScope} from './r4-creative-host';
import type {R4WorkbenchRendererAction} from '../../src/agent/r4-workbench-contract';

const scope:R4HostScope={conversationId:'chat',creationId:'creation',userIntentRef:'change-settings',operationKey:'change-settings'};
function fixture(beforeApply?:()=>void){
  const save=vi.fn().mockResolvedValue({ok:true});
  vi.stubGlobal('window',{naiDesktop:{setSetting:save}});
  useAppStore.setState({bootDone:true,settings:{imageProvider:'novelai',modelMode:'anime',language:'zh-CN'} as AppSettings,
    params:{...DEFAULT_PARAMS,positivePrompt:'preserve the prompt',negativePrompt:'preserve exclusions'},
    charCaptions:[{id:'alice',name:'Alice',prompt:'alice',useCoords:true,x:.3,y:.5}],activeCanvasSurface:'generate:t2i'});
  const renderer=createStudioAgentService({getState:useAppStore.getState,setState:useAppStore.setState,api:{} as never,uuid:()=> 'parameters-draft'});
  const rendererRequest=vi.fn(async(action:R4WorkbenchRendererAction,args:Record<string,unknown>)=>{
    if(action==='r4-workbench-parameters')beforeApply?.();
    return renderer.handle({id:'fixture',action,args});
  });
  const host={store:{readR4State:()=>({executions:{}})}};
  const workbench=createR4WorkbenchService({window:()=>null,host:()=>host as never,rendererRequest});
  return {save,renderer,rendererRequest,workbench,
    read:()=>workbench.readR4WorkbenchSnapshot(),
    write:(patch:Record<string,unknown>,expectedDraftRevision:number)=>workbench.writeR4WorkbenchParameters({patch,expectedDraftRevision},scope)};
}

beforeEach(()=>useAppStore.setState(useAppStore.getInitialState(),true));
afterEach(()=>vi.unstubAllGlobals());
describe('R4 parameter writes on the real Generate store',()=>{
  it('atomically changes model, size, sampling, seed and count and persists once without changing prompts or roles',async()=>{
    const f=fixture(),before=await f.read(),observe=vi.fn(),unsubscribe=useAppStore.subscribe(observe);
    const patch={model:'nai-diffusion-4-5-full',width:1216,height:832,steps:32,cfgScale:5.5,cfgRescale:.25,
      sampler:'k_euler',noiseSchedule:'native',seed:42,batchCount:3,batchIntervalSeconds:2};
    try{
      const result=await f.write(patch,before.draftRevision);
      expect(validateR4Result('write_workbench_parameters',result).valid).toBe(true);
      expect(result).toMatchObject({data:{writeStatus:'written',parameters:{...patch,seedMode:'fixed'}}});
      expect(observe).toHaveBeenCalledTimes(1);expect(f.save).toHaveBeenCalledTimes(1);
      expect(f.save.mock.calls[0]).toMatchObject(['lastGenerationState',{params:{model:patch.model,seed:42,seedMode:'fixed'},batchCount:3,batchIntervalSeconds:2}]);
      const after=await f.read();expect(after.draftRevision).toBeGreaterThan(before.draftRevision);
      expect(after.params.positivePrompt).toBe(before.params.positivePrompt);expect(after.params.negativePrompt).toBe(before.params.negativePrompt);
      expect(after.workbench?.charCaptions).toEqual(before.workbench?.charCaptions);
      expect(await f.write(patch,after.draftRevision)).toMatchObject({data:{writeStatus:'unchanged',changedFields:[]}});
      expect(f.save).toHaveBeenCalledTimes(1);
    }finally{unsubscribe();}
  });
  it('leaves every field unchanged when any requested parameter is invalid',async()=>{
    const f=fixture(),before=await f.read();
    await expect(f.write({steps:35,width:1000,batchCount:4},before.draftRevision)).rejects.toThrow();
    expect(await f.read()).toEqual(before);expect(f.save).not.toHaveBeenCalled();
    const result=await f.renderer.handle({id:'bypass',action:'r4-workbench-parameters',args:{draftId:before.draftId,draftRevision:before.draftRevision,patch:{steps:35,positivePrompt:'forbidden'}}});
    expect(result.ok).toBe(false);expect(await f.read()).toEqual(before);
  });
  it('rejects stale revisions, including a manual change between main validation and renderer commit',async()=>{
    const f=fixture(()=>useAppStore.getState().setParam('steps',19)),before=await f.read();
    expect(await f.write({steps:35,seed:77},before.draftRevision)).toMatchObject({data:{writeStatus:'conflict',changedFields:[]}});
    expect(useAppStore.getState().params).toMatchObject({steps:19,seed:0,seedMode:'random'});
    expect(f.save).toHaveBeenCalledTimes(1);
    f.rendererRequest.mockClear();
    expect(await f.write({steps:40},before.draftRevision)).toMatchObject({data:{writeStatus:'conflict'}});
    expect(f.rendererRequest).toHaveBeenCalledTimes(1); // read only, no second write
  });
  it('treats a provider change as a CAS conflict and never writes an inactive provider draft',async()=>{
    const f=fixture(),before=await f.read();
    useAppStore.setState(state=>({settings:{...state.settings!,imageProvider:'openai-images'}}));
    expect(await f.write({steps:35},before.draftRevision)).toMatchObject({data:{writeStatus:'conflict'}});
    const current=await f.read();
    await expect(f.write({steps:35},current.draftRevision)).rejects.toThrow();
    expect(f.save).not.toHaveBeenCalled();
  });
  it('updates i2i strength and explicitly requested size together, retaining the source and mask',async()=>{
    const f=fixture();
    useAppStore.setState({activeCanvasSurface:'generate:i2i',i2iSizeMode:'adaptive',inpaintMask:'private-mask',
      workbenchImage:{filePath:'private-source.png',fileUrl:'nai-local://private',width:512,height:512} as any});
    const before=await f.read();
    expect(await f.write({strength:.6,width:1024,height:1024},before.draftRevision)).toMatchObject({data:{writeStatus:'written',parameters:{strength:.6,width:1024,height:1024,i2iSizeMode:'custom'}}});
    expect(f.save).toHaveBeenCalledTimes(1);
    expect(f.save.mock.calls[0][1]).toMatchObject({i2iSizeMode:'custom',i2iParams:{strength:.6},params:{width:1024,height:1024}});
    expect(useAppStore.getState().inpaintMask).toBe('private-mask');expect(useAppStore.getState().workbenchImage?.filePath).toBe('private-source.png');
  });
  it('exposes valid controls and actual medium effort values without leaking local assets',async()=>{
    const f=fixture();
    useAppStore.setState({params:{...useAppStore.getState().params,effort:'medium',width:3072,height:1024},
      workbenchImage:{filePath:'do-not-expose.png',fileUrl:'nai-local://secret',width:512,height:512} as any});
    const snapshot=await f.read();
    const {result}=await adaptR4LegacyResult('read_generation_state',{}, {ok:true,data:{imageProvider:'novelai'}},scope,{workbenchSnapshot:snapshot as any});
    expect(validateR4Result('read_generation_state',result).valid).toBe(true);
    expect(result).toMatchObject({data:{parameterControls:{writeSupported:true,effectiveParameters:{steps:14,sampler:'k_euler_ancestral',cfgRescale:0},limits:{maxAssistantGenerationCount:8}}}});
    expect(JSON.stringify(result)).not.toContain('do-not-expose');expect(JSON.stringify(result)).not.toContain('nai-local://secret');
  });
  it('does not write generation parameters into a separate inpaint or enhance canvas',async()=>{
    const f=fixture();
    for(const mode of ['inpaint','generate:enhance'] as const){
      useAppStore.setState({activeCanvasSurface:mode});const before=await f.read();
      await expect(f.write({model:'nai-diffusion-4-5-full',steps:30},before.draftRevision)).rejects.toThrow();
      expect(await f.read()).toEqual(before);
    }
    expect(f.save).not.toHaveBeenCalled();
  });
  it('returns a valid receipt after updating quality and overlapping imported sampling flags',async()=>{
    const f=fixture();
    useAppStore.setState({params:{...useAppStore.getState().params,metadataReplay:{model:DEFAULT_PARAMS.model,
      parameters:{quality_boost:true,straight_alpha:true,dynamic_thresholding:true,prefer_brownian:true},positive:{use_order:true}}}});
    const before=await f.read(),result=await f.write({qualityPreset:'none',transparentBackground:false,cfgRescale:.3},before.draftRevision);
    expect(validateR4Result('write_workbench_parameters',result).valid).toBe(true);
    expect(result).toMatchObject({data:{writeStatus:'written',parameters:{qualityPreset:'none',transparentBackground:false,cfgRescale:.3}}});
    expect(useAppStore.getState().params).toMatchObject({qualityToggle:false,metadataReplay:{parameters:{prefer_brownian:true},positive:{use_order:true}}});
    expect(useAppStore.getState().params.metadataReplay!.parameters).not.toHaveProperty('quality_boost');
    expect(useAppStore.getState().params.metadataReplay!.parameters).not.toHaveProperty('straight_alpha');
    expect(useAppStore.getState().params.metadataReplay!.parameters).not.toHaveProperty('dynamic_thresholding');
    expect(f.save).toHaveBeenCalledTimes(1);
  });
});

import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {DEFAULT_PARAMS,type MobileInpaintRequest} from './types';
import type {GatewayPlanPreview} from './gateway-workbench';
import type {MobilePixels} from './mobile-inpaint';

const fixture=vi.hoisted(()=>({
  app:null as any,
  mobile:null as any,
  execute:vi.fn(),
  process:vi.fn(),
  decode:vi.fn(),
  gateway:null as any,
  officialBridge:null as any,
}));

vi.mock('./store',()=>({
  useAppStore:Object.assign(vi.fn(),{
    getState:()=>fixture.app,
    setState:(patch:any)=>{
      const next=typeof patch==='function'?patch(fixture.app):patch;
      fixture.app={...fixture.app,...next};
    },
  }),
  executeMobileInpaintRequest:fixture.execute,
}));
vi.mock('./mobile-inpaint-store',()=>({
  useMobileInpaintStore:Object.assign(vi.fn(),{getState:()=>fixture.mobile}),
  pixelsToDataUrl:()=> 'data:image/png;base64,SYNTHETIC_PIXELS',
  decodeMobilePixels:fixture.decode,
}));
vi.mock('./mobile-inpaint-processing',()=>({processMobilePixels:fixture.process}));

import {runMobileInpaint,cancelMobileInpaint} from './MobileInpaintPanel';
import {createMobileGatewayRunner} from './mobile-inpaint-gateway-run';

function pixels(width=64,height=64,fill=255):MobilePixels {
  return {width,height,data:new Uint8ClampedArray(width*height*4).fill(fill)};
}
function deferred<T>() {
  let resolve!:(value:T)=>void;
  const promise=new Promise<T>(r=>resolve=r);
  return {promise,resolve};
}
function plan(planId:string):GatewayPlanPreview {
  return {
    planId,expiresAt:'2099-01-01T00:00:00.000Z',profileId:'synthetic-profile',profileName:'Synthetic Gateway',
    protocol:'ikun',endpoint:'http://127.0.0.1:8765/v1/images/generations',model:'nai-diffusion-5-full-inpainting',
    prompt:'synthetic positive',negativePrompt:'synthetic negative',width:64,height:64,steps:28,scale:5,cfgRescale:.2,
    sampler:'ddim_v3',noiseSchedule:'polyexponential',seed:4242,operation:'mobileInpaint',requestPayload:{image:'[redacted]',mask:'[redacted]'},
  };
}
function request():MobileInpaintRequest {
  return {
    params:{...DEFAULT_PARAMS,width:64,height:64,positivePrompt:'synthetic positive',negativePrompt:'synthetic negative'},
    model:'nai-diffusion-5-full-inpainting',imageBase64:'SYNTHETIC_IMAGE',maskBase64:'SYNTHETIC_MASK',
    strength:.96,noise:0,ignoreSource:false,colorCorrection:true,
    sampling:{sampler:'ddim_v3',noiseSchedule:'polyexponential'},
    expectedAccountId:'synthetic-official-account',expectedAccountRevision:'synthetic-official-revision',
  };
}

beforeEach(()=>{
  vi.clearAllMocks();
  fixture.gateway={
    prepareMobileInpaint:vi.fn().mockResolvedValue(plan('synthetic-plan')),
    generate:vi.fn().mockResolvedValue({status:'succeeded',message:'Synthetic gateway success',items:[]}),
    cancel:vi.fn().mockResolvedValue({accepted:true,message:'Synthetic cancel'}),
  };
  fixture.officialBridge={
    hasToken:vi.fn(),getSettings:vi.fn(),mobileInpaint:vi.fn(),cancel:vi.fn(),
  };
  fixture.app={
    isGenerating:false,activeGenerationRunId:null,generationPhase:'idle',statusText:'ready',toast:'',lastError:'',
    currentAnlasSpent:null,lastAnlasSpent:null,batchCount:3,inpaintModel:'nai-diffusion-5-full-inpainting',
    params:{...DEFAULT_PARAMS,width:64,height:64,steps:28},
    refreshHistory:vi.fn().mockResolvedValue(undefined),
    cancel:vi.fn(async()=>{
      fixture.app={...fixture.app,isGenerating:false,activeGenerationRunId:null,generationPhase:'idle',statusText:'cancelled'};
    }),
  };
  fixture.mobile={
    pixels:pixels(16,16),frame:{x:0,y:0,width:16,height:16},transform:{scale:1,offsetX:0,offsetY:0},
    output:{width:64,height:64},strokes:[],layers:[],prompt:'synthetic workspace positive',negative:'synthetic workspace negative',
    strength:.96,expand:0,outwardFeather:0,ignoreSource:false,colorCorrection:true,busy:false,error:'',
    update:(patch:any)=>{fixture.mobile={...fixture.mobile,...patch};},setCandidates:vi.fn(),
  };
  fixture.execute.mockResolvedValue({ok:true,message:'Synthetic official path should not run',items:[]});
  fixture.process.mockImplementation(async(input:any)=>input.kind==='prepare'
    ? {image:pixels(),mask:pixels(),before:pixels()}
    : {image:input.generated,comparison:input.generated});
  fixture.decode.mockResolvedValue(pixels());
  vi.stubGlobal('window',{worldpainter:{gateway:fixture.gateway},naiDesktop:fixture.officialBridge});
});
afterEach(()=>vi.unstubAllGlobals());

describe('mobile inpaint gateway run lifecycle (all gateway calls explicitly mocked)',()=>{
  it('cancels while prepare is pending, cancels the late plan without submitting, and preserves a newer run identity',async()=>{
    const pending=deferred<GatewayPlanPreview>();
    fixture.gateway.prepareMobileInpaint.mockReturnValue(pending.promise);
    const confirm=vi.fn().mockResolvedValue(true);
    const runner=createMobileGatewayRunner('synthetic-profile',3,confirm);
    const running=runner.run(request());
    const oldRunId=fixture.app.activeGenerationRunId;
    await runner.cancel();
    expect(fixture.app).toMatchObject({isGenerating:false,activeGenerationRunId:null,generationPhase:'idle'});
    fixture.app={...fixture.app,isGenerating:true,activeGenerationRunId:'synthetic-new-run',generationPhase:'requesting',statusText:'new run marker',lastError:'new run error'};
    pending.resolve(plan('late-plan'));
    expect(await running).toBeNull();
    expect(fixture.gateway.cancel).toHaveBeenCalledWith('late-plan');
    expect(fixture.gateway.generate).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(fixture.app).toMatchObject({isGenerating:true,activeGenerationRunId:'synthetic-new-run',generationPhase:'requesting',statusText:'new run marker',lastError:'new run error'});
    expect(oldRunId).not.toBe('synthetic-new-run');
  });

  it('does not use the global official cancel bridge when stopping a gateway run',async()=>{
    const pending=deferred<GatewayPlanPreview>();
    fixture.gateway.prepareMobileInpaint.mockReturnValue(pending.promise);
    fixture.app.cancel=vi.fn(async()=>{await fixture.officialBridge.cancel();});
    const running=runMobileInpaint({gatewayProfileId:'synthetic-profile',confirmGatewayBatch:vi.fn().mockResolvedValue(true)});
    await vi.waitFor(()=>expect(fixture.gateway.prepareMobileInpaint).toHaveBeenCalledOnce());
    cancelMobileInpaint();
    expect(fixture.app.cancel).not.toHaveBeenCalled();
    expect(fixture.officialBridge.cancel).not.toHaveBeenCalled();
    pending.resolve(plan('cancelled-late-plan'));
    await running;
    expect(fixture.gateway.cancel).toHaveBeenCalledWith('cancelled-late-plan');
    expect(fixture.gateway.generate).not.toHaveBeenCalled();
  });

  it('cancels a prepared plan when the one batch confirmation is declined',async()=>{
    const confirm=vi.fn().mockResolvedValue(false);
    const runner=createMobileGatewayRunner('synthetic-profile',3,confirm);
    expect(await runner.run(request())).toBeNull();
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({planId:'synthetic-plan'}),3,expect.any(AbortSignal));
    expect(fixture.gateway.cancel).toHaveBeenCalledWith('synthetic-plan');
    expect(fixture.gateway.generate).not.toHaveBeenCalled();
    expect(fixture.app).toMatchObject({isGenerating:false,activeGenerationRunId:null,generationPhase:'idle'});
  });

  it('confirms exactly once and submits each batch image serially',async()=>{
    const order:string[]=[];
    let nextPlan=0;
    fixture.gateway.prepareMobileInpaint.mockImplementation(async()=>{order.push('prepare');return plan(`batch-${++nextPlan}`);});
    fixture.gateway.generate.mockImplementation(async({planId}:any)=>{order.push(`generate:${planId}`);return {status:'succeeded',message:'synthetic success',items:[]};});
    const confirm=vi.fn(async()=>{order.push('confirm');return true;});
    const runner=createMobileGatewayRunner('synthetic-profile',3,confirm);
    for(let index=0;index<3;index++)expect((await runner.run(request()))?.ok).toBe(true);
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({planId:'batch-1'}),3,expect.any(AbortSignal));
    expect(order).toEqual(['prepare','confirm','generate:batch-1','prepare','generate:batch-2','prepare','generate:batch-3']);
    expect(fixture.gateway.generate).toHaveBeenCalledTimes(3);
  });

  it('stops the paid batch after one uncertain result and never calls the official token/account path',async()=>{
    fixture.gateway.generate.mockResolvedValue({status:'uncertain',message:'synthetic result uncertain; inspect gateway history',items:[]});
    fixture.officialBridge.hasToken.mockResolvedValue(true);
    fixture.officialBridge.getSettings.mockResolvedValue({naiAccountId:'must-not-read'});
    fixture.app.settings={naiAccountId:'synthetic-official-account',naiAccountRevision:'synthetic-official-revision'};
    const confirm=vi.fn().mockResolvedValue(true);
    await runMobileInpaint({gatewayProfileId:'synthetic-profile',sampling:{sampler:'ddim_v3',noiseSchedule:'polyexponential'},confirmGatewayBatch:confirm});
    expect(confirm).toHaveBeenCalledOnce();
    expect(fixture.gateway.prepareMobileInpaint).toHaveBeenCalledOnce();
    expect(fixture.gateway.generate).toHaveBeenCalledOnce();
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(fixture.officialBridge.hasToken).not.toHaveBeenCalled();
    expect(fixture.officialBridge.getSettings).not.toHaveBeenCalled();
    expect(fixture.officialBridge.mobileInpaint).not.toHaveBeenCalled();
    expect(fixture.mobile.error).toContain('synthetic result uncertain');
  });

  it('keeps the selected mobile sampling snapshot when shared generation parameters change during prepare',async()=>{
    const pending=deferred<GatewayPlanPreview>();
    fixture.gateway.prepareMobileInpaint.mockReturnValue(pending.promise);
    const sampling={sampler:'ddim_v3',noiseSchedule:'polyexponential'};
    const confirmed=vi.fn().mockResolvedValue(true);
    const running=runMobileInpaint({gatewayProfileId:'synthetic-profile',sampling,confirmGatewayBatch:confirmed});
    await vi.waitFor(()=>expect(fixture.gateway.prepareMobileInpaint).toHaveBeenCalledOnce());
    const submitted=structuredClone(fixture.gateway.prepareMobileInpaint.mock.calls[0][0]);
    fixture.app.params={...fixture.app.params,sampler:'k_euler',noiseSchedule:'karras',cfgScale:9};
    fixture.mobile={...fixture.mobile,prompt:'later editor prompt'};
    pending.resolve(plan('snapshot-plan'));
    await running;
    expect(submitted.request).toMatchObject({
      sampling:{sampler:'ddim_v3',noiseSchedule:'polyexponential'},
      params:{positivePrompt:'synthetic workspace positive',cfgScale:DEFAULT_PARAMS.cfgScale},
    });
    expect(fixture.gateway.generate).toHaveBeenCalledWith({planId:'snapshot-plan',confirmed:true});
    expect(confirmed).toHaveBeenCalledOnce();
  });
});

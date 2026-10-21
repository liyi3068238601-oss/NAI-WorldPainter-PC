import {beforeEach,describe,expect,it,vi} from 'vitest';
import {PNG} from 'pngjs';
import {DEFAULT_PARAMS} from './types';
import type {MobilePixels} from './mobile-inpaint';

const fixture=vi.hoisted(()=>({mobile:null as any,app:null as any,execute:vi.fn(),decode:vi.fn(),candidates:vi.fn()}));
vi.mock('./store',()=>({
  useAppStore:Object.assign(vi.fn(),{getState:()=>fixture.app}),
  executeMobileInpaintRequest:fixture.execute,
}));
vi.mock('./mobile-inpaint-store',async()=>{
  const {PNG:Codec}=await import('pngjs');
  return {
    useMobileInpaintStore:Object.assign(vi.fn(),{getState:()=>fixture.mobile}),
    pixelsToDataUrl:(image:MobilePixels)=>`data:image/png;base64,${Codec.sync.write({width:image.width,height:image.height,data:Buffer.from(image.data)} as PNG).toString('base64')}`,
    decodeMobilePixels:fixture.decode,
  };
});
import {runMobileInpaint,cancelMobileInpaint} from './MobileInpaintPanel';

function pixels(width=16,height=16,color=[20,180,40,255]):MobilePixels {
  const data=new Uint8ClampedArray(width*height*4);
  for(let i=0;i<data.length;i+=4)data.set(color,i);
  return {width,height,data};
}
function png(base64:string){return PNG.sync.read(Buffer.from(base64,'base64'));}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}
const success={ok:true,message:'Explicit synthetic mock result',items:[{id:'synthetic-result',fileUrl:'data:image/png;base64,MOCK',actualSeed:4242}]};

beforeEach(()=>{
  vi.clearAllMocks();
  fixture.mobile={
    pixels:pixels(),frame:{x:-8,y:0,width:16,height:16},transform:{scale:1,offsetX:0,offsetY:0},
    output:{width:64,height:64},strokes:[],layers:[],prompt:'synthetic mobile, {red shape}',negative:'synthetic mobile negative',
    strength:.96,expand:0,outwardFeather:0,ignoreSource:false,colorCorrection:true,busy:false,error:'',
    update:(patch:any)=>{fixture.mobile={...fixture.mobile,...patch};},setCandidates:fixture.candidates,
  };
  fixture.app={isGenerating:false,batchCount:1,cancel:vi.fn(),inpaintModel:'nai-diffusion-5-full-inpainting',
    params:{...DEFAULT_PARAMS,positivePrompt:'MAIN POSITIVE',negativePrompt:'MAIN NEGATIVE',stylePrompt:'MAIN STYLE',seedMode:'fixed',seed:12345,metadataReplay:{synthetic:'MAIN REPLAY'}},
    charCaptions:[{prompt:'MAIN CHARACTER'}],vibeImages:[{base64:'MAIN VIBE'}],preciseReferences:[{base64:'MAIN PRECISE'}],
  };
  fixture.execute.mockResolvedValue(success);
  fixture.decode.mockResolvedValue(pixels(64,64,[240,60,30,255]));
});

describe('mobile inpaint request lifecycle (all generation is mocked)',()=>{
  it.each([
    ['nai-diffusion-5-full-inpainting',50,28],
    ['nai-diffusion-5-curated-inpainting',50,28],
    ['nai-diffusion-5-full-inpainting',20,20],
    ['nai-diffusion-4-5-full-inpainting',50,50],
    ['nai-diffusion-4-full-inpainting',99,50],
    ['nai-diffusion-3-inpainting',50,50],
  ])('freezes %s steps at its mobile limit without mutating shared parameters',async(model,steps,expected)=>{
    fixture.app.inpaintModel=model;
    fixture.app.params.steps=steps;
    await runMobileInpaint();
    expect(fixture.execute).toHaveBeenCalledTimes(1);
    expect(fixture.execute.mock.calls[0][0].params.steps).toBe(expected);
    expect(fixture.app.params.steps).toBe(steps);
  });

  it('uses the independent prompts and random seed, without main style/characters/references',async()=>{
    const before={...fixture.app.params};
    await runMobileInpaint();
    expect(fixture.execute).toHaveBeenCalledTimes(1);
    const request=fixture.execute.mock.calls[0][0];
    expect(request.params).toMatchObject({positivePrompt:'synthetic mobile, {red shape}',negativePrompt:'synthetic mobile negative',stylePrompt:'',seedMode:'random',seed:0,width:64,height:64,qualityToggle:false,qualityPreset:'none',ucPreset:3,variety:false,transparentBackground:false,preservePromptText:true,smea:false,smeaDyn:false});
    expect(request.params.metadataReplay).toBeUndefined();
    expect(request).not.toHaveProperty('extras');
    expect(request).not.toHaveProperty('charCaptions');
    expect(request).not.toHaveProperty('vibeImages');
    expect(request).not.toHaveProperty('preciseReferences');
    expect(fixture.app.params).toEqual(before);
    expect(fixture.candidates).toHaveBeenCalledTimes(1);
    expect(fixture.candidates.mock.calls[0][0][0]).toMatchObject({id:'synthetic-result',seed:4242,worldRect:{x:-8,y:0,width:16,height:16}});
  });

  it('keeps an unbounded frame and marks its transparent outside pixels for generation',async()=>{
    await runMobileInpaint();
    const request=fixture.execute.mock.calls[0][0],image=png(request.imageBase64),mask=png(request.maskBase64);
    expect([image.width,image.height,mask.width,mask.height]).toEqual([64,64,64,64]);
    // Left half of the frame is outside the original source; the right half samples it.
    expect([...image.data.subarray(0,4)]).toEqual([0,0,0,0]);
    expect([...mask.data.subarray(0,4)]).toEqual([255,255,255,255]);
    const inside=(32*64+48)*4;
    expect([...image.data.subarray(inside,inside+4)]).toEqual([20,180,40,255]);
    expect(mask.data[inside]).toBe(0);
  });

  it('includes image strokes in request pixels, while visible result layers only affect the before comparison',async()=>{
    fixture.mobile.strokes=[{target:'image',mode:'paint',points:[{x:4,y:8},{x:8,y:8}],size:4,color:0xffff0000,opacity:1}];
    fixture.mobile.layers=[{image:pixels(16,16,[0,0,255,255]),worldRect:{x:0,y:0,width:16,height:16},visible:true}];
    await runMobileInpaint();
    const request=fixture.execute.mock.calls[0][0],image=png(request.imageBase64);
    const colors=[];
    for(let i=0;i<image.data.length;i+=4)if(image.data[i+3])colors.push([...image.data.subarray(i,i+4)]);
    expect(colors.some(color=>color[0]>180&&color[1]<80&&color[2]<80)).toBe(true);
    expect(colors.some(color=>color[2]>180&&color[0]<80)).toBe(false);
    const candidate=fixture.candidates.mock.calls[0][0][0];
    const comparison=png(candidate.beforeUrl.split(',')[1]);
    const comparisonColors=[];
    for(let i=0;i<comparison.data.length;i+=4)if(comparison.data[i+3])comparisonColors.push([...comparison.data.subarray(i,i+4)]);
    expect(comparisonColors.some(color=>color[2]>180&&color[0]<80)).toBe(true);
    expect(fixture.mobile.layers).toHaveLength(1);
  });

  it('freezes submitted dimensions/prompts across asynchronous edits',async()=>{
    const pending=deferred<typeof success>();fixture.execute.mockReturnValue(pending.promise);
    const running=runMobileInpaint();
    fixture.mobile={...fixture.mobile,output:{width:128,height:64},prompt:'later prompt',negative:'later negative',frame:{x:100,y:100,width:32,height:16}};
    fixture.app.params={...fixture.app.params,seed:9876};
    pending.resolve(success);await running;
    const request=fixture.execute.mock.calls[0][0];
    expect(request.params).toMatchObject({width:64,height:64,positivePrompt:'synthetic mobile, {red shape}',negativePrompt:'synthetic mobile negative'});
    expect(fixture.candidates.mock.calls[0][0][0].worldRect).toEqual({x:-8,y:0,width:16,height:16});
  });

  it('keeps a late result out of a replacement source workspace',async()=>{
    const pending=deferred<typeof success>();fixture.execute.mockReturnValue(pending.promise);
    const running=runMobileInpaint();
    fixture.mobile={...fixture.mobile,pixels:pixels(32,32)};
    pending.resolve(success);await running;
    expect(fixture.candidates).not.toHaveBeenCalled();
    expect(fixture.mobile.error).toContain('源图已变化');
    expect(fixture.mobile.busy).toBe(false);
  });

  it('rejects wrong-size results and never retries a failed or uncertain request',async()=>{
    fixture.decode.mockResolvedValue(pixels(128,64));
    await runMobileInpaint();
    expect(fixture.execute).toHaveBeenCalledTimes(1);
    expect(fixture.candidates).not.toHaveBeenCalled();
    expect(fixture.mobile.error).toContain('尺寸');
    fixture.execute.mockClear();fixture.execute.mockRejectedValue(Error('synthetic timeout: result unknown'));
    await runMobileInpaint();
    expect(fixture.execute).toHaveBeenCalledTimes(1);
    expect(fixture.mobile.error).toContain('synthetic timeout');
    expect(fixture.mobile.busy).toBe(false);
  });

  it('does not submit an empty in-bounds mask, a duplicate run, or a request without source pixels',async()=>{
    fixture.mobile.frame={x:0,y:0,width:16,height:16};
    await runMobileInpaint();
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(fixture.mobile.error).toContain('没有需要重绘');
    fixture.mobile.busy=true;await runMobileInpaint();
    fixture.mobile={...fixture.mobile,busy:false,pixels:null};await runMobileInpaint();
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it('freezes batch count and appends independent candidates in the same batch',async()=>{
    fixture.app.batchCount=2;
    const pending=deferred<typeof success>();fixture.execute.mockReturnValueOnce(pending.promise).mockResolvedValueOnce({...success,items:[{...success.items[0],id:'synthetic-result-2'}]});
    const running=runMobileInpaint();fixture.app={...fixture.app,batchCount:9};
    pending.resolve(success);await running;
    expect(fixture.execute).toHaveBeenCalledTimes(2);
    const candidates=fixture.candidates.mock.calls.at(-1)![0];
    expect(candidates).toHaveLength(2);
    expect(candidates[0].batchId).toBe(candidates[1].batchId);
  });

  it('cancels a pending batch without applying a late result or starting another request',async()=>{
    fixture.app.batchCount=3;
    const pending=deferred<typeof success>();fixture.execute.mockReturnValue(pending.promise);
    const running=runMobileInpaint();
    await vi.waitFor(()=>expect(fixture.execute).toHaveBeenCalledTimes(1));
    cancelMobileInpaint();
    expect(fixture.app.cancel).toHaveBeenCalledTimes(1);
    pending.resolve(success);await running;
    expect(fixture.execute).toHaveBeenCalledTimes(1);
    expect(fixture.candidates).not.toHaveBeenCalled();
    expect(fixture.mobile.busy).toBe(false);
  });

  it('cancels during asynchronous pixel preparation before any model request starts',async()=>{
    fixture.app.batchCount=3;
    const running=runMobileInpaint();cancelMobileInpaint();
    await running;
    expect(fixture.app.cancel).toHaveBeenCalledTimes(1);
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(fixture.candidates).not.toHaveBeenCalled();
    expect(fixture.mobile.busy).toBe(false);
  });
});

import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {useMobileInpaintStore as store} from './mobile-inpaint-store';
import type {MobilePixels,MobileStroke} from './mobile-inpaint';

const pixels:MobilePixels={width:2,height:2,data:new Uint8ClampedArray(16).fill(255)};
const stroke:MobileStroke={target:'mask',mode:'paint',size:4,points:[{x:1,y:1}]};
function seedDraft(sourcePixels=pixels){
  const worldRect={x:-2,y:1,width:2,height:2};
  store.setState({
    mode:'mobile',source:{filePath:'synthetic-original.png',fileUrl:'data:image/png;base64,SYNTHETIC_ORIGINAL',width:sourcePixels.width,height:sourcePixels.height},
    pixels:sourcePixels,frame:{x:-100,y:70,width:180,height:240},transform:{scale:.5,offsetX:15,offsetY:-20},
    strokes:[stroke],layers:[{id:'synthetic-layer',batchId:'synthetic-batch',name:'synthetic layer',image:pixels,worldRect,visible:true,dataUrl:'data:image/png;base64,SYNTHETIC_LAYER'}],
    candidates:[{id:'synthetic-candidate',batchId:'synthetic-batch',image:pixels,worldRect,dataUrl:'data:image/png;base64,SYNTHETIC_CANDIDATE'}],
    selectedCandidateId:'synthetic-candidate',reviewOpen:true,undoStack:[[]],redoStack:[[stroke]],maskUndoStack:[[]],maskRedoStack:[[stroke]],
  });
  return store.getState();
}
function expectDraftPreserved(before:ReturnType<typeof store.getState>){
  const after=store.getState();
  for(const key of ['source','pixels','frame','transform','strokes','layers','candidates','undoStack','redoStack','maskUndoStack','maskRedoStack'] as const)expect(after[key]).toBe(before[key]);
  expect(after.selectedCandidateId).toBe(before.selectedCandidateId);
  expect(after.reviewOpen).toBe(true);
  expect(after.busy).toBe(false);
  expect(after.error).toContain('32 MP');
}
beforeEach(()=>store.setState(store.getInitialState(),true));
afterEach(()=>{store.setState(store.getInitialState(),true);vi.unstubAllGlobals();});

describe('mobile source-size rejection preserves the existing draft',()=>{
  it('rejects decoded source dimensions above 32 MP before allocating a canvas or replacing the draft',async()=>{
    const before=seedDraft(),decode=vi.fn().mockResolvedValue(undefined),allocate=vi.fn(()=>{throw Error('No canvas may be allocated for an oversized decoded source');});
    class OversizedSyntheticImage {naturalWidth=8192;naturalHeight=8192;crossOrigin='';src='';decode=decode;}
    vi.stubGlobal('Image',OversizedSyntheticImage);vi.stubGlobal('document',{createElement:allocate});
    await store.getState().importSource({filePath:'synthetic-oversized.png',fileUrl:'data:image/png;base64,SYNTHETIC_OVERSIZED',width:2,height:2});
    expect(decode).toHaveBeenCalledOnce();
    expect(allocate).not.toHaveBeenCalled();
    expectDraftPreserved(before);
  });

  it.each([2,3] as const)('rejects a %sx magnification above 32 MP without touching pixels, canvas, or current edit history',async factor=>{
    // A metadata-only sentinel makes pixel access fail: the size guard must run first.
    const descriptor:MobilePixels={width:4096,height:4096,get data():Uint8ClampedArray{throw Error('Oversized scaling must reject before pixel access');}};
    const before=seedDraft(descriptor),allocate=vi.fn(()=>{throw Error('Oversized scaling must reject before canvas allocation');});
    vi.stubGlobal('document',{createElement:allocate});
    await store.getState().scaleImage(factor);
    expect(allocate).not.toHaveBeenCalled();
    expectDraftPreserved(before);
  });
});

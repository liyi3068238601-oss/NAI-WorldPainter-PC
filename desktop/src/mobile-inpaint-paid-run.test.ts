import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {executeMobileInpaintRequest,registerMobileGatewayCancellation,useAppStore} from './store';
import {DEFAULT_PARAMS,type MobileInpaintRequest} from './types';

const syntheticAccount={hasToken:true,accountId:'synthetic-account',anlasBalance:100};
const sufficientQuote={ok:true,amount:1,balance:100,insufficient:false};
const result={ok:true,message:'Synthetic mocked mobile result',items:[]};
let desktop:any;
const request=(stamp:Partial<MobileInpaintRequest>={}):MobileInpaintRequest=>({
  params:{...DEFAULT_PARAMS,width:64,height:64,positivePrompt:'synthetic fixture only',seedMode:'random'},
  model:'nai-diffusion-5-full-inpainting',imageBase64:'SYNTHETIC_IMAGE',maskBase64:'SYNTHETIC_MASK',
  strength:.96,noise:0,ignoreSource:false,colorCorrection:true,...stamp,
});
function deferred<T>(){let resolve!:(value:T)=>void;let reject!:(error:Error)=>void;const promise=new Promise<T>((res,rej)=>{resolve=res;reject=rej;});return {promise,resolve,reject};}
function replaceWithNewRun(){useAppStore.setState({isGenerating:true,activeGenerationRunId:'synthetic-new-run',generationPhase:'requesting',statusText:'synthetic newer run remains active',lastError:'newer marker'});}
function expectNewRunUntouched(){expect(useAppStore.getState()).toMatchObject({isGenerating:true,activeGenerationRunId:'synthetic-new-run',generationPhase:'requesting',statusText:'synthetic newer run remains active',lastError:'newer marker'});}

beforeEach(()=>{
  useAppStore.setState(useAppStore.getInitialState(),true);
  desktop={hasToken:vi.fn().mockResolvedValue({...syntheticAccount}),quoteAnlas:vi.fn().mockResolvedValue({...sufficientQuote}),mobileInpaint:vi.fn().mockResolvedValue(result),cancel:vi.fn().mockResolvedValue({ok:true})};
  vi.stubGlobal('window',{naiDesktop:desktop});
  useAppStore.setState({account:{...syntheticAccount},settings:{language:'zh-CN',naiAccountId:'synthetic-account',naiAccountRevision:'synthetic-revision'} as any});
});
afterEach(()=>{useAppStore.setState(useAppStore.getInitialState(),true);vi.unstubAllGlobals();});

describe('real mobile paid-run helper with an explicitly mocked desktop bridge',()=>{
  it('routes global Stop to its active gateway transport and leaves unrelated runs on the official path',async()=>{
    const cancelGateway=vi.fn().mockResolvedValue(undefined);
    const unregister=registerMobileGatewayCancellation('synthetic-gateway-batch',cancelGateway);
    try{
      useAppStore.setState({isGenerating:true,activeGenerationRunId:'synthetic-gateway-batch'});
      await useAppStore.getState().cancel();
      expect(cancelGateway).toHaveBeenCalledOnce();
      expect(desktop.cancel).not.toHaveBeenCalled();
      replaceWithNewRun();
      await useAppStore.getState().cancel();
      expect(cancelGateway).toHaveBeenCalledOnce();
      expect(desktop.cancel).toHaveBeenCalledOnce();
    }finally{unregister();}
  });

  it('keeps one official batch reservation between images and prevents other generation from taking it',async()=>{
    const batchRunId='synthetic-official-batch';
    useAppStore.setState({isGenerating:true,activeGenerationRunId:batchRunId,generationPhase:'preparing'});
    expect((await executeMobileInpaintRequest(request(),batchRunId))?.ok).toBe(true);
    expect(useAppStore.getState()).toMatchObject({isGenerating:true,activeGenerationRunId:batchRunId,generationPhase:'preparing'});
    expect(await executeMobileInpaintRequest(request())).toBeNull();
    expect((await executeMobileInpaintRequest(request(),batchRunId))?.ok).toBe(true);
    expect(desktop.mobileInpaint).toHaveBeenCalledTimes(2);
  });

  it('never reacquires a cancelled or replaced batch reservation',async()=>{
    const batchRunId='synthetic-old-batch';
    expect(await executeMobileInpaintRequest(request(),batchRunId)).toBeNull();
    replaceWithNewRun();
    expect(await executeMobileInpaintRequest(request(),batchRunId)).toBeNull();
    expect(desktop.quoteAnlas).not.toHaveBeenCalled();
    expect(desktop.mobileInpaint).not.toHaveBeenCalled();
    expectNewRunUntouched();
  });

  it('does not submit a generation when the quote reports insufficient balance',async()=>{
    desktop.quoteAnlas.mockResolvedValue({...sufficientQuote,amount:101,insufficient:true});
    expect(await executeMobileInpaintRequest(request())).toBeNull();
    expect(desktop.quoteAnlas).toHaveBeenCalledOnce();
    expect(desktop.mobileInpaint).not.toHaveBeenCalled();
    expect(useAppStore.getState()).toMatchObject({isGenerating:false,activeGenerationRunId:null,generationPhase:'idle'});
  });

  it('cancels during quote preparation without submitting or clearing a subsequent run',async()=>{
    const quote=deferred<typeof sufficientQuote>();desktop.quoteAnlas.mockReturnValue(quote.promise);
    const running=executeMobileInpaintRequest(request());
    await vi.waitFor(()=>expect(desktop.quoteAnlas).toHaveBeenCalledOnce());
    await useAppStore.getState().cancel();
    replaceWithNewRun();quote.resolve(sufficientQuote);
    expect(await running).toBeNull();
    expect(desktop.mobileInpaint).not.toHaveBeenCalled();
    expectNewRunUntouched();
  });

  it('ignores a late successful quote after the active run identity changes',async()=>{
    const quote=deferred<typeof sufficientQuote>();desktop.quoteAnlas.mockReturnValue(quote.promise);
    const running=executeMobileInpaintRequest(request());
    await vi.waitFor(()=>expect(desktop.quoteAnlas).toHaveBeenCalledOnce());
    replaceWithNewRun();quote.resolve(sufficientQuote);
    expect(await running).toBeNull();
    expect(desktop.mobileInpaint).not.toHaveBeenCalled();
    expectNewRunUntouched();
  });

  it('ignores a late quote failure after the active run identity changes',async()=>{
    const quote=deferred<typeof sufficientQuote>();desktop.quoteAnlas.mockReturnValue(quote.promise);
    const running=executeMobileInpaintRequest(request());
    await vi.waitFor(()=>expect(desktop.quoteAnlas).toHaveBeenCalledOnce());
    replaceWithNewRun();quote.reject(Error('synthetic quote failure'));
    expect(await running).toBeNull();
    expect(desktop.mobileInpaint).not.toHaveBeenCalled();
    expectNewRunUntouched();
  });

  it.each([
    ['explicit frozen request',{expectedAccountId:'explicit-synthetic-account',expectedAccountRevision:'explicit-synthetic-revision'},'explicit-synthetic-account','explicit-synthetic-revision'],
    ['initial runtime settings',{},'synthetic-account','synthetic-revision'],
  ] as const)('preserves the account stamp from %s through asynchronous preflight',async(_label,stamp,expectedAccountId,expectedAccountRevision)=>{
    const quote=deferred<typeof sufficientQuote>();desktop.quoteAnlas.mockReturnValue(quote.promise);
    const input=request(stamp),before=structuredClone(input),running=executeMobileInpaintRequest(input);
    await vi.waitFor(()=>expect(desktop.quoteAnlas).toHaveBeenCalledOnce());
    useAppStore.setState({settings:{language:'zh-CN',naiAccountId:'later-synthetic-account',naiAccountRevision:'later-synthetic-revision'} as any});
    quote.resolve(sufficientQuote);await running;
    expect(desktop.mobileInpaint).toHaveBeenCalledOnce();
    expect(desktop.mobileInpaint.mock.calls[0][0]).toMatchObject({expectedAccountId,expectedAccountRevision,params:before.params,imageBase64:'SYNTHETIC_IMAGE',maskBase64:'SYNTHETIC_MASK'});
    expect(input).toEqual(before);
  });
});

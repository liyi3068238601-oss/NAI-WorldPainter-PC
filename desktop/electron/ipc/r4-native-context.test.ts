import { describe, expect, it } from 'vitest';
import { checkR4NativeSubmission, currentR4NativeExecution, mapR4NativeInputs, r4NativeSourcePath, withR4NativeExecution, withR4NativeHttpReceipt } from './r4-native-context';

describe('R4 native execution ownership', () => {
  it('keeps explicit sources isolated across concurrent asynchronous callers', async () => {
    const seen: string[] = [];
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const first = withR4NativeExecution({sourcePath:'source-a.png',beforeSubmit:kind=>{seen.push(`a:${kind}`);}}, async () => {
      await barrier;
      expect(currentR4NativeExecution()?.sourcePath).toBe('source-a.png');
      await checkR4NativeSubmission('vibe_encode');
    });
    await withR4NativeExecution({sourcePath:'source-b.png',beforeSubmit:kind=>{seen.push(`b:${kind}`);}}, async () => {
      expect(currentR4NativeExecution()?.sourcePath).toBe('source-b.png');
      await checkR4NativeSubmission();
      release();
    });
    await first;
    expect(seen).toEqual(['b:image','a:vibe_encode']);
    expect(currentR4NativeExecution()).toBeUndefined();
  });

  it('checks cancellation on both sides of the durable pre-submit gate', async () => {
    const controller = new AbortController();
    let calls = 0;
    await expect(withR4NativeExecution({signal:controller.signal,beforeSubmit:()=>{calls++;controller.abort();}},
      () => checkR4NativeSubmission())).rejects.toThrow();
    expect(calls).toBe(1);
    expect(() => withR4NativeExecution({signal:controller.signal,beforeSubmit:()=>{calls++;}},async()=>{})).toThrow();
    expect(calls).toBe(1);
  });

  it('does not install a source or permission in ordinary workbench calls', async () => {
    await checkR4NativeSubmission();
    expect(currentR4NativeExecution()).toBeUndefined();
    expect(r4NativeSourcePath('workbench.png')).toBe('workbench.png');
    await withR4NativeExecution({beforeSubmit:()=>{}},async()=>{
      expect(r4NativeSourcePath('workbench.png')).toBeUndefined();
    });
  });

  it('records a successful receipt before a subsequent local processing failure',async()=>{
    const receipt:string[]=[];
    await expect(withR4NativeExecution({beforeSubmit:()=>{},afterReceipt:(kind,result)=>{receipt.push(`${kind}:${result.status}`);}},async()=>{
      await withR4NativeHttpReceipt('image',async()=>({status:200,data:'original result'}));
      throw Error('disk full');
    })).rejects.toThrow('disk full');
    expect(receipt).toEqual(['image:confirmed']);
  });

  it('keeps server errors uncertain and does not start later paid encodings after a failure',async()=>{
    const started:number[]=[],receipts:string[]=[];
    await expect(withR4NativeExecution({beforeSubmit:()=>{},afterReceipt:(_kind,result)=>{receipts.push(result.status);}},()=>
      mapR4NativeInputs([1,2,3],async index=>{
        started.push(index);
        await checkR4NativeSubmission('vibe_encode');
        return withR4NativeHttpReceipt('vibe_encode',async()=>{
          if(index===2)throw Object.assign(Error('gateway failed'),{response:{status:502}});
          return {status:200};
        });
      }))).rejects.toThrow('gateway failed');
    expect(started).toEqual([1,2]);expect(receipts).toEqual(['confirmed','unknown']);
  });
});

import { AsyncLocalStorage } from 'node:async_hooks';
import type { R4ProviderReceipt } from '../../src/agent/r4-types';

export type R4NativeRequestKind = 'image' | 'vibe_encode' | 'upscale';

/** Host-owned scope. Never constructed from model arguments or renderer JSON. */
export interface R4NativeExecutionContext {
  sourcePath?: string;
  signal?: AbortSignal;
  beforeSubmit: (kind: R4NativeRequestKind) => void | Promise<void>;
  afterReceipt?: (kind: R4NativeRequestKind,receipt:R4ProviderReceipt) => void | Promise<void>;
}

const contexts = new AsyncLocalStorage<Readonly<R4NativeExecutionContext>>();

/** Keep existing image backends while isolating the source and durable send gate. */
export function withR4NativeExecution<T>(context: R4NativeExecutionContext, run: () => Promise<T>): Promise<T> {
  context.signal?.throwIfAborted();
  return contexts.run(Object.freeze({ ...context }), run);
}

export function currentR4NativeExecution() { return contexts.getStore(); }

export function r4NativeSourcePath(workbenchPath: string | undefined | null) {
  const context = contexts.getStore();
  return context ? context.sourcePath : workbenchPath;
}

/** A failed paid encoding must stop before the next related encoding starts. */
export async function mapR4NativeInputs<T,U>(items:readonly T[],map:(item:T)=>Promise<U>):Promise<U[]> {
  if(!contexts.getStore())return Promise.all(items.map(map));
  const results:U[]=[];
  for(const item of items)results.push(await map(item));
  return results;
}

export async function checkR4NativeSubmission(kind: R4NativeRequestKind = 'image') {
  const context = contexts.getStore();
  if (!context) return;
  context.signal?.throwIfAborted();
  await context.beforeSubmit(kind);
  context.signal?.throwIfAborted();
}

/** Persist the HTTP receipt before any local decoding/save can fail. */
export async function withR4NativeHttpReceipt<T extends {status:number}>(kind:R4NativeRequestKind,send:()=>Promise<T>):Promise<T> {
  const context=contexts.getStore();
  let response:T;
  try{response=await send();}catch(error){
    const status=(error as {response?:{status?:number}})?.response?.status;
    await context?.afterReceipt?.(kind,{status:status&&status<500?'confirmed':'unknown',rawStatus:status?`http_${status}`:'transport_unknown',receivedAt:new Date().toISOString()});
    throw error;
  }
  await context?.afterReceipt?.(kind,{status:'confirmed',rawStatus:`http_${response.status}`,receivedAt:new Date().toISOString()});
  return response;
}

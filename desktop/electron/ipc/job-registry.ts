import crypto from "crypto";
import { AsyncLocalStorage } from "node:async_hooks";

// Each paid generation call (generate/i2i/redraw/inpaint/upscale/augment) gets
// its own entry here instead of sharing one module-level AbortController. A
// slow-to-finish older call can no longer null out a newer call's controller
// out from under it, and "stop" cancels every job actually in flight instead
// of whichever one happened to hold a shared reference last.
const jobs = new Map<string, AbortController>();
const r4Context=new AsyncLocalStorage<boolean>();
let r4Exclusive=false;

/** Run one durable R4 image request without racing the renderer's manual image jobs. */
export async function withR4ExclusiveGeneration<T>(callback:()=>T|Promise<T>):Promise<T>{
  if(r4Exclusive||jobs.size>0)throw new Error("已有软件生图任务正在运行；R4 请求未发送，请等待完成后重新准备。");
  r4Exclusive=true;
  try{return await r4Context.run(true,callback);}finally{r4Exclusive=false;}
}

export function beginJob(): { id: string; controller: AbortController; end: () => void } {
  const id = crypto.randomUUID();
  const controller = new AbortController();
  if(r4Exclusive&&!r4Context.getStore())controller.abort(new Error("R4 durable generation is active."));
  jobs.set(id, controller);
  return {
    id,
    controller,
    end: () => {
      if (jobs.get(id) === controller) jobs.delete(id);
    },
  };
}

export function cancelAllJobs(): boolean {
  if (jobs.size === 0) return false;
  for (const controller of jobs.values()) controller.abort();
  jobs.clear();
  return true;
}

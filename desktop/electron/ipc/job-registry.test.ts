import { describe, expect, it } from "vitest";
import { beginJob, cancelAllJobs, withR4ExclusiveGeneration } from "./job-registry";

describe("job-registry", () => {
  it("does not enter durable dispatch while a manual or gateway request is registered", async () => {
    const manual = beginJob();
    let entered = false;
    try {
      await expect(withR4ExclusiveGeneration(() => { entered = true; })).rejects.toThrow("已有软件生图任务");
      expect(entered).toBe(false);
      expect(manual.controller.signal.aborted).toBe(false);
    } finally { manual.end(); }
  });

  it("allows the durable request's own native job and blocks unrelated submissions until it settles", async () => {
    let release!: () => void, ready!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { ready = resolve; });
    const running = withR4ExclusiveGeneration(async () => {
      const own = beginJob();
      try { expect(own.controller.signal.aborted).toBe(false); ready(); await waiting; }
      finally { own.end(); }
    });
    await entered;
    const unrelated = beginJob();
    try {
      expect(unrelated.controller.signal.aborted).toBe(true);
      await expect(withR4ExclusiveGeneration(() => {})).rejects.toThrow();
    } finally { unrelated.end(); release(); await running; }
    const after = beginJob();
    try { expect(after.controller.signal.aborted).toBe(false); } finally { after.end(); }
  });

  it("an older job finishing after a newer one starts does not clear the newer job's controller", () => {
    const a = beginJob();
    const b = beginJob();

    // A finishes late (its own cleanup runs) — this must not touch B.
    a.end();

    expect(b.controller.signal.aborted).toBe(false);
    const cancelled = cancelAllJobs();
    expect(cancelled).toBe(true);
    expect(b.controller.signal.aborted).toBe(true);
  });

  it("cancelAllJobs aborts every job currently in flight, not just the most recent", () => {
    const a = beginJob();
    const b = beginJob();
    const c = beginJob();

    cancelAllJobs();

    expect(a.controller.signal.aborted).toBe(true);
    expect(b.controller.signal.aborted).toBe(true);
    expect(c.controller.signal.aborted).toBe(true);
  });

  it("cancelAllJobs is a no-op that reports nothing-to-cancel when the registry is empty", () => {
    const a = beginJob();
    a.end();

    expect(cancelAllJobs()).toBe(false);
  });

  it("end() is idempotent and never removes a different job with the same id slot reused later", () => {
    const a = beginJob();
    a.end();
    a.end(); // calling twice must not throw or affect anything else

    const b = beginJob();
    expect(cancelAllJobs()).toBe(true);
    expect(b.controller.signal.aborted).toBe(true);
  });
});

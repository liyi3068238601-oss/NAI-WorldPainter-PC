import { beforeEach, describe, expect, it, vi } from "vitest";
import { mobileSquareBrushCells, mobileSquareBrushStamp, type MobileStroke } from "./mobile-inpaint";
import { computeMobilePixels } from "./mobile-inpaint-processing";
import { MobileInpaintPreviewScheduler, MobileInpaintStrokeCanvasCache } from "./mobile-inpaint-preview";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function opaque(width: number, height: number) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let index = 0; index < data.length; index += 4) data.set([90, 100, 110, 255], index);
  return { width, height, data };
}

describe("mobile inpaint preview parity", () => {
  beforeEach(() => vi.useRealTimers());

  it("uses the exact prepared request mask, including full-size 8x8 alignment", () => {
    const source = opaque(32, 32);
    const strokes: MobileStroke[] = [
      { target: "mask", mode: "paint", size: 8, points: [{ x: -7, y: 9 }] },
      { target: "mask", mode: "erase", size: 8, points: [{ x: 9, y: 9 }] },
      { target: "image", mode: "erase", size: 8, points: [{ x: 0, y: 0 }] },
    ];
    const input = { source, strokes, layers: [], worldRect: { x: -16, y: -16, width: 64, height: 64 }, output: { width: 64, height: 64 }, expand: 0 };
    const prepared = computeMobilePixels({ kind: "prepare", ...input }) as { mask: typeof source };
    const preview = computeMobilePixels({ kind: "mask-preview", ...input }) as typeof source;
    expect(preview).toEqual(prepared.mask);
    expect(preview.width).toBe(64);
    // Selected cells are binary and wholly aligned on the same 8px boundaries sent to the API.
    for (let y = 0; y < 64; y += 8) for (let x = 0; x < 64; x += 8) {
      const red = preview.data[(y * 64 + x) * 4];
      for (let yy = y; yy < y + 8; yy++) for (let xx = x; xx < x + 8; xx++) expect(preview.data[(yy * 64 + xx) * 4]).toBe(red);
    }
  });

  it("draws square brush preview cells with the same grid geometry as rasterization", () => {
    expect(mobileSquareBrushCells([{ x: 12, y: 12 }], 8)).toEqual([{ x: 1, y: 1 }]);
    expect(mobileSquareBrushStamp({ x: 12, y: 12 }, 8)).toEqual({ x: 8, y: 8, width: 8, height: 8 });
    const stroke: MobileStroke = { target: "mask", mode: "paint", square: true, size: 8, points: [{ x: 12, y: 12 }] };
    const result = computeMobilePixels({ kind: "mask-preview", source: opaque(64, 64), strokes: [stroke],
      worldRect: { x: 0, y: 0, width: 64, height: 64 }, output: { width: 64, height: 64 }, expand: 0 }) as ReturnType<typeof opaque>;
    for (let y = 8; y < 16; y++) for (let x = 8; x < 16; x++) expect(result.data[(y * 64 + x) * 4]).toBe(255);
    expect(result.data[(7 * 64 + 8) * 4]).toBe(0);
  });

  it("debounces and serializes work while suppressing stale results", async () => {
    vi.useFakeTimers();
    const scheduler = new MobileInpaintPreviewScheduler<string>(250);
    const old = deferred<string>(), latest = deferred<string>();
    const results: string[] = [];
    let active = 0, maximumActive = 0;
    const work = (promise: Promise<string>) => async () => {
      active++; maximumActive = Math.max(maximumActive, active);
      try { return await promise; } finally { active--; }
    };

    scheduler.schedule("old", work(old.promise), (_signature, result) => results.push(result));
    await vi.advanceTimersByTimeAsync(249);
    expect(active).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(active).toBe(1);
    scheduler.schedule("latest", work(latest.promise), (_signature, result) => results.push(result));
    await vi.advanceTimersByTimeAsync(250);
    expect(scheduler.pendingCount).toBe(1);
    old.resolve("stale");
    await vi.advanceTimersToNextTimerAsync();
    await Promise.resolve();
    expect(results).toEqual([]);
    expect(active).toBe(1);
    latest.resolve("fresh");
    await scheduler.settled;
    expect(results).toEqual(["fresh"]);
    expect(maximumActive).toBe(1);
    scheduler.dispose();
  });

  it("renders only appended cached strokes and rebuilds after undo or view changes", () => {
    const calls: MobileStroke[] = [];
    const context = { setTransform() {}, clearRect() {} } as unknown as CanvasRenderingContext2D;
    const canvas = { width: 0, height: 0, getContext: () => context } as unknown as HTMLCanvasElement;
    const cache = new MobileInpaintStrokeCanvasCache();
    const first: MobileStroke = { target: "image", mode: "paint", size: 8, points: [{ x: 1, y: 1 }] };
    const second: MobileStroke = { target: "image", mode: "erase", size: 8, points: [{ x: 2, y: 2 }] };
    const draw = (_context: CanvasRenderingContext2D, stroke: MobileStroke) => calls.push(stroke);
    const make = (strokes: MobileStroke[], key = "view-1") => cache.sync(strokes, "image", 100, 80, key, draw, () => canvas);

    expect(make([first])).toBe(canvas);
    make([first, second]);
    make([first, second]);
    expect(calls).toEqual([first, second]);
    make([first]); // Undo removes a committed stroke, requiring a clean rebuild.
    expect(calls).toEqual([first, second, first]);
    make([first], "view-2"); // A transform/viewport change invalidates screen-space ink.
    expect(calls).toEqual([first, second, first, first]);
  });
});

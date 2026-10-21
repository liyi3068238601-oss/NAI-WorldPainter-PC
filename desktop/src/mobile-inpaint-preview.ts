import type { MobileStroke } from "./mobile-inpaint";

export type MobilePreviewWork<T> = () => Promise<T>;
export type MobilePreviewResult<T> = (signature: string, result: T) => void;

interface PreviewRequest<T> {
  signature: string;
  epoch: number;
  work: MobilePreviewWork<T>;
  onResult: MobilePreviewResult<T>;
}

/** Debounces snapshots and guarantees that at most one preview worker is active. */
export class MobileInpaintPreviewScheduler<T> {
  constructor(
    private readonly debounceMs = 250,
    private readonly onError?: (signature: string, error: unknown) => void,
  ) {}

  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: PreviewRequest<T> | null = null;
  private active: PreviewRequest<T> | null = null;
  private pendingReady = false;
  private suspended = false;
  private disposed = false;
  private epoch = 0;
  private desiredSignature: string | null = null;
  private lastDeliveredSignature: string | null = null;
  private inFlight: Promise<void> = Promise.resolve();

  get activeCount() { return this.active ? 1 : 0; }
  get pendingCount() { return this.pending ? 1 : 0; }
  get isSuspended() { return this.suspended; }
  get settled() { return this.inFlight; }

  schedule(signature: string, work: MobilePreviewWork<T>, onResult: MobilePreviewResult<T>) {
    if (this.disposed || this.suspended) return;
    if (signature === this.lastDeliveredSignature) {
      this.desiredSignature = signature;
      this.clearPending();
      return;
    }
    if (this.active?.epoch === this.epoch && this.active.signature === signature) {
      this.desiredSignature = signature;
      this.clearPending();
      return;
    }
    if (this.pending?.epoch === this.epoch && this.pending.signature === signature) return;

    this.desiredSignature = signature;
    this.pending = { signature, epoch: this.epoch, work, onResult };
    this.pendingReady = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.disposed || this.suspended || !this.pending) return;
      this.pendingReady = true;
      this.pump();
    }, this.debounceMs);
  }

  invalidate() {
    if (this.disposed) return;
    this.epoch++;
    this.desiredSignature = null;
    this.lastDeliveredSignature = null;
    this.clearPending();
  }

  suspend() {
    if (this.disposed) return;
    this.suspended = true;
    this.invalidate();
  }

  resume() {
    if (!this.disposed) this.suspended = false;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.epoch++;
    this.desiredSignature = null;
    this.lastDeliveredSignature = null;
    this.clearPending();
  }

  private clearPending() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
    this.pendingReady = false;
  }

  private pump() {
    if (this.disposed || this.suspended || this.active || !this.pendingReady) return;
    const request = this.pending;
    if (!request) return;
    if (request.epoch !== this.epoch || request.signature !== this.desiredSignature) {
      this.clearPending();
      return;
    }
    this.pending = null;
    this.pendingReady = false;
    this.active = request;
    this.inFlight = this.run(request);
    void this.inFlight;
  }

  private async run(request: PreviewRequest<T>) {
    try {
      const result = await request.work();
      if (this.canPublish(request)) {
        request.onResult(request.signature, result);
        if (this.canPublish(request)) this.lastDeliveredSignature = request.signature;
      }
    } catch (error) {
      if (this.canPublish(request)) {
        try { this.onError?.(request.signature, error); } catch { /* Diagnostics cannot block the worker slot. */ }
      }
    } finally {
      if (this.active === request) this.active = null;
      this.pump();
    }
  }

  private canPublish(request: PreviewRequest<T>) {
    return !this.disposed && !this.suspended && request.epoch === this.epoch && request.signature === this.desiredSignature;
  }
}

/**
 * A stage-sized flattened ink bitmap. New strokes are drawn once; undo/reorder
 * or a viewport/transform change clears and rebuilds the bitmap. Erasers run on
 * this isolated layer, so they never clear the source image below it.
 */
export class MobileInpaintStrokeCanvasCache {
  private canvas: HTMLCanvasElement | null = null;
  private sourceStrokes: MobileStroke[] | null = null;
  private cachedStrokes: MobileStroke[] = [];
  private target: MobileStroke["target"] | null = null;
  private cacheKey = "";

  sync(
    allStrokes: MobileStroke[],
    target: MobileStroke["target"],
    width: number,
    height: number,
    cacheKey: string,
    drawStroke: (context: CanvasRenderingContext2D, stroke: MobileStroke) => void,
    createCanvas: () => HTMLCanvasElement = () => document.createElement("canvas"),
  ) {
    let rebuild = !this.canvas || this.canvas.width !== width || this.canvas.height !== height || this.target !== target || this.cacheKey !== cacheKey;
    if (!this.canvas) this.canvas = createCanvas();
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    const sameSnapshot = this.sourceStrokes === allStrokes && this.target === target;
    const selected = sameSnapshot ? this.cachedStrokes : allStrokes.filter(stroke => stroke.target === target);
    const canAppend = !rebuild && selected.length >= this.cachedStrokes.length && this.cachedStrokes.every((stroke, index) => selected[index] === stroke);
    const context = this.canvas.getContext("2d");
    if (!context) throw Error("笔迹缓存画布不可用。");

    if (rebuild || !canAppend) {
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, width, height);
      for (const stroke of selected) drawStroke(context, stroke);
    } else {
      for (const stroke of selected.slice(this.cachedStrokes.length)) drawStroke(context, stroke);
    }
    this.cachedStrokes = selected;
    this.sourceStrokes = allStrokes;
    this.target = target;
    this.cacheKey = cacheKey;
    return this.canvas;
  }

  reset() {
    this.canvas = null;
    this.sourceStrokes = null;
    this.cachedStrokes = [];
    this.target = null;
    this.cacheKey = "";
  }

  get cachedCount() { return this.cachedStrokes.length; }
  get sourceReference() { return this.sourceStrokes; }
}

const identities = new WeakMap<object, number>();
let nextIdentity = 1;
function identity(value: object) {
  let result = identities.get(value);
  if (result === undefined) { result = nextIdentity++; identities.set(value, result); }
  return result;
}

export function mobileInpaintPreviewSignature(input: {
  source: object;
  strokes: object;
  frame: { x: number; y: number; width: number; height: number };
  transform: { scale: number; offsetX: number; offsetY: number };
  output: { width: number; height: number };
  expand: number;
}) {
  const { frame, transform, output } = input;
  return [identity(input.source), identity(input.strokes), frame.x, frame.y, frame.width, frame.height,
    transform.scale, transform.offsetX, transform.offsetY, output.width, output.height, input.expand].join(":");
}

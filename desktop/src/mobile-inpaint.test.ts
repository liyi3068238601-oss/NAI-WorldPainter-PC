import { describe, expect, it } from 'vitest';
import { alignMobileMask, composeMobile, fitFrame, frameToWorld, maskMobileLayer, rasterizeMobile, resizeFrame, type MobilePixels, type MobileStroke } from './mobile-inpaint';
function image(width: number, height: number, color = [20, 40, 60, 255]): MobilePixels {
  const data = new Uint8ClampedArray(width * height * 4); for (let n = 0; n < data.length; n += 4) data.set(color, n); return { width, height, data };
}
const pixel = (p: MobilePixels, x: number, y: number) => Array.from(p.data.subarray((y * p.width + x) * 4, (y * p.width + x) * 4 + 4));
const brush = (mode: 'paint' | 'erase', size = 4): MobileStroke => ({ target: 'mask', mode, points: [{ x: 8, y: 8 }], size });
const rect = (width: number, height = width) => ({ x: 0, y: 0, width, height });
describe('mobile frame and raster semantics', () => {
  it('fits full source and centers independently sized frame; aspect changes preserve center', () => {
    const fitted = fitFrame({ width: 2000, height: 1000 }, { width: 832, height: 1216 }, { width: 1000, height: 600 });
    expect(fitted.transform).toEqual({ scale: .45, offsetX: 50, offsetY: 75 });
    const w = frameToWorld(fitted.frame, fitted.transform); expect(w.x).toBeCloseTo(584); expect(w.y).toBeCloseTo(-108); expect(w.width).toBeCloseTo(832); expect(w.height).toBeCloseTo(1216);
    const next = resizeFrame(fitted.frame, { width: 1024, height: 1024 }); expect(next.width).toBe(fitted.frame.width); expect(next.height).toBe(next.width);
    expect(next.y + next.height / 2).toBeCloseTo(fitted.frame.y + fitted.frame.height / 2);
  });
  it('samples output pixel centers and only masks actual out of bounds pixels', () => {
    const source = image(4, 4), original = source.data.slice();
    const inside = rasterizeMobile(source, { x: -.25, y: 0, width: 4, height: 4 }, source, []);
    expect(pixel(inside.image, 0, 1)).toEqual([20, 40, 60, 255]); expect(pixel(inside.mask, 0, 1)[0]).toBe(0);
    const outside = rasterizeMobile(source, { x: -.75, y: 0, width: 4, height: 4 }, source, []);
    expect(pixel(outside.image, 0, 1)).toEqual([0, 0, 0, 0]); expect(pixel(outside.mask, 0, 1)).toEqual([255, 255, 255, 255]); expect(source.data).toEqual(original);
  });
  it('keeps frozen world placement independent of processing resolution', () => {
    const source = image(8, 8), frame = { x: -2, y: -1, width: 8, height: 6 }, original = { ...frame };
    expect(rasterizeMobile(source, frame, { width: 4, height: 3 }, []).image.width).toBe(4);
    expect(rasterizeMobile(source, frame, { width: 16, height: 12 }, []).image.width).toBe(16); expect(frame).toEqual(original);
  });
  it('uses binary repeated coverage, ordered erase, and circular Euclidean dilation', () => {
    const source = image(32, 32), once = rasterizeMobile(source, rect(32), source, [brush('paint')]).mask;
    expect(rasterizeMobile(source, rect(32), source, [brush('paint'), brush('paint')]).mask.data).toEqual(once.data);
    const erased = rasterizeMobile(source, rect(32), source, [brush('paint'), brush('erase', 2)]).mask;
    expect(pixel(erased, 8, 8)[0]).toBe(0); expect(pixel(erased, 10, 8)[0]).toBe(255);
    const expanded = rasterizeMobile(source, rect(32), source, [brush('paint', 1)], 2).mask;
    expect(pixel(expanded, 10, 8)[0]).toBe(255); expect(pixel(expanded, 10, 10)[0]).toBe(0);
  });
  it('connects fast square strokes on the fixed 8 pixel world grid', () => {
    const source = image(48, 48), stroke: MobileStroke = { ...brush('paint', 8), square: true, points: [{ x: 1, y: 1 }, { x: 33, y: 33 }] };
    const mask = rasterizeMobile(source, rect(48), source, [stroke]).mask;
    expect(pixel(mask, 4, 4)[0]).toBe(255); expect(pixel(mask, 20, 20)[0]).toBe(255); expect(pixel(mask, 20, 4)[0]).toBe(0);
  });
  it('separately aligns final request mask with R>=128 and includes partial edge cells', () => {
    const raw = image(10, 10, [0, 0, 0, 0]); raw.data[(9 * 10 + 9) * 4] = 128; raw.data[0] = 127;
    const mask = alignMobileMask(raw); expect(pixel(mask, 8, 8)).toEqual([255, 255, 255, 255]); expect(pixel(mask, 7, 7)).toEqual([0, 0, 0, 255]); expect(pixel(raw, 8, 8)[0]).toBe(0);
  });
});
describe('mobile candidate alpha and paste back', () => {
  const halfMask = () => { const m = image(16, 16, [0, 0, 0, 0]); for (let y = 0; y < 16; y++) for (let x = 0; x < 8; x++) m.data.set([255, 255, 255, 255], (y * 16 + x) * 4); return m; };
  it('keeps zero feather binary and all selected transparent expansion pixels opaque', () => {
    const generated = image(16, 16, [255, 0, 0, 255]), mask = halfMask();
    const hard = maskMobileLayer(generated, mask, 0, undefined, image(16, 16)); expect(pixel(hard, 0, 8)[3]).toBe(255); expect(pixel(hard, 7, 8)[3]).toBe(255); expect(pixel(hard, 8, 8)[3]).toBe(0);
    const expansion = maskMobileLayer(generated, mask, 8, undefined, image(16, 16, [0, 0, 0, 0])); expect(pixel(expansion, 0, 8)[3]).toBe(255); expect(pixel(expansion, 7, 8)[3]).toBe(255);
  });
  it('fades inside/outside mask and request-frame edges, preserving tiny patches', () => {
    const source = image(16, 16), original = source.data.slice(), layer = maskMobileLayer(image(16, 16, [255, 0, 0, 255]), halfMask(), 8, undefined, source);
    expect(pixel(layer, 0, 8)[3]).toBeLessThanOrEqual(32); expect(pixel(layer, 4, 8)[3]).toBe(255);
    for (const x of [7, 8]) { expect(pixel(layer, x, 8)[3]).toBeGreaterThanOrEqual(180); expect(pixel(layer, x, 8)[3]).toBeLessThanOrEqual(240); }
    const profile = Array.from({ length: 9 }, (_, i) => pixel(layer, i + 4, 8)[3]); expect(profile.every((v, i) => !i || v <= profile[i - 1])).toBe(true); expect(source.data).toEqual(original);
    expect(maskMobileLayer(image(1, 1, [255, 0, 0, 255]), image(1, 1, [255, 255, 255, 255]), 8, undefined, image(1, 1)).data[3]).toBeGreaterThan(0);
  });
  it('retains full frozen request extents and world origin when composing outpaint layers', () => {
    const source = image(4, 4), original = source.data.slice(), patch = image(4, 4, [255, 0, 0, 255]);
    const composed = composeMobile(source, [], [{ image: patch, worldRect: { x: -2, y: -1, width: 4, height: 4 }, visible: true }, { image: patch, worldRect: { x: 100, y: 100, width: 4, height: 4 }, visible: false }]);
    expect([composed.width, composed.height]).toEqual([6, 5]); expect(composed.bounds).toEqual({ x: -2, y: -1, width: 6, height: 5 }); expect(pixel(composed, 0, 0)).toEqual([255, 0, 0, 255]); expect(pixel(composed, 5, 4)).toEqual([20, 40, 60, 255]);
    const comparison = rasterizeMobile(composed, { x: -2, y: -1, width: 4, height: 4 }, patch, []); expect(pixel(comparison.image, 0, 0)).toEqual([255, 0, 0, 255]); expect(source.data).toEqual(original);
  });
  it('rescales alpha layers with premultiplied color so a white patch has no dark fringe', () => {
    const source = image(16, 16, [255, 255, 255, 255]), patch = image(4, 4, [255, 255, 255, 255]); for (let y = 0; y < 4; y++) patch.data.set([0, 0, 0, 0], (y * 4 + 3) * 4);
    const result = composeMobile(source, [], [{ image: patch, worldRect: { x: 4, y: 4, width: 3, height: 3 }, visible: true }]); expect(Array.from(result.data).every(v => v === 255)).toBe(true);
  });
  it('erases image overlay without deleting source pixels', () => {
    const source = image(16, 16), original = source.data.slice(), paint: MobileStroke = { ...brush('paint'), target: 'image', color: 0xffff0000, opacity: 1 }, erase: MobileStroke = { ...paint, mode: 'erase', size: 2 };
    const result = composeMobile(source, [paint, erase], []); expect(pixel(result, 8, 8)).toEqual([20, 40, 60, 255]); expect(pixel(result, 10, 8)).toEqual([255, 0, 0, 255]); expect(source.data).toEqual(original);
  });
  it('rejects unexpected generated dimensions instead of silently stretching', () => { expect(() => maskMobileLayer(image(4, 4), image(8, 8))).toThrow('尺寸不一致'); });
  it('rejects enormous request-frame composites before allocating pixels', () => {
    const source = image(2, 2), patch = image(1, 1), largeFrame = { x: 0, y: 0, width: 163840, height: 163840 };
    expect(() => composeMobile(source, [], [{ image: patch, worldRect: largeFrame, visible: true }])).toThrow('32MP 内存上限');
    // Editing coordinates remain unrestricted; only an actual pixel allocation is bounded.
    expect(frameToWorld(largeFrame, { scale: 1, offsetX: 0, offsetY: 0 })).toEqual(largeFrame);
  });
  it('rejects distant negative bounds and unsafe pixel products before allocation', () => {
    const source = image(2, 2), patch = image(1, 1);
    expect(() => composeMobile(source, [], [{ image: patch, worldRect: { x: -100000, y: -100000, width: 1, height: 1 }, visible: true }])).toThrow('32MP 内存上限');
    expect(() => rasterizeMobile(source, rect(2), { width: Number.MAX_SAFE_INTEGER, height: 2 }, [])).toThrow('32MP 内存上限');
  });
});

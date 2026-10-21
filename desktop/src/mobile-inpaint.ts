/** Independent pixel implementation; behavior reference: mobile eb8ef2158e3f204ab90f7c198d4050a5967f4439. */
export interface MobilePoint { x: number; y: number }
export interface MobileSize { width: number; height: number }
export interface MobileRect extends MobilePoint, MobileSize {}
export interface MobileTransform { scale: number; offsetX: number; offsetY: number }
export interface MobilePixels extends MobileSize { data: Uint8ClampedArray; bounds?: MobileRect }
export interface MobileStroke {
  target: 'mask' | 'image'; mode: 'paint' | 'erase'; points: MobilePoint[]; size: number;
  square?: boolean; color?: number; opacity?: number;
}
export interface MobileLayer { image: MobilePixels; worldRect: MobileRect; visible: boolean }
export const MOBILE_MAX_PIXELS = 32 * 1024 * 1024;
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const round = (x: number) => x < 0 ? -Math.round(-x) : Math.round(x);
function checkSize(s: MobileSize) {
  if (![s.width, s.height].every(x => Number.isSafeInteger(x) && x > 0)) throw new Error('图片尺寸必须是正整数');
}
function checkAllocation(s: MobileSize) {
  checkSize(s);
  // Division rejects unsafe products before multiplication or allocating a typed array.
  if (s.width > Math.floor(MOBILE_MAX_PIXELS / s.height)) throw new Error('图像处理超过 32MP 内存上限，请缩小输出框或将其移近原图后重试。');
}
function checkImage(p: MobilePixels) { checkAllocation(p); if (p.data.length !== p.width * p.height * 4) throw new Error('图片像素长度与尺寸不一致'); }
function checkRect(r: MobileRect) {
  if (![r.x, r.y, r.width, r.height].every(Number.isFinite) || r.width <= 0 || r.height <= 0) throw new Error('输出框坐标或尺寸无效');
}
function blank(s: MobileSize): MobilePixels { checkAllocation(s); return { width: s.width, height: s.height, data: new Uint8ClampedArray(s.width * s.height * 4) }; }
const boundsOf = (s: MobilePixels): MobileRect => s.bounds ?? { x: 0, y: 0, width: s.width, height: s.height };
export function frameToWorld(f: MobileRect, t: MobileTransform): MobileRect {
  checkRect(f); if (![t.scale, t.offsetX, t.offsetY].every(Number.isFinite) || t.scale <= 0) throw new Error('画布变换无效');
  return { x: (f.x - t.offsetX) / t.scale, y: (f.y - t.offsetY) / t.scale, width: f.width / t.scale, height: f.height / t.scale };
}
export function fitFrame(source: MobileSize, output: MobileSize, viewport: MobileSize): { frame: MobileRect; transform: MobileTransform } {
  checkSize(source); checkSize(output); checkSize(viewport);
  const scale = Math.max(.05, Math.min(viewport.width * .9 / source.width, viewport.height * .9 / source.height));
  return { transform: { scale, offsetX: (viewport.width - source.width * scale) / 2, offsetY: (viewport.height - source.height * scale) / 2 },
    frame: { x: (viewport.width - output.width * scale) / 2, y: (viewport.height - output.height * scale) / 2, width: output.width * scale, height: output.height * scale } };
}
export function resizeFrame(frame: MobileRect, output: MobileSize): MobileRect {
  checkRect(frame); checkSize(output); const height = frame.width * output.height / output.width;
  return { ...frame, y: frame.y + (frame.height - height) / 2, height };
}
/** Encoding alignment is separate from editing: R >= 128 in a cell selects all its pixels. */
export function alignMobileMask(mask: MobilePixels): MobilePixels {
  checkImage(mask); const out = blank(mask);
  for (let y = 0; y < mask.height; y += 8) for (let x = 0; x < mask.width; x += 8) {
    const right = Math.min(x + 8, mask.width), bottom = Math.min(y + 8, mask.height); let on = false;
    for (let yy = y; yy < bottom && !on; yy++) for (let xx = x; xx < right; xx++) if (mask.data[(yy * mask.width + xx) * 4] >= 128) { on = true; break; }
    for (let yy = y; yy < bottom; yy++) for (let xx = x; xx < right; xx++) {
      const n = (yy * mask.width + xx) * 4; out.data[n] = out.data[n + 1] = out.data[n + 2] = on ? 255 : 0; out.data[n + 3] = 255;
    }
  }
  return out;
}
function selected(mask: MobilePixels, boundary: boolean): Uint8Array {
  const seeds = new Uint8Array(mask.width * mask.height);
  for (let y = 0; y < mask.height; y++) for (let x = 0; x < mask.width; x++) {
    const n = y * mask.width + x; if (mask.data[n * 4] === 0) continue;
    if (!boundary) { seeds[n] = 1; continue; }
    for (let dy = -1; dy <= 1 && !seeds[n]; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= mask.width || yy >= mask.height || !mask.data[(yy * mask.width + xx) * 4]) { seeds[n] = 1; break; }
    }
  }
  return seeds;
}
/** Exact Euclidean distance transform via separable parabola envelopes. */
function distanceMap(seeds: Uint8Array, width: number, height: number): Float64Array {
  const d = new Float64Array(width * height), large = width * width + height * height + 1;
  if (!seeds.some(Boolean)) { d.fill(Infinity); return d; }
  for (let y = 0; y < height; y++) {
    let p = -Infinity;
    for (let x = 0; x < width; x++) { if (seeds[y * width + x]) p = x; d[y * width + x] = Math.min(large, (x - p) ** 2); }
    p = Infinity;
    for (let x = width - 1; x >= 0; x--) { if (seeds[y * width + x]) p = x; d[y * width + x] = Math.min(d[y * width + x], (p - x) ** 2); }
  }
  const values = new Float64Array(height), sites = new Int32Array(height), edges = new Float64Array(height + 1);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) values[y] = d[y * width + x];
    let end = 0; sites[0] = 0; edges[0] = -Infinity; edges[1] = Infinity;
    for (let q = 1; q < height; q++) {
      let crossing: number;
      while (true) { const p = sites[end]; crossing = (values[q] + q * q - values[p] - p * p) / (2 * (q - p)); if (crossing > edges[end]) break; end--; }
      sites[++end] = q; edges[end] = crossing; edges[end + 1] = Infinity;
    }
    let active = 0;
    for (let y = 0; y < height; y++) { while (edges[active + 1] < y) active++; d[y * width + x] = (y - sites[active]) ** 2 + values[sites[active]]; }
  }
  return d;
}
function over(data: Uint8ClampedArray, n: number, r: number, g: number, b: number, alpha: number) {
  const a = clamp(alpha / 255, 0, 1), oldA = data[n + 3] / 255, outA = a + oldA * (1 - a);
  if (!outA) { data.fill(0, n, n + 4); return; }
  data[n] = round((r * a + data[n] * oldA * (1 - a)) / outA); data[n + 1] = round((g * a + data[n + 1] * oldA * (1 - a)) / outA);
  data[n + 2] = round((b * a + data[n + 2] * oldA * (1 - a)) / outA); data[n + 3] = round(outA * 255);
}
function draw(stroke: MobileStroke, rect: MobileRect, output: MobileSize, paint: (x: number, y: number) => void) {
  if (!Number.isFinite(stroke.size) || stroke.size <= 0) return;
  const points = stroke.points.filter(p => Number.isFinite(p.x) && Number.isFinite(p.y)); if (!points.length) return;
  const sx = output.width / rect.width, sy = output.height / rect.height;
  if (stroke.square) {
    const diameter = Math.max(1, round(stroke.size / 8)), half = Math.floor(diameter / 2), shift = diameter % 2 === 0 ? .5 : 0, cells = new Set<string>();
    const grid = points.map(p => ({ x: Math.floor(p.x / 8 + shift), y: Math.floor(p.y / 8 + shift) }));
    for (let i = 0; i < grid.length; i++) {
      const a = grid[Math.max(0, i - 1)], b = grid[i]; let x = a.x, y = a.y;
      const dx = Math.abs(b.x - x), dy = Math.abs(b.y - y), stepX = x < b.x ? 1 : -1, stepY = y < b.y ? 1 : -1; let error = dx - dy;
      while (true) {
        for (let yy = -half; yy < diameter - half; yy++) for (let xx = -half; xx < diameter - half; xx++) cells.add(`${x + xx},${y + yy}`);
        if (x === b.x && y === b.y) break; const twice = error * 2;
        if (twice > -dy) { error -= dy; x += stepX; } if (twice < dx) { error += dx; y += stepY; }
      }
    }
    for (const cell of cells) {
      const [x, y] = cell.split(',').map(Number), left = Math.floor((x * 8 - rect.x) * sx), top = Math.floor((y * 8 - rect.y) * sy);
      const right = Math.max(left, Math.ceil(((x + 1) * 8 - rect.x) * sx) - 1), bottom = Math.max(top, Math.ceil(((y + 1) * 8 - rect.y) * sy) - 1);
      for (let yy = Math.max(0, top); yy <= Math.min(output.height - 1, bottom); yy++) for (let xx = Math.max(0, left); xx <= Math.min(output.width - 1, right); xx++) paint(xx, yy);
    }
    return;
  }
  const radius = Math.floor(Math.max(1, round(stroke.size * (sx + sy) / 2)) / 2), covered = new Set<number>();
  const coords = points.map(p => ({ x: round((p.x - rect.x) * sx), y: round((p.y - rect.y) * sy) }));
  for (let i = 0; i < coords.length; i++) {
    const a = coords[Math.max(0, i - 1)], b = coords[i], dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy;
    for (let y = Math.max(0, Math.min(a.y, b.y) - radius); y <= Math.min(output.height - 1, Math.max(a.y, b.y) + radius); y++)
      for (let x = Math.max(0, Math.min(a.x, b.x) - radius); x <= Math.min(output.width - 1, Math.max(a.x, b.x) + radius); x++) {
        const t = length === 0 ? 0 : clamp(((x - a.x) * dx + (y - a.y) * dy) / length, 0, 1);
        if ((x - a.x - t * dx) ** 2 + (y - a.y - t * dy) ** 2 <= radius * radius) covered.add(y * output.width + x);
      }
  }
  for (const n of covered) paint(n % output.width, Math.floor(n / output.width));
}
function imageStrokes(source: MobilePixels, strokes: MobileStroke[]): MobilePixels {
  if (!strokes.some(stroke => stroke.target === 'image')) return source;
  const out = { ...source, data: source.data.slice() }, overlay = blank(source);
  for (const stroke of strokes) if (stroke.target === 'image') {
    const color = stroke.color ?? 0xffff4d4f, alpha = round(clamp(stroke.opacity ?? .35, 0, 1) * 255);
    draw(stroke, boundsOf(source), source, (x, y) => { const n = (y * source.width + x) * 4;
      if (stroke.mode === 'erase') overlay.data.fill(0, n, n + 4); else over(overlay.data, n, (color >>> 16) & 255, (color >>> 8) & 255, color & 255, alpha); });
  }
  for (let n = 0; n < out.data.length; n += 4) over(out.data, n, overlay.data[n], overlay.data[n + 1], overlay.data[n + 2], overlay.data[n + 3]);
  return out;
}
export function rasterizeMobile(source: MobilePixels, worldRect: MobileRect, output: MobileSize, strokes: MobileStroke[], expand = 0): { image: MobilePixels; mask: MobilePixels } {
  checkImage(source); checkRect(worldRect); checkSize(output);
  const base = imageStrokes(source, strokes), bounds = boundsOf(source), image = blank(output), mask = blank(output); checkRect(bounds);
  for (let y = 0; y < output.height; y++) for (let x = 0; x < output.width; x++) {
    const wx = worldRect.x + (x + .5) * worldRect.width / output.width, wy = worldRect.y + (y + .5) * worldRect.height / output.height, n = (y * output.width + x) * 4;
    if (wx >= bounds.x && wy >= bounds.y && wx < bounds.x + bounds.width && wy < bounds.y + bounds.height) {
      const from = (Math.floor((wy - bounds.y) * source.height / bounds.height) * source.width + Math.floor((wx - bounds.x) * source.width / bounds.width)) * 4;
      image.data.set(base.data.subarray(from, from + 4), n); if (base.data[from + 3] > 0) continue;
    }
    mask.data.fill(255, n, n + 4);
  }
  for (const stroke of strokes) if (stroke.target === 'mask') draw(stroke, worldRect, output, (x, y) => {
    const n = (y * output.width + x) * 4; mask.data.fill(stroke.mode === 'paint' ? 255 : 0, n, n + 4);
  });
  const radius = Math.max(0, round(Number.isFinite(expand) ? expand : 0));
  if (radius > 0) { const d = distanceMap(selected(mask, false), output.width, output.height); for (let n = 0; n < d.length; n++) if (d[n] <= radius * radius) mask.data.fill(255, n * 4, n * 4 + 4); }
  return { image, mask };
}
export function maskMobileLayer(generated: MobilePixels, mask: MobilePixels, outward = 8, inward?: number, base?: MobilePixels): MobilePixels {
  checkImage(generated); checkImage(mask); if (base) checkImage(base);
  if (generated.width !== mask.width || generated.height !== mask.height || (base && (base.width !== generated.width || base.height !== generated.height))) throw new Error('生成图、底图与蒙版尺寸不一致');
  const out = blank(generated), outer = Math.max(0, round(outward)), inner = clamp(round(inward ?? Math.min(outer, 2)), 0, outer), blend = !!base && outer > 0 && inner > 0;
  const d = outer > 0 ? distanceMap(selected(mask, blend), mask.width, mask.height) : null;
  const edge = (position: number, length: number) => { const radius = Math.min(inner, (length - 1) / 2); return radius <= 0 ? 1 : clamp(Math.min(position + .5, length - position - .5) / radius, 0, 1) ** 2; };
  for (let y = 0; y < generated.height; y++) for (let x = 0; x < generated.width; x++) {
    const p = y * generated.width + x, n = p * 4, on = mask.data[n] > 0; let alpha = on ? 255 : 0;
    if (d && Number.isFinite(d[p])) {
      if (blend) {
        if (on && base!.data[n + 3] === 0) alpha = 255;
        else { const signed = on ? Math.sqrt(d[p]) + .5 : -(Math.sqrt(d[p]) - .5); alpha = round(clamp((signed + outer) / (inner + outer), 0, 1) * 255);
          if (base!.data[n + 3] > 0) alpha = round(alpha * Math.min(edge(x, generated.width), edge(y, generated.height))); }
      } else if (!on) { const distance = round(Math.sqrt(d[p])); alpha = distance <= outer ? round((1 - distance / outer) * 255) : 0; }
    }
    if (alpha > 0) { out.data[n] = generated.data[n]; out.data[n + 1] = generated.data[n + 1]; out.data[n + 2] = generated.data[n + 2]; out.data[n + 3] = round(generated.data[n + 3] * alpha / 255); }
  }
  return out;
}
function resample(source: MobilePixels, size: MobileSize): MobilePixels {
  if (source.width === size.width && source.height === size.height) return source;
  const out = blank(size);
  for (let y = 0; y < size.height; y++) for (let x = 0; x < size.width; x++) {
    const fx = x * source.width / size.width, fy = y * source.height / size.height, xx = Math.floor(fx), yy = Math.floor(fy), tx = fx - xx, ty = fy - yy;
    const samples = [[xx, yy, (1 - tx) * (1 - ty)], [Math.min(xx + 1, source.width - 1), yy, tx * (1 - ty)],
      [xx, Math.min(yy + 1, source.height - 1), (1 - tx) * ty], [Math.min(xx + 1, source.width - 1), Math.min(yy + 1, source.height - 1), tx * ty]];
    let a = 0, r = 0, g = 0, b = 0;
    for (const [px, py, weight] of samples) { const n = (py * source.width + px) * 4, alpha = source.data[n + 3]; a += alpha * weight; r += source.data[n] * alpha * weight; g += source.data[n + 1] * alpha * weight; b += source.data[n + 2] * alpha * weight; }
    const n = (y * size.width + x) * 4, byte = round(a); out.data[n] = byte ? round(r / a) : 0; out.data[n + 1] = byte ? round(g / a) : 0; out.data[n + 2] = byte ? round(b / a) : 0; out.data[n + 3] = byte;
  }
  return out;
}
/** bounds preserves world origin when the saved composite extends left/upward. */
export function composeMobile(source: MobilePixels, strokes: MobileStroke[], layers: MobileLayer[]): MobilePixels {
  checkImage(source); const b = boundsOf(source); checkRect(b); const visible = layers.filter(l => l.visible);
  let left = Math.floor(b.x), top = Math.floor(b.y), right = Math.ceil(b.x + b.width), bottom = Math.ceil(b.y + b.height);
  for (const l of visible) { checkImage(l.image); checkRect(l.worldRect); left = Math.min(left, Math.floor(l.worldRect.x)); top = Math.min(top, Math.floor(l.worldRect.y)); right = Math.max(right, Math.ceil(l.worldRect.x + l.worldRect.width)); bottom = Math.max(bottom, Math.ceil(l.worldRect.y + l.worldRect.height)); }
  const out = blank({ width: right - left, height: bottom - top }); out.bounds = { x: left, y: top, width: out.width, height: out.height };
  const place = (image: MobilePixels, x: number, y: number) => {
    for (let yy = 0; yy < image.height; yy++) for (let xx = 0; xx < image.width; xx++) { const dx = x + xx, dy = y + yy; if (dx < 0 || dy < 0 || dx >= out.width || dy >= out.height) continue;
      const n = (yy * image.width + xx) * 4; over(out.data, (dy * out.width + dx) * 4, image.data[n], image.data[n + 1], image.data[n + 2], image.data[n + 3]); }
  };
  place(resample(imageStrokes(source, strokes), { width: Math.max(1, round(b.width)), height: Math.max(1, round(b.height)) }), round(b.x) - left, round(b.y) - top);
  for (const l of visible) place(resample(l.image, { width: Math.max(1, round(l.worldRect.width)), height: Math.max(1, round(l.worldRect.height)) }), round(l.worldRect.x) - left, round(l.worldRect.y) - top);
  return out;
}

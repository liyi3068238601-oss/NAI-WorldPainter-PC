import {mobileInpaintText} from "./mobile-inpaint-text";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from "react";
import { frameToWorld, rasterizeMobile, type MobilePixels, type MobileStroke } from "./mobile-inpaint";
import { useMobileInpaintStore, type MobileTool } from "./mobile-inpaint-store";
import { useAppStore } from "./store";
import "./mobile-inpaint.css";

const toolLabels: Array<[MobileTool, string, string]> = [
  ["view", "整体", "同步移动和缩放图片与输出框"],
  ["frame", "输出框", "独立移动和缩放输出框，允许越界"],
  ["image", "图片", "独立移动和缩放底图"],
  ["brush", "画笔", "绘制当前图层"],
  ["erase", "擦除", "擦除当前图层的笔迹"],
];
const cache = new WeakMap<MobilePixels, HTMLCanvasElement>();
function pixelCanvas(pixels: MobilePixels) {
  let canvas = cache.get(pixels);
  if (canvas) return canvas;
  canvas = document.createElement("canvas"); canvas.width = pixels.width; canvas.height = pixels.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw Error("图像画布不可用。");
  const image = ctx.createImageData(pixels.width, pixels.height); image.data.set(pixels.data); ctx.putImageData(image, 0, 0);
  cache.set(pixels, canvas); return canvas;
}
function strokePath(ctx: CanvasRenderingContext2D, stroke: MobileStroke, mask = false) {
  if (!stroke.points.length) return;
  const color = stroke.color ?? 0xffff4d4f;
  ctx.save();
  ctx.globalCompositeOperation = stroke.mode === "erase" ? "destination-out" : "source-over";
  ctx.strokeStyle = ctx.fillStyle = mask ? "#ff4d4f" : `#${(color & 0xffffff).toString(16).padStart(6, "0")}`;
  ctx.globalAlpha = stroke.mode === "erase" ? 1 : mask ? 0.48 : (stroke.opacity ?? 0.35);
  ctx.lineWidth = stroke.size; ctx.lineJoin = stroke.square ? "miter" : "round"; ctx.lineCap = stroke.square ? "square" : "round";
  if (stroke.points.length === 1) {
    const point = stroke.points[0]; ctx.beginPath();
    if (stroke.square) ctx.rect(point.x - stroke.size / 2, point.y - stroke.size / 2, stroke.size, stroke.size);
    else ctx.arc(point.x, point.y, stroke.size / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath(); ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
    stroke.points.slice(1).forEach(point => ctx.lineTo(point.x, point.y)); ctx.stroke();
  }
  ctx.restore();
}

export function MobileInpaintCanvas() {
  const language=useAppStore(state=>state.settings?.language);
  const mt=(key:string,values:Record<string,string|number>={})=>mobileInpaintText(language,key,values);
  const state = useMobileInpaintStore();
  const stageRef = useRef<HTMLDivElement>(null), canvasRef = useRef<HTMLCanvasElement>(null);
  const imageInkRef = useRef<HTMLCanvasElement | null>(null);
  const previewInkRef = useRef<HTMLCanvasElement | null>(null);
  const gesture = useRef<{ pointer: number; last: { x: number; y: number }; type: "draw" | "pan"; global: boolean; stroke?: MobileStroke } | null>(null);
  const [draft, setDraft] = useState<MobileStroke | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [compare, setCompare] = useState(50);
  const spaceHeld = useRef(false);

  useLayoutEffect(() => {
    const element = stageRef.current; if (!element) return;
    const observer = new ResizeObserver(entries => {
      const rect = entries[0].contentRect;
      if (rect.width > 0 && rect.height > 0) useMobileInpaintStore.getState().setViewport({ width: rect.width, height: rect.height });
    });
    observer.observe(element); return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      const current = useMobileInpaintStore.getState();
      if (current.mode !== "mobile" || useAppStore.getState().activeTab !== "inpaint" || (event.target as HTMLElement)?.closest("input,textarea,select,[contenteditable=true]")) return;
      if (event.code === "Space") { spaceHeld.current = true; event.preventDefault(); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); event.shiftKey ? current.redo() : current.undo(); }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") { event.preventDefault(); current.redo(); }
      if (event.key === "Escape") { current.update({ reviewOpen: false }); gesture.current = null; setDraft(null); }
    };
    const keyUp = (event: KeyboardEvent) => { if (event.code === "Space") spaceHeld.current = false; };
    const blur = () => { spaceHeld.current = false; gesture.current = null; setDraft(null); };
    window.addEventListener("keydown", keyDown); window.addEventListener("keyup", keyUp); window.addEventListener("blur", blur);
    return () => { window.removeEventListener("keydown", keyDown); window.removeEventListener("keyup", keyUp); window.removeEventListener("blur", blur); };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const { width, height } = state.viewport, dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(width * dpr)); canvas.height = Math.max(1, Math.round(height * dpr));
    const ctx = canvas.getContext("2d"); if (!ctx) return;
    ctx.scale(dpr, dpr); ctx.clearRect(0, 0, width, height);
    if (!state.pixels) return;
    const source = state.pixels, transform = state.transform;
    ctx.save(); ctx.translate(transform.offsetX, transform.offsetY); ctx.scale(transform.scale, transform.scale);
    ctx.drawImage(pixelCanvas(source), 0, 0); ctx.restore();
    let ink = imageInkRef.current;
    if (!ink) ink = imageInkRef.current = document.createElement("canvas");
    // Preview ink is bounded by the visible stage, rather than the full source bitmap.
    ink.width = canvas.width; ink.height = canvas.height;
    const inkCtx = ink.getContext("2d");
    if (inkCtx) {
      inkCtx.scale(dpr, dpr); inkCtx.translate(transform.offsetX, transform.offsetY); inkCtx.scale(transform.scale, transform.scale);
      inkCtx.beginPath(); inkCtx.rect(0, 0, source.width, source.height); inkCtx.clip();
      state.strokes.filter(s => s.target === "image").forEach(s => strokePath(inkCtx, s));
      if (draft?.target === "image") strokePath(inkCtx, draft);
      ctx.drawImage(ink, 0, 0, width, height);
    }
    ctx.save(); ctx.translate(transform.offsetX, transform.offsetY); ctx.scale(transform.scale, transform.scale);
    for (const layer of state.layers) if (layer.visible) ctx.drawImage(pixelCanvas(layer.image), layer.worldRect.x, layer.worldRect.y, layer.worldRect.width, layer.worldRect.height);
    ctx.restore();
    if (state.showMask && state.frame.width > 0 && state.frame.height > 0) {
      const ratio = Math.min(1, 768 / Math.max(state.output.width, state.output.height));
      const output = { width: Math.max(1, Math.round(state.output.width * ratio)), height: Math.max(1, Math.round(state.output.height * ratio)) };
      const strokes = state.strokes.filter(s => s.target === "mask");
      if (draft?.target === "mask") strokes.push(draft);
      const worldRect = frameToWorld(state.frame, transform);
      const imageStrokes = state.strokes.filter(s => s.target === "image");
      if (draft?.target === "image") imageStrokes.push(draft);
      let previewSource = source;
      if (imageStrokes.length) {
        // Keep the real source extent even when the output frame crosses the viewport.
        // Only this request-sized sample and its ink overlay are allocated for preview.
        previewSource = { ...rasterizeMobile(source, worldRect, output, [], 0).image, bounds: worldRect };
        let previewInk = previewInkRef.current;
        if (!previewInk) previewInk = previewInkRef.current = document.createElement("canvas");
        previewInk.width = output.width; previewInk.height = output.height;
        const previewCtx = previewInk.getContext("2d");
        if (previewCtx) {
          previewCtx.scale(output.width / worldRect.width, output.height / worldRect.height);
          previewCtx.translate(-worldRect.x, -worldRect.y);
          const bounds = source.bounds ?? { x: 0, y: 0, width: source.width, height: source.height };
          previewCtx.beginPath(); previewCtx.rect(bounds.x, bounds.y, bounds.width, bounds.height); previewCtx.clip();
          imageStrokes.forEach(stroke => strokePath(previewCtx, stroke));
          const overlay = previewCtx.getImageData(0, 0, output.width, output.height).data;
          // Automatic masking depends on transparency; colors are drawn by the stage renderer.
          for (let index = 3; index < overlay.length; index += 4) {
            const alpha = previewSource.data[index];
            previewSource.data[index] = Math.round(alpha + overlay[index] * (1 - alpha / 255));
          }
        }
      }
      const mask = rasterizeMobile(previewSource, worldRect, output, strokes, Math.round(state.expand * ratio)).mask;
      const tinted: MobilePixels = { width: mask.width, height: mask.height, data: new Uint8ClampedArray(mask.data.length) };
      for (let index = 0; index < mask.data.length; index += 4) { tinted.data[index] = 255; tinted.data[index + 1] = 77; tinted.data[index + 2] = 79; tinted.data[index + 3] = mask.data[index] > 0 && mask.data[index + 3] > 0 ? 100 : 0; }
      ctx.drawImage(pixelCanvas(tinted), state.frame.x, state.frame.y, state.frame.width, state.frame.height);
    }
    const { frame } = state;
    ctx.save(); ctx.strokeStyle = "#f5d57a"; ctx.lineWidth = 1.5; ctx.setLineDash([7, 4]); ctx.strokeRect(frame.x, frame.y, frame.width, frame.height);
    ctx.setLineDash([]); ctx.fillStyle = "#f5d57a"; const label = `${state.output.width} × ${state.output.height}`;
    ctx.font = "12px sans-serif"; const textWidth = ctx.measureText(label).width + 12;
    const labelX = Math.max(0, Math.min(width - textWidth, frame.x)); const labelY = Math.max(16, Math.min(height - 5, frame.y - 5));
    ctx.fillRect(labelX, labelY - 14, textWidth, 18); ctx.fillStyle = "#15151a"; ctx.fillText(label, labelX + 6, labelY - 1); ctx.restore();
  }, [state.pixels, state.viewport, state.transform, state.frame, state.strokes, state.layers, state.showMask, state.output, state.expand, draft]);

  function point(event: { clientX: number; clientY: number }) { const rect = stageRef.current!.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; }
  function world(value: { x: number; y: number }) { const t = useMobileInpaintStore.getState().transform; return { x: (value.x - t.offsetX) / t.scale, y: (value.y - t.offsetY) / t.scale }; }
  function pointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!state.pixels || state.busy || (event.button !== 0 && event.button !== 1)) return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    const p = point(event), global = spaceHeld.current || event.button === 1;
    if (!global && (state.tool === "brush" || state.tool === "erase")) {
      const stroke: MobileStroke = { target: state.target, mode: state.tool === "erase" ? "erase" : "paint", size: state.brushSize,
        square: state.squareBrush, color: Number(`0xff${state.brushColor.slice(1)}`), points: [world(p)] };
      state.checkpoint(); gesture.current = { pointer: event.pointerId, last: p, type: "draw", global: false, stroke }; setDraft(stroke);
    } else gesture.current = { pointer: event.pointerId, last: p, type: "pan", global };
  }
  function pointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const p = point(event); setCursor(p);
    const active = gesture.current; if (!active || active.pointer !== event.pointerId) return;
    // Capture can outlive a mouse release outside the renderer. A hover must never pan.
    if (event.pointerType === "mouse" && event.buttons === 0) {
      finish(event, active.type === "pan");
      return;
    }
    if (active.type === "draw" && active.stroke) {
      const samples = event.nativeEvent.getCoalescedEvents?.() || [event.nativeEvent];
      const points = samples.map(sample => world(point(sample)));
      active.stroke = { ...active.stroke, points: [...active.stroke.points, ...points] }; setDraft(active.stroke);
    } else state.pan(p.x - active.last.x, p.y - active.last.y, active.global);
    active.last = p;
  }
  function finish(event: ReactPointerEvent<HTMLDivElement>, cancel = false) {
    const active = gesture.current; if (!active || active.pointer !== event.pointerId) return;
    gesture.current = null; setDraft(null);
    if (active.type === "draw" && active.stroke && !cancel) useMobileInpaintStore.getState().update({ strokes: [...useMobileInpaintStore.getState().strokes, active.stroke] });
    else if (!cancel && !active.global) state.snap();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function wheel(event: ReactWheelEvent<HTMLDivElement>) { if (state.pixels && !state.busy) { event.preventDefault(); state.zoom(Math.exp(-event.deltaY * 0.0015), point(event)); } }
  const selected = state.candidates.find(c => c.id === state.selectedCandidateId) ?? state.candidates[0];
  const applied = selected && state.layers.some(layer => layer.id === selected.id);
  const worldRect = frameToWorld(state.frame, state.transform);
  return <main className="mobile-inpaint-workspace" aria-label={mt("新版局部重绘工作区")}>
    <div className="mobile-inpaint-tools" role="toolbar" aria-label={mt("新版重绘工具")}>
      <div className="mobile-inpaint-tool-modes">{toolLabels.map(([tool, label, title]) => <button key={tool} type="button" className={state.tool === tool ? "active" : ""} disabled={state.busy} aria-pressed={state.tool === tool} title={mt(title)} onClick={() => state.update({ tool })}>{mt(label)}</button>)}</div>
      <label className="mobile-inpaint-target">{mt("图层")}<select aria-label={mt("绘制图层")} value={state.target} disabled={state.busy} onChange={event => state.update({ target: event.target.value as "mask" | "image" })}><option value="mask">{mt("蒙版")}</option><option value="image">{mt("图像")}</option></select></label>
      <label className="mobile-inpaint-brush-size">{mt("笔宽")}<input aria-label={mt("新版画笔宽度")} type="number" min={1} max={512} value={state.brushSize} disabled={state.busy} onChange={event => state.update({ brushSize: Math.max(1, Math.min(512, Number(event.target.value) || 1)) })}/><span>px</span></label>
      <button type="button" title={mt("切换方形画笔")} aria-pressed={state.squareBrush} disabled={state.busy} onClick={() => state.update({ squareBrush: !state.squareBrush })}>{state.squareBrush ? mt("方笔") : mt("圆笔")}</button>
      {state.target === "image" && <input type="color" title={mt("图像画笔颜色")} aria-label={mt("图像画笔颜色")} value={state.brushColor} onChange={event => state.update({ brushColor: event.target.value })}/>}
    </div>
    <div className="mobile-inpaint-actions" role="toolbar" aria-label={mt("重绘视图与撤销")}>
      <button type="button" disabled={state.busy || !state.undoStack.length} onClick={state.undo} title={mt("撤销笔迹 Ctrl+Z")}>{mt("撤销")}</button>
      <button type="button" disabled={state.busy || !state.redoStack.length} onClick={state.redo} title={mt("重做笔迹 Ctrl+Shift+Z")}>{mt("重做")}</button>
      <button type="button" disabled={state.busy || !state.maskUndoStack.length} onClick={state.undoMask}>{mt("撤销蒙版")}</button>
      <button type="button" disabled={state.busy || !state.maskRedoStack.length} onClick={state.redoMask}>{mt("重做蒙版")}</button>
      <button type="button" className={state.showMask ? "active" : ""} aria-pressed={state.showMask} onClick={() => state.update({ showMask: !state.showMask })}>{state.showMask ? mt("隐藏蒙版") : mt("显示蒙版")}</button>
      <button type="button" disabled={!state.pixels || state.busy} onClick={() => state.zoom(1 / 1.2)} aria-label={mt("缩小当前工具")}>−</button>
      <span className="mobile-inpaint-zoom">{Math.round(state.transform.scale * 100)}%</span>
      <button type="button" disabled={!state.pixels || state.busy} onClick={() => state.zoom(1.2)} aria-label={mt("放大当前工具")}>＋</button>
      <button type="button" disabled={!state.pixels || state.busy} onClick={state.tool === "frame" ? state.resetFrame : state.fit}>{state.tool === "frame" ? mt("重置框") : mt("重置视图")}</button>
      <select aria-label={mt("更多重绘操作")} value="" disabled={state.busy || !state.pixels} onChange={event => { const action = event.target.value; if (action === "clear") state.clearStrokes(); else if (action === "clear-layer") state.clearStrokes(state.target); else if (action === "2" || action === "3") void state.scaleImage(Number(action) as 2 | 3); }}><option value="">{mt("更多")}</option><option value="clear-layer">{mt("清空当前图层笔迹")}</option><option value="clear">{mt("清空全部笔迹")}</option><option value="2">{mt("图片分辨率放大 2×")}</option><option value="3">{mt("图片分辨率放大 3×")}</option></select>
    </div>
    <div ref={stageRef} className={`mobile-inpaint-stage tool-${state.tool}`} tabIndex={0} aria-label={mt("新版重绘画布")} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)} onLostPointerCapture={event => finish(event, true)} onPointerLeave={() => setCursor(null)} onWheel={wheel} onContextMenu={event => event.preventDefault()}>
      <canvas ref={canvasRef}/>
      {!state.pixels && <div className="mobile-inpaint-empty"><strong>{mt("新版局部重绘")}</strong><p>{mt("在左侧导入图片，再移动输出框和绘制蒙版。")}</p><span>{mt("输出框可越过图片边缘，外侧区域作为待生成内容。")}</span></div>}
      {cursor && state.pixels && (state.tool === "brush" || state.tool === "erase") && !state.busy && <div className="mobile-inpaint-brush-cursor" style={{ left: cursor.x, top: cursor.y, width: state.brushSize * state.transform.scale, height: state.brushSize * state.transform.scale, borderRadius: state.squareBrush ? 0 : "50%" }}/>}
    </div>
    <div className="mobile-inpaint-status"><span>{state.pixels ? mt("底图 {width} × {height}", {width:state.pixels.width,height:state.pixels.height}) : mt("尚未导入图片")}</span><span title={mt("世界坐标中的输出区域")}>{mt("框")}{" "}{Math.round(worldRect.x)}, {Math.round(worldRect.y)} · {Math.round(worldRect.width)} × {Math.round(worldRect.height)}</span><span>{mt("滚轮缩放 · 空格/中键拖动整体")}</span></div>
    {(state.layers.length > 0 || state.candidates.length > 0) && <div className="mobile-inpaint-layers" aria-label={mt("重绘结果图层")}>
      <div className="mobile-inpaint-layers-heading"><strong>{mt("结果图层")}{" "}{state.layers.length}</strong>{state.candidates.length > 0 && <button type="button" onClick={() => state.update({ reviewOpen: true })}>{mt("查看候选")}{" "}{state.candidates.length}</button>}</div>
      {state.layers.map(layer => <div className="mobile-inpaint-layer" key={layer.id}><img src={layer.dataUrl} alt=""/><span>{mt(layer.name)}</span><button type="button" aria-pressed={layer.visible} aria-label={mt(layer.visible ? mt("隐藏{layer}") : mt("显示{layer}"),{layer:mt(layer.name)})} disabled={state.busy} onClick={() => state.toggleLayer(layer.id)}>{layer.visible ? mt("隐藏") : mt("显示")}</button><button type="button" aria-label={mt("移除{layer}",{layer:mt(layer.name)})} disabled={state.busy} onClick={() => state.removeLayer(layer.id)}>{mt("移除")}</button></div>)}
    </div>}
    {state.reviewOpen && selected && <section className="mobile-inpaint-review" role="dialog" aria-modal="true" aria-label={mt("重绘候选对比")}>
      <header><strong>{mt("重绘候选 ·")}{" "}{state.candidates.indexOf(selected) + 1} / {state.candidates.length}</strong><button type="button" onClick={() => state.update({ reviewOpen: false })}>{mt("关闭")}</button></header>
      <div className="mobile-inpaint-review-image">
        {selected.beforeUrl && <img src={selected.beforeUrl} alt={mt("重绘前")}/>}
        <div className="mobile-inpaint-review-after" style={{ clipPath: `inset(0 0 0 ${compare}%)` }}>{selected.beforeUrl && <img src={selected.beforeUrl} alt=""/>}<img src={selected.dataUrl} alt={mt("重绘后透明结果")}/></div>
        <div className="mobile-inpaint-compare-line" style={{ left: `${compare}%` }}/>
      </div>
      <label className="mobile-inpaint-compare-control"><span>{mt("重绘前")}</span><input aria-label={mt("候选前后对比位置")} type="range" min={0} max={100} value={compare} onChange={event => setCompare(Number(event.target.value))}/><span>{mt("重绘后")}</span></label>
      <div className="mobile-inpaint-candidate-list">{state.candidates.map((candidate, index) => <button type="button" className={candidate.id === selected.id ? "active" : ""} key={candidate.id} onClick={() => state.update({ selectedCandidateId: candidate.id })}><img src={candidate.generatedUrl || candidate.dataUrl} alt={mt("候选 {number}",{number:index+1})}/><span>{index + 1}{state.layers.some(l => l.id === candidate.id) ? mt("· 已应用") : ""}</span></button>)}</div>
      <footer><span>{selected.seed == null ? mt("Seed 未知") : `Seed ${selected.seed}`}</span><button type="button" disabled={state.busy || applied} onClick={() => state.discardCandidate(selected.id)}>{mt("丢弃此候选")}</button><button className="primary" type="button" disabled={state.busy || applied} onClick={() => state.applyCandidate(selected.id)}>{applied ? mt("已应用") : mt("应用到画布")}</button></footer>
    </section>}
  </main>;
}

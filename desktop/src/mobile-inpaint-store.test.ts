import { beforeEach, expect, it } from "vitest";
import { useMobileInpaintStore as store, type MobileCandidate } from "./mobile-inpaint-store";
import { frameToWorld, type MobileStroke } from "./mobile-inpaint";

beforeEach(() => store.setState(store.getInitialState(), true));
const pixels = { width: 2, height: 2, data: new Uint8ClampedArray(16).fill(255) };
const maskStroke = (x: number): MobileStroke => ({ target: "mask", mode: "paint", size: 10, points: [{ x, y: 0 }] });
function add(stroke: MobileStroke) { store.getState().update({ target: stroke.target }); store.getState().checkpoint(); store.getState().update({ strokes: [...store.getState().strokes, stroke] }); }

it("changing processing resolution keeps the frame center and width, independently of source pixels", () => {
  store.setState({ pixels, frame: { x: -80, y: 20, width: 400, height: 300 }, transform: { scale: 2, offsetX: 4, offsetY: 5 } });
  store.getState().setOutput({ width: 1216, height: 832 });
  const state = store.getState();
  expect(state.frame.width).toBe(400);
  expect(state.frame.x + state.frame.width / 2).toBe(120);
  expect(state.frame.y + state.frame.height / 2).toBe(170);
  expect(state.frame.height).toBeCloseTo(400 * 832 / 1216);
  expect(state.pixels).toBe(pixels);
  state.setOutput({ width: NaN, height: 1024 });
  expect(store.getState().output).toEqual({ width: 1216, height: 832 });
});

it("moving and scaling the output frame allows complete outpainting without moving the source", () => {
  store.setState({ pixels, tool: "frame", frame: { x: 50, y: 60, width: 100, height: 100 }, output: { width: 1024, height: 1024 } });
  store.getState().pan(-2000, 2000);
  store.getState().zoom(2);
  const state = store.getState();
  expect(state.transform).toEqual({ scale: 1, offsetX: 0, offsetY: 0 });
  expect(frameToWorld(state.frame, state.transform)).toEqual({ x: -2000, y: 2010, width: 200, height: 200 });
});

it("mask-only history after a global undo skips duplicate snapshots and preserves image brush marks", () => {
  const first = maskStroke(1), second = maskStroke(2), image: MobileStroke = { ...maskStroke(3), target: "image" };
  add(first); add(image); add(second);
  store.getState().undo();
  expect(store.getState().strokes).toEqual([first, image]);
  store.getState().undoMask();
  expect(store.getState().strokes).toEqual([image]);
  store.getState().redoMask();
  expect(store.getState().strokes).toEqual([image, first]);
  expect(store.getState().pixels).toBeNull();
});

it("applying another candidate in the same batch replaces exactly one result layer and leaves source and other batches intact", () => {
  const candidate = (id: string, batchId: string): MobileCandidate => ({ id, batchId, image: pixels, worldRect: { x: -2, y: 1, width: 2, height: 2 }, dataUrl: "data:image/png;base64,fixture" });
  store.setState({ pixels });
  store.getState().setCandidates([candidate("A", "one"), candidate("B", "one"), candidate("C", "two")]);
  expect(store.getState().layers).toHaveLength(0);
  store.getState().applyCandidate("A"); store.getState().applyCandidate("C"); store.getState().applyCandidate("B");
  expect(store.getState().layers.map(layer => layer.id)).toEqual(["B", "C"]);
  expect(store.getState().layers[0].name).toBe("重绘 1");
  expect(store.getState().layers[0].worldRect.x).toBe(-2);
  expect(store.getState().pixels).toBe(pixels);
  store.getState().toggleLayer("B");
  expect(store.getState().layers[0].visible).toBe(false);
  store.getState().discardCandidate("B");
  expect(store.getState().candidates).toHaveLength(3);
  store.getState().removeLayer("B"); store.getState().discardCandidate("B");
  expect(store.getState().layers.map(layer => layer.id)).toEqual(["C"]);
  expect(store.getState().candidates.map(c => c.id)).toEqual(["A", "C"]);
});

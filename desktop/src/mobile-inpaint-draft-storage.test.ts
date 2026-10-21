import { afterEach, expect, it, vi } from "vitest";
import { loadMobileInpaintPromptDrafts, loadMobileInpaintWorkspaceDrafts, saveMobileInpaintPromptDrafts, saveMobileInpaintWorkspaceDrafts } from "./mobile-inpaint-draft-storage";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem(key: string) { return values.get(key) ?? null; },
    setItem(key: string, value: string) { values.set(key, value); },
  };
}

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it("persists positive and negative drafts in distinct keys without touching global prompt storage", () => {
  const storage = memoryStorage();
  saveMobileInpaintPromptDrafts({ prompt: "portrait", negative: "blur" }, storage);
  expect([...storage.values.keys()].sort()).toEqual([
    "worldpainter.mobile-inpaint.negative-draft.v1",
    "worldpainter.mobile-inpaint.prompt-draft.v1",
  ]);
  expect(loadMobileInpaintPromptDrafts(storage)).toEqual({ prompt: "portrait", negative: "blur" });
});

it("ignores malformed fields independently and validates persisted output sizes", () => {
  const storage = memoryStorage({
    "worldpainter.mobile-inpaint.prompt-draft.v1": "{broken",
    "worldpainter.mobile-inpaint.negative-draft.v1": JSON.stringify({ version: 1, value: "safe" }),
    "worldpainter.mobile-inpaint.workspace-draft.v1": JSON.stringify({ version: 1,
      output: { width: 1000, height: 832 }, customOutputs: [{ width: 1024, height: 832 }, { width: 1024, height: 832 }, { width: 900, height: 832 }] }),
  });
  expect(loadMobileInpaintPromptDrafts(storage)).toEqual({ prompt: "", negative: "safe" });
  expect(loadMobileInpaintWorkspaceDrafts(storage)).toEqual({ output: { width: 832, height: 1216 }, customOutputs: [{ width: 1024, height: 832 }] });
});

it("continues working when storage is absent, throws, or rejects writes", async () => {
  vi.stubGlobal("localStorage", undefined);
  expect(loadMobileInpaintPromptDrafts(undefined)).toEqual({ prompt: "", negative: "" });
  expect(loadMobileInpaintWorkspaceDrafts(undefined)).toEqual({ output: { width: 832, height: 1216 }, customOutputs: [] });
  const rejected = { getItem() { throw Error("denied"); }, setItem() { throw Error("quota"); } };
  expect(loadMobileInpaintPromptDrafts(rejected)).toEqual({ prompt: "", negative: "" });
  expect(loadMobileInpaintWorkspaceDrafts(rejected).output).toEqual({ width: 832, height: 1216 });
  expect(() => saveMobileInpaintPromptDrafts({ prompt: "a", negative: "b" }, rejected)).not.toThrow();
  expect(() => saveMobileInpaintWorkspaceDrafts({ output: { width: 832, height: 1216 }, customOutputs: [] }, rejected)).not.toThrow();

  vi.resetModules();
  const { useMobileInpaintStore } = await import("./mobile-inpaint-store");
  expect(useMobileInpaintStore.getState().prompt).toBe("");
  expect(useMobileInpaintStore.getState().negative).toBe("");
});

it("restores prompt, negative, selected output, and custom sizes on a cold store import", async () => {
  const storage = memoryStorage();
  saveMobileInpaintPromptDrafts({ prompt: "new positive", negative: "new negative" }, storage);
  saveMobileInpaintWorkspaceDrafts({ output: { width: 1024, height: 832 }, customOutputs: [{ width: 1024, height: 832 }] }, storage);
  vi.stubGlobal("localStorage", storage);
  vi.resetModules();
  const { useMobileInpaintStore } = await import("./mobile-inpaint-store");
  const state = useMobileInpaintStore.getState();
  expect(state.prompt).toBe("new positive");
  expect(state.negative).toBe("new negative");
  expect(state.output).toEqual({ width: 1024, height: 832 });
  expect(state.customOutputs).toEqual([{ width: 1024, height: 832 }]);
  state.update({ prompt: "edited positive", negative: "edited negative" });
  state.setOutput({ width: 1216, height: 832 });
  expect(state.addCustomOutput({ width: 1088, height: 832 })).toBe(true);
  expect(JSON.parse(storage.values.get("worldpainter.mobile-inpaint.prompt-draft.v1")!)).toEqual({ version: 1, value: "edited positive" });
  expect(JSON.parse(storage.values.get("worldpainter.mobile-inpaint.negative-draft.v1")!)).toEqual({ version: 1, value: "edited negative" });
  expect(JSON.parse(storage.values.get("worldpainter.mobile-inpaint.workspace-draft.v1")!).output).toEqual({ width: 1216, height: 832 });
});

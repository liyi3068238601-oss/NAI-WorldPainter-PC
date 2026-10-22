import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS, type GenerateParams } from "../types";
import type { R4WorkbenchSnapshot } from "./r4-workbench-contract";
import {
  prepareWorkbenchParameterPatch,
  workbenchParameterControls,
  workbenchParameters,
} from "./workbench-parameters";

function snapshot(
  params: Partial<GenerateParams> = {},
  workbench: Partial<NonNullable<R4WorkbenchSnapshot["workbench"]>> = {},
): R4WorkbenchSnapshot {
  return {
    draftId: "draft",
    draftRevision: 1,
    inputRevision: 1,
    draftSource: "workbench",
    params: { ...DEFAULT_PARAMS, ...params },
    workbench: {
      mode: "generate:t2i",
      modelMode: "anime",
      imageProvider: "novelai",
      batchCount: 1,
      batchIntervalSeconds: 0,
      charCaptions: [],
      vibeImages: [],
      preciseReferences: [],
      ...workbench,
    },
  };
}

describe("R4 workbench parameter contract", () => {
  it("exposes only safe scalar settings and capability-filtered controls", () => {
    const state = snapshot(
      { positivePrompt: "private prompt" },
      {
        source: { filePath: "C:/private/source.png", width: 1280, height: 720 },
      },
    );
    const values = workbenchParameters(state);
    const controls = workbenchParameterControls(state);

    expect(values).toMatchObject({ model: DEFAULT_PARAMS.model, seedMode: "random", batchCount: 1 });
    expect(values).not.toHaveProperty("positivePrompt");
    expect(values).not.toHaveProperty("source");
    expect(JSON.stringify(values)).not.toContain("private");
    expect(controls.writeSupported).toBe(true);
    expect(controls.effectiveParameters).toMatchObject({
      model: DEFAULT_PARAMS.model,
      width: DEFAULT_PARAMS.width,
      height: DEFAULT_PARAMS.height,
    });
    expect(controls.models.map((model) => model.value)).not.toContain("nai-diffusion-furry-3");
    expect(controls.editableFields).not.toContain("noiseSchedule");
    expect(controls.limits).toEqual({
      dimensionStep: 64,
      maxPixelArea: 3_145_728,
      maxBatchCount: 999,
      maxAssistantGenerationCount: 8,
    });
  });

  it("rejects non-NovelAI providers and unsupported workbench modes", () => {
    const openAI = workbenchParameterControls(snapshot({}, { imageProvider: "openai-images" }));
    const inpaint = workbenchParameterControls(snapshot({}, { mode: "inpaint" }));

    expect(openAI.writeSupported).toBe(false);
    expect(openAI.reason).toContain("OpenAI Images");
    expect(openAI.editableFields).toEqual([]);
    expect(openAI.models).toEqual([]);
    expect(inpaint.writeSupported).toBe(false);
    expect(() => prepareWorkbenchParameterPatch(
      snapshot({}, { imageProvider: "openai-images" }),
      { steps: 24 },
    )).toThrow("OpenAI Images");
  });

  it("strictly validates sizes, numeric ranges, enums, and unsupported keys", () => {
    expect(() => prepareWorkbenchParameterPatch(snapshot(), { width: 65 })).toThrow("64 的倍数");
    expect(() => prepareWorkbenchParameterPatch(snapshot(), { width: 2048, height: 1600 })).toThrow("总像素");
    expect(() => prepareWorkbenchParameterPatch(snapshot(), { steps: 1.5 })).toThrow("整数");
    expect(() => prepareWorkbenchParameterPatch(snapshot(), { cfgScale: 11 })).toThrow("范围内");
    expect(() => prepareWorkbenchParameterPatch(snapshot(), { batchCount: 1000 })).toThrow("范围内");
    expect(() => prepareWorkbenchParameterPatch(snapshot(), { sampler: "not-a-sampler" })).toThrow("采样器");
    expect(() => prepareWorkbenchParameterPatch(snapshot(), { noise: 0.2 })).toThrow("不支持独立修改");
    expect(prepareWorkbenchParameterPatch(snapshot(), { cfgScale: 0 }).params.cfgScale).toBe(0);
    expect(prepareWorkbenchParameterPatch(snapshot(), { width: 49_152, height: 64 }).params.width).toBe(49_152);
  });

  it("derives a fixed seed and returns the effective preview value", () => {
    const result = prepareWorkbenchParameterPatch(snapshot(), { seed: 42 });
    expect(result.params).toMatchObject({ seed: 42, seedMode: "fixed" });
    expect(result.parameters).toMatchObject({ seed: 42, seedMode: "fixed" });
    expect(result.changedFields).toContain("seedMode");

    const explicitlyRandom = prepareWorkbenchParameterPatch(
      snapshot(),
      { seed: 42, seedMode: "random" },
    );
    expect(explicitlyRandom.params.seedMode).toBe("random");
  });

  it("requires effective values for V5 Medium and validates model transitions", () => {
    const medium = snapshot({ effort: "medium" });
    const controls = workbenchParameterControls(medium);
    expect(controls.editableFields).not.toContain("steps");
    expect(controls.effectiveParameters).toMatchObject({
      steps: 14,
      sampler: "k_euler_ancestral",
      cfgRescale: 0,
      ucPreset: 0,
    });
    expect(() => prepareWorkbenchParameterPatch(medium, { steps: 15 })).toThrow("固定 steps=14");
    expect(prepareWorkbenchParameterPatch(medium, { steps: 14 }).params.steps).toBe(14);
    expect(() => prepareWorkbenchParameterPatch(medium, {
      model: "nai-diffusion-4-5-full",
    })).toThrow("High");
    expect(() => prepareWorkbenchParameterPatch(
      snapshot({ noiseSchedule: "native" }),
      { model: "nai-diffusion-4-5-full" },
    )).not.toThrow();
  });

  it("checks model-specific flags and requires explicit cleanup when downgrading", () => {
    expect(() => prepareWorkbenchParameterPatch(snapshot(), { variety: true })).toThrow("Variety");
    expect(() => prepareWorkbenchParameterPatch(snapshot(), { noiseSchedule: "native" })).toThrow("V5");
    expect(() => prepareWorkbenchParameterPatch(snapshot(), { smeaDyn: true })).toThrow("SMEA");
    expect(() => prepareWorkbenchParameterPatch(snapshot(), { qualityPreset: "light" })).not.toThrow();

    const oldModel = snapshot({
      qualityPreset: "light",
      transparentBackground: true,
    });
    expect(() => prepareWorkbenchParameterPatch(oldModel, {
      model: "nai-diffusion-4-5-full",
    })).toThrow("Light");
    const cleaned = prepareWorkbenchParameterPatch(oldModel, {
      model: "nai-diffusion-4-5-full",
      qualityPreset: "standard",
      transparentBackground: false,
    });
    expect(cleaned.params).toMatchObject({
      model: "nai-diffusion-4-5-full",
      qualityPreset: "standard",
      transparentBackground: false,
    });
    expect(() => prepareWorkbenchParameterPatch(
      snapshot({ model: "nai-diffusion-5-full", smea: true, smeaDyn: true }),
      { model: "nai-diffusion-4-5-full" },
    )).toThrow("SMEA");
  });

  it("does not block ordinary parameter changes on unrelated stale reference flags", () => {
    const state = snapshot(
      { smea: true, smeaDyn: true, variety: true },
      { vibeImages: [{}], preciseReferences: [{}] },
    );
    expect(prepareWorkbenchParameterPatch(state, { steps: 30 }).params.steps).toBe(30);
  });

  it("checks active characters and model-bound references before switching model", () => {
    expect(() => prepareWorkbenchParameterPatch(
      snapshot({}, { charCaptions: [{ prompt: "character" }] }),
      { model: "nai-diffusion-3" },
    )).toThrow("角色提示");
    expect(() => prepareWorkbenchParameterPatch(
      snapshot({ model: "nai-diffusion-4-5-full" }, { vibeImages: [{}] }),
      { model: "nai-diffusion-5-full" },
    )).toThrow("Vibe");
    expect(() => prepareWorkbenchParameterPatch(
      snapshot({ model: "nai-diffusion-4-5-full" }, { preciseReferences: [{}] }),
      { model: "nai-diffusion-5-full" },
    )).toThrow("精准参考");
    expect(() => prepareWorkbenchParameterPatch(
      snapshot({}, { modelMode: "furry" }),
      { model: "nai-diffusion-3" },
    )).toThrow("anime/furry");
  });

  it("switches img2img custom dimensions safely and preserves unconsumed state", () => {
    const img2img = snapshot({}, {
      mode: "generate:i2i",
      i2iSizeMode: "adaptive",
      i2iParams: { strength: 0.7, noise: 0.1, extraNoiseSeed: 17 },
    });
    const sized = prepareWorkbenchParameterPatch(img2img, { width: 768, height: 1024 });
    expect(sized.workbench.i2iSizeMode).toBe("custom");
    expect(sized.changedFields).toContain("i2iSizeMode");

    const strength = prepareWorkbenchParameterPatch(img2img, { strength: 0.35 });
    expect(strength.workbench.i2iParams).toMatchObject({ strength: 0.35, noise: 0.1, extraNoiseSeed: 17 });
    expect(strength.parameters.strength).toBe(0.35);
    expect(() => prepareWorkbenchParameterPatch(img2img, {
      width: 768,
      i2iSizeMode: "adaptive",
    })).toThrow("custom");
    expect(() => prepareWorkbenchParameterPatch(snapshot(), { strength: 0.4 })).toThrow("图生图");
  });

  it("removes only metadata replay values that overlap changed controls", () => {
    const state = snapshot({
      metadataReplay: {
        model: DEFAULT_PARAMS.model,
        parameters: {
          cfg_rescale: 0,
          dynamic_thresholding: false,
          straight_alpha: true,
          quality_boost: true,
          uncond_scale: 2,
        },
        positive: { use_order: false },
      },
    });
    const result = prepareWorkbenchParameterPatch(state, {
      cfgRescale: 0.4,
      qualityPreset: "standard",
      transparentBackground: false,
    });
    expect(result.params.metadataReplay?.parameters).toEqual({ uncond_scale: 2 });
    expect(result.params.metadataReplay?.positive).toEqual({ use_order: false });
    expect(result.changedFields).toEqual(expect.arrayContaining([
      "metadataReplay.parameters.cfg_rescale",
      "metadataReplay.parameters.dynamic_thresholding",
      "metadataReplay.parameters.quality_boost",
      "metadataReplay.parameters.straight_alpha",
    ]));
  });

  it("projects metadata replay only when the request would apply it", () => {
    const replay = {
      model: DEFAULT_PARAMS.model,
      parameters: { straight_alpha: true, quality_boost: true, controlnet_strength: 9 },
    };
    const matching = workbenchParameterControls(snapshot({ metadataReplay: replay }));
    expect(matching.metadataReplayOverrides).toEqual({
      straight_alpha: true,
      quality_boost: true,
    });
    expect(matching.effectiveParameters.transparentBackground).toBe(true);

    const mismatched = workbenchParameterControls(snapshot({
      transparentBackground: false,
      metadataReplay: { ...replay, model: "nai-diffusion-4-5-full" },
    }));
    expect(mismatched).not.toHaveProperty("metadataReplayOverrides");
    expect(mismatched.effectiveParameters.transparentBackground).toBe(false);

    const medium = workbenchParameterControls(snapshot({
      effort: "medium",
      transparentBackground: false,
      metadataReplay: replay,
    }));
    expect(medium).not.toHaveProperty("metadataReplayOverrides");
    expect(medium.effectiveParameters.transparentBackground).toBe(false);
  });
});

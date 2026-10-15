import { describe, expect, it } from "vitest";
import { LOCAL_SR_MAX_PIXELS, planLocalSuperResolution } from "./local-super-resolution";

describe("local super-resolution planning", () => {
  it("shows the model scale and exact output pixel count", () => {
    expect(planLocalSuperResolution(1000, 800, "realcuganConservative2x")).toMatchObject({
      scale: 2,
      outputWidth: 2000,
      outputHeight: 1600,
      outputPixels: 3_200_000,
      withinPixelLimit: true,
    });
  });

  it("applies the 32 MP limit to both source and expected result", () => {
    expect(planLocalSuperResolution(2000, 2000, "realcuganConservative4x").withinPixelLimit).toBe(false);
    expect(planLocalSuperResolution(4096, 2048, "realcuganConservative2x").withinPixelLimit).toBe(true);
    expect(LOCAL_SR_MAX_PIXELS).toBe(32 * 1024 * 1024);
  });

  it("rejects unsupported models and invalid dimensions", () => {
    expect(() => planLocalSuperResolution(32, 32, "cloud-upscale")).toThrow("Unsupported");
    expect(() => planLocalSuperResolution(0, 32, "realcuganConservative2x")).toThrow("positive integers");
  });
});

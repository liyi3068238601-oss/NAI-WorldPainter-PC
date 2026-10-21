import { describe, expect, it } from "vitest";
import { mobileInpaintAfterClip, mobileInpaintComparePercent } from "./mobile-inpaint-comparison";

describe("mobile inpaint candidate comparison", () => {
  it("maps pointer movement to a clamped after-left reveal", () => {
    expect(mobileInpaintComparePercent(125, 100, 200)).toBe(12.5);
    expect(mobileInpaintComparePercent(-20, 0, 100)).toBe(0);
    expect(mobileInpaintComparePercent(120, 0, 100)).toBe(100);
    expect(mobileInpaintComparePercent(20, 0, 0)).toBeNull();
    expect(mobileInpaintAfterClip(25)).toBe("inset(0 75% 0 0)");
    expect(mobileInpaintAfterClip(100)).toBe("inset(0 0% 0 0)");
  });
});

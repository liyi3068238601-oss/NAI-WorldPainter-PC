import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import LocalSuperResolutionSettings, { localSuperResolutionLanguage } from "./LocalSuperResolutionSettings";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("local super-resolution settings", () => {
  it("uses Chinese only for Chinese locales and falls back to English for other or missing locales", () => {
    expect(localSuperResolutionLanguage("zh-CN")).toBe("zh");
    expect(localSuperResolutionLanguage("zh-TW")).toBe("zh");
    for (const language of ["en-US", "ja-JP", "ko-KR", undefined]) {
      expect(localSuperResolutionLanguage(language)).toBe("en");
    }
  });

  it("keeps local layout away from global modal header rules and wraps at narrow widths", () => {
    vi.stubGlobal("window", { naiDesktop: {} });
    const markup = renderToStaticMarkup(<LocalSuperResolutionSettings />);
    const css = readFileSync("src/components/LocalSuperResolutionSettings.css", "utf8");
    expect(markup).not.toContain("<header");
    expect(markup).toContain('class="local-sr-card-heading"');
    expect(css).toContain("flex-wrap: wrap");
    expect(css).toContain("min-width: 0");
    expect(css).toContain("@media (max-width: 560px)");
  });
});

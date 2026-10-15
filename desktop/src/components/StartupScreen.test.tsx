import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StartupScreen } from "./StartupScreen";

describe("StartupScreen", () => {
  it("renders the selected portrait artwork and a localized startup status", () => {
    const markup = renderToStaticMarkup(<StartupScreen language="en-US" onRetry={() => {}} />);

    expect(markup).toContain('src="./worldpainter/onboarding-style-preset-001.jpg"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain("Preparing your workspace…");
    expect(markup).not.toContain("splash.png");
  });

  it("renders a retriable boot error instead of the loading status", () => {
    const markup = renderToStaticMarkup(
      <StartupScreen language="en-US" bootError="Settings could not be read." onRetry={() => {}} />,
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Settings could not be read.");
    expect(markup).toContain("Retry");
    expect(markup).not.toContain('role="status"');
  });
});

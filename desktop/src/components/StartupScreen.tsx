import { APP_NAME, APP_VERSION, type AppSettings } from "../types";
import { desktopUiText } from "../i18n";
import { Button } from "./ui";
import "./StartupScreen.css";

const startupArtwork = "./worldpainter/onboarding-style-preset-001.jpg";

function startupStatus(language: AppSettings["language"] = "zh-CN") {
  switch (language) {
    case "zh-TW": return "正在準備你的創作工作區…";
    case "en-US": return "Preparing your workspace…";
    case "ja-JP": return "制作ワークスペースを準備しています…";
    case "ko-KR": return "창작 작업 공간을 준비하고 있어요…";
    default: return "正在准备你的创作工作区…";
  }
}

export function StartupScreen({
  language = "zh-CN",
  bootError,
  onRetry,
}: {
  language?: AppSettings["language"];
  bootError?: string | null;
  onRetry: () => void;
}) {
  return (
    <main className="startup-screen" aria-label={APP_NAME}>
      <div className="startup-screen__art" aria-hidden="true">
        <div className="startup-screen__image-frame">
          <img
            className="startup-screen__image"
            src={startupArtwork}
            alt=""
            draggable={false}
            decoding="async"
            fetchPriority="high"
          />
        </div>
      </div>

      <section className="startup-screen__panel" aria-labelledby="startup-screen-title">
        <div className="startup-screen__brand">
          <img className="startup-screen__brand-icon" src="./icon.png" alt="" />
          <div>
            <p className="startup-screen__eyebrow">NAI WORLDPAINTER · PC</p>
            <h1 id="startup-screen-title">{APP_NAME}</h1>
          </div>
        </div>

        <span className="startup-screen__rule" aria-hidden="true" />
        <p className="startup-screen__subtitle">{desktopUiText(language, "splash.subtitle")}</p>

        {bootError ? (
          <div className="startup-screen__error" role="alert">
            <p>{bootError}</p>
            <Button className="startup-screen__retry" variant="primary" onClick={onRetry}>
              {desktopUiText(language, "splash.retry")}
            </Button>
          </div>
        ) : (
          <div className="startup-screen__loading" role="status" aria-live="polite">
            <span className="startup-screen__spinner" aria-hidden="true" />
            <span>{startupStatus(language)}</span>
          </div>
        )}

        <p className="startup-screen__version">v{APP_VERSION}</p>
      </section>
    </main>
  );
}

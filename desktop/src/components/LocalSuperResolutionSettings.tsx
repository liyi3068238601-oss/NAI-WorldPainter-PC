import { useEffect, useMemo, useState } from "react";
import { LOCAL_SR_MAX_PIXELS, LOCAL_SR_MODELS, planLocalSuperResolution, type LocalSrProgress, type LocalSrRuntimeStatus, type LocalSrRunResult, type LocalSrSourceSelection } from "../local-super-resolution";
import { useAppStore } from "../store";
import { Button } from "./ui";
import "./LocalSuperResolutionSettings.css";

interface LocalSuperResolutionBridge {
  localSrGetStatus?: () => Promise<LocalSrRuntimeStatus>;
  localSrChooseRuntimeDirectory?: () => Promise<LocalSrRuntimeStatus | null>;
  localSrPickSource?: () => Promise<LocalSrSourceSelection | null>;
  localSrRun?: (request: { selectionId: string; modelId: string; confirmed: true }) => Promise<LocalSrRunResult>;
  localSrCancel?: () => Promise<void>;
  onLocalSrProgress?: (callback: (progress: LocalSrProgress) => void) => () => void;
}

function bridge() {
  return window.naiDesktop as unknown as LocalSuperResolutionBridge;
}

export function localSuperResolutionLanguage(language: string | undefined): "zh" | "en" {
  return language?.startsWith("zh") ? "zh" : "en";
}

const copy = {
  zh: {
    title: "Windows 本地超分",
    intro: "在本机使用 Real-ESRGAN 或 Real-CUGAN；不会调用在线超分服务。",
    runtime: "模型运行目录",
    runtimeAuto: "自动发现",
    runtimeChoose: "选择运行目录",
    runtimeMissing: "未发现可用模型。运行目录应包含 realesrgan 和/或 realcugan 文件夹。",
    source: "源图片",
    chooseSource: "选择图片",
    model: "超分模型",
    availableModels: "可用模型：",
    unavailable: "未安装",
    input: "输入尺寸",
    expected: "预计输出",
    boundary: "本地任务要求输入与输出都不超过 32 MP。源图和结果图各限制为 64 MB。",
    exceeded: "预计结果超过 32 MP，请缩小图片或选择较低倍率。",
    confirm: "我已检查源图、模型和预计尺寸，并确认开始本地处理。",
    run: "放大并保存",
    running: "正在本机处理…",
    cancel: "取消处理",
    saved: "已保存",
    missingApi: "本地超分尚未连接到桌面服务。",
    noSource: "尚未选择源图片。",
    noOutput: "选择图片与模型后，这里会显示预计尺寸。",
    failure: "处理失败：{message}",
  },
  en: {
    title: "Windows Local Super-Resolution",
    intro: "Run Real-ESRGAN or Real-CUGAN on this PC. No online upscaling service is used.",
    runtime: "Model runtime folder",
    runtimeAuto: "Auto-discovered",
    runtimeChoose: "Choose runtime folder",
    runtimeMissing: "No usable model found. The folder should contain realesrgan and/or realcugan.",
    source: "Source image",
    chooseSource: "Choose image",
    model: "Model",
    availableModels: "Available models:",
    unavailable: "Not installed",
    input: "Input size",
    expected: "Expected output",
    boundary: "Both input and output must stay within 32 MP. Source and result files are each limited to 64 MB.",
    exceeded: "Expected output exceeds 32 MP. Resize the image or choose a lower scale.",
    confirm: "I checked the source, model, and expected size, and confirm local processing.",
    run: "Upscale and save",
    running: "Processing locally…",
    cancel: "Cancel processing",
    saved: "Saved",
    missingApi: "Local super-resolution is not connected to the desktop service yet.",
    noSource: "No source image selected.",
    noOutput: "Choose an image and model to see the expected dimensions.",
    failure: "Processing failed: {message}",
  },
} as const;

function interpolate(template: string, values: Record<string, string | number>) {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ""));
}

function formatPixels(pixels: number) {
  return `${(pixels / 1_000_000).toFixed(2)} MP`;
}

export interface LocalSuperResolutionSettingsProps {
  onClose?: () => void;
}

export default function LocalSuperResolutionSettings({ onClose }: LocalSuperResolutionSettingsProps) {
  const language = useAppStore((state) => localSuperResolutionLanguage(state.settings?.language));
  const text = copy[language];
  const api = bridge();
  const [status, setStatus] = useState<LocalSrRuntimeStatus | null>(null);
  const [selection, setSelection] = useState<LocalSrSourceSelection | null>(null);
  const [modelId, setModelId] = useState<string>(LOCAL_SR_MODELS[0].id);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<LocalSrProgress | null>(null);
  const [result, setResult] = useState<Extract<LocalSrRunResult, { ok: true }> | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    if (typeof api.localSrGetStatus === "function") {
      void api.localSrGetStatus().then((next) => { if (active) setStatus(next); })
        .catch((error) => { if (active) setMessage(String(error)); });
    }
    const unsubscribe = api.onLocalSrProgress?.((next) => { if (active) setProgress(next); });
    return () => { active = false; unsubscribe?.(); };
  }, []);

  const model = LOCAL_SR_MODELS.find((item) => item.id === modelId) ?? LOCAL_SR_MODELS[0];
  const plan = useMemo(() => selection ? planLocalSuperResolution(selection.width, selection.height, model.id) : null, [model.id, selection]);
  const installedModels = new Set(status?.models ?? []);
  const ready = typeof api.localSrRun === "function" && !!status?.available
    && installedModels.has(model.id) && !!plan?.withinPixelLimit;

  async function chooseRuntime() {
    if (typeof api.localSrChooseRuntimeDirectory !== "function") { setMessage(text.missingApi); return; }
    try {
      const next = await api.localSrChooseRuntimeDirectory();
      if (next) { setStatus(next); setMessage(next.reason ?? ""); }
    } catch (error) { setMessage(String(error)); }
  }

  async function chooseSource() {
    if (typeof api.localSrPickSource !== "function") { setMessage(text.missingApi); return; }
    try {
      const next = await api.localSrPickSource();
      if (next) {
        setSelection(next);
        setConfirmed(false);
        setResult(null);
        setMessage("");
      }
    } catch (error) { setMessage(String(error)); }
  }

  async function run() {
    if (!selection || !ready || !confirmed || !api.localSrRun) return;
    setBusy(true);
    setMessage("");
    setResult(null);
    setProgress({ message: text.running, percent: 0 });
    try {
      const response = await api.localSrRun({ selectionId: selection.selectionId, modelId: model.id, confirmed: true });
      if (response.ok) setResult(response);
      else setMessage(response.cancelled ? response.message : interpolate(text.failure, { message: response.message }));
    } catch (error) {
      setMessage(interpolate(text.failure, { message: String(error) }));
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    await api.localSrCancel?.();
  }

  const dimensions = (width: number, height: number) => `${width.toLocaleString()} × ${height.toLocaleString()}`;

  return <section className="local-sr-settings" aria-label={text.title}>
    <div className="local-sr-heading">
      <div className="local-sr-heading-copy"><h2>{text.title}</h2><p>{text.intro}</p></div>
      {onClose && <Button onClick={onClose}>×</Button>}
    </div>
    {typeof api.localSrGetStatus !== "function" && <p role="status">{text.missingApi}</p>}
    <section className="local-sr-card">
      <div className="local-sr-card-heading">
        <strong>{text.runtime}</strong>
        <Button disabled={busy} onClick={() => void chooseRuntime()}>{text.runtimeChoose}</Button>
      </div>
      <code style={{ overflowWrap: "anywhere" }}>{status?.runtimeRoot ?? text.runtimeAuto}</code>
      {status && !status.available && <p role="status" style={{ margin: 0 }}>{status.reason ?? text.runtimeMissing}</p>}
      {status?.available && <p role="status" style={{ margin: 0 }}>{text.availableModels}{status.models.map((id) => LOCAL_SR_MODELS.find((item) => item.id === id)?.label ?? id).join(" · ")}</p>}
    </section>
    <section className="local-sr-card">
      <div className="local-sr-card-heading">
        <strong>{text.source}</strong>
        <Button disabled={busy} onClick={() => void chooseSource()}>{text.chooseSource}</Button>
      </div>
      {selection
        ? <div className="local-sr-source-row">
          <img className="local-sr-preview" src={selection.previewUrl} alt={selection.fileName} />
          <div className="local-sr-source-details">
            <strong style={{ overflowWrap: "anywhere" }}>{selection.fileName}</strong>
            <span>{text.input}: {dimensions(selection.width, selection.height)} · {formatPixels(selection.width * selection.height)} · {(selection.bytes / 1024 / 1024).toFixed(2)} MB</span>
            {plan && <span>{text.expected}: {dimensions(plan.outputWidth, plan.outputHeight)} · {formatPixels(plan.outputPixels)}</span>}
            {plan && !plan.withinPixelLimit && <strong role="alert" style={{ color: "var(--danger, #f66)" }}>{text.exceeded}</strong>}
          </div>
        </div>
        : <p style={{ margin: 0, opacity: 0.75 }}>{text.noSource}</p>}
      <label style={{ display: "grid", gap: 6 }}>
        {text.model}
        <select value={model.id} disabled={busy} onChange={(event) => { setModelId(event.target.value); setConfirmed(false); setResult(null); }}>
          {LOCAL_SR_MODELS.map((item) => <option key={item.id} value={item.id}>{item.label}{installedModels.has(item.id) ? "" : ` · ${text.unavailable}`}</option>)}
        </select>
      </label>
      <small style={{ opacity: 0.8 }}>{text.boundary} ({formatPixels(LOCAL_SR_MAX_PIXELS)})</small>
      {plan?.withinPixelLimit && <label style={{ display: "flex", gap: 8, alignItems: "start" }}>
        <input type="checkbox" disabled={busy} checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
        <span>{text.confirm}</span>
      </label>}
      {selection && plan && !plan.withinPixelLimit && <p style={{ margin: 0 }}>{text.exceeded}</p>}
      {!selection && <small style={{ opacity: 0.7 }}>{text.noOutput}</small>}
      <div className="local-sr-actions">
        <Button disabled={busy || !ready || !confirmed} onClick={() => void run()}>{busy ? text.running : text.run}</Button>
        {busy && <Button onClick={() => void cancel()}>{text.cancel}</Button>}
      </div>
      {busy && progress && <div role="status" aria-live="polite" style={{ display: "grid", gap: 5 }}>
        <span>{progress.message} · {progress.percent}%</span>
        <progress max={100} value={progress.percent} />
      </div>}
      {message && <p role="status" style={{ margin: 0 }}>{message}</p>}
      {result && <div role="status" style={{ display: "grid", gap: 8 }}>
        <strong>{text.saved}: {result.fileName} · {dimensions(result.width, result.height)}</strong>
        <img className="local-sr-result-preview" src={result.outputUrl} alt={result.fileName} />
        <code style={{ overflowWrap: "anywhere" }}>{result.outputPath}</code>
      </div>}
    </section>
  </section>;
}

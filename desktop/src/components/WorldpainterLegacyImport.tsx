import { useState } from "react";
import type { LegacyImportPreview, LegacyImportResult } from "../agent/legacy-import-types";
import { useFeatureText } from "../feature-i18n";
import { Button } from "./ui";
import "./worldpainter-legacy-import.css";

function Count({ label, value }: { label: string; value: number }) {
  return <div className="wp-legacy-import-count">
    <span>{label}</span><strong>{value}</strong>
  </div>;
}

function importedRows(result: LegacyImportResult) {
  return [
    ["生成草稿", result.imported.draft], ["图库", result.imported.gallery], ["风格", result.imported.styles],
    ["画师", result.imported.artists], ["已采纳记忆", result.imported.approvedMemories],
    ["待审核记忆", result.imported.pendingMemories], ["Agent 会话", result.imported.sessions], ["已校验图片", result.imported.assets],
  ] as const;
}

const sampleLabelKeys: Record<string, string> = {
  gallery: "图库", styles: "风格", artists: "画师", memories: "记忆", sessions: "会话",
};

/** Explicit preview/confirm boundary for a user-selected legacy SQLite snapshot. */
export function WorldpainterLegacyImport() {
  const ft = useFeatureText();
  const [preview, setPreview] = useState<LegacyImportPreview | null>(null);
  const [result, setResult] = useState<LegacyImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const choose = async () => {
    setBusy(true); setError(""); setMessage(""); setResult(null); setPreview(null);
    try {
      const selected = await window.worldpainter.legacyImport.selectAndPreview();
      if (selected) setPreview(selected);
      else setMessage("已取消选择，旧工作区未更改。");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally { setBusy(false); }
  };
  const cancel = async () => {
    if (!preview) return;
    setBusy(true); setError("");
    try { await window.worldpainter.legacyImport.cancel(preview.previewId); setPreview(null); setMessage("已取消导入预览。"); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  const confirm = async () => {
    if (!preview) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const imported = await window.worldpainter.legacyImport.confirm(preview.previewId);
      setResult(imported); setPreview(null);
      setMessage("导入已保存。刷新工作台后，新图库、Agent 会话和草稿会同步显示。");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally { setBusy(false); }
  };

  return <section className="wp-legacy-import" aria-label={ft("导入旧版 Flutter PC 工作区")}>
    <div>
      <h3>{ft("导入 Flutter PC 工作区")}</h3>
      <p>{ft("选择旧版 workspace.sqlite。先只读检查数据与图片，再由你确认追加到当前工作区。")}</p>
    </div>
    <div className="wp-legacy-import-actions">
      <Button variant="secondary" type="button" disabled={busy} onClick={() => void choose()}>{busy ? ft("正在处理…") : ft("选择旧工作区并预览")}</Button>
      {preview && <Button variant="ghost" type="button" disabled={busy} onClick={() => void cancel()}>{ft("取消预览")}</Button>}
    </div>
    {message && <p role="status" aria-live="polite">{ft(message)}</p>}
    {error && <p role="alert" aria-live="assertive">{ft("操作失败：{message}", { message: ft(error) })}</p>}

    {preview && <div className="wp-legacy-import-panel">
      <div><strong>{ft("只读预览：")}</strong> {preview.sourceFile} · schema {preview.schemaVersion} · revision {preview.revision}</div>
      <div className="wp-legacy-import-counts">
        <Count label={ft("生成草稿")} value={preview.counts.draft} />
        <Count label={ft("图库记录")} value={preview.counts.gallery} />
        <Count label={ft("风格")} value={preview.counts.styles} />
        <Count label={ft("画师")} value={preview.counts.artists} />
        <Count label={ft("已采纳记忆")} value={preview.counts.approvedMemories} />
        <Count label={ft("待审核记忆")} value={preview.counts.pendingMemories} />
        <Count label={ft("Agent 会话")} value={preview.counts.sessions} />
        <Count label={ft("可校验图片")} value={preview.counts.assets} />
        <Count label={ft("归档字段/条目")} value={preview.counts.archivedFields} />
        <Count label={ft("无效记录")} value={preview.counts.invalidRows} />
        <Count label={ft("重复记录")} value={preview.counts.duplicateRows} />
        <Count label={ft("缺失或校验失败的图片")} value={preview.counts.missingAssets} />
      </div>
      {preview.draft && <p className="wp-legacy-import-muted">
        {ft("草稿：{model} · {width} × {height} · 正向提示词 {positive} 字 · 负向提示词 {negative} 字", {
          model: preview.draft.model, width: preview.draft.width, height: preview.draft.height,
          positive: preview.draft.positivePromptCharacters, negative: preview.draft.negativePromptCharacters,
        })}
      </p>}
      {Object.entries(preview.samples).some(([, values]) => values.length > 0) && <details>
        <summary>{ft("查看名称样例")}</summary>
        <div className="wp-legacy-import-samples">
          {Object.entries(preview.samples).map(([kind, values]) => values.length ? <div key={kind}>
            <strong>{sampleLabelKeys[kind] ? ft(sampleLabelKeys[kind]) : kind}{ft("：")}</strong>
            {values.map((value, index) => <span key={index}>{index ? "、" : ""}{value}</span>)}
          </div> : null)}
        </div>
      </details>}
      {preview.warnings.length > 0 && <ul className="wp-legacy-import-warnings">
        {preview.warnings.map((warning, index) => <li key={index}>{ft(warning)}</li>)}
      </ul>}
      <p>{ft("确认后会复制通过校验的图片并追加可转换数据；新端已有数据保留。不能映射的安全字段会写入本地导入归档。")}</p>
      <div className="wp-legacy-import-actions">
        <Button variant="primary" type="button" disabled={busy} onClick={() => void confirm()}>{ft("确认导入并追加")}</Button>
        <Button variant="ghost" type="button" disabled={busy} onClick={() => void cancel()}>{ft("返回")}</Button>
      </div>
    </div>}

    {result && <div className="wp-legacy-import-panel">
      <strong>{ft("导入完成：")} {result.sourceFile}</strong>
      <div className="wp-legacy-import-counts">
        {importedRows(result).map(([label, value]) => <Count key={label} label={ft("已追加 · {label}", { label: ft(label) })} value={value} />)}
        <Count label={ft("跳过草稿")} value={result.skipped.draft} />
        <Count label={ft("无效记录")} value={result.skipped.invalidRows} />
        <Count label={ft("重复记录")} value={result.skipped.duplicateRows} />
        <Count label={ft("缺失或校验失败的图片")} value={result.skipped.missingAssets} />
      </div>
      <p>{ft("无法直接映射的数据已保存到导入归档：")}<code>{result.archiveFileName}</code></p>
      <Button variant="primary" type="button" onClick={() => window.location.reload()}>{ft("刷新工作台并显示导入内容")}</Button>
    </div>}
  </section>;
}

export default WorldpainterLegacyImport;

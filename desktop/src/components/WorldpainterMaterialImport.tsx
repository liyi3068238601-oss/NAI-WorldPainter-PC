import { useEffect, useMemo, useState } from "react";
import { formatArtistString } from "../artist-recipe";
import { appendPhoneArtistImports, appendPhoneStyleImports, classifyPhoneArtistConflict, classifyPhoneStyleConflict, matchPhoneAssetFilename, parsePhoneArtistPromptsJson, parsePhoneStylePresetsJson, type ArtistPromptPreset, type ImportedPhoneArtist, type ImportedPhoneStyle, type PhonePromptImportResult } from "../worldpainter-material-import";
import { changeStyles } from "../style-library-client";
import { useAppStore } from "../store";
import type { StylePromptPreset } from "../types";
import { Button } from "./ui";
import { FilePicker } from "./FilePicker";

interface ArtistPromptPresetLibrarySnapshot {
  version: 1;
  updatedAt: string;
  entries: ArtistPromptPreset[];
}

interface MaterialImportApi {
  artistPromptPresetLibraryLoad?: () => Promise<ArtistPromptPresetLibrarySnapshot>;
  artistPromptPresetLibraryMerge?: (entries: ArtistPromptPreset[]) => Promise<ArtistPromptPresetLibrarySnapshot>;
}

function materialApi(): MaterialImportApi {
  return window.naiDesktop as unknown as MaterialImportApi;
}

const labels = {
  "zh-CN": {
    title: "导入风格与画师串",
    intro: "选择素材 JSON，并按需添加预览图；已有收藏会保留。",
    styles: "风格 JSON",
    artists: "画师 JSON",
    images: "可选预览图（按 JSON 中的文件名精确匹配）",
    chooseStyles: "选择风格 JSON",
    chooseArtists: "选择画师 JSON",
    chooseImages: "选择预览图",
    parsed: "读取 {rows} 行 · 可导入 {valid} 条 · 问题 {issues} 条",
    styleList: "风格预览与冲突处理",
    artistList: "画师预览与冲突处理",
    noStyles: "尚未读取风格 JSON。",
    noArtists: "尚未读取画师 JSON。",
    exact: "本地已有相同内容，默认跳过",
    conflict: "名称或画师 tag 冲突：跳过或另存副本；不会覆盖已有内容",
    newRecord: "可新增",
    importCopy: "作为独立副本导入",
    skip: "跳过",
    missing: "未选到 {name}；该条仍可导入，但没有预览图。",
    ambiguous: "所选文件中有多个 {name}；请只保留一个同名文件。",
    noPreview: "无预览图",
    importStyles: "导入选中的风格",
    importArtists: "导入选中的画师",
    imported: "已导入 {count} 条。",
    nothing: "没有可导入的选中条目。",
    loading: "正在读取本地画师预设库…",
    ipcMissing: "画师素材库尚未连接到本地存储。",
    close: "关闭",
    failure: "导入失败：{error}",
    imageFailure: "部分预览图无法复制，提示词仍已导入。详情：{error}",
    rowIssue: "第 {row} 行 · {message}",
    issuesTitle: "解析提示",
    clearSelection: "图片未选或未匹配时不会从 JSON 路径读取文件。",
    styleGroup: "手机导入",
    libraryTitle: "本地画师素材库",
    searchArtists: "搜索画师名、tag 或分类",
    allCategories: "全部分类",
    weight: "权重",
    insertArtists: "插入已选画师串",
    selected: "已选 {count} 位",
    inserted: "已将 {count} 位画师串追加到风格提示词。",
  },
  "en-US": {
    title: "Import style and artist prompts",
    intro: "Choose material JSON files and add preview images if needed. Existing favorites will be kept.",
    styles: "Style JSON",
    artists: "Artist JSON",
    images: "Optional preview images (matched by exact filename)",
    chooseStyles: "Choose style JSON",
    chooseArtists: "Choose artist JSON",
    chooseImages: "Choose preview images",
    parsed: "Read {rows} rows · {valid} valid · {issues} notices",
    styleList: "Style preview and conflict choices",
    artistList: "Artist preview and conflict choices",
    noStyles: "No style JSON loaded.",
    noArtists: "No artist JSON loaded.",
    exact: "Exact content already exists; skipped by default",
    conflict: "Name or artist tag conflict: skip or add a separate copy; existing data is never overwritten",
    newRecord: "Can be added",
    importCopy: "Import as a separate copy",
    skip: "Skip",
    missing: "{name} was not selected; this prompt can still be imported without a preview.",
    ambiguous: "Multiple selected files are named {name}; keep only one file with that name.",
    noPreview: "No preview image",
    importStyles: "Import selected styles",
    importArtists: "Import selected artists",
    imported: "Imported {count} entries.",
    nothing: "No selected entries are ready to import.",
    loading: "Reading the local artist preset library…",
    ipcMissing: "Artist material storage is not connected yet.",
    close: "Close",
    failure: "Import failed: {error}",
    imageFailure: "Some previews could not be copied; prompts were still imported. Details: {error}",
    rowIssue: "Row {row} · {message}",
    issuesTitle: "Parsing notes",
    clearSelection: "Without a selected matching image, the importer never reads a path from JSON.",
    styleGroup: "Phone import",
    libraryTitle: "Local artist material library",
    searchArtists: "Search artist, tag, or category",
    allCategories: "All categories",
    weight: "Weight",
    insertArtists: "Append selected artist prompts",
    selected: "{count} selected",
    inserted: "Appended prompts for {count} artists to the style prompt.",
  },
} as const;

type Language = keyof typeof labels;
type LocalizedLabels = typeof labels[Language];
type Choice = "import" | "skip";

function interpolate(text: string, values: Record<string, string | number>) {
  return text.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ""));
}

function issueText(issue: { row?: number; message: string }, text: LocalizedLabels) {
  return issue.row === undefined
    ? issue.message
    : interpolate(text.rowIssue, { row: issue.row, message: issue.message });
}

function matchingFiles(files: readonly File[], basename: string | null): File[] {
  if (!basename) return [];
  const matched = matchPhoneAssetFilename(basename, files.map((file) => file.name));
  if (matched.status === "matched") {
    return files.filter((file) => file.name.toLocaleLowerCase() === matched.filename.toLocaleLowerCase());
  }
  if (matched.status === "ambiguous") {
    const names = new Set(matched.filenames.map((filename) => filename.toLocaleLowerCase()));
    return files.filter((file) => names.has(file.name.toLocaleLowerCase()));
  }
  return [];
}

export interface WorldpainterMaterialImportProps {
  onClose?: () => void;
}

/** A local-only import flow. It does not fetch or ship the mobile asset set. */
export default function WorldpainterMaterialImport({ onClose }: WorldpainterMaterialImportProps) {
  const settings = useAppStore((state) => state.settings);
  const language = (settings?.language === "en-US" ? "en-US" : "zh-CN") as Language;
  const text = labels[language];
  const existingStyles = settings?.stylePromptPresets ?? [];
  const [styleResult, setStyleResult] = useState<PhonePromptImportResult<ImportedPhoneStyle> | null>(null);
  const [artistResult, setArtistResult] = useState<PhonePromptImportResult<ImportedPhoneArtist> | null>(null);
  const [styleError, setStyleError] = useState("");
  const [artistError, setArtistError] = useState("");
  const [imageFiles, setImageFiles] = useState<File[]>([]);
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  const [styleChoice, setStyleChoice] = useState<Record<string, Choice>>({});
  const [artistChoice, setArtistChoice] = useState<Record<string, Choice>>({});
  const [artistEntries, setArtistEntries] = useState<ArtistPromptPreset[]>([]);
  const [artistQuery, setArtistQuery] = useState("");
  const [artistCategory, setArtistCategory] = useState("");
  const [artistWeights, setArtistWeights] = useState<Record<string, number>>({});
  const [artistLibraryReady, setArtistLibraryReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  useEffect(() => {
    const urls: Record<string, string> = {};
    for (const file of imageFiles) {
      const key = file.name.toLocaleLowerCase();
      if (urls[key]) continue;
      urls[key] = URL.createObjectURL(file);
    }
    setPreviewUrls(urls);
    return () => Object.values(urls).forEach((url) => URL.revokeObjectURL(url));
  }, [imageFiles]);

  useEffect(() => {
    let active = true;
    const api = materialApi();
    if (typeof api.artistPromptPresetLibraryLoad !== "function") {
      setArtistLibraryReady(false);
      return () => { active = false; };
    }
    void api.artistPromptPresetLibraryLoad()
      .then((snapshot) => {
        if (!active) return;
        setArtistEntries(Array.isArray(snapshot?.entries) ? snapshot.entries : []);
        setArtistLibraryReady(true);
      })
      .catch((error) => {
        if (!active) return;
        setArtistLibraryReady(false);
        setStatus(interpolate(text.failure, { error: String(error) }));
      });
    return () => { active = false; };
  }, [text.failure]);

  const styleRows = useMemo(() => (styleResult?.items ?? []).map((item) => {
    const conflict = classifyPhoneStyleConflict(item, existingStyles);
    const choice = styleChoice[item.id] ?? (conflict === "none" ? "import" : "skip");
    return { item, conflict, choice };
  }), [existingStyles, styleChoice, styleResult]);
  const artistRows = useMemo(() => (artistResult?.items ?? []).map((item) => {
    const conflict = classifyPhoneArtistConflict(item, artistEntries);
    const choice = artistChoice[item.id] ?? (conflict === "none" ? "import" : "skip");
    return { item, conflict, choice };
  }), [artistChoice, artistEntries, artistResult]);
  const artistCategories = useMemo(() => [...new Set(artistEntries.flatMap((entry) => entry.categories))].sort(), [artistEntries]);
  const visibleArtistEntries = useMemo(() => {
    const query = artistQuery.trim().toLocaleLowerCase();
    return artistEntries.filter((entry) => (
      (!artistCategory || entry.categories.includes(artistCategory))
      && (!query || `${entry.name}\n${entry.tag}\n${entry.categories.join(" ")}`.toLocaleLowerCase().includes(query))
    ));
  }, [artistCategory, artistEntries, artistQuery]);
  const selectedArtistCount = artistEntries.filter((entry) => artistWeights[entry.id] !== undefined).length;

  function readStyleFile(file: File | undefined) {
    setStyleResult(null);
    setStyleError("");
    setStyleChoice({});
    if (!file) return;
    void file.text().then((source) => setStyleResult(parsePhoneStylePresetsJson(source)))
      .catch((error) => setStyleError(String(error)));
  }

  function readArtistFile(file: File | undefined) {
    setArtistResult(null);
    setArtistError("");
    setArtistChoice({});
    if (!file) return;
    void file.text().then((source) => setArtistResult(parsePhoneArtistPromptsJson(source)))
      .catch((error) => setArtistError(String(error)));
  }

  function previewFor(filename: string | null) {
    const matches = matchingFiles(imageFiles, filename);
    return matches.length === 1 ? previewUrls[matches[0].name.toLocaleLowerCase()] : undefined;
  }

  async function importStyles() {
    const chosen = styleRows.filter((row) => row.choice === "import");
    if (!chosen.length) {
      setStatus(text.nothing);
      return;
    }
    const api = window.naiDesktop;
    const createdImageIds: string[] = [];
    const records: StylePromptPreset[] = [];
    const imageIssues: string[] = [];
    setBusy(true);
    setStatus("");
    try {
      for (const { item } of chosen) {
        const preset: StylePromptPreset = {
          id: item.id,
          name: item.name,
          prompt: item.prompt,
          group: text.styleGroup,
          createdAt: new Date().toISOString(),
          rating: 0,
          usageCount: 0,
          previewImages: [],
        };
        const matches = matchingFiles(imageFiles, item.assetImage);
        if (item.assetImage && matches.length > 1) {
          imageIssues.push(interpolate(text.ambiguous, { name: item.assetImage }));
        } else if (item.assetImage && matches.length === 1) {
          try {
            const sourcePath = api.getPathForFile(matches[0]);
            const copied = await api.importStylePromptPresetImagePaths([sourcePath], preset.id, 1);
            preset.previewImages = copied;
            if (copied.length) createdImageIds.push(preset.id);
            else imageIssues.push(interpolate(text.missing, { name: item.assetImage }));
          } catch (error) {
            imageIssues.push(`${item.assetImage}: ${String(error)}`);
          }
        } else if (item.assetImage) {
          imageIssues.push(interpolate(text.missing, { name: item.assetImage }));
        }
        records.push(preset);
      }
      await changeStyles((current) => appendPhoneStyleImports(current, records));
      await useAppStore.getState().refreshSettings();
      setStatus(interpolate(text.imported, { count: records.length }));
      if (imageIssues.length) setStatus(`${interpolate(text.imageFailure, { error: imageIssues.join(" · ") })}`);
    } catch (error) {
      await Promise.allSettled(createdImageIds.map((id) => api.deleteStylePromptPresetImages(id)));
      setStatus(interpolate(text.failure, { error: String(error) }));
    } finally {
      setBusy(false);
    }
  }

  async function importArtists() {
    const chosen = artistRows.filter((row) => row.choice === "import");
    if (!chosen.length) {
      setStatus(text.nothing);
      return;
    }
    const api = materialApi();
    if (typeof api.artistPromptPresetLibraryMerge !== "function") {
      setStatus(text.ipcMissing);
      return;
    }
    const createdImageIds: string[] = [];
    const entries: ArtistPromptPreset[] = [];
    const imageIssues: string[] = [];
    setBusy(true);
    setStatus("");
    try {
      for (const { item } of chosen) {
        const entry: ArtistPromptPreset = {
          id: item.id,
          name: item.name,
          tag: item.tag,
          categories: item.categories,
          danbooruCount: item.danbooruCount,
          createdAt: item.createdAt,
          previewImages: [],
        };
        const matches = matchingFiles(imageFiles, item.assetImage);
        if (item.assetImage && matches.length > 1) {
          imageIssues.push(interpolate(text.ambiguous, { name: item.assetImage }));
        } else if (item.assetImage && matches.length === 1) {
          try {
            const sourcePath = window.naiDesktop.getPathForFile(matches[0]);
            const copied = await window.naiDesktop.importStylePromptPresetImagePaths([sourcePath], entry.id, 1);
            entry.previewImages = copied;
            if (copied.length) createdImageIds.push(entry.id);
            else imageIssues.push(interpolate(text.missing, { name: item.assetImage }));
          } catch (error) {
            imageIssues.push(`${item.assetImage}: ${String(error)}`);
          }
        } else if (item.assetImage) {
          imageIssues.push(interpolate(text.missing, { name: item.assetImage }));
        }
        entries.push(entry);
      }
      const snapshot = await api.artistPromptPresetLibraryMerge(entries);
      setArtistEntries(Array.isArray(snapshot?.entries) ? snapshot.entries : appendPhoneArtistImports(artistEntries, entries));
      setArtistLibraryReady(true);
      setStatus(interpolate(text.imported, { count: entries.length }));
      if (imageIssues.length) setStatus(interpolate(text.imageFailure, { error: imageIssues.join(" · ") }));
    } catch (error) {
      await Promise.allSettled(createdImageIds.map((id) => window.naiDesktop.deleteStylePromptPresetImages(id)));
      setStatus(interpolate(text.failure, { error: String(error) }));
    } finally {
      setBusy(false);
    }
  }

  function insertSelectedArtistPrompts() {
    const chosen = artistEntries.filter((entry) => artistWeights[entry.id] !== undefined);
    if (!chosen.length) {
      setStatus(text.nothing);
      return;
    }
    const generated = formatArtistString(chosen.map((entry) => ({
      name: entry.tag,
      weight: artistWeights[entry.id] ?? 1,
    })));
    const state = useAppStore.getState();
    const current = state.params.stylePrompt.trim();
    state.setParam("stylePrompt", current ? `${current.replace(/[\s,，]+$/u, "")}, ${generated}` : generated);
    state.setActiveTab("generate");
    setStatus(interpolate(text.inserted, { count: chosen.length }));
  }

  const cardStyle: React.CSSProperties = {
    border: "1px solid var(--border, #444)",
    borderRadius: 8,
    padding: 12,
    minWidth: 0,
  };
  const listStyle: React.CSSProperties = {
    display: "grid",
    gap: 8,
    maxHeight: 280,
    overflow: "auto",
    marginTop: 10,
  };

  return <section className="worldpainter-material-import" aria-label={text.title} style={{ display: "grid", gap: 12, padding: 16 }}>
    <div className="wp-material-head" style={{ display: "flex", flexWrap: "wrap", alignItems: "start", justifyContent: "space-between", gap: 12 }}>
      <div><h2 style={{ margin: 0 }}>{text.title}</h2><p style={{ margin: "6px 0 0", opacity: 0.8 }}>{text.intro}</p></div>
      {onClose && <Button onClick={onClose}>{text.close}</Button>}
    </div>
    <section style={cardStyle}>
      <h3>{text.styles}</h3>
      <FilePicker accept="application/json,.json" buttonLabel={text.chooseStyles} onChange={(event) => readStyleFile(event.target.files?.[0])} />
      {styleError && <p role="alert">{interpolate(text.failure, { error: styleError })}</p>}
      {styleResult && <>
        <p>{interpolate(text.parsed, { rows: styleResult.sourceRows, valid: styleResult.items.length, issues: styleResult.issues.length })}</p>
        <div style={listStyle}>
          {styleRows.map(({ item, conflict, choice }) => {
            const matches = matchingFiles(imageFiles, item.assetImage);
            return <article key={item.id} style={{ display: "grid", gridTemplateColumns: "76px 1fr", gap: 10, alignItems: "start", borderBottom: "1px solid var(--border, #444)", paddingBottom: 8 }}>
              {previewFor(item.assetImage)
                ? <img src={previewFor(item.assetImage)} alt={item.name} style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 6 }} />
                : <div aria-label={text.noPreview} style={{ width: 72, height: 72, display: "grid", placeItems: "center", opacity: 0.65, border: "1px dashed var(--border, #666)", borderRadius: 6 }}>—</div>}
              <div style={{ minWidth: 0 }}>
                <label style={{ display: "flex", gap: 8, alignItems: "start" }}>
                  <input type="checkbox" disabled={busy || conflict === "exact-duplicate"} checked={choice === "import"} onChange={(event) => setStyleChoice((current) => ({ ...current, [item.id]: event.target.checked ? "import" : "skip" }))} />
                  <span><strong>{item.name}</strong><small style={{ display: "block", opacity: 0.75 }}>{conflict === "exact-duplicate" ? text.exact : conflict === "name-or-tag-conflict" ? text.conflict : text.newRecord}</small></span>
                </label>
                <code style={{ display: "block", whiteSpace: "pre-wrap", overflowWrap: "anywhere", marginTop: 5 }}>{item.prompt}</code>
                {item.assetImage && <small style={{ display: "block", marginTop: 5, opacity: 0.75 }}>
                  {matches.length === 1 ? item.assetImage : matches.length > 1 ? interpolate(text.ambiguous, { name: item.assetImage }) : interpolate(text.missing, { name: item.assetImage })}
                </small>}
                {conflict === "name-or-tag-conflict" && <small>{choice === "import" ? text.importCopy : text.skip}</small>}
              </div>
            </article>;
          })}
        </div>
        {styleResult.issues.length > 0 && <details><summary>{text.issuesTitle} · {styleResult.issues.length}</summary>{styleResult.issues.map((issue, index) => <p key={index}>{issueText(issue, text)}</p>)}</details>}
        <Button disabled={busy || !styleRows.some((row) => row.choice === "import")} onClick={() => void importStyles()}>{text.importStyles}</Button>
      </>}
      {!styleResult && !styleError && <p>{text.noStyles}</p>}
    </section>
    <section style={cardStyle}>
      <h3>{text.artists}</h3>
      <FilePicker accept="application/json,.json" buttonLabel={text.chooseArtists} onChange={(event) => readArtistFile(event.target.files?.[0])} />
      {artistError && <p role="alert">{interpolate(text.failure, { error: artistError })}</p>}
      {artistResult && <>
        <p>{interpolate(text.parsed, { rows: artistResult.sourceRows, valid: artistResult.items.length, issues: artistResult.issues.length })}</p>
        {!artistLibraryReady && <p role="status">{typeof materialApi().artistPromptPresetLibraryLoad === "function" ? text.loading : text.ipcMissing}</p>}
        <div style={listStyle}>
          {artistRows.map(({ item, conflict, choice }) => {
            const matches = matchingFiles(imageFiles, item.assetImage);
            return <article key={item.id} style={{ display: "grid", gridTemplateColumns: "76px 1fr", gap: 10, alignItems: "start", borderBottom: "1px solid var(--border, #444)", paddingBottom: 8 }}>
              {previewFor(item.assetImage)
                ? <img src={previewFor(item.assetImage)} alt={item.name} style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 6 }} />
                : <div aria-label={text.noPreview} style={{ width: 72, height: 72, display: "grid", placeItems: "center", opacity: 0.65, border: "1px dashed var(--border, #666)", borderRadius: 6 }}>—</div>}
              <div style={{ minWidth: 0 }}>
                <label style={{ display: "flex", gap: 8, alignItems: "start" }}>
                  <input type="checkbox" disabled={busy || conflict === "exact-duplicate" || !artistLibraryReady} checked={choice === "import"} onChange={(event) => setArtistChoice((current) => ({ ...current, [item.id]: event.target.checked ? "import" : "skip" }))} />
                  <span><strong>{item.name}</strong><small style={{ display: "block", opacity: 0.75 }}>{conflict === "exact-duplicate" ? text.exact : conflict === "name-or-tag-conflict" ? text.conflict : text.newRecord}</small></span>
                </label>
                <code>{item.tag}</code><small style={{ display: "block", opacity: 0.75 }}>{item.categories.join(" · ") || "—"} · Danbooru {item.danbooruCount}</small>
                {item.assetImage && <small style={{ display: "block", marginTop: 5, opacity: 0.75 }}>
                  {matches.length === 1 ? item.assetImage : matches.length > 1 ? interpolate(text.ambiguous, { name: item.assetImage }) : interpolate(text.missing, { name: item.assetImage })}
                </small>}
                {conflict === "name-or-tag-conflict" && <small>{choice === "import" ? text.importCopy : text.skip}</small>}
              </div>
            </article>;
          })}
        </div>
        {artistResult.issues.length > 0 && <details><summary>{text.issuesTitle} · {artistResult.issues.length}</summary>{artistResult.issues.map((issue, index) => <p key={index}>{issueText(issue, text)}</p>)}</details>}
        <Button disabled={busy || !artistLibraryReady || !artistRows.some((row) => row.choice === "import")} onClick={() => void importArtists()}>{text.importArtists}</Button>
      </>}
      {!artistResult && !artistError && <p>{text.noArtists}</p>}
    </section>
    <section style={cardStyle}>
      <h3>{text.images}</h3>
      <FilePicker accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp" multiple buttonLabel={text.chooseImages} onChange={(event) => setImageFiles(Array.from(event.target.files ?? []))} />
      <p style={{ opacity: 0.75 }}>{text.clearSelection}</p>
      {imageFiles.length > 0 && <p>{imageFiles.map((file) => file.name).join(" · ")}</p>}
    </section>
    {artistLibraryReady && <section style={cardStyle}>
      <div className="wp-material-head" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <h3>{text.libraryTitle} · {artistEntries.length}</h3>
        <Button disabled={!selectedArtistCount} onClick={insertSelectedArtistPrompts}>{text.insertArtists} · {interpolate(text.selected, { count: selectedArtistCount })}</Button>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input aria-label={text.searchArtists} placeholder={text.searchArtists} value={artistQuery} onChange={(event) => setArtistQuery(event.target.value)} />
        <select aria-label={text.allCategories} value={artistCategory} onChange={(event) => setArtistCategory(event.target.value)}>
          <option value="">{text.allCategories}</option>
          {artistCategories.map((category) => <option key={category} value={category}>{category}</option>)}
        </select>
      </div>
      <div style={listStyle}>
        {visibleArtistEntries.map((entry) => {
          const preview = entry.previewImages[0]?.fileUrl;
          const selected = artistWeights[entry.id] !== undefined;
          return <article key={entry.id} style={{ display: "grid", gridTemplateColumns: "64px 1fr auto", gap: 10, alignItems: "center", borderBottom: "1px solid var(--border, #444)", paddingBottom: 8 }}>
            {preview
              ? <img src={preview} alt={entry.name} style={{ width: 60, height: 60, objectFit: "cover", borderRadius: 6 }} />
              : <div aria-label={text.noPreview} style={{ width: 60, height: 60, display: "grid", placeItems: "center", opacity: 0.65, border: "1px dashed var(--border, #666)", borderRadius: 6 }}>—</div>}
            <div style={{ minWidth: 0 }}><strong>{entry.name}</strong><code style={{ display: "block", overflowWrap: "anywhere" }}>{entry.tag}</code><small style={{ opacity: 0.75 }}>{entry.categories.join(" · ") || "—"} · Danbooru {entry.danbooruCount}</small></div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input aria-label={`${text.weight}: ${entry.name}`} type="checkbox" checked={selected} onChange={(event) => setArtistWeights((current) => {
                const next = { ...current };
                if (event.target.checked) next[entry.id] = 1;
                else delete next[entry.id];
                return next;
              })} />
              {selected && <label>{text.weight}<input type="number" min={0.1} max={8} step={0.1} value={artistWeights[entry.id]} onChange={(event) => {
                const value = Number(event.target.value);
                if (Number.isFinite(value)) setArtistWeights((current) => ({ ...current, [entry.id]: Math.min(8, Math.max(0.1, value)) }));
              }} style={{ width: 64 }} /></label>}
            </div>
          </article>;
        })}
      </div>
    </section>}
    {status && <p role="status" aria-live="polite">{status}</p>}
  </section>;
}

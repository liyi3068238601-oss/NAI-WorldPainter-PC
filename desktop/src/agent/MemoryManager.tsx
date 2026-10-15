import { useEffect, useMemo, useState, type FormEvent } from "react";
import { confirmAction } from "../components/confirm";
import type { AgentMemory, AgentMemorySource, AgentMemoryType, AgentWorkspaceData } from "./types";
import {
  AGENT_MEMORY_TYPES,
} from "./types";
import {
  findAgentMemoryConflicts,
  isPromptTagMemoryType,
  isRetrievableAgentMemory,
  isStaleAgentMemory,
  mergeAgentMemoryContent,
  normalizeAgentMemoryContent,
} from "./memory";
import { memoryUiText } from "./memory-text";
import { featureText } from "../feature-text";

type ConflictMode = "replace" | "merge" | "coexist";

const editableSources: AgentMemorySource[] = ["manual", "userInstruction", "llmCandidate"];
const typeLabel = (language: unknown, type: AgentMemoryType | undefined) => memoryUiText(language, `type_${type ?? "other"}`);
const sourceLabel = (language: unknown, source: AgentMemorySource | undefined) => memoryUiText(language, `source_${source ?? "manual"}`);

function draftRecord(values: {
  id?: string;
  trigger: string;
  content: string;
  type: AgentMemoryType;
  scope: "global" | "conversation";
  conversationId?: string;
}): AgentMemory {
  const now = new Date().toISOString();
  return {
    id: values.id ?? "__new_memory__",
    title: values.trigger,
    trigger: values.trigger,
    content: values.content,
    type: values.type,
    source: "manual",
    scope: values.scope,
    ...(values.scope === "conversation" && values.conversationId ? { conversationId: values.conversationId } : {}),
    hitCount: 0,
    weight: 1,
    createdAt: now,
    updatedAt: now,
  };
}

export function MemoryManager({
  workspace,
  conversationId,
  disabled,
  language,
  onWorkspaceChange,
}: {
  workspace?: AgentWorkspaceData;
  conversationId?: string;
  disabled: boolean;
  language: unknown;
  onWorkspaceChange: (workspace: AgentWorkspaceData) => void;
}) {
  const t = (key: string) => memoryUiText(language, key);
  const localizeError = (reason: unknown) => featureText(typeof language === "string" ? language : undefined, reason instanceof Error ? reason.message : String(reason));
  const memories = workspace?.memories ?? [];
  const [query, setQuery] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string>();
  const [trigger, setTrigger] = useState("");
  const [type, setType] = useState<AgentMemoryType>("other");
  const [source, setSource] = useState<AgentMemorySource>("manual");
  const [scope, setScope] = useState<"global" | "conversation">("global");
  const [memoryConversationId, setMemoryConversationId] = useState<string>();
  const [content, setContent] = useState("");
  const [conflictMode, setConflictMode] = useState<ConflictMode>("coexist");
  const [conflictId, setConflictId] = useState("");
  const [staleOpen, setStaleOpen] = useState(false);
  const [staleSelected, setStaleSelected] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  // The page may have been open while the agent staged or retrieved a memory.
  // Refresh once on entry so the manager always starts from the persisted view.
  useEffect(() => {
    let active = true;
    void window.naiDesktop.getAgentWorkspace().then((fresh) => {
      if (active) onWorkspaceChange(fresh);
    }).catch((reason) => {
      if (active) setError(localizeError(reason));
    });
    return () => { active = false; };
  }, [language, onWorkspaceChange]);

  const lowerQuery = query.trim().toLocaleLowerCase();
  const filtered = useMemo(() => memories.filter((memory) => !lowerQuery
    || `${memory.trigger ?? memory.title} ${memory.title} ${memory.content} ${memory.type ?? "other"} ${memory.source ?? "manual"}`
      .toLocaleLowerCase().includes(lowerQuery)), [lowerQuery, memories]);
  const pending = filtered.filter((memory) => memory.source === "pendingLlmCandidate");
  const stored = filtered.filter((memory) => memory.source !== "pendingLlmCandidate");
  const candidateBeingEdited = editingId ? memories.find((memory) => memory.id === editingId)?.source === "pendingLlmCandidate" : false;
  const currentDraft = draftRecord({ id: editingId, trigger, content, type, scope, conversationId: editingId ? memoryConversationId : memoryConversationId ?? conversationId });
  const conflicts = trigger.trim()
    ? findAgentMemoryConflicts(memories, currentDraft, editingId ?? currentDraft.id)
    : [];
  const selectedConflict = conflicts.find((item) => item.id === conflictId) ?? conflicts[0];
  const normalizedPreview = normalizeAgentMemoryContent(type, content);
  const staleMemories = memories.filter((memory) => isStaleAgentMemory(memory));

  function openNew() {
    setEditingId(undefined);
    setTrigger("");
    setType("other");
    setSource("manual");
    setScope("global");
    setMemoryConversationId(conversationId);
    setContent("");
    setConflictMode("coexist");
    setConflictId("");
    setEditorOpen(true);
    setError("");
    setNotice("");
  }

  function openEdit(memory: AgentMemory) {
    setEditingId(memory.id);
    setTrigger(memory.trigger ?? memory.title);
    setType(memory.type ?? "other");
    setSource(memory.source ?? "manual");
    setScope(memory.scope);
    setMemoryConversationId(memory.conversationId);
    setContent(memory.content);
    setConflictMode("coexist");
    setConflictId("");
    setEditorOpen(true);
    setError("");
    setNotice("");
  }

  async function commit(kind: "save" | "approve", event?: FormEvent) {
    event?.preventDefault();
    if (!workspace || disabled || busy) return;
    const cleanTrigger = trigger.trim();
    const normalizedContent = normalizeAgentMemoryContent(type, content);
    if (!cleanTrigger || cleanTrigger.length > 200) {
      setError(t("triggerRequired"));
      return;
    }
    const keepPendingDraft = candidateBeingEdited && kind === "save";
    if (!normalizedContent.trim() && !keepPendingDraft) {
      setError(isPromptTagMemoryType(type) ? t("invalidTag") : t("contentRequired"));
      return;
    }
    const targetConversationId = editingId ? memoryConversationId : memoryConversationId ?? conversationId;
    if (scope === "conversation" && !targetConversationId) {
      setError(t("conversationRequired"));
      return;
    }

    const effectiveMode = candidateBeingEdited && kind === "save" ? "coexist" : conflictMode;
    let savedContent = normalizedContent.trim() ? normalizedContent : keepPendingDraft ? content : normalizedContent;
    const supersedeIds: string[] = [];
    if (selectedConflict && effectiveMode !== "coexist") {
      if (!selectedConflict || !conflicts.some((memory) => memory.id === selectedConflict.id)) {
        setError(t("selectConflict"));
        return;
      }
      if (effectiveMode === "merge") {
        if (selectedConflict.type !== type) {
          setError(t("mergeTypeMismatch"));
          return;
        }
        savedContent = mergeAgentMemoryContent(type, normalizedContent, selectedConflict.content);
      }
      supersedeIds.push(selectedConflict.id);
    }

    const targetSource: AgentMemorySource = kind === "approve"
      ? "llmCandidate"
      : candidateBeingEdited ? "pendingLlmCandidate" : source;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      // `supersedeIds` is a transient instruction carried through the existing
      // upsert bridge; the store applies it with the memory write atomically.
      const request = {
        ...(editingId ? { id: editingId } : {}),
        title: cleanTrigger,
        trigger: cleanTrigger,
        content: savedContent,
        type,
        source: targetSource,
        scope,
        ...(scope === "conversation" ? { conversationId: targetConversationId } : {}),
        ...(supersedeIds.length && targetSource !== "pendingLlmCandidate" ? { supersedeIds } : {}),
      };
      const result = await window.naiDesktop.upsertAgentMemory(request);
      onWorkspaceChange(result.workspace);
      if (!result.ok) {
        setError(result.message ? localizeError(result.message) : t("saveFailed"));
        return;
      }
      setNotice(kind === "approve" ? t("approvedNotice") : t("saved"));
      setEditorOpen(false);
      setEditingId(undefined);
    } catch (reason) {
      setError(localizeError(reason));
    } finally {
      setBusy(false);
    }
  }

  async function removeMemory(memory: AgentMemory, reject = false) {
    if (disabled || busy) return;
    const prompt = reject ? t("confirmReject") : t("confirmDelete");
    if (!await confirmAction(`${prompt}\n${memory.trigger ?? memory.title}`)) return;
    setBusy(true);
    setError("");
    try {
      const result = await window.naiDesktop.deleteAgentMemory(memory.id);
      onWorkspaceChange(result.workspace);
      if (!result.ok) setError(result.message ? localizeError(result.message) : t("deleteFailed"));
      else setNotice(reject ? t("rejectedNotice") : t("deletedNotice"));
    } catch (reason) {
      setError(localizeError(reason));
    } finally {
      setBusy(false);
    }
  }

  async function removeStale() {
    const ids = staleMemories.filter((memory) => staleSelected.includes(memory.id)).map((memory) => memory.id);
    if (!ids.length || disabled || busy) return;
    if (!await confirmAction(`${t("confirmStale")} (${ids.length})`)) return;
    setBusy(true);
    setError("");
    try {
      let latest = await window.naiDesktop.getAgentWorkspace();
      for (const id of ids) {
        const current = latest.memories.find((memory) => memory.id === id);
        if (!current || !isStaleAgentMemory(current)) continue;
        const result = await window.naiDesktop.deleteAgentMemory(id);
        latest = result.workspace;
        if (!result.ok) throw new Error(result.message ?? `无法删除 ${id}`);
      }
      onWorkspaceChange(latest);
      setStaleSelected([]);
      setNotice(t("deletedNotice"));
    } catch (reason) {
      setError(localizeError(reason));
    } finally {
      setBusy(false);
    }
  }

  function toggleStale(id: string, selected: boolean) {
    setStaleSelected((current) => selected ? [...new Set([...current, id])] : current.filter((item) => item !== id));
  }

  return <div className="pi-memory-manager">
    <div className="pi-memory-toolbar">
      <input type="search" aria-label={t("search")} placeholder={t("search")} value={query} onChange={(event) => setQuery(event.target.value)} />
      <button type="button" disabled={disabled || busy} onClick={openNew}>{t("add")}</button>
    </div>
    <p className="pi-memory-summary">{t("approved")}: {memories.filter((memory) => isRetrievableAgentMemory(memory)).length} · {t("pending")}: {memories.filter((memory) => memory.source === "pendingLlmCandidate").length}</p>
    {error && <p className="pi-memory-error" role="alert">{error}</p>}
    {notice && <p className="pi-memory-notice" role="status">{notice}</p>}

    {editorOpen && <form className="pi-memory-editor" onSubmit={(event) => void commit("save", event)}>
      <div className="pi-memory-editor-title"><strong>{editingId ? t("edit") : t("add")}</strong><button type="button" disabled={busy} onClick={() => setEditorOpen(false)}>{t("cancel")}</button></div>
      <label>{t("trigger")}<input autoFocus maxLength={200} value={trigger} onChange={(event) => setTrigger(event.target.value)} /></label>
      <label>{t("type")}<select value={type} onChange={(event) => setType(event.target.value as AgentMemoryType)}>{AGENT_MEMORY_TYPES.map((item) => <option key={item} value={item}>{typeLabel(language, item)}</option>)}</select></label>
      {!candidateBeingEdited && <label>{t("source")}<select value={source} onChange={(event) => setSource(event.target.value as AgentMemorySource)}>{editableSources.map((item) => <option key={item} value={item}>{sourceLabel(language, item)}</option>)}</select></label>}
      <label>{t("scope")}<select value={scope} onChange={(event) => { const next = event.target.value as "global" | "conversation"; setScope(next); if (next === "conversation" && !memoryConversationId) setMemoryConversationId(conversationId); }}><option value="global">{t("global")}</option><option value="conversation">{t("conversation")}</option></select></label>
      <label>{t("content")}<textarea rows={4} maxLength={8000} value={content} onChange={(event) => setContent(event.target.value)} /></label>
      {isPromptTagMemoryType(type) && <div className="pi-memory-preview"><small>{t("tagsPreview")}</small><pre>{normalizedPreview || "—"}</pre></div>}
      {conflicts.length > 0 && <fieldset className="pi-memory-conflicts">
        <legend>{t("conflict")}</legend>
        {conflicts.map((memory) => <label className="pi-memory-conflict-row" key={memory.id}><input type="radio" name="memory-conflict" checked={(conflictId || conflicts[0]?.id) === memory.id} onChange={() => setConflictId(memory.id)} /><span><strong>{memory.trigger ?? memory.title}</strong><small>{typeLabel(language, memory.type)} · {sourceLabel(language, memory.source)}</small><pre>{memory.content.slice(0, 180)}</pre></span></label>)}
        <span className="pi-memory-field-label">{t("conflictChoice")}</span>
        <div className="pi-memory-conflict-actions">
          <label><input type="radio" name="memory-conflict-mode" checked={conflictMode === "replace"} onChange={() => setConflictMode("replace")} />{t("replace")}</label>
          <label><input type="radio" name="memory-conflict-mode" disabled={!selectedConflict || selectedConflict.type !== type} checked={conflictMode === "merge"} onChange={() => setConflictMode("merge")} />{t("merge")}</label>
          <label><input type="radio" name="memory-conflict-mode" checked={conflictMode === "coexist"} onChange={() => setConflictMode("coexist")} />{t("coexist")}</label>
        </div>
      </fieldset>}
      <footer>
        <button type="submit" disabled={disabled || busy}>{t("save")}</button>
        {candidateBeingEdited && <button type="button" className="pi-primary" disabled={disabled || busy} onClick={() => void commit("approve")}>{t("approve")}</button>}
      </footer>
    </form>}

    {pending.length > 0 && <section className="pi-memory-section"><h3>{t("pending")}</h3><p>{t("pendingHint")}</p><div className="pi-memory-card-list">{pending.map((memory) => <article className="pi-memory-card is-pending" key={memory.id}>
      <header><strong>{memory.trigger ?? memory.title}</strong><small>{typeLabel(language, memory.type)} · {sourceLabel(language, memory.source)}</small></header>
      <pre>{memory.content}</pre>
      <footer><button type="button" disabled={disabled || busy} onClick={() => openEdit(memory)}>{t("edit")}</button><button type="button" disabled={disabled || busy} onClick={() => void removeMemory(memory, true)}>{t("reject")}</button></footer>
    </article>)}</div></section>}

    <section className="pi-memory-section"><h3>{t("approved")}</h3>
      {stored.length === 0 && pending.length === 0 && <p className="pi-muted">{t("empty")}</p>}
      <div className="pi-memory-card-list">{stored.map((memory) => <article className={`pi-memory-card${memory.supersededBy ? " is-superseded" : ""}`} key={memory.id}>
        <header><strong>{memory.trigger ?? memory.title}</strong><small>{typeLabel(language, memory.type)} · {sourceLabel(language, memory.source)}</small></header>
        <div className="pi-memory-meta"><span>{memory.scope === "conversation" ? t("conversation") : t("global")}</span><span>{t("hitCount")}: {memory.hitCount ?? 0}</span>{memory.supersededBy && <span>{t("superseded")}</span>}</div>
        <pre>{memory.content}</pre>
        <footer>{!memory.supersededBy && <button type="button" disabled={disabled || busy} onClick={() => openEdit(memory)}>{t("edit")}</button>}<button type="button" disabled={disabled || busy} onClick={() => void removeMemory(memory)}>{t("delete")}</button></footer>
      </article>)}</div>
    </section>

    <section className="pi-memory-stale">
      <button type="button" disabled={busy} aria-expanded={staleOpen} onClick={() => setStaleOpen((open) => !open)}>{t("stalePreview")} · {staleMemories.length}</button>
      {staleOpen && <div className="pi-memory-stale-list">
        {!staleMemories.length && <p className="pi-muted">{t("staleNone")}</p>}
        {staleMemories.length > 0 && <button type="button" disabled={disabled || busy} onClick={() => setStaleSelected(staleMemories.map((memory) => memory.id))}>{t("selectAll")}</button>}
        {staleMemories.map((memory) => <label key={memory.id}><input type="checkbox" disabled={disabled || busy} checked={staleSelected.includes(memory.id)} onChange={(event) => toggleStale(memory.id, event.target.checked)} /><span>{memory.trigger ?? memory.title}<small>{typeLabel(language, memory.type)} · {memory.createdAt.slice(0, 10)}</small></span></label>)}
        {!!staleSelected.length && <button type="button" disabled={disabled || busy} onClick={() => void removeStale()}>{t("clearSelected")} ({staleSelected.length})</button>}
      </div>}
    </section>
  </div>;
}

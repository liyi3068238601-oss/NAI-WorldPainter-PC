import { createHash, randomUUID } from "node:crypto";
import type { AgentComposerAction, AgentConversation, AgentMessage, AgentSendRequest, AgentWorkspaceData } from "../../src/agent/types";
import type {
  R4AgentState,
  R4ConversationConfigSnapshot,
  R4ConversationCreativeState,
  R4Creation,
  R4CreationInputSnapshot,
  R4QueuedMessage,
} from "../../src/agent/r4-types";
import type { AgentSqlStore } from "./r4-store";

type QueueTransaction = Parameters<AgentSqlStore["transaction"]>[0];
type Transaction = Parameters<QueueTransaction>[0];

export interface R4PreparedMessage {
  visibleText: string;
  providerText: string;
  actions?: AgentComposerAction[];
}

export interface R4ConversationQueueHost {
  store: AgentSqlStore;
  captureConfig(
    workspace: AgentWorkspaceData,
    state: R4AgentState,
    conversationId: string,
    source: "message_send",
  ): R4ConversationConfigSnapshot;
  snapshotCreation(creation: R4Creation, config: R4ConversationConfigSnapshot): R4CreationInputSnapshot;
}

export interface R4ConversationQueueOptions {
  /** Runtime-owned Pi call. The user message is already durable before this runs. */
  run(item: R4QueuedMessage): Promise<void>;
  /** Must synchronously freeze action/template expansion at admission. */
  prepareMessage?(request: AgentSendRequest, config: R4ConversationConfigSnapshot): R4PreparedMessage;
  /** Injects a new user message into an already-running Pi turn. */
  steer?(item: R4QueuedMessage): Promise<boolean>;
  /** Removes only this exact unconsumed steer from the live Pi turn. */
  withdrawSteer?(item: R4QueuedMessage): Promise<boolean>;
  onChanged?(conversationId: string): void;
  now?(): string;
  id?(): string;
}

export interface R4ConversationQueueResult {
  ok: boolean;
  message?: string;
  messageId?: string;
  queueId?: string;
  state?: R4ConversationCreativeState;
  data?: Record<string, unknown>;
}

type QueueLock = { tail: Promise<void> };

const timestamp = () => new Date().toISOString();

function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function conversationState(state: R4AgentState, conversationId: string) {
  return state.conversations[conversationId] ??= {
    conversationId,
    messageCreationIds: {},
    selectionRevision: 0,
    updatedAt: timestamp(),
  };
}

function selectedAttachments(chat: AgentConversation, ids: string[]) {
  const byId = new Map(chat.draftAttachments.map((item) => [item.id, item]));
  if (ids.some((id) => !byId.has(id))) throw new Error("草稿附件已变化，请重新选择后发送。");
  return ids.map((id) => structuredClone(byId.get(id)!));
}

function attachmentIdsFor(request: AgentSendRequest, chat: AgentConversation, creativeDraft?: { attachmentIds: string[] }) {
  const ids = request.attachmentIds ?? creativeDraft?.attachmentIds ?? chat.draftAttachments.map((item) => item.id);
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !id) || new Set(ids).size !== ids.length) {
    throw new Error("草稿附件选择无效，请重新选择后发送。");
  }
  return [...ids];
}

function nextRevision(revision: number) {
  if (!Number.isSafeInteger(revision) || revision < 0 || revision === Number.MAX_SAFE_INTEGER) {
    throw new Error("草稿版本无效，请重新载入后发送。");
  }
  return revision + 1;
}

/**
 * Durable, per-conversation message admission and consumer coordination.
 * Queue rows and workspace messages share a SQLite transaction; `run` always
 * happens after that commit, so a restart cannot lose an accepted user turn.
 */
export class R4ConversationQueue {
  private readonly locks = new Map<string, QueueLock>();
  private readonly drains = new Map<string, Promise<void>>();
  private readonly now: () => string;
  private readonly id: () => string;

  isBusy(){return this.drains.size>0||this.locks.size>0;}

  constructor(readonly host: R4ConversationQueueHost, readonly options: R4ConversationQueueOptions) {
    this.now = options.now ?? timestamp;
    this.id = options.id ?? randomUUID;
  }

  /**
   * Serializes non-message work with the active Pi consumer for one chat.
   * Separate conversations never share a lock.
   */
  async withConversation<T>(conversationId: string, work: () => Promise<T> | T): Promise<T> {
    const previous = this.locks.get(conversationId)?.tail ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    this.locks.set(conversationId, { tail });
    await previous.catch(() => undefined);
    try {
      return await work();
    } finally {
      release();
      if (this.locks.get(conversationId)?.tail === tail) this.locks.delete(conversationId);
    }
  }

  enqueue(request: AgentSendRequest): R4ConversationQueueResult {
    try {
      const result = this.host.store.transaction((tx) => this.admit(tx, request));
      if (!result.ok || !result.messageId || !result.queueId) return result;
      this.changed(request.conversationId);
      if (request.delivery === "steer") void this.steerMessage(request.conversationId, result.messageId);
      else void this.kick(request.conversationId);
      return result;
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  private admit(tx: Transaction, request: AgentSendRequest): R4ConversationQueueResult {
    const workspace = tx.getWorkspace();
    const state = tx.getR4State();
    const chat = workspace.conversations.find((item) => item.id === request.conversationId);
    if (!chat || chat.archivedAt) return { ok: false, message: "对话不存在或已归档。" };
    if (!request || typeof request.text !== "string" || request.text.length > 200_000) {
      return { ok: false, message: "消息内容无效或过长。" };
    }
    const conversation = conversationState(state, request.conversationId);
    const savedDraft = conversation.composerDraft;
    const currentRevision = savedDraft?.revision ?? 0;
    if (request.composerDraftRevision !== undefined && request.composerDraftRevision !== currentRevision) {
      return { ok: false, message: "草稿已变化，请重新发送当前内容。" };
    }
    if (savedDraft && request.composerDraftRevision !== undefined
      && savedDraft.text.trim() !== request.text.trim()) {
      return { ok: false, message: "草稿内容与发送内容不一致，请重新发送当前内容。" };
    }
    const attachmentIds = attachmentIdsFor(request, chat, savedDraft);
    if (!request.text.trim() && !attachmentIds.length && !(request.actions?.length)) {
      return { ok: false, message: "请输入消息、选择操作或添加附件。" };
    }
    const attachments = selectedAttachments(chat, attachmentIds);

    const confirmationHash = request.confirmedConversationConfigHash;
    let config: R4ConversationConfigSnapshot;
    if (savedDraft?.requiresConfigConfirmation) {
      const restored = savedDraft.restoredConversationConfig;
      if (!restored || !savedDraft.restoredConfigFingerprint || !confirmationHash
        || confirmationHash !== savedDraft.restoredConfigFingerprint || confirmationHash !== hash(restored)) {
        return { ok: false, message: "这是恢复的旧配置快照；请先确认后再发送，当前草稿和配置均未改变。" };
      }
      config = structuredClone(restored);
    } else {
      config = this.host.captureConfig(workspace, state, request.conversationId, "message_send");
    }
    const prepared = this.options.prepareMessage
      ? this.options.prepareMessage(request, structuredClone(config))
      : request.actions?.length
        ? (() => { throw new Error("所选软件操作尚未准备，请稍后重试。") })()
        : { visibleText: request.text.trim(), providerText: request.text.trim(), actions: [] };
    if (typeof prepared.visibleText !== "string" || typeof prepared.providerText !== "string"
      || prepared.providerText.length > 250_000) throw new Error("消息准备结果无效或过长。");

    let inputSnapshot: R4CreationInputSnapshot | undefined;
    if (request.creationId !== undefined) {
      const creation = state.creations[request.creationId];
      if (!creation || creation.conversationId !== request.conversationId) {
        return { ok: false, message: "目标创作不存在或不属于当前对话。" };
      }
      inputSnapshot = this.host.snapshotCreation(creation, config);
    }

    const now = this.now();
    const queueId = this.id();
    const messageId = this.id();
    const userIntentRef = this.id();
    const sequence = Object.values(state.messageQueue)
      .filter((item) => item.conversationId === request.conversationId)
      .reduce((highest, item) => Math.max(highest, item.sequence), 0) + 1;
    const predecessorIds = chat.messages.map((message) => message.id);
    const clearRevision = nextRevision(currentRevision);
    const item: R4QueuedMessage = {
      id: queueId,
      conversationId: request.conversationId,
      messageId,
      sequence,
      text: request.text,
      providerText: prepared.providerText,
      ...(attachmentIds.length ? { attachmentIds } : {}),
      ...(prepared.actions?.length ? { actions: prepared.actions.map((action) => ({ ...action })) } : {}),
      ...(request.creationId ? { creationId: request.creationId } : {}),
      steeringStatus: request.delivery === "steer" ? "requested" : "none",
      predecessorIds,
      userIntentRef,
      conversationConfig: structuredClone(config),
      ...(inputSnapshot ? { originalInputSnapshot: structuredClone(inputSnapshot) } : {}),
      draftRecovery: {
        draftRevision: clearRevision,
        inputFingerprint: hash({ text: request.text, attachmentIds }),
        status: "unchanged",
      },
      status: "queued",
      createdAt: now,
      updatedAt: now,
    };
    const userMessage: AgentMessage = {
      id: messageId,
      role: "user",
      content: prepared.visibleText,
      actions: prepared.actions?.length ? structuredClone(prepared.actions) : undefined,
      attachments,
      tools: [],
      status: "complete",
      createdAt: now,
      ...(request.creationId ? { creationId: request.creationId } : {}),
      conversationConfig: structuredClone(config),
      ...(inputSnapshot ? { originalInputSnapshot: structuredClone(inputSnapshot) } : {}),
      queuedMessageId: queueId,
      userIntentRef,
    };

    state.messageQueue[queueId] = item;
    if (request.creationId) conversation.messageCreationIds[messageId] = request.creationId;
    conversation.composerDraft = {
      text: "",
      revision: clearRevision,
      attachmentIds: [],
      updatedAt: now,
    };
    chat.draftAttachments = chat.draftAttachments.filter((attachment) => !attachmentIds.includes(attachment.id));
    chat.messages.push(userMessage);
    chat.updatedAt = now;
    if (chat.messages.filter((message) => message.role === "user").length === 1 && request.text.trim()) {
      chat.title = request.text.replace(/[\r\n]+/g, " ").slice(0, 36) || chat.title;
    }
    workspace.updatedAt = now;
    tx.setWorkspace(workspace);
    tx.setR4State(state);
    return { ok: true, messageId, queueId, data: { sequence, providerTextFrozen: true, predecessorIds } };
  }

  /** Start the earliest safe queued message; concurrent calls coalesce per chat. */
  kick(conversationId: string): Promise<void> {
    const current = this.drains.get(conversationId);
    if (current) return current;
    const drain = this.withConversation(conversationId, () => this.drain(conversationId));
    this.drains.set(conversationId, drain);
    void drain.finally(() => {
      if (this.drains.get(conversationId) === drain) this.drains.delete(conversationId);
    }).catch(() => undefined);
    return drain;
  }

  private async drain(conversationId: string) {
    for (;;) {
      const item = this.claimNext(conversationId);
      if (!item) return;
      this.changed(conversationId);
      try {
        await this.options.run(structuredClone(item));
        const latest = this.findByMessageId(conversationId, item.messageId);
        // The runtime may mark it waiting_execution or complete while running.
        if (latest?.status === "running") {
          this.finishTurn(conversationId, item.messageId, { ok: true, assistantId: latest.assistantMessageId });
        }
      } catch (error) {
        this.finishTurn(conversationId, item.messageId, {
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
        });
        this.changed(conversationId);
        return;
      }
    }
  }

  private claimNext(conversationId: string): R4QueuedMessage | undefined {
    let gatePaused=false;
    const result = this.host.store.transaction((tx) => {
      const state = tx.getR4State();
      const items = Object.values(state.messageQueue)
        .filter((item) => item.conversationId === conversationId)
        .sort((a, b) => a.sequence - b.sequence);
      const terminal = (item: R4QueuedMessage) => ["completed", "cancelled", "error"].includes(item.status);
      const explicit=items.find(item=>item.status==='queued'&&item.releasedGateIds?.length&&items.filter(prior=>prior.sequence<item.sequence).every(prior=>terminal(prior)||prior.status==='paused'&&item.bypassPausedPredecessorIds?.includes(prior.messageId)));
      let first: R4QueuedMessage | undefined=explicit;
      for (const item of items) {
        if(first)break;
        if (terminal(item)) continue;
        // A later explicit user send may proceed while definitely-unsent paused
        // messages remain untouched; risky/started pauses still serialize work.
        if (item.status === "paused" && !item.startedAt && item.steeringStatus !== "consumed" && !this.mayHaveSideEffects(item)) continue;
        if (item.status !== "queued" || item.steeringStatus === "requested") return undefined;
        first = item;
        break;
      }
      if (!first) return undefined;
      const blockingGate=Object.values(state.gates).find(gate=>gate.active&&((gate.reason==='unknown_prior_receipt'&&!first!.releasedGateIds?.includes(gate.id))||gate.turnId===first!.userIntentRef));
      if(blockingGate){first.status='paused';first.pauseReason='存在待核实收费回执；请明确选择无关的新消息继续，旧请求不会重发。';first.updatedAt=this.now();tx.setR4State(state);gatePaused=true;return undefined;}
      first.status = "running";
      first.pauseReason = undefined;
      first.assistantMessageId ??= this.id();
      first.startedAt ??= this.now();
      first.updatedAt = this.now();
      tx.setR4State(state);
      return structuredClone(first);
    });
    if(gatePaused)this.changed(conversationId);
    return result;
  }

  async steerMessage(conversationId: string, messageId: string): Promise<R4ConversationQueueResult> {
    const reserved = this.host.store.transaction((tx) => {
      const workspace = tx.getWorkspace();
      const state = tx.getR4State();
      const chat = workspace.conversations.find((item) => item.id === conversationId);
      const item = Object.values(state.messageQueue).find((candidate) => candidate.conversationId === conversationId && candidate.messageId === messageId);
      if (!chat || !item) return { ok: false as const, message: "排队消息不存在。" };
      if (chat.status !== "running" || item.status !== "queued" || item.steeringStatus === "consumed") {
        return { ok: false as const, message: "当前回复不可接收引导消息。" };
      }
      item.steeringStatus = "requested";
      const active = Object.values(state.messageQueue).find((candidate) => candidate.conversationId === conversationId
        && candidate.status === "running" && candidate.messageId !== item.messageId);
      if (active?.assistantMessageId) item.assistantMessageId = active.assistantMessageId;
      item.updatedAt = this.now();
      tx.setR4State(state);
      return { ok: true as const, item: structuredClone(item) };
    });
    if (!reserved.ok) return reserved;
    this.changed(conversationId);
    try {
      const accepted = await this.options.steer?.(reserved.item) ?? false;
      if (accepted) return { ok: true, messageId, queueId: reserved.item.id };
      this.releaseSteerReservation(conversationId, messageId, "当前运行时未接收引导；消息保留在队列中。", false);
      void this.kick(conversationId);
      return { ok: false, message: "当前运行时未接收引导；消息保留在队列中。", messageId, queueId: reserved.item.id };
    } catch (error) {
      this.releaseSteerReservation(conversationId, messageId, error instanceof Error ? error.message : String(error), true);
      return { ok: false, message: error instanceof Error ? error.message : String(error), messageId, queueId: reserved.item.id };
    }
  }

  /** Call only after the Pi runtime confirms message_start for this steer. */
  markSteeringConsumed(conversationId: string, messageId: string, assistantMessageId?: string) {
    const changed = this.host.store.transaction((tx) => {
      const state = tx.getR4State();
      const item = Object.values(state.messageQueue).find((candidate) => candidate.conversationId === conversationId && candidate.messageId === messageId);
      if (!item || item.steeringStatus !== "requested" || item.status === "cancelled") return false;
      item.steeringStatus = "consumed";
      item.status = "running";
      if (assistantMessageId) item.assistantMessageId = assistantMessageId;
      item.startedAt ??= this.now();
      item.updatedAt = this.now();
      tx.setR4State(state);
      return true;
    });
    if (changed) this.changed(conversationId);
    return changed;
  }

  private releaseSteerReservation(conversationId: string, messageId: string, reason: string, pause: boolean) {
    this.host.store.transaction((tx) => {
      const state = tx.getR4State();
      const item = Object.values(state.messageQueue).find((candidate) => candidate.conversationId === conversationId && candidate.messageId === messageId);
      if (!item || item.steeringStatus !== "requested") return;
      item.steeringStatus = "none";
      if (pause) {
        item.status = "paused";
        item.pauseReason = reason;
      }
      item.updatedAt = this.now();
      tx.setR4State(state);
    });
    this.changed(conversationId);
  }

  complete(conversationId: string, messageId: string) {
    const changed = this.host.store.transaction((tx) => {
      const state = tx.getR4State();
      const item = Object.values(state.messageQueue).find((candidate) => candidate.conversationId === conversationId && candidate.messageId === messageId);
      if (!item || ["completed", "cancelled"].includes(item.status)) return false;
      item.status = "completed";
      item.pauseReason = undefined;
      item.updatedAt = this.now();
      tx.setR4State(state);
      return true;
    });
    if (changed) {
      this.changed(conversationId);
      void this.kick(conversationId);
    }
    return changed;
  }

  /**
   * End one Pi reply and reconcile any steer messages admitted into it. A
   * steer not consumed before a successful end becomes ordinary queued work;
   * an unconsumed steer on stop/error is paused instead of silently lost.
   */
  finishTurn(
    conversationId: string,
    originMessageId: string,
    result: { ok: boolean; assistantId?: string; reason?: string },
  ) {
    const updated = this.host.store.transaction((tx) => {
      const state = tx.getR4State();
      const items = Object.values(state.messageQueue)
        .filter((item) => item.conversationId === conversationId)
        .sort((a, b) => a.sequence - b.sequence);
      const origin = items.find((item) => item.messageId === originMessageId);
      if (!origin) return false;
      const assistantId = result.assistantId ?? origin.assistantMessageId;
      if (assistantId) origin.assistantMessageId = assistantId;
      origin.status = result.ok ? "completed" : "error";
      origin.pauseReason = result.ok ? undefined : (result.reason ?? "运行时结束时未确认回复结果。").slice(0, 500);
      origin.updatedAt = this.now();
      for (const item of items) {
        if (item.id === origin.id || item.assistantMessageId !== assistantId) continue;
        if (item.steeringStatus === "consumed") {
          item.status = result.ok ? "completed" : "error";
          item.pauseReason = result.ok ? undefined : (result.reason ?? "接收引导后的回复未成功完成。").slice(0, 500);
          item.updatedAt = this.now();
        } else if (item.steeringStatus === "requested") {
          item.steeringStatus = "none";
          item.status = result.ok ? "queued" : "paused";
          item.pauseReason = result.ok ? "引导未被本轮消费；已回到普通消息队列。" : (result.reason ?? "原回复已停止或失败；引导未消费，等待显式恢复。").slice(0, 500);
          item.updatedAt = this.now();
        }
      }
      if (!result.ok) {
        for (const item of items) {
          if (item.sequence > origin.sequence && item.status === "queued") {
            item.status = "paused";
            item.pauseReason = `前序回复失败：${originMessageId}`;
            item.updatedAt = this.now();
          }
        }
      }
      tx.setR4State(state);
      return true;
    });
    if (updated) {
      this.changed(conversationId);
      if (result.ok) void this.kick(conversationId);
    }
    return updated;
  }

  waitForExecution(conversationId: string, messageId: string) {
    return this.setStatus(conversationId, messageId, "waiting_execution");
  }

  pause(conversationId: string, reason: string, messageId?: string) {
    const now = this.now();
    const changed = this.host.store.transaction((tx) => {
      const state = tx.getR4State();
      const candidates = Object.values(state.messageQueue).filter((item) => item.conversationId === conversationId
        && (messageId ? item.messageId === messageId : ["queued", "running", "waiting_execution"].includes(item.status)));
      for (const item of candidates) {
        if (["completed", "cancelled"].includes(item.status)) continue;
        item.status = "paused";
        item.pauseReason = reason.slice(0, 500);
        item.updatedAt = now;
      }
      if (candidates.length) tx.setR4State(state);
      return candidates.length > 0;
    });
    if (changed) this.changed(conversationId);
    return changed;
  }

  async cancel(conversationId: string, messageId: string, draftRevision?: number): Promise<R4ConversationQueueResult> {
    const before = this.host.store.readR4State();
    const candidate = Object.values(before.messageQueue).find((item) => item.conversationId === conversationId && item.messageId === messageId);
    let withdrewSteer = false;
    if (candidate?.steeringStatus === "requested") {
      const creative = before.conversations[conversationId];
      if (draftRevision !== undefined && draftRevision !== (creative?.composerDraft?.revision ?? 0)) {
        return { ok: false, message: "草稿已变化，取消不会覆盖新内容。" };
      }
      if (!candidate || !this.options.withdrawSteer) return { ok: false, message: "当前运行时不支持安全撤回引导消息。" };
      if (!(await this.options.withdrawSteer(structuredClone(candidate)))) {
        return { ok: false, message: "运行时未确认撤回；消息仍保留在队列中。" };
      }
      withdrewSteer = true;
    }
    const result = this.host.store.transaction((tx) => {
      const workspace = tx.getWorkspace();
      const state = tx.getR4State();
      const chat = workspace.conversations.find((item) => item.id === conversationId);
      const creative = state.conversations[conversationId];
      const item = Object.values(state.messageQueue).find((candidate) => candidate.conversationId === conversationId && candidate.messageId === messageId);
      if (!chat || !creative || !item) return { ok: false, message: "排队消息不存在。" };
      if (draftRevision !== undefined && draftRevision !== (creative.composerDraft?.revision ?? 0)) {
        return { ok: false, message: "草稿已变化，取消不会覆盖新内容。" };
      }
      if (withdrewSteer && (item.updatedAt !== candidate?.updatedAt || item.steeringStatus !== "requested")) {
        return { ok: false, message: "引导状态已变化，撤回结果不再适用于当前队列项。" };
      }
      if (item.status !== "queued" && item.status !== "paused") return { ok: false, message: "消息已经开始处理，不能作为未发送消息取消。" };
      if (item.steeringStatus === "consumed") return { ok: false, message: "引导消息已交给运行时，不能撤回为草稿。" };
      if (this.mayHaveSideEffects(item)) return { ok: false, message: "此消息可能已有回复或工具副作用；请恢复为新草稿，不能按未发送消息撤回。" };
      item.status = "cancelled";
      item.steeringStatus = "none";
      item.updatedAt = this.now();
      const recovery = item.draftRecovery;
      const currentDraft = creative.composerDraft ?? { text: "", revision: 0, attachmentIds: [], updatedAt: this.now() };
      const canRestore = recovery?.draftRevision === currentDraft.revision
        && !currentDraft.text.trim() && currentDraft.attachmentIds.length === 0;
      if (canRestore) {
        const message = chat.messages.find((candidate) => candidate.id === messageId && candidate.role === "user");
        const restored = (message?.attachments ?? []).filter((attachment) => !attachment.unavailable);
        const restoredIds = restored.map((attachment) => attachment.id);
        chat.draftAttachments = [...chat.draftAttachments.filter((attachment) => !restoredIds.includes(attachment.id)), ...structuredClone(restored)];
        const revision = nextRevision(currentDraft.revision);
        creative.composerDraft = { text: item.text, revision, attachmentIds: restoredIds, updatedAt: this.now() };
        if (recovery) recovery.status = "unchanged";
      } else if (recovery) {
        recovery.status = "changed";
      }
      if (chat.messages.some((candidate) => candidate.id === messageId)) {
        const message = chat.messages.find((candidate) => candidate.id === messageId)!;
        message.queuedMessageId = item.id;
      }
      tx.setWorkspace(workspace);
      tx.setR4State(state);
      return { ok: true, messageId, queueId: item.id, data: { restored: canRestore, actions: item.actions ?? [] } };
    });
    if (result.ok) this.changed(conversationId);
    return result;
  }

  /** Restore a cancelled/unstarted message only into a blank exact-revision draft. */
  restore(conversationId: string, messageId: string, expectedDraftRevision: number): R4ConversationQueueResult {
    const result = this.host.store.transaction((tx) => {
      const workspace = tx.getWorkspace();
      const state = tx.getR4State();
      const chat = workspace.conversations.find((item) => item.id === conversationId);
      const creative = state.conversations[conversationId];
      const item = Object.values(state.messageQueue).find((candidate) => candidate.conversationId === conversationId && candidate.messageId === messageId);
      if (!chat || !creative || !item) return { ok: false, message: "消息不存在。" };
      const draft = creative.composerDraft ?? { text: "", revision: 0, attachmentIds: [], updatedAt: this.now() };
      if (expectedDraftRevision !== draft.revision) return { ok: false, message: "草稿已变化，未覆盖当前内容。" };
      if (draft.text.trim() || draft.attachmentIds.length || chat.draftAttachments.length) {
        return { ok: false, message: "当前草稿不为空；为保护新内容，请先手动整理后再恢复。" };
      }
      if (item.status !== "cancelled" && item.status !== "paused" && item.status !== "error") {
        return { ok: false, message: "此消息仍在队列中，不能恢复为新草稿。" };
      }
      const message = chat.messages.find((candidate) => candidate.id === messageId && candidate.role === "user");
      const attachments = (message?.attachments ?? []).filter((attachment) => !attachment.unavailable);
      const ids = attachments.map((attachment) => attachment.id);
      chat.draftAttachments = structuredClone(attachments);
      creative.composerDraft = {
        text: item.text,
        revision: nextRevision(draft.revision),
        attachmentIds: ids,
        updatedAt: this.now(),
        restoredConversationConfig: structuredClone(item.conversationConfig),
        requiresConfigConfirmation: true,
        restoredConfigFingerprint: hash(item.conversationConfig),
      };
      if (item.status !== "cancelled") {
        item.pauseReason = `${item.pauseReason ? `${item.pauseReason}；` : ""}已恢复为新草稿；旧运行绝不重放，之前可能已有回复或工具副作用。`;
        item.status = "cancelled";
        item.steeringStatus = item.steeringStatus === "requested" ? "none" : item.steeringStatus;
        item.updatedAt = this.now();
      }
      item.draftRecovery ??= { status: "legacy_unversioned" };
      item.draftRecovery.status = "unchanged";
      chat.updatedAt = this.now();
      tx.setWorkspace(workspace);
      tx.setR4State(state);
      return { ok: true, messageId, queueId: item.id, data: { actions: item.actions ?? [], newRequestOnly: true, conversationConfigHash: hash(item.conversationConfig) } };
    });
    if (result.ok) this.changed(conversationId);
    return result;
  }

  resumeSelected(conversationId:string,messageIds:string[],acknowledgedGateIds:string[]):R4ConversationQueueResult{
    if(!Array.isArray(messageIds)||!messageIds.length||messageIds.length>64||messageIds.some(id=>typeof id!=='string'||!id)||new Set(messageIds).size!==messageIds.length
      ||!Array.isArray(acknowledgedGateIds)||!acknowledgedGateIds.length||acknowledgedGateIds.length>128||acknowledgedGateIds.some(id=>typeof id!=='string'||!id))return {ok:false,message:'请明确列出要继续的新消息与已确认的待核实记录。'};
    const result=this.host.store.transaction(tx=>{
      const state=tx.getR4State(),items=Object.values(state.messageQueue).filter(item=>item.conversationId===conversationId).sort((a,b)=>a.sequence-b.sequence);
      const chosen=messageIds.map(id=>items.find(item=>item.messageId===id));
      const gates=acknowledgedGateIds.map(id=>state.gates[id]);
      if(gates.some(gate=>!gate?.active||gate.reason!=='unknown_prior_receipt'))return {ok:false,message:'待核实记录已变化，请重新查看后再确认。'};
      if(chosen.some(item=>!item||!['queued','paused'].includes(item.status)||item.startedAt||this.mayHaveSideEffects(item)||item.steeringStatus==='requested'||item.steeringStatus==='consumed'))return {ok:false,message:'只能明确继续尚未启动且没有工具副作用的新消息，不能重放旧请求。'};
      if(chosen.some(item=>gates.some(gate=>gate.turnId===item!.userIntentRef)))return {ok:false,message:'此消息关联原待核实请求，不能作为无关新任务继续。'};
      for(const item of chosen as R4QueuedMessage[]){
        const prior=items.filter(row=>row.sequence<item.sequence&&!['completed','cancelled','error'].includes(row.status));
        if(prior.some(row=>!['queued','paused'].includes(row.status)||row.steeringStatus==='consumed'))return {ok:false,message:'前序回复仍在执行，请等它结束后继续新消息。'};
      }
      for(const item of chosen as R4QueuedMessage[]){
        const prior=items.filter(row=>row.sequence<item.sequence&&!['completed','cancelled','error'].includes(row.status)&&!messageIds.includes(row.messageId));
        for(const row of prior)if(row.status==='queued'){row.status='paused';row.pauseReason='保留原队列；用户仅选择了另一条新消息继续。';row.updatedAt=this.now();}
        item.bypassPausedPredecessorIds=prior.map(row=>row.messageId);item.releasedGateIds=[...new Set([...(item.releasedGateIds??[]),...acknowledgedGateIds])];item.status='queued';item.pauseReason=undefined;item.updatedAt=this.now();
      }
      const id=this.id();state.operations[id]={id,conversationId,creationId:chosen[0]!.creationId!,operationKey:id,operation:'release_independent_messages',status:'applied',receipt:{messageIds:[...messageIds],acknowledgedGateIds:[...acknowledgedGateIds],oldRequestsReplayed:false},createdAt:this.now()};
      tx.setR4State(state);return {ok:true,data:{restoredMessageIds:messageIds,acknowledgedGateIds}};
    });
    if(result.ok){this.changed(conversationId);void this.kick(conversationId);}return result;
  }

  resume(conversationId: string): R4ConversationQueueResult {
    const changed = this.host.store.transaction((tx) => {
      const state = tx.getR4State();
      const chatItems = Object.values(state.messageQueue).filter((item) => item.conversationId === conversationId).sort((a, b) => a.sequence - b.sequence);
      const terminal = (item: R4QueuedMessage) => ["completed", "cancelled", "error"].includes(item.status);
      const first = chatItems.find((item) => !terminal(item));
      if (!first) return { ok: true, message: "没有待恢复的消息。" };
      if (first.status === "running" || first.status === "waiting_execution" || this.mayHaveSideEffects(first)) {
        return { ok: false, message: "前序消息可能已产生回复或工具副作用；只能恢复为新草稿，不能重放。" };
      }
      if (first.status !== "paused" && first.status !== "queued") return { ok: false, message: "队列当前无需恢复。" };
      const restored: string[] = [];
      for (const item of chatItems) {
        if (terminal(item)) continue;
        if ((item.status === "paused" || item.status === "queued") && !item.startedAt
          && item.steeringStatus !== "requested" && !this.mayHaveSideEffects(item)) {
          item.status = "queued";
          item.pauseReason = undefined;
          item.updatedAt = this.now();
          restored.push(item.messageId);
          continue;
        }
        break;
      }
      if (!restored.length) return { ok: false, message: "没有可安全恢复的未启动消息。" };
      tx.setR4State(state);
      return { ok: true, messageId: first.messageId, queueId: first.id, data: { restoredMessageIds: restored } };
    });
    if (changed.ok && changed.messageId) {
      this.changed(conversationId);
      void this.kick(conversationId);
    }
    return changed;
  }

  /** Startup reconciliation only pauses; it never calls `run` or replays tools. */
  recover(): { pausedRunning: number; pausedQueued: number; pausedWaitingExecution: number } {
    const counts = this.host.store.transaction((tx) => {
      const state = tx.getR4State();
      let pausedRunning = 0, pausedQueued = 0, pausedWaitingExecution = 0;
      const changed = new Set<string>();
      for (const item of Object.values(state.messageQueue)) {
        if (item.status === "running") {
          item.status = "paused";
          item.pauseReason = "recovered:running; 之前可能已有回复或工具副作用，禁止重放。";
          item.updatedAt = this.now();
          pausedRunning += 1;
          changed.add(item.conversationId);
        } else if (item.status === "waiting_execution") {
          item.status = "paused";
          item.pauseReason = "recovered:waiting_execution; 检查执行回执后恢复为新草稿。";
          item.updatedAt = this.now();
          pausedWaitingExecution += 1;
          changed.add(item.conversationId);
        } else if (item.status === "queued") {
          item.status = "paused";
          item.pauseReason = "recovered:queued; 需要显式恢复后才能继续。";
          item.updatedAt = this.now();
          pausedQueued += 1;
          changed.add(item.conversationId);
        }
      }
      if (changed.size) tx.setR4State(state);
      return { pausedRunning, pausedQueued, pausedWaitingExecution, conversations: [...changed] };
    });
    for (const conversationId of counts.conversations) this.changed(conversationId);
    return { pausedRunning: counts.pausedRunning, pausedQueued: counts.pausedQueued, pausedWaitingExecution: counts.pausedWaitingExecution };
  }

  private setStatus(conversationId: string, messageId: string, status: R4QueuedMessage["status"]) {
    const changed = this.host.store.transaction((tx) => {
      const state = tx.getR4State();
      const item = Object.values(state.messageQueue).find((candidate) => candidate.conversationId === conversationId && candidate.messageId === messageId);
      if (!item || ["completed", "cancelled"].includes(item.status)) return false;
      item.status = status;
      item.updatedAt = this.now();
      tx.setR4State(state);
      return true;
    });
    if (changed) this.changed(conversationId);
    return changed;
  }

  private mayHaveSideEffects(item: R4QueuedMessage) {
    return /recovered:running|waiting_execution|unknown|side.effect|tool/i.test(item.pauseReason ?? "")
      || item.steeringStatus === "consumed"
      || Boolean(item.startedAt)
      || item.status === "error";
  }

  private findByMessageId(conversationId: string, messageId: string) {
    return Object.values(this.host.store.readR4State().messageQueue)
      .find((item) => item.conversationId === conversationId && item.messageId === messageId);
  }

  private changed(conversationId: string) {
    try { this.options.onChanged?.(conversationId); } catch { /* observers cannot roll back durable queue state */ }
  }
}

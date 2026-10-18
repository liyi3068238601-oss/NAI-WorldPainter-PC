import { randomUUID } from "node:crypto";
import type {
  R4AgentState,
  R4Artwork,
  R4Execution,
  R4ExecutionOutput,
  R4ExecutionStatus,
  R4OutputStatus,
  R4ProviderCancellation,
  R4ProviderReceipt,
  R4ProviderReceiptStatus,
} from "../../src/agent/r4-types";
import { validateR4ExecutionSemantics } from "../../src/agent/r4-execution-semantics";
import type { AgentSqlStore, AgentSqlTransaction } from "./r4-store";
import type { R4NativeRequestKind } from "./r4-native-context";

export interface R4ProviderOutputResult {
  outputIndex: number;
  status: R4OutputStatus;
  artwork?: R4Artwork;
  providerReceipt?: R4ProviderReceipt;
  errorCode?: string;
  errorMessage?: string;
  resolvedSeed?: number | null;
  resolvedSeedSource?: R4ExecutionOutput["resolvedSeedSource"];
}

export interface R4NativeRequestReceipt {
  status: "pending" | "confirmed" | "failed" | "unknown";
  requestId?: string;
  serviceTaskId?: string;
  message?: string;
  rawStatus?: string;
}

export interface R4ProviderSubmitResult {
  /** Transport/request evidence is independent from per-output results. */
  requestDisposition: "not_sent" | "sent" | "unknown";
  outputs: R4ProviderOutputResult[];
  providerReceiptStatus?: R4ProviderReceiptStatus;
  providerServiceTaskId?: string;
  providerCancellation?: R4ProviderCancellation;
}

export interface R4ProviderVerifyResult {
  requestDisposition: "not_sent" | "sent" | "unknown";
  outputs?: R4ProviderOutputResult[];
  providerReceiptStatus: R4ProviderReceiptStatus;
  providerServiceTaskId?: string;
  providerCancellation?: R4ProviderCancellation;
}

export interface R4ProviderCancelResult {
  disposition: "requested" | "confirmed" | "unsupported" | "unknown";
  message?: string;
}

export interface R4ExecutionProvider {
  /** outputIndex is null for one remote batch request, otherwise one slot. */
  submit(
    execution: Readonly<R4Execution>,
    outputIndex: number | null,
    context: {
      signal: AbortSignal;
      beforeSubmit(kind?: R4NativeRequestKind): Promise<void>;
      afterReceipt(kind: R4NativeRequestKind, receipt: R4NativeRequestReceipt): Promise<void>;
    },
  ): Promise<R4ProviderSubmitResult>;
  verify?(execution: Readonly<R4Execution>): Promise<R4ProviderVerifyResult>;
  cancel?(execution: Readonly<R4Execution>): Promise<R4ProviderCancelResult>;
}

export interface R4ExecutionWorkerOptions {
  onChanged?: (conversationId: string, executionId: string) => void;
  onError?: (error: unknown, executionId?: string) => void;
  /** Synchronous registration hook for workspace messages/artifacts in this same SQL commit. */
  onTransaction?: (tx: AgentSqlTransaction, state: R4AgentState, execution: R4Execution) => void;
}

const now = () => new Date().toISOString();
const copy = <T>(value: T): T => structuredClone(value);
const ACTIVE_STATUSES = new Set<R4ExecutionStatus>(["dispatching", "running", "cancel_requested"]);
const TERMINAL_STATUSES = new Set<R4ExecutionStatus>(["completed", "partial", "error", "cancelled", "blocked", "denied"]);

function appendEvent(execution: R4Execution, kind: string, detail: Record<string, unknown> = {}, outputIndex?: number) {
  execution.events ??= [];
  execution.events.push({ id: randomUUID(), kind, at: now(), ...(outputIndex === undefined ? {} : { outputIndex }), detail });
  execution.updatedAt = now();
}

function requestBudget(execution: R4Execution): Record<R4NativeRequestKind, number> {
  const parameters = execution.approvedInput.publicParameters;
  const explicit = parameters.requestBudget;
  if (explicit && typeof explicit === "object" && !Array.isArray(explicit)) {
    const budget = explicit as Record<string, unknown>;
    const result: Record<R4NativeRequestKind, number> = { image: 0, vibe_encode: 0, upscale: 0 };
    for (const kind of Object.keys(result) as R4NativeRequestKind[]) {
      const value = Number(budget[kind]);
      if (!Number.isSafeInteger(value) || value < 0) throw new Error(`批准快照中的 ${kind} 请求预算无效。`);
      result[kind] = value;
    }
    return result;
  }

  // Older snapshots have no explicit budget. Keep their image slot behavior,
  // and only permit auxiliary requests that are visible in the frozen input.
  const vibeReferences = Array.isArray(parameters.vibeReferences) ? parameters.vibeReferences.length : 0;
  const operation = String(parameters.operation ?? "");
  const passes = Number(parameters.upscalePasses ?? parameters.passes);
  return {
    image: execution.requestGranularity === "batch" ? 1 : execution.expectedOutputCount,
    vibe_encode: vibeReferences,
    upscale: /upscale/i.test(operation)
      ? Number.isSafeInteger(passes) && passes > 0 ? Math.min(8, passes) : 4
      : 0,
  };
}

function eventDetail(event: R4Execution["events"][number]) {
  return event.detail ?? {};
}

function boundaries(execution: R4Execution) {
  return execution.events.filter((event) => event.kind === "native_request_boundary");
}

function hasUnreceiptedBoundary(execution: R4Execution) {
  const receipts = new Set(execution.events
    .filter((event) => event.kind === "native_request_receipt")
    .map((event) => Number(eventDetail(event).sequence)));
  return boundaries(execution).some((event) => !receipts.has(Number(eventDetail(event).sequence)));
}

function latestReceipt(execution: R4Execution, sequence: number) {
  return execution.events
    .filter((event) => event.kind === "native_request_receipt" && Number(eventDetail(event).sequence) === sequence)
    .at(-1);
}

function boundaryOutputs(execution: R4Execution, sinceSequence = -1) {
  const indexes = new Set<number>();
  for (const event of boundaries(execution)) {
    const detail = eventDetail(event);
    if (Number(detail.sequence) <= sinceSequence) continue;
    if (Number.isSafeInteger(detail.outputIndex)) indexes.add(Number(detail.outputIndex));
    for (const index of Array.isArray(detail.outputIndexes) ? detail.outputIndexes : []) {
      if (Number.isSafeInteger(index)) indexes.add(Number(index));
    }
  }
  return indexes;
}

function appendLatestNativeOutcome(execution: R4Execution, status: R4NativeRequestReceipt["status"], message?: string) {
  const boundary = boundaries(execution).at(-1);
  if (!boundary) return;
  const detail = eventDetail(boundary);
  appendEvent(execution, "native_request_receipt", {
    kind: detail.kind,
    sequence: detail.sequence,
    status,
    ...(message ? { message: message.slice(0, 2_000) } : {}),
  });
}

function hasActiveGate(state: R4AgentState, execution: R4Execution) {
  const released = new Set(execution.releasedGateIds ?? []);
  const batchId = String(execution.approvedInput.publicParameters.batchId ?? "");
  return Object.values(state.gates).find((gate) => {
    if (!gate.active || released.has(gate.id)) return false;
    if (gate.reason === "unknown_prior_receipt") return true;
    return gate.executionId === execution.id
      || Boolean(gate.turnId && gate.turnId === String(execution.approvedInput.publicParameters.turnLineageRef??execution.userIntentRef))
      || Boolean(gate.batchId && batchId && gate.batchId === batchId);
  });
}

function ensureOutputSlots(execution: R4Execution) {
  if (!Array.isArray(execution.outputs) || execution.outputs.length !== execution.expectedOutputCount) {
    throw new Error("Execution 输出槽位未按批准数量预分配，拒绝派发。");
  }
  const seen = new Set<number>();
  for (const output of execution.outputs) {
    if (!Number.isSafeInteger(output.outputIndex) || output.outputIndex < 0 || output.outputIndex >= execution.expectedOutputCount || seen.has(output.outputIndex)) {
      throw new Error("Execution 输出槽位编号无效或重复，拒绝派发。");
    }
    seen.add(output.outputIndex);
  }
  if (seen.size !== execution.expectedOutputCount) throw new Error("Execution 输出槽位不连续，拒绝派发。");
}

function addGate(state: R4AgentState, execution: R4Execution, reason: string) {
  const existing = Object.values(state.gates).find((gate) => gate.active && gate.executionId === execution.id);
  if (existing) return existing.id;
  const id = randomUUID();
  state.gates[id] = {
    id,
    conversationId: execution.conversationId,
    executionId: execution.id,
    turnId: String(execution.approvedInput.publicParameters.turnLineageRef??execution.userIntentRef),
    sourceExecutionId: execution.id,
    active: true,
    reason,
    createdAt: now(),
  };
  return id;
}

/**
 * A provider result can be durable even when its local artwork/message
 * registration transaction fails. Keep that distinct from provider failure:
 * the output slots retain their real states, while this lineage gate prevents
 * additional paid work until startup recovery repairs the local registration.
 */
function addRegistrationGate(state: R4AgentState, execution: R4Execution) {
  const id = `registration:${execution.id}`;
  const existing = state.gates[id];
  if (existing?.active) return id;
  const publicParameters = execution.approvedInput.publicParameters;
  const lineage = publicParameters.turnLineageRef ?? execution.userIntentRef;
  const batchId = publicParameters.batchId;
  state.gates[id] = {
    id,
    conversationId: execution.conversationId,
    executionId: execution.id,
    ...(lineage ? { turnId: String(lineage) } : {}),
    ...(typeof batchId === "string" && batchId ? { batchId } : {}),
    sourceExecutionId: execution.id,
    active: true,
    reason: "prior_paid_failure",
    createdAt: now(),
  };
  return id;
}

function releaseRegistrationGate(state: R4AgentState, execution: R4Execution) {
  const gate = state.gates[`registration:${execution.id}`];
  if (!gate?.active) return false;
  gate.active = false;
  gate.releasedAt = now();
  gate.releasedBy = "artwork_registration_recovered";
  appendEvent(execution, "artwork_registration_gate_released", { gateId: gate.id });
  return true;
}

function registrationRecoveryFailure(error: unknown) {
  if (!error || typeof error !== "object") return undefined;
  const value = error as { code?: unknown; message?: unknown };
  const code = typeof value.code === "string" ? value.code : "";
  if (["ENOENT", "EACCES", "EPERM", "EISDIR", "ENOTDIR", "EIO", "EMFILE", "ENFILE"].includes(code)) {
    return "local_artwork_unavailable";
  }
  const message = typeof value.message === "string" ? value.message : "";
  if (message.startsWith("执行目标聊天或创作已不存在")) return "registration_target_missing";
  if (message.startsWith("结果图片缺少可读文件、哈希或尺寸证据")) return "local_artwork_invalid";
  if (message.startsWith("结果文件与服务产物登记哈希不一致")) return "local_artwork_hash_mismatch";
  if (message.startsWith("结果身份冲突")) return "artwork_identity_conflict";
  return undefined;
}

function markOutput(execution: R4Execution, result: R4ProviderOutputResult) {
  const output = execution.outputs.find((item) => item.outputIndex === result.outputIndex);
  if (!output) throw new Error(`Provider 返回了未预分配的 outputIndex ${result.outputIndex}。`);
  if (result.status === "completed") {
    if (!result.artwork) throw new Error(`Provider 将 outputIndex ${result.outputIndex} 标记为 completed，但没有可登记 artwork。`);
    output.artwork = {
      ...copy(result.artwork),
      id: result.artwork.id,
      attachmentId: result.artwork.attachmentId,
      revision: result.artwork.revision,
      conversationId: execution.conversationId,
      creationId: execution.creationId,
      executionId: execution.id,
      outputIndex: result.outputIndex,
    };
    output.resolvedSeed = result.resolvedSeed ?? result.artwork.resolvedSeed ?? null;
    output.resolvedSeedSource = result.resolvedSeedSource ?? result.artwork.resolvedSeedSource ?? null;
  }
  output.status = result.status;
  if (result.status === "failed") output.errorCode = result.errorCode === "attachment_unavailable" ? "attachment_unavailable" : "provider_error";
  else if (result.status === "cancelled") output.errorCode = "cancelled";
  else if (result.errorCode) output.errorCode = result.errorCode;
  if (result.errorMessage) output.errorMessage = result.errorMessage.slice(0, 2_000);
  if (result.providerReceipt) output.providerReceipt = copy(result.providerReceipt);
  output.updatedAt = now();
  appendEvent(execution, "provider_output_item", {
    status: result.status,
    ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    ...(result.providerReceipt ? { providerReceipt: copy(result.providerReceipt) } : {}),
  }, result.outputIndex);
}

function aggregate(execution: R4Execution) {
  ensureOutputSlots(execution);
  const outputs = execution.outputs;
  if (outputs.some((item) => item.status === "unknown")) execution.status = "unknown";
  else if (outputs.some((item) => item.status === "pending")) execution.status = execution.cancelRequestedAt ? "cancel_requested" : "running";
  else if (outputs.every((item) => item.status === "completed")) execution.status = "completed";
  else if (outputs.every((item) => item.status === "not_dispatched")) execution.status = "blocked";
  else if (outputs.some((item) => item.status === "completed")) execution.status = "partial";
  else if (outputs.every((item) => item.status === "cancelled" || item.status === "not_dispatched")) execution.status = "cancelled";
  else {
    execution.status = "error";
  }
  execution.updatedAt = now();
  const semantics = validateR4ExecutionSemantics(execution);
  if (!semantics.valid) throw new Error(`拒绝写入矛盾的执行聚合状态：${semantics.issues.map((item) => item.message).join(" ")}`);
}

function setAllNotDispatched(execution: R4Execution) {
  for (const output of execution.outputs) {
    output.status = "not_dispatched";
    delete output.providerReceipt;
    output.updatedAt = now();
  }
}

function confirmNotSentCancelled(execution: R4Execution) {
  setAllNotDispatched(execution);
  const first = execution.outputs[0];
  if (first) {
    first.status = "cancelled";
    first.errorCode = "cancelled";
    first.updatedAt = now();
  }
}

/**
 * Durable serial image worker. It never retries an ambiguous request: every
 * native request boundary is committed before the provider may issue its POST.
 */
export class R4ExecutionWorker {
  private pumping?: Promise<void>;
  private readonly controllers = new Map<string, AbortController>();
  /** Recovered per-output dispatches continue only after an explicit resume. */
  private readonly manualContinuations = new Set<string>();

  constructor(
    readonly store: AgentSqlStore,
    readonly provider: R4ExecutionProvider,
    readonly options: R4ExecutionWorkerOptions = {},
  ) {}

  /** True while a dispatch is running or a pump is queued to finish its work. */
  hasActiveRequests() {
    return Boolean(this.pumping) || this.controllers.size > 0;
  }

  private changed(executionId: string) {
    const execution = this.store.readR4State().executions[executionId];
    if (execution) this.options.onChanged?.(execution.conversationId, executionId);
  }

  private mutate<T>(
    executionId: string,
    callback: (state: R4AgentState, execution: R4Execution) => T,
    registerArtifacts = true,
  ): T {
    return this.store.transaction((tx) => {
      const state = tx.getR4State();
      const execution = state.executions[executionId];
      if (!execution) throw new Error(`找不到 execution ${executionId}。`);
      const result = callback(state, execution);
      if (registerArtifacts) this.options.onTransaction?.(tx, state, execution);
      tx.setR4State(state);
      return result;
    });
  }

  /** Startup recovery is conservative: queued work pauses; in-flight work is never replayed. */
  recover() {
    const recovered: string[] = [];
    const registrationChanged: string[] = [];
    this.store.transaction((tx) => {
      const state = tx.getR4State();
      let changed = false;
      for (const execution of Object.values(state.executions)) {
        if (execution.status === "queued") {
          if (execution.pauseReason !== "user_pause") {
            execution.pauseReason = "user_pause";
            appendEvent(execution, "recovered_paused", { reason: "restart_requires_user_resume" });
            recovered.push(execution.id);
            changed = true;
          }
          continue;
        }
        if (!ACTIVE_STATUSES.has(execution.status)) continue;
        const hasBoundary = boundaries(execution).length > 0;
        const safelyResumablePartial = execution.status === "dispatching"
          && execution.requestGranularity === "per_output"
          && hasBoundary
          && execution.providerReceiptStatus === "confirmed"
          && !hasUnreceiptedBoundary(execution)
          && execution.outputs.some((output) => output.status === "completed")
          && execution.outputs.some((output) => output.status === "not_dispatched")
          && execution.outputs.every((output) => output.status === "completed" || output.status === "not_dispatched");
        if (safelyResumablePartial) {
          if (execution.cancelRequestedAt || execution.status === "cancel_requested") {
            execution.status = "partial";
            execution.blockedReason = undefined;
            appendEvent(execution, "recovered_cancelled_between_outputs", { reason: "cancelled_before_next_output" });
          } else {
            // dispatching with prior completed slots is the only valid
            // aggregate for a partially submitted per-output execution.
            // Do not schedule it automatically; resume() continues it explicitly.
            appendEvent(execution, "recovered_paused", { reason: "resume_remaining_per_output_slots_explicitly" });
          }
          recovered.push(execution.id);
          changed = true;
          continue;
        }
        if (!hasBoundary) {
          if (execution.cancelRequestedAt || execution.status === "cancel_requested") {
            execution.status = "cancelled";
            execution.providerCancellation = "not_sent";
            execution.providerReceiptStatus = "not_applicable";
            confirmNotSentCancelled(execution);
            appendEvent(execution, "cancel_confirmed_not_sent", { source: "restart_recovery" });
          } else {
            execution.status = "queued";
            execution.pauseReason = "user_pause";
            appendEvent(execution, "recovered_paused", { reason: "claim_without_provider_boundary" });
          }
        } else {
          // Even a recorded response may precede async completion. Query may
          // resolve it later; resubmitting this attempt is never safe.
          const affected = boundaryOutputs(execution);
          for (const output of execution.outputs) {
            if (affected.has(output.outputIndex) && output.status === "pending") output.status = "unknown";
          }
          for (const boundary of boundaries(execution)) {
            const detail = eventDetail(boundary);
            const sequence = Number(detail.sequence);
            const latest = latestReceipt(execution, sequence);
            if (!latest || eventDetail(latest).status === "pending") {
              appendEvent(execution, "native_request_receipt", {
                kind: detail.kind,
                sequence,
                status: "unknown",
                message: "进程重启后无法确认原 provider 请求结果；不会重发。",
              });
            }
          }
          const last = boundaries(execution).at(-1);
          const lastReceipt = last ? latestReceipt(execution, Number(eventDetail(last).sequence)) : undefined;
          const lastStatus = lastReceipt ? eventDetail(lastReceipt).status : undefined;
          execution.providerReceiptStatus = lastStatus === "confirmed" || lastStatus === "failed" ? "confirmed" : "unknown";
          if (execution.outputs.some((output) => output.status === "unknown")) {
            execution.status = "unknown";
            execution.blockedReason = "unknown_prior_receipt";
            addGate(state, execution, "unknown_prior_receipt");
          } else if (execution.outputs.some((output) => output.status === "failed")) {
            execution.blockedReason = undefined;
            aggregate(execution);
            addGate(state, execution, "prior_paid_failure");
          } else {
            execution.providerReceiptStatus = "unknown";
            execution.status = "unknown";
            execution.blockedReason = "unknown_prior_receipt";
            addGate(state, execution, "unknown_prior_receipt");
          }
          appendEvent(execution, "recovered_unknown", { reason: "provider_boundary_before_restart", hadUnreceiptedBoundary: hasUnreceiptedBoundary(execution) });
        }
        recovered.push(execution.id);
        changed = true;
      }
      if (changed) tx.setR4State(state);
    });

    // Keep each paid result's local registration in its own transaction. A
    // missing or damaged file should leave that result repairable without
    // preventing unrelated conversations and executions from recovering.
    if (this.options.onTransaction) {
      const executionIds = Object.keys(this.store.readR4State().executions);
      for (const executionId of executionIds) {
        let executionRegistrationChanged = false;
        try {
          this.store.transaction((tx) => {
            const state = tx.getR4State();
            const execution = state.executions[executionId];
            if (!execution) return;
            const completedArtworks = execution.outputs
              .filter((output) => output.status === "completed" && output.artwork)
              .map((output) => output.artwork!);
            if (!completedArtworks.length) return;
            const chat = tx.getWorkspace().conversations.find((item) => item.id === execution.conversationId);
            const creation = state.creations[execution.creationId];
            const missingArtifact = completedArtworks.some((artwork) => {
              const registered = state.artworks[artwork.id];
              return !registered || registered.hash !== artwork.hash || registered.attachmentId !== artwork.attachmentId
                || !creation?.artworkIds.includes(artwork.id);
            });
            const resultMessage=chat?.messages.find(message=>message.id===`execution:${execution.id}`);
            const missingResultMessage = Boolean(chat && (!resultMessage||completedArtworks.some(artwork=>!resultMessage.attachments.some(attachment=>attachment.id===artwork.attachmentId&&(!attachment.sha256||attachment.sha256===artwork.hash)))));
            const missingCritique = TERMINAL_STATUSES.has(execution.status) && !state.critiqueQueue[`critique:${execution.id}`];
            if (missingArtifact || missingResultMessage || missingCritique) {
              this.options.onTransaction!(tx, state, execution);
              appendEvent(execution, "artwork_registration_recovered", {
                artifactIds: completedArtworks.map((artwork) => artwork.id),
              });
              executionRegistrationChanged = true;
            }
            const repairedChat = tx.getWorkspace().conversations.find((item) => item.id === execution.conversationId);
            const artifactsRegistered = completedArtworks.every((artwork) => {
              const registered = state.artworks[artwork.id];
              return Boolean(registered && registered.hash === artwork.hash && registered.attachmentId === artwork.attachmentId
                && state.creations[execution.creationId]?.artworkIds.includes(artwork.id));
            });
            const message = repairedChat?.messages.find((item) => item.id === `execution:${execution.id}`);
            const messageRegistered = Boolean(message && completedArtworks.every((artwork) =>
              message.attachments?.some((attachment) => attachment.id === artwork.attachmentId && (!attachment.sha256||attachment.sha256===artwork.hash))));
            const critiqueRegistered = !TERMINAL_STATUSES.has(execution.status) || Boolean(state.critiqueQueue[`critique:${execution.id}`]);
            const released = artifactsRegistered && messageRegistered && critiqueRegistered && releaseRegistrationGate(state, execution);
            if (released) executionRegistrationChanged = true;
            if (executionRegistrationChanged) tx.setR4State(state);
          });
          if (executionRegistrationChanged) registrationChanged.push(executionId);
        } catch (error) {
          const reason = registrationRecoveryFailure(error);
          if (!reason) throw error;
          this.store.transaction((tx) => {
            const state = tx.getR4State();
            const execution = state.executions[executionId];
            if (!execution) return;
            addRegistrationGate(state, execution);
            const lastFailure = execution.events.at(-1);
            if (lastFailure?.kind !== "artwork_registration_recovery_failed" || lastFailure.detail?.reason !== reason) {
              appendEvent(execution, "artwork_registration_recovery_failed", { reason });
            }
            tx.setR4State(state);
          });
          registrationChanged.push(executionId);
        }
      }
    }
    for (const id of new Set([...recovered, ...registrationChanged])) this.changed(id);
    return recovered;
  }

  /** User-initiated queue continuation. Unknown attempts cannot be replayed. */
  resume(executionIds: string[]) {
    const resumed: string[] = [];
    const partialContinuations: string[] = [];
    this.store.transaction((tx) => {
      const state = tx.getR4State();
      for (const id of [...new Set(executionIds)]) {
        const execution = state.executions[id];
        if (!execution) continue;
        const resumableQueued = execution.status === "queued";
        const resumablePartial = execution.status === "dispatching"
          && execution.requestGranularity === "per_output"
          && execution.providerReceiptStatus === "confirmed"
          && execution.outputs.some((output) => output.status === "completed")
          && execution.outputs.some((output) => output.status === "not_dispatched")
          && execution.outputs.every((output) => output.status === "completed" || output.status === "not_dispatched");
        if (!resumableQueued && !resumablePartial) continue;
        const activeGates = Object.values(state.gates).filter((gate) => gate.active);
        const batchId = String(execution.approvedInput.publicParameters.batchId ?? "");
        const related = activeGates.some((gate) => gate.executionId === execution.id
          || Boolean(gate.turnId && gate.turnId === String(execution.approvedInput.publicParameters.turnLineageRef??execution.userIntentRef))
          || Boolean(gate.batchId && batchId && gate.batchId === batchId));
        if (related) continue;
        const releasableUnknownGates = activeGates.filter((gate) => gate.reason === "unknown_prior_receipt");
        if (releasableUnknownGates.length) {
          execution.releasedGateIds = [...new Set([...(execution.releasedGateIds ?? []), ...releasableUnknownGates.map((gate) => gate.id)])];
          appendEvent(execution, "user_released_independent_execution", {
            releasedGateIds: releasableUnknownGates.map((gate) => gate.id),
            sourceExecutionIds: releasableUnknownGates.map((gate) => gate.sourceExecutionId).filter(Boolean),
          });
        }
        if (hasActiveGate(state, execution)) continue;
        execution.pauseReason = "none";
        appendEvent(execution, "user_resumed", { source: "explicit_resume", releasedGateIds: execution.releasedGateIds ?? [] });
        resumed.push(id);
        if (resumablePartial) partialContinuations.push(id);
      }
      if (resumed.length) tx.setR4State(state);
    });
    for (const id of partialContinuations) this.manualContinuations.add(id);
    for (const id of resumed) this.changed(id);
    void this.kick();
    return resumed;
  }

  /** Local queued cancellation is a CAS and can never call the provider. */
  async cancel(executionId: string) {
    const action = this.mutate(executionId, (state, execution) => {
      if (TERMINAL_STATUSES.has(execution.status)) return { kind: "terminal" as const, execution: copy(execution) };
      execution.cancelRequestedAt ??= now();
      appendEvent(execution, "cancel_intent", { source: "user" });
      if (execution.status === "queued") {
        execution.status = "cancelled";
        execution.providerCancellation = "not_sent";
        execution.providerReceiptStatus = "not_applicable";
        confirmNotSentCancelled(execution);
        appendEvent(execution, "cancel_confirmed_not_sent", { source: "queued_local_cancel" });
        return { kind: "cancelled" as const, execution: copy(execution) };
      }
      if (execution.status === "dispatching"
        && !execution.outputs.some((output) => output.status === "pending")
        && execution.outputs.some((output) => output.status === "completed")
        && execution.outputs.some((output) => output.status === "not_dispatched")) {
        execution.status = "partial";
        execution.providerCancellation = "not_sent";
        execution.blockedReason = undefined;
        appendEvent(execution, "cancel_stopped_before_next_boundary", { source: "user_cancel_between_outputs" });
        return { kind: "cancelled" as const, execution: copy(execution) };
      }
      if (!boundaries(execution).length && execution.status === "dispatching") {
        appendEvent(execution, "cancel_waiting_for_send_boundary", { dispatchClaimId: execution.dispatchClaimId ?? null });
      } else if (execution.status !== "unknown") {
        execution.status = "cancel_requested";
      }
      return { kind: "in_flight" as const, execution: copy(execution) };
    });
    const crossedBoundary = boundaries(action.execution).length > 0;
    if (action.kind === "in_flight" && !crossedBoundary) {
      this.controllers.get(executionId)?.abort(new Error("用户请求取消。"));
    }
    this.changed(executionId);
    if (action.kind === "in_flight" && crossedBoundary && this.provider.cancel) {
      await this.requestProviderCancellation(executionId, action.execution);
    } else if (action.kind === "in_flight" && crossedBoundary && !this.provider.cancel) {
      this.mutate(executionId, (_state, current) => {
        current.providerCancellation = "unsupported";
        appendEvent(current, "provider_cancel_receipt", { disposition: "unsupported", message: "当前 Provider 不支持远端取消；继续接收原请求结果。" });
      });
      this.changed(executionId);
    }
    return this.store.readR4State().executions[executionId];
  }

  private async requestProviderCancellation(executionId: string, execution: R4Execution) {
    try {
      const result = await this.provider.cancel!(copy(execution));
      this.mutate(executionId, (state, current) => {
        current.providerCancellation = result.disposition;
        appendEvent(current, "provider_cancel_receipt", { disposition: result.disposition, message: result.message ?? null });
        if (result.disposition === "confirmed") {
          appendLatestNativeOutcome(current, "confirmed", result.message ?? "Provider 确认取消原任务。");
          current.providerReceiptStatus = boundaries(current).length ? "confirmed" : "not_applicable";
          for (const output of current.outputs) {
            if (output.status === "pending" || output.status === "unknown") {
              output.status = "cancelled";
              output.errorCode = "cancelled";
              output.updatedAt = now();
            }
          }
          if (current.outputs.every((output) => output.status === "cancelled" || output.status === "not_dispatched")) {
            current.status = "cancelled";
            current.blockedReason = undefined;
          } else aggregate(current);
        } else if (result.disposition === "unknown") {
          // Cancellation outcome is separate from the original generation
          // receipt. Keep its pending slot alive so a late success is saved.
          appendEvent(current, "provider_cancel_unknown", { message: result.message ?? null });
        }
      });
      this.changed(executionId);
    } catch (error) {
      this.options.onError?.(error, executionId);
      this.mutate(executionId, (_state, current) => {
        current.providerCancellation = "unknown";
        appendEvent(current, "provider_cancel_unknown", { error: error instanceof Error ? error.message : String(error) });
      });
      this.changed(executionId);
    }
  }

  /** Verification only queries the original attempt; it never submits again. */
  async verify(executionId: string) {
    const execution = this.store.readR4State().executions[executionId];
    if (!execution) throw new Error(`找不到 execution ${executionId}。`);
    if (!this.provider.verify) throw new Error("当前图片服务不支持核实原任务；不会重发请求。");
    if (!["unknown", "running", "cancel_requested"].includes(execution.status)) {
      throw new Error("只有结果待核实或仍在服务端运行的 execution 可以核实。");
    }
    const result = await this.provider.verify(copy(execution));
    this.mutate(executionId, (state, current) => {
      current.providerReceiptStatus = result.providerReceiptStatus;
      current.providerServiceTaskId = result.providerServiceTaskId ?? current.providerServiceTaskId;
      if (result.providerCancellation) current.providerCancellation = result.providerCancellation;
      for (const item of result.outputs ?? []) markOutput(current, item);
      if (result.requestDisposition === "not_sent") {
        const lastBoundary = boundaries(current).at(-1);
        if (lastBoundary) {
          const detail = eventDetail(lastBoundary);
          const sequence = Number(detail.sequence);
          const receipt = latestReceipt(current, sequence);
          if (!receipt || ["pending", "unknown"].includes(String(eventDetail(receipt).status))) {
            appendEvent(current, "native_request_receipt", {
              kind: detail.kind,
              sequence,
              status: "failed",
              message: "Provider 核实原执行没有生成结果。",
            });
          }
          const targets = Array.isArray(detail.outputIndexes)
            ? detail.outputIndexes.filter((index): index is number => Number.isSafeInteger(index))
            : Number.isSafeInteger(detail.outputIndex) ? [Number(detail.outputIndex)] : [];
          for (const output of current.outputs) {
            if (!targets.includes(output.outputIndex) || !["unknown", "pending", "not_dispatched"].includes(output.status)) continue;
            output.status = "failed";
            output.errorCode = "provider_error";
            output.errorMessage = "Provider 核实原执行没有生成结果。";
            output.updatedAt = now();
          }
          current.providerReceiptStatus = "confirmed";
          current.pauseReason = undefined;
          current.blockedReason = undefined;
          const failed = current.outputs.some((output) => output.status === "failed");
          if (failed) {
            current.status = current.outputs.some((output) => output.status === "completed") ? "partial" : "error";
            addGate(state, current, "prior_paid_failure");
          } else if (current.outputs.every((output) => output.status === "completed")) {
            current.status = "completed";
          } else if (current.outputs.some((output) => output.status === "completed")) {
            current.status = "partial";
          } else {
            current.status = "unknown";
            current.providerReceiptStatus = "unknown";
            current.blockedReason = "unknown_prior_receipt";
            addGate(state, current, "unknown_prior_receipt");
          }
        } else {
          // No request boundary is evidence that no provider POST was attempted.
          for (const output of current.outputs) if (output.status === "unknown" || output.status === "pending") {
            output.status = "not_dispatched";
            delete output.providerReceipt;
            output.updatedAt = now();
          }
          current.providerReceiptStatus = "not_applicable";
          current.status = "queued";
          current.pauseReason = "user_pause";
          current.blockedReason = undefined;
        }
      } else if (result.requestDisposition === "unknown") {
        for (const output of current.outputs) if (output.status === "pending") output.status = "unknown";
        current.status = "unknown";
        current.providerReceiptStatus = "unknown";
        current.blockedReason = "unknown_prior_receipt";
      } else {
        aggregate(current);
        if (current.status === "unknown") current.blockedReason = "unknown_prior_receipt";
        else current.blockedReason = undefined;
      }
      appendEvent(current, "provider_verify_receipt", { requestDisposition: result.requestDisposition, providerReceiptStatus: result.providerReceiptStatus });
      if (current.status === "unknown") addGate(state, current, "unknown_prior_receipt");
      else if (result.requestDisposition === "not_sent") {
        for (const gate of Object.values(state.gates)) if (gate.active && gate.executionId === executionId) {
          gate.active = false;
          gate.releasedAt = now();
          gate.releasedBy = "provider_verified_not_sent";
        }
      }
    });
    this.changed(executionId);
    return this.store.readR4State().executions[executionId];
  }

  /** Schedule eligible work serially. Running this repeatedly is idempotent. */
  kick() {
    if (this.pumping) return this.pumping;
    this.pumping = this.pump().finally(() => { this.pumping = undefined; });
    return this.pumping;
  }

  private claimNext(): R4Execution | undefined {
    return this.store.transaction((tx) => {
      const state = tx.getR4State();
      const candidates = Object.values(state.executions)
        .filter((execution) => execution.status === "queued" && (!execution.pauseReason || execution.pauseReason === "none"))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      const execution = candidates.find((item) => !hasActiveGate(state, item));
      if (!execution) return undefined;
      ensureOutputSlots(execution);
      if (execution.outputs.some((output) => output.status !== "not_dispatched")) throw new Error("只有全部未派发的 execution 可以 claim。" );
      execution.status = "dispatching";
      execution.dispatchClaimId = randomUUID();
      appendEvent(execution, "queue_claim", { dispatchClaimId: execution.dispatchClaimId });
      tx.setR4State(state);
      return copy(execution);
    });
  }

  private async pump() {
    while (true) {
      const manualId = this.manualContinuations.values().next().value as string | undefined;
      if (manualId) {
        this.manualContinuations.delete(manualId);
        const state = this.store.readR4State();
        const continued = state.executions[manualId];
        if (continued?.status === "dispatching" && continued.pauseReason === "none" && !hasActiveGate(state, continued)) {
          this.changed(continued.id);
          try { await this.dispatch(copy(continued)); }
          catch (error) { this.options.onError?.(error, continued.id); }
          continue;
        }
      }
      const execution = this.claimNext();
      if (!execution) return;
      this.changed(execution.id);
      try { await this.dispatch(execution); }
      catch (error) { this.options.onError?.(error, execution.id); }
    }
  }

  private async dispatch(claimed: R4Execution) {
    const controller = new AbortController();
    this.controllers.set(claimed.id, controller);
    let callBoundaryStart = boundaries(claimed).length;
    let registrationDeferred = false;
    const beforeSubmit = async (kind: R4NativeRequestKind = "image", requestedOutputIndex: number | null = null) => {
      controller.signal.throwIfAborted();
      this.mutate(claimed.id, (state, execution) => {
        if (execution.dispatchClaimId !== claimed.dispatchClaimId) throw new Error("Execution dispatch claim 已被替换，拒绝提交。");
        if (execution.cancelRequestedAt || execution.status === "cancel_requested" || execution.status === "cancelled") {
          throw new Error("用户已取消，提交边界已停止。");
        }
        if (TERMINAL_STATUSES.has(execution.status) || execution.status === "unknown") throw new Error("Execution 已进入不可派发状态。");
        const gate = hasActiveGate(state, execution);
        if (gate) throw new Error(`当前有活动门禁 ${gate.id}，拒绝新的 provider 请求。`);
        const currentBudget = requestBudget(execution);
        const count = boundaries(execution).filter((event) => eventDetail(event).kind === kind).length;
        if (count >= currentBudget[kind]) throw new Error(`native ${kind} 请求次数超出批准快照预算。`);
        const sequence = boundaries(execution).length + 1;
        const outputIndexes = execution.requestGranularity === "batch"
          ? execution.outputs.filter((item) => item.status !== "completed" && item.status !== "failed" && item.status !== "cancelled").map((item) => item.outputIndex)
          : [requestedOutputIndex ?? -1];
        if (outputIndexes.length === 0 || outputIndexes.some((index) => index < 0)) throw new Error("没有对应的批准输出槽位。");
        for (const index of outputIndexes) {
          const output = execution.outputs.find((item) => item.outputIndex === index);
          if (!output || ["completed", "failed", "cancelled", "unknown"].includes(output.status)) throw new Error(`输出槽位 ${index} 已改变，拒绝提交。`);
          const priorImageBoundary = boundaries(execution).some((event) => {
            const detail = eventDetail(event);
            return detail.kind === "image" && (Number(detail.outputIndex) === index || (Array.isArray(detail.outputIndexes) && detail.outputIndexes.includes(index)));
          });
          if (kind === "image" && priorImageBoundary) throw new Error(`输出槽位 ${index} 已越过 image 提交边界，拒绝重发。`);
          if (output.status === "pending") {
            const pendingReceipt = boundaries(execution).some((event) => {
              const detail = eventDetail(event);
              if (Number(detail.outputIndex) !== index && !(Array.isArray(detail.outputIndexes) && detail.outputIndexes.includes(index))) return false;
              const receipt = latestReceipt(execution, Number(detail.sequence));
              return !receipt || eventDetail(receipt).status === "pending";
            });
            if (pendingReceipt) throw new Error(`输出槽位 ${index} 有未核实的 provider 回执，拒绝后续请求。`);
          }
          output.status = "pending";
          output.updatedAt = now();
        }
        execution.providerReceiptStatus = "pending";
        execution.status = execution.cancelRequestedAt ? "cancel_requested" : "running";
        appendEvent(execution, "native_request_boundary", {
          kind,
          sequence,
          ...(execution.requestGranularity === "per_output" ? { outputIndex: outputIndexes[0] } : { outputIndexes }),
          dispatchClaimId: claimed.dispatchClaimId,
        });
        appendEvent(execution, "native_request_receipt", { kind, sequence, status: "pending" });
        return sequence;
      });
      this.changed(claimed.id);
    };

    const afterReceipt = async (kind: R4NativeRequestKind, receipt: R4NativeRequestReceipt) => {
      this.mutate(claimed.id, (_state, execution) => {
        const outstanding = [...boundaries(execution)].reverse().find((event) => {
          const detail = eventDetail(event);
          if (detail.kind !== kind) return false;
          const sequence = Number(detail.sequence);
          return latestReceipt(execution, sequence) === undefined || eventDetail(latestReceipt(execution, sequence)!).status === "pending";
        });
        if (!outstanding) throw new Error(`native ${kind} receipt 没有对应的持久提交边界。`);
        const detail = eventDetail(outstanding);
        const sequence = Number(detail.sequence);
        const targetIndexes = Array.isArray(detail.outputIndexes)
          ? detail.outputIndexes.filter((item): item is number => Number.isSafeInteger(item))
          : Number.isSafeInteger(detail.outputIndex) ? [Number(detail.outputIndex)] : [];
        appendEvent(execution, "native_request_receipt", {
          kind,
          sequence,
          status: receipt.status,
          ...(receipt.requestId ? { requestId: receipt.requestId } : {}),
          ...(receipt.serviceTaskId ? { serviceTaskId: receipt.serviceTaskId } : {}),
          ...(receipt.rawStatus ? { rawStatus: receipt.rawStatus.slice(0, 160) } : {}),
          ...(receipt.message ? { message: receipt.message.slice(0, 2_000) } : {}),
        });
        if (receipt.serviceTaskId) execution.providerServiceTaskId = receipt.serviceTaskId;
        execution.providerReceiptStatus = receipt.status === "failed" ? "confirmed" : receipt.status;
        for (const output of execution.outputs) {
          if (!targetIndexes.includes(output.outputIndex) || output.status !== "pending") continue;
          if (receipt.status === "unknown") {
            output.status = "unknown";
            output.updatedAt = now();
          } else if (receipt.status === "failed") {
            output.status = "failed";
            output.errorCode = "provider_error";
            output.errorMessage = receipt.message?.slice(0, 2_000) ?? "Provider 请求失败。";
            output.updatedAt = now();
          }
          if (receipt.requestId || receipt.serviceTaskId || receipt.message || receipt.rawStatus) {
            output.providerReceipt = {
              status: receipt.status === "failed" ? "confirmed" : receipt.status,
              ...(receipt.requestId ? { requestId: receipt.requestId } : {}),
              ...(receipt.serviceTaskId ? { serviceTaskId: receipt.serviceTaskId } : {}),
              receivedAt: now(),
              ...(receipt.rawStatus ? { rawStatus: receipt.rawStatus } : {}),
              ...(receipt.message ? { message: receipt.message } : {}),
            };
          }
        }
        if (receipt.status === "failed") {
          addGate(_state, execution, "prior_paid_failure");
          const pending = execution.outputs.some((output) => output.status === "pending");
          if (pending) {
            execution.status = execution.cancelRequestedAt ? "cancel_requested" : "running";
            execution.blockedReason = "prior_paid_failure";
          } else {
            execution.status = execution.outputs.some((output) => output.status === "completed") ? "partial" : "error";
            execution.blockedReason = undefined;
          }
        } else if (receipt.status === "unknown") {
          execution.blockedReason = "unknown_prior_receipt";
          execution.status = "unknown";
          addGate(_state, execution, "unknown_prior_receipt");
        } else {
          const pending = execution.outputs.some((output) => output.status === "pending");
          if (pending) execution.status = execution.cancelRequestedAt ? "cancel_requested" : "running";
        }
      });
      this.changed(claimed.id);
    };

    try {
      if (claimed.requestGranularity === "batch") {
        registrationDeferred = !(await this.invokeProvider(claimed, null, controller, beforeSubmit, afterReceipt, callBoundaryStart));
      } else {
        for (const slot of claimed.outputs) {
          const current = this.store.readR4State().executions[claimed.id];
          if (!current || current.status === "unknown" || current.status === "blocked" || current.status === "error" || current.cancelRequestedAt) break;
          if (current.outputs.find((item) => item.outputIndex === slot.outputIndex)?.status !== "not_dispatched") continue;
          callBoundaryStart = boundaries(current).length;
          const registered = await this.invokeProvider(claimed, slot.outputIndex, controller, beforeSubmit, afterReceipt, callBoundaryStart);
          if (!registered) {
            registrationDeferred = true;
            break;
          }
          const updated = this.store.readR4State().executions[claimed.id];
          if (!updated || updated.outputs.find((item) => item.outputIndex === slot.outputIndex)?.status !== "completed") break;
        }
      }
      if (!registrationDeferred) this.finishDispatch(claimed.id);
    } catch (error) {
      this.handleDispatchError(claimed.id, callBoundaryStart, error);
      this.options.onError?.(error, claimed.id);
    } finally {
      this.controllers.delete(claimed.id);
      this.changed(claimed.id);
    }
  }

  private async invokeProvider(
    execution: R4Execution,
    outputIndex: number | null,
    controller: AbortController,
    beforeSubmit: (kind?: R4NativeRequestKind, requestedOutputIndex?: number | null) => Promise<void>,
    afterReceipt: (kind: R4NativeRequestKind, receipt: R4NativeRequestReceipt) => Promise<void>,
    callBoundaryStart: number,
  ): Promise<boolean> {
    const latest = this.store.readR4State().executions[execution.id];
    if (!latest || latest.status === "unknown" || latest.status === "blocked" || latest.cancelRequestedAt) return true;
    const callBeforeSubmit = (kind: R4NativeRequestKind = "image") => beforeSubmit(kind, outputIndex);
    const result = await this.provider.submit(copy(latest), outputIndex, { signal: controller.signal, beforeSubmit: callBeforeSubmit, afterReceipt });
    return this.applyProviderResult(execution.id, outputIndex, result, callBoundaryStart);
  }

  private applyProviderResult(executionId: string, requestedIndex: number | null, result: R4ProviderSubmitResult, callBoundaryStart: number) {
    const apply = (state: R4AgentState, execution: R4Execution) => {
      const allBoundaries = boundaries(execution);
      const imageBoundaries = allBoundaries.filter((event) => eventDetail(event).kind === "image" && Number(eventDetail(event).sequence) > callBoundaryStart);
      const crossed = imageBoundaries.length > 0;
      let requestDisposition = result.requestDisposition;
      if (requestDisposition === "sent" && allBoundaries.every((event) => Number(eventDetail(event).sequence) <= callBoundaryStart)) {
        // Provider claimed a send without crossing the host-owned durable gate.
        requestDisposition = "unknown";
      }
      if (requestDisposition === "not_sent" && crossed) {
        // A durable pre-POST boundary means the send may have raced the error.
        requestDisposition = "unknown";
      }
      execution.providerReceiptStatus = result.providerReceiptStatus
        ?? (requestDisposition === "sent" ? "confirmed" : requestDisposition === "unknown" ? "unknown" : execution.providerReceiptStatus);
      if (result.providerServiceTaskId) execution.providerServiceTaskId = result.providerServiceTaskId;
      if (result.providerCancellation) execution.providerCancellation = result.providerCancellation;

      const seen = new Set<number>();
      for (const output of result.outputs) {
        if (seen.has(output.outputIndex)) throw new Error(`Provider 重复返回 outputIndex ${output.outputIndex}。`);
        seen.add(output.outputIndex);
        if (requestedIndex !== null && output.outputIndex !== requestedIndex) throw new Error("逐图 provider 返回了错误的 outputIndex。");
        if (requestedIndex === null && execution.requestGranularity !== "batch") throw new Error("逐图 execution 收到了 batch 输出。");
        if (requestedIndex === null && !execution.outputs.some((item) => item.outputIndex === output.outputIndex)) throw new Error("Batch provider 返回了未预分配的 outputIndex。");
        markOutput(execution, output);
      }

      if (requestDisposition === "unknown") {
        const affected = boundaryOutputs(execution, callBoundaryStart);
        if (!affected.size) {
          if (requestedIndex !== null) affected.add(requestedIndex);
          else for (const output of execution.outputs) affected.add(output.outputIndex);
        }
        for (const output of execution.outputs) {
          if (affected.has(output.outputIndex) && (output.status === "pending" || output.status === "not_dispatched")) {
            output.status = "unknown";
            output.updatedAt = now();
          }
        }
        execution.providerReceiptStatus = "unknown";
        execution.status = "unknown";
        execution.blockedReason = "unknown_prior_receipt";
        addGate(state, execution, "unknown_prior_receipt");
      } else if (requestDisposition === "not_sent" && !result.outputs.length) {
        if (execution.outputs.some((item) => item.status === "completed")) {
          execution.status = "partial";
          execution.blockedReason = undefined;
        } else {
          execution.status = "blocked";
          execution.providerReceiptStatus = "not_applicable";
          execution.blockedReason = "provider_changed";
        }
        appendEvent(execution, "provider_not_sent", { outputIndex: requestedIndex, message: "Provider 明确确认未越过提交边界。" });
      } else {
        if (requestDisposition === "sent" && result.providerReceiptStatus === "unknown") {
          execution.status = "unknown";
          execution.blockedReason = "unknown_prior_receipt";
          addGate(state, execution, "unknown_prior_receipt");
        } else {
          const failed = execution.outputs.some((item) => item.status === "failed");
          const unknown = execution.outputs.some((item) => item.status === "unknown");
          if (unknown) {
            execution.status = "unknown";
            execution.blockedReason = "unknown_prior_receipt";
            addGate(state, execution, "unknown_prior_receipt");
          } else if (failed) {
            const pending = execution.outputs.some((item) => item.status === "pending");
            if (pending) {
              execution.status = execution.cancelRequestedAt ? "cancel_requested" : "running";
              execution.blockedReason = "prior_paid_failure";
            } else {
              execution.status = execution.outputs.some((item) => item.status === "completed") ? "partial" : "error";
              execution.blockedReason = undefined;
            }
            addGate(state, execution, "prior_paid_failure");
          } else if (execution.outputs.some((item) => item.status === "pending")) {
            execution.status = execution.cancelRequestedAt ? "cancel_requested" : "running";
          } else if (execution.requestGranularity === "per_output"
            && execution.outputs.some((item) => item.status === "completed")
            && execution.outputs.some((item) => item.status === "not_dispatched")) {
            if (execution.cancelRequestedAt) {
              execution.status = "partial";
              execution.blockedReason = undefined;
            } else {
              execution.status = "dispatching";
              execution.providerReceiptStatus = "confirmed";
              execution.blockedReason = undefined;
            }
          } else {
            aggregate(execution);
            execution.blockedReason = undefined;
          }
        }
      }
      appendEvent(execution, "provider_submit_result", {
        requestDisposition,
        outputIndexes: result.outputs.map((item) => item.outputIndex),
        providerReceiptStatus: execution.providerReceiptStatus,
      });
      const semantics = validateR4ExecutionSemantics(execution);
      if (!semantics.valid) throw new Error(`Provider 结果与 execution 聚合状态矛盾：${semantics.issues.map((item) => item.message).join(" ")}`);
    };
    try {
      this.mutate(executionId, apply);
      this.changed(executionId);
      return true;
    } catch (error) {
      // The provider result is already real. If atomic workspace/artifact
      // registration failed, retain its request and output evidence in the
      // execution row, stop this dispatch, and let startup recovery retry the
      // registration without repeating the paid request.
      try {
        this.mutate(executionId, (state, execution) => {
          apply(state, execution);
          addRegistrationGate(state, execution);
          appendEvent(execution, "artwork_registration_deferred", { reason: "atomic_registration_failed" });
        }, false);
      } catch {
        throw error;
      }
      this.options.onError?.(error, executionId);
      this.changed(executionId);
      return false;
    }
  }

  private finishDispatch(executionId: string) {
    this.mutate(executionId, (state, execution) => {
      const failed = execution.outputs.some((item) => item.status === "failed");
      const unknown = execution.outputs.some((item) => item.status === "unknown");
      const pending = execution.outputs.some((item) => item.status === "pending");
      if (execution.cancelRequestedAt && !boundaries(execution).length) {
        execution.status = "cancelled";
        execution.providerCancellation = "not_sent";
        execution.providerReceiptStatus = "not_applicable";
        confirmNotSentCancelled(execution);
        appendEvent(execution, "cancel_confirmed_not_sent", { source: "worker_stopped_before_boundary" });
      } else if (unknown || hasUnreceiptedBoundary(execution)) {
        for (const output of execution.outputs) if (output.status === "pending") output.status = "unknown";
        execution.providerReceiptStatus = "unknown";
        execution.status = "unknown";
        execution.blockedReason = "unknown_prior_receipt";
        addGate(state, execution, "unknown_prior_receipt");
      } else if (execution.cancelRequestedAt && pending) {
        execution.status = "cancel_requested";
      } else if (failed && pending) {
        execution.status = "running";
        execution.blockedReason = "prior_paid_failure";
        addGate(state, execution, "prior_paid_failure");
      } else if (failed) {
        execution.status = execution.outputs.some((item) => item.status === "completed") ? "partial" : "error";
        execution.blockedReason = undefined;
        addGate(state, execution, "prior_paid_failure");
      } else if (pending) {
        execution.status = "running";
      } else if (execution.outputs.every((item) => item.status === "completed")) {
        execution.status = "completed";
        execution.blockedReason = undefined;
      } else if (execution.requestGranularity === "per_output"
        && execution.outputs.some((item) => item.status === "completed")
        && execution.outputs.some((item) => item.status === "not_dispatched")) {
        if (execution.cancelRequestedAt) {
          execution.status = "partial";
          execution.blockedReason = undefined;
        } else {
          execution.status = "dispatching";
          execution.providerReceiptStatus = "confirmed";
          execution.blockedReason = undefined;
        }
      } else if (execution.outputs.some((item) => item.status === "completed")) {
        execution.status = "partial";
        execution.blockedReason = undefined;
      } else if (execution.outputs.every((item) => item.status === "cancelled" || item.status === "not_dispatched")) {
        execution.status = "cancelled";
        execution.blockedReason = undefined;
      } else if (execution.outputs.every((item) => item.status === "not_dispatched")) {
        execution.status = "blocked";
        execution.blockedReason ??= "provider_changed";
      } else if (execution.status === "dispatching") {
        if (boundaries(execution).length) {
          for (const output of execution.outputs) if (output.status === "not_dispatched") output.status = "unknown";
          execution.status = "unknown";
          execution.providerReceiptStatus = "unknown";
          execution.blockedReason = "unknown_prior_receipt";
          addGate(state, execution, "unknown_prior_receipt");
        } else {
          execution.status = "blocked";
          execution.blockedReason ??= "provider_changed";
        }
      }
      appendEvent(execution, "worker_dispatch_finished", { status: execution.status });
      const semantics = validateR4ExecutionSemantics(execution);
      if (!semantics.valid) throw new Error(`Worker 终态不满足 execution 语义：${semantics.issues.map((item) => item.message).join(" ")}`);
    });
  }

  private handleDispatchError(executionId: string, lastKnownSequence: number, error: unknown) {
    this.mutate(executionId, (state, execution) => {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
      const newBoundaries = boundaries(execution).filter((event) => Number(eventDetail(event).sequence) > lastKnownSequence);
      const hasAnyBoundary = boundaries(execution).length > 0;
      const cancelledBeforeBoundary = execution.cancelRequestedAt && !hasAnyBoundary;
      if (cancelledBeforeBoundary) {
        execution.status = "cancelled";
        execution.providerCancellation = "not_sent";
        execution.providerReceiptStatus = "not_applicable";
        confirmNotSentCancelled(execution);
        appendEvent(execution, "cancel_confirmed_not_sent", { source: "worker_stopped_before_boundary" });
      } else if (execution.cancelRequestedAt && newBoundaries.length === 0) {
        const pending = execution.outputs.some((output) => output.status === "pending");
        const completed = execution.outputs.some((output) => output.status === "completed");
        execution.status = pending ? "cancel_requested" : completed ? "partial" : "cancelled";
        execution.blockedReason = undefined;
        appendEvent(execution, "cancel_stopped_before_next_boundary", { error: message });
      } else if (newBoundaries.length > 0) {
        const affected = boundaryOutputs(execution, lastKnownSequence);
        const hasUncertain = newBoundaries.some((event) => {
          const detail = eventDetail(event);
          const receipt = latestReceipt(execution, Number(detail.sequence));
          return !receipt || ["unknown", "pending"].includes(String(eventDetail(receipt).status));
        });
        if (hasUncertain || execution.providerReceiptStatus === "unknown") {
          for (const output of execution.outputs) if ((affected.has(output.outputIndex) || output.status === "pending") && output.status === "pending") {
            output.status = "unknown";
            output.updatedAt = now();
          }
          execution.status = "unknown";
          execution.providerReceiptStatus = "unknown";
          execution.blockedReason = "unknown_prior_receipt";
          addGate(state, execution, "unknown_prior_receipt");
        } else {
          const pending = execution.outputs.some((output) => output.status === "pending");
          const completed = execution.outputs.some((output) => output.status === "completed");
          if (pending) execution.status = execution.cancelRequestedAt ? "cancel_requested" : "running";
          else if (completed) execution.status = "partial";
          else execution.status = "blocked";
          execution.blockedReason = undefined;
          if (execution.outputs.some((output) => output.status === "failed")) {
            execution.status = execution.outputs.some((output) => output.status === "completed") ? "partial" : "error";
            addGate(state, execution, "prior_paid_failure");
          } else if (execution.outputs.some((output) => output.status === "completed")
            && execution.outputs.some((output) => output.status === "not_dispatched")) {
            execution.status = "partial";
          } else if (!pending) {
            execution.status = "blocked";
            execution.providerReceiptStatus = "not_applicable";
            execution.blockedReason = "provider_changed";
          }
        }
        appendEvent(execution, "worker_dispatch_interrupted", { error: message, boundaryCount: newBoundaries.length });
      } else {
        const completed = execution.outputs.some((output) => output.status === "completed");
        execution.status = completed ? "partial" : "blocked";
        if (!hasAnyBoundary) {
          execution.providerReceiptStatus = "not_applicable";
          setAllNotDispatched(execution);
        }
        execution.blockedReason = completed ? undefined : "provider_changed";
        appendEvent(execution, "provider_preflight_failed", { error: message });
      }
      const semantics = validateR4ExecutionSemantics(execution);
      if (!semantics.valid) {
        // A safety invariant beats terminal convenience; preserve the pending
        // evidence in a non-terminal running/cancel_requested aggregate.
        if (execution.outputs.some((item) => item.status === "pending")) execution.status = execution.cancelRequestedAt ? "cancel_requested" : "running";
        else throw new Error(`Worker 错误收敛失败：${semantics.issues.map((item) => item.message).join(" ")}`);
      }
    });
  }
}

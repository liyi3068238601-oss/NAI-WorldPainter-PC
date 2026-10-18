import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentWorkspaceData } from "../../src/agent/types";
import type { R4Artwork, R4ConversationConfigSnapshot, R4Execution } from "../../src/agent/r4-types";
import { AgentSqlStore } from "./r4-store";
import { R4ExecutionWorker, type R4ExecutionProvider } from "./r4-execution-worker";
import { R4CreativeHost } from "./r4-creative-host";
import { registerR4ExecutionArtifacts } from "./r4-execution-coordinator";

const root = path.resolve(process.cwd(), ".tmp", "r4-execution-worker-tests");
const cleanup: Array<() => void> = [];
afterEach(() => { for (const clean of cleanup.splice(0).reverse()) clean(); });

function fixture(count = 1) {
  fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, "case-"));
  const workspace = {
    version: 4, conversations: [], skills: [], memories: [], characters: [], personas: [], lorebooks: [], samplerPresets: [],
    defaultGenerationMode: "confirm", updatedAt: new Date().toISOString(),
  } as unknown as AgentWorkspaceData;
  const store = new AgentSqlStore({
    filename: path.join(directory, "agent.sqlite"),
    legacyFiles: [],
    loadInitialState: () => ({ workspace }),
    normalizeWorkspace: (value) => structuredClone(value) as AgentWorkspaceData,
  });
  let storeOpen = true;
  const closeStore = () => { if (storeOpen) { store.close(); storeOpen = false; } };
  cleanup.push(() => { closeStore(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, store, closeStore, execution: execution("execution-1", count) };
}

const conversationConfig: R4ConversationConfigSnapshot = {
  version: 1,
  providerRef: { providerId: "fake" },
  modelId: "fake-model",
  presetId: null,
  enabled: false,
  publicParameters: {},
  capturedAt: "2026-10-18T00:00:00.000Z",
  source: "preview",
};

function execution(id: string, count: number): R4Execution {
  const timestamp = "2026-10-18T00:00:00.000Z";
  return {
    id,
    conversationId: "conversation-1",
    creationId: "creation-1",
    operationKey: "operation-1",
    submissionKey: `submission-${id}`,
    userIntentRef: "intent-1",
    inputRevision: 1,
    inputFingerprint: `fingerprint-${id}`,
    expectedOutputCount: count,
    requestGranularity: "per_output",
    providerRef: { providerId: "fake" },
    approvedInput: {
      inputRevision: 1,
      positivePrompt: "synthetic fixture",
      negativePrompt: "",
      stylePrompt: "",
      publicParameters: {
        requestedSeedPolicy: "random",
        requestedSeed: null,
        requestBudget: { image: count, vibe_encode: 0, upscale: 0 },
      },
      references: [],
    },
    conversationConfig,
    status: "queued",
    outputs: Array.from({ length: count }, (_, outputIndex) => ({ outputIndex, status: "not_dispatched" })),
    providerReceiptStatus: "not_applicable",
    providerCancellation: "not_sent",
    receiptRevision: 0,
    pauseReason: "none",
    createdAt: timestamp,
    updatedAt: timestamp,
    events: [],
  };
}

function artwork(executionId: string, outputIndex: number): R4Artwork {
  return {
    id: `art-${outputIndex}`,
    attachmentId: `attachment-${outputIndex}`,
    revision: 1,
    conversationId: "conversation-1",
    creationId: "creation-1",
    executionId,
    outputIndex,
    name: `fixture-${outputIndex}.png`,
    mime: "image/png",
    createdAt: new Date().toISOString(),
  };
}

function queue(store: AgentSqlStore, item: R4Execution) {
  store.transaction((tx) => {
    const state = tx.getR4State();
    state.executions[item.id] = structuredClone(item);
    tx.setR4State(state);
  });
}

function completedResult(executionId: string, outputIndex: number, status: "completed" | "failed" = "completed") {
  return {
    requestDisposition: "sent" as const,
    providerReceiptStatus: "confirmed" as const,
    outputs: [status === "completed"
      ? { outputIndex, status, artwork: artwork(executionId, outputIndex) }
      : { outputIndex, status, errorCode: "provider_error", errorMessage: "synthetic provider failure" }],
  };
}

function boundariesForTest(item: R4Execution) {
  return item.events.filter((event) => event.kind === "native_request_boundary").length;
}

describe("R4ExecutionWorker durable boundaries", () => {
  it("keeps a post-boundary request alive after unsupported cancellation and stores its late success", async () => {
    const { store, execution: item } = fixture();
    queue(store, item);

    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let deliverResult!: () => void;
    const delayed = new Promise<void>((resolve) => { deliverResult = resolve; });
    let requestSignal: AbortSignal | undefined;
    let calledCancelWithoutTaskId = false;
    const provider: R4ExecutionProvider = {
      async submit(current, outputIndex, context) {
        requestSignal = context.signal;
        await context.beforeSubmit("image");
        const afterBoundary = store.readR4State().executions[current.id];
        expect(afterBoundary.status).toBe("running");
        expect(afterBoundary.outputs[0].status).toBe("pending");
        markStarted();
        await delayed;
        await context.afterReceipt("image", { status: "confirmed", requestId: "fake-request" });
        return {
          requestDisposition: "sent",
          providerReceiptStatus: "confirmed",
          outputs: [{ outputIndex: outputIndex!, status: "completed", artwork: artwork(current.id, outputIndex!) }],
        };
      },
      async cancel(current) {
        calledCancelWithoutTaskId = !current.providerServiceTaskId;
        return { disposition: "unsupported", message: "fake provider has no remote cancellation" };
      },
    };

    const worker = new R4ExecutionWorker(store, provider);
    const pumping = worker.kick();
    expect(worker.hasActiveRequests()).toBe(true);
    await started;
    const cancellation = await worker.cancel(item.id);
    expect(calledCancelWithoutTaskId).toBe(true);
    expect(requestSignal?.aborted).toBe(false);
    expect(cancellation.status).toBe("cancel_requested");
    expect(cancellation.providerCancellation).toBe("unsupported");
    const raced = store.readR4State().executions[item.id];
    expect(raced.events.findIndex((event) => event.kind === "native_request_boundary"))
      .toBeLessThan(raced.events.findIndex((event) => event.kind === "cancel_intent"));
    expect(raced.events.some((event) => event.kind === "provider_cancel_receipt" && event.detail?.disposition === "unsupported")).toBe(true);

    deliverResult();
    await pumping;
    const saved = store.readR4State().executions[item.id];
    expect(saved.status).toBe("completed");
    expect(saved.outputs[0].status).toBe("completed");
    expect(saved.outputs[0].artwork?.id).toBe("art-0");
    expect(worker.hasActiveRequests()).toBe(false);
  });

  it("recovers completed per-output work without replay and resumes only the remaining slot", async () => {
    const { store, execution: item } = fixture(2);
    item.status = "dispatching";
    item.pauseReason = undefined;
    item.providerReceiptStatus = "confirmed";
    item.outputs[0] = { outputIndex: 0, status: "completed", artwork: artwork(item.id, 0) };
    item.outputs[1] = { outputIndex: 1, status: "not_dispatched" };
    item.dispatchClaimId = "claim-before-restart";
    item.events = [
      { id: "boundary-1", kind: "native_request_boundary", at: new Date().toISOString(), detail: { kind: "image", sequence: 1, outputIndex: 0, dispatchClaimId: item.dispatchClaimId } },
      { id: "pending-1", kind: "native_request_receipt", at: new Date().toISOString(), detail: { kind: "image", sequence: 1, status: "pending" } },
      { id: "receipt-1", kind: "native_request_receipt", at: new Date().toISOString(), detail: { kind: "image", sequence: 1, status: "confirmed" } },
    ];
    queue(store, item);

    const submittedIndexes: number[] = [];
    const provider: R4ExecutionProvider = {
      async submit(current, outputIndex, context) {
        submittedIndexes.push(outputIndex!);
        await context.beforeSubmit("image");
        await context.afterReceipt("image", { status: "confirmed", requestId: `request-${outputIndex}` });
        return {
          requestDisposition: "sent",
          providerReceiptStatus: "confirmed",
          outputs: [{ outputIndex: outputIndex!, status: "completed", artwork: artwork(current.id, outputIndex!) }],
        };
      },
    };

    const worker = new R4ExecutionWorker(store, provider);
    expect(worker.recover()).toEqual([item.id]);
    expect(store.readR4State().executions[item.id].status).toBe("dispatching");
    expect(submittedIndexes).toEqual([]);
    expect(worker.resume([item.id])).toEqual([item.id]);
    await worker.kick();
    expect(submittedIndexes).toEqual([1]);
    expect(store.readR4State().executions[item.id].status).toBe("completed");
  });

  it.each(["generate_image", "redraw_image", "inpaint_image", "upscale_image", "process_image"] as const)(
    "stops later output slots after a known paid failure for %s",
    async (operation) => {
      const { store, execution: item } = fixture(3);
      item.operationKey = `${operation}-operation`;
      item.approvedInput.publicParameters.operation = operation;
      item.approvedInput.publicParameters.requestBudget = { image: 3, vibe_encode: 0, upscale: 0 };
      queue(store, item);

      const submittedIndexes: number[] = [];
      const provider: R4ExecutionProvider = {
        async submit(current, outputIndex, context) {
          const index = outputIndex!;
          submittedIndexes.push(index);
          await context.beforeSubmit("image");
          const status = index === 1 ? "failed" : "confirmed";
          await context.afterReceipt("image", {
            status,
            requestId: `fake-${operation}-${index}`,
            ...(status === "failed" ? { message: "synthetic provider failure" } : {}),
          });
          return completedResult(current.id, index, index === 1 ? "failed" : "completed");
        },
      };

      const worker = new R4ExecutionWorker(store, provider);
      await worker.kick();
      const saved = store.readR4State().executions[item.id];
      expect(submittedIndexes).toEqual([0, 1]);
      expect(saved.status).toBe("partial");
      expect(saved.outputs.map((output) => output.status)).toEqual(["completed", "failed", "not_dispatched"]);
      expect(Object.values(store.readR4State().gates).some((gate) => gate.active && gate.executionId === item.id)).toBe(true);
    },
  );

  it("keeps an unknown prior receipt as a global automatic queue gate until an explicit independent resume", async () => {
    const { store, execution: unknown } = fixture();
    const unrelated = execution("execution-independent", 1);
    unknown.status = "unknown";
    unknown.providerReceiptStatus = "unknown";
    unknown.blockedReason = "unknown_prior_receipt";
    unknown.outputs[0].status = "unknown";
    unknown.dispatchClaimId = "claim-unknown";
    unknown.events = [
      { id: "boundary-unknown", kind: "native_request_boundary", at: new Date().toISOString(), outputIndex: 0,
        detail: { kind: "image", sequence: 1, outputIndex: 0, dispatchClaimId: "claim-unknown" } },
      { id: "receipt-unknown", kind: "native_request_receipt", at: new Date().toISOString(),
        detail: { kind: "image", sequence: 1, status: "unknown" } },
    ];
    store.transaction((tx) => {
      const state = tx.getR4State();
      state.executions[unknown.id] = structuredClone(unknown);
      state.executions[unrelated.id] = structuredClone(unrelated);
      state.gates["gate-unknown"] = {
        id: "gate-unknown", conversationId: unknown.conversationId, executionId: unknown.id,
        sourceExecutionId: unknown.id, active: true, reason: "unknown_prior_receipt", createdAt: new Date().toISOString(),
      };
      tx.setR4State(state);
    });

    const submitted: string[] = [];
    const provider: R4ExecutionProvider = {
      async submit(current, outputIndex, context) {
        submitted.push(current.id);
        await context.beforeSubmit("image");
        await context.afterReceipt("image", { status: "confirmed", requestId: `fake-${current.id}` });
        return completedResult(current.id, outputIndex!);
      },
    };
    const worker = new R4ExecutionWorker(store, provider);
    await worker.kick();
    expect(submitted).toEqual([]);
    expect(store.readR4State().executions[unrelated.id].status).toBe("queued");

    expect(worker.resume([unrelated.id])).toEqual([unrelated.id]);
    await worker.kick();
    expect(submitted).toEqual([unrelated.id]);
    expect(store.readR4State().executions[unrelated.id].status).toBe("completed");
    expect(store.readR4State().gates["gate-unknown"].active).toBe(true);
  });

  it("cancels queued work locally without crossing a provider boundary", async () => {
    const { store, execution: item } = fixture();
    queue(store, item);
    let submitCalls = 0;
    const worker = new R4ExecutionWorker(store, {
      async submit() {
        submitCalls += 1;
        throw new Error("should not dispatch cancelled work");
      },
    });

    const cancelled = await worker.cancel(item.id);
    await worker.kick();
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.providerCancellation).toBe("not_sent");
    expect(cancelled.events.some((event) => event.kind === "native_request_boundary")).toBe(false);
    expect(submitCalls).toBe(0);
  });

  it("wins a cancel race before the durable dispatch boundary and submits nothing", async () => {
    const { store, execution: item } = fixture();
    queue(store, item);
    let enteredSubmit!: () => void;
    const submitEntered = new Promise<void>((resolve) => { enteredSubmit = resolve; });
    let releaseSubmit!: () => void;
    const release = new Promise<void>((resolve) => { releaseSubmit = resolve; });
    let providerPosts = 0;
    let observedSignal: AbortSignal | undefined;
    const worker = new R4ExecutionWorker(store, {
      async submit(_current, _outputIndex, context) {
        observedSignal = context.signal;
        enteredSubmit();
        await release;
        await context.beforeSubmit("image");
        providerPosts += 1;
        await context.afterReceipt("image", { status: "confirmed" });
        return completedResult(item.id, 0);
      },
    });

    const pumping = worker.kick();
    await submitEntered;
    await worker.cancel(item.id);
    releaseSubmit();
    await pumping;

    const saved = store.readR4State().executions[item.id];
    expect(observedSignal?.aborted).toBe(true);
    expect(providerPosts).toBe(0);
    expect(saved.status).toBe("cancelled");
    expect(saved.providerCancellation).toBe("not_sent");
    expect(saved.events.some((event) => event.kind === "native_request_boundary")).toBe(false);
  });

  it.each(["requested", "confirmed"] as const)(
    "waits for a service task ID before remote cancellation and preserves the actual %s/late-result branch",
    async (cancelDisposition) => {
      const { store, execution: item } = fixture();
      queue(store, item);
      let context!: Parameters<R4ExecutionProvider["submit"]>[2];
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => { markStarted = resolve; });
      let releaseProvider!: () => void;
      const held = new Promise<void>((resolve) => { releaseProvider = resolve; });
      const cancelTaskIds: Array<string | undefined> = [];
      let remoteCancelRequests = 0;
      let submitCalls = 0;
      const provider: R4ExecutionProvider = {
        async submit(current, outputIndex, currentContext) {
          submitCalls += 1;
          context = currentContext;
          await context.beforeSubmit("image");
          await context.afterReceipt("image", { status: "pending", requestId: "request-without-task-id" });
          markStarted();
          await held;
          if (cancelDisposition === "requested") {
            await context.afterReceipt("image", {
              status: "confirmed", requestId: "late-success", serviceTaskId: "service-task-1",
            });
            return {
              requestDisposition: "sent", providerReceiptStatus: "confirmed",
              outputs: [{ outputIndex: outputIndex!, status: "completed", artwork: artwork(current.id, outputIndex!) }],
            };
          }
          return {
            requestDisposition: "sent", providerReceiptStatus: "confirmed",
            outputs: [{ outputIndex: outputIndex!, status: "cancelled", errorCode: "cancelled" }],
          };
        },
        async cancel(current) {
          cancelTaskIds.push(current.providerServiceTaskId);
          if (!current.providerServiceTaskId) return { disposition: "unsupported", message: "no addressable task ID yet" };
          remoteCancelRequests += 1;
          return { disposition: cancelDisposition, message: `fake remote cancel ${cancelDisposition}` };
        },
        async verify() {
          return {
            requestDisposition: "sent", providerReceiptStatus: "pending", providerServiceTaskId: "service-task-1",
            outputs: [{ outputIndex: 0, status: "pending" }],
          };
        },
      };
      const worker = new R4ExecutionWorker(store, provider);
      const pumping = worker.kick();
      await started;

      const beforeCancel = store.readR4State().executions[item.id];
      expect(beforeCancel.status).toBe("running");
      expect(beforeCancel.providerServiceTaskId).toBeUndefined();
      expect(beforeCancel.outputs[0].status).toBe("pending");
      expect(beforeCancel.providerReceiptStatus).toBe("pending");

      const firstCancel = await worker.cancel(item.id);
      expect(firstCancel.status).toBe("cancel_requested");
      expect(firstCancel.providerCancellation).toBe("unsupported");
      expect(remoteCancelRequests).toBe(0);
      expect(cancelTaskIds).toEqual([undefined]);

      const verified = await worker.verify(item.id);
      expect(verified.status).toBe("cancel_requested");
      expect(verified.providerServiceTaskId).toBe("service-task-1");
      expect(verified.outputs[0].status).toBe("pending");

      const secondCancel = await worker.cancel(item.id);
      expect(remoteCancelRequests).toBe(1);
      expect(cancelTaskIds).toEqual([undefined, "service-task-1"]);
      expect(secondCancel.providerCancellation).toBe(cancelDisposition);
      expect(secondCancel.status).toBe(cancelDisposition === "confirmed" ? "cancelled" : "cancel_requested");
      if (cancelDisposition === "confirmed") {
        expect(secondCancel.outputs[0].status).toBe("cancelled");
        expect(secondCancel.outputs[0].errorCode).toBe("cancelled");
      }

      releaseProvider();
      await pumping;
      const final = store.readR4State().executions[item.id];
      const boundaryIndex = final.events.findIndex((event) => event.kind === "native_request_boundary");
      const cancelIntentIndex = final.events.findIndex((event) => event.kind === "cancel_intent");
      expect(boundaryIndex).toBeLessThan(cancelIntentIndex);
      expect(final.events.some((event) => event.kind === "provider_verify_receipt")).toBe(true);
      expect(final.events.some((event) => event.kind === "provider_cancel_receipt" && event.detail?.disposition === cancelDisposition)).toBe(true);
      expect(final.providerServiceTaskId).toBe("service-task-1");
      expect(boundariesForTest(final)).toBe(1);
      expect(submitCalls).toBe(1);
      expect(worker.hasActiveRequests()).toBe(false);
      if (cancelDisposition === "requested") {
        expect(final.status).toBe("completed");
        expect(final.providerCancellation).toBe("requested");
        expect(final.outputs[0].artwork?.id).toBe("art-0");
        expect(final.events.some((event) => event.kind === "native_request_receipt" && event.detail?.status === "confirmed")).toBe(true);
      } else {
        expect(final.status).toBe("cancelled");
        expect(final.providerCancellation).toBe("confirmed");
        expect(final.outputs[0].status).toBe("cancelled");
        expect(final.outputs[0].artwork).toBeUndefined();
      }
    },
  );

  it("retains completed output evidence when atomic artwork registration fails, then repairs it after SQLite reopen without resubmission", async () => {
    const { directory, store, closeStore, execution: item } = fixture();
    const workspace = store.readWorkspace();
    workspace.conversations.push({
      id: item.conversationId, title: "registration recovery fixture", messages: [], draftAttachments: [],
    } as unknown as AgentWorkspaceData["conversations"][number]);
    store.writeWorkspace(workspace);
    const host = new R4CreativeHost(store, {
      captureConfig: () => structuredClone(conversationConfig),
      resolveAttachment: () => { throw new Error("No references in this test fixture."); },
    });
    const creationId = host.read(item.conversationId).currentCreationId!;
    item.creationId = creationId;
    item.approvedInput.publicParameters.turnLineageRef = "shared-registration-lineage";
    const related = execution("execution-related", 1);
    related.creationId = creationId;
    related.approvedInput.publicParameters.turnLineageRef = "shared-registration-lineage";
    related.createdAt = "2026-10-18T00:00:01.000Z";
    queue(store, item);
    queue(store, related);

    const submitted: string[] = [];
    const provider: R4ExecutionProvider = {
      async submit(current, outputIndex, context) {
        submitted.push(current.id);
        await context.beforeSubmit("image");
        await context.afterReceipt("image", { status: "confirmed", requestId: "worker-result-request" });
        const artifactBytes = Buffer.from(`synthetic artifact bytes for ${current.id}`);
        const readableHandle = path.join(directory, `${current.id}-result.png`);
        fs.writeFileSync(readableHandle, artifactBytes);
        const artifactHash = createHash("sha256").update(artifactBytes).digest("hex");
        const result: R4Artwork = {
          ...artwork(current.id, outputIndex!), id: `art-${current.id}-${outputIndex}`,
          attachmentId: `attachment-${current.id}-${outputIndex}`,
          readableHandle, hash: artifactHash, width: 2, height: 3,
          name: "worker-result.png", mime: "image/png",
        };
        return { requestDisposition: "sent", providerReceiptStatus: "confirmed", outputs: [{ outputIndex: outputIndex!, status: "completed", artwork: result }] };
      },
    };
    const trigger = new DatabaseSync(store.filename);
    trigger.exec("CREATE TRIGGER fail_fixture_artifact_registration BEFORE UPDATE OF workspace_json ON agent_state WHEN NEW.workspace_json <> OLD.workspace_json BEGIN SELECT RAISE(ABORT, 'fixture_artifact_registration'); END");
    trigger.close();

    const worker = new R4ExecutionWorker(store, provider, { onTransaction: registerR4ExecutionArtifacts });
    await worker.kick();
    const deferred = store.readR4State();
    const saved = deferred.executions[item.id];
    expect(saved.status).toBe("completed");
    expect(saved.outputs[0].artwork).toMatchObject({ readableHandle: path.join(directory, `${item.id}-result.png`) });
    expect(saved.events.some((event) => event.kind === "artwork_registration_deferred")).toBe(true);
    expect(deferred.artworks[saved.outputs[0].artwork!.id]).toBeUndefined();
    expect(deferred.creations[creationId].artworkIds).toEqual([]);
    expect(store.readWorkspace().conversations[0].messages).toEqual([]);
    expect(deferred.gates[`registration:${item.id}`]).toMatchObject({
      id: `registration:${item.id}`, executionId: item.id, turnId: "shared-registration-lineage",
      active: true, reason: "prior_paid_failure",
    });
    expect(deferred.executions[related.id].status).toBe("queued");
    expect(submitted).toEqual([item.id]);

    // These provider gates are independent evidence and must survive local registration repair.
    store.transaction((tx) => {
      const state = tx.getR4State();
      state.gates["provider-failure:preserve"] = {
        id: "provider-failure:preserve", conversationId: item.conversationId, executionId: "failed-source",
        turnId: "different-provider-failure-lineage", sourceExecutionId: "failed-source", active: true,
        reason: "prior_paid_failure", createdAt: new Date().toISOString(),
      };
      state.gates["provider-unknown:preserve"] = {
        id: "provider-unknown:preserve", conversationId: item.conversationId, executionId: "unknown-source",
        turnId: "different-unknown-lineage", sourceExecutionId: "unknown-source", active: true,
        reason: "unknown_prior_receipt", createdAt: new Date().toISOString(),
      };
      tx.setR4State(state);
    });

    const filename = store.filename;
    closeStore();
    const dropper = new DatabaseSync(filename);
    dropper.exec("DROP TRIGGER fail_fixture_artifact_registration");
    dropper.close();
    const reopened = new AgentSqlStore({
      filename, legacyFiles: [],
      loadInitialState: () => { throw new Error("Existing worker database must not be reseeded."); },
      normalizeWorkspace: (value) => structuredClone(value) as AgentWorkspaceData,
    });
    cleanup.push(() => reopened.close());
    const reopenedWorker = new R4ExecutionWorker(reopened, {
      async submit(current, outputIndex, context) {
        submitted.push(current.id);
        if (current.id !== related.id) throw new Error("A persisted provider result must not be resent.");
        await context.beforeSubmit("image");
        await context.afterReceipt("image", { status: "confirmed", requestId: "resumed-related-request" });
        const artifactBytes = Buffer.from(`synthetic artifact bytes for ${current.id}`);
        const readableHandle = path.join(directory, `${current.id}-result.png`);
        fs.writeFileSync(readableHandle, artifactBytes);
        const result: R4Artwork = {
          ...artwork(current.id, outputIndex!), id: `art-${current.id}-${outputIndex}`,
          attachmentId: `attachment-${current.id}-${outputIndex}`,
          readableHandle, hash: createHash("sha256").update(artifactBytes).digest("hex"), width: 2, height: 3,
          name: "worker-result.png", mime: "image/png",
        };
        return { requestDisposition: "sent", providerReceiptStatus: "confirmed", outputs: [{ outputIndex: outputIndex!, status: "completed", artwork: result }] };
      },
    }, { onTransaction: registerR4ExecutionArtifacts });
    expect(reopenedWorker.recover()).toEqual([related.id]); // terminal result is repaired; queued same-lineage work pauses
    await reopenedWorker.kick();

    const recoveredState = reopened.readR4State();
    const recoveredExecution = recoveredState.executions[item.id];
    const recoveredArtwork = recoveredExecution.outputs[0].artwork!;
    expect(recoveredExecution.status).toBe("completed");
    expect(recoveredExecution.events.some((event) => event.kind === "artwork_registration_recovered")).toBe(true);
    expect(recoveredArtwork.readableHandle).toBe(path.join(directory, `${item.id}-result.png`));
    expect(fs.readFileSync(recoveredArtwork.readableHandle!, "utf8")).toBe(`synthetic artifact bytes for ${item.id}`);
    expect(recoveredState.artworks[recoveredArtwork.id]).toMatchObject({ id: recoveredArtwork.id, hash: recoveredArtwork.hash });
    expect(recoveredState.creations[creationId].artworkIds).toEqual([recoveredArtwork.id]);
    const resultMessage = reopened.readWorkspace().conversations[0].messages.find((message) => message.id === `execution:${item.id}`);
    expect(resultMessage?.attachments).toHaveLength(1);
    expect(resultMessage?.attachments?.[0]).toMatchObject({ sha256: recoveredArtwork.hash, filePath: recoveredArtwork.readableHandle });
    expect(Object.values(recoveredState.critiqueQueue).some((entry) => entry.executionId === item.id)).toBe(true);
    expect(submitted).toEqual([item.id]);
    expect(recoveredState.executions[related.id].pauseReason).toBe("user_pause");
    expect(recoveredState.gates[`registration:${item.id}`]).toMatchObject({ active: false, releasedBy: "artwork_registration_recovered" });
    expect(recoveredState.gates["provider-failure:preserve"]).toMatchObject({ active: true, reason: "prior_paid_failure" });
    expect(recoveredState.gates["provider-unknown:preserve"]).toMatchObject({ active: true, reason: "unknown_prior_receipt" });

    // Repairing local registration never resumes same-lineage paid work automatically.
    const resumed = reopenedWorker.resume([related.id]);
    expect(resumed).toEqual([related.id]);
    await reopenedWorker.kick();
    const afterExplicitResume = reopened.readR4State();
    expect(submitted).toEqual([item.id, related.id]);
    expect(afterExplicitResume.executions[related.id].status).toBe("completed");
    expect(afterExplicitResume.gates["provider-failure:preserve"].active).toBe(true);
    expect(afterExplicitResume.gates["provider-unknown:preserve"].active).toBe(true);
  });

  it("keeps recovery available to other chats when one retained artwork file is missing", async () => {
    const { directory, store, closeStore, execution: item } = fixture();
    const workspace = store.readWorkspace();
    workspace.conversations.push(
      { id: item.conversationId, title: "missing artwork fixture", messages: [], draftAttachments: [] } as unknown as AgentWorkspaceData["conversations"][number],
      { id: "conversation-other", title: "unrelated fixture", messages: [], draftAttachments: [] } as unknown as AgentWorkspaceData["conversations"][number],
    );
    store.writeWorkspace(workspace);
    const host = new R4CreativeHost(store, {
      captureConfig: () => structuredClone(conversationConfig),
      resolveAttachment: () => { throw new Error("No references in this test fixture."); },
    });
    item.creationId = host.read(item.conversationId).currentCreationId!;
    const other = execution("execution-other-chat", 1);
    other.conversationId = "conversation-other";
    other.creationId = host.read(other.conversationId).currentCreationId!;
    other.createdAt = "2026-10-18T00:00:01.000Z";

    const expectedBytes = Buffer.from("synthetic bytes whose source file is unavailable");
    const missingArtwork: R4Artwork = {
      ...artwork(item.id, 0), id: "retained-artwork-missing-file", attachmentId: "retained-attachment-missing-file",
      readableHandle: path.join(directory, "missing-result.png"),
      hash: createHash("sha256").update(expectedBytes).digest("hex"), width: 2, height: 3,
    };
    item.status = "completed";
    item.providerReceiptStatus = "confirmed";
    item.dispatchClaimId = "claim-before-local-file-loss";
    item.outputs[0] = {
      outputIndex: 0, status: "completed", artwork: missingArtwork,
      providerReceipt: { status: "confirmed", requestId: "already-paid-request", receivedAt: new Date().toISOString() },
    };
    item.events = [
      { id: "missing-file-boundary", kind: "native_request_boundary", at: new Date().toISOString(), outputIndex: 0,
        detail: { kind: "image", sequence: 1, outputIndex: 0, dispatchClaimId: item.dispatchClaimId } },
      { id: "missing-file-receipt", kind: "native_request_receipt", at: new Date().toISOString(), outputIndex: 0,
        detail: { kind: "image", sequence: 1, status: "confirmed", requestId: "already-paid-request" } },
    ];
    queue(store, item);
    queue(store, other);
    const filename = store.filename;
    closeStore();

    const reopened = new AgentSqlStore({
      filename, legacyFiles: [],
      loadInitialState: () => { throw new Error("Existing worker database must not be reseeded."); },
      normalizeWorkspace: (value) => structuredClone(value) as AgentWorkspaceData,
    });
    cleanup.push(() => { reopened.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    const reopenedHost = new R4CreativeHost(reopened, {
      captureConfig: () => structuredClone(conversationConfig),
      resolveAttachment: () => { throw new Error("No references in this test fixture."); },
    });
    const worker = new R4ExecutionWorker(reopened, {
      async submit() { throw new Error("Recovery must not replay a completed provider request."); },
    }, { onTransaction: registerR4ExecutionArtifacts });

    expect(worker.recover()).toEqual([other.id]);
    expect(reopenedHost.read(other.conversationId).conversationId).toBe(other.conversationId);
    const recovered = reopened.readR4State();
    expect(recovered.executions[item.id].status).toBe("completed");
    expect(recovered.executions[item.id].outputs[0].artwork).toMatchObject({
      id: missingArtwork.id, attachmentId: missingArtwork.attachmentId, hash: missingArtwork.hash,
      readableHandle: missingArtwork.readableHandle,
    });
    expect(recovered.executions[item.id].events.at(-1)).toMatchObject({
      kind: "artwork_registration_recovery_failed", detail: { reason: "local_artwork_unavailable" },
    });
    expect(recovered.gates[`registration:${item.id}`]).toMatchObject({ active: true, reason: "prior_paid_failure" });
    expect(recovered.artworks[missingArtwork.id]).toBeUndefined();
    expect(recovered.executions[other.id].pauseReason).toBe("user_pause");
    expect(reopened.readWorkspace().conversations.find((chat) => chat.id === other.conversationId)?.messages).toEqual([]);
  });

  it("reopens a dispatched unknown as gated and never automatically resends its request", async () => {
    const { directory, store, closeStore, execution: item } = fixture();
    item.status = "running";
    item.providerReceiptStatus = "pending";
    item.outputs[0].status = "pending";
    item.dispatchClaimId = "claim-before-restart";
    item.events = [
      { id: "boundary-before-restart", kind: "native_request_boundary", at: new Date().toISOString(), outputIndex: 0,
        detail: { kind: "image", sequence: 1, outputIndex: 0, dispatchClaimId: item.dispatchClaimId } },
      { id: "pending-before-restart", kind: "native_request_receipt", at: new Date().toISOString(),
        detail: { kind: "image", sequence: 1, status: "pending" } },
    ];
    queue(store, item);
    const filename = store.filename;
    closeStore();

    const reopened = new AgentSqlStore({
      filename,
      legacyFiles: [],
      loadInitialState: () => { throw new Error("existing database must not be reseeded"); },
      normalizeWorkspace: (value) => structuredClone(value) as AgentWorkspaceData,
    });
    cleanup.push(() => { reopened.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    const submitted: string[] = [];
    const provider: R4ExecutionProvider = {
      async submit(current, outputIndex, context) {
        submitted.push(current.id);
        await context.beforeSubmit("image");
        return completedResult(current.id, outputIndex!);
      },
    };
    const worker = new R4ExecutionWorker(reopened, provider);
    expect(worker.recover()).toEqual([item.id]);
    await worker.kick();
    const saved = reopened.readR4State().executions[item.id];
    expect(saved.status).toBe("unknown");
    expect(saved.outputs[0].status).toBe("unknown");
    expect(Object.values(reopened.readR4State().gates).some((gate) => gate.active && gate.reason === "unknown_prior_receipt")).toBe(true);
    expect(submitted).toEqual([]);
  });
});

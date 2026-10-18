import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentWorkspaceData } from "../../src/agent/types";
import type { R4Artwork, R4ConversationConfigSnapshot, R4Execution, R4ExecutionEvent } from "../../src/agent/r4-types";
import { AgentSqlStore } from "./r4-store";
import { R4ExecutionWorker, type R4ExecutionProvider } from "./r4-execution-worker";

const root = path.resolve(process.cwd(), ".tmp", "r4-recovery-matrix");
const cleanup: Array<() => void> = [];
afterEach(() => { for (const clean of cleanup.splice(0).reverse()) clean(); });

const operations = ["generate_image", "redraw_image", "inpaint_image", "upscale_image", "process_image"] as const;
const config: R4ConversationConfigSnapshot = {
  version: 1, providerRef: { providerId: "fake-provider" }, modelId: "fake-model", presetId: null, enabled: false,
  publicParameters: {}, capturedAt: "2026-10-18T00:00:00.000Z", source: "preview",
};
const timestamp = "2026-10-18T00:00:00.000Z";

function makeWorkspace(): AgentWorkspaceData {
  return {
    version: 4,
    conversations: [{ id: "conversation-1", title: "R4 recovery fixture", messages: [], draftAttachments: [] }],
    skills: [], memories: [], characters: [], personas: [], lorebooks: [], samplerPresets: [],
    defaultGenerationMode: "confirm", updatedAt: timestamp,
  } as unknown as AgentWorkspaceData;
}

function createStore(filename: string) {
  return new AgentSqlStore({
    filename,
    legacyFiles: [],
    loadInitialState: () => ({ workspace: makeWorkspace() }),
    normalizeWorkspace: (value) => structuredClone(value) as AgentWorkspaceData,
  });
}

function makeArtwork(executionId: string, outputIndex: number): R4Artwork {
  return {
    id: `art-${executionId}-${outputIndex}`, attachmentId: `attachment-${executionId}-${outputIndex}`, revision: 1,
    conversationId: "conversation-1", creationId: "creation-1", executionId, outputIndex,
    name: `fixture-${outputIndex}.png`, mime: "image/png", createdAt: timestamp,
  };
}

function makeExecution(id: string, operation: typeof operations[number], count = 1): R4Execution {
  const isUpscale = operation === "upscale_image";
  return {
    id, conversationId: "conversation-1", creationId: "creation-1",
    operationKey: `operation-${id}`, submissionKey: `submission-${id}`, userIntentRef: `intent-${id}`,
    inputRevision: 1, inputFingerprint: `fingerprint-${id}`, expectedOutputCount: count,
    requestGranularity: "per_output", providerRef: { providerId: "fake-provider" },
    approvedInput: {
      inputRevision: 1, positivePrompt: "synthetic recovery fixture", negativePrompt: "", stylePrompt: "",
      publicParameters: {
        operation, requestedSeedPolicy: "random", requestedSeed: null,
        requestBudget: { image: isUpscale ? 0 : count, vibe_encode: 0, upscale: isUpscale ? count : 0 },
      },
      references: [],
    },
    conversationConfig: config, status: "queued",
    outputs: Array.from({ length: count }, (_, outputIndex) => ({ outputIndex, status: "not_dispatched" })),
    providerReceiptStatus: "not_applicable", providerCancellation: "not_sent", receiptRevision: 0,
    pauseReason: "none", createdAt: timestamp, updatedAt: timestamp, events: [],
  };
}

function requestEvents(execution: R4Execution, kind: "image" | "upscale", status: "pending" | "confirmed" | "unknown", outputIndex = 0): R4ExecutionEvent[] {
  const claim = `claim-${execution.id}`;
  return [
    { id: `boundary-${execution.id}`, kind: "native_request_boundary", at: timestamp, outputIndex,
      detail: { kind, sequence: 1, outputIndex, dispatchClaimId: claim } },
    { id: `pending-${execution.id}`, kind: "native_request_receipt", at: timestamp,
      detail: { kind, sequence: 1, status: "pending" } },
    ...(status === "pending" ? [] : [{ id: `receipt-${execution.id}`, kind: "native_request_receipt", at: timestamp,
      detail: { kind, sequence: 1, status } }]),
  ];
}

function fixture() {
  fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, "case-"));
  const filename = path.join(directory, "agent.sqlite");
  let store: AgentSqlStore | undefined = createStore(filename);
  cleanup.push(() => {
    store?.close();
    const relative = path.relative(root, directory);
    if (!relative || relative.startsWith("..")) throw new Error("Unsafe R4 recovery fixture cleanup path.");
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory, filename,
    get store() { if (!store) throw new Error("Fixture store is closed."); return store; },
    close() { store?.close(); store = undefined; },
    reopen() {
      if (store) throw new Error("Close the current fixture store before reopening.");
      store = new AgentSqlStore({
        filename, legacyFiles: [],
        loadInitialState: () => { throw new Error("An existing SQLite database must never be reseeded."); },
        normalizeWorkspace: (value) => structuredClone(value) as AgentWorkspaceData,
      });
      return store;
    },
  };
}

function installMatrix(store: AgentSqlStore, operation: typeof operations[number]) {
  const suffix = operation;
  const queued = makeExecution(`${suffix}-queued`, operation);
  const dispatching = makeExecution(`${suffix}-dispatching`, operation);
  dispatching.status = "dispatching";
  dispatching.pauseReason = undefined;
  dispatching.dispatchClaimId = `claim-${dispatching.id}`;
  dispatching.events = [{ id: `claim-event-${dispatching.id}`, kind: "queue_claim", at: timestamp,
    detail: { dispatchClaimId: dispatching.dispatchClaimId } }];

  const cancelledBeforeBoundary = makeExecution(`${suffix}-cancelled-before-boundary`, operation);
  cancelledBeforeBoundary.status = "cancelled";
  cancelledBeforeBoundary.cancelRequestedAt = timestamp;
  cancelledBeforeBoundary.providerCancellation = "not_sent";
  cancelledBeforeBoundary.outputs[0] = { outputIndex: 0, status: "cancelled", errorCode: "cancelled" };
  cancelledBeforeBoundary.events = [{ id: `cancel-${cancelledBeforeBoundary.id}`, kind: "cancel_intent", at: timestamp, detail: { source: "user" } }];

  const running = makeExecution(`${suffix}-running`, operation);
  running.status = "running";
  running.pauseReason = undefined;
  running.providerReceiptStatus = "pending";
  running.dispatchClaimId = `claim-${running.id}`;
  running.outputs[0] = { outputIndex: 0, status: "pending" };
  running.events = requestEvents(running, operation === "upscale_image" ? "upscale" : "image", "pending");

  const cancelRequested = makeExecution(`${suffix}-cancel-requested`, operation);
  cancelRequested.status = "cancel_requested";
  cancelRequested.pauseReason = undefined;
  cancelRequested.providerReceiptStatus = "pending";
  cancelRequested.providerCancellation = "requested";
  cancelRequested.cancelRequestedAt = timestamp;
  cancelRequested.dispatchClaimId = `claim-${cancelRequested.id}`;
  cancelRequested.outputs[0] = { outputIndex: 0, status: "pending" };
  cancelRequested.events = [
    ...requestEvents(cancelRequested, operation === "upscale_image" ? "upscale" : "image", "pending"),
    { id: `cancel-${cancelRequested.id}`, kind: "cancel_intent", at: timestamp, detail: { source: "user" } },
  ];

  const partial = makeExecution(`${suffix}-partial`, operation, 2);
  partial.status = "dispatching";
  partial.pauseReason = undefined;
  partial.providerReceiptStatus = "confirmed";
  partial.dispatchClaimId = `claim-${partial.id}`;
  partial.outputs[0] = { outputIndex: 0, status: "completed", artwork: makeArtwork(partial.id, 0) };
  partial.outputs[1] = { outputIndex: 1, status: "not_dispatched" };
  partial.events = requestEvents(partial, operation === "upscale_image" ? "upscale" : "image", "confirmed");

  const unknown = makeExecution(`${suffix}-unknown`, operation);
  unknown.status = "unknown";
  unknown.pauseReason = undefined;
  unknown.blockedReason = "unknown_prior_receipt";
  unknown.providerReceiptStatus = "unknown";
  unknown.dispatchClaimId = `claim-${unknown.id}`;
  unknown.outputs[0] = { outputIndex: 0, status: "unknown" };
  unknown.events = requestEvents(unknown, operation === "upscale_image" ? "upscale" : "image", "unknown");

  const completed = makeExecution(`${suffix}-completed`, operation);
  completed.status = "completed";
  completed.pauseReason = undefined;
  completed.providerReceiptStatus = "confirmed";
  completed.dispatchClaimId = `claim-${completed.id}`;
  completed.outputs[0] = { outputIndex: 0, status: "completed", artwork: makeArtwork(completed.id, 0) };
  completed.events = requestEvents(completed, operation === "upscale_image" ? "upscale" : "image", "confirmed");

  const executions = [queued, dispatching, cancelledBeforeBoundary, running, cancelRequested, partial, unknown, completed];
  store.transaction((tx) => {
    const state = tx.getR4State();
    for (const execution of executions) state.executions[execution.id] = structuredClone(execution);
    state.gates[`gate-${unknown.id}`] = {
      id: `gate-${unknown.id}`, conversationId: unknown.conversationId, executionId: unknown.id,
      sourceExecutionId: unknown.id, active: true, reason: "unknown_prior_receipt", createdAt: timestamp,
    };
    tx.setR4State(state);
  });
  return { queued, dispatching, cancelledBeforeBoundary, running, cancelRequested, partial, unknown, completed };
}

describe("R4 Final five-operation SQLite recovery matrix", () => {
  it.each(operations)("closes/reopens durable dispatch, receipt, cancellation, and partial-slot states for %s", async (operation) => {
    const f = fixture();
    const initial = installMatrix(f.store, operation);
    f.close();
    const reopened = f.reopen();
    const submitted: Array<{ id: string; outputIndex: number; kind: string }> = [];
    const requestKind = operation === "upscale_image" ? "upscale" : "image";
    const provider: R4ExecutionProvider = {
      async submit(execution, outputIndex, context) {
        const index = outputIndex!;
        submitted.push({ id: execution.id, outputIndex: index, kind: requestKind });
        await context.beforeSubmit(requestKind);
        await context.afterReceipt(requestKind, { status: "confirmed", requestId: `resumed-${execution.id}-${index}` });
        return {
          requestDisposition: "sent", providerReceiptStatus: "confirmed",
          outputs: [{ outputIndex: index, status: "completed", artwork: makeArtwork(execution.id, index) }],
        };
      },
    };
    const worker = new R4ExecutionWorker(reopened, provider);
    const recovered = worker.recover();
    expect(new Set(recovered)).toEqual(new Set([
      initial.queued.id, initial.dispatching.id, initial.running.id, initial.cancelRequested.id, initial.partial.id,
    ]));
    expect(reopened.readR4State().executions[initial.queued.id].pauseReason).toBe("user_pause");
    expect(reopened.readR4State().executions[initial.dispatching.id].status).toBe("queued");
    expect(reopened.readR4State().executions[initial.dispatching.id].pauseReason).toBe("user_pause");
    expect(reopened.readR4State().executions[initial.cancelledBeforeBoundary.id].status).toBe("cancelled");
    expect(reopened.readR4State().executions[initial.cancelledBeforeBoundary.id].providerCancellation).toBe("not_sent");
    expect(reopened.readR4State().executions[initial.running.id].status).toBe("unknown");
    expect(reopened.readR4State().executions[initial.running.id].outputs[0].status).toBe("unknown");
    expect(reopened.readR4State().executions[initial.cancelRequested.id].status).toBe("unknown");
    expect(reopened.readR4State().executions[initial.cancelRequested.id].outputs[0].status).toBe("unknown");
    expect(reopened.readR4State().executions[initial.partial.id].status).toBe("dispatching");
    expect(reopened.readR4State().executions[initial.partial.id].outputs.map((item) => item.status)).toEqual(["completed", "not_dispatched"]);
    expect(reopened.readR4State().executions[initial.unknown.id].status).toBe("unknown");
    expect(reopened.readR4State().executions[initial.completed.id].status).toBe("completed");

    // Recovered work is never sent merely because the application reopened.
    await worker.kick();
    expect(submitted).toEqual([]);

    const resumed = worker.resume([initial.queued.id, initial.dispatching.id, initial.partial.id]);
    expect(new Set(resumed)).toEqual(new Set([initial.queued.id, initial.dispatching.id, initial.partial.id]));
    await worker.kick();
    expect(submitted).toHaveLength(3);
    expect(submitted.filter((item) => item.id === initial.partial.id).map((item) => item.outputIndex)).toEqual([1]);
    expect(submitted.filter((item) => item.id === initial.queued.id).map((item) => item.outputIndex)).toEqual([0]);
    expect(submitted.filter((item) => item.id === initial.dispatching.id).map((item) => item.outputIndex)).toEqual([0]);
    for (const id of [initial.queued.id, initial.dispatching.id, initial.partial.id]) {
      expect(reopened.readR4State().executions[id].status).toBe("completed");
    }
    expect(Object.values(reopened.readR4State().gates).some((gate) => gate.id === `gate-${initial.unknown.id}` && gate.active)).toBe(true);
    expect(reopened.readR4State().executions[initial.unknown.id].status).toBe("unknown");
    expect(reopened.readR4State().executions[initial.running.id].status).toBe("unknown");
    expect(reopened.readR4State().executions[initial.cancelRequested.id].status).toBe("unknown");
    expect(reopened.readR4State().executions[initial.completed.id].status).toBe("completed");
  });

  it.each(operations)("rejects an active aggregate that hides fully completed slots for %s", (operation) => {
    const f = fixture();
    const execution = makeExecution(`invalid-${operation}`, operation);
    execution.status = "completed";
    execution.pauseReason = undefined;
    execution.providerReceiptStatus = "confirmed";
    execution.dispatchClaimId = `claim-${execution.id}`;
    execution.outputs[0] = { outputIndex: 0, status: "completed", artwork: makeArtwork(execution.id, 0) };
    execution.events = requestEvents(execution, operation === "upscale_image" ? "upscale" : "image", "confirmed");
    f.store.transaction((tx) => {
      const state = tx.getR4State();
      state.executions[execution.id] = execution;
      tx.setR4State(state);
    });
    f.close();

    const raw = new DatabaseSync(f.filename);
    const row = raw.prepare("SELECT r4_json FROM agent_state WHERE id = 1").get() as { r4_json: string };
    const state = JSON.parse(row.r4_json) as { executions: Record<string, R4Execution> };
    state.executions[execution.id].status = "dispatching";
    raw.prepare("UPDATE agent_state SET r4_json = ?, r4_revision = r4_revision + 1 WHERE id = 1").run(JSON.stringify(state));
    raw.close();
    const corruptedBytes = fs.readFileSync(f.filename);

    expect(() => f.reopen()).toThrow(/status:dispatching|Dispatching requires|Confirmed dispatching may only follow completed per-output outputs/);
    expect(fs.readFileSync(f.filename)).toEqual(corruptedBytes);
  });
});

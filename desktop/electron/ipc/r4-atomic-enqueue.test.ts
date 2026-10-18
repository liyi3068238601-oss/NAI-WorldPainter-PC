import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentWorkspaceData } from "../../src/agent/types";
import type { R4Artwork, R4ConversationConfigSnapshot, R4CreationInputSnapshot } from "../../src/agent/r4-types";
import { AgentSqlStore } from "./r4-store";
import { R4CreativeHost, type R4HostScope } from "./r4-creative-host";
import { R4ExecutionCoordinator } from "./r4-execution-coordinator";
import type { R4ExecutionProvider } from "./r4-execution-worker";

const root = path.resolve(process.cwd(), ".tmp", "r4-atomic-enqueue");
const cleanup: Array<() => void> = [];
afterEach(() => { for (const clean of cleanup.splice(0).reverse()) clean(); });

const config: R4ConversationConfigSnapshot = {
  version: 1, providerRef: { providerId: "fixture-model" }, modelId: "fixture-model", presetId: null, enabled: false,
  publicParameters: { visionEnabled: false }, capturedAt: "2026-10-18T00:00:00.000Z", source: "preview",
};
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0u0AAAAASUVORK5CYII=", "base64");
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function makeWorkspace(): AgentWorkspaceData {
  return {
    version: 4,
    conversations: [{ id: "conversation-1", title: "Atomic enqueue fixture", messages: [], draftAttachments: [] }],
    skills: [], memories: [], characters: [], personas: [], lorebooks: [], samplerPresets: [],
    defaultGenerationMode: "confirm", updatedAt: new Date().toISOString(),
  } as unknown as AgentWorkspaceData;
}

function fixture() {
  fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, "case-"));
  const filename = path.join(directory, "agent.sqlite");
  const initialStore = () => new AgentSqlStore({
    filename, legacyFiles: [], loadInitialState: () => ({ workspace: makeWorkspace() }),
    normalizeWorkspace: (value) => structuredClone(value) as AgentWorkspaceData,
  });
  const reopenedStore = () => new AgentSqlStore({
    filename, legacyFiles: [], loadInitialState: () => { throw new Error("Existing database must not be reseeded."); },
    normalizeWorkspace: (value) => structuredClone(value) as AgentWorkspaceData,
  });
  let store: AgentSqlStore | undefined = initialStore();
  let artifactSequence = 0;
  const submits: Array<{ executionId: string; outputIndex: number }> = [];
  const makeHost = (activeStore: AgentSqlStore) => {
    let host: R4CreativeHost;
    host = new R4CreativeHost(activeStore, {
      captureConfig: () => structuredClone(config),
      resolveAttachment: () => { throw new Error("This fixture does not use image references."); },
      prepare: async (creation, args, conversationConfig) => {
        const input: R4CreationInputSnapshot = {
          ...host.snapshot(creation), positivePrompt: String(args.positivePrompt ?? "synthetic enqueue"),
          conversationConfig,
          publicParameters: {
            operation: "generate_image", count: 2, providerRef: { providerId: "fixture-image" },
            requestedSeedPolicy: "random", requestedSeed: null,
            requestBudget: { image: 2, vibe_encode: 0, upscale: 0 },
          },
        };
        return {
          input, providerRef: { providerId: "fixture-image" },
          preview: { positivePrompt: input.positivePrompt, count: 2, imageProvider: "fixture-image", estimateSource: "fixture",
            estimatedAnlas: 0, warning: "synthetic", requestedSeedPolicy: "random", requestedSeed: null,
            resolvedSeed: null, resolvedSeedSource: null },
        };
      },
    });
    return host;
  };
  const provider: R4ExecutionProvider = {
    async submit(execution, outputIndex, context) {
      const index = outputIndex!;
      submits.push({ executionId: execution.id, outputIndex: index });
      await context.beforeSubmit("image");
      await context.afterReceipt("image", { status: "confirmed", requestId: `fixture-request-${index}` });
      const id = `art-${++artifactSequence}`;
      const readableHandle = path.join(directory, `${id}.png`);
      fs.writeFileSync(readableHandle, png);
      const artwork: R4Artwork = {
        id, attachmentId: `attachment-${id}`, revision: 1, conversationId: "conversation-1", creationId: execution.creationId,
        executionId: execution.id, batchId: execution.id, outputIndex: index, name: `${id}.png`, mime: "image/png",
        readableHandle, hash: hash(png), width: 1, height: 1, createdAt: new Date().toISOString(),
      };
      return { requestDisposition: "sent", providerReceiptStatus: "confirmed", outputs: [{ outputIndex: index, status: "completed", artwork }] };
    },
  };
  const api = (activeStore: AgentSqlStore) => {
    const host = makeHost(activeStore);
    const conversation = host.read("conversation-1");
    const scope: R4HostScope = {
      conversationId: "conversation-1", creationId: conversation.currentCreationId!,
      userIntentRef: `intent-${randomUUID()}`, operationKey: `operation-${randomUUID()}`,
    };
    return { host, scope, coordinator: new R4ExecutionCoordinator(host, provider) };
  };
  const close = () => { if (store) { store.close(); store = undefined; } };
  const reopen = () => { if (store) throw new Error("Close fixture database before reopening."); store = reopenedStore(); return store; };
  cleanup.push(() => {
    close();
    const relative = path.relative(root, directory);
    if (!relative || relative.startsWith("..")) throw new Error("Unsafe atomic enqueue fixture cleanup path.");
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory, filename, submits,
    get store() { if (!store) throw new Error("Fixture store is closed."); return store; },
    close, reopen, api,
  };
}

async function waitFor(predicate: () => boolean, label: string) {
  const end = Date.now() + 5_000;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

const abortBoundaries = [
  {
    name: "agent_state row update",
    sql: "CREATE TRIGGER fixture_abort_state_update BEFORE UPDATE OF r4_json ON agent_state WHEN NEW.r4_json <> OLD.r4_json BEGIN SELECT RAISE(ABORT, 'fixture_state_update'); END",
    drop: "DROP TRIGGER fixture_abort_state_update",
  },
  {
    name: "submission-key index insert",
    sql: "CREATE TRIGGER fixture_abort_submission_key BEFORE INSERT ON r4_submission_keys BEGIN SELECT RAISE(ABORT, 'fixture_submission_key'); END",
    drop: "DROP TRIGGER fixture_abort_submission_key",
  },
  {
    name: "second output-slot index insert after the first slot was indexed",
    sql: "CREATE TRIGGER fixture_abort_second_output BEFORE INSERT ON r4_output_slots WHEN NEW.output_index = 1 BEGIN SELECT RAISE(ABORT, 'fixture_second_output_slot'); END",
    drop: "DROP TRIGGER fixture_abort_second_output",
  },
] as const;

describe("R4 Final atomic approval and enqueue SQL write order", () => {
  it.each(abortBoundaries)("rolls back the complete accepted snapshot when the real %s write fails", async (boundary) => {
    const f = fixture();
    const { host, scope, coordinator } = f.api(f.store);
    const prepared = await host.prepare({ positivePrompt: "atomic synthetic fixture", count: 2 }, scope, true);
    const preparationId = String(prepared.preparationId);
    const fingerprint = String(prepared.inputFingerprint);
    const beforeRow = f.store.transaction((tx) => ({
      workspace: JSON.stringify(tx.getWorkspace()), state: JSON.stringify(tx.getR4State()),
    }));
    const db = new DatabaseSync(f.filename);
    const baseline = db.prepare("SELECT workspace_json, r4_json FROM agent_state WHERE id = 1").get() as { workspace_json: string; r4_json: string };
    expect(JSON.parse(baseline.r4_json).preparations[preparationId].status).toBe("ready");
    expect(db.prepare("SELECT COUNT(*) AS count FROM r4_submission_keys").get()).toMatchObject({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM r4_output_slots").get()).toMatchObject({ count: 0 });
    db.exec(boundary.sql);
    db.close();

    expect(() => coordinator.submit(preparationId, fingerprint, scope, true)).toThrow();
    expect(f.submits).toEqual([]); // the post-commit worker kick was never scheduled
    expect(JSON.stringify(f.store.readWorkspace())).toBe(beforeRow.workspace);
    const afterFailure = f.store.readR4State();
    expect(JSON.stringify(afterFailure)).toBe(beforeRow.state);
    expect(afterFailure.preparations[preparationId]).toMatchObject({ status: "ready", fingerprint });
    expect(afterFailure.preparations[preparationId].approvalReceiptId).toBeUndefined();
    expect(afterFailure.preparations[preparationId].approvedAt).toBeUndefined();
    expect(afterFailure.preparations[preparationId].consumedByExecutionId).toBeUndefined();
    expect(Object.keys(afterFailure.executions)).toHaveLength(0);
    expect(Object.values(afterFailure.operations).filter((item) => item.operation === "submit_execution")).toHaveLength(0);

    f.close();
    const inspect = new DatabaseSync(f.filename, { readOnly: true });
    const persisted = inspect.prepare("SELECT workspace_json, r4_json FROM agent_state WHERE id = 1").get() as { workspace_json: string; r4_json: string };
    expect(persisted).toEqual(baseline);
    expect(inspect.prepare("SELECT COUNT(*) AS count FROM r4_submission_keys").get()).toMatchObject({ count: 0 });
    expect(inspect.prepare("SELECT COUNT(*) AS count FROM r4_output_slots").get()).toMatchObject({ count: 0 });
    inspect.close();

    const dropper = new DatabaseSync(f.filename);
    dropper.exec(boundary.drop);
    dropper.close();
    const reopened = f.reopen();
    const retry = f.api(reopened);
    const accepted = retry.coordinator.submit(preparationId, fingerprint, scope, true) as { data: { executionId: string } };
    const executionId = accepted.data.executionId;
    await waitFor(() => reopened.readR4State().executions[executionId]?.status === "completed", "explicit retry completion");

    const final = reopened.readR4State();
    expect(f.submits.map((item) => item.outputIndex)).toEqual([0, 1]);
    expect(final.preparations[preparationId]).toMatchObject({ status: "consumed", consumedByExecutionId: executionId });
    expect(final.preparations[preparationId].approvalReceiptId).toBeTruthy();
    expect(final.executions[executionId].approvedInput.positivePrompt).toBe("atomic synthetic fixture");
    expect(Object.values(final.operations).filter((item) => item.operation === "submit_execution")).toHaveLength(1);
    expect(reopened.findExecutionBySubmissionKey(final.executions[executionId].submissionKey)).toMatchObject({
      executionId, inputFingerprint: fingerprint,
    });
    expect(Object.values(final.artworks).filter((item) => item.executionId === executionId)).toHaveLength(2);
    expect(reopened.readWorkspace().conversations[0].messages.filter((item) => item.id === `execution:${executionId}`)).toHaveLength(1);
    const inspectFinal = new DatabaseSync(f.filename, { readOnly: true });
    expect(inspectFinal.prepare("SELECT COUNT(*) AS count FROM r4_submission_keys WHERE execution_id = ?").get(executionId)).toMatchObject({ count: 1 });
    expect(inspectFinal.prepare("SELECT COUNT(*) AS count FROM r4_output_slots WHERE execution_id = ?").get(executionId)).toMatchObject({ count: 2 });
    inspectFinal.close();
  });
});

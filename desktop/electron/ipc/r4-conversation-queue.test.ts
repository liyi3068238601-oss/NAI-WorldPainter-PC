import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConversation, AgentSendRequest, AgentWorkspaceData } from "../../src/agent/types";
import {
  createEmptyR4AgentState,
  type R4ConversationConfigSnapshot,
  type R4Creation,
  type R4CreationInputSnapshot,
  type R4QueuedMessage,
} from "../../src/agent/r4-types";
import { AgentSqlStore } from "./r4-store";
import { R4ConversationQueue, type R4ConversationQueueOptions, type R4ConversationQueueHost } from "./r4-conversation-queue";

const tempRoot = path.resolve(process.cwd(), ".tmp");
let fixtureRoot = "";
const stores: AgentSqlStore[] = [];

function chat(id: string, status: AgentConversation["status"] = "idle"): AgentConversation {
  return {
    id, title: id, messages: [], draftAttachments: [], status,
    context: { used: 0, limit: 1000, percent: 0, danger: false, estimated: true, updatedAt: "2026-10-18T00:00:00.000Z" },
    compactCount: 0, createdAt: "2026-10-18T00:00:00.000Z", updatedAt: "2026-10-18T00:00:00.000Z",
    characterIds: [], lorebookIds: [], generationMode: "confirm", autoPlayGroup: false, pinned: false,
  };
}

function config(modelId = "model-original"): R4ConversationConfigSnapshot {
  return {
    version: 1,
    providerRef: { providerId: "provider-original", revision: "profile-r1" },
    modelId,
    modelRevision: "model-r1",
    presetId: "preset-original",
    enabled: true,
    body: "frozen assistant preset",
    revision: 7,
    hash: "preset-hash-7",
    publicParameters: { maxOutputTokens: 4096 },
    capturedAt: "2026-10-18T00:00:00.000Z",
    source: "message_send",
  };
}

function inputSnapshot(conversationConfig: R4ConversationConfigSnapshot): R4CreationInputSnapshot {
  return {
    inputRevision: 4,
    positivePrompt: "preserved prompt",
    negativePrompt: "",
    stylePrompt: "",
    publicParameters: { width: 832 },
    references: [],
    conversationConfig,
  };
}

function makeStore(conversations: AgentConversation[], seed?: (state: ReturnType<typeof createEmptyR4AgentState>) => void) {
  const legacyFile = path.join(fixtureRoot, "legacy-" + stores.length + ".json");
  fs.writeFileSync(legacyFile, "immutable test migration source");
  const state = createEmptyR4AgentState();
  seed?.(state);
  const store = new AgentSqlStore({
    filename: path.join(fixtureRoot, "agent-" + stores.length + ".sqlite"),
    legacyFiles: [legacyFile, legacyFile + ".bak", legacyFile + ".bak2"],
    loadInitialState: () => ({
      workspace: {
        version: 4, conversations, skills: [], memories: [], characters: [], personas: [], lorebooks: [], samplerPresets: [],
        defaultGenerationMode: "confirm", updatedAt: "2026-10-18T00:00:00.000Z",
      } as unknown as AgentWorkspaceData,
      r4State: state,
    }),
    normalizeWorkspace: (value) => value as AgentWorkspaceData,
  });
  stores.push(store);
  return store;
}

function makeHost(store: AgentSqlStore, currentConfig = config()): R4ConversationQueueHost {
  return {
    store,
    captureConfig: () => structuredClone(currentConfig),
    snapshotCreation: (_creation, boundConfig) => inputSnapshot(boundConfig),
  };
}

function makeQueue(store: AgentSqlStore, options: Partial<R4ConversationQueueOptions> = {}, currentConfig = config()) {
  let generatedId = 0;
  const queueOptions: R4ConversationQueueOptions = {
    run: async () => undefined,
    now: () => "2026-10-18T01:00:00.000Z",
    id: () => "id-" + (++generatedId),
    ...options,
  };
  return new R4ConversationQueue(makeHost(store, currentConfig), queueOptions);
}

function request(conversationId: string, patch: Partial<AgentSendRequest> = {}): AgentSendRequest {
  return {
    conversationId,
    text: "render a glass observatory",
    creationId: "creation-1",
    composerDraftRevision: 3,
    ...patch,
  };
}

function saveDraft(store: AgentSqlStore, conversationId: string, text: string, expectedRevision: number) {
  let revision = -1;
  store.transaction((tx) => {
    const state = tx.getR4State();
    const creative = state.conversations[conversationId];
    if (creative.composerDraft?.revision !== expectedRevision) throw new Error("fixture draft CAS mismatch");
    revision = expectedRevision + 1;
    creative.composerDraft = { text, revision, attachmentIds: [], updatedAt: "fixture-save" };
    tx.setR4State(state);
  });
  return revision;
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  fs.mkdirSync(tempRoot, { recursive: true });
  fixtureRoot = fs.mkdtempSync(path.join(tempRoot, "r4-conversation-queue-test-"));
});

afterEach(() => {
  while (stores.length) stores.pop()!.close();
  if (!fixtureRoot) return;
  if (path.dirname(fixtureRoot) !== tempRoot || !path.basename(fixtureRoot).startsWith("r4-conversation-queue-test-")) {
    throw new Error("Refusing to remove an unexpected R4 conversation queue fixture directory.");
  }
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = "";
});

describe("R4ConversationQueue durable conversation turns", () => {
  it("atomically persists the user turn, freezes config/provider text/input, and records the admission cutoff", async () => {
    const firstRun = deferred();
    const started: R4QueuedMessage[] = [];
    const workspaceChat = chat("conversation-1");
    workspaceChat.messages.push({ id: "prior-user", role: "user", content: "earlier", attachments: [], tools: [], status: "complete", createdAt: "before" });
    const store = makeStore([workspaceChat], (state) => {
      state.conversations["conversation-1"] = {
        conversationId: "conversation-1", messageCreationIds: {}, selectionRevision: 0, updatedAt: "before",
        currentCreationId: "creation-1",
        composerDraft: { text: "render a glass observatory", revision: 3, attachmentIds: [], updatedAt: "before" },
      };
      state.creations["creation-1"] = { id: "creation-1", conversationId: "conversation-1" } as R4Creation;
    });
    const queue = makeQueue(store, {
      prepareMessage: () => ({ visibleText: "visible request", providerText: "frozen provider request", actions: [] }),
      run: async (item) => { started.push(item); await firstRun.promise; },
    });

    const admitted = queue.enqueue(request("conversation-1"));
    expect(admitted.ok).toBe(true);
    await vi.waitFor(() => expect(started).toHaveLength(1));
    const state = store.readR4State();
    const saved = state.messageQueue[admitted.queueId!];
    const chatAfter = store.readWorkspace().conversations[0];
    expect(saved).toMatchObject({
      status: "running", text: "render a glass observatory", providerText: "frozen provider request",
      conversationConfig: { modelId: "model-original" }, predecessorIds: ["prior-user"],
      originalInputSnapshot: { positivePrompt: "preserved prompt", inputRevision: 4 },
    });
    expect(saved.assistantMessageId).toBeTruthy();
    expect(saved.startedAt).toBeTruthy();
    expect(chatAfter.messages.at(-1)).toMatchObject({ id: admitted.messageId, content: "visible request", queuedMessageId: admitted.queueId, creationId: "creation-1" });
    expect(chatAfter.messages.at(-1)?.originalInputSnapshot).toMatchObject({ inputRevision: 4 });
    expect(state.conversations["conversation-1"].composerDraft).toMatchObject({ text: "", revision: 4, attachmentIds: [] });

    firstRun.resolve();
    await queue.kick("conversation-1");
    expect(store.readR4State().messageQueue[admitted.queueId!]?.status).toBe("completed");
  });

  it("serializes messages per conversation and freezes each causal predecessor cutoff", async () => {
    const first = deferred();
    const starts: R4QueuedMessage[] = [];
    const store = makeStore([chat("conversation-1"), chat("conversation-2")], (state) => {
      state.conversations["conversation-1"] = { conversationId: "conversation-1", messageCreationIds: {}, selectionRevision: 0, updatedAt: "before", composerDraft: { text: "A", revision: 1, attachmentIds: [], updatedAt: "before" } };
      state.conversations["conversation-2"] = { conversationId: "conversation-2", messageCreationIds: {}, selectionRevision: 0, updatedAt: "before", composerDraft: { text: "D", revision: 1, attachmentIds: [], updatedAt: "before" } };
    });
    const queue = makeQueue(store, { run: async (item) => { starts.push(item); if (item.conversationId === "conversation-1" && item.sequence === 1) await first.promise; } });
    const a = queue.enqueue(request("conversation-1", { text: "A", creationId: undefined, composerDraftRevision: 1 }));
    await vi.waitFor(() => expect(starts).toHaveLength(1));
    const revisionB = saveDraft(store, "conversation-1", "B", 2);
    const b = queue.enqueue(request("conversation-1", { text: "B", creationId: undefined, composerDraftRevision: revisionB }));
    const revisionC = saveDraft(store, "conversation-1", "C", revisionB + 1);
    const c = queue.enqueue(request("conversation-1", { text: "C", creationId: undefined, composerDraftRevision: revisionC }));
    const d = queue.enqueue(request("conversation-2", { text: "D", creationId: undefined, composerDraftRevision: 1 }));
    await vi.waitFor(() => expect(starts.some((item) => item.messageId === d.messageId)).toBe(true));

    const state = store.readR4State();
    const bRecord = state.messageQueue[b.queueId!];
    const aRecord = state.messageQueue[a.queueId!];
    expect(aRecord.assistantMessageId).toBeTruthy();
    expect(bRecord.predecessorIds).toContain(a.messageId);
    expect(bRecord.predecessorIds).not.toContain(c.messageId);
    expect(bRecord.predecessorIds).not.toContain(aRecord.assistantMessageId);
    expect(starts.filter((item) => item.conversationId === "conversation-1")).toHaveLength(1);
    expect(starts.filter((item) => item.conversationId === "conversation-2")).toHaveLength(1);

    first.resolve();
    await Promise.all([queue.kick("conversation-1"), queue.kick("conversation-2")]);
    expect(starts.filter((item) => item.conversationId === "conversation-1").map((item) => item.text)).toEqual(["A", "B", "C"]);
    expect(store.readR4State().messageQueue[c.queueId!]?.status).toBe("completed");
  });

  it("lets a new explicit send proceed after an error without auto-resuming earlier paused text", async () => {
    const failFirst = deferred();
    const started: string[] = [];
    const store = makeStore([chat("conversation-1")], (state) => {
      state.conversations["conversation-1"] = { conversationId: "conversation-1", messageCreationIds: {}, selectionRevision: 0, updatedAt: "before", composerDraft: { text: "first request", revision: 1, attachmentIds: [], updatedAt: "before" } };
    });
    const queue = makeQueue(store, { run: async (item) => {
      started.push(item.text);
      if (item.text === "first request") { await failFirst.promise; throw new Error("known runtime failure"); }
    } });
    const first = queue.enqueue(request("conversation-1", { text: "first request", creationId: undefined, composerDraftRevision: 1 }));
    await vi.waitFor(() => expect(started).toEqual(["first request"]));
    let revision = saveDraft(store, "conversation-1", "already queued before the failure", 2);
    const earlierPaused = queue.enqueue(request("conversation-1", { text: "already queued before the failure", creationId: undefined, composerDraftRevision: revision }));
    failFirst.resolve();
    await vi.waitFor(() => expect(store.readR4State().messageQueue[earlierPaused.queueId!]?.status).toBe("paused"));
    expect(store.readR4State().messageQueue[first.queueId!]?.status).toBe("error");

    revision = saveDraft(store, "conversation-1", "new discussion of the recorded result", 4);
    const newSend = queue.enqueue(request("conversation-1", { text: "new discussion of the recorded result", creationId: undefined, composerDraftRevision: revision }));
    await vi.waitFor(() => expect(store.readR4State().messageQueue[newSend.queueId!]?.status).toBe("completed"));
    expect(started).toEqual(["first request", "new discussion of the recorded result"]);
    expect(store.readR4State().messageQueue[earlierPaused.queueId!]?.status).toBe("paused");
    expect(store.readR4State().messageQueue[first.queueId!]?.status).toBe("error");

    const resumed = queue.resume("conversation-1");
    expect(resumed).toMatchObject({ ok: true, data: { restoredMessageIds: [earlierPaused.messageId] } });
    await vi.waitFor(() => expect(store.readR4State().messageQueue[earlierPaused.queueId!]?.status).toBe("completed"));
    expect(started).toEqual(["first request", "new discussion of the recorded result", "already queued before the failure"]);
    expect(store.readR4State().messageQueue[first.queueId!]?.status).toBe("error");
  });

  it("restores only into the unchanged draft, preserves the frozen config, and refuses implicit config fallback", async () => {
    const draftAttachment = {
      id: "draft-image", name: "input.png", mime: "image/png", size: 8, kind: "image" as const,
      filePath: "C:/safe/input.png", createdAt: "before",
    };
    const source = chat("conversation-1");
    source.draftAttachments = [draftAttachment];
    const store = makeStore([source], (state) => {
      state.conversations["conversation-1"] = {
        conversationId: "conversation-1", messageCreationIds: {}, selectionRevision: 0, updatedAt: "before",
        composerDraft: { text: "render a glass observatory", revision: 3, attachmentIds: ["draft-image"], updatedAt: "before" },
      };
    });
    const queue = makeQueue(store);
    const admitted = queue.enqueue(request("conversation-1", { creationId: undefined, attachmentIds: ["draft-image"] }));
    queue.pause("conversation-1", "user paused before start");
    const canceled = await queue.cancel("conversation-1", admitted.messageId!, 4);
    expect(canceled).toMatchObject({ ok: true, data: { restored: true } });
    expect(store.readWorkspace().conversations[0].draftAttachments.map((item) => item.id)).toEqual(["draft-image"]);
    expect(store.readR4State().conversations["conversation-1"].composerDraft).toMatchObject({
      text: "render a glass observatory", attachmentIds: ["draft-image"], revision: 5,
    });

    const second = queue.enqueue(request("conversation-1", { creationId: undefined, composerDraftRevision: 5, attachmentIds: ["draft-image"] }));
    queue.pause("conversation-1", "user paused before start");
    store.transaction((tx) => {
      const state = tx.getR4State();
      state.conversations["conversation-1"].composerDraft = { text: "newer draft", revision: 7, attachmentIds: [], updatedAt: "newer" };
      tx.setR4State(state);
    });
    expect(await queue.cancel("conversation-1", second.messageId!, 6)).toMatchObject({ ok: false });
    expect(await queue.cancel("conversation-1", second.messageId!, 7)).toMatchObject({ ok: true, data: { restored: false } });
    expect(store.readR4State().conversations["conversation-1"].composerDraft).toMatchObject({ text: "newer draft", revision: 7 });

    const restoredQueueItem = store.readR4State().messageQueue[admitted.queueId!]!;
    store.transaction((tx) => {
      const state = tx.getR4State();
      state.conversations["conversation-1"].composerDraft = { text: "", revision: 8, attachmentIds: [], updatedAt: "cleared" };
      tx.setR4State(state);
    });
    const restore = queue.restore("conversation-1", admitted.messageId!, 8);
    expect(restore.ok).toBe(true);
    const restoredDraft = store.readR4State().conversations["conversation-1"].composerDraft!;
    expect(restoredDraft.restoredConversationConfig?.modelId).toBe("model-original");
    expect(restoredDraft.requiresConfigConfirmation).toBe(true);
    expect(queue.enqueue(request("conversation-1", { creationId: undefined, composerDraftRevision: restoredDraft.revision, attachmentIds: ["draft-image"] })).ok).toBe(false);
    const confirmed = queue.enqueue(request("conversation-1", {
      creationId: undefined,
      composerDraftRevision: restoredDraft.revision,
      attachmentIds: ["draft-image"],
      confirmedConversationConfigHash: restoredDraft.restoredConfigFingerprint,
    }));
    expect(confirmed.ok).toBe(true);
    expect(store.readR4State().messageQueue[confirmed.queueId!]?.conversationConfig.modelId).toBe(restoredQueueItem.conversationConfig.modelId);
  });

  it("does not replay recovered running turns and only restores them as a new draft", async () => {
    const inFlight = deferred();
    const started = vi.fn(async () => { await inFlight.promise; });
    const store = makeStore([chat("conversation-1")], (state) => {
      state.conversations["conversation-1"] = { conversationId: "conversation-1", messageCreationIds: {}, selectionRevision: 0, updatedAt: "before", composerDraft: { text: "unsafe to replay", revision: 1, attachmentIds: [], updatedAt: "before" } };
    });
    const firstQueue = makeQueue(store, { run: started });
    const admitted = firstQueue.enqueue(request("conversation-1", { text: "unsafe to replay", creationId: undefined, composerDraftRevision: 1 }));
    await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(1));
    const secondRun = vi.fn(async () => undefined);
    const recoveredQueue = makeQueue(store, { run: secondRun });
    expect(recoveredQueue.recover()).toMatchObject({ pausedRunning: 1 });
    expect(recoveredQueue.resume("conversation-1")).toMatchObject({ ok: false });
    expect(secondRun).not.toHaveBeenCalled();
    const draft = store.readR4State().conversations["conversation-1"].composerDraft!;
    const restored = recoveredQueue.restore("conversation-1", admitted.messageId!, draft.revision);
    expect(restored).toMatchObject({ ok: true, data: { newRequestOnly: true } });
    expect(store.readR4State().messageQueue[admitted.queueId!]).toMatchObject({ status: "cancelled", startedAt: expect.any(String) });
    expect(store.readR4State().conversations["conversation-1"].composerDraft?.text).toBe("unsafe to replay");
    inFlight.resolve();
    await firstQueue.kick("conversation-1");
    expect(secondRun).not.toHaveBeenCalled();
  });

  it("consumes a steer once or returns an unconsumed steer to the normal queue", async () => {
    const firstRun = deferred();
    const starts: string[] = [];
    const hostChat = chat("conversation-1", "running");
    const store = makeStore([hostChat], (state) => {
      state.conversations["conversation-1"] = { conversationId: "conversation-1", messageCreationIds: {}, selectionRevision: 0, updatedAt: "before", composerDraft: { text: "origin", revision: 1, attachmentIds: [], updatedAt: "before" } };
    });
    const queue = makeQueue(store, {
      run: async (item) => { starts.push(item.text); if (item.text === "origin") await firstRun.promise; },
      steer: async () => true,
    });
    const origin = queue.enqueue(request("conversation-1", { text: "origin", creationId: undefined, composerDraftRevision: 1 }));
    await vi.waitFor(() => expect(starts).toEqual(["origin"]));
    const steerRevision = saveDraft(store, "conversation-1", "steer", 2);
    const steer = queue.enqueue(request("conversation-1", { text: "steer", creationId: undefined, composerDraftRevision: steerRevision, delivery: "steer" }));
    await vi.waitFor(() => expect(store.readR4State().messageQueue[steer.queueId!]?.steeringStatus).toBe("requested"));
    const originRecord = store.readR4State().messageQueue[origin.queueId!]!;
    expect(store.readR4State().messageQueue[steer.queueId!]?.assistantMessageId).toBe(originRecord.assistantMessageId);
    queue.markSteeringConsumed("conversation-1", steer.messageId!, originRecord.assistantMessageId);
    firstRun.resolve();
    await queue.kick("conversation-1");
    expect(store.readR4State().messageQueue[origin.queueId!]?.status).toBe("completed");
    expect(store.readR4State().messageQueue[steer.queueId!]?.status).toBe("completed");
    expect(starts).toEqual(["origin"]);
  });

  it("withdraws a requested steer only through the exact runtime hook before canceling", async () => {
    const store = makeStore([chat("conversation-1", "running")], (state) => {
      state.conversations["conversation-1"] = { conversationId: "conversation-1", messageCreationIds: {}, selectionRevision: 0, updatedAt: "before", composerDraft: { text: "guide", revision: 1, attachmentIds: [], updatedAt: "before" } };
    });
    const withdraw = vi.fn(async () => true);
    const queue = makeQueue(store, { steer: async () => true, withdrawSteer: withdraw });
    const sent = queue.enqueue(request("conversation-1", { text: "guide", creationId: undefined, composerDraftRevision: 1, delivery: "steer" }));
    await vi.waitFor(() => expect(store.readR4State().messageQueue[sent.queueId!]?.steeringStatus).toBe("requested"));
    expect(await queue.cancel("conversation-1", sent.messageId!, 2)).toMatchObject({ ok: true });
    expect(withdraw).toHaveBeenCalledOnce();
    expect(store.readR4State().messageQueue[sent.queueId!]).toMatchObject({ status: "cancelled", steeringStatus: "none" });
  });
  it('only continues the explicitly selected independent new message, preserving old unknown receipts and other queued input',async()=>{
    const starts:R4QueuedMessage[]=[];
    const store=makeStore([chat('conversation-1')],state=>{
      state.conversations['conversation-1']={conversationId:'conversation-1',messageCreationIds:{},selectionRevision:0,updatedAt:'before',composerDraft:{text:'new task B',revision:1,attachmentIds:[],updatedAt:'before'}};
      state.gates.old={id:'old',conversationId:'conversation-1',turnId:'old-intent',active:true,reason:'unknown_prior_receipt',createdAt:'before'};
    });
    const queue=makeQueue(store,{run:async item=>{starts.push(item);}});
    const b=queue.enqueue(request('conversation-1',{text:'new task B',creationId:undefined,composerDraftRevision:1}));await queue.kick('conversation-1');
    const revision=saveDraft(store,'conversation-1','unselected task C',2);
    const c=queue.enqueue(request('conversation-1',{text:'unselected task C',creationId:undefined,composerDraftRevision:revision}));await queue.kick('conversation-1');
    expect(starts).toHaveLength(0);expect(store.readR4State().messageQueue[b.queueId!].startedAt).toBeUndefined();
    expect(queue.resumeSelected('conversation-1',[b.messageId!],['old']).ok).toBe(true);await queue.kick('conversation-1');
    expect(starts.map(item=>item.text)).toEqual(['new task B']);expect(starts[0].releasedGateIds).toEqual(['old']);
    expect(store.readR4State().messageQueue[c.queueId!].status).toBe('paused');expect(store.readR4State().gates.old.active).toBe(true);
    const release=Object.values(store.readR4State().operations).find(row=>row.operation==='release_independent_messages');expect(release?.receipt).toMatchObject({messageIds:[b.messageId],oldRequestsReplayed:false});
  });
  it('a newly appearing unknown receipt is not covered by an earlier continuation choice',async()=>{
    const starts:R4QueuedMessage[]=[];const store=makeStore([chat('conversation-1')],state=>{
      state.conversations['conversation-1']={conversationId:'conversation-1',messageCreationIds:{},selectionRevision:0,updatedAt:'before',composerDraft:{text:'B',revision:1,attachmentIds:[],updatedAt:'before'}};
      state.gates.old={id:'old',conversationId:'conversation-1',turnId:'old-intent',active:true,reason:'unknown_prior_receipt',createdAt:'before'};
    });
    const queue=makeQueue(store,{run:async item=>{starts.push(item);}}),b=queue.enqueue(request('conversation-1',{text:'B',creationId:undefined,composerDraftRevision:1}));await queue.kick('conversation-1');
    const held=deferred(),lock=queue.withConversation('conversation-1',()=>held.promise);await Promise.resolve();
    expect(queue.resumeSelected('conversation-1',[b.messageId!],['old']).ok).toBe(true);
    store.transaction(tx=>{const state=tx.getR4State();state.gates.new={id:'new',conversationId:'other',active:true,reason:'unknown_prior_receipt',createdAt:'later'};tx.setR4State(state);});
    held.resolve();await lock;await queue.kick('conversation-1');expect(starts).toHaveLength(0);expect(store.readR4State().messageQueue[b.queueId!].status).toBe('paused');
    store.transaction(tx=>{const state=tx.getR4State();state.gates.old.turnId=state.messageQueue[b.queueId!].userIntentRef;tx.setR4State(state);});
    expect(queue.resumeSelected('conversation-1',[b.messageId!],['old','new']).ok).toBe(false);
  });
});

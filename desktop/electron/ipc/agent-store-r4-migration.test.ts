import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ root: "" }));
vi.mock("electron", () => ({ dialog: {} }));
vi.mock("./agent-workspace-location", () => ({
  agentWorkspaceDirectory: () => fixture.root,
  rebaseAgentWorkspaceFile: (value: string) => value,
}));
vi.mock("./local-media-protocol", () => ({ toLocalMediaUrl: (value: string) => `local:${value}` }));
vi.mock("./store", () => ({
  getSettings: () => ({ agentContextWindow: 128_000, agentAutoCompactThreshold: 0.8, outputDir: "" }),
  getHistoryReferenceItems: () => [],
  fileExistsWithDirectoryCache: () => false,
}));

import {
  agentWorkspacePath,
  createEmptyAgentWorkspace,
  createAgentConversation,
  deleteAgentAttachment,
  deleteAgentConversation,
  getAgentSqlStore,
  readAgentR4State,
  readAgentWorkspace,
  resetAgentStoreCacheForTests,
  writeAgentWorkspace,
} from "./agent-store";
import { TAVERN_PRESET_LIBRARY_VERSION } from "../../src/tavern/builtins";
import { STUDIO_BUILTIN_PRESETS } from "../../src/agent/workspace-controls";

const tempRoot = path.resolve(process.cwd(), ".tmp");
const EMPTY_STAMP = "2026-10-18T00:00:00.000Z";
let fixtureRoot = "";

beforeEach(() => {
  fs.mkdirSync(tempRoot, { recursive: true });
  fixtureRoot = fs.mkdtempSync(path.join(tempRoot, "agent-store-r4-migration-"));
  fixture.root = fixtureRoot;
  resetAgentStoreCacheForTests();
});

afterEach(() => {
  resetAgentStoreCacheForTests();
  if (!fixtureRoot) return;
  if (path.dirname(fixtureRoot) !== tempRoot || !path.basename(fixtureRoot).startsWith("agent-store-r4-migration-")) {
    throw new Error("Refusing to remove an unexpected Agent migration fixture directory.");
  }
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = "";
});

describe("Agent workspace one-time SQLite migration", () => {
  it("preserves legacy bytes, custom Tavern prompt data and separate Pi binding semantics", () => {
    const workspace = createEmptyAgentWorkspace();
    const conversation = workspace.conversations[0];
    const legacySamplerPresets = [...workspace.samplerPresets];
    conversation.studioPresetId = "studio-complete";
    conversation.studioTemplateEnabled = false;
    conversation.samplerPresetId = legacySamplerPresets[0].id;
    const customPreset = {
      id: "custom-preset", name: "自定义预设", systemPrompt: "custom system body", jailbreakPrompt: "custom jailbreak",
      temperature: 0.7, topP: 0.8, frequencyPenalty: 0, presencePenalty: 0, stop: [],
      source: "sillytavern-json", sourceName: "fixture.json", createdAt: "2026-10-18", updatedAt: "2026-10-18",
      unknownExtension: { keep: "source data" },
    } as any;
    workspace.samplerPresets = [...legacySamplerPresets, customPreset];
    const raw = { ...workspace, presetLibraryVersion: Math.max(1, TAVERN_PRESET_LIBRARY_VERSION - 1), unknownWorkspaceField: { keep: true } };
    const sourceBytes = Buffer.from(`${JSON.stringify(raw, null, 2)}\n`);
    const source = agentWorkspacePath();
    fs.writeFileSync(source, sourceBytes);
    const backupBytes = Buffer.from("older synthetic JSON backup\n");
    fs.writeFileSync(`${source}.bak`, backupBytes);

    const migrated = readAgentWorkspace();
    const migratedConversation = migrated.conversations.find((item) => item.id === conversation.id)!;
    expect(migratedConversation.studioPresetId).toBe("studio-complete");
    expect(migratedConversation.studioTemplateEnabled).toBe(false);
    expect(migratedConversation.samplerPresetId).toBe(legacySamplerPresets[0].id);
    expect(migrated.samplerPresets.map((preset) => preset.id)).toEqual([...legacySamplerPresets.map((preset) => preset.id), "custom-preset"]);

    const r4 = readAgentR4State();
    expect(r4.conversations[conversation.id]?.assistantPresetBinding).toMatchObject({
      presetId: "studio-complete", enabled: false,
    });
    expect(r4.assistantPresets["tavern:custom-preset"]).toMatchObject({
      body: "custom system body\n\ncustom jailbreak",
      legacyRecord: { unknownExtension: { keep: "source data" } },
    });
    expect((r4.compatibility.legacyWorkspace as any).raw.unknownWorkspaceField).toEqual({ keep: true });
    expect(fs.readFileSync(source)).toEqual(sourceBytes);
    expect(fs.readFileSync(`${source}.bak`)).toEqual(backupBytes);

    const changed = readAgentWorkspace();
    changed.conversations[0].title = "SQLite workspace update";
    writeAgentWorkspace(changed);
    expect(fs.readFileSync(source)).toEqual(sourceBytes);
    expect(getAgentSqlStore().filename).toBe(path.join(fixtureRoot, "agent-state.sqlite"));
  });

  it("refuses an unknown workspace version without creating a fresh database or changing its backups", () => {
    const source = agentWorkspacePath();
    const primary = Buffer.from('{"version":99,"privateFixture":"keep"}\n');
    const backup = Buffer.from('{"version":4,"conversations":[]}\n');
    fs.writeFileSync(source, primary);
    fs.writeFileSync(`${source}.bak`, backup);

    expect(() => readAgentWorkspace()).toThrow(/版本 99 暂不支持/);
    expect(fs.existsSync(path.join(fixtureRoot, "agent-state.sqlite"))).toBe(false);
    expect(fs.readFileSync(source)).toEqual(primary);
    expect(fs.readFileSync(`${source}.bak`)).toEqual(backup);
  });

  it("preserves an unknown legacy assistant preset ID and marks its durable binding for repair", () => {
    const workspace = createEmptyAgentWorkspace();
    const conversation = workspace.conversations[0];
    const unknownPresetId = "tavern:removed-resource-preset";
    conversation.studioPresetId = unknownPresetId;
    conversation.studioTemplateEnabled = true;
    const source = agentWorkspacePath();
    const sourceBytes = Buffer.from(`${JSON.stringify(workspace, null, 2)}\n`);
    fs.writeFileSync(source, sourceBytes);

    const migratedWorkspace = readAgentWorkspace();
    expect(migratedWorkspace.conversations.find((item) => item.id === conversation.id)?.studioPresetId)
      .toBe(unknownPresetId);
    const state = readAgentR4State();
    expect(state.conversations[conversation.id]?.assistantPresetBinding).toEqual({
      presetId: unknownPresetId,
      enabled: true,
      legacyStatus: "migration_conflict",
    });
    expect(state.assistantPresets[unknownPresetId]).toBeUndefined();
    expect((state.compatibility.legacyWorkspace as any).raw.conversations[0].studioPresetId)
      .toBe(unknownPresetId);
    expect(fs.readFileSync(source)).toEqual(sourceBytes);
    expect(fs.existsSync(path.join(fixtureRoot, "agent-state.sqlite"))).toBe(true);
  });

  it("seeds fresh SQL workspaces with both built-in and resource-backed assistant presets", () => {
    const workspace = readAgentWorkspace();
    const state = readAgentR4State();
    const legacyResource = workspace.samplerPresets[0];
    const legacyPresetId = `tavern:${legacyResource.id}`;

    expect(Object.keys(state.assistantPresets)).toEqual(expect.arrayContaining([
      ...STUDIO_BUILTIN_PRESETS.map((preset) => preset.id),
      legacyPresetId,
    ]));
    for (const source of STUDIO_BUILTIN_PRESETS) {
      expect(state.assistantPresets[source.id]).toMatchObject({
        id: source.id,
        name: source.name,
        body: source.body,
        revision: 1,
        source: "builtin",
      });
    }
    expect(state.assistantPresets[legacyPresetId]).toMatchObject({
      id: legacyPresetId,
      name: legacyResource.name,
      body: [legacyResource.systemPrompt, legacyResource.jailbreakPrompt].filter(Boolean).join("\n\n"),
      revision: 1,
      source: "legacy_tavern",
    });
    expect(state.assistantPresets[legacyPresetId].legacyRecord).toMatchObject({
      id: legacyResource.id,
      systemPrompt: legacyResource.systemPrompt,
      jailbreakPrompt: legacyResource.jailbreakPrompt,
      sourceHash: legacyResource.sourceHash,
    });
    expect(state.assistantPresetDefaultBinding).toMatchObject({
      presetId: expect.any(String),
      enabled: true,
    });
    expect(state.conversations[workspace.conversations[0].id]?.assistantPresetBinding).toMatchObject({
      presetId: expect.any(String),
      enabled: true,
    });
  });

  it("snapshots the current assistant preset default when each conversation is created", () => {
    const store = getAgentSqlStore();
    const originalDefault = readAgentR4State().assistantPresetDefaultBinding!;
    const firstResult = createAgentConversation("Created before default change");
    expect(firstResult.ok).toBe(true);
    const firstId = firstResult.workspace.selectedConversationId!;
    expect(readAgentR4State().conversations[firstId]?.assistantPresetBinding).toEqual(originalDefault);

    const nextDefault = STUDIO_BUILTIN_PRESETS.find((preset) => preset.id !== originalDefault.presetId)!;
    store.transaction((tx) => {
      const state = tx.getR4State();
      state.assistantPresetDefaultBinding = { presetId: nextDefault.id, enabled: false };
      tx.setR4State(state);
    });

    const secondResult = createAgentConversation("Created after default change");
    expect(secondResult.ok).toBe(true);
    const secondId = secondResult.workspace.selectedConversationId!;
    const finalState = readAgentR4State();
    expect(finalState.conversations[firstId]?.assistantPresetBinding).toEqual(originalDefault);
    expect(finalState.conversations[secondId]?.assistantPresetBinding).toEqual({ presetId: nextDefault.id, enabled: false });
    expect(finalState.assistantPresetDefaultBinding).toEqual({ presetId: nextDefault.id, enabled: false });
  });

  it("versions deliberate legacy resource-preset edits without replacing R4-only edits on unrelated writes", () => {
    const workspace = readAgentWorkspace();
    const resource = workspace.samplerPresets[0]!;
    const presetId = `tavern:${resource.id}`;
    const initial = readAgentR4State().assistantPresets[presetId]!;

    workspace.samplerPresets[0] = { ...resource, systemPrompt: `${resource.systemPrompt}\nlegacy edit` };
    writeAgentWorkspace(workspace);
    let state = readAgentR4State();
    expect(state.assistantPresets[presetId]).toMatchObject({
      revision: initial.revision + 1,
      body: [`${resource.systemPrompt}\nlegacy edit`, resource.jailbreakPrompt].filter(Boolean).join("\n\n"),
    });
    expect((state.compatibility.presetRevisionHistory as Record<string, unknown>)[`${presetId}@${initial.revision}`])
      .toEqual(initial);

    const editedInR4 = state.assistantPresets[presetId]!;
    const unrelated = readAgentWorkspace();
    unrelated.conversations[0]!.title = "unrelated workspace update";
    writeAgentWorkspace(unrelated);
    state = readAgentR4State();
    expect(state.assistantPresets[presetId]).toEqual(editedInR4);
  });

  it("uses a valid backup if the primary is corrupt without repairing the old JSON files", () => {
    const workspace = createEmptyAgentWorkspace();
    workspace.conversations[0].title = "backup recovery fixture";
    const source = agentWorkspacePath();
    const primary = Buffer.from("not JSON");
    const backup = Buffer.from(JSON.stringify(workspace));
    fs.writeFileSync(source, primary);
    fs.writeFileSync(`${source}.bak`, backup);

    expect(readAgentWorkspace().conversations[0].title).toBe("backup recovery fixture");
    expect(fs.readFileSync(source)).toEqual(primary);
    expect(fs.readFileSync(`${source}.bak`)).toEqual(backup);
  });

  it("refuses chat deletion while a queued R4 execution retains durable ownership", () => {
    const workspace = readAgentWorkspace();
    const chat = workspace.conversations[0];
    const state = readAgentR4State();
    state.executions.execution = {
      id: "execution",
      conversationId: chat.id,
      creationId: "creation",
      operationKey: "operation",
      submissionKey: "submission",
      userIntentRef: "intent",
      inputRevision: 1,
      inputFingerprint: "fingerprint",
      expectedOutputCount: 1,
      requestGranularity: "per_output",
      providerRef: { providerId: "fixture" },
      approvedInput: {
        inputRevision: 1,
        positivePrompt: "synthetic fixture",
        negativePrompt: "",
        stylePrompt: "",
        publicParameters: {},
        references: [],
      },
      conversationConfig: {
        version: 1,
        providerRef: { providerId: "fixture" },
        modelId: "fixture-model",
        presetId: null,
        enabled: false,
        publicParameters: {},
        capturedAt: EMPTY_STAMP,
        source: "preview",
      },
      status: "queued",
      outputs: [{ outputIndex: 0, status: "not_dispatched" }],
      providerReceiptStatus: "not_applicable",
      providerCancellation: "not_sent",
      receiptRevision: 0,
      pauseReason: "none",
      createdAt: EMPTY_STAMP,
      updatedAt: EMPTY_STAMP,
      events: [],
    };
    getAgentSqlStore().writeR4State(state);
    const beforeWorkspace = readAgentWorkspace();
    const result = deleteAgentConversation(chat.id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("R4 创作、任务或作品记录");
    expect(readAgentWorkspace()).toEqual(beforeWorkspace);
    expect(readAgentR4State().executions.execution.status).toBe("queued");
  });

  it("keeps a draft attachment while any R4 frozen input snapshot still references it", () => {
    const workspace = readAgentWorkspace();
    const chat = workspace.conversations[0];
    const attachmentPath = path.join(fixtureRoot, "attachments", chat.id, "source.png");
    fs.mkdirSync(path.dirname(attachmentPath), { recursive: true });
    fs.writeFileSync(attachmentPath, "synthetic image attachment");
    workspace.conversations[0].draftAttachments.push({
      id: "source-attachment", name: "source.png", mime: "image/png", size: fs.statSync(attachmentPath).size,
      kind: "image", filePath: attachmentPath, fileUrl: `local:${attachmentPath}`, createdAt: EMPTY_STAMP,
    });
    writeAgentWorkspace(workspace);

    const state = readAgentR4State();
    state.preparations.preparation = {
      id: "preparation", conversationId: chat.id, creationId: "creation", inputRevision: 1,
      fingerprint: "fixture", preview: {},
      inputSnapshot: {
        inputRevision: 1, positivePrompt: "", negativePrompt: "", stylePrompt: "", publicParameters: {},
        editSource: { attachmentId: "source-attachment", revision: 1 }, references: [],
      },
      conversationConfig: {
        version: 1, providerRef: { providerId: "fixture" }, modelId: "fixture-model", presetId: null,
        enabled: false, publicParameters: {}, capturedAt: EMPTY_STAMP, source: "preview",
      },
      status: "ready", createdAt: EMPTY_STAMP,
    };
    getAgentSqlStore().writeR4State(state);
    const blocked = deleteAgentAttachment(chat.id, "source-attachment");
    expect(blocked.ok).toBe(false);
    expect(blocked.message).toContain("仍被 R4");
    expect(fs.existsSync(attachmentPath)).toBe(true);
    expect(readAgentWorkspace().conversations[0].draftAttachments).toHaveLength(1);

    state.preparations = {};
    getAgentSqlStore().writeR4State(state);
    const removed = deleteAgentAttachment(chat.id, "source-attachment");
    expect(removed.ok).toBe(true);
    expect(fs.existsSync(attachmentPath)).toBe(false);
  });
});

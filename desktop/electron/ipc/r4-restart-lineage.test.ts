import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentWorkspaceData } from '../../src/agent/types';
import type { R4Artwork, R4ConversationConfigSnapshot, R4ProviderRef } from '../../src/agent/r4-types';
import { AgentSqlStore } from './r4-store';
import { R4CreativeHost, type R4HostScope } from './r4-creative-host';
import { R4ExecutionCoordinator } from './r4-execution-coordinator';
import type { R4ExecutionProvider } from './r4-execution-worker';

const root = path.resolve(process.cwd(), '.tmp', 'r4-restart-lineage');
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0u0AAAAASUVORK5CYII=', 'base64');
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function makeStore(filename: string) {
  const workspace = {
    version: 4,
    conversations: [{ id: 'chat', title: 'Lineage fixture', messages: [], draftAttachments: [] }],
    skills: [], memories: [], characters: [], personas: [], lorebooks: [], samplerPresets: [],
    defaultGenerationMode: 'confirm', updatedAt: '2026-10-18T00:00:00.000Z',
  } as unknown as AgentWorkspaceData;
  return new AgentSqlStore({
    filename,
    legacyFiles: [],
    loadInitialState: () => ({ workspace }),
    normalizeWorkspace: value => structuredClone(value) as AgentWorkspaceData,
  });
}

function fixture(mode: 'per_output' | 'batch') {
  fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, `${mode}-`));
  const filename = path.join(directory, 'agent.sqlite');
  let store = makeStore(filename);
  let serial = 0;
  const requests: Array<{ operation: string; indexes: number[]; kind: string }> = [];
  const errors: unknown[] = [];
  const providerRef: R4ProviderRef = { providerId: mode === 'batch' ? 'openai-images' : 'fixture-image', profileId: 'fixture-profile', revision: 1 };
  const conversationConfig: R4ConversationConfigSnapshot = {
    version: 1, providerRef: { providerId: 'fixture-model' }, modelId: 'fixture-model', presetId: null, enabled: false,
    publicParameters: {}, capturedAt: '2026-10-18T00:00:00.000Z', source: 'preview',
  };

  const hostDependencies = () => ({
    captureConfig: () => structuredClone(conversationConfig),
    resolveAttachment: (_workspace: AgentWorkspaceData, state: ReturnType<AgentSqlStore['readR4State']>, conversationId: string, creationId: string, attachmentId: string) => {
      const artwork = Object.values(state.artworks).find(item => item.attachmentId === attachmentId
        && item.conversationId === conversationId && item.creationId === creationId);
      if (!artwork?.readableHandle || !fs.existsSync(artwork.readableHandle)) throw new Error('fixture attachment unavailable');
      const bytes = fs.readFileSync(artwork.readableHandle);
      return { attachmentId, revision: artwork.revision, hash: hash(bytes), name: artwork.name, mime: artwork.mime, width: artwork.width, height: artwork.height };
    },
    prepare: async (creation: { inputRevision: number; positivePrompt: string; negativePrompt: string; stylePrompt: string; requirements?: string; publicParameters: Record<string, unknown>; editSource?: { attachmentId: string; revision: number; hash?: string } | null; mask?: { attachmentId: string; revision: number; hash?: string } | null; references: any[] }, args: Record<string, unknown>, config: R4ConversationConfigSnapshot) => {
      const operation = String(args.operation ?? 'generate_image');
      const count = Number(args.count ?? 1);
      const imageBudget = mode === 'batch' ? 1 : count;
      const upscaleBudget = operation === 'upscale_image' ? 1 : 0;
      const input = {
        inputRevision: creation.inputRevision,
        positivePrompt: typeof args.positivePrompt === 'string' ? args.positivePrompt : creation.positivePrompt,
        negativePrompt: creation.negativePrompt,
        stylePrompt: creation.stylePrompt,
        requirements: creation.requirements,
        publicParameters: {
          ...structuredClone(creation.publicParameters),
          operation,
          count,
          providerRef: structuredClone(providerRef),
          requestedSeedPolicy: 'random',
          requestedSeed: null,
          requestBudget: { image: operation === 'upscale_image' ? 0 : imageBudget, vibe_encode: 0, upscale: upscaleBudget },
        },
        editSource: structuredClone(creation.editSource ?? null),
        mask: structuredClone(creation.mask ?? null),
        references: structuredClone(creation.references),
        conversationConfig: structuredClone(config),
      };
      return {
        input,
        providerRef: structuredClone(providerRef),
        preview: { positivePrompt: input.positivePrompt, negativePrompt: input.negativePrompt, stylePrompt: input.stylePrompt,
          count, imageProvider: mode === 'batch' ? 'openai-images' : 'novelai', estimateSource: 'local-estimate', estimatedAnlas: 0,
          warning: 'synthetic fixture', requestedSeedPolicy: 'random', requestedSeed: null, resolvedSeed: null, resolvedSeedSource: null },
      };
    },
  });
  const host = () => new R4CreativeHost(store, hostDependencies());
  const provider: R4ExecutionProvider = {
    async submit(execution, outputIndex, context) {
      const operation = String(execution.approvedInput.publicParameters.operation);
      const kind = operation === 'upscale_image' ? 'upscale' : 'image';
      const indexes = outputIndex === null
        ? execution.outputs.filter(item => item.status === 'not_dispatched').map(item => item.outputIndex)
        : [outputIndex];
      await context.beforeSubmit(kind);
      requests.push({ operation, indexes, kind });
      await context.afterReceipt(kind, { status: 'confirmed', requestId: `request-${requests.length}` });
      const outputs: Array<{ outputIndex: number; status: 'completed'; artwork: R4Artwork; providerReceipt: { status: 'confirmed' } }> = [];
      for (const index of indexes) {
        serial += 1;
        const id = `artwork-${serial}`;
        const attachmentId = `attachment-${serial}`;
        const readableHandle = path.join(directory, `${id}.png`);
        fs.writeFileSync(readableHandle, imageBytes);
        const artwork: R4Artwork = {
          id, attachmentId, revision: 1, conversationId: execution.conversationId, creationId: execution.creationId,
          executionId: execution.id, batchId: execution.id, outputIndex: index,
          name: `${id}.png`, mime: 'image/png', url: `fixture://${id}`, readableHandle, hash: hash(imageBytes), width: 1, height: 1,
          ...(execution.approvedInput.editSource ? { parentAttachmentId: execution.approvedInput.editSource.attachmentId } : {}),
          resolvedSeed: null, resolvedSeedSource: null, createdAt: new Date().toISOString(),
        };
        outputs.push({ outputIndex: index, status: 'completed', artwork, providerReceipt: { status: 'confirmed' } });
      }
      return { requestDisposition: 'sent', providerReceiptStatus: 'confirmed', outputs };
    },
  };
  const coordinator = (currentHost: R4CreativeHost) => new R4ExecutionCoordinator(currentHost, provider, error => errors.push(error));
  const reopen = () => { store.close(); store = makeStore(filename); };
  const dispose = () => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); };
  cleanup.push(dispose);
  return { directory, store: () => store, host, provider, coordinator, requests, errors, reopen };
}

function data(result: Record<string, unknown>) { return result.data as Record<string, any>; }
function scope(creationId: string, key: string): R4HostScope {
  return { conversationId: 'chat', creationId, userIntentRef: `intent-${key}`, operationKey: `operation-${key}` };
}
async function settle(coordinator: R4ExecutionCoordinator, store: AgentSqlStore, executionId: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const status = store.readR4State().executions[executionId]?.status;
    if (status === 'completed') return;
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`execution ${executionId} did not complete`);
}

describe('R4 restart and derived-artwork lineage', () => {
  it.each(['per_output', 'batch'] as const)('reopens the durable store and derives redraw then upscale from the exact second output (%s)', async mode => {
    const f = fixture(mode);
    let host = f.host();
    let state = host.read('chat');
    const creationId = state.currentCreationId!;
    const initialScope = scope(creationId, `${mode}-generate`);
    const initialPreview = data(await host.invoke('prepare_generation', { positivePrompt: 'two synthetic images', count: 2 }, initialScope));
    let coordinator = f.coordinator(host);
    const initial = data(coordinator.submit(String(initialPreview.preparationId), String(initialPreview.inputFingerprint), initialScope, true));
    const initialExecutionId = String(initial.executionId);
    await settle(coordinator, f.store(), initialExecutionId);

    const beforeRestart = f.store().readR4State();
    const initialExecution = beforeRestart.executions[initialExecutionId];
    expect(initialExecution.requestGranularity).toBe(mode);
    expect(initialExecution.expectedOutputCount).toBe(2);
    expect(initialExecution.outputs).toHaveLength(2);
    const originalWorks = initialExecution.outputs
      .map(output => output.artwork!).sort((a, b) => a.outputIndex! - b.outputIndex!);
    expect(originalWorks.map(item => [item.id, item.attachmentId, item.outputIndex])).toEqual([
      ['artwork-1', 'attachment-1', 0], ['artwork-2', 'attachment-2', 1],
    ]);
    expect(f.requests.filter(item => item.operation === 'generate_image')).toHaveLength(mode === 'batch' ? 1 : 2);
    expect(beforeRestart.creations[creationId].artworkIds).toEqual(['artwork-1', 'artwork-2']);

    f.reopen();
    host = f.host();
    coordinator = f.coordinator(host);
    state = host.read('chat');
    const afterRestart = f.store().readR4State();
    expect(f.requests.filter(item => item.operation === 'generate_image').flatMap(item => item.indexes)).toEqual([0, 1]);
    expect(f.requests.filter(item => item.operation === 'generate_image')).toHaveLength(mode === 'batch' ? 1 : 2);
    const restored = afterRestart.executions[initialExecutionId].outputs
      .map(output => output.artwork!).sort((a, b) => a.outputIndex! - b.outputIndex!);
    expect(restored.map(item => [item.id, item.attachmentId, item.outputIndex, item.hash])).toEqual(
      originalWorks.map(item => [item.id, item.attachmentId, item.outputIndex, item.hash]),
    );
    expect(restored.map(item => hash(fs.readFileSync(item.readableHandle!)))).toEqual(originalWorks.map(item => item.hash));

    const second = restored.find(item => item.outputIndex === 1)!;
    const selectedScope = scope(creationId, `${mode}-select-second`);
    const selected = await host.command({
      conversationId: 'chat', creationId, type: 'set_edit_source', operationId: selectedScope.operationKey,
      args: { attachmentId: second.attachmentId, attachmentRevision: String(second.revision), expectedInputRevision: 0 },
    });
    expect(selected.ok).toBe(true);

    const redrawScope = scope(creationId, `${mode}-redraw`);
    const redrawPreview = await host.prepare({ operation: 'redraw_image', positivePrompt: 'edit the second output', count: 1 }, redrawScope, true) as Record<string, any>;
    const redrawReceipt = data(coordinator.submit(String(redrawPreview.preparationId), String(redrawPreview.inputFingerprint), redrawScope, true));
    const redrawExecutionId = String(redrawReceipt.executionId);
    await settle(coordinator, f.store(), redrawExecutionId);
    const redrawn = f.store().readR4State().executions[redrawExecutionId].outputs[0].artwork!;
    expect(redrawn.parentAttachmentId).toBe(second.attachmentId);
    expect(redrawn.outputIndex).toBe(0);

    const upscaleScope = scope(creationId, `${mode}-upscale`);
    const rebound = await host.command({
      conversationId: 'chat', creationId, type: 'set_edit_source', operationId: upscaleScope.operationKey,
      args: { attachmentId: redrawn.attachmentId, attachmentRevision: String(redrawn.revision), expectedInputRevision: 1 },
    });
    expect(rebound.ok).toBe(true);
    const upscalePreview = await host.prepare({ operation: 'upscale_image', count: 1, scale: 2 }, upscaleScope, true) as Record<string, any>;
    const upscaleReceipt = data(coordinator.submit(String(upscalePreview.preparationId), String(upscalePreview.inputFingerprint), upscaleScope, true));
    const upscaleExecutionId = String(upscaleReceipt.executionId);
    await settle(coordinator, f.store(), upscaleExecutionId);
    const upscaled = f.store().readR4State().executions[upscaleExecutionId].outputs[0].artwork!;
    expect(upscaled.parentAttachmentId).toBe(redrawn.attachmentId);

    const finalState = f.store().readR4State();
    expect(finalState.artworks[originalWorks[0].id]).toMatchObject({ attachmentId: originalWorks[0].attachmentId, hash: originalWorks[0].hash, outputIndex: 0 });
    expect(finalState.artworks[second.id]).toMatchObject({ attachmentId: second.attachmentId, hash: second.hash, outputIndex: 1 });
    expect(finalState.creations[creationId].artworkIds).toEqual(['artwork-1', 'artwork-2', redrawn.id, upscaled.id]);
    expect(Object.values(finalState.executions).map(item => item.status)).toEqual(['completed', 'completed', 'completed']);
    expect(Object.values(finalState.executions).map(item => item.expectedOutputCount)).toEqual([2, 1, 1]);
    expect(Object.values(finalState.executions).reduce((sum, item) => sum + item.outputs.length, 0)).toBe(4);
    expect(Object.values(finalState.artworks)).toHaveLength(4);
    expect(f.requests).toHaveLength(mode === 'batch' ? 3 : 4);
    expect(f.requests.reduce((sum, item) => sum + item.indexes.length, 0)).toBe(4);
    expect(f.requests.some(item => item.operation === 'redraw_image' && item.indexes.length === 1)).toBe(true);
    expect(f.requests.some(item => item.operation === 'upscale_image' && item.kind === 'upscale')).toBe(true);
    expect(f.errors).toEqual([]);
  });
});

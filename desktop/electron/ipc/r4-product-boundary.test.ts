import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import fixtureDocument from '../../../docs/agent-refactor-v3.2-r4-final/schema-fixtures/fixtures.json';
import {
  registry, R4_TOOL_NAMES, r4Tool, validateR4Input, validateR4Result,
  type R4ToolDefinition, type R4ToolName,
} from '../../src/agent/r4-contracts';
import { createEmptyR4AgentState, type R4Artwork, type R4ConversationConfigSnapshot, type R4Execution } from '../../src/agent/r4-types';
import type { AgentWorkspaceData } from '../../src/agent/types';
import { R4CreativeHost, type R4HostScope } from './r4-creative-host';
import { AgentSqlStore } from './r4-store';
import { R4ExecutionWorker, type R4ExecutionProvider } from './r4-execution-worker';
import { createR4PiToolSession, type R4PiToolSessionOptions } from './r4-pi-tools';

const mocks = vi.hoisted(() => ({ executeAgentTool: vi.fn() }));
vi.mock('./agent-tools', () => ({ executeAgentTool: mocks.executeAgentTool }));

type Fixture = { id: string; tool: string; target: 'input' | 'result'; valid: boolean; instance: unknown };
const inputFixtures = [
  ...(fixtureDocument as { fixtures: Fixture[] }).fixtures.filter(item => item.target === 'input' && item.valid),
  { id: 'synthetic-write-workbench-prompts-valid', tool: 'write_workbench_prompts', target: 'input', valid: true,
    instance: { positivePrompt: 'synthetic writer fixture', expectedDraftRevision: 0 } } as Fixture,
  { id: 'synthetic-write-workbench-parameters-valid', tool: 'write_workbench_parameters', target: 'input', valid: true,
    instance: { expectedDraftRevision: 0, patch: { strength: 0.5 } } } as Fixture,
];
const root = path.resolve(process.cwd(), '.tmp', 'r4-product-boundary-tests');
const cleanup: Array<() => void> = [];

const config: R4ConversationConfigSnapshot = {
  version: 1, providerRef: { providerId: 'fixture' }, modelId: 'fixture-model', presetId: null,
  enabled: false, publicParameters: {}, capturedAt: '2026-10-18T00:00:00.000Z', source: 'preview',
};

function workspace(): AgentWorkspaceData {
  return {
    version: 4, conversations: [{ id: 'chat', title: 'Synthetic', messages: [], draftAttachments: [] }],
    skills: [], memories: [], characters: [], personas: [], lorebooks: [], samplerPresets: [],
    defaultGenerationMode: 'confirm', updatedAt: '2026-10-18T00:00:00.000Z',
  } as unknown as AgentWorkspaceData;
}

function openStore(directory: string) {
  return new AgentSqlStore({
    filename: path.join(directory, 'agent.sqlite'), legacyFiles: [],
    loadInitialState: () => ({ workspace: workspace(), r4State: createEmptyR4AgentState() }),
    normalizeWorkspace: value => structuredClone(value) as AgentWorkspaceData,
  });
}

function sqlFixture() {
  fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, 'case-'));
  const subpath = path.relative(root, directory);
  if (!subpath || subpath.startsWith('..')) throw new Error('Unsafe R4 product boundary fixture path.');
  const stores = new Set<AgentSqlStore>();
  const trackStore = (store: AgentSqlStore) => { stores.add(store); return store; };
  const closeStore = (store: AgentSqlStore) => { if (stores.delete(store)) store.close(); };
  const store = trackStore(openStore(directory));
  cleanup.push(() => {
    for (const currentStore of [...stores].reverse()) closeStore(currentStore);
    const current = path.relative(root, path.resolve(directory));
    if (!current || current.startsWith('..')) throw new Error('Refuse cleanup outside R4 product boundary fixtures.');
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, store, trackStore, closeStore };
}

type Schema = Record<string, any>;
type PathPart = string | number;
type Candidate = { kind: 'unknown_field' | 'missing_required' | 'wrong_type' | 'enum' | 'range'; input: unknown };

function valueAt(value: unknown, parts: PathPart[]): unknown {
  let current = value;
  for (const part of parts) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<PathPart, unknown>)[part];
  }
  return current;
}

function mutateAt(value: unknown, parts: PathPart[], replacement: unknown, remove = false): unknown {
  if (!parts.length) return replacement;
  const copy = structuredClone(value) as Record<PathPart, unknown>;
  let current = copy;
  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    if (!next || typeof next !== 'object') return value;
    current[part] = structuredClone(next);
    current = current[part] as Record<PathPart, unknown>;
  }
  const final = parts.at(-1)!;
  if (remove) delete current[final];
  else current[final] = replacement;
  return copy;
}

function schemaNodes(schema: Schema, base: unknown, parts: PathPart[] = [], seen = new Set<object>()): Array<{ schema: Schema; parts: PathPart[] }> {
  if (!schema || typeof schema !== 'object' || seen.has(schema)) return [];
  seen.add(schema);
  const nodes = [{ schema, parts }];
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    nodes.push(...schemaNodes(child as Schema, valueAt(base, [...parts, key]), [...parts, key], seen));
  }
  for (const keyword of ['items', 'contains']) {
    const child = schema[keyword];
    if (child && typeof child === 'object') {
      const value = valueAt(base, parts);
      if (Array.isArray(value) && value.length) nodes.push(...schemaNodes(child as Schema, value[0], [...parts, 0], seen));
      else nodes.push(...schemaNodes(child as Schema, undefined, [...parts, 0], seen));
    }
  }
  for (const keyword of ['anyOf', 'oneOf', 'allOf', 'if', 'then', 'else', 'not']) {
    const child = schema[keyword];
    if (Array.isArray(child)) child.forEach(item => nodes.push(...schemaNodes(item as Schema, valueAt(base, parts), parts, seen)));
    else if (child && typeof child === 'object') nodes.push(...schemaNodes(child as Schema, valueAt(base, parts), parts, seen));
  }
  return nodes;
}

function requiredPaths(schema: Schema, base: unknown, parts: PathPart[] = [], seen = new Set<object>()): PathPart[][] {
  if (!schema || typeof schema !== 'object' || seen.has(schema)) return [];
  seen.add(schema);
  const result: PathPart[][] = (schema.required ?? [])
    .filter((key: unknown): key is string => typeof key === 'string')
    .map((key: string) => [...parts, key]);
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    result.push(...requiredPaths(child as Schema, valueAt(base, [...parts, key]), [...parts, key], seen));
  }
  const current = valueAt(base, parts);
  if (schema.items && typeof schema.items === 'object') {
    result.push(...requiredPaths(schema.items, Array.isArray(current) ? current[0] : undefined, [...parts, 0], seen));
  }
  for (const keyword of ['anyOf', 'oneOf', 'allOf', 'if', 'then', 'else']) {
    const child = schema[keyword];
    if (Array.isArray(child)) child.forEach(item => result.push(...requiredPaths(item as Schema, current, parts, seen)));
    else if (child && typeof child === 'object') result.push(...requiredPaths(child as Schema, current, parts, seen));
  }
  return result;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function invalidCandidates(definition: R4ToolDefinition, validInput: unknown): Candidate[] {
  if (!isObject(validInput)) throw new Error(`${definition.canonical} fixture is not an object.`);
  const candidates: Candidate[] = [
    { kind: 'unknown_field', input: { ...structuredClone(validInput), __r4_unexpected_field__: true } },
    { kind: 'wrong_type', input: null },
  ];
  for (const parts of requiredPaths(definition.inputSchema as Schema, validInput)) {
    if (parts.length && valueAt(validInput, parts) !== undefined) {
      candidates.push({ kind: 'missing_required', input: mutateAt(validInput, parts, undefined, true) });
    }
  }
  const nodes = schemaNodes(definition.inputSchema as Schema, validInput);
  for (const node of nodes) {
    const value = valueAt(validInput, node.parts);
    const typeList = Array.isArray(node.schema.type) ? node.schema.type : node.schema.type ? [node.schema.type] : [];
    if (node.parts.length && node.parts.at(-1) !== 0) {
      let wrong: unknown = null;
      if (typeList.includes('string') || node.schema.enum?.some((item: unknown) => typeof item === 'string')) wrong = 47;
      else if (typeList.includes('integer') || typeList.includes('number')) wrong = 'not-a-number';
      else if (typeList.includes('object')) wrong = 47;
      else if (typeList.includes('array')) wrong = 47;
      else if (typeList.includes('boolean')) wrong = 'not-a-boolean';
      candidates.push({ kind: 'wrong_type', input: mutateAt(validInput, node.parts, wrong) });
    }
    if (node.parts.length && Array.isArray(node.schema.enum) && node.schema.enum.length) {
      const invalidEnum = node.schema.enum.some((item: unknown) => typeof item === 'string')
        ? '__r4_invalid_enum__' : null;
      candidates.push({ kind: 'enum', input: mutateAt(validInput, node.parts, invalidEnum) });
    }
    if (!node.parts.length) continue;
    if (typeof value === 'number') {
      if (typeof node.schema.minimum === 'number') candidates.push({ kind: 'range', input: mutateAt(validInput, node.parts, node.schema.minimum - 1) });
      if (typeof node.schema.maximum === 'number') candidates.push({ kind: 'range', input: mutateAt(validInput, node.parts, node.schema.maximum + 1) });
      if (typeof node.schema.exclusiveMinimum === 'number') candidates.push({ kind: 'range', input: mutateAt(validInput, node.parts, node.schema.exclusiveMinimum) });
      if (typeof node.schema.exclusiveMaximum === 'number') candidates.push({ kind: 'range', input: mutateAt(validInput, node.parts, node.schema.exclusiveMaximum) });
    } else if (typeof value === 'string') {
      if (typeof node.schema.minLength === 'number' && node.schema.minLength > 0) candidates.push({ kind: 'range', input: mutateAt(validInput, node.parts, '') });
      if (typeof node.schema.maxLength === 'number') candidates.push({ kind: 'range', input: mutateAt(validInput, node.parts, 'x'.repeat(node.schema.maxLength + 1)) });
    } else if (Array.isArray(value)) {
      if (typeof node.schema.minItems === 'number' && node.schema.minItems > 0) candidates.push({ kind: 'range', input: mutateAt(validInput, node.parts, []) });
      if (typeof node.schema.maxItems === 'number') {
        const item = value[0] === undefined ? null : value[0];
        candidates.push({ kind: 'range', input: mutateAt(validInput, node.parts, Array.from({ length: node.schema.maxItems + 1 }, () => structuredClone(item))) });
      }
    } else if (isObject(value)) {
      if (typeof node.schema.minProperties === 'number' && node.schema.minProperties > 0) candidates.push({ kind: 'range', input: mutateAt(validInput, node.parts, {}) });
      if (typeof node.schema.maxProperties === 'number') {
        const oversized = { ...value } as Record<string, unknown>;
        for (let index = 0; Object.keys(oversized).length <= node.schema.maxProperties; index += 1) oversized[`__range_${index}__`] = true;
        candidates.push({ kind: 'range', input: mutateAt(validInput, node.parts, oversized) });
      }
    }
  }
  const selected = new Map<Candidate['kind'], Candidate>();
  for (const candidate of candidates) {
    if (!selected.has(candidate.kind) && !validateR4Input(definition.canonical, candidate.input).valid) selected.set(candidate.kind, candidate);
  }
  return [...selected.values()];
}

function capabilitySnapshot() {
  const groups = new Map<string, string[]>();
  for (const tool of registry.tools) {
    const names = groups.get(tool.availability.group) ?? [];
    names.push(tool.canonical);
    groups.set(tool.availability.group, names);
  }
  return {
    catalogStatus: 'ok' as const, catalogVersion: 'r4-product-boundary-fixture', approvalMode: 'confirm' as const,
    available: [...groups].map(([group, toolNames]) => ({ group, toolNames, capabilityKeys: [`${group}.fixture`] })),
    mounted: [...R4_TOOL_NAMES], requestedGroups: [], requestedDenied: [], providerProjectionStatus: 'host_only' as const,
  };
}

function hostFixture(store: AgentSqlStore) {
  const prepare = vi.fn(async (creation: any, args: Record<string, unknown>, conversationConfig: R4ConversationConfigSnapshot) => {
    const positivePrompt=String(args.positivePrompt??'live workbench prompt');
    const preview={positivePrompt,negativePrompt:'',stylePrompt:'',count:1,imageProvider:'novelai',estimateSource:'provider-unknown',warning:'Synthetic host preview.',
      requestedSeedPolicy:'random',requestedSeed:null,resolvedSeed:null,resolvedSeedSource:null,sourceAttachmentIds:[],sourceAttachments:[]};
    return {
    input: { inputRevision: creation.inputRevision, positivePrompt, negativePrompt: '', stylePrompt: '', publicParameters: {}, references: [], conversationConfig },
    preview,
    providerRef: { providerId: 'fixture-image-provider' },
  };});
  const host = new R4CreativeHost(store, {
    captureConfig: () => structuredClone(config),
    resolveAttachment: (_workspace, _state, _conversationId, _creationId, attachmentId) => ({ attachmentId, revision: 1, hash: 'a'.repeat(64) }),
    prepare,
  });
  const current = host.read('chat');
  return { host, prepare, creationId: current.currentCreationId! };
}

function piSessionOptions(host: R4CreativeHost, store: AgentSqlStore, creationId: string) {
  const scope: R4HostScope = { conversationId: 'chat', creationId, userIntentRef: 'intent-fixture', operationKey: 'op-fixture', messageId: 'message-fixture' };
  const hostInvoke = vi.spyOn(host, 'invoke');
  const authorize = vi.fn(async () => true);
  const assertNoDispatchGate = vi.fn();
  const adapterDependencies = vi.fn(() => ({}));
  const prepareImageOperation = vi.fn(async () => ({ preparationId: 'never-used', fingerprint: 'never-used' }));
  const runPaidLegacy = vi.fn(async (_name: R4ToolName, _args: Record<string, unknown>, _scope: R4HostScope, run: () => Promise<any>) => run());
  const applyPrompt = vi.fn(async () => ({}));
  const writeWorkbenchPrompts = vi.fn(async (_args:Record<string,unknown>,scope:R4HostScope) => ({resultKind:'business',status:'completed',conversationId:scope.conversationId,
    creationId:scope.creationId,data:{writeStatus:'unchanged',draftId:'fixture-draft',draftRevision:0,changedFields:{positivePromptChanged:false,negativePromptChanged:false,stylePromptChanged:false}}}));
  const writeWorkbenchParameters = vi.fn(async (_args:Record<string,unknown>,scope:R4HostScope) => ({resultKind:'business',status:'completed',conversationId:scope.conversationId,
    creationId:scope.creationId,data:{writeStatus:'unchanged',draftId:'fixture-draft',draftRevision:0,changedFields:[],parameters:{}}}));
  const askQuestion = vi.fn(async () => ({ cancelled: true, answers: [] }) as any);
  const readSkill = vi.fn(() => ({ id: 'skill-fixture', content: 'fixture' }));
  const readPromptingReference = vi.fn(async () => ({ content: 'fixture', source: 'fixture', version: 'fixture' }));
  const coordinator = { get: vi.fn(), submit: vi.fn(), cancel: vi.fn() } as unknown as R4PiToolSessionOptions['coordinator'];
  const options: R4PiToolSessionOptions = {
    host, coordinator, scope, emit: vi.fn(), authorize, assertNoDispatchGate,
    capabilitySnapshot, initialMounted: [...R4_TOOL_NAMES], approvalMode: 'confirm', webSearchEnabled: true,
    legacySessionId: 'chat', adapterDependencies, runPaidLegacy,
    askQuestion,
    skillDirectory: [{ id: 'skill-fixture', name: 'Fixture', description: 'Synthetic test capability.' }],
    readSkill, readPromptingReference,
    promptingReferenceEnabled: true, applyPrompt, writeWorkbenchPrompts, writeWorkbenchParameters, prepareImageOperation,
  };
  return { options, scope, hostInvoke, authorize, assertNoDispatchGate, adapterDependencies, prepareImageOperation, runPaidLegacy, coordinator,
    applyPrompt, writeWorkbenchPrompts, writeWorkbenchParameters, askQuestion, readSkill, readPromptingReference };
}

describe('R4 real product boundary regression', () => {
  afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

  it('routes generated malformed variants for all 38 tools through Pi preflight with zero side effects', async () => {
    const { store } = sqlFixture();
    const { host, creationId } = hostFixture(store);
    const setup = piSessionOptions(host, store, creationId);
    const session = createR4PiToolSession(setup.options);
    const byTool = new Map<R4ToolName, Fixture>();
    for (const item of inputFixtures) if (!byTool.has(item.tool as R4ToolName)) byTool.set(item.tool as R4ToolName, item);
    expect([...byTool.keys()].sort()).toEqual([...R4_TOOL_NAMES].sort());

    const counts = new Map<Candidate['kind'], number>();
    const categoriesByTool = new Map<R4ToolName, Set<Candidate['kind']>>();
    const beforeState = store.readR4State();
    const beforeWorkspace = store.readWorkspace();
    const testCases: Array<{ tool: R4ToolName; fixture: Fixture; candidate: Candidate }> = [];
    for (const name of R4_TOOL_NAMES) {
      const definition = r4Tool(name)!;
      const fixture = byTool.get(name)!;
      const variants = invalidCandidates(definition, fixture.instance);
      const kinds = new Set(variants.map(item => item.kind));
      categoriesByTool.set(name, kinds);
      expect(kinds.has('unknown_field'), `${name}: unknown field`).toBe(true);
      expect(kinds.has('wrong_type'), `${name}: wrong type`).toBe(true);
      if ((definition.inputSchema as Schema).required?.length) {
        expect(kinds.has('missing_required'), `${name}: missing required`).toBe(true);
      }
      const activeNodes = schemaNodes(definition.inputSchema as Schema, fixture.instance)
        .filter(node => node.parts.length && valueAt(fixture.instance, node.parts) !== undefined);
      if (activeNodes.some(node => Array.isArray(node.schema.enum))) {
        expect(kinds.has('enum'), `${name}: applicable enum`).toBe(true);
      }
      if (activeNodes.some(node => typeof valueAt(fixture.instance, node.parts) === 'number'
        ? ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'].some(key => typeof node.schema[key] === 'number')
        : typeof valueAt(fixture.instance, node.parts) === 'string'
          ? typeof node.schema.minLength === 'number' || typeof node.schema.maxLength === 'number'
          : Array.isArray(valueAt(fixture.instance, node.parts))
            ? typeof node.schema.minItems === 'number' || typeof node.schema.maxItems === 'number'
            : isObject(valueAt(fixture.instance, node.parts))
              ? typeof node.schema.minProperties === 'number' || typeof node.schema.maxProperties === 'number' : false)) {
        expect(kinds.has('range'), `${name}: applicable range`).toBe(true);
      }
      testCases.push(...variants.map(candidate => ({ tool: name, fixture, candidate })));
    }
    expect(testCases.length).toBeGreaterThan(38 * 2);

    for (const { tool: name, candidate } of testCases) {
      const mounted = session.getTools().find(item => item.name === name);
      expect(mounted, `${name} must be mounted for a product preflight test`).toBeDefined();
      const result = await mounted!.execute(candidate.input as Record<string, unknown>, new AbortController().signal);
      const canonical = JSON.parse(result.output);
      expect(validateR4Result(name, canonical).valid, `${name}/${candidate.kind} canonical result`).toBe(true);
      expect(canonical.resultKind, `${name}/${candidate.kind}`).toBe('preflight_failure');
      expect(setup.authorize, `${name}/${candidate.kind} authorize`).not.toHaveBeenCalled();
      expect(setup.hostInvoke, `${name}/${candidate.kind} host`).not.toHaveBeenCalled();
      expect(mocks.executeAgentTool, `${name}/${candidate.kind} legacy`).not.toHaveBeenCalled();
      expect(setup.adapterDependencies, `${name}/${candidate.kind} dependency capture`).not.toHaveBeenCalled();
      expect(setup.assertNoDispatchGate, `${name}/${candidate.kind} gate`).not.toHaveBeenCalled();
      expect(setup.prepareImageOperation, `${name}/${candidate.kind} preview`).not.toHaveBeenCalled();
      expect(setup.coordinator.submit, `${name}/${candidate.kind} queue`).not.toHaveBeenCalled();
      expect(setup.runPaidLegacy, `${name}/${candidate.kind} paid`).not.toHaveBeenCalled();
      expect(setup.applyPrompt, `${name}/${candidate.kind} workbench apply`).not.toHaveBeenCalled();
      expect(setup.writeWorkbenchPrompts, `${name}/${candidate.kind} direct workbench write`).not.toHaveBeenCalled();
      expect(setup.writeWorkbenchParameters, `${name}/${candidate.kind} workbench parameter write`).not.toHaveBeenCalled();
      expect(setup.askQuestion, `${name}/${candidate.kind} question`).not.toHaveBeenCalled();
      expect(setup.readSkill, `${name}/${candidate.kind} skill read`).not.toHaveBeenCalled();
      expect(setup.readPromptingReference, `${name}/${candidate.kind} reference read`).not.toHaveBeenCalled();
      counts.set(candidate.kind, (counts.get(candidate.kind) ?? 0) + 1);
    }
    expect(store.readR4State()).toEqual(beforeState);
    expect(store.readWorkspace()).toEqual(beforeWorkspace);
    expect(Object.fromEntries(counts)).toMatchObject({ unknown_field: 38, wrong_type: 38 });
    // These are the tools whose frozen schemas actually declare required fields.
    expect(counts.get('missing_required')).toBeGreaterThan(0);
    expect(counts.get('enum')).toBeGreaterThan(0);
    expect(counts.get('range')).toBeGreaterThan(0);
  });

  it('rejects prepare_generation with a proposal and direct prompt together before preparation is written', async () => {
    const { store } = sqlFixture();
    const { host, prepare, creationId } = hostFixture(store);
    const proposal = await host.invoke('propose_prompt', { positivePrompt: 'synthetic proposal' }, {
      conversationId: 'chat', creationId, userIntentRef: 'intent-proposal', operationKey: 'proposal-op',
    });
    const proposalId = String((proposal.data as Record<string, unknown>).proposalId);
    const before = store.readR4State();
    const beforeWorkspace = store.readWorkspace();
    const args = { proposalId, revision: 1, positivePrompt: 'synthetic direct prompt' };
    expect(validateR4Input('prepare_generation', args).valid).toBe(false);
    const result = await host.invoke('prepare_generation', args, {
      conversationId: 'chat', creationId, userIntentRef: 'intent-prepare', operationKey: 'prepare-both',
    });
    expect(validateR4Result('prepare_generation', result).valid).toBe(true);
    expect(result).toMatchObject({ resultKind: 'preflight_failure', status: 'error' });
    expect(prepare).not.toHaveBeenCalled();
    expect(Object.keys(store.readR4State().preparations)).toEqual(Object.keys(before.preparations));
    expect(store.readR4State()).toEqual(before);
    expect(store.readWorkspace()).toEqual(beforeWorkspace);
  });

  it('accepts prepare_generation with empty args so the host can use its fresh live-workbench snapshot', async () => {
    const { store } = sqlFixture();
    const { host, prepare, creationId } = hostFixture(store);
    expect(validateR4Input('prepare_generation', {}).valid).toBe(true);
    const result = await host.invoke('prepare_generation', {}, {
      conversationId: 'chat', creationId, userIntentRef: 'intent-prepare-empty', operationKey: 'prepare-empty',
    });
    expect(validateR4Result('prepare_generation', result).valid).toBe(true);
    expect(result).toMatchObject({ resultKind: 'business', status: 'completed', data: { preparationStatus: 'prepared' } });
    expect(prepare).toHaveBeenCalledOnce();
    expect(prepare.mock.calls[0][1]).toEqual({});
  });

  it.each(['completed', 'error', 'blocked', 'denied'] as const)(
    'rejects persisted %s aggregate hiding a pending slot without changing artifact hashes or worker counters', async invalidStatus => {
      const sql = sqlFixture();
      const { directory } = sql;
      const initialStore = sql.store;
      let store = initialStore;
      const { host, creationId } = hostFixture(store);
      const timestamp = '2026-10-18T00:00:00.000Z';
      const artwork: R4Artwork = {
        id: 'artifact-1', attachmentId: 'attachment-1', revision: 1, conversationId: 'chat', creationId,
        executionId: 'execution-1', outputIndex: 0, name: 'fixture.png', mime: 'image/png',
        readableHandle: 'fixture-handle', hash: 'b'.repeat(64), createdAt: timestamp,
      };
      const validExecution: R4Execution = {
        id: 'execution-1', conversationId: 'chat', creationId, operationKey: 'operation-1', submissionKey: 'submission-1',
        userIntentRef: 'intent-1', inputRevision: 0, inputFingerprint: 'fingerprint-1', expectedOutputCount: 1,
        requestGranularity: 'per_output', providerRef: { providerId: 'fixture' },
        approvedInput: { inputRevision: 0, positivePrompt: 'fixture', negativePrompt: '', stylePrompt: '',
          publicParameters: { requestedSeedPolicy: 'random', requestedSeed: null, requestBudget: { image: 1, vibe_encode: 0, upscale: 0 } }, references: [] },
        conversationConfig: structuredClone(config), status: 'completed', outputs: [{ outputIndex: 0, status: 'completed', artwork,
          providerReceipt: { status: 'confirmed', receivedAt: timestamp } }], providerReceiptStatus: 'confirmed',
        providerCancellation: 'not_sent', receiptRevision: 1, pauseReason: 'none', createdAt: timestamp, updatedAt: timestamp, events: [],
      };
      store.transaction(tx => {
        const state = tx.getR4State();
        state.creations[creationId].artworkIds.push(artwork.id);
        state.artworks[artwork.id] = artwork;
        state.executions[validExecution.id] = validExecution;
        tx.setR4State(state);
      });
      const before = store.readR4State();
      const expectedHash = store.readR4State().artworks[artwork.id].hash;

      const corrupted = structuredClone(validExecution);
      corrupted.status = invalidStatus;
      corrupted.expectedOutputCount = 2;
      corrupted.providerReceiptStatus = 'pending';
      corrupted.outputs = [
        { outputIndex: 0, status: 'completed', artwork: structuredClone(artwork), providerReceipt: { status: 'confirmed', receivedAt: timestamp } },
        { outputIndex: 1, status: 'pending', providerReceipt: { status: 'pending', receivedAt: timestamp } },
      ];
      if (invalidStatus === 'blocked') corrupted.blockedReason = 'fixture-gate';
      expect(() => store.transaction(tx => {
        const state = tx.getR4State();
        state.executions[corrupted.id] = corrupted;
        tx.setR4State(state);
      })).toThrow(/语义|pending|in.fight|Execution/i);
      expect(store.readR4State()).toEqual(before);
      expect(store.readR4State().artworks[artwork.id].hash).toBe(expectedHash);

      sql.closeStore(store);
      store = sql.trackStore(openStore(directory));
      const provider: R4ExecutionProvider = { submit: vi.fn(async () => { throw new Error('provider must not be called'); }) };
      const worker = new R4ExecutionWorker(store, provider);
      worker.recover();
      await worker.kick();
      const reopened = store.readR4State();
      expect(reopened).toEqual(before);
      expect(reopened.artworks[artwork.id].hash).toBe(expectedHash);
      expect(reopened.executions['execution-1'].events.filter(event => event.kind === 'queue_claim')).toHaveLength(0);
      expect(provider.submit).not.toHaveBeenCalled();
    },
  );
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registry, validateR4Result } from '../../src/agent/r4-contracts';
import type { R4LegacyCapabilitySnapshot } from '../../src/agent/r4-legacy-adapter';
import { createR4PiToolSession, type R4PiToolSessionOptions } from './r4-pi-tools';

const mocks = vi.hoisted(() => ({ executeAgentTool: vi.fn() }));
vi.mock('./agent-tools', () => ({ executeAgentTool: mocks.executeAgentTool }));

const scope = {
  conversationId: 'chat-1', creationId: 'creation-1', userIntentRef: 'intent-1',
  operationKey: 'operation-1', messageId: 'message-1',
};

function snapshot(mounted: string[] = ['get_capabilities']): R4LegacyCapabilitySnapshot {
  const groups = new Map<string, string[]>();
  for (const tool of registry.tools) {
    const names = groups.get(tool.availability.group) ?? [];
    names.push(tool.canonical);
    groups.set(tool.availability.group, names);
  }
  return {
    catalogStatus: 'ok', catalogVersion: 'r4-test', approvalMode: 'confirm',
    available: [...groups].map(([group, toolNames]) => ({ group, toolNames, capabilityKeys: [`${group}.read`] })),
    mounted, requestedGroups: [], requestedDenied: [], providerProjectionStatus: 'host_only',
  };
}

function enqueueReceipt() {
  return {
    resultKind: 'business', status: 'accepted', conversationId: scope.conversationId,
    creationId: scope.creationId,
    data: { submissionStatus: 'accepted', executionId: 'execution-1', executionStatus: 'queued',
      inputFingerprint: 'fingerprint-1', acceptedAt: '2026-10-18T00:00:00.000Z' },
  };
}

function options(patch: Partial<R4PiToolSessionOptions> = {}): R4PiToolSessionOptions {
  const state = { preparations: {} as Record<string, unknown> };
  return {
    host: {
      invoke: vi.fn(async (name: string) => ({
        resultKind: 'business', status: 'completed', conversationId: scope.conversationId,
        creationId: scope.creationId,
        data: name === 'read_creation' ? {
          readStatus: 'ok', conversationId: scope.conversationId, creationId: scope.creationId,
          currentProposalRef: null, selectionRevision: 0, draftId: scope.creationId, draftRevision: 0,
          inputRevision: 0, references: [], proposals: [], activeExecutionIds: [],
        } : {},
      })),
      store: { readR4State: () => state },
    } as unknown as R4PiToolSessionOptions['host'],
    coordinator: {
      get: vi.fn(), cancel: vi.fn(), submit: vi.fn(async () => enqueueReceipt()),
    } as unknown as R4PiToolSessionOptions['coordinator'],
    scope,
    emit: vi.fn(), authorize: vi.fn(async () => true),
    assertNoDispatchGate: vi.fn(),
    capabilitySnapshot: () => snapshot(),
    approvalMode: 'confirm', webSearchEnabled: false,
    adapterDependencies: () => ({ workbenchSnapshot: { draftId: 'draft-1', draftRevision: 4, inputRevision: 2 } }),
    ...patch,
  };
}

function getTool(session: ReturnType<typeof createR4PiToolSession>, name: string) {
  const tool = session.getTools().find(item => item.name === name);
  if (!tool) throw new Error(`${name} was not mounted`);
  return tool;
}

describe('R4 Pi tool session', () => {
  beforeEach(() => mocks.executeAgentTool.mockReset());

  it('starts with only mounted tools and mounts a requested, available group for the next call', async () => {
    const session = createR4PiToolSession(options({
      capabilitySnapshot: () => snapshot(['get_capabilities']),
      initialMounted: ['get_capabilities'],
    }));
    expect(session.mountedTools()).toEqual(['get_capabilities']);
    const result = await getTool(session, 'get_capabilities').execute({ requestedGroups: ['tags'] }, new AbortController().signal);
    const receipt = JSON.parse(result.output);
    expect(validateR4Result('get_capabilities', receipt).valid).toBe(true);
    expect(receipt.data.mounted).toContain('search_tags');
    expect(session.mountedTools()).toContain('search_tags');
  });

  it('rejects malformed canonical arguments before a host, legacy handler or authorization runs', async () => {
    const setup = options({ initialMounted: ['read_creation'] });
    const session = createR4PiToolSession(setup);
    const tool = getTool(session, 'read_creation');
    const result = await tool.execute({ unexpected: 'field' }, new AbortController().signal);
    const parsed = JSON.parse(result.output);
    expect(validateR4Result('read_creation', parsed).valid).toBe(true);
    expect(parsed).toMatchObject({ resultKind: 'preflight_failure', status: 'error' });
    expect(setup.host.invoke).not.toHaveBeenCalled();
    expect(mocks.executeAgentTool).not.toHaveBeenCalled();
    expect(setup.authorize).not.toHaveBeenCalled();
  });

  it('rejects a direct image target outside the frozen message scope before preview, consent, or enqueue', async () => {
    const setup = options({
      initialMounted: ['redraw_image'],
      capabilitySnapshot: () => snapshot(['get_capabilities', 'redraw_image']),
      prepareImageOperation: vi.fn(async () => ({ preparationId: 'should-not-prepare', fingerprint: 'unused' })),
    });
    const result = await getTool(createR4PiToolSession(setup), 'redraw_image').execute({
      attachmentId: 'source-1', positivePrompt: 'synthetic target mismatch',
      targetConversationId: 'another-chat', targetCreationId: scope.creationId,
    }, new AbortController().signal);
    const canonical = JSON.parse(result.output);

    expect(validateR4Result('redraw_image', canonical).valid).toBe(true);
    expect(canonical).toMatchObject({ resultKind: 'preflight_failure', status: 'blocked', error: { code: 'context_mismatch' } });
    expect(setup.prepareImageOperation).not.toHaveBeenCalled();
    expect(setup.authorize).not.toHaveBeenCalled();
    expect(setup.coordinator.submit).not.toHaveBeenCalled();
    expect(mocks.executeAgentTool).not.toHaveBeenCalled();
  });

  it.each([
    ['propose_memory', { trigger: 'synthetic trigger', content: 'synthetic memory', targetConversationId: 'another-chat' }],
    ['manage_prompt_templates', {
      action: 'save', kind: 'assistant', modelVersion: 'v5', expectedRevision: 'revision-1', body: 'synthetic body',
      targetCreationId: 'another-creation',
    }],
  ] as const)('%s rejects unsupported target fields before authorization or its legacy handler', async (name, args) => {
    const setup = options({
      initialMounted: [name],
      capabilitySnapshot: () => snapshot(['get_capabilities', name]),
    });
    const result = await getTool(createR4PiToolSession(setup), name).execute(args, new AbortController().signal);
    const canonical = JSON.parse(result.output);

    // These frozen registry schemas intentionally expose no target fields for
    // the legacy tools; they must fail closed instead of silently stripping a
    // mismatched target and applying the request to the current conversation.
    expect(validateR4Result(name, canonical).valid).toBe(true);
    expect(canonical).toMatchObject({ resultKind: 'preflight_failure', error: { code: 'invalid_arguments' } });
    expect(setup.authorize).not.toHaveBeenCalled();
    expect(mocks.executeAgentTool).not.toHaveBeenCalled();
  });

  it('returns a canonical preflight result when a mounted capability is revoked before execution', async () => {
    let enabled = true;
    const setup = options({
      initialMounted: ['read_creation'],
      capabilitySnapshot: () => ({ ...snapshot(['get_capabilities', ...(enabled ? ['read_creation'] : [])]),
        available: enabled ? snapshot(['read_creation']).available : [] }),
    });
    const session = createR4PiToolSession(setup);
    const tool = getTool(session, 'read_creation');
    enabled = false;
    const result = await tool.execute({}, new AbortController().signal);
    const canonical = JSON.parse(result.output);
    expect(validateR4Result('read_creation', canonical).valid).toBe(true);
    expect(canonical).toMatchObject({ resultKind: 'preflight_failure', status: 'blocked' });
    expect(setup.host.invoke).not.toHaveBeenCalled();
  });

  it('converts a persisted pre-dispatch gate rejection into a valid preflight envelope', async () => {
    const setup = options({
      initialMounted: ['read_creation'],
      assertNoDispatchGate: vi.fn(() => { throw new Error('durable authorization gate'); }),
    });
    const result = await getTool(createR4PiToolSession(setup), 'read_creation')
      .execute({}, new AbortController().signal);
    const canonical = JSON.parse(result.output);
    expect(validateR4Result('read_creation', canonical).valid).toBe(true);
    expect(canonical).toMatchObject({ resultKind: 'preflight_failure', status: 'blocked' });
    expect(setup.host.invoke).not.toHaveBeenCalled();
  });

  it('maps a real legacy response to canonical JSON and retains generated files only as a UI sidecar', async () => {
    const images = [{ id: 'private-attachment', filePath: 'C:\\private\\result.png' }];
    mocks.executeAgentTool.mockResolvedValue({ ok: true, title: 'Tag results', output: 'legacy receipt', data: [{ tag: 'cat', category: 0 }], generatedImages: images });
    const onToolReceipt = vi.fn();
    const setup = options({
      initialMounted: ['search_tags'],
      onToolReceipt,
      capabilitySnapshot: () => snapshot(['get_capabilities', 'search_tags']),
    });
    const session = createR4PiToolSession(setup);
    const result = await getTool(session, 'search_tags').execute({ query: 'cat' }, new AbortController().signal);
    const parsed = JSON.parse(result.output);
    expect(validateR4Result('search_tags', parsed).valid).toBe(true);
    expect(parsed.data.items[0]).toMatchObject({ tag: 'cat', category: 'general' });
    expect(result.output).not.toContain('C:\\private');
    expect(result.output).not.toContain('legacy receipt');
    expect(onToolReceipt).toHaveBeenCalledWith(expect.objectContaining({ generatedImages: images, legacyOutput: 'legacy receipt' }));
    expect(mocks.executeAgentTool).toHaveBeenCalledWith(expect.objectContaining({
      tool: 'langbai_search_tags', args: { query: 'cat' }, sessionId: scope.conversationId,
    }), setup.emit);
  });

  it('captures destructive legacy-adapter metadata before the handler removes its source record', async () => {
    let candidateExists = true;
    const order: string[] = [];
    const adapterDependencies = vi.fn(async () => {
      order.push('capture');
      const capturedScope = candidateExists ? 'conversation' as const : undefined;
      return { resolveCandidateScope: () => capturedScope };
    });
    mocks.executeAgentTool.mockImplementation(async () => {
      order.push('delete');
      candidateExists = false;
      return { ok: true, title: 'Memory candidate deleted', output: 'deleted', data: { deleted: true } };
    });
    const setup = options({
      initialMounted: ['delete_memory_candidate'],
      capabilitySnapshot: () => snapshot(['get_capabilities', 'delete_memory_candidate']),
      adapterDependencies,
    });
    const result = await getTool(createR4PiToolSession(setup), 'delete_memory_candidate')
      .execute({ candidateId: 'candidate-1' }, new AbortController().signal);
    const canonical = JSON.parse(result.output);
    expect(validateR4Result('delete_memory_candidate', canonical).valid).toBe(true);
    expect(canonical.data).toMatchObject({ deleteStatus: 'deleted', candidateId: 'candidate-1', scope: 'conversation' });
    expect(order).toEqual(['capture', 'delete']);
  });

  it('validates and authorizes a durable preparation before coordinator enqueue', async () => {
    const setup = options({ initialMounted: ['generate_image'] });
    const state = (setup.host.store as unknown as { readR4State: () => { preparations: Record<string, unknown> } }).readR4State();
    state.preparations['prep-1'] = {
      id: 'prep-1', fingerprint: 'fingerprint-1', conversationId: scope.conversationId, creationId: scope.creationId,
      userIntentRef: scope.userIntentRef,inputSnapshot:{inputRevision:0,publicParameters:{}},
    };
    const session = createR4PiToolSession(setup);
    const result = await getTool(session, 'generate_image').execute({ preparationId: 'prep-1' }, new AbortController().signal);
    const parsed = JSON.parse(result.output);
    expect(validateR4Result('generate_image', parsed).valid).toBe(true);
    expect(setup.authorize).toHaveBeenCalledWith('generate_image', { preparationId: 'prep-1' }, expect.any(AbortSignal));
    expect(setup.coordinator.submit).toHaveBeenCalledWith('prep-1', 'fingerprint-1', expect.objectContaining({
      operationKey: expect.stringMatching(/^intent-1:generate_image:/),
    }), true);
  });

  it.each([
    ['a previous message', 'intent-before'],
    ['a legacy preparation without an intent', undefined],
  ])('rejects a preparation from %s before authorization or enqueue', async (_description, userIntentRef) => {
    const setup = options({ initialMounted: ['generate_image'] });
    const state = (setup.host.store as unknown as { readR4State: () => { preparations: Record<string, unknown> } }).readR4State();
    state.preparations['prep-1'] = {
      id: 'prep-1', fingerprint: 'fingerprint-1', conversationId: scope.conversationId, creationId: scope.creationId,
      ...(userIntentRef === undefined ? {} : { userIntentRef }),inputSnapshot:{inputRevision:0,publicParameters:{}},
    };

    const result = await getTool(createR4PiToolSession(setup), 'generate_image')
      .execute({ preparationId: 'prep-1' }, new AbortController().signal);
    const canonical = JSON.parse(result.output);

    expect(validateR4Result('generate_image', canonical).valid).toBe(true);
    expect(canonical).toMatchObject({ resultKind: 'preflight_failure', status: 'error', error: { code: 'preparation_stale' } });
    expect(setup.authorize).not.toHaveBeenCalled();
    expect(setup.coordinator.submit).not.toHaveBeenCalled();
  });

  it('returns a canonical denial before enqueue when confirmation is declined', async () => {
    const setup = options({ initialMounted: ['generate_image'], authorize: vi.fn(async () => false) });
    const state = (setup.host.store as unknown as { readR4State: () => { preparations: Record<string, unknown> } }).readR4State();
    state.preparations['prep-1'] = {
      id: 'prep-1', fingerprint: 'fingerprint-1', conversationId: scope.conversationId, creationId: scope.creationId,
      userIntentRef: scope.userIntentRef,inputSnapshot:{inputRevision:0,publicParameters:{}},
    };
    const result = await getTool(createR4PiToolSession(setup), 'generate_image')
      .execute({ preparationId: 'prep-1' }, new AbortController().signal);
    const canonical = JSON.parse(result.output);
    expect(validateR4Result('generate_image', canonical).valid).toBe(true);
    expect(canonical).toMatchObject({ resultKind: 'preflight_failure', status: 'denied' });
    expect(setup.coordinator.submit).not.toHaveBeenCalled();
  });

  it('does not mount apply_prompt or direct edit tools without their real CAS/preparation adapters', () => {
    const setup = options({
      initialMounted: ['apply_prompt', 'redraw_image', 'inpaint_image', 'upscale_image', 'process_image'],
      capabilitySnapshot: () => snapshot(['get_capabilities', 'apply_prompt', 'redraw_image', 'inpaint_image', 'upscale_image', 'process_image']),
    });
    const names = createR4PiToolSession(setup).mountedTools();
    expect(names).toEqual(['get_capabilities']);
  });

  it('prepares direct image edits before authorization and submits only after consent', async () => {
    const order: string[] = [];
    const setup = options({
      initialMounted: ['redraw_image'],
      capabilitySnapshot: () => snapshot(['get_capabilities', 'redraw_image']),
      authorize: vi.fn(async (name, args) => { order.push(`authorize:${name}:${String(args.preparationId)}`); return true; }),
    });
    const state = (setup.host.store as unknown as { readR4State: () => { preparations: Record<string, unknown> } }).readR4State();
    state.preparations['edit-prep'] = {
      id: 'edit-prep', fingerprint: 'edit-fp', conversationId: scope.conversationId, creationId: scope.creationId,
      userIntentRef: scope.userIntentRef,inputSnapshot:{inputRevision:0,publicParameters:{}},
    };
    setup.prepareImageOperation = vi.fn(async () => { order.push('prepare'); return { preparationId: 'edit-prep', fingerprint: 'edit-fp' }; });
    const session = createR4PiToolSession(setup);
    const result = await getTool(session, 'redraw_image').execute({ attachmentId: 'source', positivePrompt: 'forest' }, new AbortController().signal);
    expect(validateR4Result('redraw_image', JSON.parse(result.output)).valid).toBe(true);
    expect(order).toEqual(['prepare', 'authorize:redraw_image:edit-prep']);
    expect(setup.coordinator.submit).toHaveBeenCalledWith('edit-prep', 'edit-fp', expect.any(Object), true);
  });

  it('runs the persisted gate before each model call', async () => {
    const setup = options();
    await createR4PiToolSession(setup).beforeModelCall();
    expect(setup.assertNoDispatchGate).toHaveBeenCalledWith(scope, 'model_call');
  });
});

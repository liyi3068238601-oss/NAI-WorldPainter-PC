import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  run: vi.fn(), studioPiModel: vi.fn(() => ({ api: 'fixture', provider: 'fixture', id: 'fixture' })),
  studioPiStream: vi.fn(() => vi.fn()), legacyTools: vi.fn(() => [{ name: 'legacy-tool', description: 'legacy', readonly: true, execute: vi.fn() }]),
}));
vi.mock('./pi-agent-core', () => ({ runStudioPiAgent: mocks.run, studioPiUsageFromError: vi.fn() }));
vi.mock('./pi-agent-provider', () => ({ studioPiModel: mocks.studioPiModel, studioPiStream: mocks.studioPiStream }));
vi.mock('./pi-studio-tools', () => ({ createStudioPiTools: mocks.legacyTools }));
vi.mock('./worldpainter-knowledge', () => ({ readWorldpainterPromptingReference: vi.fn(async () => 'reference') }));

import { completeStudioPiTurn } from './pi-agent-turn';
import { R4_SYSTEM_PROMPT } from '../../src/agent/r4-system-prompt';

const emptyUsage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function baseOptions(patch: Record<string, unknown> = {}) {
  return {
    settings: {} as never,
    conversationId: 'chat-1', messageId: 'message-1',
    prompt: [
      { role: 'assistant', content: 'previous answer', sourceMessageId: 'old-message' },
      { role: 'user', content: 'current request' },
    ],
    toolHistory: {
      'old-message': [
        { id: 'old-message:r4', name: 'read_creation', input: { targetCreationId: 'creation-1' }, output: '{"ok":true}', status: 'completed' },
        { id: 'old-message:legacy', name: 'langbai_search_tags', input: { query: 'cat' }, output: 'legacy result', status: 'completed' },
      ],
    },
    signal: new AbortController().signal,
    onText: vi.fn(), onTool: vi.fn(), emit: vi.fn(),
    onReady: vi.fn(), onSteeringConsumed: vi.fn(),
    authorize: vi.fn(async () => true),
    ...patch,
  } as never;
}

function r4Context() {
  const host = { invoke: vi.fn(), store: { readR4State: () => ({ preparations: {} }) } };
  return {
    host: host as never,
    coordinator: { get: vi.fn(), cancel: vi.fn(), submit: vi.fn() } as never,
    scope: { conversationId: 'chat-1', creationId: 'creation-1', userIntentRef: 'intent-1', operationKey: 'op-1' },
    assertNoDispatchGate: vi.fn(),
    capabilitySnapshot: () => ({
      catalogStatus: 'ok', catalogVersion: 'fixture', approvalMode: 'confirm',
      available: [{ group: 'capabilities', toolNames: ['get_capabilities'], capabilityKeys: [] }],
      mounted: ['get_capabilities'], requestedGroups: [], requestedDenied: [], providerProjectionStatus: 'host_only',
    }),
    initialMounted: ['get_capabilities'], approvalMode: 'confirm' as const, webSearchEnabled: false,
    adapterDependencies: () => ({}),
  };
}

describe('completeStudioPiTurn protocol split', () => {
  beforeEach(() => {
    mocks.run.mockReset();
    mocks.legacyTools.mockClear();
    mocks.run.mockResolvedValue({ text: 'done', reasoning: '', usage: emptyUsage, messages: [] });
  });

  it('restores canonical history flat while retaining the old args envelope for legacy receipts', async () => {
    await completeStudioPiTurn(baseOptions());
    const call = mocks.run.mock.calls[0][0];
    const calls = call.history.filter((message: { role: string }) => message.role === 'assistant')
      .flatMap((message: { content: Array<{ type: string; arguments?: unknown }> }) => message.content)
      .filter((part: { type: string }) => part.type === 'toolCall');
    expect(calls).toHaveLength(2);
    expect(calls[0].arguments).toEqual({ targetCreationId: 'creation-1' });
    expect(calls[1].arguments).toEqual({ args: { query: 'cat' } });
  });

  it('lazily pairs only proven terminal history rows, keeps original IDs, and leaves malformed rows inert', async () => {
    const history = [
      { id: 'old-turn:call-read', name: 'read_creation', title: 'read', input: { targetCreationId: 'creation-old' }, output: '{"creationId":"creation-old"}', status: 'completed' },
      { id: 'old-turn:call-image', name: 'langbai_generate_image', title: 'old image', input: { positivePrompt: 'old scene' }, output: '{"imageId":"old-image"}', generatedImages: [{ id: 'old-image', createdAt: '2026-01-01T00:00:00.000Z' }], status: 'completed' },
      { id: 'old-turn:duplicate', name: 'read_creation', input: {}, output: '{}', status: 'completed' },
      { id: 'old-turn:duplicate', name: 'read_proposal', input: {}, output: '{}', status: 'completed' },
      { id: 'some-other-turn:orphan', name: 'langbai_search_tags', input: { query: 'cat' }, output: 'old result', status: 'completed' },
      { id: 'old-turn:unclosed', name: 'langbai_generate_image', input: { positivePrompt: 'unfinished' }, status: 'running' },
      { id: 'old-turn:missing-input', name: 'read_creation', output: '{}', status: 'completed' },
      { name: 'read_creation', input: {}, output: '{}', status: 'completed' },
    ];
    const toolHistory = {
      'old-turn': history,
      'source-message-not-in-transcript': [{ id: 'source-message-not-in-transcript:orphan', name: 'read_creation', input: {}, output: '{}', status: 'completed' }],
    };
    const original = JSON.stringify(toolHistory);
    const audit = vi.fn();
    await completeStudioPiTurn(baseOptions({
      prompt: [
        { role: 'assistant', content: 'prior response', sourceMessageId: 'old-turn' },
        { role: 'user', content: 'new request' },
      ],
      toolHistory,
      onHistoryProjection: audit,
    }));

    const call = mocks.run.mock.calls[0][0];
    const toolCalls = call.history.filter((message: { role: string }) => message.role === 'assistant')
      .flatMap((message: { content: Array<{ type: string; id?: string; name?: string }> }) => message.content)
      .filter((part: { type: string }) => part.type === 'toolCall');
    const results = call.history.filter((message: { role: string }) => message.role === 'toolResult');
    expect(toolCalls.map((part: { id: string }) => part.id)).toEqual(['call-read', 'call-image']);
    expect(toolCalls.map((part: { name: string }) => part.name)).toEqual(['read_creation', 'langbai_generate_image']);
    expect(results.map((message: { toolCallId: string }) => message.toolCallId)).toEqual(['call-read', 'call-image']);
    const resultTexts = results.flatMap((message: { content: Array<{ type: string; text?: string }> }) => message.content.map(part => part.text ?? ''));
    expect(resultTexts.some((text: string) => JSON.parse(text).historical === true)).toBe(true);
    expect(resultTexts.some((text: string) => JSON.parse(text).generatedImages?.[0]?.id === 'old-image')).toBe(true);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      version: 'r4-legacy-history-pairing/1', lazy: true,
      paired: [
        { sourceMessageId: 'old-turn', recordId: 'old-turn:call-read', toolCallId: 'call-read', toolName: 'read_creation' },
        { sourceMessageId: 'old-turn', recordId: 'old-turn:call-image', toolCallId: 'call-image', toolName: 'langbai_generate_image' },
      ],
    }));
    expect(audit.mock.calls[0][0].inert.map((row: { reason: string }) => row.reason)).toEqual([
      'duplicate_native_call_id', 'duplicate_native_call_id', 'unproven_native_call_id',
      'call_not_terminal', 'missing_or_invalid_input', 'missing_record_id', 'missing_source_message',
    ]);
    expect(JSON.stringify(toolHistory)).toBe(original);
    const registered = mocks.legacyTools.mock.results[0]?.value;
    expect(registered[0].execute).not.toHaveBeenCalled();
  });

  it('uses only mounted flat canonical tools in R4 mode and preserves raw flat inputs in UI events', async () => {
    const context = r4Context();
    const turn = baseOptions({ r4Context: context }) as {
      onTool: ReturnType<typeof vi.fn>;
      onReady: ReturnType<typeof vi.fn>;
      onSteeringConsumed: ReturnType<typeof vi.fn>;
    };
    await completeStudioPiTurn(turn as never);
    const call = mocks.run.mock.calls[0][0];
    expect(call.tools.map((tool: { name: string }) => tool.name)).toEqual(['get_capabilities']);
    expect(call.tools.every((tool: { flatArguments?: boolean; handlesAuthorization?: boolean }) => tool.flatArguments && tool.handlesAuthorization)).toBe(true);
    expect(call.getTools).toBeTypeOf('function');
    expect(call.beforeModelCall).toBeTypeOf('function');
    expect(call.systemPrompt).toContain(R4_SYSTEM_PROMPT);
    expect(call.systemPrompt).toContain('read_skill');
    expect(call.systemPrompt).toContain('ask_user');
    expect(call.systemPrompt).not.toContain('langbai_software_capabilities');
    expect(call.onReady).toBe(turn.onReady);
    expect(call.onSteeringConsumed).toBe(turn.onSteeringConsumed);

    await call.onEvent({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'read_creation', args: { targetCreationId: 'creation-2' } });
    const onTool = mocks.run.mock.calls[0][0].onToolRunning;
    onTool('call-2', 'read_creation', { targetCreationId: 'creation-3' });
    expect(turn.onTool).toHaveBeenNthCalledWith(1, expect.objectContaining({
      name: 'read_creation', input: { targetCreationId: 'creation-2' },
    }));
    expect(turn.onTool).toHaveBeenNthCalledWith(2, expect.objectContaining({
      name: 'read_creation', input: { targetCreationId: 'creation-3' },
    }));
  });

  it('keeps the legacy tool path mounted when no R4 context is supplied', async () => {
    await completeStudioPiTurn(baseOptions());
    const call = mocks.run.mock.calls[0][0];
    expect(call.tools).toEqual([{ name: 'legacy-tool', description: 'legacy', readonly: true, execute: expect.any(Function) }]);
    expect(call.getTools).toBeUndefined();
    expect(call.beforeModelCall).toBeUndefined();
    expect(mocks.legacyTools).toHaveBeenCalledTimes(1);
  });

  it('assembles fixed rules, the selected preset and bounded references once without eagerly injecting Skill bodies', async () => {
    const preset='SELECTED_CREATIVE_PRESET',knowledge='MATCHED_REFERENCE_FACTS',hostContext='HOST_INPUT_SNAPSHOT';
    const readSkill=vi.fn(()=>({id:'layout',name:'Layout',description:'Composition',instructions:'SKILL_BODY_ONLY_ON_READ'}));
    await completeStudioPiTurn(baseOptions({
      r4Context:r4Context(),configuredSystemPrompt:preset,worldpainterKnowledge:{version:'v5',prompt:knowledge},
      skillDirectory:[{id:'layout',name:'Layout',description:'Composition'}],readSkill,
      prompt:[{role:'system',content:'Studio Pi conversation'},{role:'system',content:R4_SYSTEM_PROMPT},
        {role:'system',content:preset},{role:'system',content:knowledge},{role:'system',content:hostContext},
        {role:'system',content:hostContext},{role:'user',content:'仅讨论画面'}],
    }));
    const call=mocks.run.mock.calls[0][0];
    expect(call.systemPrompt.startsWith(R4_SYSTEM_PROMPT)).toBe(true);
    for(const section of [R4_SYSTEM_PROMPT,preset,knowledge,hostContext])expect(call.systemPrompt.split(section)).toHaveLength(2);
    expect(call.systemPrompt).toContain('Applicable Skill directory');
    expect(call.systemPrompt).not.toContain('SKILL_BODY_ONLY_ON_READ');
    expect(readSkill).not.toHaveBeenCalled();
  });
});

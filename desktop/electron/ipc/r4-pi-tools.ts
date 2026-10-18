import { createHash } from 'node:crypto';
import type { AgentEvent, AgentQuestionResult, AgentToolBridgeRequest } from '../../src/agent/types';
import {
  registry,
  r4Tool,
  validateR4Input,
  validateR4Result,
  type R4ToolDefinition,
  type R4ToolName,
} from '../../src/agent/r4-contracts';
import { r4SdkInputFallbacks } from '../../src/agent/r4-sdk-input-fallbacks';
import {
  adaptR4LegacyResult,
  mapR4LegacyArgs,
  type R4LegacyAdapterDependencies,
  type R4LegacyCapabilitySnapshot,
} from '../../src/agent/r4-legacy-adapter';
import type { R4CreativeHost, R4HostScope } from './r4-creative-host';
import type { R4ExecutionCoordinator } from './r4-execution-coordinator';
import type { StudioPiTool } from './pi-agent-core';
import { executeAgentTool } from './agent-tools';
import { R4_SYSTEM_PROMPT } from '../../src/agent/r4-system-prompt';
import { readWorldpainterPromptingReference } from './worldpainter-knowledge';

export interface R4ImageOperationPreparation {
  preparationId: string;
  fingerprint: string;
}

export interface R4PiToolReceipt {
  name: R4ToolName;
  args: Record<string, unknown>;
  result: Record<string, unknown>;
  generatedImages?: unknown[];
  /** Host-only legacy receipt; deliberately excluded from the model result. */
  legacyOutput?: string;
}

export interface R4PiToolSessionOptions {
  host: R4CreativeHost;
  coordinator: R4ExecutionCoordinator;
  /** Frozen by the host for this user message; never assembled from model arguments. */
  scope: R4HostScope;
  emit: (event: AgentEvent) => void;
  authorize: (canonicalName: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<boolean>;
  /** Must re-read durable gates; also called before every model request. */
  assertNoDispatchGate: (scope: R4HostScope, tool?: R4ToolName | 'model_call') => void | Promise<void>;
  capabilitySnapshot: () => R4LegacyCapabilitySnapshot;
  initialMounted?: readonly string[];
  approvalMode: 'confirm' | 'auto';
  webSearchEnabled: boolean;
  legacySessionId?: string;
  legacyPromptLocks?: AgentToolBridgeRequest['promptLocks'];
  adapterDependencies: (
    scope: R4HostScope,
    name: R4ToolName,
    args: Record<string, unknown>,
  ) => R4LegacyAdapterDependencies | Promise<R4LegacyAdapterDependencies>;
  runPaidLegacy?: (name:R4ToolName,args:Record<string,unknown>,scope:R4HostScope,run:()=>Promise<Omit<R4PiToolReceipt,'name'|'args'>>,signal:AbortSignal) => Promise<Omit<R4PiToolReceipt,'name'|'args'>>;
  preflightLegacy?: (name:R4ToolName,args:Record<string,unknown>,scope:R4HostScope) => void|Promise<void>;
  askQuestion?: (args: Record<string, unknown>, signal: AbortSignal) => Promise<AgentQuestionResult>;
  skillDirectory?: Array<{ id: string; name: string; description: string }>;
  readSkill?: (id: string) => unknown;
  readPromptingReference?: (reference: 'ideation' | 'writing') => Promise<{
    content: string;
    source: string;
    version: string;
  }>;
  promptingReferenceEnabled?: boolean;
  applyPrompt?: (args: Record<string, unknown>, scope: R4HostScope, signal: AbortSignal) => Promise<Record<string, unknown>>;
  /** Direct image edits need a durable preparation; the tool is not mounted without it. */
  prepareImageOperation?: (
    name: 'redraw_image' | 'inpaint_image' | 'upscale_image' | 'process_image',
    args: Record<string, unknown>,
    scope: R4HostScope,
    signal: AbortSignal,
  ) => Promise<R4ImageOperationPreparation>;
  onToolReceipt?: (receipt: R4PiToolReceipt) => void;
}

/** Context supplied by agent-runtime. Per-turn UI callbacks are injected by pi-agent-turn. */
export type R4PiTurnContext = Omit<R4PiToolSessionOptions,
  'emit' | 'authorize' | 'askQuestion' | 'skillDirectory' | 'readSkill' | 'onToolReceipt'>;

export interface R4PiToolSession {
  getTools(): readonly StudioPiTool[];
  beforeModelCall(): Promise<void>;
  systemPrompt: string;
  mountedTools(): string[];
}

const toolByName = new Map(registry.tools.map(tool => [tool.canonical, tool] as const));
const IMAGE_TOOLS = new Set<R4ToolName>([
  'generate_image', 'redraw_image', 'inpaint_image', 'upscale_image', 'process_image',
]);
const HOST_TOOLS = new Set<R4ToolName>([
  'get_execution', 'propose_prompt', 'read_creation', 'read_proposal', 'set_current_proposal',
  'prepare_generation', 'generate_image', 'cancel_execution', 'patch_creation_inputs',
]);

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function callScope(scope: R4HostScope, name: R4ToolName, args: Record<string, unknown>): R4HostScope {
  const hash = createHash('sha256').update(stable(args)).digest('hex');
  return { ...scope, operationKey: `${scope.userIntentRef}:${name}:${hash}` };
}

function row(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function targetsFrozenScope(args: Record<string, unknown>, scope: R4HostScope): boolean {
  return (args.targetConversationId !== undefined && args.targetConversationId !== scope.conversationId)
    || (args.targetCreationId !== undefined && args.targetCreationId !== scope.creationId);
}

function errorDefinition(tool: R4ToolDefinition) {
  const schema = tool.resultSchema as { properties?: Record<string, unknown> };
  const error = schema.properties?.error as { properties?: Record<string, unknown> } | undefined;
  return error?.properties as Record<string, { enum?: string[]; items?: { enum?: string[] } }> | undefined;
}

function preflightFailure(
  name: R4ToolName,
  scope: R4HostScope,
  message: string,
  preferredCode = 'invalid_arguments',
  status: 'error' | 'blocked' | 'denied' | 'cancelled' = 'error',
  preferredActions: string[] = ['correct_arguments', 'select_supported_capability', 'continue_without_tool'],
): Record<string, unknown> {
  const definition = toolByName.get(name)!;
  const properties = errorDefinition(definition);
  const codes = properties?.code?.enum ?? [];
  const code = codes.includes(preferredCode) ? preferredCode
    : codes.includes('invalid_arguments') ? 'invalid_arguments' : codes[0];
  const actions = properties?.allowedActions?.items?.enum ?? [];
  const allowedAction = [...preferredActions, ...actions].find(action => actions.includes(action));
  if (!code || !allowedAction) throw new Error(`R4 ${name} result schema has no preflight error shape.`);
  const result = {
    resultKind: 'preflight_failure', status,
    error: { code, message, allowedActions: [allowedAction] },
  };
  const checked = validateR4Result(name, result);
  if (!checked.valid) throw new Error(`R4 ${name} preflight result did not match its schema.`);
  return result;
}

function isReady(name: R4ToolName, options: R4PiToolSessionOptions): boolean {
  if (name === 'get_capabilities') return true;
  if (name === 'apply_prompt') return Boolean(options.applyPrompt);
  if (['redraw_image', 'inpaint_image', 'upscale_image', 'process_image'].includes(name)) {
    return Boolean(options.prepareImageOperation);
  }
  if (name === 'ask_user') return Boolean(options.askQuestion);
  if (name === 'read_skill') return Boolean(options.readSkill && options.skillDirectory?.length);
  if (name === 'read_prompting_reference') return options.promptingReferenceEnabled === true;
  if (name === 'search_web') return options.webSearchEnabled;
  return true;
}

function runtimeAvailableNames(options: R4PiToolSessionOptions, snapshot = options.capabilitySnapshot()) {
  const listed = new Set(snapshot.available.flatMap(group => group.toolNames));
  return new Set([...listed].filter((name): name is R4ToolName => {
    const tool = r4Tool(name);
    return Boolean(tool && isReady(tool.canonical, options));
  }));
}

function isReadonlyForCall(tool: R4ToolDefinition, args: Record<string, unknown>) {
  if (tool.canonical === 'manage_prompt_templates' && args.action === 'read') return true;
  return tool.classification.readonly;
}

function needsAuthorization(tool: R4ToolDefinition, args: Record<string, unknown>) {
  if (isReadonlyForCall(tool, args)) return false;
  const byAction = tool.approvalByAction as Record<string, unknown> | undefined;
  if (byAction && typeof args.action === 'string' && Object.prototype.hasOwnProperty.call(byAction, args.action)) {
    return byAction[args.action] !== 'none' && byAction[args.action] !== false;
  }
  return tool.approval !== 'none';
}

function businessResult(name: R4ToolName, scope: R4HostScope, data: Record<string, unknown>, status = 'completed') {
  const result = {
    resultKind: 'business', status,
    conversationId: scope.conversationId,
    creationId: scope.creationId,
    data,
  };
  const checked = validateR4Result(name, result);
  if (!checked.valid) {
    const details = checked.errors.map(error => `${error.instancePath || '/'} ${error.message ?? error.keyword}`).join('; ');
    throw new Error(`R4 ${name} result failed schema validation: ${details}`);
  }
  return result;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!row(value)) throw new Error(`${label} returned no structured result.`);
  return value;
}

function mapQuestionResult(args: Record<string, unknown>, answer: AgentQuestionResult) {
  const questions = Array.isArray(args.questions) ? args.questions : [];
  const answers = answer.answers.map((item, index) => {
    const questionIndex = questions.findIndex((question, candidateIndex) => {
      return row(question) && (question.prompt === item.question || candidateIndex === index);
    });
    const indexInQuestions = questionIndex >= 0 ? questionIndex : index;
    const optionId = typeof item.optionId === 'string' ? /^o([1-6])$/.exec(item.optionId) : null;
    const result: Record<string, unknown> = { questionIndex: indexInQuestions };
    if (optionId) result.selectedOptionIndex = Number(optionId[1]) - 1;
    else if (typeof item.text === 'string') result.freeText = item.text;
    return result;
  });
  return {
    answerStatus: answer.cancelled ? 'cancelled' : answers.length === 0 ? 'unanswered'
      : answers.length < questions.length ? 'unanswered' : 'answered',
    ...(answers.length ? { answers } : {}),
  };
}

function capabilitiesResult(
  options: R4PiToolSessionOptions,
  snapshot: R4LegacyCapabilitySnapshot,
  mounted: Set<R4ToolName>,
  requestedGroups: string[],
  requested: string[],
): Record<string, unknown> {
  const availableNames = runtimeAvailableNames(options, snapshot);
  const available = snapshot.available.map(group => ({
    group: group.group,
    toolNames: group.toolNames.filter(name => {
      const definition = r4Tool(name);
      return Boolean(definition && definition.availability.group === group.group && availableNames.has(definition.canonical));
    }),
    capabilityKeys: [...group.capabilityKeys],
  })).filter(group => group.toolNames.length > 0);
  const denialByGroup = new Map(snapshot.requestedDenied.map(item => [item.group, item.reason]));
  const requestedDenied: Array<{ group: string; reason: string }> = [];
  for (const group of requested) {
    const found = available.find(item => item.group === group);
    if (found?.toolNames.length) continue;
    requestedDenied.push({ group, reason: denialByGroup.get(group) ?? 'disabled' });
  }
  for (const group of available) {
    if (!requestedGroups.includes(group.group)) continue;
    for (const name of group.toolNames) mounted.add(name as R4ToolName);
  }
  const order = new Map(registry.tools.map((tool, index) => [tool.canonical, index]));
  const mountedNames = ['get_capabilities', ...[...mounted]
    .filter(name => name !== 'get_capabilities')
    .sort((a, b) => (order.get(a) ?? 999) - (order.get(b) ?? 999))];
  const result = businessResult('get_capabilities', options.scope, {
    catalogStatus: requestedDenied.length ? 'partial' : snapshot.catalogStatus,
    catalogVersion: snapshot.catalogVersion,
    approvalMode: options.approvalMode,
    available,
    mounted: mountedNames,
    requestedGroups,
    requestedDenied,
    providerProjectionStatus: snapshot.providerProjectionStatus,
  });
  return result;
}

class R4PreflightRejection extends Error {
  constructor(readonly result: Record<string, unknown>) { super('R4 preflight rejected the call.'); }
}

/** Builds the actual flat Pi tool surface for a single frozen R4 turn. */
export function createR4PiToolSession(options: R4PiToolSessionOptions): R4PiToolSession {
  const mounted = new Set<R4ToolName>();
  const initial = new Set(options.initialMounted ?? options.capabilitySnapshot().mounted);
  const snapshot = options.capabilitySnapshot();
  const availableNames = runtimeAvailableNames(options, snapshot);
  for (const name of initial) {
    const tool = r4Tool(name);
    if (tool && availableNames.has(tool.canonical)) mounted.add(tool.canonical);
  }
  // The discovery tool is the one unconditional root of the dynamic catalog.
  mounted.add('get_capabilities');
  let requestedGroups: string[] = [];

  const getTools = (): readonly StudioPiTool[] => registry.tools
    .filter(definition => mounted.has(definition.canonical) && isReady(definition.canonical, options))
    .map(definition => makeTool(definition));

  const beforeModelCall = async () => {
    await options.assertNoDispatchGate(options.scope, 'model_call');
  };

  function makeTool(definition: R4ToolDefinition): StudioPiTool {
    const name = definition.canonical;
    return {
      name,
      description: definition.description,
      readonly: definition.classification.readonly,
      paid: definition.cost.mayCharge,
      flatArguments: true,
      handlesAuthorization: true,
      parameters: definition.inputSchema as Record<string, unknown>,
      prepareArguments(rawArgs) {
        return validateR4Input(name, rawArgs).valid
          ? rawArgs as Record<string, unknown>
          : r4SdkInputFallbacks[name];
      },
      isValidArguments(rawArgs) { return validateR4Input(name, rawArgs).valid; },
      async execute(rawArgs, signal) {
        const receipt = (result: Record<string, unknown>) => {
          options.onToolReceipt?.({ name, args: rawArgs, result });
          return { ok: true, output: JSON.stringify(result), data: result };
        };
        if (signal.aborted) {
          return receipt(preflightFailure(name, options.scope, '调用已取消；工具未运行。', 'invalid_arguments', 'cancelled'));
        }
        const validation = validateR4Input(name, rawArgs);
        if (!validation.valid) {
          return receipt(preflightFailure(name, options.scope, '参数不符合 R4 工具合同；工具未运行。'));
        }
        // Every canonical tool shares the same frozen message scope. Keep this
        // guard at the Pi boundary because direct image preparations do not go
        // through host.invoke, while legacy adapters may discard target fields.
        if (targetsFrozenScope(rawArgs, options.scope)) {
          return receipt(preflightFailure(name, options.scope,
            '显式目标与本轮消息冻结范围不一致；工具未运行。', 'context_mismatch', 'blocked',
            ['reselect_target_creation', 'read_creation', 'continue_without_action', 'correct_arguments']));
        }
        if (!mounted.has(name) || !runtimeAvailableNames(options).has(name)) {
          return receipt(preflightFailure(name, options.scope, '工具本轮未挂载或能力已撤销；请刷新能力目录。',
            'not_mounted', 'blocked', ['continue_without_tool', 'select_supported_capability']));
        }

        const call = callScope(options.scope, name, rawArgs);
        try {
          try { await options.assertNoDispatchGate(call, name); }
          catch (error) {
            const code = error && typeof error === 'object' && 'code' in error
              ? String((error as { code: unknown }).code) : 'invalid_arguments';
            const failure = preflightFailure(name, call,
              error instanceof Error ? error.message : '派发保护阻止本次调用；工具未运行。',
              code, 'blocked', ['continue_without_tool', 'select_supported_capability', 'correct_arguments']);
            return receipt(failure);
          }
          try{await options.preflightLegacy?.(name,rawArgs,call);}
          catch(error){return receipt(preflightFailure(name,call,error instanceof Error?error.message:'工具依赖不可用；未运行。'));}

          const directImageOperation = IMAGE_TOOLS.has(name) && name !== 'generate_image';
          const applyPromptOwnsPreviewAuthorization = name === 'apply_prompt' && Boolean(options.applyPrompt);
          if (needsAuthorization(definition, rawArgs) && !directImageOperation && !applyPromptOwnsPreviewAuthorization) {
            if (name === 'generate_image') {
              const preparation = options.host.store.readR4State().preparations[String(rawArgs.preparationId)];
              if (!preparation
                || preparation.conversationId !== call.conversationId
                || preparation.creationId !== call.creationId
                || preparation.userIntentRef !== call.userIntentRef) {
                return receipt(preflightFailure(name, call,
                  '准备记录已过期，或属于另一条消息；请基于本轮输入重新预览。', 'preparation_stale'));
              }
            }
            const approvalArgs = name === 'generate_image' ? { preparationId: rawArgs.preparationId } : rawArgs;
            try {
              const approved = await options.authorize(name, approvalArgs, signal);
              if (!approved) throw new Error('user_denied');
            } catch (error) {
              const cancelled = signal.aborted || (error instanceof Error && error.name === 'AbortError');
              const failure = preflightFailure(name, call,
                cancelled ? '授权等待已取消；工具未运行。' : '用户未批准；工具未运行。',
                cancelled ? 'invalid_arguments' : 'user_denied', cancelled ? 'cancelled' : 'denied',
                ['continue_without_action', 'continue_without_tool', 'request_user_decision']);
              return receipt(failure);
            }
          }

          let result: Omit<R4PiToolReceipt, 'name' | 'args'>;
          try { result = await dispatch(name, rawArgs, call, signal); }
          catch (error) {
            if (error instanceof R4PreflightRejection) return receipt(error.result);
            throw error;
          }
          const checked = validateR4Result(name, result.result);
          if (!checked.valid) {
            const details = checked.errors.map(error => `${error.instancePath || '/'} ${error.message ?? error.keyword}`).join('; ');
            throw new Error(`R4 ${name} returned an invalid canonical result: ${details}`);
          }
          options.onToolReceipt?.({ name, args: rawArgs, ...result });
          return { ok: true, output: JSON.stringify(result.result), data: result.result };
        } catch (error) {
          // Only explicitly classified failures from pre-dispatch authorization
          // are converted above. A handler/coordinator error may follow a paid
          // or durable side effect and must stay an unknown execution failure.
          throw error;
        }
      },
    };
  }

  async function legacy(name: R4ToolName, args: Record<string, unknown>, scope: R4HostScope, signal: AbortSignal) {
    const definition = toolByName.get(name)!;
    const handler = definition.legacyHandler;
    if (typeof handler !== 'string') throw new Error(`R4 ${name} has no compatible legacy handler.`);
    const legacyArgs = mapR4LegacyArgs(name, args);
    const request = {
      tool: handler,
      args: legacyArgs,
      sessionId: options.legacySessionId ?? scope.conversationId,
      signal,
      promptLocks: options.legacyPromptLocks,
    };
    // Resolve identities and revisions while their source records still exist.
    // In particular, memory deletion removes the scope we need to project its receipt.
    const dependencies = await options.adapterDependencies(scope, name, args);
    try{await options.preflightLegacy?.(name,args,scope);}
    catch(error){throw new R4PreflightRejection(preflightFailure(name,scope,error instanceof Error?error.message:'工具依赖已变化；未运行。'));}
    const run=async()=>{
      const legacyResponse = await executeAgentTool(request, options.emit);
      const adapted = await adaptR4LegacyResult(name, args, legacyResponse, {
        conversationId: scope.conversationId, creationId: scope.creationId,
      }, dependencies);
      return { result: adapted.result, generatedImages: adapted.generatedImages, legacyOutput: adapted.legacyOutput };
    };
    return definition.cost.mayCharge&&options.runPaidLegacy?options.runPaidLegacy(name,args,scope,run,signal):run();
  }

  async function submitImageOperation(
    name: R4ToolName,
    preparation: R4ImageOperationPreparation,
    scope: R4HostScope,
  ) {
    // A Pi tool approval is not UI evidence that a durable preview belongs to
    // this user intent. Recheck it at the last boundary before enqueue too.
    const durable = options.host.store.readR4State().preparations[preparation.preparationId];
    if (!durable
      || durable.conversationId !== scope.conversationId
      || durable.creationId !== scope.creationId
      || durable.fingerprint !== preparation.fingerprint
      || durable.userIntentRef !== scope.userIntentRef) {
      return preflightFailure(name, scope,
        '准备记录已过期，或属于另一条消息；请基于本轮输入重新预览。', 'preparation_stale');
    }
    const response = await options.coordinator.submit(preparation.preparationId, preparation.fingerprint, scope, true);
    const result = asRecord(response, 'execution coordinator');
    const validation = validateR4Result('generate_image', result);
    if (!validation.valid) throw new Error('Execution coordinator returned an invalid enqueue receipt.');
    const data = result.data as Record<string, unknown>;
    const status = result.status;
    const submissionStatus = data.submissionStatus === 'stale' || data.submissionStatus === 'already_consumed'
      ? 'invalid' : data.submissionStatus;
    const projected = {
      resultKind: result.resultKind,
      status,
      conversationId: scope.conversationId,
      creationId: scope.creationId,
      data: {
        submissionStatus,
        executionId: data.executionId,
        executionStatus: data.executionStatus,
        inputFingerprint: data.inputFingerprint,
        acceptedAt: data.acceptedAt,
      },
    };
    const checked = validateR4Result(name, projected);
    if (!checked.valid) throw new Error(`R4 ${name} enqueue receipt did not match its result contract.`);
    return projected;
  }

  async function dispatch(name: R4ToolName, args: Record<string, unknown>, scope: R4HostScope, signal: AbortSignal): Promise<Omit<R4PiToolReceipt, 'name' | 'args'>> {
    if (name === 'get_capabilities') {
      const snapshot = options.capabilitySnapshot();
      const requested = Array.isArray(args.requestedGroups) ? args.requestedGroups as string[] : [];
      requestedGroups = [...new Set([...requestedGroups, ...requested])].slice(0, 10);
      const result = capabilitiesResult(options, snapshot, mounted, requestedGroups, requested);
      return { result };
    }
    if (name === 'ask_user') {
      const answer = await options.askQuestion!(args, signal);
      const data = mapQuestionResult(args, answer);
      return { result: businessResult(name, scope, data) };
    }
    if (name === 'read_skill') {
      const skill = options.readSkill!(String(args.skillId));
      const response = skill
        ? { ok: true, title: 'Skill', output: JSON.stringify(skill), data: skill }
        : { ok: false, title: 'Skill unavailable', output: 'Skill is not available in this turn.' };
      const adapted = await adaptR4LegacyResult(name, args, response, {
        conversationId: scope.conversationId, creationId: scope.creationId,
      }, await options.adapterDependencies(scope, name, args));
      return { result: adapted.result, legacyOutput: adapted.legacyOutput };
    }
    if (name === 'read_prompting_reference') {
      try {
        const metadata = options.readPromptingReference
          ? await options.readPromptingReference(args.reference as 'ideation' | 'writing')
          : { content: await readWorldpainterPromptingReference(args.reference), source: 'bundled V5 prompting references', version: 'v5' };
        const adapted = await adaptR4LegacyResult(name, args, {
          ok: true, title: 'Prompting reference', output: metadata.content,
          data: { reference: args.reference, content: metadata.content, source: metadata.source, version: metadata.version },
        }, { conversationId: scope.conversationId, creationId: scope.creationId }, await options.adapterDependencies(scope, name, args));
        return { result: adapted.result, legacyOutput: adapted.legacyOutput };
      } catch (error) {
        const adapted = await adaptR4LegacyResult(name, args, {
          ok: false, title: 'Prompting reference unavailable', output: error instanceof Error ? error.message : String(error),
        }, { conversationId: scope.conversationId, creationId: scope.creationId }, await options.adapterDependencies(scope, name, args));
        return { result: adapted.result, legacyOutput: adapted.legacyOutput };
      }
    }
    if (name === 'apply_prompt') {
      return { result: await options.applyPrompt!(args, scope, signal) };
    }
    if (name === 'generate_image') {
      const preparation = options.host.store.readR4State().preparations[String(args.preparationId)];
      if (!preparation || preparation.conversationId !== scope.conversationId || preparation.creationId !== scope.creationId
        || preparation.userIntentRef !== scope.userIntentRef) {
        return { result: preflightFailure(name, scope,
          '准备记录已过期，或属于另一条消息；请基于本轮输入重新预览。', 'preparation_stale') };
      }
      if (preparation.fingerprint.length < 1) throw new Error('Prepared generation has no fingerprint.');
      return { result: await submitImageOperation(name, { preparationId: preparation.id, fingerprint: preparation.fingerprint }, scope) };
    }
    if (IMAGE_TOOLS.has(name)) {
      const prepared = await options.prepareImageOperation!(name as 'redraw_image' | 'inpaint_image' | 'upscale_image' | 'process_image', args, scope, signal);
      const durable = options.host.store.readR4State().preparations[prepared.preparationId];
      if (!durable
        || durable.conversationId !== scope.conversationId
        || durable.creationId !== scope.creationId
        || durable.fingerprint !== prepared.fingerprint
        || durable.userIntentRef !== scope.userIntentRef) {
        throw new R4PreflightRejection(preflightFailure(name, scope,
          '准备记录已过期，或属于另一条消息；请基于本轮输入重新预览。', 'preparation_stale'));
      }
      try {
        const approved = await options.authorize(name, { preparationId: prepared.preparationId }, signal);
        if (!approved) throw new Error('user_denied');
      } catch (error) {
        const cancelled = signal.aborted || (error instanceof Error && error.name === 'AbortError');
        throw new R4PreflightRejection(preflightFailure(name, scope,
          cancelled ? '授权等待已取消；未提交图像操作。' : '用户未批准；未提交图像操作。',
          cancelled ? 'invalid_arguments' : 'user_denied', cancelled ? 'cancelled' : 'denied',
          ['continue_without_action', 'continue_without_tool', 'request_user_decision']));
      }
      return { result: await submitImageOperation(name, prepared, scope) };
    }
    if (name === 'get_execution') {
      return { result: options.coordinator.get(String(args.executionId), scope) };
    }
    if (name === 'cancel_execution') {
      return { result: await options.coordinator.cancel(String(args.executionId), scope) };
    }
    if (HOST_TOOLS.has(name)) {
      return { result: await options.host.invoke(name, args, scope) };
    }
    return legacy(name, args, scope, signal);
  }

  return {
    getTools,
    beforeModelCall,
    systemPrompt: R4_SYSTEM_PROMPT,
    mountedTools: () => getTools().map(tool => tool.name),
  };
}

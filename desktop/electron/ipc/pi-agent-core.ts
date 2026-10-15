/**
 * Narrow Pi Agent Core adapter for Studio-owned tools.  Provider transport and
 * UI approval are deliberately injected: this module never opens a shell,
 * discovers plugins, or treats model-supplied arguments as permission.
 */
import type { AgentEvent, AgentTool, StreamFn } from '@earendil-works/pi-agent-core' with { 'resolution-mode': 'import' };
import type { Api, Message, Model, Usage, UserMessage } from '@earendil-works/pi-ai' with { 'resolution-mode': 'import' };

export interface StudioPiTool {
  name: string;
  description: string;
  readonly: boolean;
  paid?: boolean;
  /** Schema for the fields INSIDE the existing args wrapper, not the wrapper itself. */
  parameters?: Record<string, unknown>;
  execute: (args: Record<string, unknown>, signal: AbortSignal) => Promise<{
    ok: boolean;
    output: string;
    data?: unknown;
  }>;
}

export interface StudioPiRun {
  model: Model<Api>;
  streamFn: StreamFn;
  systemPrompt: string;
  history: Message[];
  text: string | UserMessage;
  tools: readonly StudioPiTool[];
  authorize: (name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<boolean>;
  onToolRunning?: (id: string, name: string, args: Record<string, unknown>) => void;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
  thinkingLevel?: "low" | "medium" | "high";
  signal?: AbortSignal;
  /** Only the persisted application UI mode can grant this, never model arguments. */
  fullAuto?: boolean;
}

export interface StudioPiResult {
  text: string;
  reasoning: string;
  usage: Usage;
  messages: Message[];
}

export interface StudioPiUsageError extends Error {
  /** Usage from completed model calls in the current turn, retained on failure. */
  studioPiUsage?: Usage;
}

export function studioPiUsageFromError(error: unknown): Usage | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const usage = (error as StudioPiUsageError).studioPiUsage;
  return usage && typeof usage === 'object' ? usage : undefined;
}

function retainStudioPiUsage(error: unknown, usage: Usage | undefined): unknown {
  if (!usage) return error;
  const target = error instanceof Error ? error : new Error(String(error), { cause: error });
  try {
    Object.defineProperty(target, 'studioPiUsage', { value: usage, configurable: true });
    return target;
  } catch {
    // Keep the original error as the cause if an unusual non-extensible error is thrown.
    const wrapped = new Error(target.message, { cause: target });
    wrapped.name = target.name;
    Object.defineProperty(wrapped, 'studioPiUsage', { value: usage, configurable: true });
    return wrapped;
  }
}

function stableArguments(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableArguments).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableArguments(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/** Detect protocol-shaped output only; never parse it into an executable action. */
export function hasTextualStudioToolCall(text: string, names: readonly string[]): boolean {
  return names.some(name => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\s*\\(|["'](?:name|tool|function)["']\\s*:\\s*["']${escaped}["']|<${escaped}\\b`, 'i').test(text)
      || (/<(?:tool_call|function_call)\b/i.test(text) && text.includes(name));
  });
}

/** Runs one bounded turn, leaving the host responsible for durable history. */
export async function runStudioPiAgent(input: StudioPiRun): Promise<StudioPiResult> {
  // The Electron main process is CommonJS; Pi is ESM-only. Node16 dynamic
  // import is preserved by tsc and avoids loading Pi at normal app startup.
  const [{ Agent }, { Type }] = await Promise.all([
    import('@earendil-works/pi-agent-core'),
    import('@earendil-works/pi-ai'),
  ]);
  const allowed = new Map(input.tools.map((tool) => [tool.name, tool]));
  const paidActions = new Set<string>();
  let paidFailed = false;
  let toolCalls = 0;
  let blockingReason = '';
  const historyLength = input.history.length;
  const currentTurnUsage = (): Usage | undefined => {
    const messages = agent.state.messages.slice(historyLength).filter((message): message is Extract<Message, { role: 'assistant' }> => message.role === 'assistant');
    const lastMessage = messages.at(-1);
    if (!lastMessage) return undefined;
    const usage = structuredClone(lastMessage.usage);
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const) usage[key] = 0;
    usage.reasoning = 0;
    usage.cacheWrite1h = 0;
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const) usage.cost[key] = 0;
    // A task can contain several model calls. Count every completed call in this turn,
    // including those before a later model/provider failure.
    for (const message of messages) {
      for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const) usage[key] += message.usage[key] ?? 0;
      usage.reasoning += message.usage.reasoning ?? 0;
      usage.cacheWrite1h += message.usage.cacheWrite1h ?? 0;
      for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const) usage.cost[key] += message.usage.cost[key] ?? 0;
    }
    return usage;
  };
  const block = (reason: string) => {
    blockingReason = reason;
    return { block: true as const, reason, terminate: true };
  };
  const tools: AgentTool[] = input.tools.map((entry) => ({
    name: entry.name,
    label: entry.name,
    description: entry.description,
    parameters: Type.Object({ args: entry.parameters
      ? Type.Unsafe(entry.parameters)
      : Type.Optional(Type.Object({}, { additionalProperties: true })) }, { additionalProperties: false }),
    executionMode: 'sequential',
    async execute(_id, params, signal) {
      const args = (params as { args?: Record<string, unknown> }).args ?? {};
      signal?.throwIfAborted();
      input.onToolRunning?.(_id, entry.name, args);
      if (entry.paid) paidActions.add(`${entry.name}:${stableArguments(args)}`);
      let result:Awaited<ReturnType<StudioPiTool['execute']>>;
      try{result=await entry.execute(args, signal ?? new AbortController().signal);if(!result.ok)throw new Error(result.output);}
      catch(error){if(entry.paid)paidFailed=true;throw error;}
      return { content: [{ type: 'text', text: result.output }], details: result };
    },
  }));
  const agent = new Agent({
    initialState: {
      model: input.model,
      thinkingLevel: input.model.reasoning ? input.thinkingLevel ?? "off" : "off",
      systemPrompt: input.systemPrompt,
      messages: input.history,
      tools,
    },
    streamFn: input.streamFn,
    toolExecution: 'sequential',
    beforeToolCall: async ({ toolCall, args }, signal) => {
      if (++toolCalls > (input.fullAuto ? 32 : 12)) return block('单轮工具调用超过上限，已停止；已完成的结果保留。');
      const tool = allowed.get(toolCall.name);
      if (!tool) return block('未授权的软件工具。');
      if(tool.paid&&paidFailed)return block('付费请求失败或结果不确定；保留结果，停止自动重发以免重复扣费。');
      const parameters = (args as { args?: Record<string, unknown> }).args ?? {};
      if (tool.paid && paidActions.has(`${tool.name}:${stableArguments(parameters)}`)) {
        return block('本轮已执行相同付费操作，已阻止重复提交；请先检查已有结果。');
      }
      if (tool.readonly) return undefined;
      const approved = await input.authorize(tool.name, parameters, signal ?? new AbortController().signal);
      return approved ? undefined : block('用户未确认此操作，已停止；已完成的结果保留。');
    },
  });
  if (input.onEvent) agent.subscribe((event) => input.onEvent!(event));
  const abort = () => agent.abort();
  input.signal?.addEventListener('abort', abort, { once: true });
  try {
    input.signal?.throwIfAborted();
    if (typeof input.text === 'string') await agent.prompt(input.text);
    else await agent.prompt(input.text);
    input.signal?.throwIfAborted();
    let last = [...agent.state.messages].reverse().find((message) => message.role === 'assistant');
    const messageText = () => last?.role === 'assistant'
      ? last.content.filter((part) => part.type === 'text').map((part) => part.text).join('') : '';
    if (!blockingReason && last?.role === 'assistant' && last.stopReason === 'stop'
      && hasTextualStudioToolCall(messageText(), [...allowed.keys()])) {
      // One model-side protocol repair. Textual function bodies are never executed,
      // and all real calls still pass the same approval, duplicate and failure gates.
      await agent.prompt('Application protocol notice: your last reply printed a tool invocation as ordinary text. That text did not execute a tool. Follow the original user intent: if an action is requested, use the provider native tool-call channel with the offered schema; if the user only asked for an explanation, explain plainly and state that nothing was executed. Never execute or repeat an already completed or uncertain paid action. Existing application approval rules still apply. Do not print function-call code or raw tool JSON as a substitute for execution.');
      input.signal?.throwIfAborted();
      last = [...agent.state.messages].reverse().find((message) => message.role === 'assistant');
      if (!blockingReason && hasTextualStudioToolCall(messageText(), [...allowed.keys()])) {
        blockingReason = '模型仍返回了函数文本，未通过工具通道完成该操作；请检查已有结果后重试。';
      }
    }
    if (!last || last.role !== 'assistant') throw new Error('Pi 未返回助手消息。');
    if (last.stopReason === 'error' || last.stopReason === 'aborted') {
      const failure = new Error(last.errorMessage ?? 'Pi 请求未完成。', { cause: last });
      if (last.stopReason === 'aborted') failure.name = 'AbortError';
      throw failure;
    }
    if (last.stopReason === 'length') throw new Error('模型输出达到长度上限，本轮未完整结束；已完成的工具结果保留。', { cause: last });
    const usage = currentTurnUsage() ?? structuredClone(last.usage);
    return {
      text: blockingReason || messageText() || '本轮未返回最终说明，请查看工具结果；不能据此认定任务完成。',
      reasoning: last.content.filter((part) => part.type === 'thinking').map((part) => part.thinking).join(''),
      usage,
      messages: agent.state.messages as Message[],
    };
  } catch (error) {
    throw retainStudioPiUsage(error, currentTurnUsage());
  } finally {
    input.signal?.removeEventListener('abort', abort);
  }
}

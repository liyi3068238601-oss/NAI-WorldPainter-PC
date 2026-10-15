import { describe, expect, it, vi } from 'vitest';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { AssistantMessage, Model, StreamFunction } from '@earendil-works/pi-ai';
import { runStudioPiAgent, hasTextualStudioToolCall, studioPiUsageFromError } from './pi-agent-core';

const model: Model<'openai-completions'> = {
  id: 'fixture', name: 'Fixture', provider: 'fixture', api: 'openai-completions',
  baseUrl: 'https://example.invalid/v1', reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 4096, maxTokens: 1024,
};

function reply(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason']): AssistantMessage {
  return {
    role: 'assistant', content, api: model.api, provider: model.provider,
    model: model.id, stopReason, timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

function fakeStream(...turns: AssistantMessage[]) {
  let index = 0;
  return vi.fn((() => {
    const stream = createAssistantMessageEventStream();
    const message = turns[index++];
    queueMicrotask(() => {
      stream.push({ type: 'start', partial: message });
      stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message });
    });
    return stream;
  }) as StreamFunction<'openai-completions'>);
}

describe('Studio Pi gateway', () => {
  it('runs a read-only Studio tool and returns the follow-up answer', async () => {
    const execute = vi.fn(async () => ({ ok: true, output: 'state ready' }));
    const authorize = vi.fn(async () => true);
    const streamFn = fakeStream(
      reply([{ type: 'toolCall', id: 'call-1', name: 'langbai_get_generation_state', arguments: { args: {} } }], 'toolUse'),
      reply([{ type: 'text', text: '已读取当前设置。' }], 'stop'),
    );
    const result = await runStudioPiAgent({
      model, streamFn, systemPrompt: 'Use Studio tools.', history: [], text: '检查设置',
      tools: [{ name: 'langbai_get_generation_state', description: 'Read current settings', readonly: true, execute }],
      authorize,
    });
    expect(result.text).toBe('已读取当前设置。');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(authorize).not.toHaveBeenCalled();
  });

  it('blocks a paid tool without UI approval', async () => {
    const execute = vi.fn(async () => ({ ok: true, output: 'generated' }));
    const streamFn = fakeStream(reply([
      { type: 'toolCall', id: 'call-2', name: 'langbai_generate_image', arguments: { args: { positivePrompt: 'cat' } } },
    ], 'toolUse'));
    await runStudioPiAgent({
      model, streamFn, systemPrompt: 'Use Studio tools.', history: [], text: '画猫',
      tools: [{ name: 'langbai_generate_image', description: 'Generate image', readonly: false, execute }],
      authorize: async () => false,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([false,true])('never repeats the same paid operation within one turn in fullAuto=%s', async fullAuto => {
    const execute = vi.fn(async () => ({ ok: true, output: 'image saved' }));
    const authorize = vi.fn(async () => true);
    const call = (id: string) => reply([
      { type: 'toolCall', id, name: 'langbai_generate_image',
        arguments: { args: { positivePrompt: 'cat' } } },
    ], 'toolUse');
    await runStudioPiAgent({
      model, fullAuto, streamFn: fakeStream(call('first'), call('again')),
      systemPrompt: 'Use Studio tools.', history: [], text: '画猫',
      tools: [{ name: 'langbai_generate_image', description: 'Generate image',
        readonly: false, paid: true, execute }], authorize,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(authorize).toHaveBeenCalledTimes(1);
  });
});

it.each([{fullAuto:false,limit:12},{fullAuto:true,limit:32}])('bounds a looping task in fullAuto=$fullAuto without discarding completed results',async({fullAuto,limit})=>{
  const execute=vi.fn(async()=>({ok:true,output:'saved result'}));
  const turns=Array.from({length:limit+1},(_,i)=>reply([{type:'toolCall',id:`read-${i}`,name:'read',arguments:{args:{}}}],'toolUse'));
  const result=await runStudioPiAgent({model,fullAuto,systemPrompt:'fixture',history:[],text:'read',
    tools:[{name:'read',description:'read',readonly:true,execute}],authorize:async()=>true,streamFn:fakeStream(...turns)});
  expect(execute).toHaveBeenCalledTimes(limit);expect(result.text).toContain('超过上限');
  expect(result.messages.filter(message=>message.role==='toolResult'&&!message.isError)).toHaveLength(limit);
});

it('continues distinct requested paid steps with a separate confirmation for each', async () => {
  const generate = vi.fn(async () => ({ok:true,output:'{"attachmentId":"generated-1"}'}));
  const upscale = vi.fn(async () => ({ok:true,output:'{"attachmentId":"upscaled-1"}'}));
  const authorize = vi.fn(async () => true);
  const result = await runStudioPiAgent({model,systemPrompt:'fixture',history:[],text:'生成后放大',authorize,
    tools:[{name:'generate',description:'generate',readonly:false,paid:true,execute:generate},
      {name:'upscale',description:'upscale',readonly:false,paid:true,execute:upscale}],
    streamFn:fakeStream(
      reply([{type:'toolCall',id:'generate-1',name:'generate',arguments:{args:{prompt:'cat'}}}],'toolUse'),
      reply([{type:'toolCall',id:'upscale-1',name:'upscale',arguments:{args:{attachmentId:'generated-1',scale:2}}}],'toolUse'),
      reply([{type:'text',text:'已生成并放大。'}],'stop'))});
  expect(generate).toHaveBeenCalledTimes(1); expect(upscale).toHaveBeenCalledTimes(1);
  expect(authorize.mock.calls.map(call=>call[0])).toEqual(['generate','upscale']);
  expect(upscale.mock.calls[0]?.[0]).toEqual({attachmentId:'generated-1',scale:2});
  expect(result.text).toBe('已生成并放大。');
});

it.each([false,true])('does not retry failed paid work in fullAuto=%s', async fullAuto => {
  const execute = vi.fn(async () => ({ok:false,output:'response lost; outcome uncertain'}));
  const call = (id:string) => reply([{type:'toolCall',id,name:'paid',arguments:{args:{id}}}],'toolUse');
  const result = await runStudioPiAgent({model,systemPrompt:'fixture',history:[],text:'do work',fullAuto,
    tools:[{name:'paid',description:'paid',readonly:false,paid:true,execute}],authorize:async()=>true,
    streamFn:fakeStream(call('first'),call('retry'))});
  expect(execute).toHaveBeenCalledTimes(1); expect(result.text).toContain('结果不确定');
});

it('reports denial rather than returning an earlier promise of success',async()=>{
  const execute=vi.fn();
  const result=await runStudioPiAgent({model,systemPrompt:'fixture',history:[],text:'draw',
    tools:[{name:'draw',description:'draw',readonly:false,execute}],authorize:async()=>false,
    streamFn:fakeStream(reply([{type:'text',text:'正在为你生成。'},
      {type:'toolCall',id:'denied',name:'draw',arguments:{args:{}}}],'toolUse'))});
  expect(result.text).toContain('用户未确认');expect(result.text).not.toContain('正在为你生成');expect(execute).not.toHaveBeenCalled();
});

it('repairs textual tool syntax through the model protocol once, never by evaluating text',async()=>{
  const execute=vi.fn(async()=>({ok:true,output:'image saved'}));
  const authorize=vi.fn(async()=>true);
  const streamFn=fakeStream(reply([{type:'text',text:'functions.draw({"prompt":"text-only"})'}],'stop'),
    reply([{type:'toolCall',id:'native',name:'draw',arguments:{args:{prompt:'native-only'}}}],'toolUse'),
    reply([{type:'text',text:'已保存图片。'}],'stop'));
  const result=await runStudioPiAgent({model,streamFn,systemPrompt:'fixture',history:[],text:'draw',
    tools:[{name:'draw',description:'draw',readonly:false,paid:true,execute}],authorize});
  expect(streamFn).toHaveBeenCalledTimes(3);expect(execute).toHaveBeenCalledTimes(1);
  expect(execute.mock.calls[0]?.[0]).toEqual({prompt:'native-only'});expect(authorize).toHaveBeenCalledTimes(1);
  expect(result.text).toBe('已保存图片。');
});

it('stops after one failed text-protocol repair and never executes printed arguments',async()=>{
  const execute=vi.fn(),authorize=vi.fn();
  const printed=reply([{type:'text',text:'{"name":"draw","arguments":{"args":{"prompt":"cat"}}}'}],'stop');
  const streamFn=fakeStream(printed,printed);
  const result=await runStudioPiAgent({model,streamFn,systemPrompt:'fixture',history:[],text:'draw',
    tools:[{name:'draw',description:'draw',readonly:false,execute}],authorize});
  expect(streamFn).toHaveBeenCalledTimes(2);expect(execute).not.toHaveBeenCalled();expect(authorize).not.toHaveBeenCalled();
  expect(result.text).toContain('未通过工具通道');
  expect(hasTextualStudioToolCall('The draw tool is available.',['draw'])).toBe(false);
});

it('counts all model calls in a tool task, excluding prior history',async()=>{
  const first=reply([{type:'toolCall',id:'read',name:'read',arguments:{args:{}}}],'toolUse');
  first.usage={...first.usage,input:10,output:5,reasoning:2,totalTokens:15};
  const last=reply([{type:'text',text:'done'}],'stop');last.usage={...last.usage,input:20,output:6,reasoning:3,totalTokens:26};
  const old=reply([{type:'text',text:'past'}],'stop');old.usage={...old.usage,input:1000,totalTokens:1000};
  const result=await runStudioPiAgent({model,systemPrompt:'fixture',history:[old],text:'read',
    tools:[{name:'read',description:'read',readonly:true,execute:async()=>({ok:true,output:'result'})}],authorize:async()=>false,
    streamFn:fakeStream(first,last)});
  expect(result.usage).toMatchObject({input:30,output:11,reasoning:5,totalTokens:41});
});

it('retains completed model usage when a successful tool is followed by a failed final model call', async () => {
  const first = reply([{ type: 'toolCall', id: 'read', name: 'read', arguments: { args: {} } }], 'toolUse');
  first.usage = { ...first.usage, input: 7, output: 4, reasoning: 1, totalTokens: 11 };
  const providerFailure = new Error('Final model request failed');
  let calls = 0;
  const streamFn = vi.fn((() => {
    if (calls++ > 0) throw providerFailure;
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: 'start', partial: first });
      stream.push({ type: 'done', reason: 'toolUse', message: first });
    });
    return stream;
  }) as StreamFunction<'openai-completions'>);
  const execute = vi.fn(async () => ({ ok: true, output: 'read completed' }));
  let failure: unknown;
  try {
    await runStudioPiAgent({ model, streamFn, systemPrompt: 'fixture', history: [], text: 'read',
      tools: [{ name: 'read', description: 'read', readonly: true, execute }], authorize: async () => false });
  } catch (error) { failure = error; }

  expect(execute).toHaveBeenCalledTimes(1);
  expect(failure).toMatchObject({ message: 'Final model request failed' });
  expect(studioPiUsageFromError(failure)).toMatchObject({ input: 7, output: 4, reasoning: 1, totalTokens: 11 });
  expect((failure as Error).cause).toMatchObject({ errorMessage: 'Final model request failed' });
});

it('does not report a length-limited or empty response as task completion',async()=>{
  const run=(message:AssistantMessage)=>runStudioPiAgent({model,systemPrompt:'fixture',history:[],text:'fixture',tools:[],authorize:async()=>false,streamFn:fakeStream(message)});
  await expect(run(reply([{type:'text',text:'partial'}],'length'))).rejects.toThrow('长度上限');
  expect((await run(reply([],'stop'))).text).toContain('不能据此认定任务完成');
});

it.each([
  { args: { preparationId: 42, count: 'not-an-integer' } },
  { args: { count: 1 } },
  { args: { preparationId: 'fixture', count: 99 } },
  { args: { preparationId: 'fixture', count: 1, arbitraryPath: 'unexpected' } },
  {},
])('rejects malformed schema fields before authorize or execute: %j', async (arguments_) => {
  const execute = vi.fn(async () => ({ ok: true, output: 'never' }));
  const authorize = vi.fn(async () => true);
  const running = vi.fn();
  const events: any[] = [];
  await runStudioPiAgent({ model, systemPrompt: 'fixture', history: [], text: 'fixture',
    streamFn: fakeStream(reply([{ type: 'toolCall', id: 'bad', name: 'paid', arguments: arguments_ }], 'toolUse'), reply([{ type: 'text', text: 'invalid input' }], 'stop')),
    tools: [{ name: 'paid', description: 'paid fixture', readonly: false, paid: true, execute,
      parameters: { type: 'object', properties: { preparationId: { type: 'string', minLength: 1 }, count: { type: 'integer', minimum: 1, maximum: 8 } },
        required: ['preparationId', 'count'], additionalProperties: false } }],
    authorize, onToolRunning: running, onEvent: event => { events.push(event); } });
  expect(authorize).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
  expect(running).not.toHaveBeenCalled();
  expect(events.find(event => event.type === 'tool_execution_end')).toMatchObject({ isError: true });
});

it('keeps args wrapper and passes validated field values to approval and execution', async () => {
  const execute = vi.fn(async () => ({ ok: true, output: 'fixture only' }));
  const authorize = vi.fn(async () => true);
  const onToolRunning = vi.fn();
  await runStudioPiAgent({ model, systemPrompt: 'fixture', history: [], text: 'fixture',
    streamFn: fakeStream(reply([{ type: 'toolCall', id: 'valid', name: 'paid', arguments: { args: { preparationId: 'fixture' } } }], 'toolUse'), reply([{ type: 'text', text: 'done' }], 'stop')),
    tools: [{ name: 'paid', description: 'fixture', readonly: false, execute, parameters: { type: 'object', properties: { preparationId: { type: 'string' } }, required: ['preparationId'], additionalProperties: false } }],
    authorize, onToolRunning });
  expect(authorize.mock.calls[0]?.[1]).toEqual({ preparationId: 'fixture' });
  expect(execute.mock.calls[0]?.[0]).toEqual({ preparationId: 'fixture' });
  expect(onToolRunning).toHaveBeenCalledWith('valid', 'paid', { preparationId: 'fixture' });
});

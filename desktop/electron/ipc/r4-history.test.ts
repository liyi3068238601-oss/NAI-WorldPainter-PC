import {describe,it,expect} from 'vitest';
import {createEmptyR4AgentState,type R4QueuedMessage} from '../../src/agent/r4-types';
import type {AgentMessage} from '../../src/agent/types';
import {r4CausalHistory} from './r4-history';

const message=(id:string,role:'user'|'assistant'='user'):AgentMessage=>({id,role,content:id,attachments:[],tools:[],status:'complete',createdAt:'2026-10-18T00:00:00Z'});
describe('R4 causal message closure',()=>{
  it('includes predecessor late tool/result reply while excluding later queued input',()=>{
    const state=createEmptyR4AgentState();
    state.messageQueue.a={id:'qa',conversationId:'chat',messageId:'a',userIntentRef:'ia',assistantMessageId:'answer-a',status:'completed'} as R4QueuedMessage;
    state.messageQueue.b={id:'qb',conversationId:'chat',messageId:'b',predecessorIds:['a'],status:'running'} as R4QueuedMessage;
    state.messageQueue.c={id:'qc',conversationId:'chat',messageId:'c',status:'queued'} as R4QueuedMessage;
    const result=r4CausalHistory([message('a'),message('b'),message('c'),message('answer-a','assistant')],state,state.messageQueue.b);
    expect(result.map(row=>row.id)).toEqual(['a','answer-a','b']);
  });
  it('does not inject cancelled/paused predecessor user requests into a later turn',()=>{
    const state=createEmptyR4AgentState();
    state.messageQueue.a={conversationId:'chat',messageId:'a',status:'cancelled'} as R4QueuedMessage;
    const item={conversationId:'chat',messageId:'b',predecessorIds:['a']} as R4QueuedMessage;
    expect(r4CausalHistory([message('a'),message('b')],state,item).map(row=>row.id)).toEqual(['b']);
  });
});

import type {AgentMessage} from '../../src/agent/types';
import type {R4AgentState,R4QueuedMessage} from '../../src/agent/r4-types';

/** Include completed predecessors and their late receipts, never later queued input. */
export function r4CausalHistory(messages:AgentMessage[],state:R4AgentState,item:R4QueuedMessage):AgentMessage[]{
  const allowed=new Set(item.predecessorIds??[]);
  const predecessors=Object.values(state.messageQueue).filter(row=>row.conversationId===item.conversationId&&allowed.has(row.messageId));
  const started=(row:R4QueuedMessage)=>row.status==='completed'||Boolean(row.startedAt)||row.status==='error';
  const intents=new Set(predecessors.filter(started).map(row=>row.userIntentRef));
  for(const predecessor of predecessors){
    if(started(predecessor)&&predecessor.assistantMessageId)allowed.add(predecessor.assistantMessageId);
    if(!started(predecessor))allowed.delete(predecessor.messageId);
  }
  for(const execution of Object.values(state.executions)){
    if(execution.conversationId!==item.conversationId||!intents.has(execution.userIntentRef))continue;
    allowed.add(`execution:${execution.id}`);
    const critique=Object.values(state.critiqueQueue).find(row=>row.executionId===execution.id&&row.status==='delivered');
    if(critique?.messageId)allowed.add(critique.messageId);
  }
  const current=messages.find(message=>message.id===item.messageId&&message.role==='user');
  if(!current)throw Error('排队消息的原始正文缺失，未创建模型请求。');
  return [...messages.filter(message=>allowed.has(message.id)&&message.id!==item.messageId&&message.status!=='streaming'),current];
}

import fs from 'node:fs';
import {createHash} from 'node:crypto';
import type {ImageContent,TextContent} from '@earendil-works/pi-ai' with {'resolution-mode':'import'};
import type {R4CritiqueQueueItem,R4Execution} from '../../src/agent/r4-types';
import type {AgentSqlStore} from './r4-store';
import type {R4ConversationQueue} from './r4-conversation-queue';
import {R4_SYSTEM_PROMPT} from '../../src/agent/r4-system-prompt';
import {runStudioPiAgent} from './pi-agent-core';
import {studioPiModel,studioPiStream} from './pi-agent-provider';
import {settingsForR4Config} from './r4-agent-service';

const now=()=>new Date().toISOString();
export interface R4CritiqueOptions{
  changed:(conversationId:string)=>void;
  assertDispatch:(execution:R4Execution)=>void;
  activeRequests?:Map<string,AbortController>;
  /** Tests may replace model transport, never the durable claiming path. */
  review?:(item:R4CritiqueQueueItem,execution:R4Execution,images:ImageContent[],signal:AbortSignal,beforeModelCall:()=>void)=>Promise<{text:string;usage?:import('../../src/agent/types').AgentTokenUsage}>;
}

/** One unique visual review per execution, sharing the real conversation lock. */
export class R4CritiqueConsumer{
  private readonly scheduled=new Set<string>();
  constructor(readonly store:AgentSqlStore,readonly messages:R4ConversationQueue,readonly options:R4CritiqueOptions){}
  isBusy(){return this.scheduled.size>0;}
  recover(){
    for(const row of Object.values(this.store.readR4State().critiqueQueue)){
      if(row.status==='running')this.finishUnavailable(row,row.dispatchStartedAt?'重启前的自动点评回执待核实，未自动重试。':'重启前的自动点评尚未提交，未自动继续；需要时可发消息请求点评。',row.dispatchStartedAt?'unknown':'blocked');
      else if(row.status==='pending')this.finishUnavailable(row,'重启前待发的自动点评未自动继续；需要时可重新发消息请求点评。','blocked');
    }
  }
  schedule(conversationId:string){
    if(this.scheduled.has(conversationId))return;
    if(!Object.values(this.store.readR4State().critiqueQueue).some(row=>row.conversationId===conversationId&&row.status==='pending'))return;
    this.scheduled.add(conversationId);
    void this.messages.withConversation(conversationId,()=>this.drain(conversationId)).then(()=>{
      this.scheduled.delete(conversationId);
      // A completion can arrive after the last drain read but before this
      // consumer releases its conversation lock.
      this.schedule(conversationId);
    },()=>this.scheduled.delete(conversationId));
  }
  pausePending(conversationId:string){
    for(const row of Object.values(this.store.readR4State().critiqueQueue))if(row.conversationId===conversationId&&row.status==='pending')
      this.finishUnavailable(row,'回复已停止，本次待发的自动点评未继续；需要时可发消息请求点评。','blocked');
  }
  private async drain(conversationId:string){
    for(;;){
      const candidate=Object.values(this.store.readR4State().critiqueQueue).find(row=>row.conversationId===conversationId&&row.status==='pending');
      if(!candidate)return;
      const state=this.store.readR4State(),execution=state.executions[candidate.executionId];
      try{if(!execution)throw Error('执行记录缺失。');this.options.assertDispatch(execution);}
      catch{this.finishUnavailable(candidate,'生成任务存在失败、待核实或配置缺失，本次未作自动视觉评价。','blocked');continue;}
      const images:ImageContent[]=[];
      try{
        for(const output of execution.outputs.filter(row=>row.status==='completed'&&row.artwork).slice(0,4)){
          const art=output.artwork!,bytes=fs.readFileSync(art.readableHandle!);
          if(bytes.length>20*1024*1024||createHash('sha256').update(bytes).digest('hex')!==art.hash)throw Error('作品文件身份已变化。');
          images.push({type:'image',data:bytes.toString('base64'),mimeType:art.mime});
        }
        if(!images.length||candidate.conversationConfig.publicParameters.visionEnabled!==true)throw Error('没有像素可发送到原对话模型。');
        settingsForR4Config(candidate.conversationConfig);
      }catch{this.finishUnavailable(candidate,'未向原对话模型送达可用图片，本次未作视觉评价。','blocked');continue;}
      const claimed=this.store.transaction(tx=>{const current=tx.getR4State(),row=current.critiqueQueue[candidate.id];
        if(row?.status!=='pending')return false;row.status='running';row.updatedAt=now();tx.setR4State(current);return true;});
      if(!claimed)continue;
      const controller=new AbortController();this.options.activeRequests?.set(conversationId,controller);
      let modelDispatchEntered=false;
      try{
        this.options.assertDispatch(execution);
        const result=await (this.options.review??reviewR4Images)(candidate,execution,images,controller.signal,()=>{
          this.options.assertDispatch(execution);controller.signal.throwIfAborted();
          this.store.transaction(tx=>{const state=tx.getR4State(),row=state.critiqueQueue[candidate.id];if(row?.status!=='running')throw Error('点评已停止，未提交。');row.dispatchStartedAt=now();row.updatedAt=now();tx.setR4State(state);});
          modelDispatchEntered=true;
        });
        controller.signal.throwIfAborted();
        if(!result.text.trim())throw Error('自动点评没有返回完整说明。');
        this.store.transaction(tx=>{const current=tx.getR4State(),workspace=tx.getWorkspace(),row=current.critiqueQueue[candidate.id];
          if(row?.status!=='running')return;
          const chat=workspace.conversations.find(chat=>chat.id===conversationId);if(!chat)throw Error('原聊天已不存在，点评结果待恢复。');
          const messageId=`critique-message:${execution.id}`;
          if(!chat.messages.some(message=>message.id===messageId))chat.messages.push({id:messageId,role:'assistant',content:result.text.trim(),attachments:[],tools:[],status:'complete',createdAt:now(),completedAt:now(),
            creationId:execution.creationId,conversationConfig:candidate.conversationConfig,usage:result.usage});
          row.status='delivered';row.messageId=messageId;row.updatedAt=now();
          current.conversations[conversationId].messageCreationIds[messageId]=execution.creationId;
          tx.setWorkspace(workspace);tx.setR4State(current);
        });
        this.options.changed(conversationId);
      }catch{this.finishUnavailable(candidate,modelDispatchEntered?'自动点评未得到完整回执，未自动重试。':'自动点评在发送前被阻断，本次未作视觉评价。',modelDispatchEntered?'unknown':'blocked');}
      finally{if(this.options.activeRequests?.get(conversationId)===controller)this.options.activeRequests.delete(conversationId);}
    }
  }
  private finishUnavailable(item:R4CritiqueQueueItem,text:string,status:'blocked'|'unknown'){
    this.store.transaction(tx=>{const state=tx.getR4State(),workspace=tx.getWorkspace(),row=state.critiqueQueue[item.id];if(!row||!['pending','running'].includes(row.status))return;
      row.status=status;row.updatedAt=now();const id=`critique-unavailable:${item.executionId}`;
      if(status==='unknown'){
        const gateId=`critique-unknown:${item.executionId}`,execution=state.executions[item.executionId];
        state.gates[gateId]??={id:gateId,conversationId:item.conversationId,turnId:execution?String(execution.approvedInput.publicParameters.turnLineageRef??execution.userIntentRef):undefined,sourceExecutionId:item.executionId,active:true,reason:'unknown_prior_receipt',createdAt:now()};
      }
      const chat=workspace.conversations.find(chat=>chat.id===item.conversationId);
      if(chat&&!chat.messages.some(message=>message.id===id))chat.messages.push({id,role:'assistant',content:text,attachments:[],tools:[],status:'complete',createdAt:now(),creationId:item.creationId});
      if(state.conversations[item.conversationId])state.conversations[item.conversationId].messageCreationIds[id]=item.creationId;
      tx.setWorkspace(workspace);tx.setR4State(state);
    });
    this.options.changed(item.conversationId);
  }
}

async function reviewR4Images(item:R4CritiqueQueueItem,execution:R4Execution,images:ImageContent[],signal:AbortSignal,beforeModelCall:()=>void){
  const settings=settingsForR4Config(item.conversationConfig);
  const context:TextContent={type:'text',text:`针对这次生成目标，简短点评下面实际提供的 ${images.length} 张图片，给一个可选的下一步建议。只评论看见的像素；未提供的输出不作评价。不要自行生成、改图或调用反推服务。\n原目标和提示词：${execution.approvedInput.requirements??''}\n${execution.approvedInput.positivePrompt}`};
  const result=await runStudioPiAgent({model:studioPiModel(settings),streamFn:studioPiStream(settings),tools:[],history:[],authorize:async()=>false,signal,beforeModelCall,
    systemPrompt:[item.conversationConfig.enabled?item.conversationConfig.body:'',R4_SYSTEM_PROMPT,'本次仅作简短视觉点评，没有可调用的工具。'].filter(Boolean).join('\n\n'),
    text:{role:'user',content:[context,...images],timestamp:Date.now()}});
  return {text:result.text,usage:{input:result.usage.input,output:result.usage.output,reasoning:result.usage.reasoning??0,cacheRead:result.usage.cacheRead,cacheWrite:result.usage.cacheWrite,total:result.usage.totalTokens}};
}

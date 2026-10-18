import {useState} from 'react';
import type {R4ConversationCreativeState, R4Execution, R4QueuedMessage} from '../agent/r4-types';
import {r4ActiveUnknownGates, r4CanContinueIndependentMessage, r4GlobalExecutions, r4GlobalQueue, r4Text, type R4UnknownGateView} from '../agent/r4-ui';
import {LuCheck, LuCircleAlert, LuLoaderCircle, LuPause, LuPlay, LuRotateCcw, LuSquare, LuX} from 'react-icons/lu';

export function AgentR4QueuePanel(props: {
  language: unknown;
  states: R4ConversationCreativeState[];
  conversationTitles: Record<string,string>;
  creationTitles: Record<string,string>;
  currentConversationId?: string;
  currentCreationId?: string;
  canSteerCurrentReply: boolean;
  visible: boolean;
  onClose: () => void;
  onResumeQueue: (executions:R4Execution[]) => void;
  onResumeMessages: (conversationId:string,messageIds?:string[],acknowledgedGateIds?:string[]) => void;
  onCancelMessage: (item:R4QueuedMessage) => void;
  onRestoreMessage: (item:R4QueuedMessage) => void;
  onSteerMessage: (item:R4QueuedMessage) => void;
  onCancelExecution: (execution:R4Execution) => void;
  onVerifyExecution: (execution:R4Execution) => void;
}) {
  const [confirmation,setConfirmation]=useState<{kind:'message';item:R4QueuedMessage;gateIds:string[]}|{kind:'image';items:R4Execution[];gateIds:string[]}>();
  const {language,states}=props;
  const t=(zh:string,en:string)=>r4Text(language,zh,en);
  if(!props.visible)return null;
  const queue=r4GlobalQueue(states);
  const executions=r4GlobalExecutions(states);
  const unknownGates=r4ActiveUnknownGates(states);
  const unknownGateIds=unknownGates.map(item=>item.gate.id);
  const confirmationStale=Boolean(confirmation&&confirmation.gateIds.join('\u0000')!==unknownGateIds.join('\u0000'));
  const requestMessageResume=(item:R4QueuedMessage)=>setConfirmation({kind:'message',item,gateIds:[...unknownGateIds]});
  const requestImageResume=(items:R4Execution[])=>setConfirmation({kind:'image',items:[...items],gateIds:[...unknownGateIds]});
  const confirmResume=()=>{
    if(!confirmation||confirmationStale)return;
    if(confirmation.kind==='message')props.onResumeMessages(confirmation.item.conversationId,[confirmation.item.messageId],confirmation.gateIds);
    else props.onResumeQueue(confirmation.items);
    setConfirmation(undefined);
  };
  const resumable=executions.filter(item=>item.status==='queued'&&Boolean(item.pauseReason));
  const pausedMessageConversations=[...new Set(queue.filter(item=>item.status==='paused').map(item=>item.conversationId))];
  const activeExecutions=executions.filter(item=>['queued','dispatching','running','cancel_requested','unknown','blocked'].includes(item.status));
  const activeMessages=queue.filter(item=>['queued','running','waiting_execution','paused'].includes(item.status));
  const recoverableMessages=queue.filter(item=>item.status==='cancelled').slice(-8).reverse();
  const stateByConversation=new Map(states.map(state=>[state.conversationId,state]));

  return <section className="r4-queue-panel" role="dialog" aria-modal="false" aria-label={t('全局队列','Global queue')}>
    <header><div><strong>{t('全局队列','Global queue')}</strong><span>{activeExecutions.length+activeMessages.length} {t('个待处理项目','active items')}</span></div><button className="r4-queue-close" type="button" aria-label={t('关闭队列','Close queue')} onClick={props.onClose}><LuX/></button></header>
    {(resumable.length>0||pausedMessageConversations.length>0)&&<div className="r4-queue-resume-bar"><span><LuPause/>{t('已暂停的任务不会自动重发。','Paused tasks are never resent automatically.')}</span>{resumable.length>0&&<button type="button" onClick={()=>requestImageResume(resumable)}><LuPlay/>{t('继续图片队列','Resume image queue')} · {resumable.length}</button>}{pausedMessageConversations.includes(props.currentConversationId??'')&&unknownGates.length===0&&<button type="button" onClick={()=>props.onResumeMessages(props.currentConversationId!)}><LuPlay/>{t('继续当前对话文字队列','Resume this chat')}</button>}{pausedMessageConversations.includes(props.currentConversationId??'')&&unknownGates.length>0&&<span className="r4-queue-gate-hint">{t('存在待核实回执；请选择一条无关的新消息并明确确认。','Unknown receipts remain; explicitly continue an unrelated new message.')}</span>}</div>}
    {unknownGates.length>0&&<section className="r4-unknown-gates" aria-label={t('待核实的收费回执','Unknown paid receipts')} role="alert"><header><LuCircleAlert/><strong>{t('待核实的收费回执','Unknown paid receipts')} · {unknownGates.length}</strong></header><p>{t('这些记录会保留。继续独立新消息不会重新发送原请求；新回执仍会正常阻断。','These records remain in history. Continuing an independent new message never resends the old request; any new unknown receipt still blocks dispatch.')}</p>{unknownGates.map(view=><UnknownGateSummary key={view.gate.id} view={view} states={states} conversationTitles={props.conversationTitles} creationTitles={props.creationTitles} language={language}/>)}</section>}
    <div className="r4-queue-scroll">
      <section className="r4-queue-group"><h3>{t('图像任务','Image executions')}</h3>
        {activeExecutions.length===0&&<p className="r4-queue-empty">{t('没有活动的图像任务。','No active image executions.')}</p>}
        {activeExecutions.map(execution=>{
          const canCancel=['queued','dispatching','running','cancel_requested'].includes(execution.status);
          const needsVerify=execution.status==='unknown'||execution.providerReceiptStatus==='unknown';
          const outputs=execution.outputs.filter(item=>item.status==='completed').length;
          const state=stateByConversation.get(execution.conversationId);
          const creation=state?.creations[execution.creationId];
          return <article className={`r4-queue-item r4-execution-item r4-execution-${execution.status}`} key={execution.id}>
            <div className="r4-queue-item-heading">{['queued','dispatching','running','cancel_requested'].includes(execution.status)?<LuLoaderCircle/>:needsVerify?<LuCircleAlert/>:<LuCheck/>}<strong>{creation?.title||props.creationTitles[execution.creationId]||t('创作','Creation')}</strong><span className={`r4-status-badge r4-status-${execution.status}`}>{executionStatusText(language,execution)}</span></div>
            <p>{props.conversationTitles[execution.conversationId]||execution.conversationId} · {outputs}/{execution.expectedOutputCount} {t('张','outputs')}</p>
            {execution.pauseReason&&<small className="r4-queue-reason">{execution.pauseReason}</small>}
            {execution.blockedReason&&<small className="r4-queue-reason is-error">{execution.blockedReason}</small>}
            {execution.status==='completed'&&execution.providerCancellation==='requested'&&<small>{t('已完成，未取消。','Completed; not cancelled.')}</small>}
            <footer>{needsVerify&&<button type="button" onClick={()=>props.onVerifyExecution(execution)}><LuRotateCcw/>{t('核实状态','Verify status')}</button>}{canCancel&&<button type="button" className="r4-danger-action" onClick={()=>props.onCancelExecution(execution)}><LuSquare/>{execution.status==='cancel_requested'?t('取消请求已发出','Cancellation requested'):t('取消任务','Cancel task')}</button>}{execution.status==='queued'&&execution.pauseReason&&<button type="button" onClick={()=>requestImageResume([execution])}><LuPlay/>{t('继续此任务','Resume this task')}</button>}</footer>
          </article>;
        })}
      </section>
      <section className="r4-queue-group"><h3>{t('文字消息','Text messages')}</h3>
        {activeMessages.length===0&&<p className="r4-queue-empty">{t('没有排队或暂停的消息。','No queued or paused messages.')}</p>}
        {activeMessages.map(item=>{
          const state=stateByConversation.get(item.conversationId);
          const creation=item.creationId?state?.creations[item.creationId]:undefined;
          const canContinue=unknownGates.length>0&&r4CanContinueIndependentMessage(item,unknownGates.map(view=>view.gate));
          const belongsToUnknown=unknownGates.some(view=>view.gate.turnId===item.userIntentRef);
          return <article className={`r4-queue-item r4-message-queue-item r4-message-${item.status}`} key={item.id}>
            <div className="r4-queue-item-heading">{item.status==='running'?<LuLoaderCircle/>:item.status==='paused'?<LuPause/>:<LuCheck/>}<strong>{creation?.title||props.creationTitles[item.creationId??'']||t('全部对话','All messages')}</strong><span className={`r4-status-badge r4-status-${item.status}`}>{queueStatusText(language,item.status)}</span></div>
            <p>{props.conversationTitles[item.conversationId]||item.conversationId} · #{item.sequence}</p>
            <div className="r4-queue-message-preview">{item.text||t('无文字内容','No text content')}</div>
            {item.draftRecovery&&<small className={`r4-draft-recovery r4-recovery-${item.draftRecovery.status}`}>{draftRecoveryText(language,item.draftRecovery.status)}</small>}
            {item.legacyStatus&&<small className="r4-legacy-note">{t('历史消息未版本化','Legacy message is unversioned')}</small>}
            {belongsToUnknown&&<small className="r4-queue-reason is-error">{t('此消息属于待核实请求，不会重发。可恢复为新草稿并重新检查。','This message belongs to an unknown request and will not be resent. Restore it as a new draft for review.')}</small>}
            <footer>{item.status==='queued'&&<button type="button" className="r4-danger-action" onClick={()=>props.onCancelMessage(item)}><LuX/>{t('取消排队','Cancel')}</button>}{item.status==='queued'&&props.canSteerCurrentReply&&item.conversationId===props.currentConversationId&&item.creationId===props.currentCreationId&&<button type="button" onClick={()=>props.onSteerMessage(item)}><LuPlay/>{t('立即引导回复','Guide current reply')}</button>}{canContinue&&<button type="button" onClick={()=>requestMessageResume(item)}><LuPlay/>{t('继续这条新消息','Continue this new message')}</button>}{item.status==='paused'&&item.conversationId===props.currentConversationId&&unknownGates.length===0&&<button type="button" onClick={()=>props.onResumeMessages(item.conversationId)}><LuPlay/>{t('继续文字队列','Resume messages')}</button>}{item.status==='cancelled'&&<button type="button" onClick={()=>props.onRestoreMessage(item)}><LuRotateCcw/>{t('恢复为草稿','Restore as draft')}</button>}</footer>
          </article>;
        })}
        {recoverableMessages.length>0&&<details className="r4-cancelled-messages"><summary>{t('已取消的消息','Cancelled messages')} · {recoverableMessages.length}</summary>{recoverableMessages.map(item=><article className="r4-queue-item r4-message-queue-item r4-message-cancelled" key={item.id}><div className="r4-queue-item-heading"><LuX/><strong>{props.conversationTitles[item.conversationId]||item.conversationId} · #{item.sequence}</strong></div><div className="r4-queue-message-preview">{item.text||t('无文字内容','No text content')}</div>{item.draftRecovery&&<small className={`r4-draft-recovery r4-recovery-${item.draftRecovery.status}`}>{draftRecoveryText(language,item.draftRecovery.status)}</small>}<footer><button type="button" onClick={()=>props.onRestoreMessage(item)}><LuRotateCcw/>{t('恢复为草稿','Restore as draft')}</button></footer></article>)}</details>}
      </section>
    </div>
    {confirmation&&<div className="r4-resume-confirm-backdrop" role="presentation"><section className="r4-resume-confirm" role="alertdialog" aria-modal="true" aria-labelledby="r4-resume-confirm-title" aria-describedby="r4-resume-confirm-description"><header><strong id="r4-resume-confirm-title">{confirmation.kind==='message'?t('明确继续一条新消息','Explicitly continue one new message'):t('确认恢复图片任务','Confirm image task recovery')}</strong><button type="button" aria-label={t('关闭确认','Close confirmation')} onClick={()=>setConfirmation(undefined)}><LuX/></button></header><div className="r4-resume-confirm-body">{confirmation.kind==='message'?<><h3>{t('这条新消息将继续','This new message will continue')}</h3><p>{props.conversationTitles[confirmation.item.conversationId]||confirmation.item.conversationId} · {t('消息','message')} <code>{confirmation.item.messageId}</code></p><pre>{confirmation.item.text||t('（此消息没有文字内容，可能包含附件或动作。）','(This message has no text and may contain attachments or actions.)')}</pre><p id="r4-resume-confirm-description" className="r4-resume-confirm-warning">{t('确认即表示：只继续上面这条未启动的新消息；下面列出的旧请求绝不重发，待核实记录也不会删除。若本次产生新的未知回执，后续收费操作仍会暂停。','Confirming continues only this unstarted new message. The old requests listed below will never be resent, and their records will remain. A new unknown receipt will still pause later paid operations.')}</p></>:<><h3>{t('仅恢复这些明确列出的执行','Only these exact executions will resume')}</h3><ul>{confirmation.items.map(item=><li key={item.id}><code>{item.id}</code><span>{props.creationTitles[item.creationId]||props.states.find(state=>state.conversationId===item.conversationId)?.creations[item.creationId]?.title||t('创作','Creation')} · {item.expectedOutputCount} {t('张','outputs')}</span>{item.pauseReason&&<small>{item.pauseReason}</small>}</li>)}</ul><p id="r4-resume-confirm-description" className="r4-resume-confirm-warning">{t('只向 resume_queue 提交上面列出的执行ID。待核实旧请求不会重发，下面的未知回执记录保持原样。','Only the execution IDs above are passed to resume_queue. No old unknown request is resent, and the receipt records below remain unchanged.')}</p></>}{unknownGates.length>0&&<><h3>{t('当前待核实来源','Current unknown receipt sources')}</h3><div className="r4-resume-confirm-gates">{unknownGates.map(view=><UnknownGateSummary key={view.gate.id} view={view} states={states} conversationTitles={props.conversationTitles} creationTitles={props.creationTitles} language={language}/>)}</div></>}{confirmationStale&&<p role="alert" className="r4-resume-confirm-stale">{t('待核实记录在确认期间已变化。请关闭后重新查看。','Unknown receipts changed while this confirmation was open. Close it and review again.')}</p>}</div><footer><button type="button" onClick={()=>setConfirmation(undefined)}>{t('返回队列','Back to queue')}</button><button type="button" className="pi-primary" autoFocus disabled={confirmationStale} onClick={confirmResume}>{confirmation.kind==='message'?t('确认继续这条新消息','Continue this new message'):t('确认恢复列出的任务','Resume listed tasks')}</button></footer></section></div>}
  </section>;
}

function UnknownGateSummary(props:{view:R4UnknownGateView;states:R4ConversationCreativeState[];conversationTitles:Record<string,string>;creationTitles:Record<string,string>;language:unknown}){
  const {view,states,conversationTitles,creationTitles,language}=props;
  const t=(zh:string,en:string)=>r4Text(language,zh,en);
  const state=states.find(item=>item.conversationId===view.gate.conversationId);
  let source:string,detail:string|undefined;
  if(view.source==='paid-service'){
    source=t('付费服务','Paid service');detail=view.detail;
  }else if(view.source==='critique'){
    source=t('付费点评','Paid critique');
    const execution=view.execution;
    detail=execution?`${creationTitles[execution.creationId]||state?.creations[execution.creationId]?.title||execution.id} · ${execution.id}`:view.gate.sourceExecutionId;
  }else if(view.source==='image-execution'){
    source=t('图片任务','Image execution');
    const execution=view.execution;
    detail=execution?`${creationTitles[execution.creationId]||state?.creations[execution.creationId]?.title||execution.id} · ${execution.id}`:view.gate.sourceExecutionId;
  }else source=t('来源未关联','Unlinked receipt source');
  return <article className="r4-unknown-gate-item"><div><strong>{source}</strong><span>{conversationTitles[view.gate.conversationId]||view.gate.conversationId}</span></div>{detail&&<p>{detail}</p>}<small>{t('状态：回执待核实','Status: receipt unknown')} · {t('记录ID','Record ID')} <code>{view.gate.id}</code></small></article>;
}

function executionStatusText(language:unknown,execution:R4Execution):string {
  const t=(zh:string,en:string)=>r4Text(language,zh,en);
  if(execution.status==='completed'&&execution.providerCancellation==='requested')return t('已完成，未取消','Completed, not cancelled');
  const labels:Record<R4Execution['status'],[string,string]>={
    queued:['排队中','Queued'],dispatching:['正在提交','Dispatching'],running:['生成中','Running'],cancel_requested:['正在确认取消','Cancellation pending'],completed:['已完成','Completed'],partial:['部分完成','Partial'],error:['失败','Error'],cancelled:['已取消','Cancelled'],unknown:['待核实','Needs verification'],blocked:['已阻断','Blocked'],denied:['已拒绝','Denied'],
  };
  return t(...labels[execution.status]);
}

function queueStatusText(language:unknown,status:R4QueuedMessage['status']):string {
  const labels:Record<R4QueuedMessage['status'],[string,string]>={queued:['排队中','Queued'],running:['回复中','Running'],waiting_execution:['等待图像任务','Waiting for image task'],paused:['已暂停','Paused'],completed:['已完成','Completed'],cancelled:['已取消','Cancelled'],error:['错误','Error']};
  return r4Text(language,...labels[status]);
}

function draftRecoveryText(language:unknown,status:NonNullable<R4QueuedMessage['draftRecovery']>['status']):string {
  const labels:Record<NonNullable<R4QueuedMessage['draftRecovery']>['status'],[string,string]>={unchanged:['草稿未变化，可安全恢复','Draft unchanged; safe to restore'],changed:['草稿已变化，恢复不会覆盖新内容','Draft changed; restore will preserve new text'],conflict:['草稿版本冲突，需要检查','Draft version conflict; review required'],legacy_unversioned:['历史草稿未版本化','Legacy draft is unversioned']};
  return r4Text(language,...labels[status]);
}

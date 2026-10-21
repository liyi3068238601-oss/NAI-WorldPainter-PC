import type {R4Creation, R4QueuedMessage} from '../agent/r4-types';
import {r4Text} from '../agent/r4-ui';
import {studioUxText} from '../agent/ux';
import {LuChevronDown, LuLayers, LuListChecks, LuMessageSquare, LuPlus, LuPanelLeftOpen, LuPanelRightOpen} from 'react-icons/lu';

function creationTitle(language: unknown, creation: R4Creation): string {
  const name = creation.title || r4Text(language, '未命名创作', 'Untitled creation');
  const details = [
    r4Text(language, `创作：${name}`, `Creation: ${name}`),
    r4Text(language, `输入修订：v${creation.inputRevision}`, `Input revision: v${creation.inputRevision}`),
    r4Text(language, `关联作品：${creation.artworkIds.length}`, `Linked artworks: ${creation.artworkIds.length}`),
    studioUxText(language, 'creationScopeHint'),
  ];
  if (creation.legacyStatus === 'legacy_unversioned') details.push(studioUxText(language, 'legacyCreationHint'));
  return details.join('\n');
}

export function AgentR4CreationControls(props: {
  language: unknown;
  compact?: boolean;
  conversationTitle: string;
  creations: R4Creation[];
  currentCreationId?: string;
  scope: 'all' | 'creation';
  queueCount: number;
  queueOpen: boolean;
  resourcesOpen: boolean;
  disabled: boolean;
  onScope: (scope: 'all' | 'creation') => void;
  onSelectCreation: (creationId: string) => void;
  onCreateCreation: () => void;
  onToggleChats: () => void;
  onToggleQueue: () => void;
  onToggleResources: () => void;
}) {
  const {language, conversationTitle, creations, currentCreationId, scope, queueCount, disabled} = props;
  const current = creations.find(item => item.id === currentCreationId);
  return <header className="r4-topbar">
    <div className="r4-topbar-left">
      <button className="r4-topbar-drawer" type="button" aria-label={r4Text(language, '聊天', 'Chats')} title={r4Text(language, '聊天', 'Chats')} onClick={props.onToggleChats}><LuPanelLeftOpen/><span>{r4Text(language, '聊天', 'Chats')}</span></button>
      <div className="r4-chat-title"><LuMessageSquare aria-hidden/><span title={conversationTitle}>{conversationTitle || r4Text(language, '新对话', 'New chat')}</span></div>
    </div>
    <details className="r4-topbar-tasks"><summary>{r4Text(language,'任务范围','Task scope')}</summary><div className="r4-topbar-center">
      <label className="r4-creation-select"><span title={studioUxText(language, 'creationScopeHint')}><LuLayers aria-hidden/>{r4Text(language, '当前创作', 'Current creation')}</span>
        <select aria-label={r4Text(language, '当前创作', 'Current creation')} title={current ? creationTitle(language, current) : studioUxText(language, 'creationScopeHint')} disabled={disabled} value={currentCreationId ?? ''} onChange={event => {if(event.target.value)props.onSelectCreation(event.target.value);}}>
          {!current&&<option value="">{creations.length ? r4Text(language, '选择创作', 'Choose a creation') : r4Text(language, '暂无创作', 'No creations')}</option>}
          {creations.map((creation,index)=><option key={creation.id} value={creation.id} title={creationTitle(language, creation)}>{creation.title || `${r4Text(language, '创作', 'Creation')} ${index+1}`}</option>)}
        </select><LuChevronDown aria-hidden/>
      </label>
      <button type="button" className="r4-create-creation" disabled={disabled} onClick={props.onCreateCreation}><LuPlus/><span>{r4Text(language, '新建创作', 'New creation')}</span></button>
      <div className="r4-scope-switch" role="group" aria-label={r4Text(language, '消息范围', 'Message scope')}>
        <button type="button" aria-pressed={scope==='all'} onClick={()=>props.onScope('all')}>{r4Text(language, '全部对话', 'All messages')}</button>
        <button type="button" aria-pressed={scope==='creation'} disabled={!currentCreationId} onClick={()=>props.onScope('creation')}>{r4Text(language, '当前创作', 'This creation')}</button>
      </div>
    </div>
    </details>
    <div className="r4-topbar-right">
      <button className={`r4-queue-toggle${props.queueOpen?' is-active':''}`} type="button" aria-expanded={props.queueOpen} onClick={props.onToggleQueue}><LuListChecks/><span>{r4Text(language, '队列', 'Queue')}</span>{queueCount>0&&<b>{queueCount}</b>}</button>
      <button className="r4-topbar-drawer" type="button" aria-label={r4Text(language, '资源', 'Resources')} title={r4Text(language, '资源', 'Resources')} aria-expanded={props.resourcesOpen} onClick={props.onToggleResources}><LuPanelRightOpen/><span>{r4Text(language, '资源', 'Resources')}</span></button>
    </div>
  </header>;
}

export function countR4QueueItems(items: readonly R4QueuedMessage[]): number {
  return items.filter(item => ['queued','running','waiting_execution','paused'].includes(item.status)).length;
}

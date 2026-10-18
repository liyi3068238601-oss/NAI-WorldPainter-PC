import type {R4AssistantPreset, R4AssistantPresetBinding, R4ConversationConfigSnapshot, R4Creation, R4QueuedMessage} from '../agent/r4-types';
import {r4Text} from '../agent/r4-ui';
import {LuChevronDown, LuLayers, LuListChecks, LuMessageSquare, LuPlus, LuPanelLeftOpen, LuPanelRightOpen, LuSparkles} from 'react-icons/lu';

export function AgentR4CreationControls(props: {
  language: unknown;
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
    <div className="r4-topbar-center">
      <label className="r4-creation-select"><span><LuLayers aria-hidden/>{r4Text(language, '当前创作', 'Current creation')}</span>
        <select aria-label={r4Text(language, '当前创作', 'Current creation')} disabled={disabled} value={currentCreationId ?? ''} onChange={event => {if(event.target.value)props.onSelectCreation(event.target.value);}}>
          {!current&&<option value="">{creations.length ? r4Text(language, '选择创作', 'Choose a creation') : r4Text(language, '暂无创作', 'No creations')}</option>}
          {creations.map((creation,index)=><option key={creation.id} value={creation.id}>{creation.title || `${r4Text(language, '创作', 'Creation')} ${index+1}`}</option>)}
        </select><LuChevronDown aria-hidden/>
      </label>
      <button type="button" className="r4-create-creation" disabled={disabled} onClick={props.onCreateCreation}><LuPlus/><span>{r4Text(language, '新建创作', 'New creation')}</span></button>
      <div className="r4-scope-switch" role="group" aria-label={r4Text(language, '消息范围', 'Message scope')}>
        <button type="button" aria-pressed={scope==='all'} onClick={()=>props.onScope('all')}>{r4Text(language, '全部对话', 'All messages')}</button>
        <button type="button" aria-pressed={scope==='creation'} disabled={!currentCreationId} onClick={()=>props.onScope('creation')}>{r4Text(language, '当前创作', 'This creation')}</button>
      </div>
    </div>
    <div className="r4-topbar-right">
      <button className={`r4-queue-toggle${props.queueOpen?' is-active':''}`} type="button" aria-expanded={props.queueOpen} onClick={props.onToggleQueue}><LuListChecks/><span>{r4Text(language, '队列', 'Queue')}</span>{queueCount>0&&<b>{queueCount}</b>}</button>
      <button className="r4-topbar-drawer" type="button" aria-label={r4Text(language, '当前创作', 'Current creation')} title={r4Text(language, '当前创作', 'Current creation')} aria-expanded={props.resourcesOpen} onClick={props.onToggleResources}><LuPanelRightOpen/><span>{r4Text(language, '当前创作', 'Current creation')}</span></button>
    </div>
  </header>;
}

export function AgentR4AssistantPresetControl(props: {
  language: unknown;
  presets: Record<string, R4AssistantPreset>;
  binding?: R4AssistantPresetBinding;
  defaults?: R4AssistantPresetBinding;
  restoredConfig?: R4ConversationConfigSnapshot;
  disabled: boolean;
  onChange: (presetId: string, enabled: boolean) => void;
  onSetDefault: (presetId: string, enabled: boolean) => void;
}) {
  const {language, presets, binding, defaults, disabled} = props;
  // A chat with no explicit override displays the seeded new-chat default.
  // Any write still sends a concrete preset ID; this control never clears the binding.
  const effectiveBinding = props.restoredConfig
    ? props.restoredConfig.presetId ? {presetId:props.restoredConfig.presetId,enabled:props.restoredConfig.enabled,legacyStatus:props.restoredConfig.legacyStatus} : undefined
    : binding ?? defaults;
  const selectedId = effectiveBinding?.presetId ?? '';
  const enabled = effectiveBinding?.enabled ?? false;
  const selectedPreset = selectedId ? presets[selectedId] : undefined;
  const isEnglish = typeof language === 'string' && language.toLowerCase().startsWith('en');
  const unknownLegacy = Boolean(effectiveBinding?.legacyStatus || (selectedId && !selectedPreset));
  const defaultMatches = defaults?.presetId === selectedId && defaults.enabled === enabled;
  return <div className="r4-preset-control" aria-label={r4Text(language, '助手预设', 'Assistant preset')}>
    <label className="r4-preset-choice"><span><LuSparkles aria-hidden/>{r4Text(language, '助手预设', 'Assistant preset')}</span>
      <select aria-label={r4Text(language, '助手预设', 'Assistant preset')} disabled={disabled} value={selectedId} onChange={event=>{if(event.target.value)props.onChange(event.target.value,enabled);}}>
        {!selectedId&&<option value="" disabled>{props.restoredConfig?.presetId===null?(isEnglish?'Restored config has no preset':'恢复配置未使用预设'):isEnglish?'Preset is initializing':'预设初始化中'}</option>}
        {selectedId&&!selectedPreset&&<option value={selectedId} disabled>{isEnglish?'Unavailable legacy preset':'不可用的历史预设'}</option>}
        {Object.values(presets).sort((a,b)=>a.name.localeCompare(b.name)).map(preset=><option key={preset.id} value={preset.id}>{preset.name}{preset.legacyStatus?' · legacy':''}</option>)}
      </select>
    </label>
    <label className="r4-preset-enabled"><input type="checkbox" checked={enabled} disabled={disabled||!selectedId||unknownLegacy} onChange={event=>props.onChange(selectedId,event.target.checked)}/><span>{r4Text(language, '启用', 'Enabled')}</span></label>
    {selectedPreset&&<small className="r4-preset-revision" title={`${selectedPreset.hash} · rev ${selectedPreset.revision}`}>v{selectedPreset.revision}</small>}
    {unknownLegacy&&<small className="r4-legacy-note" role="status">{selectedPreset?r4Text(language, '历史配置未版本化', 'Legacy settings are unversioned'):r4Text(language, `历史预设不可用：${selectedId}。请重新选择。`,`Unavailable preset: ${selectedId}. Choose a replacement.`)}</small>}
    <button type="button" disabled={disabled||!selectedId||unknownLegacy||defaultMatches} title={defaultMatches?r4Text(language,'已是新会话默认','Already the new-chat default'):undefined} onClick={()=>props.onSetDefault(selectedId,enabled)}>{r4Text(language, '设为新会话默认', 'Set as new-chat default')}</button>
  </div>;
}

export function countR4QueueItems(items: readonly R4QueuedMessage[]): number {
  return items.filter(item => ['queued','running','waiting_execution','paused'].includes(item.status)).length;
}

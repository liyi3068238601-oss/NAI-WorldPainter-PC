import {MotionDisclosure} from './MotionDisclosure';
import {useStudioRegionMotion} from '../use-studio-motion';
import type {AgentUiPreferences} from '../agent/preferences';
import {useState,type ReactNode} from 'react';
import {LuBookOpen,LuCheck,LuFileText,LuUserRound,LuImport,LuChevronDown,LuBrain,LuSparkles} from 'react-icons/lu';
import type {AgentConversation,AgentWorkspaceData} from '../agent/types';
import type {StudioConversationOptions} from '../agent/workspace-controls';
import type {R4AssistantPreset,R4AssistantPresetBinding,R4ConversationConfigSnapshot} from '../agent/r4-types';
import {r4Text} from '../agent/r4-ui';
import {studioUxText} from '../agent/ux';
import {MemoryManager} from '../agent/MemoryManager';
import {AgentSkillsPanel} from './AgentSkillsPanel';

/** All resource types share one compact row; descriptive content is opt-in. */
function ResourceRow({name,title,icon,selected,disabled,onSelect,detailsLabel,multiple=false,children}:{name:string;title?:string;icon:ReactNode;selected:boolean;disabled:boolean;onSelect:()=>void;detailsLabel:string;multiple?:boolean;children:ReactNode}){
 const [expanded,setExpanded]=useState(false);
 return <article className="pi-resource-item" role="listitem">
  <div className="pi-resource-row"><button className="pi-resource-select" title={title??name} disabled={disabled} role={multiple?'checkbox':undefined} aria-checked={multiple?selected:undefined} aria-pressed={multiple?undefined:selected} onClick={onSelect}>{icon}<span>{name}</span><LuCheck className={selected?'pi-resource-selected':'pi-resource-unselected'} aria-hidden/></button><button className="pi-resource-details-toggle" aria-label={`${detailsLabel}: ${name}`} title={detailsLabel} aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}><LuChevronDown aria-hidden/></button></div>
  <MotionDisclosure open={expanded}><div className="pi-resource-details">{children}</div></MotionDisclosure>
 </article>;
}
export interface AgentR4AssistantPresetControlProps {
 language:unknown;
 presets:Record<string,R4AssistantPreset>;
 binding?:R4AssistantPresetBinding;
 defaults?:R4AssistantPresetBinding;
 restoredConfig?:R4ConversationConfigSnapshot;
 disabled:boolean;
 onChange:(presetId:string,enabled:boolean)=>void;
 onSetDefault:(presetId:string,enabled:boolean)=>void;
}

const BUILTIN_PRESET_NAMES:Record<string,string>={
 'dsh-infinite-gen-5':'presetInfiniteFive','dsh-infinite-gen-4':'presetInfinite','studio-complete':'presetComplete',
};

/** The resource list and its actions share the exact binding used by R4 sends. */
export function AgentR4AssistantPresetControl(props:AgentR4AssistantPresetControlProps){
 const {language,presets,binding,defaults,disabled}=props;
 const t=(key:string)=>studioUxText(language,key);
 const effectiveBinding=props.restoredConfig
  ? props.restoredConfig.presetId?{presetId:props.restoredConfig.presetId,enabled:props.restoredConfig.enabled,legacyStatus:props.restoredConfig.legacyStatus}:undefined
  : binding??defaults;
 const selectedId=effectiveBinding?.presetId??'',enabled=effectiveBinding?.enabled??false;
 const selectedPreset=presets[selectedId];
 const unknownLegacy=Boolean(effectiveBinding?.legacyStatus||(selectedId&&!selectedPreset));
 const defaultMatches=defaults?.presetId===selectedId&&defaults.enabled===enabled;
 return <div className="pi-assistant-presets">
  <div className="r4-preset-control" aria-label={t('assistantRolePreset')} title={t('assistantRolePresetHint')}>
   <strong>{t('assistantRolePreset')}</strong>
   <label className="r4-preset-enabled"><input type="checkbox" checked={enabled} disabled={disabled||!selectedId||unknownLegacy} onChange={event=>props.onChange(selectedId,event.target.checked)}/><span>{r4Text(language,'启用','Enabled')}</span></label>
   {selectedPreset&&<small className="r4-preset-revision" title={`${selectedPreset.hash} · rev ${selectedPreset.revision}`}>v{selectedPreset.revision}</small>}
   <button type="button" disabled={disabled||!selectedId||unknownLegacy||defaultMatches} title={defaultMatches?r4Text(language,'已是新会话默认','Already the new-chat default'):undefined} onClick={()=>props.onSetDefault(selectedId,enabled)}>{r4Text(language,'设为新会话默认','Set as new-chat default')}</button>
  </div>
  {unknownLegacy&&<p className="r4-legacy-note" role="status">{selectedPreset?r4Text(language,'历史配置未版本化','Legacy settings are unversioned'):r4Text(language,`历史预设不可用：${selectedId}。请重新选择。`,`Unavailable preset: ${selectedId}. Choose a replacement.`)}</p>}
  {props.restoredConfig?.presetId===null&&<p className="pi-muted">{r4Text(language,'恢复配置未使用预设','Restored config has no preset')}</p>}
  <div className="pi-resource-list" role="list">
   {Object.values(presets).sort((a,b)=>a.name.localeCompare(b.name)).map(preset=>{
    const builtin= preset.source==='builtin'&&BUILTIN_PRESET_NAMES[preset.id]===preset.name;
    const name=builtin?t(preset.name):preset.name;
    const title=`${name}\n${r4Text(language,`原始名称：${preset.name}`,`Original name: ${preset.name}`)}\nID: ${preset.id}`;
    return <ResourceRow key={preset.id} name={name} title={title} icon={<LuFileText/>} selected={selectedId===preset.id} disabled={disabled} onSelect={()=>props.onChange(preset.id,enabled)} detailsLabel={t('details')}>
     {builtin&&<p>{t(preset.name+'Body')}</p>}<pre>{preset.body}</pre>
     {builtin&&['dsh-infinite-gen-5','dsh-infinite-gen-4'].includes(preset.id)&&<a href={`https://github.com/Minglink/${preset.id}`} onClick={event=>{event.preventDefault();void window.naiDesktop.openExternal(`https://github.com/Minglink/${preset.id}`)}}>Minglink · CC BY-NC-SA 4.0</a>}
    </ResourceRow>;
   })}
  </div>
 </div>;
}

export function AgentResourcePanel({workspace,chat,language,disabled,presetControl,onChange,onImport,onWorkspaceChange,tab,onTab}:{workspace?:AgentWorkspaceData;chat?:AgentConversation;language:unknown;disabled:boolean;presetControl:Omit<AgentR4AssistantPresetControlProps,'language'>;onChange:(patch:Partial<StudioConversationOptions>)=>void;onImport:(kind:'presets'|'characters')=>void;onWorkspaceChange:(workspace:AgentWorkspaceData)=>void;tab:NonNullable<AgentUiPreferences['resourceTab']>;onTab:(tab:NonNullable<AgentUiPreferences['resourceTab']>)=>void}){
 const region=useStudioRegionMotion(tab);
 const t=(key:string)=>studioUxText(language,key);
 return <aside id="pi-creative-resources" className="pi-resource-panel" aria-label={t('resources')}>
  <header><strong><LuBookOpen/>{t('resources')}</strong></header>
  <div className="pi-resource-tabs" role="tablist" aria-label={t('resources')}>{(['presets','skills','characters','memories'] as const).map(value=><button key={value} id={'pi-resource-tab-'+value} role="tab" aria-selected={tab===value} aria-controls={'pi-resource-'+value} onClick={()=>onTab(value)}>{value==='presets'?<LuFileText/>:value==='skills'?<LuSparkles/>:value==='characters'?<LuUserRound/>:<LuBrain/>}{t('resource_'+value)}</button>)}</div>
  <section ref={region} className="pi-resource-body" role="tabpanel" id={'pi-resource-'+tab} aria-labelledby={'pi-resource-tab-'+tab}>
   {(tab==='presets'||tab==='characters')&&<button className="pi-resource-import" disabled={disabled} onClick={()=>onImport(tab)}><LuImport/>{t('import_'+tab)}</button>}
   {tab==='memories'&&<MemoryManager workspace={workspace} conversationId={chat?.id} disabled={disabled} language={language} onWorkspaceChange={onWorkspaceChange}/>}
   {tab==='skills'&&<AgentSkillsPanel workspace={workspace} chat={chat} language={language} disabled={disabled} onWorkspaceChange={onWorkspaceChange} onChange={onChange}/>}
   {tab==='presets'&&<AgentR4AssistantPresetControl language={language} {...presetControl}/>}
   {tab==='characters'&&<div className="pi-resource-list" role="list">
    {workspace?.characters.map(card=><ResourceRow key={card.id} name={card.nickname||card.name} icon={card.avatarDataUrl?<img className="pi-resource-avatar" src={card.avatarDataUrl} alt=""/>:<LuUserRound/>} selected={chat?.characterIds.includes(card.id)??false} disabled={disabled} onSelect={()=>onChange({characterIds:[card.id],activeCharacterId:card.id})} detailsLabel={t('details')}><p>{card.description}</p>{card.personality&&<p>{card.personality}</p>}{card.scenario&&<p>{card.scenario}</p>}{card.systemPrompt&&<pre>{card.systemPrompt}</pre>}</ResourceRow>)}
   </div>}
   {tab==='characters'&&!workspace?.characters.length&&<p className="pi-muted">{t('noResources')}</p>}
  </section>
 </aside>;
}

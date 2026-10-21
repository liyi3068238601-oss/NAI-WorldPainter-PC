import {useId,useLayoutEffect,useRef,useState,type FormEvent,type ReactNode} from 'react';
import {LuBookOpen,LuCheck,LuFileText,LuPlus,LuPencil,LuX,LuChevronDown,LuBrain,LuSparkles} from 'react-icons/lu';
import type {AgentUiPreferences} from '../agent/preferences';
import type {AgentConversation,AgentWorkspaceData} from '../agent/types';
import type {StudioConversationOptions} from '../agent/workspace-controls';
import type {R4AssistantPreset,R4AssistantPresetBinding,R4ConversationConfigSnapshot} from '../agent/r4-types';
import type {R4CreativeCommandResult} from '../agent/r4-commands';
import {r4Text} from '../agent/r4-ui';
import {studioUxText} from '../agent/ux';
import {MemoryManager} from '../agent/MemoryManager';
import {AgentSkillsPanel} from './AgentSkillsPanel';
import {AppPortal} from './ui';
import {MotionDisclosure} from './MotionDisclosure';
import {useStudioRegionMotion} from '../use-studio-motion';

/** All resource types share one compact row; descriptive content is opt-in. */
function ResourceRow({name,title,icon,selected,disabled,onSelect,detailsLabel,children}:{name:string;title?:string;icon:ReactNode;selected:boolean;disabled:boolean;onSelect:()=>void;detailsLabel:string;children:ReactNode}){
 const [expanded,setExpanded]=useState(false);
 return <article className="pi-resource-item" role="listitem">
  <div className="pi-resource-row"><button className="pi-resource-select" title={title??name} disabled={disabled} aria-pressed={selected} onClick={onSelect}>{icon}<span>{name}</span><LuCheck className={selected?'pi-resource-selected':'pi-resource-unselected'} aria-hidden/></button><button type="button" className="pi-resource-details-toggle" aria-label={`${detailsLabel}: ${name}`} title={detailsLabel} aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}><LuChevronDown aria-hidden/></button></div>
  <MotionDisclosure open={expanded}><div className="pi-resource-details">{children}</div></MotionDisclosure>
 </article>;
}

type PresetEditorState={mode:'create';presetId:string;name:string;body:string}|{mode:'edit';presetId:string;expectedRevision:number;name:string;body:string};
const MAX_PRESET_NAME_LENGTH=100;
const MAX_PRESET_BODY_LENGTH=1_000_000;

function AssistantPresetEditor({language,editor,busy,error,onClose,onName,onBody,onSubmit}:{language:unknown;editor:PresetEditorState;busy:boolean;error:string;onClose:()=>void;onName:(value:string)=>void;onBody:(value:string)=>void;onSubmit:(event:FormEvent<HTMLFormElement>)=>void}){
 const titleId=useId(),nameRef=useRef<HTMLInputElement>(null);
 useLayoutEffect(()=>{nameRef.current?.focus({preventScroll:true});},[]);
 const closeLabel=r4Text(language,'关闭','Close');
 return <AppPortal><div className="modal-backdrop pi-dialog-mask" onMouseDown={event=>{if(event.target===event.currentTarget&&!busy)onClose();}} onKeyDown={event=>{if(event.key==='Escape'&&!event.defaultPrevented&&!busy){event.preventDefault();onClose();}}}>
  <section className="pi-agent pi-modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
   <header><h2 id={titleId}>{editor.mode==='create'?r4Text(language,'新增助手预设','New assistant preset'):r4Text(language,'编辑助手预设','Edit assistant preset')}</h2><button type="button" className="pi-icon" aria-label={closeLabel} disabled={busy} onClick={onClose}><LuX/></button></header>
   <form onSubmit={onSubmit}>
    <label>{r4Text(language,'名称','Name')}<input ref={nameRef} value={editor.name} maxLength={MAX_PRESET_NAME_LENGTH} onChange={event=>onName(event.target.value)} required autoComplete="off"/></label>
    <label>{r4Text(language,'提示词正文','Prompt body')}<textarea value={editor.body} maxLength={MAX_PRESET_BODY_LENGTH} onChange={event=>onBody(event.target.value)} required rows={14} style={{boxSizing:'border-box',display:'block',width:'100%',minHeight:260,resize:'vertical',border:'1px solid var(--pi-line)',borderRadius:9,background:'var(--bg-input,var(--pi-card))',padding:10,color:'var(--pi-text)',font:'inherit',lineHeight:1.5}}/></label>
    {error&&<p role="alert">{error}</p>}
    <footer><button type="button" className="secondary" disabled={busy} onClick={onClose}>{r4Text(language,'取消','Cancel')}</button><button type="submit" className="pi-primary" disabled={busy||!editor.name.trim()||!editor.body.trim()}>{busy?r4Text(language,'保存中…','Saving…'):r4Text(language,'保存','Save')}</button></footer>
   </form>
  </section>
 </div></AppPortal>;
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
 onCreatePreset:(presetId:string,name:string,body:string)=>Promise<R4CreativeCommandResult>;
 onEditPreset:(presetId:string,expectedRevision:number,name:string,body:string)=>Promise<R4CreativeCommandResult>;
}

const BUILTIN_PRESET_NAMES:Record<string,string>={
 'studio-novelai-assistant':'presetNovelAiAssistant',
 'dsh-infinite-gen-5':'presetInfiniteFive','dsh-infinite-gen-4':'presetInfinite','studio-complete':'presetComplete',
};

/** The resource list and its actions share the exact binding used by R4 sends. */
export function AgentR4AssistantPresetControl(props:AgentR4AssistantPresetControlProps){
 const {language,presets,binding,defaults,disabled}=props;
 const [editor,setEditor]=useState<PresetEditorState|null>(null),[saving,setSaving]=useState(false),[editorError,setEditorError]=useState('');
 const t=(key:string)=>studioUxText(language,key);
 const effectiveBinding=props.restoredConfig
  ? props.restoredConfig.presetId?{presetId:props.restoredConfig.presetId,enabled:props.restoredConfig.enabled,legacyStatus:props.restoredConfig.legacyStatus}:undefined
  : binding??defaults;
 const selectedId=effectiveBinding?.presetId??'',enabled=effectiveBinding?.enabled??false;
 const selectedPreset=presets[selectedId];
 const unknownLegacy=Boolean(effectiveBinding?.legacyStatus||(selectedId&&!selectedPreset));
 const defaultMatches=defaults?.presetId===selectedId&&defaults.enabled===enabled;
 const openCreate=()=>{if(disabled)return;setEditor({mode:'create',presetId:crypto.randomUUID(),name:'',body:''});setEditorError('');};
 const openEdit=(preset:R4AssistantPreset)=>{if(disabled)return;setEditor({mode:'edit',presetId:preset.id,expectedRevision:preset.revision,name:preset.name,body:preset.body});setEditorError('');};
 const saveEditor=async(event:FormEvent<HTMLFormElement>)=>{
  event.preventDefault();if(!editor||saving||disabled)return;
  const name=editor.name.trim();
  if(!name||name.length>MAX_PRESET_NAME_LENGTH){setEditorError(r4Text(language,`名称不能为空且最多${MAX_PRESET_NAME_LENGTH}个字符。`,`Name must contain 1–${MAX_PRESET_NAME_LENGTH} characters.`));return;}
  if(!editor.body.trim()||editor.body.length>MAX_PRESET_BODY_LENGTH){setEditorError(r4Text(language,`正文不能为空且最多${MAX_PRESET_BODY_LENGTH}个字符。`,`Prompt body must contain 1–${MAX_PRESET_BODY_LENGTH} characters.`));return;}
  setSaving(true);setEditorError('');
  try{
   const result=editor.mode==='create'
    ?await props.onCreatePreset(editor.presetId,name,editor.body)
    :await props.onEditPreset(editor.presetId,editor.expectedRevision,name,editor.body);
   if(result.ok)setEditor(null);else setEditorError(result.message??r4Text(language,'预设保存失败。','Could not save the preset.'));
  }catch(reason){setEditorError(String(reason));}
  finally{setSaving(false);}
 };
 return <div className="pi-assistant-presets">
  <div className="r4-preset-control" aria-label={t('assistantRolePreset')} title={t('assistantRolePresetHint')}>
   <strong>{t('assistantRolePreset')}</strong>
   <label className="r4-preset-enabled"><input type="checkbox" checked={enabled} disabled={disabled||!selectedId||unknownLegacy} onChange={event=>props.onChange(selectedId,event.target.checked)}/><span>{r4Text(language,'启用','Enabled')}</span></label>
   {selectedPreset&&<small className="r4-preset-revision" title={`${selectedPreset.hash} · rev ${selectedPreset.revision}`}>v{selectedPreset.revision}</small>}
   <button type="button" disabled={disabled||!selectedId||unknownLegacy||defaultMatches} title={defaultMatches?r4Text(language,'已是新会话默认','Already the new-chat default'):undefined} onClick={()=>props.onSetDefault(selectedId,enabled)}>{r4Text(language,'设为新会话默认','Set as new-chat default')}</button>
  </div>
  {unknownLegacy&&<p className="r4-legacy-note" role="status">{selectedPreset?r4Text(language,'历史配置未版本化','Legacy settings are unversioned'):r4Text(language,`历史预设不可用：${selectedId}。请重新选择。`,`Unavailable preset: ${selectedId}. Choose a replacement.`)}</p>}
  {props.restoredConfig?.presetId===null&&<p className="pi-muted">{r4Text(language,'恢复配置未使用预设','Restored config has no preset')}</p>}
  <button type="button" disabled={disabled} onClick={openCreate}><LuPlus/>{r4Text(language,'新增预设','New preset')}</button>
  <div className="pi-resource-list" role="list">
   {Object.values(presets).sort((a,b)=>a.name.localeCompare(b.name)).map(preset=>{
    const builtin=preset.source==='builtin'&&BUILTIN_PRESET_NAMES[preset.id]===preset.name;
    const name=builtin?t(preset.name):preset.name;
    const title=`${name}\n${r4Text(language,`原始名称：${preset.name}`,`Original name: ${preset.name}`)}\nID: ${preset.id}`;
    return <ResourceRow key={preset.id} name={name} title={title} icon={<LuFileText/>} selected={selectedId===preset.id} disabled={disabled} onSelect={()=>props.onChange(preset.id,enabled)} detailsLabel={t('details')}>
     {builtin&&<p>{t(preset.name+'Body')}</p>}<pre>{preset.body}</pre>
     <button type="button" disabled={disabled} onClick={()=>openEdit(preset)}><LuPencil/>{r4Text(language,'编辑','Edit')}</button>
     {builtin&&['dsh-infinite-gen-5','dsh-infinite-gen-4'].includes(preset.id)&&<a href={`https://github.com/Minglink/${preset.id}`} onClick={event=>{event.preventDefault();void window.naiDesktop.openExternal(`https://github.com/Minglink/${preset.id}`)}}>Minglink · CC BY-NC-SA 4.0</a>}
    </ResourceRow>;
   })}
  </div>
  {editor&&<AssistantPresetEditor language={language} editor={editor} busy={saving} error={editorError} onClose={()=>setEditor(null)} onName={name=>setEditor(current=>current?{...current,name}:current)} onBody={body=>setEditor(current=>current?{...current,body}:current)} onSubmit={event=>void saveEditor(event)}/>}
 </div>;
}

export function AgentResourcePanel({workspace,chat,language,disabled,presetControl,onCreatePreset,onEditPreset,onChange,onWorkspaceChange,tab,onTab,onClose}:{workspace?:AgentWorkspaceData;chat?:AgentConversation;language:unknown;disabled:boolean;presetControl:Omit<AgentR4AssistantPresetControlProps,'language'|'onCreatePreset'|'onEditPreset'>;onCreatePreset:AgentR4AssistantPresetControlProps['onCreatePreset'];onEditPreset:AgentR4AssistantPresetControlProps['onEditPreset'];onChange:(patch:Partial<StudioConversationOptions>)=>void;onWorkspaceChange:(workspace:AgentWorkspaceData)=>void;tab:NonNullable<AgentUiPreferences['resourceTab']>;onTab:(tab:NonNullable<AgentUiPreferences['resourceTab']>)=>void;onClose?:()=>void}){
 const region=useStudioRegionMotion(tab),t=(key:string)=>studioUxText(language,key);
 // Older stored UI preferences may still name the removed character-card tab.
 const visibleTab=tab==='characters'?'presets':tab;
 return <aside id="pi-creative-resources" className="pi-resource-panel" aria-label={t('resources')}>
  <header><strong><LuBookOpen/>{t('resources')}</strong>{onClose&&<button type="button" className="pi-icon" aria-label={t('close')} onClick={onClose}><LuX/></button>}</header>
  <div className="pi-resource-tabs" role="tablist" aria-label={t('resources')}>{(['presets','skills','memories'] as const).map(value=><button key={value} id={'pi-resource-tab-'+value} role="tab" aria-selected={visibleTab===value} aria-controls={'pi-resource-'+value} onClick={()=>onTab(value)}>{value==='presets'?<LuFileText/>:value==='skills'?<LuSparkles/>:<LuBrain/>}{t('resource_'+value)}</button>)}</div>
  <section ref={region} className="pi-resource-body" role="tabpanel" id={'pi-resource-'+visibleTab} aria-labelledby={'pi-resource-tab-'+visibleTab}>
   {visibleTab==='memories'&&<MemoryManager workspace={workspace} conversationId={chat?.id} disabled={disabled} language={language} onWorkspaceChange={onWorkspaceChange}/>}
   {visibleTab==='skills'&&<AgentSkillsPanel workspace={workspace} chat={chat} language={language} disabled={disabled} onWorkspaceChange={onWorkspaceChange} onChange={onChange}/>}
   {visibleTab==='presets'&&<AgentR4AssistantPresetControl language={language} {...presetControl} onCreatePreset={onCreatePreset} onEditPreset={onEditPreset}/>}
  </section>
 </aside>;
}

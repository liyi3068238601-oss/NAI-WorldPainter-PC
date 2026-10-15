import {useState} from 'react';
import {LuCheck,LuLock,LuPencil,LuPlus,LuSparkles,LuTrash2,LuZap} from 'react-icons/lu';
import {confirmAction} from './confirm';
import type {AgentConversation,AgentSkill,AgentWorkspaceData} from '../agent/types';
import {studioUxText} from '../agent/ux';
import {STUDIO_SKILL_LIMITS,type StudioConversationOptions} from '../agent/workspace-controls';

type SkillDraft={id?:string;name:string;description:string;instructions:string;enabled:boolean;autoSelect:boolean;triggerKeywords:string};
const emptyDraft=():SkillDraft=>({name:'',description:'',instructions:'',enabled:true,autoSelect:false,triggerKeywords:''});
const draftFrom=(skill:AgentSkill):SkillDraft=>({id:skill.id,name:skill.name,description:skill.description,instructions:skill.instructions,enabled:skill.enabled,autoSelect:skill.autoSelect===true,triggerKeywords:(skill.triggerKeywords??[]).join(', ')});
const keywordsFrom=(value:string)=>[...new Set(value.split(/[,，\n]/).map(item=>item.trim()).filter(Boolean))];

export function AgentSkillsPanel({workspace,chat,language,disabled,onWorkspaceChange,onChange}:{
 workspace?:AgentWorkspaceData;
 chat?:AgentConversation;
 language:unknown;
 disabled:boolean;
 onWorkspaceChange:(workspace:AgentWorkspaceData)=>void;
 onChange:(patch:Partial<StudioConversationOptions>)=>void;
}){
 const [draft,setDraft]=useState<SkillDraft|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const t=(key:string)=>studioUxText(language,key),skills=workspace?.skills??[],selectedIds=chat?.selectedSkillIds??[],skillLimitReached=skills.length>=STUDIO_SKILL_LIMITS.maxSkills;
 const save=async()=>{
  if(!draft||!draft.name.trim()||!draft.instructions.trim()||busy)return;
  setBusy(true);setError('');
  try{
   const result=await window.naiDesktop.upsertAgentSkill({
    ...(draft.id?{id:draft.id}:{}),name:draft.name.trim(),description:draft.description.trim(),instructions:draft.instructions,
    enabled:draft.enabled,autoSelect:draft.autoSelect,triggerKeywords:keywordsFrom(draft.triggerKeywords),
   });
   if(!result.ok){setError(result.message??t('statusError'));return;}
   onWorkspaceChange(result.workspace);setDraft(null);
  }catch(reason){setError(String(reason));}
  finally{setBusy(false);}
 };
 const setEnabled=async(skill:AgentSkill,enabled:boolean)=>{
  if(busy||disabled)return;
  setBusy(true);setError('');
  try{
   const result=await window.naiDesktop.upsertAgentSkill({...skill,enabled});
   if(result.ok)onWorkspaceChange(result.workspace);else setError(result.message??t('statusError'));
  }catch(reason){setError(String(reason));}
  finally{setBusy(false);}
 };
 const remove=async(skill:AgentSkill)=>{
  if(skill.builtIn||busy||disabled||!await confirmAction(`${t('skillDelete')}: ${skill.name}?`))return;
  setBusy(true);setError('');
  try{
   const result=await window.naiDesktop.deleteAgentSkill(skill.id);
   if(result.ok){onWorkspaceChange(result.workspace);if(draft?.id===skill.id)setDraft(null);}else setError(result.message??t('statusError'));
  }catch(reason){setError(String(reason));}
  finally{setBusy(false);}
 };
 const toggleSelected=(skillId:string)=>{
  const next=selectedIds.includes(skillId)?selectedIds.filter(id=>id!==skillId):[...selectedIds,skillId];
  onChange({selectedSkillIds:next});
 };
 return <div className="pi-skill-manager">
  <div className="pi-skill-heading"><div><strong>{t('skillSelection')}</strong><small>{t('skillSelectionHint')}</small></div><button type="button" className="pi-primary" disabled={disabled||busy||skillLimitReached} onClick={()=>{setError('');setDraft(emptyDraft());}}><LuPlus/>{t('skillNew')}</button></div>
  {skillLimitReached&&<small className="pi-muted">{t('skillLimitReached').replace('{count}',String(STUDIO_SKILL_LIMITS.maxSkills))}</small>}
  {error&&<p role="alert" className="pi-error pi-skill-error">{error}</p>}
  <div className="pi-skill-list" role="list" aria-label={t('resource_skills')}>
   {skills.map(skill=>{
    const isSelected=selectedIds.includes(skill.id);
    const keywords=skill.triggerKeywords??[];
    const visibleKeywords=keywords.slice(0,4);
    const hiddenKeywordCount=Math.max(0,keywords.length-visibleKeywords.length);
    return <article key={skill.id} className={`pi-skill-card${isSelected?' is-selected':''}${skill.enabled?'':' is-disabled'}`} role="listitem">
     <div className="pi-skill-card-title"><strong>{skill.name}</strong>{skill.builtIn&&<span title={t('skillBuiltIn')}><LuLock/>{t('skillBuiltIn')}</span>}</div>
     <p>{skill.description||t('skillNoDescription')}</p>
     <label className="pi-skill-check"><input type="checkbox" disabled={disabled||(!skill.enabled&&!isSelected)||(!isSelected&&selectedIds.length>=STUDIO_SKILL_LIMITS.maxSelected)} checked={isSelected} onChange={()=>toggleSelected(skill.id)}/><span>{t('skillUseInChat')}</span>{isSelected&&<LuCheck aria-hidden/>}</label>
     <label className="pi-skill-check"><input type="checkbox" disabled={disabled} checked={skill.enabled} onChange={event=>void setEnabled(skill,event.target.checked)}/><span>{t('skillEnabled')}</span></label>
     {skill.autoSelect&&<small className="pi-skill-auto" title={keywords.join('、')}><LuZap aria-hidden/>{t('skillAutoSelect')}{visibleKeywords.length?` · ${visibleKeywords.join('、')}${hiddenKeywordCount?` +${hiddenKeywordCount}`:''}`:''}</small>}
     {!skill.builtIn&&<div className="pi-skill-actions"><button type="button" disabled={disabled||busy} onClick={()=>setDraft(draftFrom(skill))}><LuPencil/>{t('skillEdit')}</button><button type="button" className="is-danger" disabled={disabled||busy} onClick={()=>void remove(skill)}><LuTrash2/>{t('skillDelete')}</button></div>}
    </article>;
   })}
  </div>
  {!skills.length&&<p className="pi-muted">{t('skillEmpty')}</p>}
  {draft&&<section className="pi-skill-editor" aria-label={draft.id?t('skillEdit'):t('skillNew')}>
   <header><strong><LuSparkles/>{t(draft.id?'skillEdit':'skillNew')}</strong><button type="button" disabled={busy} onClick={()=>setDraft(null)}>{t('cancel')}</button></header>
   <label>{t('skillName')}<input autoFocus maxLength={STUDIO_SKILL_LIMITS.maxNameLength} value={draft.name} onChange={event=>setDraft({...draft,name:event.target.value})}/></label>
   <label>{t('skillDescription')}<textarea rows={2} maxLength={STUDIO_SKILL_LIMITS.maxDescriptionLength} value={draft.description} onChange={event=>setDraft({...draft,description:event.target.value})}/></label>
   <label>{t('skillInstructions')}<textarea rows={6} maxLength={STUDIO_SKILL_LIMITS.maxInstructionsLength} value={draft.instructions} onChange={event=>setDraft({...draft,instructions:event.target.value})}/></label>
   <label>{t('skillKeywords')}<textarea rows={2} maxLength={STUDIO_SKILL_LIMITS.maxTriggerKeywords*(STUDIO_SKILL_LIMITS.maxTriggerKeywordLength+2)} value={draft.triggerKeywords} onChange={event=>setDraft({...draft,triggerKeywords:event.target.value})} placeholder={t('skillKeywordsHint')}/></label>
   <label className="pi-skill-check"><input type="checkbox" checked={draft.autoSelect} onChange={event=>setDraft({...draft,autoSelect:event.target.checked})}/><span>{t('skillAutoSelect')}</span></label>
   <small>{t('skillAutoSelectHint')}</small>
   <label className="pi-skill-check"><input type="checkbox" checked={draft.enabled} onChange={event=>setDraft({...draft,enabled:event.target.checked})}/><span>{t('skillEnabled')}</span></label>
   <footer><button type="button" disabled={busy} onClick={()=>setDraft(null)}>{t('cancel')}</button><button type="button" className="pi-primary" disabled={disabled||busy||!draft.name.trim()||!draft.instructions.trim()} onClick={()=>void save()}>{t(busy?'saveBusy':'save')}</button></footer>
  </section>}
 </div>;
}

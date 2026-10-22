import ig5 from '../../shared/ig5-image-prompts.json';
import type {AgentConversation,AgentSkill,AgentWorkspaceData} from './types';
import type {R4ConversationConfigSnapshot} from './r4-types';
import infinitePreset from '../../shared/agent-infinite-preset.json';
import {LYRA_PRESET_SYSTEM_PROMPT,LYRA_PRESET_JAILBREAK_PROMPT} from '../tavern/lyra-preset-data';
import {STUDIO_NOVELAI_ASSISTANT_PRESET_BODY} from './novelai-default-content';

export {createBuiltinAgentSkills} from './agent-skill-content';
export {STUDIO_NOVELAI_ASSISTANT_PRESET_BODY};

export const STUDIO_DEFAULT_PRESET_ID='studio-novelai-assistant';
export const STUDIO_LEGACY_PRESET_ID='dsh-infinite-gen-4';
export const STUDIO_MERGED_PRESET_ID='studio-complete';
export const STUDIO_LYRA_PRESET_ID='builtin-lyra-beta-3-8-sampler';
export const STUDIO_SKILL_LIMITS={
 maxSkills:64,
 maxDirectoryEntries:24,
 maxSelected:24,
 maxNameLength:80,
 maxDescriptionLength:300,
 maxInstructionsLength:12_000,
 maxTriggerKeywords:64,
 maxTriggerKeywordLength:80,
} as const;
const oldPresetIds=new Set(['studio-director','studio-prompts','studio-reference','tavern:'+STUDIO_LYRA_PRESET_ID]);
export function studioPresetId(id?:string){return !id||oldPresetIds.has(id)?STUDIO_DEFAULT_PRESET_ID:id;}

export const STUDIO_BUILTIN_PRESETS=[
 {id:STUDIO_DEFAULT_PRESET_ID,name:'presetNovelAiAssistant',body:STUDIO_NOVELAI_ASSISTANT_PRESET_BODY},
 {id:'dsh-infinite-gen-5',name:'presetInfiniteFive',body:ig5.prompts.studio},
 {id:STUDIO_LEGACY_PRESET_ID,name:'presetInfinite',body:infinitePreset.adaptedPrompt},
 {id:STUDIO_MERGED_PRESET_ID,name:'presetComplete',body:[
  'Help the user plan and create images. Keep replies brief, preserve explicit image constraints, use actual Studio generation tools and receipts. Do not generate when asked only to discuss or inspect.',
  'Focus on NovelAI prompt composition, subject, action, lighting and framing. Preserve explicit tags and exclusions. Explain edits briefly; never invent an executed image.',
  'Analyze attached reference images and separate observed visual details from uncertainty. Preserve requested identity, clothing and composition in the generation plan. Use app image tools only when requested.',
  LYRA_PRESET_SYSTEM_PROMPT,LYRA_PRESET_JAILBREAK_PROMPT,
 ].join('\n\n')},
] as const;

export type StudioConversationOptions=Pick<AgentConversation,'studioApprovalMode'|'studioWebSearchEnabled'|'studioTemplateEnabled'|'studioPresetId'|'characterIds'|'activeCharacterId'|'lorebookIds'|'selectedSkillIds'>;
export function studioSessionOptions(chat?: Partial<AgentConversation>){return{
 approvalMode:chat?.studioApprovalMode==='auto'?'auto' as const:'confirm' as const,
 webSearchEnabled:chat?.studioWebSearchEnabled!==false,
 templateEnabled:chat?.studioTemplateEnabled!==false,
 presetId:studioPresetId(chat?.studioPresetId),
};}
export function studioToolEnabled(name:string,webSearchEnabled:boolean){return name!=='langbai_search_web'||webSearchEnabled;}
export function studioBuiltinPreset(id:string){return STUDIO_BUILTIN_PRESETS.find(p=>p.id===studioPresetId(id));}

/** Skill bodies stay out of the normal prompt and are read one at a time. */
export const STUDIO_READ_SKILL_TOOL_NAME='read_skill';
export type StudioSkillDescriptor=Pick<AgentSkill,'id'|'name'|'description'>;
export type StudioSkillMatchContext={
 /** Bounded, same-conversation prior user text supplied by the runtime. */
 recentUserText?:string;
 /** Count of currently selected Generate characters; no workbench read is required. */
 activeCharacterCount?:number;
};

const multiCharacterPatterns=[
 /(?:两|二|2|三|3|四|4|五|5|多|几)\s*(?:个|名)?\s*(?:人|角色|人物|女孩|男孩|少女|少年|女生|男生|女孩子|男孩子)/u,
 /\b(?:two|three|four|multiple|several)\s+(?:girls?|boys?|people|persons?|characters|women|men|couples?)\b/i,
 /\b(?:1girl\s+and\s+1boy|2girls?|2boys?|2others?)\b/i,
 /(?:角色|人物).{0,8}(?:互动|相拥|拥抱|牵手|接吻|对视|并肩)|(?:互动|相拥|拥抱|牵手|接吻|对视|并肩).{0,8}(?:角色|人物)/u,
 /(?:他们俩|她们俩|她俩|他们|她们|这两人|这些角色|这些人物)/u,
 /(?:相拥|互动|抱住|拥抱|牵手|接吻|对视|并肩|相望)/u,
 /\b(?:they|them|their|each other|both of them|interacting|holding hands|hug|hugs|hugging|embrace|embraces|kissing)\b/i,
];
function skillMatchText(messageText:string,context?:StudioSkillMatchContext){
 return `${messageText.slice(0,20_000)}\n${typeof context?.recentUserText==='string'?context.recentUserText.slice(0,8_000):''}`.toLowerCase();
}
function hasMultiCharacterContext(messageText:string,context?:StudioSkillMatchContext){
 return (Number.isFinite(context?.activeCharacterCount)&&Number(context?.activeCharacterCount)>1)
  ||multiCharacterPatterns.some(pattern=>pattern.test(messageText));
}
function studioSkillApplies(skill:AgentSkill,chat:Pick<AgentConversation,'selectedSkillIds'>|undefined,messageText:string,context?:StudioSkillMatchContext){
 if(!skill.enabled)return false;
 if(chat?.selectedSkillIds?.includes(skill.id))return true;
 if(!skill.autoSelect)return false;
   if(skill.id==='builtin-multi-character-composition'&&hasMultiCharacterContext(skillMatchText(messageText,context),context))return true;
 const keywords=(skill.triggerKeywords??[]).slice(0,STUDIO_SKILL_LIMITS.maxTriggerKeywords).map(keyword=>keyword.trim().slice(0,STUDIO_SKILL_LIMITS.maxTriggerKeywordLength).toLowerCase()).filter(Boolean);
 if(!keywords.length)return true;
 const text=skillMatchText(messageText,context);
 return keywords.some(keyword=>text.includes(keyword));
}
function studioSkillMatchRank(skill:AgentSkill,chat:Pick<AgentConversation,'selectedSkillIds'>|undefined,messageText:string,context?:StudioSkillMatchContext){
 if(chat?.selectedSkillIds?.includes(skill.id))return Number.POSITIVE_INFINITY;
 if(!skill.autoSelect)return 0;
 if(skill.id==='builtin-multi-character-composition'&&hasMultiCharacterContext(skillMatchText(messageText,context),context))return 500;
 const text=skillMatchText(messageText,context);
 return (skill.triggerKeywords??[]).slice(0,STUDIO_SKILL_LIMITS.maxTriggerKeywords).map(keyword=>keyword.trim().slice(0,STUDIO_SKILL_LIMITS.maxTriggerKeywordLength).toLowerCase())
  .filter(keyword=>keyword&&text.includes(keyword)).reduce((longest,keyword)=>Math.max(longest,keyword.length),1);
}

/** Current-turn catalog entries contain no skill body or execution capability. */
export function studioSkillDirectory(
 workspace:Partial<Pick<AgentWorkspaceData,'skills'>>,
 chat:Pick<AgentConversation,'selectedSkillIds'>|undefined,
 messageText='',
 matchContext?:StudioSkillMatchContext,
):StudioSkillDescriptor[]{
 return (workspace.skills??[]).map((skill,index)=>({skill,index,rank:studioSkillMatchRank(skill,chat,messageText,matchContext)}))
  .filter(({skill})=>skill.id.length<=200&&studioSkillApplies(skill,chat,messageText,matchContext))
  .sort((left,right)=>right.rank-left.rank||left.index-right.index)
  .slice(0,STUDIO_SKILL_LIMITS.maxDirectoryEntries)
  .map(({skill})=>({
   id:skill.id.slice(0,200),
   name:skill.name.slice(0,STUDIO_SKILL_LIMITS.maxNameLength),
   description:skill.description.slice(0,STUDIO_SKILL_LIMITS.maxDescriptionLength),
  }));
}

/** Resolve a body only if the skill is enabled and selected or matched this turn. */
export function studioReadSkill(
 workspace:Partial<Pick<AgentWorkspaceData,'skills'>>,
 chat:Pick<AgentConversation,'selectedSkillIds'>|undefined,
 skillId:string,
 messageText='',
 matchContext?:StudioSkillMatchContext,
):Pick<AgentSkill,'id'|'name'|'description'|'instructions'>|null{
 const skills=workspace.skills??[];
 const eligibleIds=new Set(studioSkillDirectory(workspace,chat,messageText,matchContext).map(item=>item.id));
 const skill=skills.find(item=>item.id===skillId&&eligibleIds.has(item.id));
 if(skill&&skill.instructions.length>STUDIO_SKILL_LIMITS.maxInstructionsLength){
  throw new Error(`Skill 正文超过 ${STUDIO_SKILL_LIMITS.maxInstructionsLength} 字符，未读取；请精简后重试。`);
 }
 return skill?{
  id:skill.id,
  name:skill.name.slice(0,STUDIO_SKILL_LIMITS.maxNameLength),
  description:skill.description.slice(0,STUDIO_SKILL_LIMITS.maxDescriptionLength),
  instructions:skill.instructions.slice(0,STUDIO_SKILL_LIMITS.maxInstructionsLength),
 }:null;
}

/** Active Studio context keeps preset identity only; legacy role cards remain stored but are not injected. */
export function studioCreativeReferenceData(workspace:AgentWorkspaceData,chat:AgentConversation,lore:Array<{book:{name:string};entry:{content:string;comment?:string}}>,frozenConfig?:Pick<R4ConversationConfigSnapshot,'presetId'|'enabled'|'revision'|'hash'>){
 void lore;
 let preset:Record<string,unknown>|null;
 if(frozenConfig!==undefined){
  preset=frozenConfig.enabled&&frozenConfig.presetId?{
   id:frozenConfig.presetId,
   enabled:frozenConfig.enabled,
   revision:frozenConfig.revision??null,
   hash:frozenConfig.hash??null,
  }:null;
 }else{
  const options=studioSessionOptions(chat);
  const builtin=studioBuiltinPreset(options.presetId);
  const tavern=options.presetId.startsWith('tavern:')?workspace.samplerPresets.find(p=>p.id===options.presetId.slice(7)):undefined;
  preset=options.templateEnabled?(builtin?{id:builtin.id,name:builtin.name,source:'builtin'}:tavern?{id:'tavern:'+tavern.id,name:tavern.name,source:tavern.source,sourceName:tavern.sourceName}:null):null;
 }
 return JSON.stringify({preset});
}

/** Explicit user-selected task system layer, never a tool or payment permission. */
export function studioSelectedSystemPrompt(workspace:AgentWorkspaceData,chat:AgentConversation):string {
 const options=studioSessionOptions(chat);if(!options.templateEnabled)return '';
 const builtin=studioBuiltinPreset(options.presetId);if(builtin)return builtin.body;
 const preset=options.presetId.startsWith('tavern:')?workspace.samplerPresets.find(p=>p.id===options.presetId.slice(7)):undefined;
 return preset?[preset.systemPrompt,preset.jailbreakPrompt].filter(Boolean).join('\n\n'):'';
}

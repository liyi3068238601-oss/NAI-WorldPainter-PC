import {describe,expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import ig5 from '../../shared/ig5-image-prompts.json';
import infinitePreset from '../../shared/agent-infinite-preset.json';
import {LYRA_PRESET_SYSTEM_PROMPT,LYRA_PRESET_JAILBREAK_PROMPT} from '../tavern/lyra-preset-data';
import {createBuiltinAgentSkills,studioReadSkill,studioSkillDirectory,STUDIO_DEFAULT_PRESET_ID,STUDIO_READ_SKILL_TOOL_NAME,STUDIO_SKILL_LIMITS,STUDIO_NOVELAI_ASSISTANT_PRESET_BODY,STUDIO_BUILTIN_PRESETS,studioBuiltinPreset,studioCreativeReferenceData} from './workspace-controls';
import type {AgentConversation,AgentSkill,AgentWorkspaceData} from './types';

const workspace=(skills:AgentSkill[])=>({skills} as AgentWorkspaceData);
const chat=(selectedSkillIds:string[]=[])=>( {selectedSkillIds} as AgentConversation);
const sha256=(value:string)=>createHash('sha256').update(value).digest('hex');
const skillIds=(skills:AgentSkill[])=>skills.map(skill=>skill.id);
const directory=(skills:AgentSkill[],message:string,context?:Parameters<typeof studioSkillDirectory>[3])=>studioSkillDirectory(workspace(skills),chat(),message,context).map(item=>item.id);

describe('on-demand Studio skills',()=>{
 it('ships seven stable workflows and keeps the other factory preset bodies byte-identical',()=>{
  const skills=createBuiltinAgentSkills('2026-10-15T00:00:00.000Z');
  expect(STUDIO_DEFAULT_PRESET_ID).toBe('studio-novelai-assistant');
  expect(STUDIO_BUILTIN_PRESETS.map(preset=>[preset.id,preset.name])).toEqual([
   ['studio-novelai-assistant','presetNovelAiAssistant'],
   ['dsh-infinite-gen-5','presetInfiniteFive'],
   ['dsh-infinite-gen-4','presetInfinite'],
   ['studio-complete','presetComplete'],
  ]);
  expect(skillIds(skills)).toEqual([
   'builtin-scene-ideation-storyboarding','builtin-novelai-prompt-versions','builtin-multi-character-composition',
   'builtin-image-generation','builtin-image-editing','builtin-prompt-term-lookup','builtin-creative-memory',
  ]);
  expect(skills.every(skill=>skill.builtIn&&skill.enabled&&skill.autoSelect&&skill.triggerKeywords?.length)).toBe(true);
  expect(skills.map(skill=>skill.createdAt)).toEqual(Array(7).fill('2026-10-15T00:00:00.000Z'));
  expect(skills.every(skill=>skill.instructions.length<=STUDIO_SKILL_LIMITS.maxInstructionsLength)).toBe(true);

  expect(STUDIO_NOVELAI_ASSISTANT_PRESET_BODY.length).toBeLessThan(500);
  expect(STUDIO_NOVELAI_ASSISTANT_PRESET_BODY).toContain('主动补足');
  expect(STUDIO_NOVELAI_ASSISTANT_PRESET_BODY).not.toContain('write_workbench_prompts');
  expect(STUDIO_NOVELAI_ASSISTANT_PRESET_BODY).not.toContain('prepare_generation');
  expect(studioBuiltinPreset(STUDIO_DEFAULT_PRESET_ID)?.body).toBe(STUDIO_NOVELAI_ASSISTANT_PRESET_BODY);
  expect(STUDIO_BUILTIN_PRESETS.map(preset=>preset.body)).toEqual([
   STUDIO_NOVELAI_ASSISTANT_PRESET_BODY,ig5.prompts.studio,infinitePreset.adaptedPrompt,[
    'Help the user plan and create images. Keep replies brief, preserve explicit image constraints, use actual Studio generation tools and receipts. Do not generate when asked only to discuss or inspect.',
    'Focus on NovelAI prompt composition, subject, action, lighting and framing. Preserve explicit tags and exclusions. Explain edits briefly; never invent an executed image.',
    'Analyze attached reference images and separate observed visual details from uncertainty. Preserve requested identity, clothing and composition in the generation plan. Use app image tools only when requested.',
    LYRA_PRESET_SYSTEM_PROMPT,LYRA_PRESET_JAILBREAK_PROMPT,
   ].join('\n\n'),
  ]);
  expect(STUDIO_BUILTIN_PRESETS.slice(1).map(preset=>sha256(preset.body))).toEqual([
   '969c9d5893f696cd92a5cd9c18b89213d3fb169a27499310bba8d4c636deb9b6',
   '438f957e8529ddebf3c5d98f8fa1571048e3e3d7db300cd720a1dcdc95c2803d',
   'f919a82bd44f60a138129c13771950872d0dc2d48b7297e7dcadea52dc7ae6e3',
  ]);

  const roles=[{id:'legacy-role',name:'Agent角色卡不应注入',description:'PRIVATE_ROLE_DESCRIPTION'}] as any;
  const refs=studioCreativeReferenceData({characters:roles} as any,{characterIds:['legacy-role'],studioPresetId:STUDIO_DEFAULT_PRESET_ID} as any,[]);
  expect(refs).not.toContain('PRIVATE_ROLE_DESCRIPTION');
  expect(JSON.parse(refs)).not.toHaveProperty('characters');
  expect(STUDIO_READ_SKILL_TOOL_NAME).toBe('read_skill');
  expect(STUDIO_SKILL_LIMITS).toMatchObject({maxSkills:64,maxDirectoryEntries:24,maxSelected:24,maxInstructionsLength:12_000});
 });

 it('matches ordinary prompt-writing and image intent to the workbench skill',()=>{
  const skills=createBuiltinAgentSkills('now');
  for(const message of ['帮我写一版提示词','修改正向词','把词填进去','帮我画一个雨夜街景','按这个描述生成一张雨夜街景']){
   expect(directory(skills,message)).toContain('builtin-image-generation');
  }
  expect(directory(skills,'按 V5 的写法整理这段提示词')).toContain('builtin-novelai-prompt-versions');
  for(const message of ['帮我写一版提示词','修改正向词','帮我画一张两人合照']){
   expect(directory(skills,message)).toContain('builtin-novelai-prompt-versions');
  }
  expect(directory(skills,'帮我构思一个安静的城市画面')).toContain('builtin-scene-ideation-storyboarding');
  expect(directory(skills,'只讨论一个原创雨夜场景')).not.toContain('builtin-prompt-term-lookup');
  const loaded=studioReadSkill(workspace(skills),chat(),'builtin-image-generation','帮我画一个雨夜街景');
  expect(loaded?.instructions).toContain('read_generation_state');
  expect(loaded?.instructions).toContain('expectedDraftRevision');
  expect(loaded?.instructions).toContain('空字符串只用于用户明确要求清空');
  expect(loaded?.instructions).toContain('成功后只有用户也明确要求生成时才 fresh-read');
  expect(loaded?.instructions).toContain('prepare_generation({})');
  expect(loaded?.instructions).toContain('upscale_image');
 });

 it('matches multi-character wording, action language, and same-conversation context',()=>{
  const skills=createBuiltinAgentSkills('now');
  for(const message of [
   '画两名角色并肩站立','做一个2人构图','安排二人互动','设计三人合照',
   '1girl and 1boy in a garden','2girls holding hands','让 Alice 抱住 Bob',
  ]){
   expect(directory(skills,message)).toContain('builtin-multi-character-composition');
  }
  expect(directory(skills,'把他们衣服改红',{recentUserText:'先画两名角色在车站相遇',activeCharacterCount:1})).toContain('builtin-multi-character-composition');
  expect(directory(skills,'调整人物层次',{activeCharacterCount:2})).toContain('builtin-multi-character-composition');
  expect(studioReadSkill(workspace(skills),chat(),'builtin-multi-character-composition','改他们的衣服',{recentUserText:'画两个人牵手'} )?.instructions).toContain('characterLayoutIntent');
  const multi=skills.find(skill=>skill.id==='builtin-multi-character-composition')!;
  for(const rule of ['characterPrompts','expectedDraftRevision','useCoords=true','useCoords=false','characterLayoutIntent:"planned"','characterLayoutIntent:"free"','x 从左到右','y 从上到下','人物中心点','不是包围框或骨骼坐标','景别、画幅','视线','留白','disabled 项不参加本次布局，缺省沿用同一角色旧值','name 只是工作台标签','纯重排']){
   expect(multi.instructions).toContain(rule);
  }
 });

 it('keeps model-version prompting distinct from universal syntax rules',()=>{
  const skill=createBuiltinAgentSkills('now').find(item=>item.id==='builtin-novelai-prompt-versions')!;
  expect(skill.name).toBe('NovelAI 分版本写词');
  for(const detail of ['V4','V4.5','V5','总人数','角色关系','局部动作','negativePrompt','read_prompting_reference({reference:"writing"})','`|` 在模型间含义不同']){
   expect(skill.instructions).toContain(detail);
  }
  expect(skill.instructions).not.toContain('0–8');
  expect(skill.instructions).not.toContain('kind 只能');
  expect(skill.instructions).not.toContain('prompt variants');
 });

 it('loads editing, verification and memory workflows only when relevant',()=>{
  const skills=createBuiltinAgentSkills('now'),ws=workspace(skills);
  const editText='用蒙版局部重绘，把背景改成海边';
  expect(directory(skills,editText)).toContain('builtin-image-editing');
  const edit=studioReadSkill(ws,chat(),'builtin-image-editing',editText)!;
  for(const detail of ['蒙版','inpaintPositivePrompt','new mobile inpaint mode','upscale_image'])expect(edit.instructions).toContain(detail);

  const lookupText='请核实《星际远征》里的林月这个角色';
  expect(directory(skills,lookupText)).toContain('builtin-prompt-term-lookup');
  const lookup=studioReadSkill(ws,chat(),'builtin-prompt-term-lookup',lookupText)!;
  expect(lookup.instructions).toContain('search_tags');
  expect(lookup.instructions).toContain('search_artists');
  expect(lookup.instructions).toContain('search_web');
  expect(lookup.instructions).toContain('reference:"ideation"');

  const memoryText='请查一下我之前记住的角色标准设定';
  expect(directory(skills,memoryText)).toContain('builtin-creative-memory');
  const memory=studioReadSkill(ws,chat(),'builtin-creative-memory',memoryText)!;
  expect(memory.instructions).toContain('search_memories');
  expect(memory.instructions).toContain('待审核候选');
  expect(memory.instructions).toContain('character_outfit');
 });

 it('lists only enabled skills selected for the chat or matched for this turn, without their instructions',()=>{
  const skills=createBuiltinAgentSkills('now');
  skills.push({id:'custom',name:'Custom',description:'Fixture description',instructions:'PRIVATE_INSTRUCTIONS',enabled:true,autoSelect:true,triggerKeywords:['blue outfit'],createdAt:'now',updatedAt:'now'});
  skills.push({id:'disabled',name:'Disabled',description:'',instructions:'DO_NOT_READ',enabled:false,autoSelect:true,triggerKeywords:['blue outfit'],createdAt:'now',updatedAt:'now'});
  const directory=studioSkillDirectory(workspace(skills),chat(),'Please make an image with a blue outfit');
  expect(directory.map(skill=>skill.id)).toEqual(['custom']);
  expect(directory[0]).toEqual({id:'custom',name:'Custom',description:'Fixture description'});
  expect(JSON.stringify(directory)).not.toContain('PRIVATE_INSTRUCTIONS');
  expect(JSON.stringify(directory)).not.toContain('DO_NOT_READ');
 });

 it('reads one applicable instruction body and refuses disabled, unselected, or unmatched skills',()=>{
  const skill=createBuiltinAgentSkills('now').find(item=>item.id==='builtin-prompt-term-lookup')!;
  const ws=workspace([skill]);
  expect(studioReadSkill(ws,chat(),'builtin-prompt-term-lookup','请查一下这个 Danbooru 标签的含义')?.instructions).toBe(skill.instructions);
  expect(studioReadSkill(ws,chat(),'builtin-prompt-term-lookup','我们聊聊周末计划')).toBeNull();
  expect(studioReadSkill(ws,chat(),'builtin-prompt-term-lookup','')).toBeNull();
  expect(studioReadSkill(workspace([{...skill,enabled:false}]),chat(),'builtin-image-generation','生图')).toBeNull();
  expect(studioReadSkill(ws,chat([skill.id]),skill.id,'随便聊聊')?.id).toBe(skill.id);
 });

 it('tolerates legacy workspaces without a skills array and refuses to load a truncated body',()=>{
  expect(studioSkillDirectory({},chat(),'ordinary message')).toEqual([]);
  expect(studioReadSkill({},chat(),'missing','ordinary message')).toBeNull();
  const skill:AgentSkill={id:'oversized',name:'N'.repeat(100),description:'D'.repeat(400),instructions:'I'.repeat(STUDIO_SKILL_LIMITS.maxInstructionsLength+1),enabled:true,createdAt:'now',updatedAt:'now'};
  expect(()=>studioReadSkill(workspace([skill]),chat([skill.id]),skill.id)).toThrow(/超过 12000 字符，未读取/);
  expect(studioReadSkill(workspace([{...skill,instructions:'I'.repeat(STUDIO_SKILL_LIMITS.maxInstructionsLength)}]),chat([skill.id]),skill.id)?.instructions).toHaveLength(STUDIO_SKILL_LIMITS.maxInstructionsLength);
 });

 it('treats an auto-select skill without keywords as available every turn',()=>{
  const skill:AgentSkill={id:'always',name:'Always',description:'',instructions:'body',enabled:true,autoSelect:true,triggerKeywords:[],createdAt:'now',updatedAt:'now'};
  expect(studioSkillDirectory(workspace([skill]),chat(),'ordinary message')).toEqual([{id:'always',name:'Always',description:''}]);
 });

 it('bounds the directory and keeps explicitly selected entries ahead of automatic matches',()=>{
  const skills=Array.from({length:STUDIO_SKILL_LIMITS.maxDirectoryEntries+8},(_,index):AgentSkill=>({
   id:`auto-${index}`,name:`Auto ${index}`,description:'summary',instructions:`private ${index}`,enabled:true,autoSelect:true,triggerKeywords:['match'],createdAt:'now',updatedAt:'now',
  }));
  skills.push({id:'selected',name:'Selected',description:'chosen',instructions:'private selected',enabled:true,createdAt:'now',updatedAt:'now'});
  const directory=studioSkillDirectory(workspace(skills),chat(['selected']),'match');
  expect(directory).toHaveLength(STUDIO_SKILL_LIMITS.maxDirectoryEntries);
  expect(directory[0]?.id).toBe('selected');
  expect(studioReadSkill(workspace(skills),chat(['selected']),`auto-${STUDIO_SKILL_LIMITS.maxDirectoryEntries+1}`,'match')).toBeNull();
  expect(JSON.stringify(directory)).not.toContain('private');
 });
});

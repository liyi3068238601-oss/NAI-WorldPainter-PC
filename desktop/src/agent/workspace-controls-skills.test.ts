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

describe('on-demand Studio skills',()=>{
 it('ships a practical NovelAI default while retaining the original optional preset bodies',()=>{
  const skills=createBuiltinAgentSkills('2026-10-15T00:00:00.000Z');
  expect(STUDIO_DEFAULT_PRESET_ID).toBe('studio-novelai-assistant');
  expect(STUDIO_BUILTIN_PRESETS.map(preset=>[preset.id,preset.name])).toEqual([
   ['studio-novelai-assistant','presetNovelAiAssistant'],
   ['dsh-infinite-gen-5','presetInfiniteFive'],
   ['dsh-infinite-gen-4','presetInfinite'],
   ['studio-complete','presetComplete'],
  ]);
  expect(skills.map(skill=>skill.id)).toEqual(['builtin-image-generation','builtin-multi-character-composition','builtin-image-editing','builtin-prompt-term-lookup','builtin-creative-memory']);
  expect(skills.every(skill=>skill.builtIn&&skill.enabled&&skill.autoSelect&&skill.triggerKeywords?.length)).toBe(true);
  expect(skills.map(skill=>skill.createdAt)).toEqual(Array(5).fill('2026-10-15T00:00:00.000Z'));
  const generation=skills.find(skill=>skill.id==='builtin-image-generation')!;
  expect(generation.triggerKeywords).toEqual(expect.arrayContaining(['生图','填入提示词','写入工作台','工作台提示词','正向提示词','提示词优化']));
  for(const instruction of ['read_generation_state','write_workbench_prompts','expectedDraftRevision','prepare_generation({})','generate_image','冲突','不重试','工作台真实模型']){
   expect(generation.instructions).toContain(instruction);
  }
  const multi=skills.find(skill=>skill.id==='builtin-multi-character-composition')!;
  expect(multi.instructions).toContain('characterPrompts 是完整数组替换');
  expect(multi.instructions).toContain('删除第 N 项');
  expect(multi.instructions).toContain('传 []');
  const lookup=skills.find(skill=>skill.id==='builtin-prompt-term-lookup')!;
  expect(lookup.triggerKeywords).toEqual(expect.arrayContaining(['查词','标签含义','danbooru']));
  expect(lookup.triggerKeywords).not.toEqual(expect.arrayContaining(['生图','图片','生成图片','改图']));
  expect(lookup.instructions).toContain('search_tags');
  expect(lookup.instructions).toContain('联网搜索');
  expect(studioBuiltinPreset(STUDIO_DEFAULT_PRESET_ID)?.body).toBe(STUDIO_NOVELAI_ASSISTANT_PRESET_BODY);
  expect(STUDIO_NOVELAI_ASSISTANT_PRESET_BODY).toContain('标签语言必须使用英文');
  expect(STUDIO_NOVELAI_ASSISTANT_PRESET_BODY).toContain('用户明确要求生成时');
  expect(STUDIO_NOVELAI_ASSISTANT_PRESET_BODY).toContain('prepare_generation({})');
  expect(STUDIO_NOVELAI_ASSISTANT_PRESET_BODY).toContain('当前 R4 工具目录没有 Pixiv 上传能力');
  expect(STUDIO_NOVELAI_ASSISTANT_PRESET_BODY).toContain('legacy inpaint mode 中 read_generation_state 的 params.positivePrompt');
  expect(STUDIO_NOVELAI_ASSISTANT_PRESET_BODY).toContain('由 renderer 按活跃模式映射到真实 inpaintPositivePrompt');
  expect(STUDIO_NOVELAI_ASSISTANT_PRESET_BODY).toContain('ask_user：缺少会实质影响生成结果');
  expect(STUDIO_NOVELAI_ASSISTANT_PRESET_BODY).toContain('权重范围 0–8，精确到 0.1');
  expect(STUDIO_BUILTIN_PRESETS.map(preset=>preset.body)).toEqual([
   STUDIO_NOVELAI_ASSISTANT_PRESET_BODY,ig5.prompts.studio,infinitePreset.adaptedPrompt,[
    'Help the user plan and create images. Keep replies brief, preserve explicit image constraints, use actual Studio generation tools and receipts. Do not generate when asked only to discuss or inspect.',
    'Focus on NovelAI prompt composition, subject, action, lighting and framing. Preserve explicit tags and exclusions. Explain edits briefly; never invent an executed image.',
    'Analyze attached reference images and separate observed visual details from uncertainty. Preserve requested identity, clothing and composition in the generation plan. Use app image tools only when requested.',
    LYRA_PRESET_SYSTEM_PROMPT,LYRA_PRESET_JAILBREAK_PROMPT,
   ].join('\n\n'),
  ]);
  expect(STUDIO_BUILTIN_PRESETS[1]?.body).toBe(ig5.prompts.studio);
  expect(STUDIO_BUILTIN_PRESETS[2]?.body).toBe(infinitePreset.adaptedPrompt);
  expect(STUDIO_BUILTIN_PRESETS.slice(1).map(preset=>sha256(preset.body))).toEqual([
   '969c9d5893f696cd92a5cd9c18b89213d3fb169a27499310bba8d4c636deb9b6',
   '438f957e8529ddebf3c5d98f8fa1571048e3e3d7db300cd720a1dcdc95c2803d',
   'f919a82bd44f60a138129c13771950872d0dc2d48b7297e7dcadea52dc7ae6e3',
  ]);
  for(const preset of STUDIO_BUILTIN_PRESETS){
   expect(preset.body.length).toBeGreaterThan(20);
  }
  const roles=[{id:'legacy-role',name:'Agent角色卡不应注入',description:'PRIVATE_ROLE_DESCRIPTION'}] as any;
  const refs=studioCreativeReferenceData({characters:roles} as any,{characterIds:['legacy-role'],studioPresetId:STUDIO_DEFAULT_PRESET_ID} as any,[]);
  expect(refs).not.toContain('PRIVATE_ROLE_DESCRIPTION');
  expect(JSON.parse(refs)).not.toHaveProperty('characters');
  expect(STUDIO_READ_SKILL_TOOL_NAME).toBe('read_skill');
  expect(STUDIO_SKILL_LIMITS).toMatchObject({maxSkills:64,maxDirectoryEntries:24,maxSelected:24,maxInstructionsLength:12_000});
 });

 it('makes the workbench Skill available and loads its complete workflow for fill or generation requests',()=>{
  const skills=createBuiltinAgentSkills('now'),ws=workspace(skills);
  const fillText='请把这段提示词写入工作台的正向提示词';
  const generationText='按这个描述生成一张雨夜街景';
  const promptText='帮我优化这段正向提示词，保持画风不变';
  expect(studioSkillDirectory(ws,chat(),fillText).map(item=>item.id)).toContain('builtin-image-generation');
  expect(studioSkillDirectory(ws,chat(),generationText).map(item=>item.id)).toContain('builtin-image-generation');
  expect(studioSkillDirectory(ws,chat(),promptText).map(item=>item.id)).toContain('builtin-image-generation');
  expect(studioSkillDirectory(ws,chat(),generationText).map(item=>item.id)).not.toContain('builtin-prompt-term-lookup');
  expect(studioSkillDirectory(ws,chat(),'帮我画一个原创新场景').map(item=>item.id)).not.toContain('builtin-prompt-term-lookup');
  expect(studioSkillDirectory(ws,chat(),'画《星际远征》里林月这个角色').map(item=>item.id)).toContain('builtin-prompt-term-lookup');
  const loaded=studioReadSkill(ws,chat(),'builtin-image-generation',generationText);
  expect(loaded?.instructions).toBe(skills.find(item=>item.id==='builtin-image-generation')?.instructions);
  expect(loaded?.instructions).toContain('成功后 fresh-read，再调用 prepare_generation({})');
  expect(loaded?.instructions).toContain('只需讨论、分析或提供候选词时直接回复');
  const editText='用蒙版局部重绘，把背景改成海边';
  expect(studioSkillDirectory(ws,chat(),editText).map(item=>item.id)).toContain('builtin-image-editing');
  const editSkill=studioReadSkill(ws,chat(),'builtin-image-editing',editText);
  expect(editSkill?.instructions).toContain('蒙版');
  expect(editSkill?.instructions).toContain('expectedDraftRevision');
  const multiText='画两个角色并分开写 character_1 和 character_2';
  expect(studioSkillDirectory(ws,chat(),multiText).map(item=>item.id)).toContain('builtin-multi-character-composition');
  const multiSkill=studioReadSkill(ws,chat(),'builtin-multi-character-composition',multiText);
  expect(multiSkill?.instructions).toContain('write_workbench_prompts');
  expect(multiSkill?.instructions).toContain('完整数组替换');
  expect(multiSkill?.instructions).toContain('传 []');
  const memoryText='请查一下我之前记住的角色标准穿搭';
  expect(studioSkillDirectory(ws,chat(),memoryText).map(item=>item.id)).toContain('builtin-creative-memory');
  const memorySkill=studioReadSkill(ws,chat(),'builtin-creative-memory',memoryText);
  expect(memorySkill?.instructions).toContain('search_memories');
  expect(memorySkill?.instructions).toContain('待审核候选');
 });

 it('lists only enabled skills selected for the chat or matched for this turn, without their instructions',()=>{
  const skills=createBuiltinAgentSkills('2026-10-15T00:00:00.000Z');
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

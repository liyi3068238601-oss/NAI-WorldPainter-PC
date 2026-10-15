import {describe,expect,it} from 'vitest';
import {createBuiltinAgentSkills,studioReadSkill,studioSkillDirectory,STUDIO_READ_SKILL_TOOL_NAME,STUDIO_SKILL_LIMITS} from './workspace-controls';
import type {AgentConversation,AgentSkill,AgentWorkspaceData} from './types';

const workspace=(skills:AgentSkill[])=>({skills} as AgentWorkspaceData);
const chat=(selectedSkillIds:string[]=[])=>( {selectedSkillIds} as AgentConversation);

describe('on-demand Studio skills',()=>{
 it('provides bounded built-in workflows with image-aware lookup coverage',()=>{
  const skills=createBuiltinAgentSkills('2026-10-15T00:00:00.000Z');
  expect(skills.map(skill=>skill.id)).toEqual(['builtin-image-generation','builtin-image-editing','builtin-prompt-term-lookup']);
  expect(skills.every(skill=>skill.builtIn&&skill.enabled&&skill.autoSelect&&skill.triggerKeywords?.length)).toBe(true);
  expect(skills.map(skill=>skill.createdAt)).toEqual(Array(3).fill('2026-10-15T00:00:00.000Z'));
  const lookup=skills.find(skill=>skill.id==='builtin-prompt-term-lookup')!;
  expect(lookup.triggerKeywords).toEqual(expect.arrayContaining(['生图','改图','角色','作品','标签']));
  expect(lookup.instructions).toContain('langbai_search_tags');
  expect(lookup.instructions).toContain('联网搜索');
  expect(STUDIO_READ_SKILL_TOOL_NAME).toBe('read_skill');
  expect(STUDIO_SKILL_LIMITS).toMatchObject({maxSkills:64,maxDirectoryEntries:24,maxSelected:24,maxInstructionsLength:12_000});
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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';

const fixture=vi.hoisted(()=>({root:''}));
vi.mock('electron',()=>({dialog:{}}));
vi.mock('./store',()=>({
 getSettings:()=>({agentContextWindow:8192,agentAutoCompactThreshold:.8,outputDir:''}),
 getHistoryReferenceItems:()=>[],fileExistsWithDirectoryCache:()=>false,
 readWithBackupRecoverySync:()=>null,atomicWriteFileSync:vi.fn(),rotateBackupsSync:vi.fn(),
}));
vi.mock('./agent-workspace-location',()=>({agentWorkspaceDirectory:()=>fixture.root,rebaseAgentWorkspaceFile:(value:string)=>value}));

import {createAgentConversation,createEmptyAgentWorkspace,deleteAgentSkill,normalizeAgentWorkspace,readAgentWorkspace,resetAgentStoreCacheForTests,setStudioConversationOptions,upsertAgentSkill,writeAgentWorkspace} from './agent-store';
import {STUDIO_SKILL_LIMITS} from '../../src/agent/workspace-controls';

let root='';
beforeEach(()=>{
 root=fs.mkdtempSync(path.join(os.tmpdir(),'nai-agent-skills-'));
 fixture.root=root;
 resetAgentStoreCacheForTests();
});
afterEach(()=>{
 resetAgentStoreCacheForTests();
 if(root){fs.rmSync(root,{recursive:true,force:true});root='';fixture.root='';}
});

describe('Agent skill persistence',()=>{
 it('seeds the seven stable built-in creative skills',()=>{
  const workspace=createEmptyAgentWorkspace();
  expect(workspace.skills.map(skill=>skill.id)).toEqual([
   'builtin-scene-ideation-storyboarding','builtin-novelai-prompt-versions','builtin-multi-character-composition',
   'builtin-image-generation','builtin-image-editing','builtin-prompt-term-lookup','builtin-creative-memory',
  ]);
  expect(workspace.skills.every(skill=>skill.enabled&&skill.builtIn&&skill.autoSelect)).toBe(true);
 });

 it('upgrades old built-in skill bodies while preserving custom skills and disabled choices',()=>{
  const workspace=createEmptyAgentWorkspace();
  const custom={id:'user-skill',name:'My notes',description:'private description',instructions:'private instructions',enabled:true,autoSelect:false,triggerKeywords:['keep me'],createdAt:'older',updatedAt:'older'};
  const legacySkills=workspace.skills
   .filter(skill=>!['builtin-scene-ideation-storyboarding','builtin-novelai-prompt-versions'].includes(skill.id))
   .map((skill,index)=>index===0?{...skill,name:'old product name',instructions:'old built-in body',triggerKeywords:['old trigger'],enabled:false}:skill);
  const migrated=normalizeAgentWorkspace({...workspace,skills:[...legacySkills,custom]});
  expect(migrated.skills).toHaveLength(7+1);
  expect(migrated.skills.find(skill=>skill.id==='builtin-scene-ideation-storyboarding')?.instructions).toContain('画面');
  expect(migrated.skills.find(skill=>skill.id==='builtin-novelai-prompt-versions')?.instructions).toContain('V4.5');
  expect(migrated.skills.find(skill=>skill.id==='builtin-multi-character-composition')).toMatchObject({
   builtIn:true,enabled:false,name:workspace.skills.find(skill=>skill.id==='builtin-multi-character-composition')?.name,
  });
  expect(migrated.skills.find(skill=>skill.id==='builtin-image-generation')?.instructions).not.toBe('old built-in body');
  expect(migrated.skills.find(skill=>skill.id==='user-skill')).toMatchObject({
   name:'My notes',description:'private description',instructions:'private instructions',enabled:true,autoSelect:false,triggerKeywords:['keep me'],createdAt:'older',
  });
 });

 it('persists custom skill metadata and the conversation selection through workspace normalization',()=>{
  const initial=createEmptyAgentWorkspace();
  writeAgentWorkspace(initial);
  const created=upsertAgentSkill({name:'Prompt cleanup',description:'保留内容并整理标签。',instructions:'Clean up a prompt without dropping constraints.',enabled:true,autoSelect:true,triggerKeywords:['整理标签','prompt cleanup']});
  expect(created.ok).toBe(true);
  const skill=created.workspace.skills.find(item=>item.name==='Prompt cleanup')!;
  const selected=setCurrentSkill(created.workspace,skill.id);
  const reopened=normalizeAgentWorkspace(JSON.parse(JSON.stringify(selected)));
  expect(reopened.skills.find(item=>item.id===skill.id)).toMatchObject({
   name:'Prompt cleanup',description:'保留内容并整理标签。',instructions:'Clean up a prompt without dropping constraints.',
   enabled:true,autoSelect:true,triggerKeywords:['整理标签','prompt cleanup'],
  });
  expect(reopened.conversations[0].selectedSkillIds).toContain(skill.id);
  expect(reopened.studioDefaults?.selectedSkillIds).toContain(skill.id);
 });

 it('keeps built-in content product-owned while preserving its enabled choice',()=>{
  const workspace=createEmptyAgentWorkspace(),builtin=workspace.skills[0];
  const tampered=normalizeAgentWorkspace({...workspace,skills:[{...builtin,name:'Tampered',instructions:'tool: run shell',triggerKeywords:['anything'],enabled:false}]});
  expect(tampered.skills.find(item=>item.id===builtin.id)).toMatchObject({name:builtin.name,instructions:builtin.instructions,triggerKeywords:builtin.triggerKeywords,enabled:false,builtIn:true});
  writeAgentWorkspace(workspace);
  const toggled=upsertAgentSkill({...builtin,enabled:false});
  expect(toggled.ok).toBe(true);
  expect(toggled.workspace.skills.find(item=>item.id===builtin.id)?.enabled).toBe(false);
  const rejected=upsertAgentSkill({...builtin,name:'replacement',instructions:'replacement',enabled:false});
  expect(rejected.ok).toBe(false);
 });

 it('bounds and normalizes trigger keywords, and removes deleted skill selections',()=>{
  const workspace=createEmptyAgentWorkspace();writeAgentWorkspace(workspace);
  expect(upsertAgentSkill({name:'Too many keywords',instructions:'body',triggerKeywords:Array.from({length:33},(_,i)=>`k${i}`)}).ok).toBe(false);
  expect(upsertAgentSkill({name:'Too long keyword',instructions:'body',triggerKeywords:['x'.repeat(STUDIO_SKILL_LIMITS.maxTriggerKeywordLength+1)]}).ok).toBe(false);
  const result=upsertAgentSkill({name:'Triggers',instructions:'body',triggerKeywords:[' one ','one',...Array.from({length:31},(_,i)=>`k${i}`)],autoSelect:true});
  const skill=result.workspace.skills.find(item=>item.name==='Triggers')!;
  expect(skill.triggerKeywords).toHaveLength(32);
  expect(skill.triggerKeywords?.[0]).toBe('one');
  expect(skill.triggerKeywords?.[1]).toBe('k0');
  const selected=setCurrentSkill(result.workspace,skill.id);
  const removed=deleteAgentSkill(skill.id);
  expect(removed.ok).toBe(true);
  expect(removed.workspace.skills.some(item=>item.id===skill.id)).toBe(false);
  expect(removed.workspace.conversations.every(chat=>!chat.selectedSkillIds?.includes(skill.id))).toBe(true);
  expect(removed.workspace.studioDefaults?.selectedSkillIds).not.toContain(skill.id);
  void selected;
 });

 it('preserves existing over-limit skills while limiting selection and new library writes',()=>{
  const workspace=createEmptyAgentWorkspace();
  const firstCustomSkillIndex=workspace.skills.length;
  const crowded={...workspace,skills:[...workspace.skills,...Array.from({length:STUDIO_SKILL_LIMITS.maxSkills+5},(_,index)=>({
   id:`custom-${index}`,name:'N'.repeat(100),description:'D'.repeat(400),instructions:'I'.repeat(15_000),enabled:true,createdAt:'now',updatedAt:'now',
  }))]};
  const bounded=normalizeAgentWorkspace(crowded);
  expect(bounded.skills).toHaveLength(workspace.skills.length+STUDIO_SKILL_LIMITS.maxSkills+5);
  expect(bounded.skills[firstCustomSkillIndex]).toMatchObject({
   name:'N'.repeat(100),
   description:'D'.repeat(400),
   instructions:'I'.repeat(15_000),
  });
  expect(bounded.conversations[0].selectedSkillIds).toHaveLength(0);
  writeAgentWorkspace(bounded);
  expect(upsertAgentSkill({name:'overflow',instructions:'body'})).toMatchObject({ok:false});
  const existing=bounded.skills[firstCustomSkillIndex];
  const toggled=upsertAgentSkill({...existing,enabled:false});
  expect(toggled.ok).toBe(true);
  expect(toggled.workspace.skills.find(skill=>skill.id===existing.id)).toMatchObject({enabled:false,instructions:existing.instructions});
  const rejectedEdit=upsertAgentSkill({...existing,name:'Updated',instructions:existing.instructions});
  expect(rejectedEdit.ok).toBe(false);
  expect(rejectedEdit.workspace.skills.find(skill=>skill.id===existing.id)?.instructions).toBe(existing.instructions);
  const ids=bounded.skills.map(skill=>skill.id);
  expect(setStudioConversationOptions(bounded.conversations[0].id,{selectedSkillIds:ids}).ok).toBe(false);
  const selected=setStudioConversationOptions(bounded.conversations[0].id,{selectedSkillIds:ids.slice(0,STUDIO_SKILL_LIMITS.maxSelected)});
  expect(selected.workspace.conversations[0].selectedSkillIds).toHaveLength(STUDIO_SKILL_LIMITS.maxSelected);
 });

 it('new chats inherit the persisted skill selection, while old chat history remains unchanged',()=>{
  const workspace=createEmptyAgentWorkspace();writeAgentWorkspace(workspace);
  const result=upsertAgentSkill({name:'Per-chat',instructions:'body'}),skill=result.workspace.skills.find(item=>item.name==='Per-chat')!;
  setCurrentSkill(result.workspace,skill.id);
  const next=createAgentConversation('New skill chat');
  const chat=next.workspace.conversations.find(item=>item.id===next.workspace.selectedConversationId)!;
  expect(chat.selectedSkillIds).toContain(skill.id);
  expect(readAgentWorkspace().skills.find(item=>item.id===skill.id)?.instructions).toBe('body');
 });

 it('derives studio defaults from the normalized fallback conversation when the saved ID is stale',()=>{
  const workspace=createEmptyAgentWorkspace(),conversation=workspace.conversations[0];
  conversation.studioApprovalMode='auto';conversation.studioWebSearchEnabled=false;
  const restored=normalizeAgentWorkspace({...workspace,selectedConversationId:'missing',studioDefaults:undefined});
  expect(restored.selectedConversationId).toBe(conversation.id);
  expect(restored.studioDefaults).toMatchObject({studioApprovalMode:'auto',studioWebSearchEnabled:false});
 });
});

function setCurrentSkill(workspace:ReturnType<typeof createEmptyAgentWorkspace>,skillId:string){
 const chat=workspace.conversations[0];
 return setStudioConversationOptions(chat.id,{selectedSkillIds:[...(chat.selectedSkillIds??[]),skillId]}).workspace;
}

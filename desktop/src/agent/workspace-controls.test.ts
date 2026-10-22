import {describe,expect,it} from 'vitest';
import {createBuiltinAgentSkills,studioReadSkill,studioSkillDirectory,STUDIO_SKILL_LIMITS} from './workspace-controls';
import type {AgentConversation,AgentSkill,AgentWorkspaceData} from './types';

describe('workbench parameter skill',()=>{
 const skills=createBuiltinAgentSkills('now');
 const workspace={skills} as AgentWorkspaceData;
 const chat={selectedSkillIds:[]} as unknown as AgentConversation;

 it('auto-selects the workbench workflow for common parameter requests',()=>{
  for(const message of [
   '步数改为28',
   'cfgScale 调到5',
   'seed 改成42',
   '尺寸设成1024x1024',
   '模型切换到 nai-diffusion-5-full',
   'sampler 改成 k_euler',
   'batchCount 设为4',
   'effort 改成 high',
   'effort 改成 high 并把 steps 调成28',
   'strength 设为0.7',
   '种子设为42',
   '改成4张',
   '张数改为4',
   '间隔2秒',
   '重绘强度0.6',
   '宽度1024',
   '高度768',
   '透明背景',
   '质量设为light',
  ]){
   expect(studioSkillDirectory(workspace,chat,message).map(skill=>skill.id)).toContain('builtin-image-generation');
  }
  expect(skills.find(skill=>skill.id==='builtin-image-generation')?.triggerKeywords?.length).toBeLessThanOrEqual(STUDIO_SKILL_LIMITS.maxTriggerKeywords);
 });

 it('loads the canonical parameter write path and its model/effective-value boundaries',()=>{
  const skill=studioReadSkill(workspace,chat,'builtin-image-generation','步数改为28');
  expect(skill?.instructions).toContain('write_workbench_parameters');
  for(const rule of [
   'parameterControls.writeSupported=true',
   'editableFields',
   '按当前值与 patch 合并后的目标组合、工具 schema、parameterControls.models 与 limits 判断目标字段是否支持',
   '普通参数 patch 只写用户明确指定且当前 editableFields 允许的字段',
   '即使它不在旧组合的 editableFields 中',
   '由 write_workbench_parameters 做最终校验',
   '不要为普通 model/effort 切换预先清理已有参数或额外追问',
   'effectiveParameters 才表示实际生效值',
   'Medium 实际使用 14 步、Euler、cfgRescale=0、ucPreset=0',
   '第二次 expectedDraftRevision 使用第一次成功回执的 draftRevision',
   'maxAssistantGenerationCount 限制（当前为 8）',
   '含 NAI relay',
   'openai-images 独立配置',
  ]){
   expect(skill?.instructions).toContain(rule);
  }
 });

 it('enforces the trigger keyword matching limit',()=>{
  expect(STUDIO_SKILL_LIMITS.maxTriggerKeywords).toBe(64);
  const keywords=Array.from({length:STUDIO_SKILL_LIMITS.maxTriggerKeywords+1},(_,index)=>`boundary-${String(index).padStart(3,'0')}`);
  const skill:AgentSkill={id:'trigger-boundary',name:'Trigger boundary',description:'',instructions:'body',enabled:true,autoSelect:true,triggerKeywords:keywords,createdAt:'now',updatedAt:'now'};
  const customWorkspace={skills:[skill]} as AgentWorkspaceData;
  expect(studioSkillDirectory(customWorkspace,chat,'boundary-063').map(item=>item.id)).toContain('trigger-boundary');
  expect(studioSkillDirectory(customWorkspace,chat,'boundary-064').map(item=>item.id)).not.toContain('trigger-boundary');
 });
});

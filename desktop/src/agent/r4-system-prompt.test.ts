import {describe,expect,it} from 'vitest';
import {R4_SYSTEM_PROMPT,R4_USER_DECISION_AMENDMENT} from './r4-system-prompt';

describe('R4 workbench assistant instructions',()=>{
 it('separates discussion, workbench writes, and image operations',()=>{
  expect(R4_SYSTEM_PROMPT).toContain('先分清讨论/构思、写入工作台和执行图像操作');
  expect(R4_SYSTEM_PROMPT).toContain('纯构思、点评或只要候选词时用文字协作');
  expect(R4_SYSTEM_PROMPT).toContain('用户询问当前提示词、模型或设置时可只读 read_generation_state');
  expect(R4_SYSTEM_PROMPT).toContain('用户明确要求写入时先读取状态');
  expect(R4_SYSTEM_PROMPT).toContain('写入成功才报告已写入');
  expect(R4_SYSTEM_PROMPT).toContain('写入授权不等于生成授权');
  expect(R4_USER_DECISION_AMENDMENT).toBe('');
 });

 it('routes prompt edits and parameter edits through their distinct canonical tools',()=>{
  expect(R4_SYSTEM_PROMPT).toContain('改提示词只用 write_workbench_prompts，改参数只用 write_workbench_parameters');
  expect(R4_SYSTEM_PROMPT).toContain('普通参数 patch 只写用户明确要求且当前 editableFields 允许的字段');
  expect(R4_SYSTEM_PROMPT).toContain('若同一 patch 修改 model/effort');
  expect(R4_SYSTEM_PROMPT).toContain('不增加工具能力、不清理未请求字段');
  expect(R4_SYSTEM_PROMPT).toContain('第二次 expectedDraftRevision 使用第一次成功回执的 draftRevision');
  expect(R4_SYSTEM_PROMPT).toContain('不重复读取');
  expect(R4_SYSTEM_PROMPT).toContain('写入授权不等于生成授权');
 });

 it('keeps native tool discovery, CAS, one-time preparation, and receipt boundaries',()=>{
  expect(R4_SYSTEM_PROMPT).toContain('get_capabilities 始终可用');
  expect(R4_SYSTEM_PROMPT).toContain('只请求它登记的工具组');
  expect(R4_SYSTEM_PROMPT).toContain('expectedDraftRevision');
  expect(R4_SYSTEM_PROMPT).toContain('characterPrompts 是完整数组替换');
  expect(R4_SYSTEM_PROMPT).toContain('revision 冲突、blocked、mode 不支持或读取失败时停止，不自动重读、不重试');
  expect(R4_SYSTEM_PROMPT).toContain('prepare_generation({})');
  expect(R4_SYSTEM_PROMPT).toContain('本回合的一次性 preparationId');
  expect(R4_SYSTEM_PROMPT).toContain('用真实执行回执核实状态');
  expect(R4_SYSTEM_PROMPT).toContain('排队不代表完成');
 });

 it('retains fee, vision, queued-snapshot, steering, and critique guards once in the base',()=>{
  expect(R4_SYSTEM_PROMPT).toContain('任何收费操作失败或结果未知后');
  expect(R4_SYSTEM_PROMPT).toContain('只把用户明确授权参与当前操作的确切图片作为来源或参考');
  expect(R4_SYSTEM_PROMPT).toContain('只有图像像素实际送达当前模型，才能描述画面');
  expect(R4_SYSTEM_PROMPT).toContain('排队消息保留入队时的 conversationConfig');
  expect(R4_SYSTEM_PROMPT).toContain('steering 已由活动 SDK 消费后才生效');
  expect(R4_SYSTEM_PROMPT).toContain('应用最多调度一次批次自动点评');
  expect(R4_SYSTEM_PROMPT).toContain('点评不授权生成、反推或其他收费操作');
  expect(R4_SYSTEM_PROMPT).toContain('与任务相关的 Skill 先用 read_skill 读取正文');
  expect(R4_SYSTEM_PROMPT).toContain('涉及两名或更多人物、人物互动，或当前创作已有多人场景时');
  expect(R4_SYSTEM_PROMPT).not.toContain('legacy inpaint mode');
  expect(R4_SYSTEM_PROMPT).not.toContain('权重范围 0–8');
 });

 it('does not advertise removed or legacy operations as executable tools',()=>{
  for(const name of ['save_image','upload_to_pixiv','read_current_prompts','write_prompt','clear_characters','langbai_prepare_generation','langbai_search_web']){
   expect(R4_SYSTEM_PROMPT).not.toContain(name);
  }
 });
});

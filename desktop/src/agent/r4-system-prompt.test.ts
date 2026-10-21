import {describe,expect,it} from 'vitest';
import {R4_SYSTEM_PROMPT,R4_USER_DECISION_AMENDMENT} from './r4-system-prompt';

describe('R4 workbench assistant instructions',()=>{
 it('directly writes explicitly requested prompt changes with a revision guard',()=>{
  expect(R4_USER_DECISION_AMENDMENT).toContain('直接按意图写实际工作台');
  expect(R4_USER_DECISION_AMENDMENT).toContain('read_generation_state');
  expect(R4_USER_DECISION_AMENDMENT).toContain('draftRevision 作为 expectedDraftRevision');
  expect(R4_USER_DECISION_AMENDMENT).toContain('write_workbench_prompts');
  expect(R4_USER_DECISION_AMENDMENT).toContain('不追加确认步骤');
  expect(R4_USER_DECISION_AMENDMENT).toContain('省略字段保持不变');
  expect(R4_USER_DECISION_AMENDMENT).toContain('空字符串只用于用户明确要求清空');
  expect(R4_USER_DECISION_AMENDMENT).toContain('revision 冲突、blocked 或状态不可用表示未应用');
  expect(R4_USER_DECISION_AMENDMENT).toContain('单纯讨论、点评或输出候选词不写工作台');
  expect(R4_USER_DECISION_AMENDMENT).toContain('readStatus 为 ok 并读取当前 mode');
 });

 it('writes new image prompts to the workbench before preparing from a fresh snapshot',()=>{
  expect(R4_USER_DECISION_AMENDMENT).toContain('用户明确要求生成时，使用当前生成工作台作为实际输入');
  expect(R4_USER_DECISION_AMENDMENT).toContain('收到 write_workbench_prompts 成功回执后，fresh-read 工作台并调用 prepare_generation({})');
  expect(R4_USER_DECISION_AMENDMENT).toContain('用户要求沿用当前词和角色项，则读取工作台后直接 prepare_generation({})');
  expect(R4_USER_DECISION_AMENDMENT).toContain('写词本身不授权生成');
  expect(R4_USER_DECISION_AMENDMENT).toContain('prepare_generation({}) 冻结当前工作台快照');
  expect(R4_USER_DECISION_AMENDMENT).toContain('characterPrompts 是工作台的完整数组替换');
  expect(R4_USER_DECISION_AMENDMENT).toContain('清空传 []');
  expect(R4_USER_DECISION_AMENDMENT).toContain('不要把局部重绘词写到错误 mode');
  expect(R4_USER_DECISION_AMENDMENT).toContain('legacy inpaint mode 中 read_generation_state 的 params.positivePrompt 表示当前独立重绘正向词');
  expect(R4_USER_DECISION_AMENDMENT).toContain('由 renderer 按活跃模式映射到工作台真实 inpaintPositivePrompt');
  expect(R4_USER_DECISION_AMENDMENT).toContain('不虚构独立 inpaint_negative');
  expect(R4_SYSTEM_PROMPT).toContain('write_workbench_prompts');
 });

 it('keeps skills as loaded guidance and preserves authorization, receipts and no-retry boundaries',()=>{
  expect(R4_SYSTEM_PROMPT).toContain('先用 read_skill 读取正文并按其流程行动');
  expect(R4_SYSTEM_PROMPT).toContain('只把用户明确授权参与生成的确切图片作为参考');
  expect(R4_SYSTEM_PROMPT).toContain('一次性 preparation');
  expect(R4_SYSTEM_PROMPT).toContain('真实回执核实');
  expect(R4_SYSTEM_PROMPT).toContain('停止本轮及关联批次的后续收费调用');
  expect(R4_SYSTEM_PROMPT).toContain('不换工具、参数、账号、批次或 preparation 重试');
  expect(R4_SYSTEM_PROMPT).toContain('已发送和排队的文字消息保留入队时的原始指令、对话模型与助手预设快照');
  expect(R4_SYSTEM_PROMPT).toContain('需要当前提示词或角色项时，用 read_generation_state 读取当时的 Generate 工作台');
  expect(R4_SYSTEM_PROMPT).toContain('图像任务只在获授权入队后保留该快照');
  expect(R4_SYSTEM_PROMPT).toContain('之后的工作台变化只影响后续新准备，不修改已入队任务');
  expect(R4_SYSTEM_PROMPT).toContain('运行时确认同创作引导已被活动 SDK 消费后才生效');
  expect(R4_SYSTEM_PROMPT).toContain('批次自动点评由应用最多调度一次');
  expect(R4_SYSTEM_PROMPT).toContain('不授权生成、反推或其他收费操作');
  expect(R4_SYSTEM_PROMPT).toContain('使用已挂载的 ask_user');
  expect(R4_SYSTEM_PROMPT).not.toContain('助手每次生图');
  expect(R4_SYSTEM_PROMPT).not.toContain('不得自动继承、追加或覆盖工作台当前提示词');
 });
});

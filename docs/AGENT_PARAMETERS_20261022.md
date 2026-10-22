# 助手操作生成页参数

日期：2026-10-22。开发分支：`feat/agent-r4-refactor`。

## 已接入

新增 PC 原生工具 `write_workbench_parameters({expectedDraftRevision, patch})`。
助手先通过 `read_generation_state` 读取工作台及参数能力，再直接修改当前生成页草稿。
提示词继续使用 `write_workbench_prompts`。同一请求依次写提示词和参数时，后一次使用前一次成功回执中的版本。

| 参数 | 字段和限制 |
| --- | --- |
| 模型、生成档位 | `model`、`effort`，使用当前动漫/Furry 模式允许的实际模型目录 |
| 尺寸 | `width`、`height`，64 的倍数，总像素不超过 3,145,728 |
| 步数、引导强度 | `steps` 1–50、`cfgScale` 0–10、`cfgRescale` 0–1 |
| 采样与噪声计划 | `sampler`、`noiseSchedule`，按当前模型能力验证 |
| 种子 | `seed` 为 uint32；明确数字默认切换 `seedMode=fixed`，随机用 `random` |
| 张数、间隔 | `batchCount` 1–999、`batchIntervalSeconds` 0–3600；助手单次生图仍最多 8 张 |
| 质量与高级选项 | `ucPreset`、`qualityPreset`、透明背景、SMEA/Dyn、Variety，按模型能力验证 |
| 图生图 | `strength`、`i2iSizeMode`；明确宽高会同步切到自定义尺寸 |

只设置参数不会生成图片。固定种子的批次逐张递增，并在 uint32 范围内回绕。
V5 Full Medium 实际固定 14 步、Euler Ancestral、CFG Rescale 0、UC 0；要自定义这些值需明确切至 High。

## 数据与操作边界

- 主进程和 renderer 均校验参数。renderer 再次检查同一 draft ID/revision 后同步一次提交，保存一次；版本冲突与无效参数都不会部分写入或自动重试。
- 改动只覆盖明确字段及必要关联字段。种子模式、图生图尺寸模式、质量兼容字段和与本次参数重叠的元数据回放字段会在回执中列明。其它提示词、角色、来源、蒙版、参考图及无关元数据保留。
- 切换模型会检查已启用角色数量与参考图兼容性，不静默删角色或参考图。与目标模型冲突的参数需在同一 patch 中明确调整。
- `read_generation_state.parameterControls` 返回当前可写字段、模型目录、工作台值、生效值和限额；模型能力取自实时工作台。适用的高级元数据回放覆盖单独返回，Medium 不误报为已启用。
- 当前支持 NovelAI Generate 文生图/图生图，包括相同 NAI 协议的 relay 账号。OpenAI Images 使用独立服务配置；独立重绘、增强和后处理画布未在本次开放参数写入，不向它们写入无效的 Generate 参数。
- 工作台仍可设置最多 999 张供手动队列使用；助手生图的既有 1–8 张约束保留，不自动拆分收费批次。图生图 noise/extraNoiseSeed 未新增接口，避免宣称未被当前 R4 请求消费的值已生效。
- 现有四个内置预设和七个 Skill 保留。仅扩展工作台 Skill 的参数操作流程与匹配词；Skill 触发关键词上限提升到 64。

## 验证

- 完整 Vitest：4,578 项通过、0 失败、2 跳过，508 个文件。
- TypeScript 检查、renderer/Electron 构建通过。
- 覆盖实际 Zustand 工作台写入、原子保存、IPC 间手动修改竞争、渠道切换冲突、参数回执、模型切换、元数据覆盖、图生图尺寸模式恢复，以及更新后参数被生成预览冻结。
- EXE 资源与启动检查结果随测试包 `BUILD-INFO.json` 和 `verification/` 提供。
- 全程使用本地夹具和模拟服务；未调用真实付费模型或图像接口。

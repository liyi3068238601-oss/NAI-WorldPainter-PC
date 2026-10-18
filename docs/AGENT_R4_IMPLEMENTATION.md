# R4 Final 产品实施记录

开始日期：2026-10-18。开发分支：`feat/agent-r4-refactor`，起点 `dfd7caa63ae19bd40651e00127a71efe57b71b4e`。

用户已授权修改实际产品代码，目标是完成 R4 Final 全部 Agent 改造。设计基线目录 `docs/agent-refactor-v3.2-r4-final` 保持冻结。主产品为 `desktop/` Electron/React/Pi；旧 Flutter、原始设计 ZIP 和用户数据保留。R4 产品接线、本地自动回归、隔离原生运行与 Windows x64 目录打包已完成；外部服务及冻结矩阵尚未实测的分支单列在验收报告，不把本地合成证据升级为正式服务验收。

## 调查与复用

- 复用当前 Pi 0.84.4 Agent、四种对话协议、供应商凭据管理、知识/Skill/模板/记忆和图像后端；按安装版本 README 与源码核对原生工具、工具发现和安全节点引导。
- 旧 `pi-agent-core` 的 `{args:{...}}` 继续用于旧历史；新模型调用接入 canonical 平铺合同，动态挂载只影响后续模型请求。
- 旧准备保存在内存、执行同步、文字繁忙即拒绝，缺少创作/提案/执行持久对象。新实现须建立真正的 durable store/worker，并为实际每次发送保留证据。
- Agent JSON 工作区 normalizer 对未知版本会回到空默认值；迁移前必须保留原字节，未知版本拒绝覆盖。正式数据不参与开发测试。

## 完整范围与完成门槛

| 阶段 | 必须落地内容 | 权威验收 | 当前状态 |
| --- | --- | --- | --- |
| 数据与合同 | 原工作区/预设无损迁移；创作、提案、图片输入与修订；36 工具输入/结果及执行语义；版本化 schema | 真实 store 读回、原件 hash、239 结构用例及全部跨字段反例 | 已接线；合同、SQL 和迁移回归通过 |
| 首个完整流程 | 读取创作→方案或同轮改参考→冻结预览→授权与原子入队→worker→登记可读附件→查询与对话展示 | 真实 Pi SDK + host + SQLite + fake provider；第二张派生编辑及重开 store | 实际产品路径已贯通并通过本地集成 |
| 五类图像与事务 | generation/redraw/inpaint/upscale/process；取消竞争、失败 gate、未知回执、重启暂停与手动恢复、幂等、费用/种子事实 | 五个入口真实本地 HTTP/SQL 故障矩阵；worker 脚本 provider 合同矩阵 | 已接线；15 项 HTTP 故障用例、五操作 SQLite 重开及共享取消状态机通过 |
| 对话与配置 | 会话串行队列、排队取消恢复、引导单次消费、因果历史、配置快照、预设独立默认/共享修订、一次自动点评 | 真实消费回调、SQL 配置与队列、实际像素、消息/回执原子交付 | 已接线；回归及独立审查通过，明确选择新消息 B 的端到端用例通过 |
| 产品界面 | 三栏、顶部创作与范围、方案卡、当前创作、源/参考胶囊、统一预览、队列/取消/恢复、完整查看器和原图下载、窄窗/焦点 | React 测试、隔离 Electron main/preload/renderer、横/竖图查看 | 已接线；原生交互、800/1280/1920 视口、横竖图及重启 smoke 通过 |
| 保留与收尾 | 原有工作台、图库、资源、预设/Skill/记忆、渠道及导入导出仍可达；打包/重开 | 全量回归、类型检查、构建、Windows运行、迁移读回分别记录 | 全量 4336 通过/0失败/2跳过；类型、构建、Windows x64 目录打包及打包程序冷启动通过 |

## 已执行的开发检查

- frozen registry 文件逐字节复用，SHA-256 为 `91d25a6f3a4e62fc4e7e8f912e654f15d602a4bbd799ffd335afec9ea3c057d4`；产品新增说明单列于系统提示词 amendment。
- `r4-store` 使用 Electron 自带 `node:sqlite`，workspace、R4 状态、submission key/output slot 索引共用事务。旧 JSON/备份保持原字节；未知版本、损坏、导入冲突、丢失预设均 fail-closed。旧归档按各会话原绑定迁移，portable capsule 保留 SQL、附件和本机绑定 key。
- `r4-creative-host` 负责版本方案、输入 CAS、精确参考授权及撤销；`r4-execution-coordinator/worker` 负责批准快照、入队、逐请求回执、恢复和 gate。每个真实图片/Vibe/放大 POST 之前均有持久边界，R4 请求关闭隐式重试和兼容回退。
- `r4-agent-runtime` 接入实际 Pi 消费者。文字消息在发送时冻结配置，排队项可取消/恢复，引导只在 SDK 确认消费时推进输入。因果历史包含前序迟到产物，排除后续消息。原工作台的应用操作走独立 diff/CAS。
- `r4-paid-service` 为转换、改写、反推保留发送前记录和结果；同操作重放返回原回执，已越过发送边界的崩溃记录转 unknown，未越界记录标为未发并阻止重放。实际 HTTP POST 使用单次边界，阻止旧服务的模板纠正或空响应自动重试。自动点评读取原图片字节与原模型/预设快照，在同聊天串行器运行，消息与 delivered 回执共同提交。
- 四种对话协议经过真实本机 HTTP → 安装版 Pi SDK → canonical preflight：8 项通过，包括 malformed 参数不得授权/进入 handler、503 只有一次请求。五类图片真实 native adapter → 本机 HTTP 故障矩阵：15 项通过。上述服务均为本地合成服务。
- 最终全量报告：[vitest-final.json](evidence/agent-r4/2026-10-18/vitest-final.json)，480 个文件、4338 项测试、**4336 通过、0 失败、2 跳过**。两项跳过为原有可选 Real-CUGAN CLI 及外部混合 Vibe bundle fixture；完整名称记录在 [validation-summary.json](evidence/agent-r4/2026-10-18/validation-summary.json)。`npm run typecheck`、`npm run build` 均 exit 0；构建保留原有大 chunk 警告。
- Windows x64 `electron-builder --dir` exit 0。33 个关键打包文件与当前构建逐字节相同，Ajv 2020 和 R4 模块均入包。源 registry 与冻结基线逐字节相同；TypeScript 重排运行时 JSON 空白，打包 registry 与源文件解析内容相同。SHA-256 及清单见 [build-manifest.json](evidence/agent-r4/2026-10-18/build-manifest.json)。
- 隔离 userData 中运行实际 Electron/main/preload/renderer 并重启，验证本地图片 URL、横竖图完整查看、批次导航、用途切换撤销授权、键盘焦点、队列与工作台/冻结输入预览、取消消息恢复为草稿。800/1280/1920 视口无水平溢出。随后启动实际打包 executable，确认 `app.asar` renderer/preload/SQLite 和主要 Agent UI 可用，原暂停项与 unknown gates 未自动恢复，renderer 错误为 0。合成 profile 和真实程序运行层分别记录。

## 实施期间确认的最终规则

1. 助手与工作台分开。助手的正面、负面、风格提示词由 AI 明确给出；省略的负面/风格为空，不继承工作台锁定词、保存词或兼容服务保留负面词。用户要保留特定词时，在对话中明确提醒。工作台应用仍须独立预览并确认。
2. 改图源持续保留，普通聊天、入队和完成不清除。明确处理其他作品只影响该次冻结输入；只有移除、换图或“继续修改”明确改变当前源。
3. “仅讨论”不能带生成用途或勾选参与生成。更换色彩/构图/角色/氛围用途后，原参与授权不扩展到新用途；模型传 true 不能自证授权。
4. 新聊天默认、会话预设绑定、共享预设正文修订各有明确入口；共享编辑保留版本，旧消息/任务仍使用原快照。
5. 重启后的确定未发任务暂停，显式“继续队列”后才发送。可能已发的任务只核实，不把本地取消等同远端取消，迟到结果仍归原聊天/创作。
6. 反推、改写或自动点评的请求回执不明时，用户可明确选择无关的新任务 B 继续。恢复许可只覆盖 B 和确认时列出的旧 gate；原请求 A 继续待核实、绝不重发，不把继续 B 解释为取消、退款或释放所有任务。后出现的新 unknown 仍阻止自动收费。

## 证据与限制

逐条 T01–T29/U01–U07 的实现与验证层级见 [AGENT_R4_ACCEPTANCE.md](AGENT_R4_ACCEPTANCE.md)。统一证据入口为 [证据说明](evidence/agent-r4/2026-10-18/README.md)，包含最终全量报告、构建清单、隔离原生收据和截图。

本次完成实施与上述本地验证，没有发送真实收费请求，没有读写真实用户 profile。真实模型/图片账号行为、原生供应商远端取消、多显示器/DPI、物理断电及冻结矩阵的未覆盖组合不在通过结论内；对应验收行保留“部分”。当前 native adapter 不宣称支持服务端取消，取消后仍保留迟到的真实结果。

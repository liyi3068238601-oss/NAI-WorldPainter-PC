# R4 Final 迁移交接与历史源码审查

2026-10-18 Final：本轮只修改设计文档、schema/离线校验和独立 HTML，未修改产品源码。本地 HEAD 仍为下列固定提交。以下源码细节保留为 R3/R4 历史审查，不宣称本轮重新运行产品或完整重审源码；当前规范与实施入口以 FINAL_REVIEW.md、TOOLS_AND_FLOWS.md 和 ACCEPTANCE_MATRIX.md 为准。

Final 新增的实现要求包括 D20 源图生命周期、发送配置冻结、预设启停的版本化新绑定、精确用途 opt-in、prior_paid_failure 派发保护以及取消结果分支收紧。先按本包合同 hash 固定实施基线，再完成真实 host + fake provider 的首个闭环；本轮没有开始接线。

## 原 R4 固定 HEAD 记录

- R4 本次范围：只修订本文件与 `ACCEPTANCE_MATRIX.md` 中的验收规格索引；未修改产品源码、registry、`TOOLS_AND_FLOWS.md` 或 `SYSTEM_PROMPT.md`，未实施 host 接线，也未运行产品测试。
- 下文原固定 HEAD 源码核对保留为 R3 的只读审查记录，不代表本次重新审计源码或实测 R4 目标协议。HTML 原型/schema/设计文档不能证明产品 host 行为。
- 检查时间：2026-10-16 11:10:39 +08:00。
- 固定提交：`dfd7caa63ae19bd40651e00127a71efe57b71b4e`；本地 `git rev-parse HEAD` 与用户报告列出的 SHA 一致。本轮未连接 GitHub 核验远端分支，也未运行产品、测试、模型或图像服务。
- 范围：用户报告 `docs/agent-refactor-v3.2-r3/source/复审与实施前修订清单.md`；旧设计 `docs/agent-refactor-v3/TOOLS_AND_FLOWS.md` 与 `SYSTEM_PROMPT.md`；固定提交中的 Pi schema/core/turn、runtime、tool handler、image provider、generation preparation、job registry，以及 `agent-store.ts` 预设规范化路径。源码只读审查。本轮没有修改产品文件；只新增/修改 R3 设计与验收文档。没有运行产品测试或真实模型/图像服务；独立 HTML 浏览器检查另见 VERIFICATION。
- 结论：报告关于异步边界、ID 映射、持久化、失败停发和取消粒度的主要风险都有源码依据。报告将工具参数包络概括到内部 execute 层时略宽；此外 prepare 指纹会拒绝部分设置漂移，不能说成无条件静默采用新设置。其余内容作为“目标协议尚待实现”的建议成立。下文依据均指固定 HEAD，不代表 v3.2 设计已经接入。
- 根据用户确认的行为，本轮设计将目标 canonical registry 扩为 36 项（原 33 项加 `read_creation`、`read_proposal`、`patch_creation_inputs`）。固定 HEAD 的 `desktop/electron` 中未检出这三个名称；前两个是新设计的只读工具，第三个是待实现的输入写入工具，不能写成现有产品能力。

## 关键报告主张与源码核对

| 项目 | 固定 HEAD 证据 | 独立判断与迁移约束 |
| --- | --- | --- |
| 平铺参数不是只改模型描述 | pi-agent-core.ts:125–141 把 Pi 的 parameters 包成 args 对象，execute 从 params.args 解包；154–165 的 beforeToolCall 同样解包。pi-studio-tool-schema.ts:20 说明它定义 args 包内字段。pi-agent-turn.ts:163–187、298–310 重建/解析 native 事件。 | **主张成立，但需收窄措辞：**Pi 边界使用 args envelope；StudioPiTool.execute 和 executeAgentTool 收到的是解包后的平铺 record。新协议应改 Pi exposure、授权、事件、结果归一和历史 projection 的边界 adapter，不要把内部业务 handler 再套一层 args。 |
| 当前历史投影不能当作新持久协议 | pi-agent-turn.ts:163–187 按 toolHistory 合成 `history_n` call ID 与同 ID result；将 tool.input 重新包成 args，status 只把 completed 视为成功。 | **主张方向成立。**当前工具记录不是原生 Pi 消息的原样持久化。迁移要保留可得的原始历史与版本；旧记录缺失 call ID/字段时只做惰性投影，不填当前 UI 创作，不伪造 schema 合法性或成功状态。 |
| paidFailed 不覆盖 accepted 后的异步终态 | pi-agent-core.ts:97–98、133–141 以单次 Pi 回合局部变量记录 execute 等待期间的异常；154–161 仅在之后工具调用前检查此值。pi-studio-tools.ts:255–280 也等待 executeAgentTool 返回才发回 tool result。 | **条件性主张成立。**固定 HEAD 当前图像 handler 同步等待结果；若改成 accepted 后由 worker 异步失败，旧 turn 闭包不会收到后来的 receipt。必须由持久 host batch/turn gate 在每次 dispatch 前检查，逐项 error/unknown 先落盘再唤醒 worker。不能把它写成当前已存在后台异步队列的故障。 |
| paidActions 不是持久幂等 | pi-agent-core.ts:72–76、97–98、137、160–161 以工具名加 stable args 放在本回合 Set 中；pi-studio-tool-schema.ts:37 的 generate_image 唯一入参为 preparationId。 | **主张成立。**换 preparationId 会得到不同键，重启也会丢 Set。保留其单回合防重作为第一层；执行队列另需稳定 submission intent/key、持久 execution/receipt 索引及相同键不同参数拒绝。不能把工具参数 hash 当远端 exactly-once 保证。 |
| abortAgentMessage 与单 execution 取消不同 | agent-runtime.ts:1353–1357 只 abort 指定 conversation 的 active request。job-registry.ts:8–27 按内部 job controller 管运行中任务并提供全局 cancelAllJobs；nai.ts:5212–5215 的 cancelGeneration 调用它。原生 generate 在 agent-tools.ts:513–529 只在逐张调用前检查 request.signal；redraw/inpaint/upscale 在 531–579 未把该 signal 传给对应操作。 | **主张成立。**全局 cancelAllJobs 确实存在，但它取消当前 registry 中所有工作，不按 executionId 定位；abortAgentMessage 本身也不等价于远端取消。新 cancel 必须是 execution 单项状态转换，区分 queued、dispatching、服务不支持与已确认取消。 |
| 准备对象只在进程内且不是完整 job snapshot | pi-generation-preparation.ts:17–65 用 Map 保存 session、时间、fingerprint、原始 args 与 preview；10 分钟后过期，consume 删除令牌。pi-studio-tools.ts:18–27 指纹会比较 provider、参数、modelMode、group、prompt locks 和账户等级；258–272 才消费并调用 handler。agent-tools.ts:233–252 在执行期重新读设置、解析附件并应用提示词锁。 | **部分成立，需保留漂移保护事实。**指纹在准备/确认期间变化会拒绝，不能描述为必然静默套用新默认；但 Map 不耐重启，args/fingerprint 也不自动成为 durable execution snapshot。新 host 应持久保存批准后的实际生效参数与源附件 revision/hash，再只做可执行性校验；不要在 dispatch 时重算有效 prompt。 |
| 字段 schema 与旧 handler 不对齐 | pi-studio-tool-schema.ts:10–51 与 agent-tools.ts:372–432、657–659 的对应字段见下一节。 | **主张成立。**模型 schema 暴露字段不证明 handler 接受或生效。adapter 必须字段级显式转换，并对不支持值拒绝；不要静默 fallback。 |
| 新输出身份与 durable execution 尚未闭合 | agent-tools.ts:141–155 用 HistoryItem.id 填 AgentAttachment.id；634–655 的历史结果也称其 attachmentId。固定 HEAD 没有目标设计的 artifactId→execution output→持久附件映射或 ExecutionService。 | **主张成立，属于目标设计缺口。**明确 artifactId 与 attachmentId 是同一 ID 还是一对映射；成功 output 公开前先可靠登记可读附件、版本/hash、outputIndex、归属和父图。UI 缩略图/URL 不作权威证据。 |

## 字段级 adapter 清单

| 目标/旧输入 | 固定 HEAD 实际行为 | 适配要求与不可复用假设 | 证据 |
| --- | --- | --- | --- |
| Pi flat arguments | Pi properties 是 args wrapper 内字段；Pi core 解包后向 StudioPiTool.execute 传平铺 args。 | 新 canonical schema 可平铺，但在 Pi provider adapter 明确包/解包；history/event/tool authorization 同步改。不要把“平铺”误实现成 handler 参数整体 `{args: ...}`。 | pi-studio-tool-schema.ts:20–51；pi-agent-core.ts:125–165；pi-agent-turn.ts:163–187 |
| gallery source/safeOnly | schema 允许 aitag、artist-ranking、tags-gallery 等；handler 实际只接受 danbooru、safebooru、gelbooru、quicktag，不认的值会回退 danbooru。handler 支持 safeOnly，schema 未暴露且默认 true。 | 显式映射受支持来源；未知值拒绝而非换站。若保留 safeOnly 输入，schema 暴露它并测试实际传递。 | pi-studio-tool-schema.ts:31；agent-tools.ts:379–386 |
| artist/reference preset filters | schema 没有 artist scope；handler 有 scope 和 limit。reference schema 只给 query/kind；handler 还读 group 和 limit。prompt preset schema 的 kind 接受 negative，而 handler 只筛 all/positive/style，negative 变 all。 | 对字段逐个决定 canonical 名和可见性；不支持字段不可静默接受。negative 需要实现筛选或从 schema 移除。 | pi-studio-tool-schema.ts:30–33；agent-tools.ts:372–432 |
| 图片词条保存 | schema 只有 name、prompt；handler 调 savePromptPreset(name,prompt)，helper 只向 positivePromptPresets 追加。 | 新 schema 若有 category/negative/style/revision，必须实现真实类别存储并映射；不得把存在字段或返回成功当成已保存到对应类别。 | pi-studio-tool-schema.ts:44；agent-tools.ts:289–306、657–659 |
| templateVersion/edit prompt | templateVersion 是 v5/v4.5 enum；edit 入口使用 currentPrompt、instruction、kind、mode、templateVersion，随后选择模板并调用转换服务。模板结果另带 bodySha256。 | engine/model version、模板正文 revision 与模板 hash 分开命名；canonical edit 参数逐字段保留 instruction/mode。不要把 v5/v4.5 当模板 revision。 | pi-studio-tool-schema.ts:10、28、42–43；agent-tools.ts:334–341、612–632 |
| memory candidate | Pi schema 与 handler 使用 type 和 scope；写入 pendingLlmCandidate，conversation scope 添加当前 session id。 | 若 canonical 协议用 category，明确 category→type；保留 global/conversation scope 与审核状态，不能把候选当已启用记忆。 | pi-studio-tool-schema.ts:46；agent-tools.ts:696–710 |
| native generation / inpaint | generation schema 含 seed/seedMode、CFG、采样器、质量、Vibe/precise/角色字段；inpaint schema 删除三类参考字段，却没有 inpaintModel；handler 单独读 inpaintModel，遇到不支持参考会拒绝。 | 参数按实际 model/service capability 切片；inpaintModel 与 generation model 分开。每项 UI 控件需有输入 hash 与 provider 参数证据，不能只保留 prompt/model/size/count。 | pi-studio-tool-schema.ts:11–19、38–40；agent-tools.ts:233–252、546–564 |
| compatible provider | agent-image-provider.ts:24–46 只开放文生图，input key 限 positivePrompt/count/model；其他参数拒绝，且 model 必须等于设置值。 | provider adapter 消化 domain/context 字段后，仅送服务确实支持的字段；参考、seed、size 等能力不得假冒生效或静默切 NovelAI。 | agent-image-provider.ts:24–46、49–66 |
| attachment/output | 旧 imageAttachment 用 HistoryItem.id 做附件 ID，read/list history 解析当前本地记录；附件读取仍需 host 确认可见来源。 | 新产物要原子登记 artifact 与可读 attachment，绑定 conversation/creation、outputIndex、revision/hash、parentAttachmentId。不能把历史 global ID、fileUrl 或当前选中图直接视作新 execution 权限。 | agent-tools.ts:141–155、262–286、479–498、634–655 |
| approval/provider snapshot | StudioPiTool 仅含 readonly/paid；非 readonly 走 authorize。图像服务 binding 和 prepare fingerprint 有漂移校验，但不构成持久 execution。 | 将 effect、approval、paid、capability 分离；本地写入设 approval=none 时仍按用户意图校验，不伪装 readonly。账号引用只存安全稳定引用，不能持久化密钥；dispatch 使用批准快照。 | pi-studio-tools.ts:242–280；pi-agent-core.ts:154–165；agent-runtime.ts:982–1005；pi-generation-preparation.ts:17–65 |
| `read_creation` / `read_proposal` | 固定 HEAD 当前 Pi schema 与 Studio tool registry 中未检出这两个 canonical ID；当前 read/history 工具不能据此视作等价实现。 | 作为新增只读定义进入目标 36 项；明确 conversation/creation/proposal 范围与 revision 回执，不写入 store、不触发 provider。验收应断言 read/write/provider 副作用均为 0。 | pi-studio-tool-schema.ts:20–51；pi-studio-tools.ts:18–27 |
| `patch_creation_inputs` | 固定 HEAD 没有该 canonical ID 或 creation-input CAS/undo contract；现有 generation handler 会在执行时读取设置、解析附件并应用 prompt locks。 | 作为新增写入定义接受 expected revision 和稳定 operation key；无歧义用户指令可同步更新并返回可撤销 receipt，歧义时只询问。清源需原子清掉依赖 mask、保留源作品；CAS/undo 冲突不得覆写；不得改变已发送 execution snapshot。 | pi-studio-tool-schema.ts:20–51；agent-tools.ts:233–252 |

## 与旧设计的连续性和本轮收敛目标

旧 V3.1 `TOOLS_AND_FLOWS.md` 中可核验的 host-side 改图预览、稳定附件标识、旧 call/result 配对与恢复流程仅作为迁移参考。本轮 R3 才将批次点评的 claim/崩溃恢复、消息与 delivered 回执原子提交、不承诺远端 exactly-once 收敛成验收目标；不把这组目标泛化归因于旧 V3.1 `SYSTEM_PROMPT.md`。本轮也将多图逐图请求与远端 batch 的计数、U01/U02 viewer 范围和“生成第二张→重启→读取→编辑/放大”组合验收补入 R3 矩阵。这些均为待实现设计目标，不是固定 HEAD 已有实现。

本轮用户明确覆盖两条行为：重启后 durable queued 默认暂停，由用户手动继续；viewer 默认显示发起入口所属同批次，可切当前创作全部作品。`ACCEPTANCE_MATRIX.md` 的 T13、U01/U02 按这两条编写；T29 将 T07 的“读取第二张并编辑/放大”与 T13 的真实 store 重启合并验收。Viewer 不包含“全部对话”范围。固定 HEAD 当前没有目标 ExecutionService/queued durable store，不能把这些用户决策写成当前产品行为。

助手预设的共享兼容与迁移要求已随 R3 单独收录在 [`PRESET_COMPATIBILITY.md`](PRESET_COMPATIBILITY.md)，避免依赖 R2 或 V3.1 包外文件。当前 `agent-store.ts` 的版本归一化、旧预设库替换、会话预设引用回退和 `studioDefaults` 耦合均作为待实施迁移约束，而不是本轮产品改动。

## 报告措辞校正与未做事项

1. 报告关于参数包络的方向正确；若表述成业务 handler 也接收嵌套对象则过宽。Pi boundary 是嵌套，Studio handler 是平铺。
2. 报告提到 cancelAllJobs 并非幻影：固定 HEAD 的 job-registry.ts 存在全局 helper，nai.ts 的 cancelGeneration 会调用它。但它没有 executionId 粒度，且 abortAgentMessage 不调用它；报告的“不能替代单 execution 取消”判断正确。
3. 报告说准备后执行期重读设置的风险成立，但 studioGenerationFingerprint 会对一组设置/账户状态做比较，漂移时拒绝；不应写成每次都会无声替换输入。缺口在于该流程不是可跨重启恢复的持久实际输入 snapshot。
4. async accepted 后的 paidFailed 缺口是从同步 handler 迁往后台 worker 时的条件风险，不是 fixed HEAD 当前已存在 async 执行失败。
5. 本轮只复核本地固定 HEAD。未连 GitHub；未证明远端 branch 指针等于此提交。
6. 本次固定 HEAD 源码迁移审查未运行 T01–T29/U01–U07、单元/集成测试、真实模型/图像服务或浏览器；这只描述本次源码审查范围，不代表 R2/R3 文档或原型的其他验证状态。验收矩阵中的用例仍明确保持待实现。R3 文档修订没有改产品源码，也不构成产品测试结果。

## R4 验收规格修订与迁移边界

本次修订依据本目录 `source/R3_收尾复审与接线验收建议.md` §3.3、§4、§5、§6、§7，以及现有 `TOOLS_AND_FLOWS.md`、`SYSTEM_PROMPT.md` 的输入快照、同回合授权、批准/入队、结果与焦点边界。没有修改这两份合同；下列是把它们落到验收步骤的方式，不是新增产品实现事实。

`ACCEPTANCE_MATRIX.md` 对应索引如下：

| 修订点 | 矩阵位置 | 验收收敛 |
| --- | --- | --- |
| seed 时间边界与创作隔离 | U05 | 入队前依赖 seed 变化令旧预览失效、旧请求为 0；重新预览并批准后才持久入队。入队成功后改 UI seed 不回写 execution snapshot/hash。修改另一创作不使 A 的预览失效。 |
| 五种图片入口的真实准备与提交路径 | T08–T13 前置覆盖规则及各行 | `generate_image` 覆盖 `prepare_generation → generate_image`；`redraw_image`、`inpaint_image`、`upscale_image`、`process_image` 分别验收各自真实 host handler 内的 `prepareExecution`，不添加模型公开 prepare 调用。幂等、参数冲突、提交事务故障、取消竞争、迟到回执和重启均逐类单独跑。 |
| 领取后的取消与发送证据 | T11/T12 | queued 取消赢 CAS 时零派发；worker 先领取后，取消意图必须独立持久化，且无 pending/unknown 发送证据时仍可为 dispatching。只有 worker 证明 provider 边界未越过且发送前停止成功，才以持久证据确认取消；已有正常 pending 才是 cancel_requested；发送事实不明就是 unknown。无 service ID 既不能证明已发也不能证明未发；五类工具分别覆盖以上分支，迟到成功仍保留。 |
| 同回合清源/仅讨论后生成 | T28 | 保留 patch/replay/undo/CAS 基础用例，并新增同回合 `patch→prepare→approve→submit` 持久入队链。固定原 message hash、连续 before/after revision、authorizedPatchReceiptChain、effectiveSnapshotRef、旧 execution hash 与逐层调用次数。read/refresh 或并发 UI 变更不能扩展授权；输入改变时旧预览拒绝且不收费。 |
| 结果项和预分配槽位 | 测试夹具约定、T06/T07/T15/T29 | `expectedCount` 仅为矩阵夹具简写，逐例映射到 `get_execution.expectedOutputCount`；`provider.output.item` 仅数 provider 实际返回的逐图记录；`execution.output.slot` 对每个 `outputIndex` 预留且持久化一个槽位，数量恒等于该字段。`not_dispatched`、`unknown` 也占槽，不伪装成 provider 返回图。 |
| 拒绝与 pending/unknown 矛盾的聚合终态 | T06/T15 | 在 T06 用 `pending`、T15 分别用 `pending` 与 `unknown` 注入 `error`/`blocked`/`denied` aggregate；host 必须拒绝且不持久化矛盾终态、不触发后续 claim/派发，并保留已有成功输出及其 artifact/attachment/hash。两行仍是待实现 host 验收。 |
| HTML 复审后的交互边界 | 独立 HTML 旁证、U04、U01/U02 的附属子场景 | 演示 hold owner 的释放/保留仅列为独立 HTML 旁证，不进入产品 T13；产品 U04、U01/U02 加入异步回执期间右栏与焦点稳定、viewer 首尾翻页的有效焦点落点；不新增一批编号，也不把 HTML 原型交互当 host 验收。 |
| 保持既有范围 | T29 与 UI 子场景 | 保留“生成第二张→真实 store 重启→读取第二张→编辑→放大”的 T29；按 §6 保留现有预设分层与主界面布局，只覆盖输入/异步状态/焦点规则，不扩成视觉重设计。 |

这些行和附属子场景仍全部 pending。R3 固定 HEAD 审查及 HTML 原型结果都不能升格为当前 host 实测；后续必须使用真实 host、持久测试 store、fake provider 和可追踪计数/receipt 执行矩阵。真实服务、实际扣费、原生 UI 接受度分别属于独立证据层。

## 下一阶段建议（本轮未授权实施）

建议下一阶段先做一个真实 host + fake provider 的最小闭环：读取创作输入 → 形成提案/准备 → 批准并持久入队 → worker 执行 → 登记可读产物及输出槽位 → `get_execution` → 以第二张作品发起一次派生编辑。该垂直切片同时用 T28 的同回合 patch 路径验证输入因果链，并覆盖取消、unknown、重启恢复和旧历史投影；再按 T08–T13 扩展到五类图片入口，结合 PRESET_COMPATIBILITY 的真实主进程迁移验证。实施前先根据实际源码入口与 store 结构收窄首个切片，不以 schema 或浏览器原型代替持久 host。

用户本轮只授权设计文档和独立 HTML 原型修订，没有授权产品接线或测试实施；上述为建议，未执行。当前没有必须用户选择的真实分支：U05 以 durable enqueue 成功作为前/后边界，若批准与入队是一个原子动作，“入队后修改 UI seed”仍可直接验收；viewer 焦点在首尾落到任一仍有效控件即可，不影响既有用户决定。



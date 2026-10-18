# 工具调用与运行流程 · v3.2 R4 Final

日期：2026-10-18。**R4 Final 目标协议，尚未接入产品。** 本文替代上一版同名文件的运行规则；原 R4 完整保留在 ../agent-refactor-v3.2-r4/。本轮不修改 Pi/Electron/React 源码。

## 1. 一份合同贯通四个层面

工具输入与结果结构以 [tool-registry.json](tool-registry.json) 为机器可读来源；字段适配、能力约束及投影边界见 [TOOL_CONTRACTS.md](TOOL_CONTRACTS.md)。本文规定因果顺序、授权、持久化、取消和恢复。系统提示词与 UI 只能解释这些合同，不能发明额外权限或成功状态。

R4 Final 沿用未接线设计的 registryVersion 与 36 项工具 schemaVersion **2.0.0**；本轮收紧聚合语义及取消结果条件分支，并为已有 blockedReason 增加 prior_paid_failure 枚举，不能称 schema 未变。实施时固定本包的合同 hash，明确协议迁移版本，不把旧 2.0.0 快照当成同一合同。R3 升版是因为 resultKind 等必填结果字段改变了合同。R2 的 1.0.0 原始历史保持不变，由版本化投影处理，不按新合同直接执行或改写旧记录。

目录在原 33 项上增加两个免费只读入口 read_creation、read_proposal，以及窄职责写入工具 patch_creation_inputs，**共 36 项**。这使缺失状态、旧卡与 CAS 冲突都能刷新，不让模型猜内部 ID，也不要求用户输入 revision。

| 使用需要 | 调用或入口 | 必须返回/绑定 |
| --- | --- | --- |
| 本轮能力与补挂工具 | get_capabilities，requestedGroups 申请工具组 | catalogVersion、可用/已挂载/拒绝原因；仅下一安全模型调用更新工具集 |
| 创作当前状态 | read_creation | 确切 conversationId/creationId、当前方案和 selectionRevision、草稿输入修订、源图/参考绑定、方案摘要 ID |
| 旧方案正文 | read_proposal | proposalId/revision、完整正向/负向/风格、来源与修订 |
| 同步当前图片用途 | patch_creation_inputs | expectedInputRevision；仅清除改图源或设置单张参考用途，业务回执可撤销 |
| 全局工作台/实际设置 | read_generation_state | draftId/draftRevision、来源和生效设置；不以 UI 当前前台代替调用目标 |
| 建立可操作方案 | propose_prompt | 创建与修订分支；proposalId/baseRevision 成对；proposalStatus 和有效版本 |
| 设置当前方案 | set_current_proposal | expectedSelectionRevision、selectionStatus、可撤销回执 |
| 写工作台 | apply_prompt | targetDraftId/expectedDraftRevision、applyStatus 与真实新修订 |
| 生成/编辑 | prepare_generation + generate_image，或专用编辑工具 | 有效输入预览、固定快照、稳定提交意图、executionId |
| 查询/取消 | get_execution / cancel_execution | 实际任务阶段和取消处置；查询 completed 不等于生成成功 |

普通创作讨论无需查询整套状态。状态足够时直接继续；缺字段或冲突时只读刷新所需目标。工具发现不解除联网开关、供应商能力、授权或费用限制；被拒绝的组不会因重复发现而可用。需要的工具未挂载时，申请后由 host 在下一模型步骤挂载，不能调用不存在的名字。

get_capabilities 自身始终挂载。requestedGroups、availability.group 与登记表 groupCatalog 取自同一组映射，包括 image_edit、creation_context、vision_service 等实际组。挂载变更只发生在下一安全模型步骤，该步骤同时取得新的 catalogVersion 与实际 mounted 规范名称；被拒绝的组保持 requestedDenied 及具体原因。发现成功不等于新工具已经在当前步骤可调用。

有创作范围的工具允许模型成对提供 targetConversationId/targetCreationId，它们只是目标引用。host 必须与发送时冻结的 allowedTargetScopes 中同一对核验；省略时只使用 message/card 的冻结目标。允许范围、用户意图、operationKey/submissionKey 和冻结输入修订由 host 注入，模型不能扩大。结果返回 host 已解析的真实目标。

## 2. 单一状态来源与成功判定

每个原生 call 最终只有一份与 toolCallId 配对的 result。等待确认期间原调用挂起，不先发临时成功结果。授权拒绝/取消后闭合为未执行结果；执行后以真实回执闭合。异步 execution.updated 是领域事件，不是原 call 的第二份结果。

| 结果类别 | UI 与助手可以说什么 |
| --- | --- |
| 外层 completed + proposalStatus 有有效版本 | 已创建/修订方案；不代表已设为当前 |
| selectionStatus=applied | 已设为当前方案，显示撤销 |
| selectionStatus=unchanged | 已经是当前方案；不制造新撤销按钮 |
| selectionStatus=conflict/not_found/invalid | 没有完成设置；显示真实当前状态/缺项 |
| applyStatus 成功且有新 draftRevision | 已应用工作台；冲突绝不显示已应用 |
| accepted + executionId | 已入队，尚未生成完成 |
| get_execution 外层 completed | 查询完成；按内部 executionStatus 显示排队/运行/未知等 |
| cancelDisposition=requested | 已登记取消请求；未保证远端停止 |
| cancelDisposition=already_terminal | 展示实际完成/部分完成/失败/取消状态；已完成作品保留 |
| cancelDisposition=not_cancellable/not_found | 未取消，说明具体原因；不改成 unknown 来掩盖已知终态 |

具体枚举、字段和错误允许动作由登记表定义。模型文本、工具卡、队列与作品卡读取同一规范化结果；不各自按 HTTP 成功、绿色图标或外层 completed 推断业务成功。

结果先以 resultKind 区分 business 与 preflight_failure。后者在参数、目标或授权等前置检查失败时使用，无 data，不要求捏造尚未解析的 query、executionId 或目标；仅保留确实已知的上下文和结构化 error。已知 executionId 的 not_found 属于一次有效查询的业务结果。已发生或可能发生远端发送的错误不能归为前置失败，须保留真实业务状态及核实入口。每个工具均需有合法前置失败正例，但 schema 正例不证明真实 handler 没有副作用。

## 3. 作品、附件与当前输入

artifactId 是作品记录身份；**attachmentId 是工具读取图片的稳定入口**。每个成功 output 必须同时给出 artifactId、attachmentId、attachmentRevision、内容 hash、outputIndex、conversationId、creationId、parentAttachmentId（新图为 null）。后续重绘、放大、反推和读取元数据直接使用返回的 attachmentId，不从 URL 或“当前选图”猜。

文件写入受管存储并确认可读取后，作品/附件绑定/成功回执在同一可靠提交中发布。若文件落盘但数据库提交失败，允许留下待回收的孤立文件，不能先展示不可读的成功作品。重启重新检查文件与 hash；缺失则标产物不可用，不自动重做收费请求。

种子分开保存 requestedSeedPolicy/requestedSeed 与逐图 resolvedSeed/resolvedSeedSource。实际值只能来自服务回执或可验证的图片元数据；随机请求、模板默认值、当前工作台 seed 都不是实际种子。准备阶段实际值为 null，不能把同一预览值套给多图。查看器按当前 attachmentRevision 展示，未返回则显示“实际种子未返回”。固定示例值必须标“模拟数据”。

### 当前输入的不变量

1. 每个创作最多一个 edit source；reference role、mask 与 edit source 分开建模。同一图片可以有不同用途，但各用途必须有明确独立绑定和可见胶囊。
2. 点击改图源胶囊 × 是一次本地可逆输入命令：核对 expectedInputRevision → 清除 editSource 和依赖它的蒙版/待发源绑定 → 增加 inputRevision → 刷新胶囊、右栏和未提交预览。作品记录与其他独立参考绑定保留。为避免含糊，UI 明确写“移除改图源”，不用泛化的删除图片。
3. 源图清除后，新快照必须 sourceAttachmentId=null。此前已发送消息的原始快照和已批准执行不被回写；同回合授权派生按下节处理。重新提交的意图读取清除后的当前输入。界面若显示旧任务快照，须标“已提交输入”。
4. discussion 只能 includeInGeneration=false。选“仅讨论”立即取消勾选并禁用生成参与；切到有效用途仍默认不勾，由用户明确选择。胶囊显示用途，不以附件存在暗示参与生成。
5. host 对 conversation/creation 绑定、附件修订、role/include 配对和服务能力再次校验。发现 discussion=true 或缺少源图却请求重绘，返回明确错误，**不能偷偷修正参数、补旧源图、删不支持字段或降级成别的工具**。
6. 对尚未提交的预览，相关输入修订变化即失效。确认必须针对同一 inputRevision/fingerprint；失效后重开预览。已提交快照不可变。

参考的绑定类型与具体用途分字段保存：仅讨论为 role=discussion、includeInGeneration=false，不能带 referencePurpose；其他参考为 role=reference，并必须记录 referencePurpose=color/composition/character/atmosphere，分别对应色彩/构图/角色/氛围。edit_source/mask 不带这个字段。read_creation、生成预览和 patch 的 beforeRefs/afterRefs/undo.restoreRefs 保留同一用途；用途名称不表示供应商已经支持，参与生成仍要独立授权并校验能力。胶囊中非参与状态显示“不参与生成”，避免把“色彩”和“仅讨论”并列成两个用途。

### 聊天与界面共用的图片输入命令

用户明确要求“移除改图源”或把确切图片改为仅讨论时，助手按需 read_creation，再调用 patch_creation_inputs。工具只允许 clear_edit_source、set_reference_usage 两种动作；不接受任意 JSON patch，不删除作品，不改消息历史或已批准任务。写入、免费、approval=none，但显式用户意图与目标归属校验仍是前提。

**D20 源图生命周期：**改图源是创作输入绑定，持续保留到用户明确移除或换图。发送普通消息、文字草稿恢复、生成入队与完成都不隐式清除，也不自动把新结果设为源。预览始终显示源图标识；源文件失效时阻断改图并提示重新选择，不能降级为文生图。删除源绑定与删除作品资产是不同动作。

参考参与授权由 host 核对原用户事件、确切绑定与用途，并与同一 userIntentRef 关联。界面明确勾选或聊天明确说参与生成均可授权；模型传 true、只更换用途、只读刷新都不构成授权。原绑定在 expectedInputRevision 上同用途且已授权 true 时可保持；更换用途默认 false，除非同一明确指令重新授权。执行前校验撤销/修订，失败不写入、不推进有效输入链。schema 只能验证字段，用户意图与授权来源须用真实 host 测试证明。

同一应用命令供胶囊 ×、用途控件和模型调用共用。以 expectedInputRevision 做 CAS，成功返回 before/after 绑定、actionId 和新 inputRevision；unchanged 不新增撤销。operationKey 重放先查原回执；相同 key 不同参数拒绝。UI 撤销恢复该回执之前的绑定，包括依赖蒙版；必须仍匹配 afterInputRevision，且被恢复附件修订可读，否则保留当前输入并报告冲突/失效。撤销不能恢复已发任务或已删除文件。无明确图片身份时助手先问，不按前台选图猜。

### 同一指令先改输入再生成

原消息快照、TurnEffectiveInputSnapshot、批准执行快照是三个独立对象。发送时本轮有效输入指向原消息；“把橱窗暖光参考设为仅讨论，然后生成”先调用 patch_creation_inputs。host 验证成功回执属于同一回合、同一目标和同一 userIntentRef，且 beforeInputRevision 连续，才将 actionId/operationKey/前后修订加入 authorizedPatchReceiptChain，推进 effectiveSnapshotRef/effectiveInputRevision。prepare_generation 使用这一派生输入，确认后再冻结成执行快照。

只读刷新、其他回合写入、用户在界面并发选择、未经授权的用途修改均不得追加到这条链。CAS 失败不推进，unchanged 不伪造成功写入链；目标或参数差异影响预览时重新比较与批准。原消息用于审计，派生链用于本轮实际准备，执行快照用于已入队任务，三者不可相互覆盖。

图片资产与用途绑定也需分离：attachmentId 指向可读图片，reference binding 指向当前创作内的 role/purpose/include 与修订。同图同时为作品、参考和改图源时，从参考入口打开查看器必须携带参考绑定上下文，不能先命中 artwork 就丢掉参考用途。

## 4. 从用户动作到提交

### A. 修改提示词并设为当前

用户讨论 → 普通文字协作 → 需要版本化时 propose_prompt → 方案卡。若用户明确选择唯一版本，read_creation/read_proposal 按需补齐 → set_current_proposal → 业务成功回执 → 当前方案更新。

同一操作的 operationKey 由 host 稳定分配；重放先按 key 和参数 hash 找原回执，再做 CAS。相同 key/相同输入返回原回执，即使当前 revision 已更新；同 key 不同输入拒绝。新操作遇到版本冲突返回实际当前选择。刷新只是获得事实，不是自动覆盖授权。

撤销用 UI 内部命令恢复 beforeRef（允许 null），并以回执 afterSelectionRevision 做 CAS。后续选择已改变则不覆盖。按钮与模型调用共用这套命令；不增加任意状态修改或通用 undo 工具。

### B. 任意方案直接生图

选定版本 → prepare_generation（方案引用与直接提示词严格二选一）→ 展示生成目标、实际生效参数、源图/参考、张数、费用 → 确认 → generate_image → 原子入队 → accepted。

这条路径不先设为当前、不写工作台。完整词和参数可折叠，但来源、作用类型、费用与阻断原因不能隐藏。锁定词、默认值、账号配置、渠道能力都在准备阶段解析为**实际生效输入**；不能到 dispatch 才重新套最新默认值。

同回合“修改参考后生成”的对话模型与助手预设来自已发送消息的 conversationConfig 快照，包括 enabled/body/revision/hash；直接点卡片生成则在打开预览时捕获该配置。后来切换聊天配置不倒灌原操作，固定配置也不因当前选项变化而自动失效；实际 provider/账号权限/能力不可用仍阻断执行。当前方案指针仅记录讨论来源；已明确的 proposal revision 或工作台正文不会因设置另一个当前方案而被替换，也不因此失效。真正被预览依赖的源图、参考、提示词、图像参数仍执行修订/指纹校验。

### C. 第二张改背景或放大

从输出列表锁定第二张的 attachmentId/revision/hash → 用户明确编辑范围 → redraw_image/inpaint_image/upscale_image 等专用工具 → host 的内部 prepareExecution 建立同等预览 → 授权与原子入队。

prepareExecution 不是模型工具；专用工具 call 在 confirm 模式下等待该预览决定，不再让模型为同一预览发第二次调用。auto 模式按既有规则处理，仍有预览记录、快照和能力校验。蒙版缺失或渠道不支持时阻断。新图的 parentAttachmentId 固定为第二张，第一张和源图均保留。

### D. 工作台写入

明确“应用到工作台” → read_generation_state 获得 draftId/draftRevision → 展示字段差异 → apply_prompt 指向 targetDraftId 与 expectedDraftRevision → 成功才更新 UI。期间工作台有新编辑则返回冲突，保留两边内容；重新读取与比较后再决定，不自动把旧批准扩展到新状态。

### E. 五类提交共用的 host 上下文

generate_image、redraw_image、inpaint_image、upscale_image、process_image 均引用同一个 ExecutionSubmissionContext。它包含稳定 operationKey/submissionKey、userIntentRef、目标与允许范围、providerBinding/accountBinding（配置引用，不是密钥）、attachmentBindings 的 revision/hash、frozenInputRevision、effectiveSnapshotRef、approvalReceipt 和 failedGateRef。准备/授权/失败护栏不因使用放大或后处理工具而省略。

这些字段由 host 提供，不能加入模型平铺参数以让模型自证授权。转换与编辑适配中的 operationKey 等依赖必须出现在 hostInjectedFields 或明确的 derivation 中，未知来源不能通过映射检查。准备时冻结输入；入队事务再核对目标、修订与 fingerprint，本次预览依赖输入在入队提交前改变，即拒绝旧预览并要求重新预览；即便曾点击批准也不可使用旧批准绕过。入队成功后再改 UI seed，原 execution hash 与 provider payload 保持不变；无关创作输入变化不影响该预览。U05 分别验证这三个时点/范围。

## 5. 原子提交、取消竞争与失败护栏

submissionKey 标识稳定的提交意图，由 host 分配并持久保存，不能要求模型随意造值。UI 双击、传输重试、accepted 响应丢失重放均使用原 key；用户明确“再生成一次”才建立新意图。旧 preparationId 换新 ID 不等于新授权。同一意图重复调用不同工具仍由实际输入 hash/意图映射拦截。

| 原子边界 | 一次可靠提交必须覆盖 |
| --- | --- |
| 准备/批准 | 候选有效输入、input revision、能力/配置版本、fingerprint；批准只绑定该指纹 |
| 入队 | 校验批准与指纹、消费一次性 preparation（如有）、snapshot、execution、初始 receipt、submissionKey→execution 映射 |
| 领取 | queued→dispatching 的 CAS，同时检查取消意图、会话/批次停止标记、全局暂停/unknown gate、批准和附件失效 |
| 排队取消 | queued→cancelled 与不可领取标记；胜出后 provider submit 次数必须为 0 |
| 输出/失败 | output、artifact/attachment 可读绑定、receiptRevision、turn/batch failure gate；先持久化，再唤醒 worker/UI |
| 点评登记 | batch 唯一自动点评键、conversation 串行队列项、消费状态一起保存 |
| 点评交付 | critique attempt 的最终 assistant message 与 delivered 回执一起原子提交 |

worker 只能领取已提交的 durable execution；accepted 只能在入队提交成功后返回。相同 submissionKey/相同指纹返回原 execution 与回执；同 key 不同参数拒绝。存储方案可用事务库或经故障注入证明的日志实现；不以多个独立 JSON 写入假装原子性。

取消与 worker 必须竞争同一个 queued 状态。取消输给 queued→dispatching 的领取 CAS 时，先持久登记独立取消意图；没有已发在途证据时仍为 dispatching，不能为了显示取消而编造 pending。worker 在发送前再次检查意图，若能证明确未发送且停止成功则记确认取消；已经有正常 pending 才投影 cancel_requested，发送事实无法确认则 unknown。不能仅凭领取阶段报告“确定未发送”。尚无服务任务 ID 时保留取消意图，拿到可定位 ID 后再请求；服务不支持取消则如实说明并继续记录实际结果。迟到成功产物照常保存。中止等待不等于远端取消，更不等于退款。cancel_execution 只作用于一个校验过归属的 execution，不映射为 abortAgentMessage 或 cancelAllJobs。

任何已派发项 error/unknown 都立即持久记录关联 turn/batch 停止标记；包括逐张结果，不能等整体失败才做。后续图像与相关收费文字/视觉调用在 dispatch 前重新检查。Pi 的单 turn 闭包保护只作第一层，不足以覆盖 accepted 后的后台失败。

未知导致全局队列自动推进暂停。用户可查看受影响任务并明确释放列出的无关任务；只解除这些条目的全局等待，原 unknown 不重发、原失败批次不续跑，关联依赖不解锁。新的重试需新用户意图和新预览，保留与原任务关系。

## 6. 聚合状态与重启

成功产物逐项可见，不等待批次全部成功。outputs 持久保存恰好 expectedOutputCount 个稳定、连续的 outputIndex，尚未派发也占一个槽位。JSON Schema 检查结构，validate_execution_semantics 检查跨字段聚合语义；二者都必须通过，结构合法不代表状态真实。

聚合顺序统一：任一 output 或 provider 回执 unknown → unknown；否则有正常在途证据 → running/cancel_requested；最后才能判断确定终态。后续派发门闩与 executionStatus 分开：非空 blockedReason 表示当前禁止未来派发，解除后省略字段（无门闩），历史原因保留在事件日志。running/cancel_requested/unknown 可以同时带此字段，不能因此变成终态 blocked。

已知 failed 与 pending 同时存在时使用 blockedReason=prior_paid_failure，保留在途状态且停止未来派发；不能用 unknown_prior_receipt 冒充已知失败。所有阶段 failed 都带有效错误码；completed/partial/error 必须有 confirmed provider 回执，not_applicable 只适用于确无 provider 请求的情形。not_cancellable 仅用于 running/cancel_requested/unknown，providerCancellation 只能 unsupported/unknown；queued/dispatching 仍走本地取消 CAS 或持久取消意图。

| executionStatus | 聚合约束 |
| --- | --- |
| queued | 全 not_dispatched，provider not_applicable；pauseReason 必填，普通 FIFO 为 none |
| dispatching | dispatcher 已持久领取，尚无 pending/unknown 的已发证据，仍有 not_dispatched；先前输出仅可 completed，failed/cancelled 后不能继续领取；不得绕过 gate；崩溃后先核实而非重发 |
| running | 无 unknown，有 pending 输出；已发部分继续等待，后续派发可以另被 gate 暂停 |
| cancel_requested | 无 unknown，有 pending 输出；取消意图已持久登记，继续接收真实回执 |
| unknown | 任一输出或 provider 回执待核实，优先于其他在途/已返回项 |
| completed | 数量完整且全部 completed，不能有待返回回执 |
| partial | 全部输出确定结束，至少一项成功并有 failed/cancelled/not_dispatched |
| error | 无成功，无未知或在途，至少一项 failed；失败与取消混合时失败优先 |
| cancelled | 无成功/失败/未知/在途，至少一项确认 cancelled，其余可 not_dispatched |
| blocked | 全 not_dispatched、provider not_applicable，当前 blockedReason 非空，整单终止受阻 |
| denied | 全 not_dispatched、provider not_applicable，无当前 gate；host 已持久记录授权拒绝，不能由“没有结果”推断 |

表中领取、授权拒绝、取消意图和持久事件的真实性须由真实 host 测试证明；当前结果合同和离线语义函数不能凭字段验证这些事务发生过。逐项 cancelled 须带 errorCode=cancelled；failed 须有有效失败代码；普通未暂停 queued 用 pauseReason=none。requestedSeedPolicy=fixed 必须有 requestedSeed，random 必须为 null；resolvedSeed 只认返回证据。除 blocked 外的确定终态不保留本 execution 的活动 blockedReason；历史原因写事件。由失败建立的全局/关联批次 gate 另行持久保存，不能随 execution 终态一起清掉。工具结果、任务卡和助手解释须使用同一权威聚合结果。
必须区分 execution 入队次数、provider 请求次数和 output 项数。逐图提交三张，第二张失败时第三张确实未发送，可标 not_dispatched；远端一次 batch(count=3) 已发送时，三个输出均属于该请求，未返回第三张只能按回执或 unknown 处理，不能假称尚未 dispatch。保留 request 粒度与 output 映射，取消和费用也不能凭输出索引推断。

| 重启时持久证据 | 默认恢复 |
| --- | --- |
| durable queued，确定无发送尝试 | **暂停，显示“继续队列”**；用户恢复后重新校验原批准、输入与能力，再首次发送 |
| dispatching/running/cancel_requested，缺终态 | 先查询服务；无证据保持 unknown，绝不自动重发 |
| completed/partial，已有产物 | 恢复作品与真实逐项状态，不重复成功步骤 |
| failure gate/unknown gate/用户暂停 | 先恢复 gate，再启动 worker；不能先 dispatch 后补暂停 |
| 入队提交结果丢失 | 按 submissionKey 找原 execution；不能用新的 preparation 重建重复任务 |

本地幂等不保证远端 exactly-once。远端支持幂等键时透传稳定 request key，支持查询时保存 serviceTaskId；否则承认发送后丢失回执的不确定。任何超时重试库都不得对收费提交做隐式重发。

## 7. 文字排队、因果闭包与引导

**用户提交顺序与模型因果顺序分开。** 发送 B 时只冻结 B 的正文、附件用途/修订、显式方案、目标创作、模型与助手预设。B 真正开始时加入前驱 A 的完整完成消息与 call/result 闭包；不能按 B 的发送时刻截掉 A 的迟到结果。晚于 B 提交的用户消息 C 不倒灌进 B，除非它被明确登记并消费为 B 的引导。

每个会话同时一个活动模型回合。跨创作局部约束保持隔离；共享会话顺序不等于把所有创作提示词混在一起。旧卡操作携带来源目标，读取与刷新也使用该目标。

取消排队文字以稳定 messageId 定位并保留原消息；恢复到输入框须核对目标创作和 composer draftRevision。已写新草稿时保留两份，旧消息留在可恢复入口，不静默覆盖；空草稿才恢复正文与仍有效附件。纯文字输入/恢复不增加图片 inputRevision，确有源图或参考绑定变化时才增加。停止回复与取消指定排队消息是不同操作。

| 消息状态转移 | 持久条件和行为 |
| --- | --- |
| pending→steering_pending | messageId、状态版本、目标 turn/creation 与原队列位置；只改变处理归属，不删除消息 |
| steering_pending→consumed_by_turn | 在无未配对 call 的安全节点，原子写入因果输入事件和消费状态 |
| 正常结束先赢得竞争 | 未消费引导 CAS 为 fallback_queued，作为下一条消息一次处理 |
| 停止/错误/重启 | 未消费内容保留并暂停；不会自动接着运行 |
| 已消费引导重启恢复 | 按因果事件恢复；不再作为独立消息回答，不重放已提交工具 |

正文输出后不能撤回已经展示的内容；新要求只改变后续内容。引导沿用活动回合的模型/预设，UI 显示“等待引导生效”直到可靠接收。切换预设影响之后新发送的消息；已发送（含排队）保持原版本。

停止回复立即暂停后续文本队列，并按每个 call 的真实阶段闭合：未发且等待批准的 call 撤销确认入口并记未执行；已经原子入队的 call 保留原 accepted；已发同步收费请求等待真实结果或记 unknown。停止 UI 可以先响应，协议尾部仍要完成这些记录；不丢 call，不再补第二份矛盾 result。图像任务继续由 execution 队列管理，除非用户另行取消指定任务。

## 8. 自动点评、种子与下载

批次结束或停发后，已有可读图片时登记一次 critiqueRequest，进入**同一会话串行器**。消息仍按原目标创作。用户已有待发消息优先；点评排在已排队用户消息后，后续新消息按提交顺序处理。重复完成/迟到事件不会重复自动点评。只有像素实际送达所选模型且能力支持才可评价；否则说明本次未看图，不另开收费反推服务。

critiqueRequest 引用 execution 固定的对话模型安全配置、助手预设 ID/revision/hash/body/enabled 与原创作目标，不能在启动时读当前聊天设置。该快照在生成准备/批准时固定；图片生成 provider 与点评的对话模型分别命名。配置不可用、无视觉能力或无法送达像素时跳过视觉评价并显示原因，不自动换模型。关联失败/unknown 的停发标记优先于自动点评：仍可登记待处理项与展示已有作品，但不启动受阻的收费请求；用户明确另发点评要求才按新意图、费用及原 gate 规则处理，不借点评自动续跑失败批次。

唯一队列项不足以保证交付：worker claim 后、模型响应后、最终消息提交前后的崩溃均需覆盖。最终 assistant message 与 delivered 在同一事务提交；已交付则复用原消息。若远端可能已调用但结果与本地交付均不明，记 unknown，不自动再次调用。用户明确再次点评是新 attempt，保留旧未知记录；不以“恢复点评”为名承诺远端 exactly-once，也不为避免重复而伪造点评内容。

大图 viewer 默认同一 execution/batch 的有序作品集合；可切换当前创作全部作品。成员用稳定 attachment ID，不用全局数组索引。上一张/下一张不改变当前方案、生成参数或待发源图。适应窗口保持完整图，放大后允许滚动/平移；横图、竖图、多图、缺元数据分别验收。

“下载原图”保存当前附件的原字节与正确扩展名，验证可读与内容 hash；失败报告原因，不把截图冒充原文件。原型仅下载明确标注的本地示例 SVG/用户选择原文件，不含真实服务回执。真实种子只读展示；复用种子、参数回填与下载属于不同动作，本轮不隐式执行。

## 9. 历史适配与验证层级

当前包装位于 Pi schema/call、beforeToolCall 及历史投影边界，下游业务 handler 已接收平铺参数。迁移需检查 schema→解包/校验→授权→adapter→事件→结果归一化→历史投影整个链路，但不能在已平铺的 handler 再解一次包。原始历史及 protocol/schemaVersion 保持不变。历史投影只作模型上下文适配，绝不执行 handler 来补结果；缺 creationId 不填当前创作，残缺/重复/未知工具记录转成明确的惰性历史说明，不伪装 native success。

当前字段与受限兼容渠道清单见 [MIGRATION_REVIEW.md](MIGRATION_REVIEW.md)。36 份设计契约、静态验证、fake-provider host 测试、真实模型协议测试、真实图像服务验收分别报告。后面三层本轮均未实施；[ACCEPTANCE_MATRIX.md](ACCEPTANCE_MATRIX.md) 是交给实现阶段的要求，不是通过记录。



# 工具合同与当前设计状态 · v3.2 R4 Final

本文件与 [tool-registry.json](tool-registry.json)、[schema-fixtures/fixtures.json](schema-fixtures/fixtures.json) 定义 **R4 设计态**工具合同；没有修改产品代码。R3 已完成 result-envelope 迁移，registryVersion 与 36 项工具 schemaVersion 当前沿用 `2.0.0`。R4 未增删模型/结果字段，但收紧了 `cancel_execution` 条件分支、执行聚合合法值和静态校验，并为已有 `blockedReason` 增加 `prior_paid_failure` 枚举；因此不能称 schema 完全未变。因 R4 仍是未接线的设计快照，暂沿用 R3 的 `2.0.0`，实际接线前必须评估新增枚举值与收紧分支的兼容性和迁移版本。R2 目录中的历史合同与 fixtures 不回放到当前 schema。机器可读 schema 决定字段、范围、枚举、条件和结果结构；本文件解释职责、旧实现差异、授权与故障语义。总体顺序见 [TOOLS_AND_FLOWS.md](TOOLS_AND_FLOWS.md)，产品界面见 [UI_SPEC.md](UI_SPEC.md)，系统提示词见 [SYSTEM_PROMPT.md](SYSTEM_PROMPT.md)，设计总览见 [README.md](README.md)，可交互原型见 [prototype-v3.2-r4.html](prototype-v3.2-r4.html)。

## 1. 规范与执行边界

- registry 的每项工具均有 `inputSchema` 与 `resultSchema`，采用 JSON Schema Draft 2020-12；对象必须 `additionalProperties:false`。模型参数是**原生平铺对象**，不再包 `{args:{...}}`。星号表示 schema 的必填项；oneOf / allOf 等条件同时生效。
- `modelFields` 与顶层输入字段一一对应。creation-scoped 工具可接收成对的可选 `targetConversationId/targetCreationId`：它们只是模型提出的目标引用，不能扩展权限。`hostInjectedFields` 是模型绝不能生成的 `defaultMessageTarget/allowedTargetScopes`、稳定幂等键、服务账号绑定、附件解析、CAS 基准和冻结快照。显式 pair 必须与冻结 message/card `allowedTargetScopes` 中的同一对匹配；缺省使用消息发送时冻结的 target，不读取 UI active。结果中的 `conversationId/creationId` 是 host 已解析目标。
- `catalogConstraints` 表示 JSON Schema 之外的动态约束：当前模型、sampler、账号配置、角色输入、附件归属和服务能力必须由 host 根据本轮 catalog 校验。不能把未知值 clamp、换默认、删字段后继续或切换服务。
- host 要实现完整 schema 和动态校验；**provider/tool-call schema projection 尚未实现**。projection 必须从规范 schema 生成并保留条件与拒绝语义；在未实现前不能把这份 host schema 当作模型厂商已支持的投影来描述。
- `legacyHandler` 是待迁移的旧 handler 名或 `null`。`fieldMappings` 说明兼容适配，不证明新合同已实现。`null` 项需要新的 host/service 命令。付费图片 handler 只能作为持久队列 worker 的后端，不能在原生工具 call 中继续同步执行。
- `get_capabilities` 是始终挂载的最小发现入口，但只在需要发现或刷新能力时按需调用，不要求每轮调用；36 项目录中的其余工具仍按需挂载，不会每轮全部暴露。唯一 `groupCatalog` 同时约束 `requestedGroups`、`available[].group`、`requestedDenied[].group` 与每项 `availability.group`；模型可请求目录中任一组，下次安全模型调用才挂载通过策略检查的工具。`requestedDenied` 必须显示拒绝原因，不能解除用户联网开关、收费限制、账号或能力限制。

### 结果与回执

`cancel_execution` 的结果配对固定如下：`requested+dispatching` 仅表示 host 已登记发送前取消意图，providerCancellation 必须是 `not_sent`；queued 本地 CAS 成功时以 `requested+cancelled/not_sent` 表示。`already_terminal` 只报告真实终态，且 providerCancellation=`not_sent`。`not_cancellable` 仅允许 `running/cancel_requested/unknown`，providerCancellation 只能是 `unsupported/unknown`；`not_cancellable+not_sent` 没有可验证的请求结果含义，必须拒绝。`not_found` 只带 `not_sent`，不得附阶段或回执版本。

结果外层必须带 `resultKind`。`business` 表示已进入业务处理，必须带 `data`；外层 `status` 可记录实际的 accepted/completed/denied/cancelled/blocked/error。远端请求已发送后的 failed/unknown 必须如实放在 `data` 中（例如 reverse_prompt 的 `serviceStatus=unknown`），即便外层状态为 error，也不能伪装成“副作用前错误”；如果工具已成功返回这份完整结果，外层也可为 `completed`，业务字段仍记录远端 failed/unknown。`preflight_failure` 只表示参数、权限、授权或能力校验在业务副作用前拒绝：外层 `status` 为 `error/blocked/denied/cancelled`，带 `error`，且不带 `data`；未知的业务 ID 和目标 ID 不得编造。合法输入查询未找到记录仍属于 `business`，回显调用者已知的目标 ID 与 not_found。对同一个 native `toolCallId` 只回一份工具结果；等待审批时原 call 保持挂起，批准/拒绝后再闭合。`execution.updated` 等是独立持久领域事件，不能作为同一 call 的第二份结果。

`get_execution` 的外层 `status=completed` 只表示查询已返回；`data.executionStatus` 才表示队列和整项执行阶段。`queued/dispatching/running/cancel_requested` 是未完成阶段；`completed/partial/error/cancelled/blocked/denied` 是已知终态；`unknown` 表示回执尚不能确定。图片任务 `accepted` 只表示已登记进持久队列。

对每个 `readStatus=ok` 快照，`outputs` 必须恰有 `expectedOutputCount` 个索引连续且唯一的条目。聚合规则固定优先级：任一已派发输出或 provider 回执为 `unknown` 时整体为 `unknown`，即便其他输出已完成、取消或失败；无未知证据时，只要存在 `pending` 输出或 provider 回执就必须是 `running` 或 `cancel_requested`。因此 `error/blocked/denied` 不能遮住在途工作。
`dispatching` 表示 host 已提交持久 dispatcher claim，但尚无 pending/unknown 的 provider 或输出证据；per-output 只可同时保留已确认的先前 `completed` 输出与剩余 `not_dispatched` 项。先前存在 `failed` 或 `cancelled` 时必须停止后续 claim。claim 的持久性、恢复时检查回执并且不得自动重发是 host 约束，现有结果字段和离线 validator 无法证明。
取消意图由 host 独立持久化，不增加模型字段：在 `dispatching` 且没有 provider 发出证据时，`cancel_execution` 可返回 `cancelDisposition=requested`、`executionStatus=dispatching`、`providerCancellation=not_sent`；dispatcher 在发送前检查该意图并确认本地终止。只有 pending 输出证明 provider 请求已在途后才投影 `cancel_requested`；无法确认是否发出时用 `unknown`，并且不得重发。
`blockedReason` 非空表示当前后续派发 gate，不是历史错误文本；它可与 `running/cancel_requested` 及实际 pending 输出并存，解除后省略此字段，历史原因放事件日志。已知 failed 输出与 pending work 并存时必须用 `prior_paid_failure`，不得用 `unknown_prior_receipt` 冒充已知失败；该值表示停止未来派发，不会遮住已经在途的输出。`executionStatus=blocked` 则是整项执行终态，要求所有输出 `not_dispatched`、provider 回执 `not_applicable` 且带 `blockedReason`。
已知终态必须有可表达证据：`completed` 要求全部输出完成且 `providerReceiptStatus=confirmed`；`partial` 要求全部输出已知终态、至少有成功和一个失败/取消/未派发，并且 provider 回执为 `confirmed`。`not_applicable` 表示没有 provider 请求，不能与已完成输出或失败/部分结果并存。每个 `failed` 输出在任一执行阶段都须带 `provider_error` 或 `attachment_unavailable`；零成功时，已知失败优先于取消并归为 `error`，纯取消才归为 `cancelled`。`blocked` 需当前 gate 且全未派发；`denied` 需全未派发、provider `not_applicable`、无当前 gate及已持久化的授权拒绝决定。只因没有 pending 不能推导 `error/blocked/denied`；现有字段没有授权拒绝 receipt 引用，离线 validator 无法证明拒绝决定来源或持久性。
输出 `status=cancelled` 必须同时有 `errorCode=cancelled`；终态取消至少有一个 cancelled 输出且不得含成功/失败，provider `not_applicable` 仅用于本地排队取消。batch provider 请求一旦 pending/confirmed/unknown，不能把缺少的单项伪报为 `not_dispatched`。

任务输出只有当 `outputs[].status=completed` 且带有完整附件身份时才可复用。该身份固定为 `artifactId`、`attachmentId`、`attachmentRevision`、内容 `hash`、`outputIndex`、`conversationId`、`creationId` 和可空的 `parentAttachmentId`。输入绑定沿用 `role` 分类，不把它混成 provider 能力；当 `role=reference` 时必须同时记录 `referencePurpose`（`color`、`composition`、`character`、`atmosphere`），非 reference 不带该字段。`discussion` 必须 `includeInGeneration=false`。`includeInGeneration=true` 只是模型提出的状态，不是权限；仅当同一 expectedInputRevision 上同目标/同附件绑定/同角色已有未撤销授权，或同一 `userIntentRef` 可追溯到用户对确切参考、目标、用途和授权范围的明确 opt-in 时才允许。只改 `referencePurpose` 不授权；改角色默认必须保持 false，除非同一指令明确 opt-in。host 要保留可追溯的原用户事件；离线 schema 不证明用户意图真实性。用途只表达创作意图，host 仍独立检查服务是否支持该参考方式。每张完成图还单独携带 `resolvedSeed` 与 `resolvedSeedSource`；没有可核验来源时两者都为 null。成功文件先验证可读与 hash，再原子发布作品、附件绑定和回执；不可读、部分或未知结果不显示为成功图像。

`read_creation` 成功读取时必定返回完整 `references` 数组，当前没有输入绑定时显式返回 `[]`；数组包含 edit_source、mask 等绑定及其稳定附件身份。 `operationKey` 和 `submissionKey` 由 host 从用户动作、submission intent 或 native `toolCallId` 稳定生成，模型不传。重复 key 同 payload 返回原 receipt；同 key 不同 payload 冲突。付费结果 unknown 时不自动重发；同 turn/batch 的相关后续付费调用停止，未知任务阻止队列自动推进，直至查询回执或用户处理风险。



### 回合输入派生快照与共享提交上下文

输入版本分三阶段冻结：用户提交消息时形成不可变 `OriginalMessageSnapshot`；只有同一回合、意图和目标下成功授权的 CAS patch 回执才推进 `TurnEffectiveInputSnapshot`，同时保留原始快照；`prepare/approval/enqueue` 再绑定单独不可变的 execution snapshot，并从有效快照 revision 注入 `frozenInputRevision`。后续 UI 编辑不能热改该 execution snapshot。

五个图像提交工具都引用 `#/$defs/ExecutionSubmissionContext`：稳定 `operationKey/submissionKey`、目标与授权范围、`userIntentRef`、`providerBinding/accountBinding`、经校验的 `attachmentBindings`、`frozenInputRevision/effectiveSnapshotRef`、`approvalReceipt` 与 `failedGateRef` 一次性共同定义。该 host-only 对象不会混入平铺 `inputSchema`。收费文字模型 `convert_prompt/edit_prompt` 也显式声明 host 注入的 `operationKey`。

### 费用与授权

`approval=existing_confirm_auto` 保留用户已经选择的 confirm/auto 模式；registry 不把这改成“每次都确认”。文字模型和图像模型调用的 `cost` 都标出收费类别与未知/依赖预览的估算。`prepare_generation`、方案提案、设为当前和输入同步本身不收费；预览/准备也不构成图像授权。取消不启动收费服务、不给予重试权；此前 dispatch 是否已经收费由 provider receipt 决定。`manage_prompt_templates` 是分支工具：read/select 免费且无审批；save/restore 是本地写操作并沿用 confirm/auto，schema 中的 action 分支不可混用。

## 2. 36 项工具合同

星号表示必填字段。表内 `data.*` 是外层 `status` 与 call/result envelope 内部的业务字段。错误代码后的动作来自 registry 的 `allowedActions`，只描述可安全恢复路径，不代表自动重试。


### `get_capabilities`

**职责与时机：** 始终挂载的最小能力目录入口；读取可用组、已挂载工具和拒绝原因，并可请求下一安全模型调用挂载候选。它不授权联网、收费或执行。

**可用性与副作用：** `always_on` / `capabilities`；effect=`read`；approval=`none`；paid=`false`，mayCharge=`false`。Host-only：catalogSnapshot, conversationId.


**模型入参：** `requestedGroups`: array<value ∈ {capabilities, generation, history, tags, artists, gallery, web, prompt_presets, reference_presets, image_metadata, memory, skills, prompting_reference, questions, execution, prompt, creation_context, workbench, templates, prompt_service, vision_service, image_edit, creation_inputs}> ≤10（每次请求最多 10 组；完整目录共 23 组）。

**Host 注入：** catalogSnapshot, conversationId。逐字段派生来源见 registry `fieldMappings.hostInjected`。

**业务结果：** `catalogStatus*`: value ∈ {ok, partial}; `catalogVersion*`: string (min 1, max 100); `approvalMode*`: value ∈ {confirm, auto}; `available*`: array<object> ≤32; `mounted*`: array<string (min 1, max 100)> ≤64; `requestedGroups*`: array<value ∈ {capabilities, generation, history, tags, artists, gallery, web, prompt_presets, reference_presets, image_metadata, memory, skills, prompting_reference, questions, execution, prompt, creation_context, workbench, templates, prompt_service, vision_service, image_edit, creation_inputs}> ≤10; `requestedDenied*`: array<object> ≤10; `providerProjectionStatus*`: value ∈ {not_implemented, host_only}。

**错误与允许动作：** `invalid_arguments` → correct_arguments; `not_mounted` → continue_without_tool。

**兼容边界：** `langbai_software_capabilities`；完整字段映射以 registry `fieldMappings` 为准。请求能力不解除联网或付费限制。



### `read_generation_state`

**职责与时机：** 读取当前生图参数与工作台 draftId/draftRevision；CAS 冲突后先刷新权威版本，不猜 revision。

**可用性与副作用：** `conditional` / `generation`；effect=`read`；approval=`none`；paid=`false`，mayCharge=`false`。Host-only：conversationId, creationId, workbenchSnapshot.


**模型入参：** 无。

**Host 注入：** conversationId, creationId, workbenchSnapshot。逐字段派生来源见 registry `fieldMappings.hostInjected`。

**业务结果：** `readStatus*`: value ∈ {ok, not_found, unavailable}; `draftId`: string (min 1, max 200); `draftRevision`: integer (min 0, max 2147483647); `inputRevision`: integer (min 0, max 2147483647); `draftSource`: value ∈ {workbench, default}; `params`: object; `imageProvider`: value ∈ {novelai, openai-images}; `modelMode`: value ∈ {anime, furry}; `referenceCapabilities`: object。

**错误与允许动作：** `context_mismatch` → read_creation, reselect_target_creation; `not_found` → read_creation, read_proposal。

**兼容边界：** `langbai_get_generation_state`；完整字段映射以 registry `fieldMappings` 为准。旧 handler 只返回设置；draftId/draftRevision/inputRevision 由 host 工作台快照提供。



### `list_history`

**职责与时机：** 查询当前 conversation/creation 可见历史及稳定附件 ID；不执行任务，也不等于视觉检查。

**可用性与副作用：** `conditional` / `history`；effect=`read`；approval=`none`；paid=`false`，mayCharge=`false`。Host-only：allowedTargetScopes, conversationId, creationId, defaultMessageTarget, resolvedTargetScope.


**模型入参：** `limit`: integer (min 1, max 100); `date`: string (max 20); `groupId`: string (max 100); `targetConversationId`: string (min 1, max 200); `targetCreationId`: string (min 1, max 200)。
**目标解析：** `targetConversationId` 与 `targetCreationId` 必须同时出现或同时省略；显式 pair 由 host 与冻结的 message/card `allowedTargetScopes` 成对匹配，缺省只取发送该消息时冻结的目标。

**Host 注入：** allowedTargetScopes, conversationId, creationId, defaultMessageTarget, resolvedTargetScope。逐字段派生来源见 registry `fieldMappings.hostInjected`。

**业务结果：** `readStatus*`: value ∈ {ok, no_match}; `items*`: array<object> ≤100; `nextCursor`: string (max 500); `groups`: array<object> ≤100。

**错误与允许动作：** `invalid_arguments` → correct_arguments, select_supported_capability; `context_mismatch` → read_creation, reselect_target_creation。

**兼容边界：** `langbai_list_history`；完整字段映射以 registry `fieldMappings` 为准。新 host 先做归属过滤，再解析附件；旧全局 history/cache 不构成跨 creation 授权。



### `search_tags`

**职责与时机：** 在本地标签索引核对陌生标签；结果是候选，不自动采纳。

**可用性与副作用：** `conditional` / `tags`；effect=`read`；approval=`none`；paid=`false`，mayCharge=`false`。Host-only：无额外模型可见字段.


**模型入参：** `query*`: string (min 1, max 300); `limit`: integer (min 1, max 100)。

**Host 注入：** 无额外模型可见字段。逐字段派生来源见 registry `fieldMappings.hostInjected`。

**业务结果：** `searchStatus*`: value ∈ {ok, no_match}; `query*`: string (min 1, max 300); `items*`: array<object> ≤100。

**错误与允许动作：** `invalid_arguments` → correct_arguments, select_supported_capability。

**兼容边界：** `langbai_search_tags`；完整字段映射以 registry `fieldMappings` 为准。旧 handler query 上限 300。



### `search_artists`

**职责与时机：** 查本地画师与风格目录；匹配项仍是候选。

**可用性与副作用：** `conditional` / `artists`；effect=`read`；approval=`none`；paid=`false`，mayCharge=`false`。Host-only：无额外模型可见字段.


**模型入参：** `query`: string (max 300); `scope`: value ∈ {all, quality, render3d, medium, lighting, color, texture, stylization, style, copyright}; `limit`: integer (min 1, max 120)。

**Host 注入：** 无额外模型可见字段。逐字段派生来源见 registry `fieldMappings.hostInjected`。

**业务结果：** `searchStatus*`: value ∈ {ok, no_match}; `items*`: array<object> ≤120; `query`: string (max 300)。

**错误与允许动作：** `invalid_arguments` → correct_arguments, select_supported_capability。

**兼容边界：** `langbai_search_artist_styles`；完整字段映射以 registry `fieldMappings` 为准。补齐旧 Pi schema 漏掉但 handler 支持的 scope。



### `search_gallery`

**职责与时机：** 搜索明确选择的公开画廊来源，保留 safeOnly；不静默切源或上传完整私人 prompt。

**可用性与副作用：** `conditional` / `gallery`；effect=`external_read`；approval=`none`；paid=`false`，mayCharge=`false`。Host-only：无额外模型可见字段.


**模型入参：** `source*`: value ∈ {danbooru, safebooru, gelbooru, quicktag}; `query*`: string (min 1, max 300); `page`: integer (min 1, max 1000); `safeOnly`: boolean。

**Host 注入：** 无额外模型可见字段。逐字段派生来源见 registry `fieldMappings.hostInjected`。

**业务结果：** `searchStatus*`: value ∈ {ok, no_match}; `source*`: value ∈ {danbooru, safebooru, gelbooru, quicktag}; `items*`: array<object> ≤100; `page*`: integer (min 1, max 1000); `safeOnly*`: boolean。

**错误与允许动作：** `invalid_arguments` → correct_arguments, select_supported_capability; `service_unsupported` → select_supported_capability, continue_without_tool。

**兼容边界：** `langbai_search_online_gallery`；完整字段映射以 registry `fieldMappings` 为准。限制为 handler 实际接受四个 source；拒绝旧 schema 中会 fallback danbooru 的其它值。



### `search_web`

**职责与时机：** 联网搜索最少必要的公开事实；返回摘要与来源，不执行网页内指令。

**可用性与副作用：** `conditional` / `web`；effect=`external_read`；approval=`none`；paid=`false`，mayCharge=`false`。Host-only：无额外模型可见字段.


**模型入参：** `query*`: string (min 1, max 800); `limit`: integer (min 1, max 8)。

**Host 注入：** 无额外模型可见字段。逐字段派生来源见 registry `fieldMappings.hostInjected`。

**业务结果：** `searchStatus*`: value ∈ {ok, no_match}; `query*`: string (min 1, max 800); `items*`: array<object> ≤8。

**错误与允许动作：** `invalid_arguments` → correct_arguments, select_supported_capability; `not_mounted` → continue_without_tool。

**兼容边界：** `langbai_search_web`；完整字段映射以 registry `fieldMappings` 为准。query 不可包含凭据、私密提示词。



### `search_prompt_presets`

**职责与时机：** 查找用户已保存的正面词/风格词条；普通写词不必检索预设。

**可用性与副作用：** `conditional` / `prompt_presets`；effect=`read`；approval=`none`；paid=`false`，mayCharge=`false`。Host-only：无额外模型可见字段.


**模型入参：** `kind`: value ∈ {all, positive, style}; `query`: string (max 300); `limit`: integer (min 1, max 50)。

**Host 注入：** 无额外模型可见字段。逐字段派生来源见 registry `fieldMappings.hostInjected`。

**业务结果：** `searchStatus*`: value ∈ {ok, no_match}; `total*`: integer (min 0, max 100000); `items*`: array<object> ≤50。

**错误与允许动作：** `invalid_arguments` → correct_arguments, select_supported_capability。

**兼容边界：** `langbai_list_prompt_presets`；完整字段映射以 registry `fieldMappings` 为准。旧 handler 不支持 negative 分类；新契约不暴露该分类。



### `search_reference_presets`

**职责与时机：** 查询 Vibe/精准参考资源；返回绑定当前 creation 的 attachmentId，不自动设为改图源。

**可用性与副作用：** `conditional` / `reference_presets`；effect=`read`；approval=`none`；paid=`false`，mayCharge=`false`。Host-only：allowedTargetScopes, conversationId, creationId, defaultMessageTarget, resolvedTargetScope.


**模型入参：** `query`: string (max 300); `kind`: value ∈ {all, vibe, precise}; `group`: string (max 160); `limit`: integer (min 1, max 100); `targetConversationId`: string (min 1, max 200); `targetCreationId`: string (min 1, max 200)。
**目标解析：** `targetConversationId` 与 `targetCreationId` 必须同时出现或同时省略；显式 pair 由 host 与冻结的 message/card `allowedTargetScopes` 成对匹配，缺省只取发送该消息时冻结的目标。

**Host 注入：** allowedTargetScopes, conversationId, creationId, defaultMessageTarget, resolvedTargetScope。逐字段派生来源见 registry `fieldMappings.hostInjected`。

**业务结果：** `searchStatus*`: value ∈ {ok, no_match}; `total*`: integer (min 0, max 100000); `groups`: array<string (max 160)> ≤200; `items*`: array<object> ≤100。

**错误与允许动作：** `invalid_arguments` → correct_arguments, select_supported_capability; `context_mismatch` → read_creation, reselect_target_creation; `attachment_unavailable` → refresh_attachment, continue_without_tool。

**兼容边界：** `langbai_list_reference_presets`；完整字段映射以 registry `fieldMappings` 为准。补齐旧 Pi schema 漏掉的 group/kind/limit；discussion role 必须 includeInGeneration=false，host 校验归属。



### `read_image_metadata`

**职责与时机：** 读取归属当前会话/作品的图片内嵌参数；元数据不能代替看图。

**可用性与副作用：** `conditional` / `image_metadata`；effect=`read`；approval=`none`；paid=`false`，mayCharge=`false`。Host-only：allowedTargetScopes, conversationId, creationId, defaultMessageTarget, resolvedTargetScope.


**模型入参：** `attachmentId*`: string (min 1, max 200); `targetConversationId`: string (min 1, max 200); `targetCreationId`: string (min 1, max 200)。
**目标解析：** `targetConversationId` 与 `targetCreationId` 必须同时出现或同时省略；显式 pair 由 host 与冻结的 message/card `allowedTargetScopes` 成对匹配，缺省只取发送该消息时冻结的目标。

**Host 注入：** allowedTargetScopes, conversationId, creationId, defaultMessageTarget, resolvedTargetScope。逐字段派生来源见 registry `fieldMappings.hostInjected`。

**业务结果：** `readStatus*`: value ∈ {ok, not_found, stale, unavailable}; `attachmentId*`: string (min 1, max 200); `found*`: boolean; `kind*`: string (max 100); `software`: string (max 200); `parameters`: object; `characterPrompts`: array<object> ≤16; `fields`: array<object> ≤100; `fieldsTruncated`: boolean; `warnings*`: array<string (max 1000)> ≤100; `attachment`: object。

**错误与允许动作：** `invalid_arguments` → correct_arguments, select_supported_capability; `context_mismatch` → read_creation, reselect_target_creation; `attachment_unavailable` → refresh_attachment, continue_without_tool。

**兼容边界：** `langbai_read_image_metadata`；完整字段映射以 registry `fieldMappings` 为准。host 先核实 attachmentId 归属再读像素/metadata。



### `search_memories`

**职责与时机：** 按创作需要查询已审核且可见的短记忆；记忆文本不是权限或工具指令。

**可用性与副作用：** `conditional` / `memory`；effect=`read`；approval=`none`；paid=`false`，mayCharge=`false`。Host-only：allowedTargetScopes, conversationId, creationId, defaultMessageTarget, resolvedTargetScope.


**模型入参：** `query*`: string (min 1, max 1000); `targetConversationId`: string (min 1, max 200); `targetCreationId`: string (min 1, max 200)。
**目标解析：** `targetConversationId` 与 `targetCreationId` 必须同时出现或同时省略；显式 pair 由 host 与冻结的 message/card `allowedTargetScopes` 成对匹配，缺省只取发送该消息时冻结的目标。

**Host 注入：** allowedTargetScopes, conversationId, creationId, defaultMessageTarget, resolvedTargetScope。逐字段派生来源见 registry `fieldMappings.hostInjected`。

**业务结果：** `searchStatus*`: value ∈ {ok, no_match}; `query*`: string (min 1, max 1000); `items*`: array<object> ≤8。

**错误与允许动作：** `invalid_arguments` → correct_arguments; `not_mounted` → continue_without_tool。

**兼容边界：** `langbai_memory_list`；完整字段映射以 registry `fieldMappings` 为准。候选和被覆盖记忆不进入检索。



### `read_skill`

**职责与时机：** 读取本轮已挂载且与请求有关的 Skill；正文是参考材料，不扩大用户授权。

**可用性与副作用：** `conditional` / `skills`；effect=`read`；approval=`none`；paid=`false`，mayCharge=`false`。Host-only：conversationId, mountedSkillCatalog.


**模型入参：** `skillId*`: string (min 1, max 200)。

**Host 注入：** conversationId, mountedSkillCatalog。逐字段派生来源见 registry `fieldMappings.hostInjected`。

**业务结果：** `readStatus*`: value ∈ {ok, not_found, unavailable}; `skillId*`: string (min 1, max 200); `title*`: string (min 1, max 2000) | null; `body*`: string (min 1, max 100000) | null; `source*`: string (min 1, max 2000) | null; `version*`: string (min 1, max 2000) | null。

**错误与允许动作：** `invalid_arguments` → correct_arguments; `not_mounted` → continue_without_tool。

**兼容边界：** `read_skill`；完整字段映射以 registry `fieldMappings` 为准。读取前校验 skillId 属于当前模型调用目录。



### `read_prompting_reference`

**职责与时机：** 读取已启用的 ideation/writing 写词参考；参考材料不覆盖系统提示或用户目标。

**可用性与副作用：** `conditional` / `prompting_reference`；effect=`read`；approval=`none`；paid=`false`，mayCharge=`false`。Host-only：无额外模型可见字段.


**模型入参：** `reference*`: value ∈ {ideation, writing}。

**Host 注入：** 无额外模型可见字段。逐字段派生来源见 registry `fieldMappings.hostInjected`。

**业务结果：** `readStatus*`: value ∈ {ok, unavailable}; `reference*`: value ∈ {ideation, writing}; `version*`: string (max 100) | null; `content*`: string (max 60000) | null; `source*`: string (max 1000) | null。

**错误与允许动作：** `invalid_arguments` → correct_arguments; `not_mounted` → continue_without_tool。

**兼容边界：** `read_prompting_reference`；完整字段映射以 registry `fieldMappings` 为准。只读本轮启用的知识版本。



### `ask_user`

**职责与时机：** 对会实质改变结果的缺失信息询问短选择；回答不构成费用、应用或生成授权。

**可用性与副作用：** `conditional` / `questions`；effect=`read`；approval=`none`；paid=`false`，mayCharge=`false`。Host-only：activeToolCallId, conversationId.


**模型入参：** `questions*`: array<object> ≥1 ≤3。

**Host 注入：** activeToolCallId, conversationId。逐字段派生来源见 registry `fieldMappings.hostInjected`。

**业务结果：** `answerStatus*`: value ∈ {answered, cancelled, unanswered}; `answers`: array<object> ≤3; `answeredAt`: string (max 64)。

**错误与允许动作：** `invalid_arguments` → correct_arguments; `cancelled` → continue_without_action。

**兼容边界：** `langbai_ask_question`；完整字段映射以 registry `fieldMappings` 为准。返回真实回答、取消或未回答；不修改 approval mode。



### `get_execution`

**职责与时机：** 查询持久执行记录与逐张 output receipt；completed 输出带可复用附件完整身份以及逐张 resolvedSeed/source。外层 completed 只表示查询返回，任务阶段读取 data.executionStatus。

**可用性与副作用：** `conditional` / `execution`；effect=`read`；approval=`none`；paid=`false`，mayCharge=`false`。Host-only：allowedTargetScopes, authorizationScope, defaultMessageTarget, resolvedTargetScope.


**模型入参：** `executionId*`: string (min 1, max 200); `targetConversationId`: string (min 1, max 200); `targetCreationId`: string (min 1, max 200)。
**目标解析：** `targetConversationId` 与 `targetCreationId` 必须同时出现或同时省略；显式 pair 由 host 与冻结的 message/card `allowedTargetScopes` 成对匹配，缺省只取发送该消息时冻结的目标。

**Host 注入：** allowedTargetScopes, authorizationScope, defaultMessageTarget, resolvedTargetScope。逐字段派生来源见 registry `fieldMappings.hostInjected`。

**业务结果：** `readStatus*`: value ∈ {ok, not_found, unavailable}; `executionId*`: string (min 1, max 200); `executionStatus`: value ∈ {queued, dispatching, running, cancel_requested, completed, partial, error, cancelled, unknown, blocked, denied}; `queuePosition`: integer (min 0, max 100000); `blockedReason`: value ∈ {unknown_prior_receipt, provider_changed, attachment_invalid, account_changed, capability_changed, authorization_stale, prior_paid_failure}; `outputs`: array<object> ≤8; `createdAt`: string (max 64); `updatedAt`: string (max 64); `receiptRevision`: integer (min 0, max 2147483647); `providerReceiptStatus`: value ∈ {pending, confirmed, unknown, not_applicable}; `requestedSeedPolicy`: value ∈ {random, fixed}; `requestedSeed`: integer (min 0, max 4294967295) | null; `expectedOutputCount`: integer (min 1, max 8); `requestGranularity`: value ∈ {per_output, batch}; `pauseReason`: value ∈ {none, queue_serialization, unknown_prior_receipt, user_pause, approval_pending, policy_hold}。

**错误与允许动作：** `invalid_arguments` → correct_arguments, select_supported_capability; `context_mismatch` → read_creation, reselect_target_creation; `not_found` → read_creation, read_proposal。

**兼容边界：** `无等价旧 handler`；完整字段映射以 registry `fieldMappings` 为准。



### `propose_prompt`

**职责与时机：** 在指定会话创作对象创建或修订版本化提示词提案；只写 conversation，不改工作台、不收费。

**可用性与副作用：** `conditional` / `prompt`；effect=`conversation_write`；approval=`none`；paid=`false`，mayCharge=`false`。Host-only：allowedTargetScopes, defaultMessageTarget, operationKey, resolvedTargetScope, sourceAttachmentBindings, userIntentRef.


**模型入参：** `positivePrompt*`: string (min 1, max 20000); `negativePrompt`: string (max 20000); `stylePrompt`: string (max 20000); `modelVersion`: string (max 120); `sourceAttachmentIds`: array<string (min 1, max 200)> ≤16; `changeSummary`: string (max 2000); `proposalId`: string (min 1, max 200); `baseRevision`: integer (min 1, max 2147483647); `targetConversationId`: string (min 1, max 200); `targetCreationId`: string (min 1, max 200)。
**目标解析：** `targetConversationId` 与 `targetCreationId` 必须同时出现或同时省略；显式 pair 由 host 与冻结的 message/card `allowedTargetScopes` 成对匹配，缺省只取发送该消息时冻结的目标。

**Host 注入：** allowedTargetScopes, defaultMessageTarget, operationKey, resolvedTargetScope, sourceAttachmentBindings, userIntentRef。逐字段派生来源见 registry `fieldMappings.hostInjected`。

**业务结果：** `proposalStatus*`: value ∈ {proposed, revised, conflict, not_found, invalid}; `proposalId`: string (min 1, max 200) | null; `revision`: integer (min 1, max 2147483647) | null; `positivePrompt`: string (min 1, max 20000) | null; `negativePrompt`: string (max 20000); `stylePrompt`: string (max 20000); `modelVersion`: string (max 120); `sourceAttachmentIds`: array<string (min 1, max 200)> ≤16; `changeSummary`: string (max 2000) | null; `diff`: object; `sourceAttachments`: array<object> ≤16。

**错误与允许动作：** `invalid_arguments` → correct_arguments, select_supported_capability; `context_mismatch` → read_creation, reselect_target_creation; `stale_revision` → read_creation, read_proposal, request_user_decision; `attachment_unavailable` → refresh_attachment, continue_without_tool。

**兼容边界：** `无等价旧 handler`；完整字段映射以 registry `fieldMappings` 为准。不映射到旧 apply handler；修订时 proposalId/baseRevision 必须成对且过期拒绝。



### `read_creation`

**职责与时机：** 读取目标 creation 的 currentProposalRef/selectionRevision、draft/input revision，以及完整参考输入绑定（role=reference 时含 referencePurpose）；成功结果始终返回 references 数组，空时也显式返回 []。

**可用性与副作用：** `conditional` / `creation_context`；effect=`read`；approval=`none`；paid=`false`，mayCharge=`false`。Host-only：allowedTargetScopes, defaultMessageTarget, resolvedTargetScope, sourceCardContext.


**模型入参：** `targetConversationId`: string (min 1, max 200); `targetCreationId`: string (min 1, max 200)。
**目标解析：** `targetConversationId` 与 `targetCreationId` 必须同时出现或同时省略；显式 pair 由 host 与冻结的 message/card `allowedTargetScopes` 成对匹配，缺省只取发送该消息时冻结的目标。

**Host 注入：** allowedTargetScopes, defaultMessageTarget, resolvedTargetScope, sourceCardContext。逐字段派生来源见 registry `fieldMappings.hostInjected`。

**业务结果：** `readStatus*`: value ∈ {ok, not_found}; `conversationId*`: string (min 1, max 200); `creationId*`: string (min 1, max 200); `currentProposalRef`: object | null; `selectionRevision`: integer (min 0, max 2147483647); `draftId`: string (min 1, max 200); `draftRevision`: integer (min 0, max 2147483647); `inputRevision`: integer (min 0, max 2147483647); `references`: array<object> ≤32; `proposals`: array<object> ≤100; `activeExecutionIds`: array<string (min 1, max 200)> ≤32。

**错误与允许动作：** `context_mismatch` → read_creation, reselect_target_creation; `not_found` → read_creation, read_proposal。

**兼容边界：** `无等价旧 handler`；完整字段映射以 registry `fieldMappings` 为准。



### `read_proposal`

**职责与时机：** 读取目标 creation 中精确 proposalId/revision 的完整提示词与来源绑定；not_found/stale 不返回伪造正文。不会更新 currentProposalRef。

**可用性与副作用：** `conditional` / `creation_context`；effect=`read`；approval=`none`；paid=`false`，mayCharge=`false`。Host-only：allowedTargetScopes, defaultMessageTarget, resolvedTargetScope, sourceCardContext.


**模型入参：** `proposalId*`: string (min 1, max 200); `revision*`: integer (min 1, max 2147483647); `targetConversationId`: string (min 1, max 200); `targetCreationId`: string (min 1, max 200)。
**目标解析：** `targetConversationId` 与 `targetCreationId` 必须同时出现或同时省略；显式 pair 由 host 与冻结的 message/card `allowedTargetScopes` 成对匹配，缺省只取发送该消息时冻结的目标。

**Host 注入：** allowedTargetScopes, defaultMessageTarget, resolvedTargetScope, sourceCardContext。逐字段派生来源见 registry `fieldMappings.hostInjected`。

**业务结果：** `proposalReadStatus*`: value ∈ {ok, not_found, stale}; `proposalId*`: string (min 1, max 200); `revision*`: integer (min 1, max 2147483647); `positivePrompt`: string (min 1, max 20000); `negativePrompt`: string (max 20000); `stylePrompt`: string (max 20000); `modelVersion`: string (max 120); `sourceAttachmentIds`: array<string (min 1, max 200)> ≤16; `changeSummary`: string (max 2000); `currentProposalRef`: object | null; `selectionRevision`: integer (min 0, max 2147483647); `sourceAttachments`: array<object> ≤16。

**错误与允许动作：** `invalid_arguments` → correct_arguments, select_supported_capability; `context_mismatch` → read_creation, reselect_target_creation; `not_found` → read_creation, read_proposal; `stale_revision` → read_creation, read_proposal, request_user_decision。

**兼容边界：** `无等价旧 handler`；完整字段映射以 registry `fieldMappings` 为准。



### `set_current_proposal`

**职责与时机：** 按 CAS 将用户明确指定的 proposal revision 设为当前方案；局部可撤销，不写生成工作台。

**可用性与副作用：** `conditional` / `prompt`；effect=`current_proposal_selection`；approval=`none`；paid=`false`，mayCharge=`false`。Host-only：allowedTargetScopes, defaultMessageTarget, operationKey, resolvedTargetScope, userIntentRef.


**模型入参：** `proposalId*`: string (min 1, max 200); `revision*`: integer (min 1, max 2147483647); `expectedSelectionRevision*`: integer (min 0, max 2147483647); `targetConversationId`: string (min 1, max 200); `targetCreationId`: string (min 1, max 200)。
**目标解析：** `targetConversationId` 与 `targetCreationId` 必须同时出现或同时省略；显式 pair 由 host 与冻结的 message/card `allowedTargetScopes` 成对匹配，缺省只取发送该消息时冻结的目标。

**Host 注入：** allowedTargetScopes, defaultMessageTarget, operationKey, resolvedTargetScope, userIntentRef。逐字段派生来源见 registry `fieldMappings.hostInjected`。

**业务结果：** `selectionStatus*`: value ∈ {applied, unchanged, conflict, not_found, invalid}; `actionId*`: string (min 1, max 200) | null; `beforeRef*`: object | null; `afterRef*`: object | null; `beforeSelectionRevision*`: integer (min 0, max 2147483647); `selectionRevision*`: integer (min 0, max 2147483647) | null。

**错误与允许动作：** `invalid_arguments` → correct_arguments, select_supported_capability; `context_mismatch` → read_creation, reselect_target_creation; `not_found` → read_creation, read_proposal; `stale_revision` → read_creation, read_proposal, request_user_decision。

**兼容边界：** `无等价旧 handler`；完整字段映射以 registry `fieldMappings` 为准。无旧 handler；冲突返回真实 selectionRevision，UI 撤销通过同一 CAS 恢复 beforeRef (允许 null)。



### `apply_prompt`

**职责与时机：** 仅在用户明确要求时将指定 proposal revision 原子应用到指定生成工作台；CAS 冲突不写入。

**可用性与副作用：** `conditional` / `workbench`；effect=`workbench_write`；approval=`existing_confirm_auto`；paid=`false`，mayCharge=`false`。Host-only：allowedTargetScopes, defaultMessageTarget, operationKey, resolvedTargetScope, userIntentRef.


**模型入参：** `proposalId*`: string (min 1, max 200); `proposalRevision*`: integer (min 1, max 2147483647); `targetDraftId*`: string (min 1, max 200); `expectedDraftRevision*`: integer (min 0, max 2147483647); `targetConversationId`: string (min 1, max 200); `targetCreationId`: string (min 1, max 200)。
**目标解析：** `targetConversationId` 与 `targetCreationId` 必须同时出现或同时省略；显式 pair 由 host 与冻结的 message/card `allowedTargetScopes` 成对匹配，缺省只取发送该消息时冻结的目标。

**Host 注入：** allowedTargetScopes, defaultMessageTarget, operationKey, resolvedTargetScope, userIntentRef。逐字段派生来源见 registry `fieldMappings.hostInjected`。

**业务结果：** `applyStatus*`: value ∈ {applied, conflict, not_found, invalid}; `draftId*`: string (min 1, max 200); `draftRevision*`: integer (min 0, max 2147483647) | null; `diff`: object。

**错误与允许动作：** `invalid_arguments` → correct_arguments, select_supported_capability; `context_mismatch` → read_creation, reselect_target_creation; `not_found` → read_creation, read_proposal; `stale_revision` → read_creation, read_proposal, request_user_decision; `user_denied` → continue_without_action。

**兼容边界：** `langbai_apply_prompt`；完整字段映射以 registry `fieldMappings` 为准。旧 handler 仅写 lastGenerationState，无全局 draft CAS；需新 transaction adapter，不可直接复用旧 handler。



### `save_prompt_preset`

**职责与时机：** 保存用户明确要求复用的正面提示词词条；不管理助手系统预设。

**可用性与副作用：** `conditional` / `prompt_presets`；effect=`local_preset_write`；approval=`existing_confirm_auto`；paid=`false`，mayCharge=`false`。Host-only：无额外模型可见字段.


**模型入参：** `name*`: string (min 1, max 100); `prompt*`: string (min 1, max 30000)。

**Host 注入：** 无额外模型可见字段。逐字段派生来源见 registry `fieldMappings.hostInjected`。

**业务结果：** `writeStatus*`: value ∈ {saved, conflict, invalid}; `id*`: string (min 1, max 200) | null; `name*`: string (min 1, max 100); `kind*`: value ∈ {positive}; `prompt`: string (max 30000); `revision*`: integer (min 1, max 2147483647) | null。

**错误与允许动作：** `invalid_arguments` → correct_arguments。

**兼容边界：** `langbai_save_prompt_preset`；完整字段映射以 registry `fieldMappings` 为准。legacy handler 仅保存 positive preset；store revision 由新 adapter 返回。



### `read_prompt_template`

**职责与时机：** 读取应用实际保存的文字模板；modelVersion(v5/v4.5) 与正文 templateRevision 是分开的。

**可用性与副作用：** `conditional` / `templates`；effect=`read`；approval=`none`；paid=`false`，mayCharge=`false`。Host-only：无额外模型可见字段.


**模型入参：** `kind`: value ∈ {convert, reverse, optimize, assistant}; `mode`: value ∈ {mixed, tags, natural}; `modelVersion`: value ∈ {v5, v4.5}。

**Host 注入：** 无额外模型可见字段。逐字段派生来源见 registry `fieldMappings.hostInjected`。

**业务结果：** `readStatus*`: value ∈ {ok, not_found}; `kind*`: value ∈ {convert, reverse, optimize, assistant}; `mode*`: value ∈ {mixed, tags, natural}; `modelVersion*`: value ∈ {v5, v4.5}; `templateRevision`: string (min 1, max 128) | null; `body`: string (max 60000) | null; `bodySha256`: string (max 64) | null; `source`: value ∈ {builtin, custom} | null。

**错误与允许动作：** `invalid_arguments` → correct_arguments。

**兼容边界：** `studio_prompt_template`；完整字段映射以 registry `fieldMappings` 为准。旧 templateVersion 表示模型/提示词版本 v5/v4.5，不是正文 revision。



### `manage_prompt_templates`

**职责与时机：** 按 revision 读取、选择、保存或恢复应用共享的文字模板；写入沿用现有确认和备份流程。

**可用性与副作用：** `conditional` / `templates`；effect=`template_write`；approval=`existing_confirm_auto`；paid=`false`，mayCharge=`false`。Host-only：无额外模型可见字段.
 分支审批：`read`=none, `select`=none, `save`=existing_confirm_auto, `restore`=existing_confirm_auto.


**模型入参：** `action*`: value ∈ {read, select, save, restore}; `kind`: value ∈ {convert, reverse, optimize, assistant}; `mode`: value ∈ {mixed, tags, natural}; `modelVersion`: value ∈ {v5, v4.5}; `expectedRevision`: string (min 1, max 128); `body`: string (max 60000)。

**Host 注入：** 无额外模型可见字段。逐字段派生来源见 registry `fieldMappings.hostInjected`。

**业务结果：** `templateStatus*`: value ∈ {read, selected, saved, restored, conflict, cancelled, invalid}; `kind*`: value ∈ {convert, reverse, optimize, assistant}; `mode*`: value ∈ {mixed, tags, natural}; `modelVersion*`: value ∈ {v5, v4.5}; `templateRevision*`: string (min 1, max 128) | null; `body`: string (max 60000); `source`: value ∈ {builtin, custom}; `backupPath`: string (max 1000)。

**错误与允许动作：** `invalid_arguments` → correct_arguments, select_supported_capability; `stale_revision` → read_creation, read_proposal, request_user_decision; `user_denied` → continue_without_action。

**兼容边界：** `langbai_templates`；完整字段映射以 registry `fieldMappings` 为准。read/select/save/restore 由 action 表示；restore 由 adapter 合成 legacy restoreDefault=true，不接受模型伪造该内部字段；旧 workflow 会重读 revision 并在 save/restore 前确认和备份。



### `convert_prompt`

**职责与时机：** 用户明确要求时调用配置的文字转换服务，返回候选文本；不自动应用/保存，文字服务可能收费。

**可用性与副作用：** `conditional` / `prompt_service`；effect=`external_text_model`；approval=`existing_confirm_auto`；paid=`true`，mayCharge=`true`。Host-only：allowedTargetScopes, defaultMessageTarget, operationKey, resolvedTargetScope.


**模型入参：** `text*`: string (min 1, max 24000); `knownCharacter`: boolean; `mode`: value ∈ {mixed, tags, natural}; `modelVersion`: value ∈ {v5, v4.5}; `templateRevision`: string (min 1, max 128); `targetConversationId`: string (min 1, max 200); `targetCreationId`: string (min 1, max 200)。
**目标解析：** `targetConversationId` 与 `targetCreationId` 必须同时出现或同时省略；显式 pair 由 host 与冻结的 message/card `allowedTargetScopes` 成对匹配，缺省只取发送该消息时冻结的目标。

**Host 注入：** allowedTargetScopes, defaultMessageTarget, operationKey, resolvedTargetScope。逐字段派生来源见 registry `fieldMappings.hostInjected`。

**业务结果：** `serviceStatus*`: value ∈ {succeeded, failed, unknown}; `candidateText`: string (max 30000) | null; `modelVersion`: value ∈ {v5, v4.5}; `templateRevision`: string (max 128); `source`: string (max 100); `bodySha256`: string (max 64)。

**错误与允许动作：** `invalid_arguments` → correct_arguments; `template_stale` → read_current_template, request_user_decision; `provider_unknown` → do_not_retry_unknown, stop_related_paid_calls, wait_for_receipt。

**兼容边界：** `langbai_convert_prompt`；完整字段映射以 registry `fieldMappings` 为准。templateRevision 与 templateVersion 分开；unknown 不自动重发。



### `edit_prompt`

**职责与时机：** 仅用户明确选择配置的优化/编辑模型时调用；普通协作写词由对话提案完成。

**可用性与副作用：** `conditional` / `prompt_service`；effect=`external_text_model`；approval=`existing_confirm_auto`；paid=`true`，mayCharge=`true`。Host-only：allowedTargetScopes, defaultMessageTarget, operationKey, resolvedTargetScope.


**模型入参：** `kind*`: value ∈ {optimize, custom}; `currentPrompt*`: string (min 1, max 24000); `instruction`: string (max 8000); `mode`: value ∈ {mixed, tags, natural}; `modelVersion`: value ∈ {v5, v4.5}; `templateRevision`: string (min 1, max 128); `targetConversationId`: string (min 1, max 200); `targetCreationId`: string (min 1, max 200)。
**目标解析：** `targetConversationId` 与 `targetCreationId` 必须同时出现或同时省略；显式 pair 由 host 与冻结的 message/card `allowedTargetScopes` 成对匹配，缺省只取发送该消息时冻结的目标。

**Host 注入：** allowedTargetScopes, defaultMessageTarget, operationKey, resolvedTargetScope。逐字段派生来源见 registry `fieldMappings.hostInjected`。

**业务结果：** `serviceStatus*`: value ∈ {succeeded, failed, unknown}; `candidateText`: string (max 30000) | null; `changeSummary`: string (max 2000); `templateRevision`: string (max 128); `source`: string (max 100); `bodySha256`: string (max 64)。

**错误与允许动作：** `invalid_arguments` → correct_arguments; `template_stale` → read_current_template, request_user_decision; `provider_unknown` → do_not_retry_unknown, stop_related_paid_calls, wait_for_receipt。

**兼容边界：** `langbai_edit_prompt`；完整字段映射以 registry `fieldMappings` 为准。保留旧 kind/currentPrompt/instruction/mode；不将 templateVersion 当正文 revision。



### `reverse_prompt`

**职责与时机：** 用户明确请求且图片像素可达时视觉反推；结果附不确定性，不把元数据当视觉观察。

**可用性与副作用：** `conditional` / `vision_service`；effect=`external_vision_model`；approval=`existing_confirm_auto`；paid=`true`，mayCharge=`true`。Host-only：allowedTargetScopes, attachmentBinding, defaultMessageTarget, operationKey, resolvedTargetScope.


**模型入参：** `attachmentId*`: string (min 1, max 200); `scope`: value ∈ {full, character, object, scene}; `hint`: string (max 1000); `knownCharacter`: boolean; `mode`: value ∈ {mixed, tags, natural}; `modelVersion`: value ∈ {v5, v4.5}; `templateRevision`: string (min 1, max 128); `targetConversationId`: string (min 1, max 200); `targetCreationId`: string (min 1, max 200)。
**目标解析：** `targetConversationId` 与 `targetCreationId` 必须同时出现或同时省略；显式 pair 由 host 与冻结的 message/card `allowedTargetScopes` 成对匹配，缺省只取发送该消息时冻结的目标。

**Host 注入：** allowedTargetScopes, attachmentBinding, defaultMessageTarget, operationKey, resolvedTargetScope。逐字段派生来源见 registry `fieldMappings.hostInjected`。

**业务结果：** `serviceStatus*`: value ∈ {succeeded, failed, unknown}; `attachmentId*`: string (min 1, max 200); `candidateText`: string (min 1, max 30000); `uncertainty`: string (min 1, max 2000); `templateRevision`: string (max 128); `source`: string (max 100); `bodySha256`: string (max 64); `partialText`: string (min 1, max 30000); `isPartial*`: boolean。

`serviceStatus=failed/unknown` 不得填入成功字段 `candidateText`；若保留部分识别正文，必须同时有 `partialText` 与 `isPartial=true`。远端已发送后的 unknown 是业务回执，不是 preflight 拒绝；结果 envelope 正常返回时可用外层 `completed` 搭配 `data.serviceStatus=unknown`，工具调用自身失败时则保留真实外层错误与同一份 business data。

**错误与允许动作：** `invalid_arguments` → correct_arguments; `context_mismatch` → read_creation, reselect_target_creation; `attachment_unavailable` → refresh_attachment, continue_without_tool; `provider_unknown` → do_not_retry_unknown, stop_related_paid_calls, wait_for_receipt。

**兼容边界：** `langbai_reverse_prompt`；完整字段映射以 registry `fieldMappings` 为准。host 校验 creation 归属并传实际像素。



### `prepare_generation`

**职责与时机：** 免费冻结一次文生图输入并生成预览/一次性令牌；必须二选一：proposalId+revision 或直接 positivePrompt，不提交生图；有效参考绑定需带 referencePurpose，host 仍单独核验服务能力。

**可用性与副作用：** `conditional` / `generation`；effect=`prepare`；approval=`none`；paid=`false`，mayCharge=`false`。Host-only：allowedTargetScopes, attachmentBindings, capabilitySnapshot, defaultMessageTarget, frozenInputRevision, operationKey, promptLocks, providerBinding, resolvedTargetScope, submissionKey, turnEffectiveInputSnapshot, userIntentRef, workbenchSnapshot.


**模型入参：** `positivePrompt`: string (min 1, max 20000); `negativePrompt`: string (max 20000); `stylePrompt`: string (max 20000); `count`: integer (min 1, max 8); `model`: string (min 1, max 120); `width`: integer (min 64, max 2048); `height`: integer (min 64, max 2048); `steps`: integer (min 1, max 50); `cfgScale`: number (min 0, max 10); `cfgRescale`: number (min 0, max 1); `requestedSeedPolicy`: value ∈ {random, fixed}; `requestedSeed`: integer (min 0, max 4294967295); `sampler`: string (min 1, max 100); `noiseSchedule`: value ∈ {native, karras, exponential}; `smea`: boolean; `smeaDyn`: boolean; `variety`: boolean; `effort`: value ∈ {medium, high}; `qualityPreset`: value ∈ {standard, light, none}; `ucPreset`: integer (min 0, max 3); `transparentBackground`: boolean; `fileNamePrefix`: string (max 80); `vibeReferences`: array<object> ≤16; `preciseReferences`: array<object> ≤16; `characterPrompts`: array<object> ≤16; `proposalId`: string (min 1, max 200); `revision`: integer (min 1, max 2147483647); `targetConversationId`: string (min 1, max 200); `targetCreationId`: string (min 1, max 200)。
**目标解析：** `targetConversationId` 与 `targetCreationId` 必须同时出现或同时省略；显式 pair 由 host 与冻结的 message/card `allowedTargetScopes` 成对匹配，缺省只取发送该消息时冻结的目标。

**Host 注入：** allowedTargetScopes, attachmentBindings, capabilitySnapshot, defaultMessageTarget, frozenInputRevision, operationKey, promptLocks, providerBinding, resolvedTargetScope, submissionKey, turnEffectiveInputSnapshot, userIntentRef, workbenchSnapshot。逐字段派生来源见 registry `fieldMappings.hostInjected`。

**业务结果：** `preparationStatus*`: value ∈ {prepared, stale, invalid}; `preparationId`: string (min 1, max 200) | null; `inputRevision`: integer (min 0, max 2147483647) | null; `inputFingerprint`: string (min 1, max 128) | null; `sourceProposal`: object | null; `preview`: object | null; `expiresAt`: string (max 64)。

**错误与允许动作：** `invalid_arguments` → correct_arguments, select_supported_capability; `context_mismatch` → read_creation, reselect_target_creation; `stale_revision` → read_creation, read_proposal, request_user_decision; `capability_unavailable` → select_supported_capability, use_supported_alternative; `attachment_unavailable` → refresh_attachment, continue_without_action。

**兼容边界：** `langbai_prepare_generation`；完整字段映射以 registry `fieldMappings` 为准。兼容图片 provider 的 materialized schema 只允许 positivePrompt/count/model；其他字段明确拒绝。role=discussion 或 includeInGeneration=false 的附件不可混入任务快照；仍须拒绝旧 schema 曾暴露但 handler 不支持的 scale、qualityToggle。



### `generate_image`

**职责与时机：** 消费当前创作中未过期且已通过既有授权策略的 preparation；accepted 只表示 durable queue 入队。

**可用性与副作用：** `conditional` / `generation`；effect=`image_execution`；approval=`existing_confirm_auto`；paid=`true`，mayCharge=`true`。Host-only：conversationId, creationId, operationKey, submissionKey, userIntentRef, providerBinding, accountBinding, attachmentBindings, frozenInputRevision, effectiveSnapshotRef, approvalReceipt, defaultMessageTarget, allowedTargetScopes, failedGateRef.


**模型入参：** `preparationId*`: string (min 1, max 200)。

**Host 注入：** conversationId, creationId, operationKey, submissionKey, userIntentRef, providerBinding, accountBinding, attachmentBindings, frozenInputRevision, effectiveSnapshotRef, approvalReceipt, defaultMessageTarget, allowedTargetScopes, failedGateRef。逐字段派生来源见 registry `fieldMappings.hostInjected`。

**业务结果：** `submissionStatus*`: value ∈ {accepted, blocked, stale, already_consumed}; `executionId`: string (min 1, max 200) | null; `executionStatus`: value ∈ {queued, dispatching, running, cancel_requested, completed, partial, error, cancelled, unknown, blocked, denied} | null; `inputFingerprint`: string (min 1, max 128) | null; `acceptedAt`: string (max 64) | null。

**错误与允许动作：** `invalid_arguments` → correct_arguments, select_supported_capability; `context_mismatch` → read_creation, reselect_target_creation; `preparation_stale` → read_generation_state, prepare_new_preview, request_user_decision; `queue_blocked` → check_execution_status, wait_for_receipt, stop_related_paid_calls; `idempotency_conflict` → check_execution_status, do_not_retry_unknown。

**兼容边界：** `langbai_generate_image`；完整字段映射以 registry `fieldMappings` 为准。ExecutionService durably records executionId, queue entry and receipt before accepted; legacy handler runs only behind worker.



### `redraw_image`

**职责与时机：** 从明确源图建立图生图任务；预览/授权前冻结 attachment、提示词、支持参数、inputRevision 和账号引用。

**可用性与副作用：** `conditional` / `image_edit`；effect=`image_execution`；approval=`existing_confirm_auto`；paid=`true`，mayCharge=`true`。Host-only：conversationId, creationId, operationKey, submissionKey, userIntentRef, providerBinding, accountBinding, attachmentBindings, frozenInputRevision, effectiveSnapshotRef, approvalReceipt, defaultMessageTarget, allowedTargetScopes, failedGateRef.


**模型入参：** `positivePrompt*`: string (min 1, max 20000); `negativePrompt`: string (max 20000); `stylePrompt`: string (max 20000); `count`: integer (min 1, max 8); `model`: string (min 1, max 120); `width`: integer (min 64, max 2048); `height`: integer (min 64, max 2048); `steps`: integer (min 1, max 50); `cfgScale`: number (min 0, max 10); `cfgRescale`: number (min 0, max 1); `requestedSeedPolicy`: value ∈ {random, fixed}; `requestedSeed`: integer (min 0, max 4294967295); `sampler`: string (min 1, max 100); `noiseSchedule`: value ∈ {native, karras, exponential}; `smea`: boolean; `smeaDyn`: boolean; `variety`: boolean; `effort`: value ∈ {medium, high}; `qualityPreset`: value ∈ {standard, light, none}; `ucPreset`: integer (min 0, max 3); `transparentBackground`: boolean; `fileNamePrefix`: string (max 80); `vibeReferences`: array<object> ≤16; `preciseReferences`: array<object> ≤16; `characterPrompts`: array<object> ≤16; `attachmentId*`: string (min 1, max 200); `strength`: number (min 0, max 1); `noise`: number (min 0, max 1); `targetConversationId`: string (min 1, max 200); `targetCreationId`: string (min 1, max 200)。
**目标解析：** `targetConversationId` 与 `targetCreationId` 必须同时出现或同时省略；显式 pair 由 host 与冻结的 message/card `allowedTargetScopes` 成对匹配，缺省只取发送该消息时冻结的目标。

**Host 注入：** conversationId, creationId, operationKey, submissionKey, userIntentRef, providerBinding, accountBinding, attachmentBindings, frozenInputRevision, effectiveSnapshotRef, approvalReceipt, defaultMessageTarget, allowedTargetScopes, failedGateRef。逐字段派生来源见 registry `fieldMappings.hostInjected`。

**业务结果：** `submissionStatus*`: value ∈ {accepted, blocked, invalid}; `executionId`: string (min 1, max 200) | null; `executionStatus`: value ∈ {queued, dispatching, running, cancel_requested, completed, partial, error, cancelled, unknown, blocked, denied} | null; `inputFingerprint`: string (min 1, max 128) | null; `acceptedAt`: string (max 64) | null。

**错误与允许动作：** `invalid_arguments` → correct_arguments, select_supported_capability; `context_mismatch` → read_creation, reselect_target_creation; `attachment_unavailable` → refresh_attachment, continue_without_action; `capability_unavailable` → select_supported_capability, use_supported_alternative; `provider_unknown` → do_not_retry_unknown, stop_related_paid_calls, wait_for_receipt。

**兼容边界：** `langbai_redraw_image`；完整字段映射以 registry `fieldMappings` 为准。reference arrays 按动态服务能力逐项验证；discussion/includeInGeneration=false 不能成为 source。



### `inpaint_image`

**职责与时机：** 用确切源图和蒙版局部重绘；接口不支持 Vibe/精准参考/角色提示，额外传入字段会被严格拒绝。

**可用性与副作用：** `conditional` / `image_edit`；effect=`image_execution`；approval=`existing_confirm_auto`；paid=`true`，mayCharge=`true`。Host-only：conversationId, creationId, operationKey, submissionKey, userIntentRef, providerBinding, accountBinding, attachmentBindings, frozenInputRevision, effectiveSnapshotRef, approvalReceipt, defaultMessageTarget, allowedTargetScopes, failedGateRef.


**模型入参：** `positivePrompt*`: string (min 1, max 20000); `negativePrompt`: string (max 20000); `stylePrompt`: string (max 20000); `count`: integer (min 1, max 8); `model`: string (min 1, max 120); `width`: integer (min 64, max 2048); `height`: integer (min 64, max 2048); `steps`: integer (min 1, max 50); `cfgScale`: number (min 0, max 10); `cfgRescale`: number (min 0, max 1); `requestedSeedPolicy`: value ∈ {random, fixed}; `requestedSeed`: integer (min 0, max 4294967295); `sampler`: string (min 1, max 100); `noiseSchedule`: value ∈ {native, karras, exponential}; `smea`: boolean; `smeaDyn`: boolean; `variety`: boolean; `effort`: value ∈ {medium, high}; `qualityPreset`: value ∈ {standard, light, none}; `ucPreset`: integer (min 0, max 3); `transparentBackground`: boolean; `fileNamePrefix`: string (max 80); `attachmentId*`: string (min 1, max 200); `maskAttachmentId*`: string (min 1, max 200); `strength`: number (min 0.01, max 1); `noise`: number (min 0, max 1); `inpaintModel`: string (min 1, max 120); `targetConversationId`: string (min 1, max 200); `targetCreationId`: string (min 1, max 200)。
**目标解析：** `targetConversationId` 与 `targetCreationId` 必须同时出现或同时省略；显式 pair 由 host 与冻结的 message/card `allowedTargetScopes` 成对匹配，缺省只取发送该消息时冻结的目标。

**Host 注入：** conversationId, creationId, operationKey, submissionKey, userIntentRef, providerBinding, accountBinding, attachmentBindings, frozenInputRevision, effectiveSnapshotRef, approvalReceipt, defaultMessageTarget, allowedTargetScopes, failedGateRef。逐字段派生来源见 registry `fieldMappings.hostInjected`。

**业务结果：** `submissionStatus*`: value ∈ {accepted, blocked, invalid}; `executionId`: string (min 1, max 200) | null; `executionStatus`: value ∈ {queued, dispatching, running, cancel_requested, completed, partial, error, cancelled, unknown, blocked, denied} | null; `inputFingerprint`: string (min 1, max 128) | null; `acceptedAt`: string (max 64) | null。

**错误与允许动作：** `invalid_arguments` → correct_arguments, select_supported_capability; `context_mismatch` → read_creation, reselect_target_creation; `attachment_unavailable` → refresh_attachment, continue_without_action; `capability_unavailable` → select_supported_capability; `provider_unknown` → do_not_retry_unknown, stop_related_paid_calls, wait_for_receipt。

**兼容边界：** `langbai_inpaint_image`；完整字段映射以 registry `fieldMappings` 为准。schema 不暴露并严格拒绝 vibeReferences/preciseReferences/characterPrompts；不偷偷删字段后退化。



### `upscale_image`

**职责与时机：** 按服务实际支持倍率生成派生图，不覆盖源图；不支持的 scale 明确拒绝而不是由旧 handler 改成 4。

**可用性与副作用：** `conditional` / `image_edit`；effect=`image_execution`；approval=`existing_confirm_auto`；paid=`true`，mayCharge=`true`。Host-only：conversationId, creationId, operationKey, submissionKey, userIntentRef, providerBinding, accountBinding, attachmentBindings, frozenInputRevision, effectiveSnapshotRef, approvalReceipt, defaultMessageTarget, allowedTargetScopes, failedGateRef.


**模型入参：** `attachmentId*`: string (min 1, max 200); `scale*`: value ∈ {2, 4}; `targetConversationId`: string (min 1, max 200); `targetCreationId`: string (min 1, max 200)。
**目标解析：** `targetConversationId` 与 `targetCreationId` 必须同时出现或同时省略；显式 pair 由 host 与冻结的 message/card `allowedTargetScopes` 成对匹配，缺省只取发送该消息时冻结的目标。

**Host 注入：** conversationId, creationId, operationKey, submissionKey, userIntentRef, providerBinding, accountBinding, attachmentBindings, frozenInputRevision, effectiveSnapshotRef, approvalReceipt, defaultMessageTarget, allowedTargetScopes, failedGateRef。逐字段派生来源见 registry `fieldMappings.hostInjected`。

**业务结果：** `submissionStatus*`: value ∈ {accepted, blocked, invalid}; `executionId`: string (min 1, max 200) | null; `executionStatus`: value ∈ {queued, dispatching, running, cancel_requested, completed, partial, error, cancelled, unknown, blocked, denied} | null; `inputFingerprint`: string (min 1, max 128) | null; `acceptedAt`: string (max 64) | null。

**错误与允许动作：** `invalid_arguments` → correct_arguments, select_supported_capability; `context_mismatch` → read_creation, reselect_target_creation; `attachment_unavailable` → refresh_attachment, continue_without_action; `capability_unavailable` → select_supported_capability; `provider_unknown` → do_not_retry_unknown, stop_related_paid_calls, wait_for_receipt。

**兼容边界：** `langbai_upscale_image`；完整字段映射以 registry `fieldMappings` 为准。host 先校验 imageProvider.upscaleScales，再调用旧 handler。



### `process_image`

**职责与时机：** 调用按 operation 分支约束的 Director 图像处理。emotion 操作必须给 emotion；colorize 与 emotion 参数不能混用。需要支持的 capability 与目标附件经 host 校验后走统一执行预览、授权和队列。

**可用性与副作用：** `conditional` / `image_edit`；effect=`image_execution`；approval=`existing_confirm_auto`；paid=`true`，mayCharge=`true`。Host-only：conversationId, creationId, operationKey, submissionKey, userIntentRef, providerBinding, accountBinding, attachmentBindings, frozenInputRevision, effectiveSnapshotRef, approvalReceipt, defaultMessageTarget, allowedTargetScopes, failedGateRef.


**模型入参：** `attachmentId*`: string (min 1, max 200); `operation*`: value ∈ {bg-removal, lineart, sketch, colorize, emotion, declutter}; `colorizePrompt`: string (max 2000); `emotion`: value ∈ {neutral, happy, sad, angry, surprised, scared, disgusted, amazed}; `emotionLevel`: number (min 0, max 1); `defry`: integer (min 0, max 5); `targetConversationId`: string (min 1, max 200); `targetCreationId`: string (min 1, max 200)。
**目标解析：** `targetConversationId` 与 `targetCreationId` 必须同时出现或同时省略；显式 pair 由 host 与冻结的 message/card `allowedTargetScopes` 成对匹配，缺省只取发送该消息时冻结的目标。

**Host 注入：** conversationId, creationId, operationKey, submissionKey, userIntentRef, providerBinding, accountBinding, attachmentBindings, frozenInputRevision, effectiveSnapshotRef, approvalReceipt, defaultMessageTarget, allowedTargetScopes, failedGateRef。逐字段派生来源见 registry `fieldMappings.hostInjected`。

**业务结果：** `submissionStatus*`: value ∈ {accepted, blocked, invalid}; `executionId`: string (min 1, max 200) | null; `executionStatus`: value ∈ {queued, dispatching, running, cancel_requested, completed, partial, error, cancelled, unknown, blocked, denied} | null; `inputFingerprint`: string (min 1, max 128) | null; `acceptedAt`: string (max 64) | null。

**错误与允许动作：** `invalid_arguments` → correct_arguments, select_supported_capability; `context_mismatch` → read_creation, reselect_target_creation; `service_unsupported` → select_supported_capability, use_supported_alternative; `provider_unknown` → do_not_retry_unknown, stop_related_paid_calls, wait_for_receipt。

**兼容边界：** `langbai_director`；完整字段映射以 registry `fieldMappings` 为准。canonical 不暴露旧 prompt alias；仅历史投影在 colorize 且无冲突时可迁移 alias。



### `cancel_execution`

**职责与时机：** 按 executionId 请求取消并返回真实回执；dispatching 且无发出证据时只持久化 host 取消意图并返回 not_sent，不伪造 pending；只有存在 pending 在途输出才返回 cancel_requested，发出状态不明时返回 unknown；not_cancellable 仅用于 running/cancel_requested/unknown，queued 走本地 CAS、dispatching 无发送证据只登记 host 意图；not_found 不附造阶段或 receiptRevision，already_terminal 只报告真实终态；取消不收费、不重试。

**可用性与副作用：** `conditional` / `execution`；effect=`cancel`；approval=`none`；paid=`false`，mayCharge=`false`。Host-only：allowedTargetScopes, cancelOperationKey, defaultMessageTarget, resolvedTargetScope, userIntentRef.


**模型入参：** `executionId*`: string (min 1, max 200); `targetConversationId`: string (min 1, max 200); `targetCreationId`: string (min 1, max 200)。
**目标解析：** `targetConversationId` 与 `targetCreationId` 必须同时出现或同时省略；显式 pair 由 host 与冻结的 message/card `allowedTargetScopes` 成对匹配，缺省只取发送该消息时冻结的目标。

**Host 注入：** allowedTargetScopes, cancelOperationKey, defaultMessageTarget, resolvedTargetScope, userIntentRef。逐字段派生来源见 registry `fieldMappings.hostInjected`。

**业务结果：** `cancelDisposition*`: value ∈ {requested, already_terminal, not_cancellable, not_found}; `executionId*`: string (min 1, max 200); `executionStatus`: value ∈ {queued, dispatching, running, cancel_requested, completed, partial, error, cancelled, unknown, blocked, denied}; `providerCancellation*`: value ∈ {not_sent, requested, confirmed, unsupported, unknown}; `receiptRevision`: integer (min 0, max 2147483647)。

**错误与允许动作：** `invalid_arguments` → correct_arguments, select_supported_capability; `context_mismatch` → read_creation, reselect_target_creation; `not_found` → read_creation, check_execution_status; `invalid_state` → check_execution_status, continue_without_action。

**兼容边界：** `无等价旧 handler`；完整字段映射以 registry `fieldMappings` 为准。无单 execution 旧 handler；全局 abort/cancelAll 不能替代。远端确认前保留执行阶段或 unknown；本工具本身不调用收费服务；不改变已提交图像任务的既有费用状态。



### `propose_memory`

**职责与时机：** 仅将用户明确要求记住的内容写为待审核候选；不立刻进入有效记忆，拒绝凭据和一次性指令。

**可用性与副作用：** `conditional` / `memory`；effect=`memory_candidate_write`；approval=`existing_confirm_auto`；paid=`false`，mayCharge=`false`。Host-only：conversationId, operationKey.


**模型入参：** `trigger*`: string (min 1, max 200); `title`: string (max 200); `category`: value ∈ {characterName, characterFeature, style, other, fact, preference, observation, decision}; `content*`: string (min 1, max 8000); `scope`: value ∈ {global, conversation}。

**Host 注入：** conversationId, operationKey。逐字段派生来源见 registry `fieldMappings.hostInjected`。

**业务结果：** `candidateStatus*`: value ∈ {pending, invalid}; `candidateId`: string (min 1, max 200) | null; `category`: value ∈ {characterName, characterFeature, style, other, fact, preference, observation, decision}; `scope*`: value ∈ {global, conversation}。

**错误与允许动作：** `invalid_arguments` → correct_arguments, select_supported_capability; `user_denied` → continue_without_action。

**兼容边界：** `langbai_memory_upsert`；完整字段映射以 registry `fieldMappings` 为准。显式 category→type 映射，保留 global/conversation scope。



### `delete_memory_candidate`

**职责与时机：** 删除用户明确指定的待审核记忆候选；不可删除已审核记忆。

**可用性与副作用：** `conditional` / `memory`；effect=`memory_candidate_delete`；approval=`existing_confirm_auto`；paid=`false`，mayCharge=`false`。Host-only：conversationId, operationKey.


**模型入参：** `candidateId*`: string (min 1, max 200)。

**Host 注入：** conversationId, operationKey。逐字段派生来源见 registry `fieldMappings.hostInjected`。

**业务结果：** `deleteStatus*`: value ∈ {deleted, not_found, invalid}; `candidateId*`: string (min 1, max 200); `scope*`: value ∈ {global, conversation}。

**错误与允许动作：** `invalid_arguments` → correct_arguments, select_supported_capability; `not_found` → continue_without_action; `user_denied` → continue_without_action。

**兼容边界：** `langbai_memory_delete`；完整字段映射以 registry `fieldMappings` 为准。只调用待审核候选删除路径。



### `patch_creation_inputs`

授权判定：`role=reference` 是分类，不等于用户同意参与生成。保留 `includeInGeneration=true` 必须在当前 `expectedInputRevision` 上同时匹配目标、attachmentId/revision、role 和 `referencePurpose`，且对应修订的授权记录仍有效、未撤销。旧用途授权不延伸到新用途；用途变化默认设为 false，只有同一 `userIntentRef` 可追溯到用户对确切附件、目标和新用途的明确 opt-in 时才允许 true。host 证据记录来源事件、输入修订、用途与授权 scope；这些合成 host-context fixtures 检查规则分支，但不证明事件或授权真实。

**职责与时机：** 按 inputRevision 原子修改指定 creation 的来源状态；role=reference 时设置 referencePurpose，discussion 不带 purpose 且 includeInGeneration=false；includeInGeneration=true 仅在保留同目标、同绑定、同角色且未撤销的既有授权，或同一用户意图明确授权确切参考参与生成时允许；清除 edit source 会同时移除依赖蒙版并返回可撤销完整变更集。

**可用性与副作用：** `conditional` / `creation_inputs`；effect=`creation_input_write`；approval=`none`；paid=`false`，mayCharge=`false`。Host-only：allowedTargetScopes, currentInputSnapshot, defaultMessageTarget, operationKey, resolvedTargetScope, turnEffectiveInputSnapshot, userIntentRef.


**模型入参：** `expectedInputRevision*`: integer (min 0, max 2147483647); `action*`: value ∈ {clear_edit_source, set_reference_usage}; `expectedAttachmentId`: string (min 1, max 200); `attachmentId`: string (min 1, max 200); `attachmentRevision`: string (min 1, max 128); `role`: value ∈ {reference, discussion}; `includeInGeneration`: boolean; `targetConversationId`: string (min 1, max 200); `targetCreationId`: string (min 1, max 200); `referencePurpose`: value ∈ {color, composition, character, atmosphere}。
**目标解析：** `targetConversationId` 与 `targetCreationId` 必须同时出现或同时省略；显式 pair 由 host 与冻结的 message/card `allowedTargetScopes` 成对匹配，缺省只取发送该消息时冻结的目标。

**Host 注入：** allowedTargetScopes, currentInputSnapshot, defaultMessageTarget, operationKey, resolvedTargetScope, turnEffectiveInputSnapshot, userIntentRef。逐字段派生来源见 registry `fieldMappings.hostInjected`。

**业务结果：** `inputStatus*`: value ∈ {applied, unchanged, conflict, not_found, invalid}; `actionId*`: string (min 1, max 200) | null; `inputRevision*`: integer (min 0, max 2147483647) | null; `undo*`: object | null; `beforeRefs*`: array<object> ≤32; `afterRefs*`: array<object> ≤32。

**错误与允许动作：** `invalid_arguments` → correct_arguments, select_supported_capability; `context_mismatch` → read_creation, reselect_target_creation; `stale_revision` → read_creation, request_user_decision; `not_found` → read_creation, refresh_attachment。

**兼容边界：** `无等价旧 handler`；完整字段映射以 registry `fieldMappings` 为准。仅这两个窄命令；不会物理删除附件或修改发送/批准快照。清源时 expectedAttachmentId 可阻止串源；undo 由 UI 用 CAS 回写，不另增模型工具；clear_edit_source 会由 host 原子移除 edit source 及依赖蒙版；回执 beforeRefs/afterRefs 与 restoreRefs 表示完整变更集，UI 撤销按 returned inputRevision CAS。



## 3. 关键条件 schema 与示例

### 建立与修订方案

新建方案只传 `positivePrompt`（其他可选字段按需给出），不可传一半修订定位。修订已有方案必须同时传 `proposalId` 和整数 `baseRevision`；CAS 过期返回 `stale_revision`，先 `read_creation/read_proposal` 得到实际版本，再由用户意图决定是否重提。`propose_prompt` 只改变对话内 PromptProposal，不更新工作台 draft，也不提交图像任务。

```json
{"positivePrompt":"a paper crane courier under warm lantern light","negativePrompt":"blurry, malformed hands","changeSummary":"把背景换成雨夜街巷"}
```

```json
{"proposalId":"proposal_7","baseRevision":3,"positivePrompt":"a paper crane courier under warm lantern light","changeSummary":"雨夜背景，人物和服装保持"}
```

### 入队与执行查询

模型先使用 `prepare_generation`：`proposalId+revision` 与直接 `positivePrompt` 二选一。准备返回锁定的 `inputFingerprint`、`inputRevision` 和实际预览；原生默认值、用户设置、account/provider binding 与 source attachments 在确认前解析并冻结。确认后 `generate_image({"preparationId":"..."})` 建 durable execution，回 `status=accepted` 和 `executionId`。`executionStatus=queued` 是入队态。之后由持久 receipt/事件更新任务；禁止把 accepted 解释成图片完成。 `requestedSeedPolicy/requestedSeed` 记录任务请求；准备阶段的 `resolvedSeed` 必须为 null。每张 completed output 独立返回 `resolvedSeed/resolvedSeedSource`（来源只能是 provider receipt 或 verified embedded metadata；无法核验时两者为 null），不能把一次预览值套用到 count>1 的所有图。

`get_execution({"executionId":"..."})` 的示例展示工具查询完成但图仍运行；请求 seed 与每张输出的实际 seed 分开：

```json
{"resultKind":"business","status":"completed","conversationId":"chat_1","creationId":"creation_1","data":{"readStatus":"ok","executionId":"exec_1","executionStatus":"running","expectedOutputCount":1,"requestGranularity":"per_output","outputs":[{"outputIndex":0,"status":"pending"}],"receiptRevision":2,"providerReceiptStatus":"pending","requestedSeedPolicy":"random","requestedSeed":null}}
```

### 改图、来源和讨论图

`redraw_image` 锁定源图身份、提示词和参数；`inpaint_image` 还要求同 creation 的 mask。host 在授权前冻结来源图、参数、输入 revision 和服务账号引用，内部 preview 与生图相同。兼容图像 provider 当前只支持文生图；所有不支持的编辑要返回 `capability_unavailable/service_unsupported`，不可静默转 NovelAI。

`prepare_generation` 的 `vibeReferences/preciseReferences/characterPrompts` 只接受可用、属于当前 `conversationId/creationId` 且 role 符合的附件。discussion 必须 `includeInGeneration=false`；把它直接当生成引用属于输入错误。要从聊天同步用途变化，唯一模型工具是 `patch_creation_inputs`，只支持两种动作：

```json
{"expectedInputRevision":8,"action":"set_reference_usage","attachmentId":"att_ref","attachmentRevision":"rev_3","role":"discussion","includeInGeneration":false}
```

```json
{"expectedInputRevision":8,"action":"clear_edit_source","expectedAttachmentId":"att_old"}
```

```json
{"expectedInputRevision":9,"action":"set_reference_usage","attachmentId":"att_ref","attachmentRevision":"rev_3","role":"reference","referencePurpose":"composition","includeInGeneration":true}
```

该请求样例仅展示合法字段结构，不代表获得授权。`includeInGeneration=true` 只有在同版本已有未撤销授权或同一用户指令明确允许该确切参考参与生成时才能执行；单独修改用途不能授权。

当 `role=reference` 时必须给 `referencePurpose`（color/composition/character/atmosphere）；discussion 不带 purpose 且 `includeInGeneration=false`。`includeInGeneration=true` 是状态请求，不构成授权：host 仅在 expectedInputRevision 上同目标、同 attachmentId/revision、同 role 已有仍有效且未撤销的生成授权时保留；否则需要同一 `userIntentRef` 追溯到用户对这一确切参考明确要求参与生成的原始事件。host 记录该事件、解析目标、用途和授权 scope；只改 purpose 不授权，role 改动默认 false，除非同一明确指令 opt-in。模型没有 permission 字段，输入/结果 schema 和静态语义样例都不能验证真实用户意图或事件来源。`read_creation` 与准备预览里的有效绑定使用相同字段；before/after/restoreRefs 保留原用途，避免撤销丢失信息。同步操作以 inputRevision 做 CAS，按当前 conversation/creation 校验附件并返回前后绑定、actionId 和 UI 可用的 CAS undo 信息。它不物理删除作品、不修改历史消息、不回写已发送或已批准快照。相同 operationKey 重放先返回原回执；UI 撤销走同命令 CAS，不暴露通用模型 undo。

### 审批取消与 unknown

待审批 call 保持原 tool call 等待态；用户拒绝后一次性返回 `denied/cancelled`，worker 零提交。用户明确点了已选中任务的“取消”时，`cancel_execution` 免二次确认（`approval=none`），仍核对用户意图、任务归属和阶段。`not_found` 只返回请求的 executionId 与 `providerCancellation=not_sent`，不附造 `executionStatus` 或 `receiptRevision`；`already_terminal` 只能回报真实终态并带回执版本。`requested` 带当前回执版本：排队期间本地抢取消成功可回 `cancelled/not_sent`；dispatcher 已领取但无发出证据时保留 `dispatching/not_sent` 并由 host 持久取消意图、发送前检查，实际有 pending 在途输出后才投影 `cancel_requested`；发出状态无法确认时回 `unknown`。取消只请求停止，不删结果、不重试；若服务无法确认，则 `executionStatus=unknown` 并阻止相关付费队列自动前进。恢复只能基于持久回执；unknown 不可自动重新发起，用户可核实状态或显式处理其他无关队列条目。

## 4. 旧代码核验与需要新建的 host 能力

以下是当前源代码事实，用于限定兼容 adapter；目标合同是设计提案，不声称旧调用已经具备这些能力。

| 当前源码 | 已核验事实 | 新合同的处理 |
| --- | --- | --- |
| `desktop/electron/ipc/pi-studio-tool-schema.ts:9-51` | Pi 参数 schema 是 `{args:{...}}` 内部字段；refs 元素 `additionalProperties:true`；旧 schema 含 `scale`/`qualityToggle`、画廊枚举超出实际 handler 等偏差。 | 对模型暴露平铺 schema；对象递归关闭额外字段；把无 handler 支持的字段拒绝，不静默接受。 |
| `desktop/src/agent/generation-input.ts:102-186` | 生成参数 parser 会在 width/height=2048、CFG=10 等边界 clamp/default，并按当前 model 校验 Vibe/precise/character references。 | 新 host 根据能力 catalog 做严格校验并把有效解析结果写入 preview/fingerprint；拒绝未支持选项，不用 parser fallback 偷换用户意图。 |
| `desktop/electron/ipc/agent-tools.ts:372-453, 426-478` | Gallery handler 只接受 danbooru/safebooru/gelbooru/quicktag，其它 source fallback 到 danbooru；`safeOnly` 有 handler 支持但旧 Pi schema 漏掉。prompt presets 实际只有 all/positive/style；reference presets handler 支持 group/kind/limit，但旧 schema 漏 group/limit。 | `search_gallery` 限定真实四个 source，显式传 safeOnly；不合法 source 拒绝。提示词 preset 不开放 negative；参考 preset 补齐旧 handler 已支持过滤字段。 |
| `desktop/electron/ipc/agent-image-provider.ts:10-46` | 兼容图像 provider 标示 capabilities=`text-to-image`，输入只接受 `positivePrompt/count/model`，非文生图操作被阻断且不 fallback 到 NovelAI。 | 能力 catalog 把图像编辑设为 unavailable；动态投影不删参数后继续。 |
| `desktop/electron/ipc/agent-template-tools.ts:4-25` | 模板写操作在授权前/异步备份后重复核对 revision，再备份，最后才写；restore 是内部 `body:''+restoreDefault:true` 适配。 | `manage_prompt_templates` 以 `templateRevision` 做 host CAS；action=read/select 不审批，save/restore 按现有 confirm/auto，模型不直接提交内部 restoreDefault 字段。 |
| `desktop/electron/ipc/pi-studio-tools.ts:130-309` | 当前准备和付费执行链为同步 handler；未有目标合同中的 durable ExecutionService accepted/receipt 生命周期。 | 必须加 host ExecutionService、持久队列、submissionKey、回执恢复与 unknown 护栏；不能只把旧同步 handler 的返回包装成 accepted。 |

## 5. 目录与样例验证边界

在此设计目录运行 `python -B validate_registry.py` 验证 36 项工具 schema、字段隔离、发现组映射、共享 host context、结果判别、36×4 基础 fixture 覆盖与执行语义。本轮有 239 个 JSON Schema fixtures、50 个 execution semantic cases、11 种 executionStatus 各有正例和命中对应状态分支的反例；另有四种 cancelDisposition 分支配对样例与 8 个 synthetic reference authorization host-context cases。fixture 使用固定设计样例，只验证 schema/合同分支；host-context 用例不证明用户事件或授权的真实性。不证明产品 handler 零副作用、服务存在、定价正确、模型遵循、回执真实或产品已实现。最终覆盖与限制见 [source/r4-final-contract-audit.md](source/r4-final-contract-audit.md)，反例前后 envelope 见 [schema-fixtures/counterexamples-r3.json](schema-fixtures/counterexamples-r3.json)。`providerProjection.status=not_implemented` 是当前明确缺口。当前 Electron 源码审查只覆盖表中限定文件与行段，其他边界需进入实现时再核验。


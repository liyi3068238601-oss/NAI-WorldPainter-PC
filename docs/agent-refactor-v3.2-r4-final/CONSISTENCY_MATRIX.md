# 工具、提示词、界面一致性表 · v3.2 R4 Final

本表是设计合同的交叉索引，不是端到端通过证明。机器结构以 tool-registry.json 为准；持久化与竞争语义以 TOOLS_AND_FLOWS 为准。真实接线、模型遵循与远端服务另行验收。

| 行为 | 工具 / host 责任 | 系统提示词 | 界面表现 | 检查层 |
| --- | --- | --- | --- | --- |
| 普通创作讨论 | 无必需工具 | 不强制调用/生图 | 正常对话 | 真实模型待验 |
| 工具发现闭环 | always_on get_capabilities、统一groupCatalog | 仅按下一步骤实际挂载名调用 | 缺能力说明原因 | schema/catalog静态 + host待验 |
| 输入前置失败 | resultKind=preflight_failure，无data | 不造ID或业务内容 | 显示缺项而非假任务 | 36工具fixture + handler待验 |
| 同轮先改再生成 | authorizedPatchReceiptChain推进effectiveSnapshotRef | 原消息不变，仅成功授权patch派生 | 新预览排除已移除输入 | 原型演示 + T23/T28待验 |
| 五类图像提交 | 统一ExecutionSubmissionContext | 不把权限字段交给模型 | 相同预览与确认边界 | 静态引用/声明 + host待验 |
| 生成方案 | propose_prompt 只创建版本 | 不声称已选择/已应用 | 候选方案卡 | schema + host 待验 |
| 设为当前方案 | set_current_proposal，CAS/replay | 唯一明确直接执行，歧义问 | 当前方案与可撤销回执 | 原型 + host 待验 |
| 工作台写入 | read_generation_state → apply_prompt CAS | 刷新不授权覆盖 | 差异预览，冲突保留 | schema + host 待验 |
| 任意版本生成 | prepare → immutable snapshot → submit | 不要求先采纳/应用 | 用此版本生成 → 预览 | 原型 + host 待验 |
| 改图源生命周期 | 仅明确移除/换图或继续修改动作改 source binding；生成结果独立登记 | 普通聊天、入队、完成不清源或自动切换到新结果 | 原 source ID/hash 保持；明确继续修改后才绑定所选结果 | U03 待验 |
| 源图移除 | patch_creation_inputs / 同一 UI command | 不补回历史旧源 | 胶囊/右栏/新预览一起清除 | 原型 + U03/U07/T23/T28 |
| 参考仅讨论与 opt-in | role/include 配对；host 以原用户事件、同 userIntentRef、确切目标、附件/修订、role、referencePurpose 和 scope 验证 | `role=reference` 只是类别；不用用途变化或模型参数推导授权 | 只有同一授权范围可保留 true；用途或 role 变化默认不参与，同一明确指令 opt-in 新范围后才勾选 | 原型 + U04/T28 待验 |
| 撤销输入更改 | inputRevision CAS，原绑定有效性 | 不编造撤销完成 | 冲突不覆盖后续选择 | U07/T28 待验 |
| 异步预览变化 | 目标/修订/指纹双重检查 | 旧批准不扩展 | 失效提示、禁用确认、重新预览 | 预览竞争原型 + host待验 |
| 执行配置冻结 | 同轮操作取消息发送时 conversationConfig；卡片操作在预览打开时固定；不可用则阻断 | 当前配置不倒灌已发送操作；currentPlanRef 不进显式旧版本输入 fingerprint | 显示固定模型/预设并保留在任务详情 | U05/T28 待验 |
| 预览时间线 | 入队前依赖输入变化拒绝；入队后快照不变 | 不扩展旧批准 | 失效入口与原任务清楚分开 | U05 三子场景待验 |
| 异步右栏刷新 | 按 section/binding 保留局部状态 | 不重复播报用途 | 保持展开/滚动/栏内焦点，不抢输入 | R4 原型浏览器证据，非 host；产品项 pending |
| 演示队列暂停 | 持有者逐项释放，独立 gate 保留 | 不把演示状态当服务事实 | 最后持有者取消后可推进 | R4 原型浏览器证据，非 host；产品项 pending |
| 查看器首尾 | 禁用按钮不能接收恢复焦点 | 无附加模型调用 | 可用导航→范围→标题 | R4 原型浏览器证据，非 host；产品项 pending |
| 图片与参考绑定 | 资产独立于role/purpose/include | 不凭选中作品猜用途 | 参考查看器显示真实用途 | 参考绑定原型 |
| 生成第二张再改 | output attachment mapping | 使用稳定 ID，不猜索引 | viewer 当前图明确绑定 | 原型 + T07 |
| 不支持的参数 | 能力投影和 adapter 拒绝 | 不静默删参数/换渠道 | 具体阻断原因 | T02/T25/T27 待验 |
| 查询成功 | query result 与 executionStatus 分离 | 不声称图像完成 | 任务仍可运行/未知 | T06 待验 |
| 聚合状态 | 完整槽位、unknown/在途优先、穷尽状态；blockedReason独立于整体状态 | 不把未返回判为未发送 | 已有图保留、逐项状态可见 | schema语义检查 + host待验 |
| 反推输出 | 成功candidateText/uncertainty，失败partialText | 未完成片段不冒充成功 | 失败/待核实清楚标识 | schema fixture + service待验 |
| 取消已完成 | already_terminal + 原终态 | 已完成、未取消 | 保留作品 | host 待验 |
| 取消与领取竞争 | 原子 queued CAS | cancel_requested 不等于取消 | 已请求/未支持/真实终态 | T11/T12 待验 |
| 重启 | 恢复 gate，queued 默认暂停 | 不自动重发 | 继续队列；可能已发先核实 | T13 待验 |
| 后台失败 | 持久 turn/batch gate | 不换 preparation 绕过 | 后续受阻与已有图保留 | T14–T16 待验 |
| 文字排队与取消恢复 | submit order + 前驱因果闭包；cancel messageId/draftRevision CAS | 不包含更晚用户消息 | 排队取消只在草稿版本未变时恢复；新草稿不被覆盖 | 原型 + T17/T19 |
| 引导 | 持久 messageId + 单次消费 | 安全节点改变后续内容 | 等待生效/已接收 | 原型 + T18–T20 |
| 助手预设开关与默认 | `assistantPresetBinding={presetId,enabled}`；新会话默认独立保存相同结构；旧字段版本化迁移 | 关闭保留选中项但跳过其正文，基础规则不关闭 | 工具栏可开关，预设面板设默认；共享编辑显示关闭中的引用 | 原型 + PRESET_COMPATIBILITY 待验 |
| 共享预设更新 | 发送/执行时冻结 preset ID、enabled、body、revision/hash | 引导不热换预设 | 轻提示，消息详情可查 | 原型局部 + host 待验 |
| 自动点评 | batch 唯一键 + 同会话串行器；继承 origin execution 对话模型/预设快照 | 有像素才看图，不读取当前配置；failure/unknown gate 阻止自动付费点评 | gate 阻断时保留 pending 并显示已有作品；一次简评、建议可选 | T24 待验 |
| 种子 | resolvedSeed + evidence source | 不用 requestedSeed 冒充 | 当前图片实际值或未返回 | 原型fixture + host 待验 |
| 下载 | 原附件 bytes/hash/MIME | 不声称截图是原图 | 本地示例与真实原图清楚区分 | 原型 + U06 |
| 旧历史 | 保存原始版本，仅惰性投影 | 不把旧名文本当执行授权 | 残缺记录明确标注 | T21 待验 |

发现不一致时先修权威合同与状态机，再同步提示词和显示；不能只改文案掩盖副作用。界面中的按钮可操作、schema 样例通过，均不能证明真实生成、扣费、远端取消或重启恢复正确。实际执行证据以 VERIFICATION 为准；完整产品用例见 ACCEPTANCE_MATRIX。


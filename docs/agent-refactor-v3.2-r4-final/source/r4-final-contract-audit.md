# R4 Final 工具合同与静态校验审查

审查目录：`agent-refactor-v3.2-r4-final`。范围为 36 工具 registry、schema、validator、语义 fixtures 与合同摘要。此交付仅调整设计合同，没有运行产品 handler、访问网络服务或调用收费 API。

## 合同收敛

- `registryVersion` 与全部工具 `schemaVersion` 保留 `2.0.0`，作为未接线设计快照沿用版本号。没有新增或删除模型/结果字段，但 R4 收紧了 `cancel_execution` 的条件分支、执行结果的可接受组合，并给既有 `blockedReason` 增加 `prior_paid_failure`；不能描述为 schema 完全未变。实际接线前必须评估枚举扩展和分支收紧的兼容性。
- `dispatching` 的 per-output 先前输出仅允许 `completed`，其余槽位保持 `not_dispatched`；已有 `failed` 或 `cancelled` 时不得再 claim 后续输出。持久 dispatcher claim、恢复检查和不重发仍是 host 行为要求，输出字段和离线 validator 不能证明其真实性。
- 任一状态下 `failed` 输出都必须有 `provider_error` 或 `attachment_unavailable`。`provider_unknown` 只属于 `unknown` 输出证据。已知失败与在途输出同在时保留 `running/cancel_requested`，并要求当前 gate `blockedReason=prior_paid_failure`；不能用 `unknown_prior_receipt` 表示已知失败。
- `completed`、`partial` 和 `error` 都要求 `providerReceiptStatus=confirmed`。`not_applicable` 代表没有 provider 请求，仍用于 queued、blocked、denied 和本地排队取消等零派发情形，不能与完成或部分成功结果共存。
- `cancel_execution.not_cancellable` 仅允许 `running`、`cancel_requested`、`unknown`；queued 通过本地 CAS 取消，dispatching 尚无发送证据时只登记 host 取消意图并保持 `not_sent`。四种 cancelDisposition 都有可接受正例和针对错误阶段/回执配对的拒绝例；`already_terminal+unknown` 明确拒绝，`requested+cancelled` 仅接受 `not_sent/confirmed`。
- `patch_creation_inputs` 中 `includeInGeneration=true` 是状态请求，不是授权。host 仅可在当前 expectedInputRevision 上，保留目标、attachmentId/revision、role=reference 与 referencePurpose 全部相同且仍有效、未撤销的授权；旧用途授权不延伸到新用途。新用途要求同一 `userIntentRef` 可追溯到针对确切参考、目标、用途和授权 scope 的明确用户 opt-in。`role=reference` 只是分类。没有增加模型可伪造的 permission 字段。

## 覆盖与验证

- `cancel_execution.not_cancellable` 的 `providerCancellation` 限定为 `unsupported/unknown`；合法 `running+not_sent` 反例专门命中该条件分支并被 schema 拒绝。

- Registry 保持 36 工具、23 个 discovery groups；summary generator 保留 `get_capabilities` 单次最多 10 组和完整目录 23 组的区分。36 工具的五类派生合同摘要由 registry 生成并检查。
- `schema-fixtures/fixtures.json` 有 239 个 JSON Schema fixture、50 个 execution semantic cases。11 个 `executionStatus` 均有 schema-valid 正例和由对应状态分支拒绝的 schema-valid 反例；原 R3 附件中的 3 个 error/blocked/denied 实例逐字保留并继续被语义函数拒绝。
- cancel result 分支映射覆盖：requested 9 正/5 反，already_terminal 6 正/2 反，not_cancellable 3 正/5 反，not_found 1 正/1 反。另有 8 个仅用于离线规则演练的合成 host-context reference authorization cases；它们不是产品结果字段或真实授权证据。
- `python -B sync_tool_summaries.py --write`：36 工具摘要生成完成，1 行更新。
- `python -B validate_registry.py`：通过，输出 36 tools、239 JSON Schema fixtures、50 semantic cases、11 个状态分支正反覆盖、3 个原始 R3 反例、8 个旧/新反例和 Draft 2020-12 host schemas。
- `python -B sync_tool_summaries.py --check`：通过，36 工具的五类派生摘要全部匹配。

## 尚待 host 验证的边界

离线合同不能证明 dispatcher claim、取消意图、失败 gate、授权拒绝决定或 user event 的真实持久化；也不能证明用户原始文本确实明确 opt-in、provider 是否实际收费或 receipt 是否可信。新增 reference case 只把合成 host evidence 与合同规则做一致性检查；真实 host 仍需事件来源、目标、附件身份、用途、授权范围与撤销状态的审计测试。

`TOOLS_AND_FLOWS.md` 与 `schema-fixtures/COVERAGE.md` 已同步本轮规则。`source/r4-verification.md` 为未改写的原 R4 历史记录，本轮验证见根目录 `VERIFICATION.md`。

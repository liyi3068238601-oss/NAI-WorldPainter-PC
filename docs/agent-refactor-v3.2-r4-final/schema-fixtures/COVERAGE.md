# R4 Schema Fixture 覆盖表

覆盖 `36/36` 项工具；每项都提供最小合法输入、非法/边界输入、正常业务结果、前置错误结果。共 239 个 JSON Schema fixtures 与 50 个跨字段执行语义案例（包含 11 种 executionStatus 各自的合法和状态分支拒绝例），另有 8 个旧/新反例。registryVersion 和每条 fixture 的 schemaVersion 均固定为 `2.0.0`。R4 未增删字段，但收紧 `cancel_execution` 条件分支；此版本号仅沿用未接线设计快照，集成时需重评兼容性。所有 ID、内容均为固定设计样例。

| 工具 | 最小合法输入 | 非法边界 | 正常业务结果 | 前置错误结果 |
|---|---|---|---|---|
| `get_capabilities` | `coverage-get_capabilities-input-min-valid` | `coverage-get_capabilities-input-invalid-boundary` | `coverage-get_capabilities-business-result-valid` | `coverage-get_capabilities-preflight-error-valid` |
| `read_generation_state` | `coverage-read_generation_state-input-min-valid` | `coverage-read_generation_state-input-invalid-boundary` | `coverage-read_generation_state-business-result-valid` | `coverage-read_generation_state-preflight-error-valid` |
| `list_history` | `coverage-list_history-input-min-valid` | `coverage-list_history-input-invalid-boundary` | `coverage-list_history-business-result-valid` | `coverage-list_history-preflight-error-valid` |
| `search_tags` | `coverage-search_tags-input-min-valid` | `coverage-search_tags-input-invalid-boundary` | `coverage-search_tags-business-result-valid` | `coverage-search_tags-preflight-error-valid` |
| `search_artists` | `coverage-search_artists-input-min-valid` | `coverage-search_artists-input-invalid-boundary` | `coverage-search_artists-business-result-valid` | `coverage-search_artists-preflight-error-valid` |
| `search_gallery` | `coverage-search_gallery-input-min-valid` | `coverage-search_gallery-input-invalid-boundary` | `coverage-search_gallery-business-result-valid` | `coverage-search_gallery-preflight-error-valid` |
| `search_web` | `coverage-search_web-input-min-valid` | `coverage-search_web-input-invalid-boundary` | `coverage-search_web-business-result-valid` | `coverage-search_web-preflight-error-valid` |
| `search_prompt_presets` | `coverage-search_prompt_presets-input-min-valid` | `coverage-search_prompt_presets-input-invalid-boundary` | `coverage-search_prompt_presets-business-result-valid` | `coverage-search_prompt_presets-preflight-error-valid` |
| `search_reference_presets` | `coverage-search_reference_presets-input-min-valid` | `coverage-search_reference_presets-input-invalid-boundary` | `coverage-search_reference_presets-business-result-valid` | `coverage-search_reference_presets-preflight-error-valid` |
| `read_image_metadata` | `coverage-read_image_metadata-input-min-valid` | `coverage-read_image_metadata-input-invalid-boundary` | `coverage-read_image_metadata-business-result-valid` | `coverage-read_image_metadata-preflight-error-valid` |
| `search_memories` | `coverage-search_memories-input-min-valid` | `coverage-search_memories-input-invalid-boundary` | `coverage-search_memories-business-result-valid` | `coverage-search_memories-preflight-error-valid` |
| `read_skill` | `coverage-read_skill-input-min-valid` | `coverage-read_skill-input-invalid-boundary` | `coverage-read_skill-business-result-valid` | `coverage-read_skill-preflight-error-valid` |
| `read_prompting_reference` | `coverage-read_prompting_reference-input-min-valid` | `coverage-read_prompting_reference-input-invalid-boundary` | `coverage-read_prompting_reference-business-result-valid` | `coverage-read_prompting_reference-preflight-error-valid` |
| `ask_user` | `coverage-ask_user-input-min-valid` | `coverage-ask_user-input-invalid-boundary` | `coverage-ask_user-business-result-valid` | `coverage-ask_user-preflight-error-valid` |
| `get_execution` | `coverage-get_execution-input-min-valid` | `coverage-get_execution-input-invalid-boundary` | `coverage-get_execution-business-result-valid` | `coverage-get_execution-preflight-error-valid` |
| `propose_prompt` | `coverage-propose_prompt-input-min-valid` | `coverage-propose_prompt-input-invalid-boundary` | `coverage-propose_prompt-business-result-valid` | `coverage-propose_prompt-preflight-error-valid` |
| `read_creation` | `coverage-read_creation-input-min-valid` | `coverage-read_creation-input-invalid-boundary` | `coverage-read_creation-business-result-valid` | `coverage-read_creation-preflight-error-valid` |
| `read_proposal` | `coverage-read_proposal-input-min-valid` | `coverage-read_proposal-input-invalid-boundary` | `coverage-read_proposal-business-result-valid` | `coverage-read_proposal-preflight-error-valid` |
| `set_current_proposal` | `coverage-set_current_proposal-input-min-valid` | `coverage-set_current_proposal-input-invalid-boundary` | `coverage-set_current_proposal-business-result-valid` | `coverage-set_current_proposal-preflight-error-valid` |
| `apply_prompt` | `coverage-apply_prompt-input-min-valid` | `coverage-apply_prompt-input-invalid-boundary` | `coverage-apply_prompt-business-result-valid` | `coverage-apply_prompt-preflight-error-valid` |
| `save_prompt_preset` | `coverage-save_prompt_preset-input-min-valid` | `coverage-save_prompt_preset-input-invalid-boundary` | `coverage-save_prompt_preset-business-result-valid` | `coverage-save_prompt_preset-preflight-error-valid` |
| `read_prompt_template` | `coverage-read_prompt_template-input-min-valid` | `coverage-read_prompt_template-input-invalid-boundary` | `coverage-read_prompt_template-business-result-valid` | `coverage-read_prompt_template-preflight-error-valid` |
| `manage_prompt_templates` | `coverage-manage_prompt_templates-input-min-valid` | `coverage-manage_prompt_templates-input-invalid-boundary` | `coverage-manage_prompt_templates-business-result-valid` | `coverage-manage_prompt_templates-preflight-error-valid` |
| `convert_prompt` | `coverage-convert_prompt-input-min-valid` | `coverage-convert_prompt-input-invalid-boundary` | `coverage-convert_prompt-business-result-valid` | `coverage-convert_prompt-preflight-error-valid` |
| `edit_prompt` | `coverage-edit_prompt-input-min-valid` | `coverage-edit_prompt-input-invalid-boundary` | `coverage-edit_prompt-business-result-valid` | `coverage-edit_prompt-preflight-error-valid` |
| `reverse_prompt` | `coverage-reverse_prompt-input-min-valid` | `coverage-reverse_prompt-input-invalid-boundary` | `coverage-reverse_prompt-business-result-valid` | `coverage-reverse_prompt-preflight-error-valid` |
| `prepare_generation` | `coverage-prepare_generation-input-min-valid` | `coverage-prepare_generation-input-invalid-boundary` | `coverage-prepare_generation-business-result-valid` | `coverage-prepare_generation-preflight-error-valid` |
| `generate_image` | `coverage-generate_image-input-min-valid` | `coverage-generate_image-input-invalid-boundary` | `coverage-generate_image-business-result-valid` | `coverage-generate_image-preflight-error-valid` |
| `redraw_image` | `coverage-redraw_image-input-min-valid` | `coverage-redraw_image-input-invalid-boundary` | `coverage-redraw_image-business-result-valid` | `coverage-redraw_image-preflight-error-valid` |
| `inpaint_image` | `coverage-inpaint_image-input-min-valid` | `coverage-inpaint_image-input-invalid-boundary` | `coverage-inpaint_image-business-result-valid` | `coverage-inpaint_image-preflight-error-valid` |
| `upscale_image` | `coverage-upscale_image-input-min-valid` | `coverage-upscale_image-input-invalid-boundary` | `coverage-upscale_image-business-result-valid` | `coverage-upscale_image-preflight-error-valid` |
| `process_image` | `coverage-process_image-input-min-valid` | `coverage-process_image-input-invalid-boundary` | `coverage-process_image-business-result-valid` | `coverage-process_image-preflight-error-valid` |
| `cancel_execution` | `coverage-cancel_execution-input-min-valid` | `coverage-cancel_execution-input-invalid-boundary` | `coverage-cancel_execution-business-result-valid` | `coverage-cancel_execution-preflight-error-valid` |
| `propose_memory` | `coverage-propose_memory-input-min-valid` | `coverage-propose_memory-input-invalid-boundary` | `coverage-propose_memory-business-result-valid` | `coverage-propose_memory-preflight-error-valid` |
| `delete_memory_candidate` | `coverage-delete_memory_candidate-input-min-valid` | `coverage-delete_memory_candidate-input-invalid-boundary` | `coverage-delete_memory_candidate-business-result-valid` | `coverage-delete_memory_candidate-preflight-error-valid` |
| `patch_creation_inputs` | `coverage-patch_creation_inputs-input-min-valid` | `coverage-patch_creation_inputs-input-invalid-boundary` | `coverage-patch_creation_inputs-business-result-valid` | `coverage-patch_creation_inputs-preflight-error-valid` |

## `cancel_execution` 与参考授权上下文

cancelDisposition 样例映射为：requested 9 正/5 反，already_terminal 6 正/2 反，not_cancellable 3 正/5 反，not_found 1 正/1 反。新增 `cancel-not-cancellable-running-not-sent-invalid` 在合法 `running` 阶段仅因 `providerCancellation=not_sent` 被条件 schema 拒绝；not_cancellable 的回执只能是 `unsupported/unknown`。

`referenceParticipationCases` 共 8 个合成 host-context 案例，分别覆盖当前 revision 上精确同用途授权的保留、用途变化无新授权的拒绝、同一 userIntentRef 对新用途明确 opt-in 的接受，以及目标/附件/角色/用途不匹配、撤销和过期 revision。`role=reference` 仅表示分类，不表示同意。

## `get_execution` 聚合状态语义覆盖

`semanticCases` 共 50 例。下表每个 public `executionStatus` 都有一个 schema-valid 合法正例和一个 schema-valid 反例；反例须由该状态自身的 `[status:<enum>]` 校验分支拒绝，validator 会比对拒绝规则标记，避免只因更早的通用规则失败而误报已覆盖。

| executionStatus | 合法正例 | 状态分支拒绝反例 |
|---|---|---|
| `queued` | `execution-queued-all-output-held` | `execution-queued-gate-needs-non-none-pause-invalid` |
| `dispatching` | `execution-dispatching-claim-valid` | `execution-dispatching-confirmed-without-prior-output-invalid` |
| `running` | `execution-running-pending-valid` | `execution-running-without-pending-invalid` |
| `cancel_requested` | `execution-cancel-requested-pending-valid` | `execution-cancel-requested-without-dispatched-pending-invalid` |
| `completed` | `execution-completed-all-output-valid` | `execution-completed-with-failed-output-invalid` |
| `partial` | `execution-partial-known-success-failure` | `execution-partial-without-success-invalid` |
| `error` | `execution-error-known-failure-valid` | `execution-error-cancellation-only-invalid` |
| `cancelled` | `execution-cancelled-local-queue-valid` | `execution-cancelled-without-cancelled-output-invalid` |
| `unknown` | `execution-unknown-priority-with-running-sibling` | `execution-unknown-without-unknown-evidence-invalid` |
| `blocked` | `execution-blocked-terminal-evidence-valid` | `execution-blocked-without-gate-evidence-invalid` |
| `denied` | `execution-denied-no-dispatch-valid` | `execution-denied-with-active-gate-invalid` |

原附件 `source/R3_新增聚合状态反例.json` 中 error/blocked/denied 三个对象均逐字保留在 `semanticCases`，作为额外反例；它们因共享 pending 优先规则而拒绝。另有 cancellation race 的 `dispatching + cancel intent + providerCancellation=not_sent` 合法例及伪造“已请求 provider 取消”的非法例。

状态约束中仍有两项只能作为 host 验收要求：结果字段不能证明 dispatcher claim 的持久化、恢复时不自动重发；`denied` 可表示全未派发和拒绝状态，但现有字段没有持久授权拒绝 receipt 引用，因此 validator 不能独立证明拒绝决定的来源或持久性。离线校验只覆盖结构与可表达的语义。

覆盖按各自 input/result schema 验证；`preflight_failure` 例子必须不带 `data`。跨输出数量、序号和聚合优先级在 `fixtures.json.semanticCases` 中单独验证，因为 JSON Schema 不能表达数组长度等于动态 `expectedOutputCount`。

这些是 schema 与设计合同的静态例子，不执行产品 handler，不证明模拟错误之后产品路径零副作用，不调用服务或付费 API。

本轮针对授权上下文的 10 例覆盖：同目标/附件/角色/用途且当前修订授权未撤销时保留；旧 grant 遇到用途变化且无新 opt-in 时拒绝；同一 userIntentRef 对新用途有明确 opt-in 时接受。`role=reference` 仅是分类。授权来源和事件真实性仍由 host 验证。

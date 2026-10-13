# 浪白 NovelAI Studio Agent 工具调用风险只读审计

## 范围与基线

本审计只读取源码、文档和已有测试，没有调用模型/生图服务，没有检查密钥或运行时环境变量，也没有修改参考克隆或产品实现代码；本次唯一写入是本审计文档。

- PC 基线：`E:\NAI-WorldPainter\PC端`，HEAD `d0449f6b2de063af0d4d0fddccd85d7b25dba562`。审计时分支为 `main...origin/main [ahead 1]`，工作区可见其他实现产生的未跟踪 `lib/assistant/` 和 `test/assistant/`；此报告只将 `agent_contract.dart` 当作接口证据，不将未提交实现视为固定基线。
- 浪白参考克隆：`E:\NAI-WorldPainter\PC端\.tmp\novelai-image-desktop`，HEAD `2d609393c3902874afae5200c26165d86b76055f`，审计时工作区干净。
- PC 计划将 AI 助手列为 M4 范围，且当前状态仍是“助手主体……仍待完成”；PC 应按手机功能矩阵逐项对齐，不因参考项目替换范围（`docs/PC_PLAN.md:34,74`；`AGENTS.md:6-10`）。

## 结论：有两个可定位的“没有工具被执行”路径，但没有证据锁定某次实际故障的根因

### 1. 默认 Pi Agent 路径允许模型不用工具，应用仍会把回复判为成功

Pi Agent 启动时把注册工具放进 Agent 初始状态，但调用 `agent.prompt` 时没有传入应用级的“此轮必须调用某工具”策略（`electron/ipc/pi-agent-core.ts:54-86,101-108`）。上层组装工具和调用参数时也没有设置 `toolChoice`（`electron/ipc/pi-agent-turn.ts:138-177`）。Gemini 适配器会根据库传来的 `options.toolChoice` 计算 function-calling 模式，但应用这层没有给用户选中的动作建立强制调用契约（`electron/ipc/pi-agent-provider.ts:160-176`）。

如果模型返回普通文本，Pi 核心会正常返回该文本；主进程随即把回复状态标为 `complete` 并返回 `ok: true`，没有检查“本轮要求的动作是否实际执行”（`electron/ipc/pi-agent-core.ts:109-123`；`electron/ipc/agent-runtime.ts:913-927`）。因此，若用户意图是必须搜索、读写模板或执行其他动作，单靠 system/user prompt 指示调用工具，存在模型直接回答、工具零调用但 UI 显示成功的路径。

这是代码可证明的设计风险，不是本次报告能够确认的用户现场根因。没有脱敏的请求/响应轨迹或 mock 复现，无法判断用户遇到的情况是模型选择、具体模型/网关兼容、工具不可用，还是运行时切到了另一条路径。

OpenAI 的 `auto` 允许模型零次或多次调用，`required` 才能要求至少一次调用；Gemini 的 `AUTO` 允许自然语言响应或调用工具，`ANY` 才会约束调用；Anthropic 的默认 `auto` 也允许直接回复。协议文档支持“不能把提供工具等同于强制调用”的判断，但不证明 Pi 依赖在所有适配器上的具体默认序列化行为：[OpenAI function calling](https://platform.openai.com/docs/guides/function-calling)、[Gemini function calling](https://ai.google.dev/gemini-api/docs/generate-content/function-calling)、[Anthropic tool use](https://docs.anthropic.com/en/docs/build-with-claude/tool-use)。

### 2. 环境开关可把所有普通 Agent 消息旁路到无工具 Tavern 路径

`sendAgentMessage` 默认走 Pi；只有 `LANGBAI_PI_AGENT === '0'` 时才走旧 Tavern 分支（`electron/ipc/agent-runtime.ts:961-963`）。Tavern 的 OpenAI Chat、Responses、Anthropic、Gemini 请求体均没有工具字段，例如 `openAiChat` 只组装模型、消息、流式与采样参数（`electron/ipc/agent-runtime.ts:306-325`），Responses/Anthropic/Gemini 请求分别在 `419-434`、`506-525`、`564-582`。该条件一旦成立，工具调用能力就不可能发生。

本审计没有读取该环境变量，也没有验证该分支在当前安装中是否启用；因此只把它列为可复现的条件路径，不断言它是当前配置。

### 3. 工具开关与动作文本存在契约不一致的风险

Pi 工具注册表默认把准备工具、所有只读工具和所有变更工具提供给模型；网页搜索开关会从注册表中移除 `langbai_search_web`（`electron/ipc/pi-studio-tools.ts:85-100`；`src/agent/workspace-controls.ts:22-28`）。而 composer action 转换器对 `web-search` 生成的只是“请调用 `langbai_search_web`”提示文本，不会直接分派工具（`src/agent/composer-actions.ts:49-67`）。因此如果某个动作数据仍被提交、但相应工具因开关而未注册，提示中要求的工具不可用，且当前 turn builder 没有显式拒绝该冲突。

同时，当前 `PiAgentPage.tsx` 读取、显示和移除 `draftActions`，但本快照中未发现 `stageStudioComposerAction` 的调用点（`src/PiAgentPage.tsx:88,173,208-211,383`；`src/agent/composer-actions.ts:37-46`）。所以不能把这项契约风险说成当前界面上用户一定能触发的操作；它适用于来自已缓存状态或未来接入的 action 数据。

## 可复用的成熟边界

浪白 Pi Agent 的执行与安全边界值得借鉴其设计，不应照搬 Electron 业务实现：

- **明确 allowlist 和 Schema**：从固定的 app tool 列表构建 JSON Schema 工具，并在执行前按同一注册表校验名称（`electron/ipc/agent-tools.ts:64-95`；`electron/ipc/pi-agent-core.ts:54-75,87-99`）。
- **将多轮执行限制为有界顺序循环**：工具串行执行；非全自动模式下设调用上限；未知工具、付费失败后的重复调用和未确认变更都会被阻止（`pi-agent-core.ts:65-99`）。
- **工具结果作为工具数据回传，并保留调用身份**：成功结果进入下一次模型输入；本地测试覆盖 Gemini 的 function call、Schema 和第二次请求包含工具结果（`pi-agent-provider.test.ts:153-170`），也覆盖工具输出以 `tool` 角色返回模型（`pi-agent-turn.test.ts:147-162`）。
- **先持久化结果收据，再继续模型轮次**：生成资产和输出先写入当前工具记录，后续 LLM 失败时也保留（`pi-agent-turn.ts:143-151,173-191`；运行时把历史收据明确标作“不是新的授权”）（`agent-runtime.ts:863-867,875-888`）。
- **审批和取消由应用持有**：变更工具走一次性审批，取消信号传到 Agent/工具；审批中取消不会执行待处理工具；付费请求不确定时保留收据并禁止静默重试（`agent-runtime.ts:890-910,928-958`；`pi-agent-approval.ts:3-38`；`agent-runtime-pi.test.ts:65-112,263-300`）。

PC 已有的 `lib/assistant/agent_contract.dart:121-129` 把 `toolChoice` 设为必传字段，并提供取消信号。建议保留这个显式边界：由每个 provider adapter 把它映射到受支持的请求格式，而不是在 transport 或 loop 中默认为 `auto`。

## 移植时应避开的缺陷与处理建议

- 不要把“工具 Schema 已发送给模型”记作“工具已执行”；工具调用数为零必须是独立、可观察的结果。
- 不要把所有对话统一设为 `required`。普通聊天、解释和上下文追问允许零工具；只有应用明确要求某项动作的 turn 才应携带 required/specific-tool 契约。若 provider 不支持该策略，应检测无调用并返回“动作未执行/需要重试”，不能落成成功。
- 不要只把 UI 快捷动作翻译成自然语言提示。将动作意图、允许工具子集、工具选择策略和完成判定结构化，并在发送前校验该工具存在且当前开关/能力允许。
- 不要让失败的 JSON 参数退化成空参数执行；Schema/JSON 解析错误应在工具调用边界失败关闭并原样回送错误。
- 不要复制移动端曾存在的“确认回调缺失时默认同意”模式；PC 的变更/付费工具需以应用层显式审批为准，审批关闭、取消、超时都不能执行。
- 不要把旧 Tavern 的无工具请求误当作 Agent provider 能力。保留该路由时，应在状态/日志中显式标识模式，且 UI 不得声称此轮可用工具。
- 不要把参考项目“工具列表很长”直接断言为根因。按当前任务选取少量相关工具值得测试，但工具数量导致不调用需要实测证据。

## 建议给 PC Agent 加的契约测试

建议用 mock transport 和确定性工具，不访问真实端点：

1. **模式与 payload 映射**：对 OpenAI Chat/Responses、Anthropic、Gemini 分别断言 `auto`、`required`、指定单工具时的请求体；不支持的选择应给明确错误，不能静默降级。
2. **必需动作无调用**：应用标记为必须执行动作时，模拟 provider 返回纯文本、空内容或结束但无 tool call；确认结果为未执行/失败状态，UI 不显示成功，且不调用任一工具。
3. **普通对话零调用**：普通问答在 `auto` 下返回自然语言，应成功结束且无副作用。
4. **动作与能力开关冲突**：提交 web-search 等显式动作，但工具被开关禁用时，发送前拒绝或显式降级为“无法执行”；不得把工具名只写进 prompt 后继续报成功。
5. **完整调用往返**：多条/多轮 tool call 保留稳定 ID、名称、参数；结果按 provider 需要的 role 与 call ID 回传；后续请求包含精确结果，再由模型结束。覆盖流式分片、并行/顺序约定、空参数和 malformed JSON。
6. **拒绝、未知工具、失败与取消**：未知名称、Schema 不匹配、工具失败、provider 中断、审批拒绝、审批期间取消以及工具运行期间取消均验证：未授权工具不会执行，已完成收据不丢，付费不确定操作不自动重发。
7. **成功状态不变量**：仅当普通对话正常结束，或必需动作已达到定义的完成条件时，assistant turn 才能标记 `complete`。

## 证据边界

此报告是源码和已有 mock 测试审计，不代表真实模型会稳定调用工具、真实网关支持指定的 `tool_choice`，或用户当前启用了某条特定配置。要定位某个现场请求，最小证据应是脱敏后的 provider 协议、脱敏请求体中的工具/选择字段、响应结束原因和该轮工具事件数；不得记录 API Key、Cookie 或提示词中的私密材料。

# 小助手 HTTP 接入与真实模型联调

日期：2026-10-14。本批使用用户明确授权的本机连接；没有新增生图渠道。

## 交付

小助手模型连接现在接受远程 HTTP 和 HTTPS，可保存、恢复、读取模型列表及发送聊天/工具请求。设置页注明 HTTP 不加密传输。用户名/密码嵌入 URL、查询参数、片段及非 HTTP 协议仍被拒绝；密钥继续按连接 ID、协议、主机、端口和路径隔离。模型列表和聊天请求均禁止重定向。

Windows Release 已重新构建并打开。用户在新版绘世保存了 DeepSeek 连接；测试通过只读 SQLite 与精确目标的 Windows Credential Manager 读取该连接，实际模型列表包含 `deepseek-v4.1-flash`。没有枚举无关凭据，也没有修改用户工作区配置或会话。

## 真实服务结果

| 场景 | 结果与证据 |
| --- | --- |
| 自动选用工具 | DeepSeek 在 `tool_choice=auto` 下依次调用 `read_current_prompts`、`write_prompt`、`generate_image`，并依据真实工具结果回答。见 [refine.json](evidence/assistant-live/refine.json)。 |
| 连续修改草稿 | 清晨提示词改为月夜，移除 morning/golden sunlight/sunbeam，加入 moonlight/glowing window 等；原负面词保留。 |
| 官方生图 | NAI Diffusion 4.5 Full，768×768，28 steps，Seed 20261014。共 2 次官方生成 POST，每次 `n_samples=1`，实际得到 2 张图片。第一张使用 DeepSeek 已写入的草稿经生产生成链路执行；第二张由真实 Agent 完成确认后执行。 |
| 拒绝操作 | DeepSeek 提议修改蓝色月光为紫色月光；测试确认层拒绝后运行结束，草稿和图片数不变，没有继续请求模型或生图。见 [decline.json](evidence/assistant-live/decline.json)；其中 turn 的 failed 是预期拒绝状态。 |
| 工具诊断 | `required` 首轮返回 `diagnostic_echo`，执行后结果回传，再由模型回复；两次模型请求均 HTTP 200。见 [diagnostic.json](evidence/assistant-live/diagnostic.json)。 |
| 持久化 | 独立测试工作区的 SQLite 会话、提示词与两张原图均在关闭重开后读取成功；见各 `*-reopen.json`。 |

首轮沿用经用户批准的 Studio HTTP 中转，测试客户端仅改写目标地址。放开 HTTP 后，最终联调直接使用绘世保存的真实地址，沿用生产 `OpenAiAgentTransport → AssistantController/AgentEngine → WorkspaceAgentTools → WorkbenchController → GenerationRuntime`，仅注入请求计数和参数检查，不替换模型回复、工具调用或图像结果。

确认由测试层按本次授权校验后执行：仅允许本轮合成场景的主/负提示词写入和指定模型/尺寸的 1 张生成，拒绝其余确认。测试没有模拟人的原生界面点击，因此不等于完整 Windows 人工交互验收。

## 图像效果

| 清晨 | 月夜 |
| --- | --- |
| ![清晨山湖木屋](evidence/assistant-live/image-d791d0041348.png) | ![月夜山湖木屋](evidence/assistant-live/image-8e16cfa164db.png) |

已直接查看两张实际输出。清晨图具有金色光束、红色木屋、松树、山湖与倒影；月夜图具有蓝色月光、清晰月亮、暖色窗灯与水面反光，两张均无明显人物、文字或水印。语义修改生效，但构图与木屋形状变化；这次是两次文生图，不证明同一画面编辑或严格主体一致性。月夜木屋与岸线衔接仍有生图常见的空间模糊，不作为几何精度验收。

## 次数、费用与数据

- 每个 Agent 生图确认仅允许 1 张，官方 HTTP 层再硬限制全次测试最多 2 个 POST、单次 1 张、768×768、28 steps、无参考图/编码/后处理附加请求。超限或结果不确定时停止，不自动重发。
- 只读官方账号查询确认有效 Opus。按官方免费条件限定本次 4.5 文生图；每次请求前后核对余额，累计观察到 **0 Anlas** 变化。该数字仅为本次 NovelAI 余额观察，DeepSeek 中转费用未核算。
- 真实 LLM 共 13 次 POST：12 次 HTTP 200、1 次 HTTP 503；详见 [http-requests.json](evidence/assistant-live/http-requests.json)。不把模型列表、官方余额等只读查询混入这个计数。
- 密钥仅通过捕获的匿名管道进入测试进程及内存凭据库；没有写入源代码、参数、日志、报告或测试数据库。发布证据仅含本次专门构造的场景和输出，不含用户图库、私人提示词或真实接口密钥。

## 测试过程中发现并处理的情况

1. 最初测试预算闸要求持有付费余额，未识别有效 Opus 免费资格，因此在发送官方请求之前拒绝了首轮生成。修正测试闸并重新查询套餐后继续；[initial.json](evidence/assistant-live/initial.json) 保留失败现场，官方请求数为 0。不是产品 API 失败。
2. Studio 配置在测试期间切换到另一模型，原 DeepSeek 不再出现在当前凭据的模型列表，后续调用返回 503。停止使用该配置，没有替换成其他模型；用户随后直接在绘世保存 DeepSeek。旧失败见 [resume_initial.json](evidence/assistant-live/resume_initial.json)。
3. 首张图片已成功生成，但测试夹具最初复用了关闭后的资产存储，导致重开断言报错。更正为重新打开资产存储后独立只读重验通过；没有再次生成该图片。
4. 用户实际添加 HTTP 连接时触发原有 HTTPS 限制，按明确要求修正产品地址验证，并新增回归测试。

## 验证与范围

- 全量 Flutter：393 项通过，1 项既有的显式启用本地 SR 探针默认跳过；本批未重跑 SR 模型。
- HTTP 专项：20 项通过，其中新增 4 项覆盖远程 HTTP 保存/恢复、模型/聊天 URL、凭据范围、禁止重定向及非法 URL。
- Dart：`lib` 和修改后的测试静态分析无问题。
- Windows/Web Release 构建通过；Web 保留既有 Cupertino 字体引用提示。Windows 使用现有完整图标构建参数。
- 真实测试夹具 refine、decline、diagnostic 及独立只读重开均通过。未测试公网 WD、Vision、更多模型、多角色、图片编辑或新生图渠道。中转后端的真实模型实现无法由客户端独立证明，报告以服务配置/模型 ID 及实际响应为准。

证据索引：[validation.json](evidence/assistant-live/validation.json)、[SHA256SUMS.txt](evidence/assistant-live/SHA256SUMS.txt)。本机手动真实探针位于被忽略的 `.tmp/assistant_live_probe_test.dart`，凭据读取器 `.tmp/worldpainter_live_credentials.py` 的 `--pipe` 模式只能供父进程捕获，不能直接输出到终端。真实探针不属于默认测试集，不能在未重新确认账号和次数范围的自动化中运行。

## 参考

- [DeepSeek 工具调用](https://api-docs.deepseek.com/guides/tool_calls/)与[思考模式的工具上下文规则](https://api-docs.deepseek.com/guides/thinking_mode/)用于核对结构化调用及 reasoning_content 回传；本批不展示模型推理内容。
- [NovelAI 官方生成基础](https://docs.novelai.net/en/image/basics/)与[模型说明](https://docs.novelai.net/en/image/models/)用于核对 Opus 单张、普通尺寸、28 steps 的免费资格及 V4.5/V5 区别。
- [Langbai NovelAI Studio](https://github.com/2786886095/novelai-image-desktop) 本地源码的 credential-helper/credential-vault 与 anlas.ts 作为已安装凭据桥接和费用条件的参考；没有复制用户配置进入仓库。

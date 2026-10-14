# 助手提示词知识来源与迁移边界

日期：2026-10-14。`nai-image-official-2026-10-14-r1` 是此前独立整理的官方摘要修订号，定义于 `lib/assistant/prompting_knowledge.dart`；本批接入手机端原始资源后，该摘要不再是当前助手运行时的提示词/参考正文来源。本文件记录手机端基线、官方事实来源、许可边界和当前接线。

## 结论与运行边界

`PromptingVersion` 是助手知识模式，`V4.5` 与 `V5` 只选择相应的本地提示词指导。它不改变生图模型、渠道、参数或权限。当前 PC 生图服务拒绝超过六个角色槽（`lib/generation/novelai_generation_service.dart:572-576`），助手工具目标也只开放 `character_1..6`（`lib/assistant/workspace_tools.dart:67-79`）。NovelAI 文档列出的 V5 22 角色是模型能力资料，不能写成 PC 当前可执行能力或据此宣称 PC 已连接 V5 生图。

当前运行时由 `lib/assistant/assistant_mobile_resources.dart` 读取手机端固定包内资源：无非空自定义覆盖时采用手机默认系统提示词；V4.5/V5 分别选取用户保存的画风词；V5 使用手机原始 `SKILL.md`，`read_prompting_reference` 只接受 `ideation` 和 `writing` 并读取两份对应原文。知识库按手机原有命中规则处理当前用户输入，命中内容才添加到本次模型上下文，最多 5 条、正文合计 2,000 字符。固定 asset 的界面摘要只显示来源、路径、哈希和条数，不提供正文编辑或外部文件导入。本批没有改写手机端 system prompt asset，也没有增加新的系统提示词内容；V5 沿用手机端原有 App 集成边界模板。

这五项资料作为整体加载和校验；任一项失败会阻止普通助手发送，独立诊断路径与这组资料加载分开。Windows native 路径用 `compute` 在 UI isolate 外完成资源解码、知识索引解析和 SHA-256 计算，以降低大资源处理对界面的阻塞；处理只读资产字节并构造内存快照，不修改原资源。资源逐项的来源、长度与哈希见永久 [mobile-resource-manifest.json](evidence/assistant-tag-knowledge/mobile-resource-manifest.json)。

此前六主题官方摘要及其工具定义仍留在 `prompting_knowledge.dart` 作为独立资料代码；当前 `lib/` 的助手生产路径只从该文件引用 `PromptingVersion` 类型，不再调用其摘要/工具实现。具体资源清单与实测边界见 [助手手机资源复核](ASSISTANT_TAG_KNOWLEDGE_REVIEW.md)。

## 官方事实摘要

下表保留此前对 NovelAI 官方文档的独立概述，供事实对照；它不是本批接线后的运行时提示词/参考内容，也不替代手机端现有原文资源。

| 主题 | 已核对事实 | 官方来源 |
| --- | --- | --- |
| 构思 | 官方基础指南允许用标签或自然语言描述图像意图，并强调主体重点。助手可以把主体、动作/关系、取景/构图、光线、背景或媒介作为可选构思维度；这是本地整理建议，不是官方固定模板或效果保证。 | [Image Generation Basics & Prompt Basics](https://docs.novelai.net/en/image/basics/), [Models](https://docs.novelai.net/en/image/models/) |
| 写法 | 官方指南建议把主体与重点放在前半段，以逗号加空格分隔标签，并提醒词序可能改变结果、冗长重复文本会占用上下文。助手只提供可尝试写法，不承诺生成效果。 | [Image Generation Basics & Prompt Basics](https://docs.novelai.net/en/image/basics/) |
| 强调与降权 | 花括号和方括号分别提高、降低提示词强调；数字权重语法从 V4 起可用，负数值强调从 V4.5 起可用。 | [Strengthening & Weakening](https://docs.novelai.net/en/image/strengthening-weakening/) |
| 多角色 | V4/V4.5 最多六个，V5 最多 22 个；基础提示词与单角色提示词承担不同信息。交互前缀存在可靠性限制。PC 仍限六槽。 | [Models](https://docs.novelai.net/en/image/models/), [Multi-Character Prompting](https://docs.novelai.net/en/image/multiplecharacters/) |
| 图中文字 | V4.5 限英文；V5 支持英文、日文、中文等。官方 `Text:` 写法要求把目标文字放在基础提示词末尾。Text Rendering 页面把 V5 Curated 374、Full 750 标为字符；Models 页面把相同数字标为 tokens，官方页面单位不一致，因此本地摘要不将其设作硬限制。 | [Models](https://docs.novelai.net/en/image/models/), [Text Rendering](https://docs.novelai.net/en/image/textrendering/) |
| 质量词 | 官方 Quality Tags 开关会隐藏地追加模型相关词组并占用提示词长度；词组按模型/变体变化，不能把单一尾缀推广到全部配置。 | [Add Quality Tags Toggle](https://docs.novelai.net/en/image/qualitytags/), [Models](https://docs.novelai.net/en/image/models/) |

核对日期为 2026-10-14。上表和 Dart 摘要保留这些页面的 URL，不复制其示例段落。V5 Full/Curated 的文字渲染界限数值不同，且官方两个页面对单位的写法不一致；助手应说明这一限制，不得把数值当作所有模型变体通用的硬上限。

## 手机端实现与内容格式

手机代码基线为 HEAD `01e85981a52b5d45d3cb6d1ee03a8604fe53d9ab`。版本对话框明确提供 V4.5/V5（`../手机端/lib/presentation/widgets/llm_chat/prompt_version_dialog.dart:4-25`）；一般的新会话入口默认 V5，但启动无历史会话、删除最后一个会话或清空会话会新建 V4.5 会话（`../手机端/lib/presentation/viewmodels/llm_chat_viewmodel.dart:167-172,332-338,380-400`）。目前观察到该 session 版本用于选择默认画风词，并控制是否加载提示词知识；不等于 PC 已有生图模型切换。只有普通 `general` 会话且版本为 V5 时，ViewModel 才加载技能并动态注册 `read_prompting_reference`；加载失败时不注册（同文件 `:513-534`）。手机实现只允许 `ideation|writing` 两个固定参考名（`../手机端/lib/domain/agents/tools/read_prompting_reference_tool.dart:17-50`），Asset Loader 把它们分别映射到 `assets/nai5-prompting/references/通用构思.md` 与 `通用写法.md`（`../手机端/lib/data/datasources/local/asset_prompting_skill_loader.dart:4-42`）。`pubspec.yaml:58-59` 将提示词目录整体打包，其中包括 `SKILL.md`、合订文档、这两份参考文件和 GPLv3 文本许可证。

手机 `../手机端/lib/presentation/widgets/llm_chat/prompt_apply_parser.dart:3-4,63-67,97-118,120-159,161-189,199-283` 的实现和 `../手机端/test/prompt_apply_parser_test.dart` 覆盖两种输入：JSON 代码围栏或正文中的第一个平衡 JSON 对象，已识别字段是 `positive`、`negative`、`characters[{positive,negative}]`；以及由中文正向/负向/角色标签指向的 fenced code block。角色标签支持数字、中文数字一到六或 A-F；未标目标的代码块会被忽略。该 parser 自身没有 V4.5/V5 版本门槛。**在该 HEAD 的 `手机端/lib` 中未找到生产代码导入或调用此解析器；它只有自身文件和单测。** 因此只能说解析规则有实现与测试，不能说有实际可用的文本提案应用流程。

手机 `../手机端/lib/domain/agents/tools/write_prompt_tool.dart:67-98` 会直接调用提示词写入接口；该工具没有开启 `requireConfirmation`，其默认值为 false（`../手机端/lib/domain/agents/agent_tool.dart:74-89`）。这与 PC 当前的应用层确认流程不同。PC `WorkspaceAgentTools` 每轮绑定草稿 fingerprint、要求先读当前提示词，并把目标与修改前后差异作为需确认的提案；执行前再次检查草稿状态（`lib/assistant/workspace_tools.dart:16-42,47-114`）。PC Agent 只分派结构化工具调用，不从普通回答或 fenced block 执行内容（`lib/assistant/agent_engine.dart:58-60`）。

## 手机文件校验记录

以下 SHA-256 对应上述手机 HEAD 工作区的实际文件字节。手机端资源中含有经 GPLv3 许可的提示词包；本批按指定来源将原有资源纳入 PC 包，七项的 PC 路径、长度与哈希见 [原始资源清单](ASSISTANT_TAG_KNOWLEDGE_REVIEW.md) 和永久 [mobile-resource-manifest.json](evidence/assistant-tag-knowledge/mobile-resource-manifest.json)，文件与来源 manifest 匹配。

| 手机端相对路径 | SHA-256 |
| --- | --- |
| `lib/presentation/widgets/llm_chat/prompt_version_dialog.dart` | `9BADED6533803D6B92808904F3C7FF67C7B998C0677251EE21F7F27E21B04F0B` |
| `lib/presentation/widgets/llm_chat/prompt_apply_parser.dart` | `C34E265E4611FEE807C0849356494199B40D7A30B20F31868986EA992D3BD996` |
| `test/prompt_apply_parser_test.dart` | `6E397AFEDE12DC2E9CE6F6747E114A85F17CD6A9DA4CCDA0535877DDA42ECCC8` |
| `lib/presentation/viewmodels/llm_chat_viewmodel.dart` | `A59D8C047DCA3201931E930B0291E768F6C871BF24FAD654BF36FE9A732B306C` |
| `lib/domain/agents/tools/read_prompting_reference_tool.dart` | `F21B3A37CDCC40BEACD1DE1FB85421F379E0CB46285AD926E1F1D6FDA73D4038` |
| `lib/domain/services/prompting_skill_loader.dart` | `A5F83D3D3C728C157AC411FB74C4EA376EDA8584EBA51988ABF7A029FB19BDAF` |
| `lib/data/datasources/local/asset_prompting_skill_loader.dart` | `4EB651531FC76FBEC980FE10620F48B515AE4A92EE7696B3D828C2D9D7E6EC14` |
| `lib/domain/agents/tools/write_prompt_tool.dart` | `C0E959805F6AE7ADAB720948356E5C13A9B82ADC36743898037C5BD97E2817DB` |
| `lib/domain/agents/agent_tool.dart` | `5DBC9F0143BB6D7F350E3DB3997FA081529ED57FE41455EEBC0326952522F059` |
| `lib/domain/agents/agent_loop.dart` | `7675E4A9570F8FE7864D88549DE40B625E8DAFBEA11F14DEEA1A973811B7C62C` |
| `assets/nai5-prompting/SKILL.md` | `C2461185579F280F4DB68266DD9BEE4F83604E48233074A095C95BEE3455C360` |
| `assets/nai5-prompting/NAI5_All_Prompting.md` | `A0B35A51169C66BBF139A074A742E957D782B0927A7C4BD323804A5369F402E3` |
| `assets/nai5-prompting/references/通用构思.md` | `9FDC8CCE237496737D016FFEE42A76A68D2689F00F280835ABFF1318437FEC63` |
| `assets/nai5-prompting/references/通用写法.md` | `494DC7526C99C353E29F0786861A465F1581AEF042B3FDA298C63197E66E0426` |
| `assets/nai5-prompting/LICENSE` | `BFDE1FD94C3B17B89FBBFA6321660C8284F631BF126DB1E0A32C897944A842DB` |
| `README.md` | `005681D0B42832A5F5BBB97847E671FD4FE5A1796A82549B620848311ABF8AC7` |
| `pubspec.yaml` | `A0197752F95811DAC0332A55C91AFD94CD824B811FE081B4668DF67CD90E9D42` |

## 许可边界

手机 README 的 MIT 徽标（`../手机端/README.md:12`）链接到根 `LICENSE`，但该手机目录当前没有根 `LICENSE` 文件。`assets/nai5-prompting/LICENSE` 是 GNU GPLv3 文本，手机 `pubspec.yaml:58-59` 将包含 `SKILL.md`、`NAI5_All_Prompting.md`、两份参考和许可证的整个目录作为应用资源打包。合订文档头部及附录（`NAI5_All_Prompting.md:3,1700-1716`）说明该包依托社群提示词、图片与反推语料，公开版对成员名做了匿名化。不能把手机 README 的 MIT 标识当作该技能包按 MIT 授权的证据。

本批依据用户指示，将手机 HEAD `01e85981a52b5d45d3cb6d1ee03a8604fe53d9ab` 中的原始默认系统提示词、skill、固定参考和知识库随原 GPL `LICENSE` 复制到 PC 包内；所复制内容没有改写，PC 哈希/长度列于资源清单。运行时只按手机既有接线使用系统提示词、V5 skill、两份参考及匹配到的知识条目；合订文档和许可证只随原包保留，不注入模型。流程证据 [`live-pipeline.json`](evidence/assistant-tag-knowledge/live-pipeline.json) 记录了真实 WD 返回 18 个标签、5 个标签经 DeepSeek 翻译后由用户确认追加且保留权重和负向词；SQLite 重开恢复来源、审核和双版本偏好并通过资产引用保护。手机端原 V5 Agent 子集仅调用 `read_prompting_reference` / `read_current_prompts` 两个只读工具，两次请求后草稿未变、0 生图。全量 Flutter 测试为 435 通过、1 跳过（可选 SR opt-in），静态分析无问题；Windows Release 已完成最后 caption 微改后的顺序重建，Web Release 构建成功，最后微改后的结果待主控核对。Core/bundle 探针确认原知识库 12,738 条且 SHA-256 与 manifest 一致，Windows Release 原资料设置 UI 实际加载并展示五个哈希和条数，见 [mobile-bundle.json](evidence/assistant-tag-knowledge/mobile-bundle.json)、[native-metadata.jpg](evidence/assistant-tag-knowledge/native-metadata.jpg)。隔离合成 PNG 的 native 确认流程与 QA 进程退出后的 SQLite 值已验证，详见 [native-review.json](evidence/assistant-tag-knowledge/native-review.json) 和 [native-confirmation.jpg](evidence/assistant-tag-knowledge/native-confirmation.jpg)。非空偏好 native 键盘录入因 UIA 索引过期未验证，应用重开验证也待补；双版本偏好持久化已有 live pipeline 与 6 项 Widget 测试证据，但本轮不据此宣称完整 native 手工验收。

## 本地参考实现对照

| 固定参考 | 同类实现 | 与本批的差异和采用边界 |
| --- | --- | --- |
| `../参考资料/novelai_local_web`，HEAD `aa0fcbe477eae0a703ec47740785f9419d7d5cbe`，根许可证 AGPL-3.0 | `next_nai_web/src/components/ai-painting/PromptEditor/promptWeights.mjs` 提供提示词权重编辑；`usePromptSuggestions.js` 会取消过期的联想请求并校验文本/光标上下文。 | 可作为权重编辑和过期联想处理的体验参考；没有同类的助手知识读取工具或文本提案确认流程。本批不复制代码。 |
| `.tmp/novelai-image-desktop`，HEAD `2d609393c3902874afae5200c26165d86b76055f`，MIT | `src/prompt-assistant.ts:14-22` 校验编辑请求并限制输入长度；`src/components/PromptAssistant.tsx:20,42-68` 显示只读结果预览、比较来源上下文并要求显式点击应用；`src/App.tsx:2295-2297` 再核对当前提示词是否仍等于提案原文。 | 有用的“预览后应用”和陈旧结果拦截模式，但只有单个正向提示词编辑，不提供 V4.5/V5 固定官方知识，也不覆盖 PC 的多目标结构化工具确认。本批记录其行为，不复制实现。 |

PC 的 `WorkspaceAgentTools` 保留目标级差异预览、显式确认和草稿 fingerprint（`lib/assistant/workspace_tools.dart:45-115`）。PC 还提供用户主动审阅普通文本提案的入口：助手完成回复后可选择“查看提示词提案”，核对目标和修改前后内容，再勾选应用目标并填写原因；控制器会重验会话、回复、知识版本和草稿 fingerprint（`lib/prototype/assistant_panel.dart:707-821`、`lib/assistant/assistant_controller.dart:322-405`）。普通文本或模型返回的工具 JSON 不会自行执行或应用。当前 `read_prompting_reference` 从手机固定参考文件中只读返回 `ideation` 或 `writing` 原文；应用提案仍由用户显式触发，并留下本地应用记录。

# 助手图像标签与手机端资料接线复核

日期：2026-10-14。手机端来源仓库 HEAD：`01e85981a52b5d45d3cb6d1ee03a8604fe53d9ab`。本批只记录手机端现有资源的来源、PC 接线和验证证据，不复述提示词、技能或知识库正文，也不记录凭据或私人地址。

## 原始资源清单

PC 包内的七项资源对应永久证据 [mobile-resource-manifest.json](evidence/assistant-tag-knowledge/mobile-resource-manifest.json)，表中字节数与 SHA-256 均取自该清单；当前 PC 文件逐项与清单匹配。复制内容保持原样，手机端 GPL `LICENSE` 随提示词资源一并保留。

| 手机端来源 | PC 包内路径 | 字节数 | SHA-256 |
| --- | --- | ---: | --- |
| `lib/core/constants/app_constants.dart`（默认助手系统提示词） | `assets/assistant/mobile/system_prompt.txt` | 9,098 | `644fef0d802ee47aa61893054e59520181cdc087feda0bcc197ba29cb7e36c77` |
| `lib/assets/nsfw_knowledge.json` | `assets/assistant/mobile/nsfw_knowledge.json` | 8,882,911 | `fe8788cb82dd8a6ef7ebf5bd11b39d7fa7b1dec4f912835d5bf525bb7d9ac66c` |
| `assets/nai5-prompting/SKILL.md` | `assets/assistant/mobile/nai5-prompting/SKILL.md` | 2,392 | `c2461185579f280f4db68266dd9bee4f83604e48233074a095c95bee3455c360` |
| `assets/nai5-prompting/references/通用构思.md` | `assets/assistant/mobile/nai5-prompting/references/通用构思.md` | 18,065 | `9fdc8cce237496737d016ffee42a76a68d2689f00f280835abff1318437fec63` |
| `assets/nai5-prompting/references/通用写法.md` | `assets/assistant/mobile/nai5-prompting/references/通用写法.md` | 85,427 | `494dc7526c99c353e29f0786861a465f1581aef042b3fda298c63197e66e0426` |
| `assets/nai5-prompting/NAI5_All_Prompting.md` | `assets/assistant/mobile/nai5-prompting/NAI5_All_Prompting.md` | 103,948 | `a0b35a51169c66bbf139a074a742e957d782b0927a7c4bd323804a5369f402e3` |
| `assets/nai5-prompting/LICENSE` | `assets/assistant/mobile/nai5-prompting/LICENSE` | 35,825 | `bfde1fd94c3b17b89fbbfa6321660c8284f631bf126db1e0a32c897944a842db` |

`AssistantMobileResources` 从固定 Flutter asset 路径加载默认系统提示词、V5 skill、两份固定参考和知识库，并按原始 bytes 计算摘要。五项资源在一次加载中共同解码和校验；任一项失败都会阻止普通助手发送，独立诊断路径不依赖这组资料。Windows native 路径通过 `compute` 在 UI isolate 外完成资源解码、知识索引解析和摘要计算，降低大资源处理对界面的阻塞；此流程只读原始资源，不改写它们。`NAI5_All_Prompting.md` 与许可证作为原包文件保留，但不会作为运行时提示词或工具返回内容。V5 参考工具只接受 `ideation`、`writing` 两个固定名称；没有任意路径读取、外部 JSON 导入或知识内容编辑入口。

系统提示词非空的既有用户自定义值仍优先使用；没有自定义值时使用手机端默认系统提示词。PC 的 V4.5/V5 画风词分别保存，并按当前会话版本加入提示词。手机端原始 system prompt、skill、参考和知识文件均未改写；V5 会话使用原始 skill 和固定参考，并沿用手机端原有 App 集成边界模板。运行时只做手机 loader 原有的首尾空白裁剪。

知识库只从固定包内资源读取，并在内存中使用，不写入工作区 SQLite。匹配只看当前用户输入：英文关键词按词边界匹配，其他关键词按子串匹配；命中按条目 ID 排序，最多返回 5 条、正文合计最多 2,000 字符。只有发生命中时，匹配正文才作为 system-role 上下文发送给当前助手模型。设置界面只显示来源、路径、SHA-256、条数和加载状态；“重试加载”重新读取包内资源，不更改内容。WD 服务开关摘要另有明确前缀，避免被误认为关闭手机端资料加载。

## 本批服务证据

证据只保留运行状态和必要摘要，不在本报告复制请求正文、图片内容或私人地址。

| 检查 | 已确认结果 | 证据 |
| --- | --- | --- |
| WD-Tagger 实际请求 | 公共 WD-Tagger Space 请求通过；模型为 `SmilingWolf/wd-swinv2-tagger-v3`，未发送凭据，自动重试 0 次。 | [`wd-live.json`](evidence/assistant-tag-knowledge/wd-live.json) |
| 标签索引查询 | 查询通过，返回 3 个候选，自动重试 0 次。 | [`external-services.json`](evidence/assistant-tag-knowledge/external-services.json) |
| DeepSeek 视觉理解 | 请求通过，模型为 `deepseek-v4.1-flash`。 | [`external-services.json`](evidence/assistant-tag-knowledge/external-services.json) |
| 生图调用 | `imageGenerationPosts` 为 0；本批没有发起生图请求。 | [`external-services.json`](evidence/assistant-tag-knowledge/external-services.json) |

完整流程另由 [`live-pipeline.json`](evidence/assistant-tag-knowledge/live-pipeline.json) 记录：真实 WD-Tagger 返回 18 个标签，选出的 5 个英文标签经 DeepSeek 翻译；用户确认后追加到正向词，已有权重和负向词保持不变。SQLite 重开后来源、审核结果及两套版本偏好均恢复，来源文件仍受资产引用保护。手机端 V5 Agent 工具子集测试只开放 `read_prompting_reference` 与 `read_current_prompts` 两个只读工具；两次模型请求完成这两项调用，草稿未改变，生图请求数为 0。

这些记录证明本次服务调用成功，不代表所有图片、标签或模型输出都已完成准确性验收。

补充 [agent-auto-live.json](evidence/assistant-tag-knowledge/agent-auto-live.json)：向 DeepSeek 提供测试工作区完整的 12 项生产工具定义，`tool_choice` 两轮均为 `auto`，没有强制首轮工具调用。原手机端 V5 提示词下，模型在两次请求中成功完成参考读取与当前词框读取。测试执行层只允许这两种读取操作，拒绝其他调用，因此没有改写草稿或发起生图请求；不能据此宣称全部付费、写入或超分工具都已完成本批真实验收。

## 已完成与待补验证

- UI 专属 Widget 测试 6/6 通过，覆盖双版本偏好保存、只读资源元数据、失败重试、离开后忽略迟到响应及 640×480 逻辑尺寸 / DPR 2 滚动。该测试使用 synthetic snapshot 和 mock workspace；合成截图为 [preferences-compact-mock.png](evidence/assistant-tag-knowledge/preferences-compact-mock.png)。全量 Flutter 测试为 435 通过、1 跳过（可选 SR opt-in），静态分析无问题。
- PC 七项包内文件的长度与 SHA-256 均与 manifest 匹配；core/bundle 探针确认原始知识库为 12,738 条且 SHA-256 与 manifest 一致，见 [mobile-bundle.json](evidence/assistant-tag-knowledge/mobile-bundle.json)。最终 Windows/Web Release 均构建成功，两个包中的七项资源与源文件逐字节一致，见 [release-resource-check.json](evidence/assistant-tag-knowledge/release-resource-check.json)。Flutter 对中文文件名使用 URI 编码，逻辑 asset 名称保持原样。Web 保留既有 CupertinoIcons 字体提示；Windows 使用完整 Material 字体，本批可见控件的图标已在原生窗口核对。
- Windows Release native 复核使用隔离的合成 64×64 PNG，解析 7 个候选。确认前数据库未改变；确认后正向内容追加并保留原权重、换行、负向词和来源，保存成功，QA 进程退出后数据库值仍正确。证据见 [native-review.json](evidence/assistant-tag-knowledge/native-review.json)、[native-metadata.jpg](evidence/assistant-tag-knowledge/native-metadata.jpg) 与 [native-confirmation.jpg](evidence/assistant-tag-knowledge/native-confirmation.jpg)。该 Release 中真实资源设置 UI 的 loader 显示 5 个资源哈希及 12,738 条知识库。
- 双版本非空偏好持久化由 [live-pipeline.json](evidence/assistant-tag-knowledge/live-pipeline.json) 与 6 项 Widget 测试覆盖；native 键盘输入尚未验证：UIA 索引已过期，输入未落入字段，随后窗口最小化且检测到用户输入，故停止继续输入。另在新的 Windows Flutter 测试进程中，以生产 SQLite、资产存储及控制器重开原生程序写出的工作区，确认词框、7 个候选、原图和引用保护恢复。这证明跨进程数据恢复，不代表已重开 Release 窗口完成手工验收。

本批复用现有的 WD-Tagger 客户端，并核对公共服务的 `api_prefix`、上传及 `predict` 输入输出；参考为 [SmilingWolf Space 上游源码](https://huggingface.co/spaces/SmilingWolf/wd-tagger/blob/main/app.py)。没有增加生图渠道或依赖，实际新增生图请求为 0。

关联对照见 [手机端功能对照基线](MOBILE_PARITY.md) 与 [提示词知识来源](PROMPTING_SOURCES.md)。

最终检查和构建产物摘要见 [validation.json](evidence/assistant-tag-knowledge/validation.json)，提交源码摘要见 [source-hashes.json](evidence/assistant-tag-knowledge/source-hashes.json)，证据文件摘要见 [sha256-index.json](evidence/assistant-tag-knowledge/sha256-index.json)。敏感模式检查及与本机保存凭据原值的比对均未发现泄漏；未提交测试密钥、私人服务地址或测试工作区。

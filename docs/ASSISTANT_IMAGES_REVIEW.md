# 小助手附图分析与 Agent 本地超分

日期：2026-10-14。延续 M4，生图渠道未扩展。正式发布、真实 LLM 和公网图片服务测试均未发生。

## 本批实现

- 小助手设置增加可选 WD-Tagger：默认关闭；六个手机端模型、服务地址、一般/角色阈值及 MCut 均可保存。启用后发送附图才上传，界面显示目的服务。没有识图模型时可只用 WD；绑定识图模型时依次取得两种观察。
- 发送时冻结配置和附图引用，限制 4 张/每张 10 MiB；重新编码 PNG 去掉文件元数据块，保留受管原图。此操作不承诺移除像素隐写或可见水印。WD 只将前 40 个一般、10 个角色和 4 个评级标签及置信度纳入上下文，caption 不直接注入。
- 每项分析有可展开的过程记录。WD 失败但识图完整，或识图失败但全部图片 WD 成功时，明确提示并继续；任一图片缺少可用观察则停止主模型。取消/关闭阻止晚到结果继续请求；历史只重放观察文本，不重传图片或保存 Base64。
- `upscale_image` 通过 `read_gallery` 的受管图片 ID 选图，固定三个本地预设，确认时显示原图、模型、倍率和尺寸。执行绑定确认时的源图身份，切换当前选图不会串图，源记录变化会拒绝。结果保留父图关系并进入图库；不调用收费远程放大。
- 图片任务复用原有进度/停止/持久化路径，助手调用不覆盖用户的图片工具草稿。图库保存失败不返回成功图片 ID；中断恢复不会自动重做任务。

## 调查和采用方式

本批独立实现协议适配与接线，复用 PC 已有受管资产、结构化 Agent、图片任务和 Windows ncnn 后端；没有复制手机业务源码、第三方模型或社区语料，没有新增运行依赖。

| 来源 | 固定依据与用途 |
| --- | --- |
| 手机端 `01e85981a52b5d45d3cb6d1ee03a8604fe53d9ab` | 只读查看 `wd_tagger_api_service.dart`、`llm_chat_viewmodel.dart`、`upscale_image_tool.dart`；对照六模型、两类阈值、WD/Vision 协作及确认超分。根许可仍未明确，不复制源码。 |
| [SmilingWolf Space app.py](https://huggingface.co/spaces/SmilingWolf/wd-tagger/blob/fbd35b187d6e8cb8a00c529d52999f82d6b5193b/app.py) | 固定 revision `fbd35b187d6e8cb8a00c529d52999f82d6b5193b`，核对 6 输入和 caption/rating/character/general 的 4 输出顺序。只读源码，不上传图片验证公网服务。 |
| [Gradio API 文档](https://www.gradio.app/main/guides/view-api-page)及 [6.19.0 Label 上游](https://github.com/gradio-app/gradio/blob/gradio%406.19.0/gradio/components/label.py) | 核对 upload → call/predict → SSE 协议和 Label 的空字典/置信度格式。没有把 generating 或缺失 complete 的流当成成功。 |
| [既有本地超分报告](IMAGE_TOOLS_REVIEW.md) | 沿用固定版本、配对模型和许可，三个预设为 Real-ESRGAN Anime 4×、Real-CUGAN Conservative 2×/4×。 |

相比手机当前实现，PC 不自动重试公网冷启动/限流，也不接收任意本地文件路径。WD 使用单次独立 HTTP client，不发送模型凭据、不跟随重定向，120 秒覆盖全部三阶段；1 MiB 响应、16 KiB caption、每类 1000 个标签与标签长度/置信度严格校验。超时终止内部任务，不取消调用方，以允许识图回退。设置 schema 1 完整解析，旧助手快照缺少 WD 字段时才采用关闭默认值。

## 验证

| 检查 | 本批结果 |
| --- | --- |
| 全量 Flutter 测试 | 389 项通过，1 项显式启用的本地模型探针默认跳过；该探针随后单独运行通过，覆盖三个预设及 SQLite 重开。 |
| 静态分析与构建 | Dart 无问题；Windows / Web Release 均通过；Web 保留既有 Cupertino 字体提示。 |
| Windows 探针 | SQLite 重开、中文路径、PNG SHA-256、安全凭据跨进程读取通过。 |
| 视觉抽查 | 两种设置表单视口截图及三种真实 SR 输出均已查看；合成几何图只验证执行/输出结构，不代表绘画质量。 |
| Windows 界面 | 独立合成工作区成功启动并恢复附图/设置，启动截图已留存。自动化输入连续收到 `user input was detected in this window`，因此停止输入；实际发送、确认超分、设置保存后的原生重开 **未完成**，不把预置快照算交互证据。没有发生该原生 QA 的 HTTP 请求。 |

最终运行结果及文件哈希见 [validation.json](evidence/assistant-images/validation.json) 和 [SHA256SUMS.txt](evidence/assistant-images/SHA256SUMS.txt)。自动化、Windows 实际本地模型输出和模拟模型的原生界面操作分别记录；模拟模型不证明真实 LLM 会正确选用工具。

- 测试覆盖 WD 三阶段本机 HTTP、multipart、严格完成事件、异常/重定向/总超时/晚到响应、取消、配置恢复、观察上下文、部分失败、诊断隔离及原图保留。
- 超分覆盖拒绝确认、等待确认后源图移除/切换、固定源图处理、忙碌/取消/关闭、保存失败、派生身份与 SQLite 重开；另有显式启用的 Windows 三预设实际运行探针。
- 设置表单正常和窄窗口 widget 交互/截图，以及 Windows Release 的实际界面操作单列证据。

本地复现：设置 `PUB_CACHE=PC端/.tmp/pub-cache`，用 `../.tools/flutter/bin/flutter.bat test --no-pub --reporter expanded`；实际 SR 探针额外设置 `WORLDPAINTER_AGENT_SR_PROBE=1`、`WORLDPAINTER_SR_RUNTIME=PC端/.tmp/sr-runtime` 和 `WORLDPAINTER_SR_TEMP=PC端/.tmp/assistant-images-sr-jobs`，运行 `test/assistant/upscale_agent_test.dart`。该探针仅处理合成图，不连接公网。

原生 QA 使用 `scripts/assistant-image-qa-mock.py`：先运行附图集成测试生成合成快照，再执行 `--prepare` 建立独立数据目录；服务仅监听 `127.0.0.1:5121`，不会转发外网。`WORLDPAINTER_DATA_DIR` 指向 `.tmp/assistant-images-native-qa` 后启动 Release。全部输入为合成图片/会话，模型输出是确定性协议模拟，超分调用实际打包后端。

## 未完成范围

- 公网 WD Space 的在线状态、排队时间、匿名额度与兼容性，以及真实 LLM/Vision 调用仍未验收。120 秒可能不足以等待冷启动，失败需用户显式重发。
- 本批 WD 服务用于助手附图预分析；独立图片打标页的候选勾选/反选、翻译和写入流程仍未实现（MP-IMG-02）。
- 本地 SR 合成图验证不代表绘画品质评测、Intel-only GPU 或新机器安装验收。
- 手机社区提示词知识深度、默认风格/画师偏好、外部知识库、漫画/Pixiv 和其余 M4/M5 必迁范围仍继续跟踪。

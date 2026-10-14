# 标签搜索与助手全链批次

日期：2026-10-14。承接 `245d890` 的记忆批次，继续 M4；不增加生图渠道。本批全部请求验证使用合成数据与 mock/回环服务，没有调用真实 LLM、第三方标签搜索或付费生图。

## 入口与行为

- 侧栏 **标签搜索**：输入中英文关键词，手动查询最多 30 条标签；展示原 tag、提示词形式、中文名称、分类、热度、相关分数及 Wiki 详情。复制值将下划线转换为空格，与手机页一致，不自动改创作草稿。
- **搜索设置**：默认 Hugging Face，可显式选 ModelScope 或输入兼容 API 根地址；NSFW 标签开关默认开启，与手机调用一致。修改设置不发送请求，保存后才用于新查询。来源与过滤设置参加工作区 SQLite 保存。
- 空结果、服务失败、加载与取消分别显示；改查询、改设置或离开页面使旧请求失效，迟到响应不会替换新结果。服务错误可手动重试。
- **AI 助手**：新增 `search_danbooru`。模型需要结构化调用工具，普通文字没有执行权限。工具链可以读取草稿、检索已采纳记忆、搜索标签，再提议写词；写词沿用差异预览和明确确认。

## 来源与实现取舍

手机端的命名为 Danbooru API，但实际调用第三方中文语义索引，并非 Danbooru 官方实时接口。PC 保留这个现有服务协议并标明来源，不将返回结果描述成官方认证。手机三个参考文件的 HEAD 和 SHA-256 见 `evidence/tag-search/reference-sources.json`。

协议调查参考 [ComfyUI-DanbooruSearcher 固定版本](https://github.com/SuzumiyaAkizuki/ComfyUI-DanbooruSearcher/tree/3522854610d9cb51193ffcdd5b9a3059d4a686be) 和 [HF 部署源码](https://huggingface.co/spaces/SAkizuki/DanbooruSearch/tree/427a3c377821367f83a1f3c141c15fdfcb290bd2)。`api_fastapi.py` 定义 `/search`，`ui_nicegui.py` 将其挂载到 `/api`，外部路径为 `/api/search`。发送 `query/top_k=5/limit/show_nsfw`，读取 `results` 中的有界字段。GitHub 仓库未找到根 LICENSE；HF 部署标 GPL-3.0。本批仅参考协议，自行实现客户端与界面，未复制第三方业务代码、模型、词库或图片，未新增依赖。

上游存在匿名额度与 API Key 治理代码；本批不发送 Key，不验证运行时额度或部署政策。若远端拒绝匿名请求，会显示 HTTP 错误；不会借用助手或生图凭据，也不会自动切到其他域名。用户可显式配置自己可用的同协议地址。

与手机实现的差异：手机默认自动跨域回退，且坏 `results` 可能表现为空列表；PC 只请求当前明确选择的地址，坏 JSON/格式和失败状态明确报错。查询 15 秒总超时，响应上限 1 MiB、最多 30 条；Wiki 截至 4096 字符，Agent 回传单条 Wiki 截至 512 字符。完整 Wiki 指的是当前返回的受限文本，不保证上游原文无截断。Agent 不能通过参数开启用户已关闭的 NSFW 过滤，结果作为资料回传，不构成指令或授权。

## 验证记录

全量 Flutter 测试 **324 项通过**（比上批增加 23 项），Dart 静态分析无问题，Windows/Web Release 构建和 Windows 存储/凭据探针通过。Widget 截图覆盖 1440×900、640×480（DPR 2），主控查看了搜索结果、长 Wiki、紧凑详情、确认和完成状态。

Windows 原生程序使用独立合成 fixture 与 `127.0.0.1:5119` 服务，实际点击走通四工具链、差异确认和写入；正常关闭再启动后，提示词后缀、记忆命中及工具历史保留，没有自动重放。原生“测试工具调用”按钮也通过 nonce/调用 ID/结果回传诊断。mock 记录 7 次聊天请求、1 次标签请求、5 次工具调用（四步业务链 + 一步诊断），两个流程完成，无真实外部服务调用。鼠标点击与重开已验证；自动化 `type_text` 两次没有使新文字进入 Flutter 编辑框，额外无工具/失败/取消情景的原生键入未完成，这些分支由自动化测试覆盖，不宣称全面原生输入验收。

原生检查发现 Windows 增量构建保留了旧的 Material 图标子集，新增入口图标缺失。核对当前 SDK 3.47.7 `BundleWindowsAssets` / `IconTreeShaker.inputs`：字体资源目标没有随 Dart-only 图标变化重新构建。构建脚本现对 Windows 使用 `--no-tree-shake-icons`，携带完整 1,645,184 字节字体；重新构建后实际重开并确认标签页/侧栏图标恢复。修复前后 exe 与 `app.so` SHA-256 完全一致，变化在资源包；最终字体与 SDK 原件的哈希一致。

验证结果和对应日志、截图、源码与构建哈希统一记录于 [validation.json](evidence/tag-search/validation.json) 和 [SHA256SUMS.txt](evidence/tag-search/SHA256SUMS.txt)。测试涵盖协议字段、限额、坏数据、重定向、超时/取消、空结果、界面复制/详情/重试、迟到响应、SQLite 重开及四工具确认链。实际 Windows 交互结果在 validation 中单独标注，不能用 widget 测试或构建成功替代。

`scripts/tag-agent-qa-mock.py` 仅监听 `127.0.0.1:5119`，提供分片 SSE、合成标签、模型列表、诊断和失败/取消情景；无外网转发。`--prepare` 只接受 PC `.tmp` 下的合成工作区 fixture，拒绝覆盖已有数据库。请求收据不记录完整对话或凭据。

M4 与手机全量移植仍未完成。自动标签校准未接线，专用 v4.5/v5 知识、WD-Tagger 和其余 Agent 工具待后续批次；真实外部服务、真实模型工具调用稳定性与费用仍未验证。

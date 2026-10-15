# 绘世 · NAI WorldPainter PC

Windows 图像创作工作台。当前主实现为 **Electron + React 迁移预览版**，位于 `desktop/`；原 Flutter 源码与数据继续保留，作为迁移基线和回退版本。

2026-10-15，按用户最新安排，直接适配 `novelai-image-desktop` 的成熟功能代码，再参照 `novelai_local_web` 整理界面与交互。产品保持绘世近黑暖金 / 浅色蓝的配色，使用独立名称、图标、欢迎图、数据目录和项目信息。上游署名保留在许可证与第三方说明中。

本批完成情况和 Windows 验收证据见 [迁移与 M4 报告](docs/M4_ELECTRON_MIGRATION.md)。参考项目功能更多不代表手机全量 parity 已通过；原 Flutter 的验证结论也不能直接继承给 Electron。

最新本地预览包：`build/WorldPainter-0.1.0-models-preview/win-unpacked/NAI WorldPainter PC.exe`。包含 [多供应商模型管理与真实启动屏修正](docs/AGENT_PROVIDERS_V1.md)，并保留此前的 [Agent 执行改进和 Skill 系统](docs/AGENT_EXECUTION_V1.md)。请保留同目录内全部文件；这是未签名的解包开发版本，本批原生窗口验收受自动审批阻断。上一批 `agent-preview` 与 M4 `preview` 均保留。

## 启动与开发

需要 Node.js 22.12 以上（本机使用 24）和 Windows x64。在本仓库执行：

```powershell
cd desktop
npm ci
node node_modules/electron/install.js
npm run dev
```

Electron 42 的运行时需单独安装；下载失败时使用官方固定版本归档并核对 `node_modules/electron/checksums.json`，不要跳过校验。开发数据默认写入 `PC端/data/electron`；可用 `WORLDPAINTER_DATA_DIR` 指定项目内隔离目录。打包版本默认使用 `%APPDATA%/NAI-WorldPainter-PC`。旧版与上游账户不会自动迁入。

```powershell
npm run typecheck
npm test -- --retry=0
npm run build
npm run pack:dir
```

验收日志、缓存和临时数据放本仓库 `.tmp/`。当前为本地预览，不是正式发布；自动更新尚未启用。

## 本批入口

- **设置 → 智能体模型**：多供应商 / 多模型管理；Agent 原设置入口保留，输入区旁可原位展开模型菜单。
- **生图智能体 → 资源 → 记忆**：分类记忆、候选审核、冲突合并/替换/并存、有界检索与清理预览。
- **生图智能体 → 创作资源 → 技能**：替换世界书入口，按会话选择或关键词匹配工作流、按需读取正文；预设保留。多轮工具结果以原生调用协议回传，函数文本可进行一次协议纠正。
- **设置 → 绘世资料**：旧 Flutter 工作区只读预览后追加导入、风格/画师 JSON 与预览图导入、本地超分、V4.5/V5 风格词和外部知识库。
- **设置 → 兼容网关**：7877/ikun 独立凭据和纯文生图计划；不支持的参考/编辑参数会明确阻止，不回退官方账户。
- 迁入基线还包含生成、局部重绘、后期、元数据、标签、参考图与漫画等功能；以逐项验收记录为准。

本轮工作区、导入和知识库数据使用合成数据，账户/网关流程使用本地模拟服务；本地超分另以真实 Windows Vulkan CUGAN 后端验收，未联网。初始打包候选的超分 GUI 流程，以及该批最终包的冷启动、深浅主题与产品身份检查已通过，详细边界见 [M4 迁移报告](docs/M4_ELECTRON_MIGRATION.md)。未发送真实付费 API 请求。手机风格/画师素材库未整体随包分发；按用户要求仅复用指定的 `style_001.jpg` 为欢迎图，其余可自行导入。网关编辑能力、Agent 本地超分接线、Pixiv 和其他未验收 parity 项仍在后续范围。

## 项目文档

- [阶段与范围](docs/PC_PLAN.md) · [手机功能矩阵](docs/MOBILE_PARITY.md)
- [当前技术路线](docs/ARCHITECTURE.md) · [绘世视觉方向](docs/DESIGN_DIRECTION.md)
- [源码来源与复用](docs/RESEARCH.md) · [第三方许可](docs/THIRD_PARTY.md)
- [旧 Flutter 最后工作流验收](docs/ASSISTANT_EDIT_WORKFLOW_REVIEW.md)

旧 Flutter 仍可按 `scripts/build-windows.ps1` 构建；其开发数据位于 `data/desktop`，与新端分离。不要把 Electron 的 `desktop/mobile/` 上游测试参考快照当成绘世手机项目。

本项目：[NAI-WorldPainter-PC](https://github.com/liyi3068238601-oss/NAI-WorldPainter-PC)。唯一开发目录为 `E:\NAI-WorldPainter\PC端`。

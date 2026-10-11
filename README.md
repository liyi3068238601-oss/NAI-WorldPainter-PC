# NAI WorldPainter PC 绘世桌面端

面向 Windows 的绘世创作客户端。**先完整移植手机端全部现有功能，再增加其他功能**，包括 NovelAI 官方与现有兼容网关、其他已接入生图服务、提示词助手、图库后期、漫画、本地超分和 Pixiv 工作流。

当前状态：**规划初稿，尚未开始应用实现**。仓库建立于 2026-10-11；目前没有可运行客户端或安装包。

- GitHub：<https://github.com/liyi3068238601-oss/NAI-WorldPainter-PC>（私有）
- 唯一工作目录：`E:\NAI-WorldPainter\PC端`
- [PC 端规划](docs/PC_PLAN.md)：目标、首版范围、交互、里程碑与验收。
- [手机端功能对照](docs/MOBILE_PARITY.md)：按功能记录来源、PC 等价行为和验收标准。
- [设计方向](docs/DESIGN_DIRECTION.md)：界面、布局、动画与流畅感优先参考 NovelAI Local Web，其次浪白；保留绘世主色和风格。
- [技术路线比较](docs/ARCHITECTURE.md)：按全量移植成本优先验证 Flutter Windows，Electron 作为对照，尚未定案。
- [调查与复用清单](docs/RESEARCH.md)：现有代码、官方资料、来源和复用边界。

NovelAI Local Web 与浪白同时是功能实现代码参考：逐项评估成熟模块的复用/适配，不从零重复实现已有可靠方案。新增功能仍在全量移植验收后开展。

全量移植首版完成应意味着：手机端现有能力逐项在 PC 上可达、可用、可持久化并经过验收。仅完成生图流程属于中间开发版本，不能称为移植完成；模拟接口通过不能代替真实服务兼容性验证。

当前提交只包含项目自写规划、调查证据与仓库配置，没有导入手机端或参考项目的实现及图片。首要参考克隆在用户指定的 `E:\NAI-WorldPainter\novelai_local_web`，浪白克隆在被忽略的 `.tmp/` 内。项目发行许可证待确定，第三方内容引入时单独记录来源和许可。

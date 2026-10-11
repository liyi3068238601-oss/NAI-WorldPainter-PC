# NAI WorldPainter PC 绘世桌面端

面向 Windows 的 NovelAI 创作客户端，首版同时支持 **NovelAI 官方接入与兼容网关接入**，围绕提示词、生成任务、本地图库和图片后期建立连续工作流。

当前状态：**规划初稿，尚未开始应用实现**。仓库建立于 2026-10-11；目前没有可运行客户端或安装包。

- GitHub：<https://github.com/liyi3068238601-oss/NAI-WorldPainter-PC>（私有）
- 唯一工作目录：`E:\NAI-WorldPainter\PC端`
- [PC 端规划](docs/PC_PLAN.md)：目标、首版范围、交互、里程碑与验收。
- [技术路线比较](docs/ARCHITECTURE.md)：暂推荐 Electron + React + TypeScript，待桌面验证后定案。
- [调查与复用清单](docs/RESEARCH.md)：现有代码、官方资料、来源和复用边界。

首版完成应意味着：两类接入分别能完成生成、结果落盘、重新打开、复用参数和明确失败反馈；不能用模拟接口通过代替真实服务兼容性验证。

现阶段只包含项目自写规划与仓库配置，没有导入手机端、参考 Web 项目的代码或图片。项目发行许可证待确定，第三方内容引入时单独记录来源和许可。

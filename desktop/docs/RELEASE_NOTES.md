# 绘世 PC 迁移预览记录

> 本页记录当前绘世 PC 桌面迁移预览状态，不是正式发行说明。上游产品的版本与发行历史已归档在 [上游来源资料](./upstream-reference/README.md)，不得作为绘世下载或验收信息。

## 当前状态

- 本项目是 [NAI-WorldPainter-PC](https://github.com/liyi3068238601-oss/NAI-WorldPainter-PC) 的 Windows 桌面迁移预览。功能范围和验收进度以[项目规划](../../docs/PC_PLAN.md)与[手机功能对照](../../docs/MOBILE_PARITY.md)为准。
- 当前没有公开安装包或正式发行链接；应用自动更新未启用，应用提示为：“当前为绘世迁移预览版，尚未配置正式更新渠道。”请勿从上游项目页面下载文件并将其视为绘世发行版。
- Windows 用户数据隔离在 `%APPDATA%\NAI-WorldPainter-PC\`，设置文件名为 `worldpainter-desktop.json`。上游应用数据不会自动扫描或共用；旧 Flutter 工作区仅可通过设置中的显式导入流程迁移。

## 来源与许可

桌面实现基于 [Langbai NovelAI Studio 上游源码](https://github.com/2786886095/novelai-image-desktop)。上游作者署名及 MIT 许可保留在本目录的 [LICENSE](../LICENSE)，第三方组件归属见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。`upstream-reference/` 中的发行记录仅说明源项目历史，不代表本项目发布、可下载或已完成验收。

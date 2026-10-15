# 本机开发与工作区说明

> 当前目录是绘世 PC 的 Windows 桌面迁移预览。没有公开安装包或正式发行链接，自动更新未启用；请勿使用上游项目的发行附件作为绘世安装包。

## 查看当前产品说明

产品范围、功能矩阵与整体验收状态以 [PC 端 README](../../../README.md)、[PC 端规划](../../../docs/PC_PLAN.md) 和 [手机功能对照](../../../docs/MOBILE_PARITY.md) 为准。本目录的代码和测试属于迁移工作区，不能单独证明全量功能已验收或正式发行。

## 启动本机开发预览

在本目录安装项目依赖并启动 Electron 开发环境：

```powershell
npm ci
npm run dev
```

类型检查可运行 `npm run typecheck`。此流程用于本机开发与验收，不会下载或启用正式更新渠道。

## 数据目录

Windows 用户数据使用独立目录 `%APPDATA%\NAI-WorldPainter-PC\`，设置文件名为 `worldpainter-desktop.json`。程序不会自动扫描或共用 Langbai NovelAI Studio 的旧用户数据目录。旧 Flutter 工作区保留在原位置；如需迁移，使用应用设置中的“绘世资料”显式导入。

## 来源与许可

本桌面实现基于 [Langbai NovelAI Studio 上游源码](https://github.com/2786886095/novelai-image-desktop)，其 MIT 许可与作者署名保留在本目录的 [LICENSE](../../LICENSE)。[上游来源说明](../upstream-reference/README.md) 和[归档发行记录](../upstream-reference/RELEASE_NOTES.md)仅用于追溯来源，不代表绘世 PC 的发行或下载信息。

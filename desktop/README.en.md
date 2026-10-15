# NAI WorldPainter PC — desktop migration preview

This directory contains the in-progress Electron desktop migration preview for NAI WorldPainter PC. It is not a formal release.

- **Current documentation:** See the [PC project README](../README.md) for the current product overview and the [PC plan](../docs/PC_PLAN.md) for scope and acceptance status.
- **Releases and updates:** No public installer or formal release is available. Automatic updates are disabled. Upstream release downloads are not WorldPainter installers.
- **Separate data:** On Windows, user data is stored under `%APPDATA%\NAI-WorldPainter-PC\`; the settings file is `worldpainter-desktop.json`. The app does not automatically scan or share the upstream app's data directory. Import an older Flutter workspace only through the app's explicit import flow.
- **Source and license:** The desktop implementation is based on the [Langbai NovelAI Studio upstream source](https://github.com/2786886095/novelai-image-desktop). Its MIT license and attribution are retained in [LICENSE](./LICENSE); see the [upstream source note](./docs/upstream-reference/README.md). Archived upstream release history is source context only.
- **This project:** [NAI-WorldPainter-PC](https://github.com/liyi3068238601-oss/NAI-WorldPainter-PC).

Languages: [简体中文](./README.md) · [繁體中文](./README.zh-TW.md) · [English](./README.en.md) · [日本語](./README.ja.md) · [한국어](./README.ko.md)

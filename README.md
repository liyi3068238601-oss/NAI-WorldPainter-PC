# NAI WorldPainter PC 绘世桌面端

面向 Windows 的绘世创作客户端。**先完整移植手机端全部现有功能，再增加其他功能**，包括 NovelAI 官方与现有兼容网关、其他已接入生图服务、提示词助手、图库后期、漫画、本地超分和 Pixiv 工作流。

**最新批次：提示词素材管理已接入**，支持自建风格、预览图、画师多分组/加权组合、JSON 复制及 4,121 条 MIT 离线胶囊。全量 211 项测试、静态分析、Windows/Web Release 构建和 Windows 存储/凭据探针通过；实际 Windows 窗口已验证收藏保存、跨进程重开、负向胶囊追加与深浅主题，详见 [本批说明](docs/PROMPT_LIBRARY_REVIEW.md)。按用户本轮安排暂不增加生图渠道，未调用真实远端接口。内置风格/画师素材许可、手机完整词库对齐和助手主体仍待完成。

已有基础：**Flutter 三栏工作台已接入 NovelAI 官方/7877/ikun 请求链路、Windows 凭据保护、持久化图库、PNG 元数据选择性回填和 Vibe 编码库/缓存**。图库移除记录只更新索引；资产审计只读，恢复和清理需要显式操作。真实服务调用当前暂停，接口测试只使用 mock，未验收真实账号或费用行为。在线模型发现仍未实现；本地超分运行包及模型已通过独立脚本部署。上一资产批次记录为 190 项测试通过，最新结果见上文。上次内置浏览器检查缺少 `26.1007.21434` runtime；本批未重试浏览器交互，Web 构建不代表手动浏览器 QA 通过。GPT/Nano、WD-Tagger、M4 助手主体/M5 与其余完整手机端移植仍未完成。这不是全量移植完成版或正式安装包。

- [图生图与局部重绘](docs/IMAGE_EDITING_REVIEW.md)：裁切、蒙版绘制擦除、区域生成、结果图层、合成和回填。
- [报告核验与修复](docs/QA_REPAIR_REVIEW.md)：合成草稿、分块 Seed、PNG 导出和采样四项修复，145 项回归及浏览器/Windows 验证。
- [生成链路与凭据验证](docs/GENERATION_REVIEW.md)：本轮参数、凭据、图库、模拟接口与剩余边界。
- [图库资产生命周期与元数据审计](docs/ASSET_LIBRARY_REVIEW.md)：图库索引、受管文件恢复/清理、PNG 参数选择和 Vibe 库/缓存的当前边界。
- [原型验收记录](docs/PROTOTYPE_REVIEW.md)：实际交互、截图、自动化检查与明确限制。
- [持久化与 Windows 验证](docs/PERSISTENCE_REVIEW.md)：数据库重开、关闭前保存、中文路径与实际发布 exe 探针。
- [手机端逐项迁移顺序](docs/MOBILE_MIGRATION_NEXT.md)：下一批实现及仍需适配的平台能力。
- 开发环境：在 PC端 目录的 PowerShell 先设置 `$env:PUB_CACHE = Join-Path (Get-Location) '.tmp/pub-cache'`，再解析依赖或运行测试；避免缓存写到项目外。
- 浏览器预览：在本目录执行 `pwsh -File scripts/preview.ps1 -Build`，然后在内置浏览器打开 `http://127.0.0.1:5080/`。已构建时可省略 `-Build`；端口被占用可传 `-Port 5081`。
- Windows 构建：先运行 `flutter pub get`，再执行 `pwsh -File scripts/build-windows.ps1`（可传 `-FlutterPath`）；脚本解决当前 Flutter 工具链的中文构建路径问题。产物在 `build/windows/x64/runner/Release/worldpainter_pc.exe`，运行时保留完整 Release 目录，不能只复制 exe。
- Windows 凭据验证：构建后执行 `pwsh -File scripts/probe-credentials.ps1`，使用合成凭据跨两个隐藏进程验证写入、读取和删除，不触碰真实账号。
- Windows 存储验证：构建后执行 `pwsh -File scripts/probe-windows.ps1`，在本目录 `.tmp` 下启动两个隐藏的实际 exe 进程完成写入与重开校验。测试与构建串行运行，避免 SQLite DLL 占用。
- 本地开发数据：构建脚本将默认数据目录固定为本仓库 `data/desktop`（Git 忽略）；可用 `WORLDPAINTER_DATA_DIR` 覆盖。浏览器预览使用当前站点的 IndexedDB，与 exe 相互独立；清理站点数据会删除预览记录，请固定使用 5080 端口。
- Web SQLite 资产已锁定并纳入仓库；更新时执行 `pwsh -File scripts/setup-web-storage.ps1`，核对 [依赖与许可](docs/THIRD_PARTY.md) 后重新构建。
- 验证：`flutter test --no-pub`、`dart analyze lib test`。本机 `flutter analyze` 的分析服务器在中文目录触发 JSON 解析异常，Dart 分析器可正常完成检查。
- 工具链：Flutter 3.47.7 / Dart 3.13.5；本机 SDK 在父目录 `.tools/flutter`。依赖缓存、日志和构建产物分别放在本目录 `.tmp`、`build`，不提交到 Git。

- GitHub：<https://github.com/liyi3068238601-oss/NAI-WorldPainter-PC>（私有）
- 唯一工作目录：`E:\NAI-WorldPainter\PC端`
- [PC 端规划](docs/PC_PLAN.md)：目标、首版范围、交互、里程碑与验收。
- [手机端功能对照](docs/MOBILE_PARITY.md)：按功能记录来源、PC 等价行为和验收标准。
- [图片工具与后期审计](docs/IMAGE_TOOLS_REVIEW.md)：分块、Director、官方 Enhance/Upscale、本地超分的手机可达行为、协议和本轮 PC 进展。
- [设计方向](docs/DESIGN_DIRECTION.md)：界面、布局、动画与流畅感优先参考 NovelAI Local Web，其次浪白；保留绘世主色和风格。
- [实机交互调查](docs/REFERENCE_UI_REVIEW.md)：内置浏览器中的真实界面操作、模拟服务边界、截图与借鉴结论。
- [技术路线](docs/ARCHITECTURE.md)：Flutter Windows 为当前路线；SQLite、凭据及 Release 构建已验证，其他原生平台能力继续逐项验收。
- [调查与复用清单](docs/RESEARCH.md)：现有代码、官方资料、来源和复用边界。

NovelAI Local Web 与浪白同时是功能实现代码参考：逐项评估成熟模块的复用/适配，不从零重复实现已有可靠方案。新增功能仍在全量移植验收后开展。

全量移植首版完成应意味着：手机端现有能力逐项在 PC 上可达、可用、可持久化并经过验收。仅完成生图流程属于中间开发版本，不能称为移植完成；模拟接口通过不能代替真实服务兼容性验证。

当前包含自行实现的 PC 界面、业务与平台适配、调查证据和本地预览工具；未直接导入手机端或参考项目的业务实现。主工作区示意风景是程序绘制的占位画面，不是 AI 生成结果。首要参考克隆在用户指定的 `E:\NAI-WorldPainter\novelai_local_web`，浪白克隆在被忽略的 `.tmp/` 内。项目发行许可证待确定；字体、脚手架和图标来源见 [第三方记录](docs/THIRD_PARTY.md)。

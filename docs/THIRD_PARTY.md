# 原型来源与许可

日期：2026-10-11。产品整体发行许可证仍待确定；以下第三方内容保留其原有许可。

| 内容 | 固定来源 | 许可与处理 |
| --- | --- | --- |
| Flutter Windows/Web runner 脚手架、Flutter SDK | Flutter 3.47.7，`abaf9c523780a608bd46686fd5e53740a07077f8`，由 `flutter create --empty --platforms=windows,web` 生成 | BSD-3-Clause；保留生成文件声明及 `licenses/FLUTTER_LICENSE.txt`；运行时依赖声明由 Flutter 的 NOTICES 资产汇总 |
| Noto Sans SC 可变字体 | [Google Fonts 固定提交](https://github.com/google/fonts/tree/2894aab31764f10f29c421bdfd2340d3b382d384/ofl/notosanssc)，原文件 `NotoSansSC[wght].ttf`，本地只改文件名 | SIL OFL 1.1；未裁剪或修改字体内容，保留 `assets/fonts/OFL.txt`；完整本地字体支持中文输入，不请求网络字体 |
| 绘世几何画笔图标 | `scripts/generate-icons.py` | 本项目新绘制；不是参考项目图标 |
| 月下远山、晴岚山谷、落日海岸 | `lib/prototype/scene_art.dart` | 本项目原创程序示意画；不是 AI 生成结果或外部作品 |
| 灵感胶囊词库 | [NovelAI Studio 固定提交](https://github.com/2786886095/novelai-image-desktop/tree/2d609393c3902874afae5200c26165d86b76055f) 的 `mobile/assets/capsule_taxonomy.json`，由 `src/prompt-data.ts` 与 `src/capsule-data.ts` 合并生成 | MIT，Copyright (c) 2026 Langbai；保留 `licenses/CAPSULES_MIT.txt` 并随 Windows/Web 资产打包。只转换为扁平 JSON，未引入 GPL Danbooru CSV。来源、转换及 SHA-256 见 [记录](evidence/prompt-library/capsule-source.json) |

字体 SHA-256：`A3041811A78C361B1DE50F953C805E0244951C21C5BD412F7232EF0D899AF0DA`。
OFL 文件 SHA-256：`1C05C68C34F9708415AADA51F17E1B0092D2CEA709BF4A94CD38114F9E73D7D9`。
已重新下载上述固定提交中的字体，与工作区文件校验一致。

SQLite 持久化依赖锁定于 `pubspec.lock`。Windows 使用 `sqflite_common_ffi` 原生 FFI 后端作为生产存储路径；`sqflite_common_ffi_web` 仅用于实验性浏览器预览。

| 包 | 固定版本 | 用途 | 许可副本 |
| --- | --- | --- | --- |
| `sqflite_common` | 2.5.13+1 | SQLite 公共 API | BSD-2-Clause；[上游](https://github.com/tekartik/sqflite/tree/master/sqflite_common)，[许可证副本](../licenses/dependencies/sqflite_common-2.5.13+1-LICENSE.txt) |
| `sqflite_common_ffi` | 2.4.3 | Windows 原生 FFI 存储后端 | BSD-2-Clause；[上游](https://github.com/tekartik/sqflite/tree/master/sqflite_common_ffi)，[许可证副本](../licenses/dependencies/sqflite_common_ffi-2.4.3-LICENSE.txt) |
| `sqflite_common_ffi_web` | 1.2.0 | 实验性浏览器预览后端及 worker setup | BSD-2-Clause；[上游](https://github.com/tekartik/sqflite/tree/master/packages_web/sqflite_common_ffi_web)，[许可证副本](../licenses/dependencies/sqflite_common_ffi_web-1.2.0-LICENSE.txt) |
| `sqlite3` | 3.7.0 | FFI/Web SQLite 绑定及 Web WASM 发布资产 | MIT；[上游](https://github.com/simolus3/sqlite3.dart/tree/main/sqlite3)，[许可证副本](../licenses/dependencies/sqlite3-3.7.0-LICENSE.txt)。WASM 中的 SQLite 引擎按 [SQLite 官方说明](https://sqlite.org/copyright.html) 属于公有领域。 |
| `path` | 1.9.1 | 路径处理 | BSD-3-Clause；[上游](https://github.com/dart-lang/core/tree/main/pkgs/path)，[许可证副本](../licenses/dependencies/path-1.9.1-LICENSE.txt) |
| `crypto` | 3.0.7 | 哈希等加密工具 | BSD-3-Clause；[上游](https://github.com/dart-lang/core/tree/main/pkgs/crypto)，[许可证副本](../licenses/dependencies/crypto-3.0.7-LICENSE.txt) |

`web/sqflite_sw.js` 由 `sqflite_common_ffi_web 1.2.0` 官方 setup 生成。其 setup 子项目锁定 `sqlite3 3.7.0`；本仓库的 `web/sqlite3.wasm` 来自 sqlite3.dart 的 3.7.0 官方 release，替换 setup 默认的 3.6.0 WASM。固定包归档校验和、许可证副本校验和、Web 资产大小与 SHA-256 记录在 [`dependency-assets.json`](evidence/persistence/dependency-assets.json)。

其他间接包的固定版本见 `pubspec.lock`，Flutter SDK 及其余 SDK 组件的通知见 Flutter `NOTICES` 资产。

许可证副本按原始字节保留；`path` 许可证第一行自带一个尾空格，未为消除 Git 空白提示而改动上游原文。生成的 worker 固定为 LF，避免 Windows checkout 改变已记录的资产哈希。

本轮参考 NovelAI Local Web 的三栏分工、独立参数滚动、固定生成区、大提示词编辑器与图库往返体验。没有复制其 AGPL 实现、浪白实现或手机端业务代码。后续引入业务代码仍需逐模块登记许可。

实现依据：[Flutter 响应式布局](https://docs.flutter.dev/ui/adaptive-responsive)、[Flutter Web 无障碍](https://docs.flutter.dev/ui/accessibility/web-accessibility)。浏览器预览与 Windows 使用同一套 Flutter 界面代码；前者的成功不替代原生平台验收。

## Windows 本地超分运行时

Windows 本地 SR 使用官方 ncnn Vulkan 便携发行包，不依赖 CUDA、PyTorch、Android .so 或外部 Python 环境。固定 Real-ESRGAN ncnn-vulkan v0.2.5.0 与 Real-CUGAN ncnn-vulkan 20220728，只安装动漫 x4 模型和保守型 2x/4x 模型。安装脚本在解包前验证固定归档长度和 SHA-256，并只提取指定可执行文件、运行库与模型；下载归档和生成运行时留在 .tmp/sr-runtime 忽略目录。

| 运行时 | 上游代码 / 模型许可 | 许可副本 |
| --- | --- | --- |
| [Real-ESRGAN ncnn-vulkan v0.2.5.0](https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan/releases/tag/v0.2.5.0) | 实现 MIT；上游动漫模型 BSD-3-Clause | [实现许可](../licenses/REAL_ESRGAN_NCNN_VULKAN_MIT.txt)、[模型许可](../licenses/REAL_ESRGAN_MODEL_BSD-3-CLAUSE.txt) |
| [Real-CUGAN ncnn-vulkan 20220728](https://github.com/nihui/realcugan-ncnn-vulkan/releases/tag/20220728) | 实现与模型 MIT | [实现许可](../licenses/REAL_CUGAN_NCNN_VULKAN_MIT.txt)、[模型许可](../licenses/REAL_CUGAN_MODEL_MIT.txt) |
| 上游打包的 ncnn、libwebp、stb、dirent | BSD-3-Clause / MIT / Public Domain，按上游声明 | licenses/NCNN_BSD-3-CLAUSE.txt、LIBWEBP_BSD-3-CLAUSE.txt、STB_MIT_OR_PUBLIC_DOMAIN.txt、DIRENT_MIT.txt |
| Microsoft VCOMP140 OpenMP runtime | Real-ESRGAN / Real-CUGAN Windows ZIP 内未修改的 vcomp140.dll；随部署分发须遵守 [Visual Studio 2022 Redistribution](https://learn.microsoft.com/en-us/visualstudio/releases/2022/redistribution) 许可条件 | setup 脚本不提取 vcomp140d.dll 调试运行库；已核对 vcomp140.dll 的 Microsoft Authenticode 签名 |

运行时归档 URL、归档 SHA-256、模型来源和手机端模型逐项比对记录在 [local-sr-runtime-manifest.json](evidence/local-sr-runtime-manifest.json)。GitHub release 未提供归档校验和；项目固定下载后核得的 SHA-256，并在独立安装脚本中校验。Real-CUGAN 归档哈希另与 Scoop 官方清单交叉核对。

运行 PowerShell 命令 scripts/setup-super-resolution.ps1 可准备开发运行时。桌面集成可将运行时放入 data/sr；后续构建脚本是否捆绑由构建配置单独决定。

## 生成链路新增依赖

依赖来自 pub.dev 官方包分发，固定版本和包归档 SHA-256 见 pubspec.lock；以下副本保留原字节。

| 包 | 固定版本 | 用途 / 许可 |
| --- | --- | --- |
| [archive](https://pub.dev/packages/archive/versions/4.5.1) | 4.5.1 | 官方 ZIP 响应；MIT，另保留 LICENSE-other 内第三方声明；licenses/dependencies/archive-4.5.1-LICENSE*.txt |
| [posix](https://pub.dev/packages/posix/versions/6.5.2) | 6.5.2 | archive 间接依赖；MIT；licenses/dependencies/posix-6.5.2-LICENSE.txt |
| [http](https://pub.dev/packages/http/versions/1.6.0) | 1.6.0 | 原生 / 浏览器请求；BSD-3-Clause；licenses/dependencies/http-1.6.0-LICENSE.txt |
| [web](https://pub.dev/packages/web/versions/1.1.1) | 1.1.1 | 浏览器图片选择；BSD-3-Clause；licenses/dependencies/web-1.1.1-LICENSE.txt |

生成协议按手机端行为、官方文档和参考项目调查独立实现，未整块移入手机端或 AGPL 项目代码。Windows 凭据使用微软系统 CredWriteW/CredReadW/CredDeleteW，不引入外部原生插件。脚本 mock-image-service.py 的测试图为本项目程序生成几何图，画面明确标注 LOCAL MOCK。

# 原型来源与许可

日期：2026-10-11。产品整体发行许可证仍待确定；以下第三方内容保留其原有许可。

| 内容 | 固定来源 | 许可与处理 |
| --- | --- | --- |
| Flutter Windows/Web runner 脚手架、Flutter SDK | Flutter 3.47.7，`abaf9c523780a608bd46686fd5e53740a07077f8`，由 `flutter create --empty --platforms=windows,web` 生成 | BSD-3-Clause；保留生成文件声明及 `licenses/FLUTTER_LICENSE.txt`；运行时依赖声明由 Flutter 的 NOTICES 资产汇总 |
| Noto Sans SC 可变字体 | [Google Fonts 固定提交](https://github.com/google/fonts/tree/2894aab31764f10f29c421bdfd2340d3b382d384/ofl/notosanssc)，原文件 `NotoSansSC[wght].ttf`，本地只改文件名 | SIL OFL 1.1；未裁剪或修改字体内容，保留 `assets/fonts/OFL.txt`；完整本地字体支持中文输入，不请求网络字体 |
| 绘世几何画笔图标 | `scripts/generate-icons.py` | 本项目新绘制；不是参考项目图标 |
| 月下远山、晴岚山谷、落日海岸 | `lib/prototype/scene_art.dart` | 本项目原创程序示意画；不是 AI 生成结果或外部作品 |

字体 SHA-256：`A3041811A78C361B1DE50F953C805E0244951C21C5BD412F7232EF0D899AF0DA`。
OFL 文件 SHA-256：`1C05C68C34F9708415AADA51F17E1B0092D2CEA709BF4A94CD38114F9E73D7D9`。
已重新下载上述固定提交中的字体，与工作区文件校验一致。

依赖锁定见 `pubspec.lock`；当前没有业务第三方包，运行时直接依赖 Flutter SDK，测试使用 flutter_test/flutter_lints 及其锁定依赖。

本轮参考 NovelAI Local Web 的三栏分工、独立参数滚动、固定生成区、大提示词编辑器与图库往返体验。没有复制其 AGPL 实现、浪白实现或手机端业务代码。后续引入业务代码仍需逐模块登记许可。

实现依据：[Flutter 响应式布局](https://docs.flutter.dev/ui/adaptive-responsive)、[Flutter Web 无障碍](https://docs.flutter.dev/ui/accessibility/web-accessibility)。浏览器预览与 Windows 使用同一套 Flutter 界面代码；前者的成功不替代原生平台验收。

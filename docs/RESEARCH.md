# 绘世 PC 调查与复用清单

调查日期：2026-10-11。以下区分本轮源码检查、既有审计结论和后续待验证项。

## 当前材料

| 材料 | 固定来源 | 本轮确认 | 用途 |
| --- | --- | --- | --- |
| 手机端 | `../手机端`；[上游](https://github.com/sakiko0901/NAI-WorldPainter)；HEAD `bd530001a80a32aa1e1b39653275a59f7ec5fd18` | Flutter，pubspec `1.2.3+212014`，含 Android，无已跟踪 Windows runner；有用户未提交 UI 改动 | 功能清单、协议分流、领域模型与平台差异 |
| 参考 Web | `../参考资料/novelai_local_web`；[上游](https://github.com/YILING0013/novelai_local_web)；HEAD `aa0fcbe477eae0a703ec47740785f9419d7d5cbe` | React/Next 前端与 Flask 后端；工作区 Git 状态干净；带 AGPL-3.0 文件 | 本地图库、元数据另存、参数测试用例设计 |
| 既有功能审计 | `../NAI-WorldPainter_2026-10-10.md` | 同一手机端提交的审计与建议；不是本次运行证据 | 资产归属、参数协议、Seed、助手版本与检索预算 |

本轮未执行手机端或参考 Web 的构建、测试和真实服务调用。未复制源码、示例图、模型和提示词资产。手机端 README 标注 MIT，但根目录与 Git 跟踪树没有 LICENSE；GitHub 仓库 API 的 license 字段为 null，不能据此完成代码复用许可确认。局部素材附带的许可证不自动覆盖整个应用。后续若要复制，先补全来源与许可记录。

## 可以直接转化为 PC 需求的发现

| 代码位置（相对手机端） | 发现 | PC 中的具体处理 |
| --- | --- | --- |
| `lib/data/repositories/generation_repository_impl.dart` | 已存在渠道分流与凭据解析 | 保留官方/网关独立适配的思路；不共用鉴权 client |
| `lib/data/datasources/remote/official_novelai_api_service.dart` 与 `novelai_api_service.dart` | 官方和多种网关有不同请求逻辑 | 为每种协议建立脱敏请求/响应样本和能力矩阵 |
| `lib/domain/entities/generation_task.dart` | 参数、角色、参考、重绘已有领域表达 | 定义不可变提交快照，不能只保存当前 UI 状态 |
| `lib/core/queue/generation_queue.dart` | 串行任务有现成业务场景 | PC 首版保持串行，另补状态持久化与不确定结果处理 |
| `lib/data/datasources/local/database_helper.dart`、`pubspec.yaml` | sqflite；FFI 当前只在开发依赖 | Flutter 候选需补 Windows 运行时初始化，不能直接宣称跨平台完成 |
| `lib/domain/usecases/save_image.dart` | 手机保存到相册 | PC 明确保存目录、同名冲突与文件管理器入口 |
| `lib/core/services/background_keepalive_service.dart` | Android 前台服务 | PC 单独处理进程生命周期、窗口关闭与任务恢复 |
| `lib/data/datasources/super_resolution_channel.dart` 与 Android Kotlin 插件 | 本地超分依赖 Android 原生通道 | 首版不照搬；以后使用 Windows 后端并另核模型许可 |

参考 Web 的 `nai_flask/tests/test_payload_baseline.py` 展示了按模型和动作检验请求字段及不支持组合的办法。PC 将自行编写等价目的的契约测试，不把参考项目的当前枚举当成官方最新能力。`README.md` 中图库分组、可恢复删除、元数据另存和原件保留可直接转化为 PC 验收场景。

## 同类实现与官方依据

| 来源 | 当前证据范围 | 下一步如何使用 |
| --- | --- | --- |
| [浪白 NovelAI Studio](https://github.com/2786886095/novelai-image-desktop) | 本轮 GitHub API 确认仓库存在并识别 MIT；已有审计描述 Electron 和提示词审核设计 | M1 读取固定版本的相关源码与 LICENSE，评估局部复用；未复制 |
| [NAIWeaver](https://github.com/ststoryweaver/NAIWeaver) | 本轮 GitHub API 确认 MIT 及 Android/Windows/Linux/Web 项目描述 | Flutter 路线候选；研究能力表与桌面组织方式，不能据项目描述推断已测试 |
| [Flutter Windows](https://docs.flutter.dev/platform-integration/windows/setup) | 本轮打开官方开发环境说明 | 确认 Flutter/C++ 构建条件，列入 M1 成本比较 |
| [Electron security](https://www.electronjs.org/docs/latest/tutorial/security) | 本轮打开官方安全边界文档 | 转化为 IPC、renderer 与外链验收要求 |
| [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) | 本轮打开 Windows 前提说明 | 比较 Rust、C++ 工具链与 WebView2 成本 |
| [NovelAI 账号文档](https://docs.novelai.net/en/text/usersettings/account/) | 官方说明 Persistent API Token 与轮换行为 | 首版只需用户提供 Token，避免复制密码登录流程 |
| [NovelAI 图像 API](https://image.novelai.net/docs/index.html) | 确認文档入口；本轮文本抓取未取得动态 Swagger schema | M1 获取真实协议定义，核对模型/参数/响应；不能称接口已实测 |

## 后续引入记录

每个真正引入的外部模块或资产至少记录：来源 URL、commit/版本、完整文件 SHA-256、许可文件、署名要求、具体使用路径和修改说明。只借鉴交互时记录行为和对应验收；不把参考项目的商标、示例图或内置素材一起复制。

手机端未提交的 UI 调整属于当前工作现场，不能当成固定上游版本分发。后续若需要借鉴其最新效果，先明确具体文件与变更来源，再决定如何接入独立 PC 仓库。

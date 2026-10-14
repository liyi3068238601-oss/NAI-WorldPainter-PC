# 绘世 PC 调查与复用清单

调查日期：2026-10-11。以下区分本轮源码检查、既有审计结论和后续待验证项。

用户确定：PC 界面、布局、动画与流畅感优先参考 NovelAI Local Web，其次浪白。手机端决定最低功能范围，绘世现有主题决定视觉风格，参考项目不自动决定后端架构。

用户进一步明确两个参考项目的**功能实现代码也可借鉴**。下列模块是已定位的调查候选，不是已验证或已导入的代码：

| 来源 | 已定位实现/测试 | 对应移植用途 |
| --- | --- | --- |
| NovelAI Local Web | `nai_flask/api_utils/novelai_payload_builder.py`、`novelai_client.py`、`tests/test_payload_baseline.py` | 官方请求构造、参数组合与契约测试 |
| NovelAI Local Web | `nai_flask/api_utils/image_metadata.py`、`local_image_library.py`、`image_validation.py` | 元数据解析、图库持久化、图片输入校验 |
| NovelAI Local Web | `nai_flask/api_utils/local_inference.py`、`image_inference.py` | Windows 本地图像处理后端的参考；不能直接假定覆盖手机全部模型 |
| 浪白 | `src/prompt-template-audit.ts` 及对应测试 | 提示词语义/权重/用户事实保护；已阅读文件开头的规则实现 |
| 浪白 | `src/metadata-selection.ts`、`metadata-replay.ts` 及测试 | 参数选择应用与元数据回填 |
| 浪白 | `src/comic/project-store.ts`、`generation-queue.ts`、`candidate-result.ts` 及测试 | 漫画项目、任务归属与候选图工作流 |

实施时逐项记录“直接复用 / 组合调用 / 局部改造 / 借鉴后实现”的选择及依据，核对固定提交、LICENSE、依赖、输入输出、测试和修改范围。首要参考带 AGPL-3.0 文件，浪白代码带 MIT 文件，实际引入需满足对应许可与署名；本轮没有复制这些模块进入产品。参考项目独有功能进入全量移植之后的新增候选，不自动扩大当前范围。

## 当前材料

| 材料 | 固定来源 | 本轮确认 | 用途 |
| --- | --- | --- | --- |
| 首要界面参考新克隆 | `E:\NAI-WorldPainter\novelai_local_web`；[上游](https://github.com/YILING0013/novelai_local_web)；HEAD `aa0fcbe477eae0a703ec47740785f9419d7d5cbe` | 用户指定位置已完成完整 Git 克隆，origin 与干净状态已核对；已查看工作台截图 | PC 界面、布局、动画与流畅感的第一参考 |
| 手机端 | `../手机端`；[上游](https://github.com/sakiko0901/NAI-WorldPainter)；HEAD `bd530001a80a32aa1e1b39653275a59f7ec5fd18` | Flutter，pubspec `1.2.3+212014`，含 Android，无已跟踪 Windows runner；有用户未提交 UI 改动 | 功能清单、协议分流、领域模型与平台差异 |
| 参考 Web | `../参考资料/novelai_local_web`；[上游](https://github.com/YILING0013/novelai_local_web)；HEAD `aa0fcbe477eae0a703ec47740785f9419d7d5cbe` | React/Next 前端与 Flask 后端；工作区 Git 状态干净；带 AGPL-3.0 文件 | 本地图库、元数据另存、参数测试用例设计 |
| 既有功能审计 | `../NAI-WorldPainter_2026-10-10.md` | 同一手机端提交的审计与建议；不是本次运行证据 | 资产归属、参数协议、Seed、助手版本与检索预算 |

手机端未构建。首要参考新克隆已完成前端构建，并通过上游测试注入接口启动本地演示；内置浏览器操作与范围见 [实机调查](REFERENCE_UI_REVIEW.md)，真实付费服务未调用。没有复制参考实现、示例图、模型或提示词资产进入 PC 产品提交。新克隆与旧 `参考资料` 副本当前提交一致，旧副本保持原位。手机端 README 标注 MIT，但根目录与 Git 跟踪树没有 LICENSE；GitHub 仓库 API 的 license 字段为 null，不能据此完成代码复用许可确认。局部素材附带的许可证不自动覆盖整个应用。后续若要复制，先补全来源与许可记录。

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
| `lib/data/datasources/super_resolution_channel.dart` 与 Android Kotlin 插件 | 本地超分依赖 Android 原生通道 | 全量移植首版必须实现 Windows 等价后端，核对模型许可并验证实际输出 |

参考 Web 的 `nai_flask/tests/test_payload_baseline.py` 展示了按模型和动作检验请求字段及不支持组合的办法。PC 将自行编写等价目的的契约测试，不把参考项目的当前枚举当成官方最新能力。`README.md` 中图库分组、可恢复删除、元数据另存和原件保留可直接转化为 PC 验收场景。

## 同类实现与官方依据

| 来源 | 当前证据范围 | 下一步如何使用 |
| --- | --- | --- |
| [浪白 NovelAI Studio](https://github.com/2786886095/novelai-image-desktop) | 已克隆 `2d609393c3902874afae5200c26165d86b76055f`，读取 MIT 文件、AppChrome、AppTabBar、navigation 与布局 CSS，查看 README 的旧版实际截图 | 第二参考；研究任务导航与画布/历史分区，不复制品牌和配色 |
| [NAIWeaver](https://github.com/ststoryweaver/NAIWeaver) | 本轮 GitHub API 确认 MIT 及 Android/Windows/Linux/Web 项目描述 | Flutter 路线候选；研究能力表与桌面组织方式，不能据项目描述推断已测试 |
| [Flutter Windows](https://docs.flutter.dev/platform-integration/windows/setup) | 本轮打开官方开发环境说明 | 确认 Flutter/C++ 构建条件，列入 M1 成本比较 |
| [Electron security](https://www.electronjs.org/docs/latest/tutorial/security) | 本轮打开官方安全边界文档 | 转化为 IPC、renderer 与外链验收要求 |
| [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) | 本轮打开 Windows 前提说明 | 比较 Rust、C++ 工具链与 WebView2 成本 |
| [NovelAI 账号文档](https://docs.novelai.net/en/text/usersettings/account/) | 官方说明 Persistent API Token 与轮换行为 | 首版只需用户提供 Token，避免复制密码登录流程 |
| [NovelAI 图像 API](https://image.novelai.net/docs/index.html) | 确认文档入口；本轮文本抓取未取得动态 Swagger schema | M1 获取真实协议定义，核对模型/参数/响应；不能称接口已实测 |

## 后续引入记录

每个真正引入的外部模块或资产至少记录：来源 URL、commit/版本、完整文件 SHA-256、许可文件、署名要求、具体使用路径和修改说明。只借鉴交互时记录行为和对应验收；不把参考项目的商标、示例图或内置素材一起复制。

手机端未提交的 UI 调整属于本次本地功能基线，不能当成固定上游版本分发。文件指纹和差异状态记录在 [功能矩阵](MOBILE_PARITY.md) 及其源码 manifest 中；后续引入时仍须保留来源与边界。

## 2026-10-14 记忆批次调查

只读调查手机同一 HEAD 的记忆实体、管理用例、SQLite repository、页面/ViewModel 与 get/save 工具。采用候选审核、替代历史和类型/来源语义，自行实现 PC 模型和交互；修正新条目进入过期清理的问题，并记录标签型内容规范化差异。未复制第三方业务代码、增加依赖或素材。Flutter 弹窗生命周期官方依据、文件指纹和实际验证见 [记忆批次](ASSISTANT_KNOWLEDGE_REVIEW.md)。
## 2026-10-14 标签服务协议补充

手机现有 Danbooru 搜索实际连接第三方中文语义索引。对照 GitHub `SuzumiyaAkizuki/ComfyUI-DanbooruSearcher` commit `3522854610d9cb51193ffcdd5b9a3059d4a686be` 与 HF `SAkizuki/DanbooruSearch` commit `427a3c377821367f83a1f3c141c15fdfcb290bd2` 核对了 `/api/search` 请求/响应。前者未找到根许可证，后者 LICENSE 为 GPL v3；没有复制第三方代码、模型或词库。本批独立实现客户端，不宣称官方实时标签校验，也未验证服务当前在线性、匿名配额或 Key 政策。固定版本链接、行为差异和证据见 [标签搜索报告](TAG_SEARCH_REVIEW.md)。

## 2026-10-14 提示词知识与应用调查

只读复核手机版本选择、V5 动态参考工具与未接线的文本解析器，并比较浪白的提案预览/陈旧内容检查。手机技能包 GPLv3，未复制社区语料；PC 采用官方文档的独立摘要，记录模型页与文字页的单位冲突。固定参考版本、文件 SHA-256、许可边界和实际移植差异见 [来源记录](PROMPTING_SOURCES.md)，实现与验证见 [批次报告](PROMPTING_REVIEW.md)。

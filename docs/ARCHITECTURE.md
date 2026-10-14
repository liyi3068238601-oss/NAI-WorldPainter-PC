# 绘世 PC 技术路线比较

方案版本：0.5。实施状态更新：2026-10-13。Flutter 三栏工作台、SQLite 自动保存、Windows 凭据、生成链路和图库资产能力已实现到部分业务路径；平台、全量业务及正式验收仍未完成。

用户已明确先完整移植手机端全部功能。根据源码审查与 [内置浏览器实机体验](REFERENCE_UI_REVIEW.md)，下一步采用 **Flutter Windows 复用业务、独立重做桌面表现层**。参考中的多栏、标签、提示词编辑和蒙版交互没有显示必须依赖 React 的能力；业务完整性仍是选型的首要依据。Electron 为有触发条件的后备，不同时开发两套完整客户端。

NovelAI Local Web 是用户指定的界面、布局、动画和流畅感首要参考，浪白为第二参考。这是桌面体验优先级，不要求移植其 Flask/Next.js 后端，也不替代手机端全部功能。

两者同时可作功能实现代码参考。选型需要计算可合法复用模块带来的实际收益；不能只比较“Flutter 原样复制”和“Electron 全部从零重写”。同一功能可选择成熟模块移植、调用独立组件或自行实现，前提是依赖、许可证、部署复杂度与行为测试均可接受。

## 候选方案

| 方案 | 当前可利用的基础 | 需要承担的成本 | 结论 |
| --- | --- | --- | --- |
| Flutter Windows | 手机端已有 Dart 领域模型、请求适配、Agent、漫画及数据库结构 | 根许可证待核实；Windows runner、SQLite、相册保存、后台任务和本地超分要适配；桌面 UI 重做 | 当前实施路线，M1 验证高风险能力 |
| Electron + React + TypeScript | 浪白现有 MIT 的 NAI 请求、元数据回填、漫画队列可适配 | Dart 业务需迁移或逐项找到等价实现；数据模型和 IPC 不可原样套用；原生模块需验证 | 关键用例失败且成本不可接受时启用的后备 |
| Tauri + React + Rust | Web 前端和 Rust 桌面命令；使用系统 WebView | Rust 与 TS 双栈；Windows 构建工具和 WebView2；双接入及桌面插件需验证 | 后续若体积或系统资源要求更严格，可重新评估 |
| 本地 Web + Python | 首要界面参考已有 React/Flask 工作流 | 双运行时、端口/生命周期/打包；仍需补齐手机端其他功能；现有参考为 AGPL | 研究界面实现；参考优先级不代表采用其整套技术栈 |

Flutter 的复用优势目前是基于源码结构的判断，尚未测得移植工时。M1 先验证全渠道请求与图片解析、蒙版栅格化、SQLite 重开、Agent 工具调用、漫画导出、Pixiv 队列和 Windows 本地超分。若出现不可接受的阻碍，再对同一失败用例实现 Electron 对照并记录成本；不采用未经验证的 Dart/Node 常驻桥掩盖重写成本。

Flutter 官方要求 Windows 开发环境与 C++ 桌面构建工具；Tauri Windows 开发涉及 C++ 构建工具、Rust 与 WebView2。参见 [Flutter Windows](https://docs.flutter.dev/platform-integration/windows/setup) 与 [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)。本机已实查 Flutter 3.47.7、Dart 3.13.5、VS 2022 C++ 桌面工具与 Windows SDK；原生依赖和清洁环境安装仍需逐项验证。

## 当前 PC 实现边界

`lib/main.dart` 先恢复工作区再显示绘世主题；`lib/prototype/workbench.dart` 和 `workbench_controller.dart` 管理桌面工作区、草稿参数、任务结果、图库索引、保存/恢复及资产维护。生成请求已接入 NovelAI 官方、7877 与 ikun 适配，但真实服务调用当前暂停，验证只使用 mock。`scene_art.dart` 提供无外部素材的示意画。`lib/storage/` 使用 schema 1 的 PC SQLite 数据库与修订号 CAS；它不是手机端 v22 业务数据库移植，其他数据域和完整手机业务仍需逐项迁移。

Windows 与 Web 预览复用同一 Flutter UI。Web 仅作为内置浏览器中的设计验收入口，不增加另一套 React 产品。图片处理、SQLite、文件对话框、凭据和超分以 Windows 原生探针单独验证。

## 建议模块边界

```text
桌面界面：工作台 / 图库与工具 / 队列 / 助手 / 漫画 / Pixiv / 设置
    ↓ 受限且经过校验的桌面命令
应用服务：草稿版本 / 任务调度 / 资产保存 / 后期 / 提示词与记忆 / 漫画 / 发布
    ↓
领域契约：GenerationSpec / CapabilityProfile / GenerationPlan
    ↓
独立适配器：NovelAI 官方 / 全部现有网关 / GPT / Nano Banana / LLM / Pixiv / 标签
    ↓
本地基础设施：SQLite / 文件 / 凭据 / Windows 超分 / 脱敏日志
```

领域模块应避免依赖窗口和具体供应商 HTTP client。复用手机业务前逐个识别 Flutter、dart:ui、文件和平台插件依赖，不将现有 domain 目录全部误称纯 Dart。第一版采用单一应用与清晰目录，不为潜在未来扩展建立 monorepo 或插件宿主。

Flutter 候选保持 `lib/domain/`、`lib/data/` 和现有用例组织，PC 表现层独立，平台实现集中提供数据库、文件保存、任务生命周期、凭据和超分适配。仓库保持独立，不使用指向相邻手机目录的运行时依赖。正式引入代码时固定来源和许可、保留署名，之后同步通过明确的补丁和测试完成。

Electron 候选目录：`src/main/` 负责桌面与应用服务，`src/preload/` 提供最小 IPC 桥，`src/renderer/` 提供 React 界面，`src/domain/` 存放纯类型与规则，`src/providers/` 放置渠道协议，`src/storage/` 管理资产和数据库，`tests/` 存放契约与流程用例。这些目录尚未创建。

## 双接入契约

官方采用用户主动提供的 Persistent API Token。账号文档说明可以取得此 Token，重新生成会使旧 Token 失效；应用不应自动替用户轮换。参考 [NovelAI 账号文档](https://docs.novelai.net/en/text/usersettings/account/)。账号和图像接口分别查阅 [账号 API](https://api.novelai.net/docs/) 与 [图像 API](https://image.novelai.net/docs/index.html)，动态 Swagger 页面仍需在实现时进一步读取实际 schema。

网关不是一种统一协议。用 `protocolId + providerId + modelId + operation` 解析能力，配置中区分地址和协议。模型列表能返回不表示生成、参考图、重绘和超分已兼容。官方 Token 不能发送到网关，网关 Key 不能进入官方请求。

两类适配器都返回统一的图片结果与错误分类，但保留原始协议的必要诊断字段。任务保存适配前快照与实际生效参数；下载结果图使用独立客户端，跨 origin 跳转不得继承供应商鉴权头。能力不支持时在发送前报出具体字段。

## 桌面与数据边界

候选 Electron 实现应开启 context isolation 与 renderer sandbox，关闭 renderer Node integration，采用受限 CSP、校验 IPC 来源与参数、限制导航和外链。凭据只通过受控服务使用，保存前走系统保护能力；普通设置与日志不存明文秘密。文件对话框选定的目录与资产 ID 是文件操作边界，不向渲染层暴露任意文件读写命令。参见 [Electron 安全文档](https://www.electronjs.org/docs/latest/tutorial/security)。

SQLite 已采用锁定的 `sqflite_common_ffi 2.4.3` / `sqlite3 3.7.0`，Windows 在后台 isolate 执行数据库操作。Web 预览采用 `sqflite_common_ffi_web 1.2.0` 的 SharedWorker + IndexedDB，属于实验性预览实现，不作为正式 Windows 存储。保存使用事务和 revision CAS；失败保留内存状态并阻止正常关窗，过新或损坏数据库不自动重置。详见 [持久化验证](PERSISTENCE_REVIEW.md)。`lib/generation` 提供独立请求协议，`lib/security` 提供 Windows Credential Manager 通道，`lib/media` 以经过验证的内容寻址引用存储图片，字节先验证并原子落盘，再写图库索引；Web 凭据只在内存保存，浏览器图片存入独立 assets.sqlite。`lib/metadata` 当前实现 PNG 参数解析与选择字段回填；未选字段和图片里缺失的字段保留当前值。`lib/references` 保存命名 Vibe 与有界编码缓存。详见 [生成链路审计](GENERATION_REVIEW.md) 和 [资产生命周期审计](ASSET_LIBRARY_REVIEW.md)。

图库删除分成索引和文件两个明确操作。删除/清空图库记录只提交索引变化并清空不再有效的选择，不直接删除图像文件；此行为与手机端既有 `clearHistory` 语义一致。`ImageAssetMaintenance` 是可选接口，避免要求所有 `ImageAssetStore` 测试替身都支持维护。只读审计递归收集序列化数据中的精确有效资产引用，并通过 store 的读取校验检查缺失/损坏；未引用文件只能在用户明确批准后清理。IO 实现只枚举受管 SHA-256 命名空间的普通文件，对引用格式、目录类型及解析后路径做约束；清理前先保存工作区并再次检查引用。应用不做自动垃圾回收，活跃生成/图片操作期间也不允许资产维护。

Vibe 编码库和缓存随 PC 工作区保存。兼容范围绑定模型、服务协议/端点和信息提取值，生成强度可独立调整；缓存有数量/字节上限，失败编码不会缓存。资产维护引用扫描同时覆盖已保存的 Vibe 源图，避免清理仍被库条目使用的图片。

全量 Flutter 测试 `flutter test --no-pub --reporter expanded` 的 190 项已通过；Web/Windows Release 构建、静态分析及 Windows 存储/凭据探针通过。内置浏览器重装后仍缺少 `26.1007.21434` runtime，手动浏览器 QA 尚未完成；大图库缩略图队列和性能优化仍待验证。

## M1 的选择依据

实际记录安装包大小、冷启动、空闲内存、大图拖入与缩放、图库分页、SQLite 重开、系统凭据保存、中文路径、清洁环境安装结果；同时记录全部手机功能的直接复用/适配/重实现数量与风险。样本规模与目标阈值在测试前记录，不用未测试的性能数字宣传技术栈。

任一路线遇到打包、存储、原生能力或交互验证失败，先定位具体原因；若成本不可接受，比较备选路线的同一组用例，再更新决定。不能用连续堆叠兼容层代替路线复核，也不能靠取消本地超分、漫画或发布能力降低验证要求。

## 助手领域

`lib/assistant` 将公开配置/会话状态、HTTP 协议、工具循环和工作台工具分开。工具 schema 与分派共用注册表；流式参数只在完整响应结束后进入执行层。工作台实例持有 AssistantController，状态作为 `assistant` 节点参加原有 SQLite CAS 保存与递归图片引用审计，Key 不写入该节点。关闭窗口先取消助手并等待资产准备/保存；恢复时保留收据，将未完成轮次标为中断。只有完整轮次进入后续上下文，避免回放无结果的工具调用。具体限额、协议字段回放、审批与验证边界见 [助手报告](ASSISTANT_REVIEW.md)。

2026-10-14 增量：`PromptMemoryLibrary` 在助手节点内保存独立 schema/revision；`memory_tools.dart` 只允许有界检索已采纳记录和提交待审核候选。用户审核/冲突处理由控制器提交，未审核记录不会进入模型检索结果。历史关系、选中删除预览、旧快照兼容和新建记忆的清理保护见 [记忆批次](ASSISTANT_KNOWLEDGE_REVIEW.md)。`model_discovery.dart` 用只读凭据视图处理未保存的连接草稿，不提前写入 Key。

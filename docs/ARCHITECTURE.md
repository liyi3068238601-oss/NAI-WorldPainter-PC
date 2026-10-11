# 绘世 PC 技术路线比较

日期：2026-10-11。版本：0.2。状态：全量移植约束下重新比较，尚未进行桌面性能或打包验证。

用户已明确先完整移植手机端全部功能。本次撤销原先 Electron 的默认优先级，优先验证 Flutter Windows 复用方案。布局参考与技术框架分开决策；最终路线必须覆盖全部现有能力。

NovelAI Local Web 是用户指定的界面、布局、动画和流畅感首要参考，浪白为第二参考。这是桌面体验优先级，不要求移植其 Flask/Next.js 后端，也不替代手机端全部功能。

两者同时可作功能实现代码参考。选型需要计算可合法复用模块带来的实际收益；不能只比较“Flutter 原样复制”和“Electron 全部从零重写”。同一功能可选择成熟模块移植、调用独立组件或自行实现，前提是依赖、许可证、部署复杂度与行为测试均可接受。

## 候选方案

| 方案 | 当前可利用的基础 | 需要承担的成本 | 结论 |
| --- | --- | --- | --- |
| Flutter Windows | 手机端已有 Dart 领域模型、请求适配、Agent、漫画及数据库结构 | 根许可证待核实；Windows runner、SQLite、相册保存、后台任务和本地超分要适配；桌面 UI 重做 | 优先验证，评估复用能否降低全量移植风险 |
| Electron + React + TypeScript | 成熟桌面 Web UI；可用 TypeScript 统一界面、契约和服务；已有同类 Electron 项目可调查 | 全部 Dart 业务需重实现或找到明确授权的对应实现；双栈桥接会额外增加维护；原生模块需验证 | 对照候选，不能只凭布局好看或空窗口选择 |
| Tauri + React + Rust | Web 前端和 Rust 桌面命令；使用系统 WebView | Rust 与 TS 双栈；Windows 构建工具和 WebView2；双接入及桌面插件需验证 | 后续若体积或系统资源要求更严格，可重新评估 |
| 本地 Web + Python | 首要界面参考已有 React/Flask 工作流 | 双运行时、端口/生命周期/打包；仍需补齐手机端其他功能；现有参考为 AGPL | 研究界面实现；参考优先级不代表采用其整套技术栈 |

Flutter 的复用优势目前是基于源码结构的判断，尚未测得移植工时。M1 用同一批高风险场景比较两条路线：全渠道请求与图片解析、蒙版栅格化、SQLite 重开、Agent 工具调用、漫画导出、Pixiv 队列和 Windows 本地超分。若选择 Electron，必须逐项说明替代实现与验证成本，不采用未经验证的 Dart/Node 常驻桥来掩盖重写成本。

Flutter 官方要求 Windows 开发环境与 C++ 桌面构建工具；Tauri Windows 开发涉及 C++ 构建工具、Rust 与 WebView2。参见 [Flutter Windows](https://docs.flutter.dev/platform-integration/windows/setup) 与 [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)。这些文档不代表当前机器已具备全部构建条件。

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

SQLite 驱动与凭据存储库暂不指定版本。M1 核实维护状态、许可、Windows 预编译支持与 Electron ABI，并验证实际安装包。图片解析与缩略图等耗时工作移入 worker 或独立任务，避免阻塞界面。所有发布依赖在采用时锁定版本。

## M1 的选择依据

实际记录安装包大小、冷启动、空闲内存、大图拖入与缩放、图库分页、SQLite 重开、系统凭据保存、中文路径、清洁环境安装结果；同时记录全部手机功能的直接复用/适配/重实现数量与风险。样本规模与目标阈值在测试前记录，不用未测试的性能数字宣传技术栈。

任一路线遇到打包、存储、原生能力或交互验证失败，先定位具体原因；若成本不可接受，比较备选路线的同一组用例，再更新决定。不能用连续堆叠兼容层代替路线复核，也不能靠取消本地超分、漫画或发布能力降低验证要求。

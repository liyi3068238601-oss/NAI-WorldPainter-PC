# 绘世 PC 技术路线比较

日期：2026-10-11。状态：建议，尚未进行桌面性能或打包验证。

## 候选方案

| 方案 | 当前可利用的基础 | 需要承担的成本 | 结论 |
| --- | --- | --- | --- |
| Flutter Windows | 手机端已有 Dart 领域模型、请求适配、Agent 和数据库结构 | 根许可证待核实；Windows runner、SQLite、相册保存、后台任务和本地超分要适配；桌面 UI 重做 | 共用业务代码成为优先目标时有优势，保留候选 |
| Electron + React + TypeScript | 成熟桌面 Web UI；可用 TypeScript 统一界面、契约和服务；已有同类 Electron 项目可调查 | 现有 Dart 业务需重新实现；打包体积与内存；进程安全边界；SQLite 原生模块兼容性 | 暂推荐，M1 验证后决定 |
| Tauri + React + Rust | Web 前端和 Rust 桌面命令；使用系统 WebView | Rust 与 TS 双栈；Windows 构建工具和 WebView2；双接入及桌面插件需验证 | 后续若体积或系统资源要求更严格，可重新评估 |
| 本地 Web + Python | 参考项目已有 React/Flask 工作流 | 双运行时、端口/生命周期/打包；与独立桌面体验仍有距离；现有参考为 AGPL | 借鉴工作流，首版暂不采用其整套部署方式 |

Electron 建议来自当前独立 PC 产品目标和桌面交互需求，是工程判断，不是测得的性能优势。重写已有业务有实际成本，M1 必须将两条 API 适配和关键图片格式解析纳入成本评估，不能只凭空窗口运行成功定案。

Flutter 官方要求 Windows 开发环境与 C++ 桌面构建工具；Tauri Windows 开发涉及 C++ 构建工具、Rust 与 WebView2。参见 [Flutter Windows](https://docs.flutter.dev/platform-integration/windows/setup) 与 [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)。这些文档不代表当前机器已具备全部构建条件。

## 建议模块边界

```text
桌面界面：工作台 / 图库 / 队列 / 助手 / 设置
    ↓ 受限且经过校验的桌面命令
应用服务：草稿版本 / 任务调度 / 资产保存 / 后期 / 提示词提案
    ↓
领域契约：GenerationSpec / CapabilityProfile / GenerationPlan
    ↓
独立适配器：NovelAI 官方 / 指定协议网关 / LLM
    ↓
本地基础设施：SQLite / 文件 / 凭据 / 脱敏日志
```

领域模块不依赖 UI 控件、窗口和具体供应商 HTTP client。第一版采用单一应用与清晰目录，不为潜在未来扩展建立 monorepo 或插件宿主。

Electron 候选目录：`src/main/` 负责桌面与应用服务，`src/preload/` 提供最小 IPC 桥，`src/renderer/` 提供 React 界面，`src/domain/` 存放纯类型与规则，`src/providers/` 放置渠道协议，`src/storage/` 管理资产和数据库，`tests/` 存放契约与流程用例。这些目录尚未创建。

## 双接入契约

官方采用用户主动提供的 Persistent API Token。账号文档说明可以取得此 Token，重新生成会使旧 Token 失效；应用不应自动替用户轮换。参考 [NovelAI 账号文档](https://docs.novelai.net/en/text/usersettings/account/)。账号和图像接口分别查阅 [账号 API](https://api.novelai.net/docs/) 与 [图像 API](https://image.novelai.net/docs/index.html)，动态 Swagger 页面仍需在实现时进一步读取实际 schema。

网关不是一种统一协议。用 `protocolId + providerId + modelId + operation` 解析能力，配置中区分地址和协议。模型列表能返回不表示生成、参考图、重绘和超分已兼容。官方 Token 不能发送到网关，网关 Key 不能进入官方请求。

两类适配器都返回统一的图片结果与错误分类，但保留原始协议的必要诊断字段。任务保存适配前快照与实际生效参数；下载结果图使用独立客户端，跨 origin 跳转不得继承供应商鉴权头。能力不支持时在发送前报出具体字段。

## 桌面与数据边界

候选 Electron 实现应开启 context isolation 与 renderer sandbox，关闭 renderer Node integration，采用受限 CSP、校验 IPC 来源与参数、限制导航和外链。凭据只通过受控服务使用，保存前走系统保护能力；普通设置与日志不存明文秘密。文件对话框选定的目录与资产 ID 是文件操作边界，不向渲染层暴露任意文件读写命令。参见 [Electron 安全文档](https://www.electronjs.org/docs/latest/tutorial/security)。

SQLite 驱动与凭据存储库暂不指定版本。M1 核实维护状态、许可、Windows 预编译支持与 Electron ABI，并验证实际安装包。图片解析与缩略图等耗时工作移入 worker 或独立任务，避免阻塞界面。所有发布依赖在采用时锁定版本。

## M1 的选择依据

实际记录安装包大小、冷启动、空闲内存、大图拖入与缩放、图库分页、SQLite 重开、系统凭据保存、中文路径、清洁环境安装结果。样本规模与目标阈值在测试前记录，不用未测试的性能数字宣传技术栈。

若 Electron 打包、存储或交互验证失败，先定位具体原因；若成本不可接受，比较 Flutter 或 Tauri 的同一组用例，再更新此决定。不能用连续堆叠兼容层代替路线复核。

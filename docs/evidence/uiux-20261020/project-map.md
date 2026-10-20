# 绘世 PC 功能与规范静态调查

调查日期：2026-10-20。范围：独立克隆 `uiux-workspace/`，基线 `dfd7caa63ae19bd40651e00127a71efe57b71b4e`，工作分支 `feat/uiux-evidence-audit-20261020`。本文件只有文档/源码调查，不含本轮 GUI 体验结论，不能替代逐步截图审计。没有读取真实图库、凭据或工作区数据，没有远程模型调用，也未改产品代码。

## 当前规则与历史材料的解释

- `AGENTS.md` 要求先读 PC_PLAN、ARCHITECTURE、RESEARCH；源代码导入不能标为全量验收，手机功能完整迁移是最低标准。外部代码/素材要记录固定版本、许可和 hash，截图/日志不得含真实 Token、私有提示词和用户图片。
- 本轮用户明确要求独立工作区/分支，因此调查在本轮独立克隆中进行。原 AGENTS 的固定产品目录规定不应被解释为允许污染原工作树。
- `docs/PC_PLAN.md` v0.6 当前路线为 Electron/React/TypeScript；`lib/`、`windows/` 和 Flutter 验收文档保留为迁移前基线，不并行重做两套产品。
- `docs/DESIGN_DIRECTION.md` 开头明确：早期 Flutter 与左右栏排序建议不再约束迁移版。现阶段先保持成熟工作区，按实际问题优化；不能将历史的“左导航/中画面/右参数”原型规格直接作为当前强制重构目标。
- `docs/MOBILE_PARITY.md` 开头明确：下方 110 个 MP 追踪 ID 是 Flutter 阶段审计（27 页面/组件入口与 83 细项/差异），不是新 Electron 端已完成项，也不是 110 个已可达手机能力。C=源码存在，R=静态路由可达，U=未运行验证；不可达/未接线项不能算现状，但要保留追踪。

## 当前导航与实现位置

以下是静态调用链，不是从 UI 发现入口的操作记录；GUI 审计必须先看图、再点击确认。

| 导航/用户任务 | 当前实现依据 | 需要体验验证的关联 |
| --- | --- | --- |
| 生成（文生图/图生图） | `desktop/src/app/navigation.ts:1`；`App.tsx:4243`；`i18n.ts:73` | 正负词/画师串/模型/Seed/角色/参考，切换模式与草稿保留 |
| 重绘 | `navigation.ts` 的 inpaint；`App.tsx:4272`、`:7252`；`InpaintCanvas.tsx` | 源图归属、画笔/擦除/区域、撤销、蒙版保存、回到生成不串图 |
| 后期 | postprocess；`App.tsx:4273`；`LocalSuperResolutionSettings.tsx` | 官方付费后期与本地 SR 的入口区别、来源/输出、取消反馈 |
| 反推 | inspect；`App.tsx:4274` | 图片分析输入、失败恢复、与元数据解析的概念区别 |
| 转换 | convert；`App.tsx:4275` | 自然语言转标签、长文本、原词保留/确认应用 |
| 原数据 | metadata；`MetadataInspector.tsx`、`MetadataApplyPanel.tsx` | NAI/SD/ComfyUI 参数查看与选择回填，未选字段不覆盖 |
| 工具 | tools；`ToolsHub.tsx:35-40`、`:180` | 漫画、批量重绘、画师实验室、个人法典、V5 画师权重修复、画师串权重抽签 |
| 参考预设 | referencePresets；`ReferencePresetManager.tsx` | Vibe/精准参考预设、模型兼容、导入/更新与源图关联 |
| 在线画廊 | onlineGallery；`features/online-gallery/` | 这是远程公开作品浏览，不应与本地历史混淆；本轮禁止使用真实用户账户数据 |
| 生图智能体 | agent；`App.tsx:82/86` 实际懒加载 `PiAgentPage.tsx` | 旧 `AgentPage.tsx`/Tavern 仍存在但不能当当前主 UI；模型选择、附件、工具确认与错误恢复看 Pi 页面 |
| 记录 | records；`App.tsx:7262`、`AiLogPanel` | 反推/转换/拆分镜每次发送与返回的记录；截图要保持仅合成文本 |
| 风格管理 | styles；`StyleLibrary.tsx` | 素材分类/搜索/插入/导入，不等于全部手机内置预览素材已分发 |
| 作品 | works；`WorksLibrary`、`works-library.ts` | 本地资产管理、筛选/选择、与右侧历史条/收藏关系 |
| 收藏夹 | favorites；`GalleryFavoritesLibrary`、`favorites-*` | 收藏分组/排序/批量操作、导入冲突及参数回填 |

`ACTIVE_TABS` 共 14 项；`WIDE_WORKSPACE_TABS` 对 metadata/tools/referencePresets/onlineGallery/agent/records/styles/works/favorites 使用宽工作区。`AppTabBar.tsx` 使用测量条和 ResizeObserver 计算可见 tab 数，多余放“更多”；用户可拖动或 Alt+左右重排，Escape 退出编辑，顺序存于 `langbai.navigation.order.v1`（`app/tab-order.ts`）。应测试小窗口时当前页是否明确、隐藏项能否找到、键盘是否到达。

`App.tsx:7089-7135` 的 PersistentTabView/PersistentCanvasSurface 在首次挂载后隐藏而不卸载；`ToolsHub.tsx:140-156` 新应用会话总回轻量工具索引，同一会话切 tab 保留活动工具。以上只是保留机制，不能据此宣称所有表单/图片状态均持久化；GUI 应验证页面切换与冷启动两个不同场景。

漫画没有独立顶层 tab。当前静态入口是工具卡片 → `comic/TagComicGenerator`；`ComicGenerator.tsx` 此处载入的是 `BatchRedraw`。把文件名误认漫画主入口会导致审计走错流程。漫画 parity 包括项目、分镜导入/编辑、任务候选、主图、对白后期和逐格/整页 PNG，不能只验工具卡片。

## 设置组织

`App.tsx:5839-5858` 定义 16 组：api、storage、backup、worldpainter、gateway、ai-reverse、convert-api、agent-models、templates、prompt、language、sound、appearance、performance、mcp、about。`App.tsx:5920-5940` 是导航/内容容器。主菜单 `app/AppChrome.tsx` 还含流式预览、输出目录、设置、帮助文档。

- API 内有 NovelAI 账号管理、兼容图像设置、OpenAI 编辑设置、代理；不要把多种服务凭据混成一个全局账号。
- “绘世资料”承载旧 Flutter PC 导入、记忆/知识/素材相关补齐功能；旧 SQLite 必须用户选择、只读预览后追加，不可自动扫描真实数据。
- “兼容网关”有独立 `GatewayWorkbench`，与官方 Token 分离。
- “Agent 模型”复用 `AgentProviderSettings`，Pi 页面 `AgentModelPicker` 原位切换；配置与切换需分别验收。
- “外观”包含深/浅/跟随系统、减少动画、工作区布局重置；“性能”含各模式草稿/状态保留选项。默认保留行为须按实际开关记录。
- `features/settings/ResourceDatabaseSettings.tsx` 声明本地 ONNX Tagger 当前尚未接入；资源库安装、恢复和缓存清理是不同操作，不要用“设置有 UI”当后端可用。

## 设计约束

| 项目 | 已确认规范 | 验收意义 |
| --- | --- | --- |
| 品牌 | 深色 `#0A0A0C`/表面 `#1C1C21`/暖金 `#F5D57A`；浅色白/蓝 `#3B82F6` | 改动保留绘世身份；不导入参考项目紫色渐变、角色/宣传/作者联系与打赏 |
| 层级 | 金色用于主要操作、焦点与选中；图像维持视觉中心；轻边框与中文层级 | 不能所有按钮同权，也不能让参数信息压过画面 |
| 面板 | 独立滚动、长列表局部滚动、窄窗口入口、补全不越界 | 1280×720 下主要操作/错误/确认不能被挤走 |
| 动效 | 可中断、不阻塞点击与输入、减少动画仍有状态反馈 | 静态截图和 CSS 时间不证明流畅；要实测切页/滚动/输入/缩放 |
| 数据 | 任务冻结规格、源图绑定、保存实际 Seed；异步只能更新对应任务 | 草稿切换、Agent 延迟返回、取消/队列是串图/覆写高风险点 |
| 适配 | 至少 1280×720、1920×1080 和 100%/150%/200%，本轮额外1440×900 | Electron viewport/缩放模拟、Windows 系统 DPI 与多显示器应分别报告 |

## 功能完整范围与明确缺口

`PC_PLAN.md` 的最低范围包括：官方/现有网关/GPT/Nano 的接入配置；文生/图生/高级参数/多角色/批量队列；Vibe/精准参考/缓存；蒙版/局部/分块/候选/撤销；Director/官方后期/本地 SR；图库/收藏/元数据/打标/风格/画师；多供应商多模态 Agent/确认；Danbooru/模板/记忆；漫画全流程；Pixiv 上传表单和队列；深浅主题/草稿/凭据/存储/文件/诊断。服务暂不可用只可记阻塞，不能取消功能。

`M4_ELECTRON_MIGRATION.md` 的当前缺口/验证边界：

1. 7877/ikun 首版适配只有纯文生图；图生图、重绘、多角色/Vibe/精准参考应明确阻止，不静默丢参降级。对应完整手机范围保留。
2. 本地 SR 独立入口的 CUGAN 2×合成图 CLI 和初始打包候选 GUI 有历史证据；其他模型、Agent 调用及图库回流不能由此视作全通过。
3. 手机 SQLite v22 显式迁移未闭合；旧 PC schema 1 导入不能代替。
4. Pixiv 发布/队列与漫画全流程、真实渠道、长任务压力、完整 DPI/多显示器未全验收。
5. 手机 24 风格/137 画师预览许可未确认，不能因功能迁移就分发；胶囊覆盖 2,218 个去重英文标签不等于分类/中文译名完全一致。
6. 高级页面选项/布局、上游大体积 JS chunk 是质量清单，不是本轮已定位的 GUI 缺陷。
7. 自动化、真实接口、人工视觉要分开；`PC_PLAN`/`MOBILE_PARITY` 中 Flutter 的 190/435/460 历史测试数不能作 Electron 当前测试结果。

## 当前 Agent 与隔离运行提示

实际主链以 ARCHITECTURE 头部为准：`PiAgentPage → agent-runtime → pi-agent-turn → pi-studio-tools → agent-tools`；Skill 目录按需读取，保留预设，供应商注册表独立模型参数和凭据。Pi 页面附件支持选择、拖拽、粘贴；`PiAgentPage.tsx:362` 是 pending 工具确认托盘，`:376` 是 AgentModelPicker。未配置模型时发送 disabled，禁止为走通 UI 而填真实 Key。

`desktop/electron/main.ts:304-313` 读取 `NAI_UI_CAPTURE_PATH`、`NAI_UI_CAPTURE_USER_DATA`、`WORLDPAINTER_DATA_DIR` 并设置 userData。`:1567` 的 `!uiCaptureUserData` 参与旧资料迁移 guard。运行负责人应完整检查该块和存储初始化，确保隔离路径、outputDir、Agent workspace 都在测试根中；不要仅设置一个环境变量就默认没有旧目录检查。截图入口 `uiCapture` 也有改变页面/账户状态的测试钩子（`App.tsx:7172-7198`），不得把钩子直接跳到目标页当用户入口发现或原生交互证据。

## 后续审计记录建议

三种视角均为启发式评估，不是真人研究。新用户看“我在哪里/下一步/错误恢复”，熟练创作者看完整参数/长词/角色/批量和少打断，产品工程看状态归属/持久化/取消/可达性。每步保存：截图文件、开始状态、可见入口、操作数、反馈与等待、误操作、草稿/图片关联、恢复方式、环境/尺寸/主题/模拟范围。先从截图发现入口，出现问题后再用本文件的源码位置解释根因。

低风险候选只应来自复现证据，例如单个按钮命名、缺少焦点/键盘闭合、明确裁切、长文本断行、局部错误提示。核心导航、栏顺序、整体工作台与视觉方向仍先做真实 React 组件交互原型并留给用户选择。当前本文件没有提出任何产品代码修复，也没有运行 GUI 或测试命令。

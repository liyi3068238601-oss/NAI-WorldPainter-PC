# 绘世 PC 第一版迁移与 M4 收尾

日期：2026-10-15。分支：`feat/electron-m4-migration`。本报告描述当前 `desktop/`，原 Flutter 验收记录不自动继承到新实现。

## 当前结论

根据用户授权，直接迁移 MIT 桌面功能源码，完成绘世身份适配、M4 记忆/知识库/素材补齐及合成数据下的 Windows 本机交互验收（包括初始打包候选的本地超分 GUI 流程）。当前交付为本地开发预览；最新包的 GUI 视觉验收仍待完成，全量手机功能矩阵仍保留，真实付费接口、Pixiv 与其他差异项未因此标为完成。参考项目其余缺点按后续批次处理，不在首版中全面重构。

## 来源与改动范围

- 功能基线：相邻只读 `novelai-image-desktop`，提交 `7bc76ded4f539949a52f29fba32e2d896d2f89b7`，MIT，原署名和嵌套第三方许可保留。主来源清单见 [manifest](evidence/electron-migration/upstream-source-manifest.json)。
- 回归夹具：补入上游 `mobile/` 必需源码/资源、Android 单个实现文件及文档快照，以运行原有跨平台回归。它们不是绘世手机源码，不进入 Windows 产品包；补充清单见 [test-reference manifest](evidence/electron-migration/upstream-test-reference-manifest.json)。最初 manifest 的 exclusions 描述第一批复制范围，后续夹具以补充清单为准。
- 界面参考：`novelai_local_web` 的独立滚动、面板收展、分组和结果复用交互；没有复制其 AGPL 前端源码、品牌或图片。本批实际比较了既有 [深色参考截图](evidence/reference-ui/07-workspace-dark-1920.jpg) 与原生工作台，保持参考实现的可用布局，先统一绘世视觉。
- `lib/`、Flutter runner 和原用户数据保留；相邻参考项目及手机项目未改写。

## 绘世身份与视觉

窗口、欢迎页、关于页、仓库入口、备份对话框和默认工作区使用绘世名称。移除原作者联系方式、群组、打赏二维码、宣传图和吉祥物；新增绘世原创 SVG 山景/月色欢迎图与山形图标。深色沿用 `#0A0A0C` / `#1C1C21` / `#F5D57A`，浅色沿用白底蓝色。共享选中态、按钮、面板和阴影改用绘世主题 token；保留可收展三栏和窄窗口入口。

原作者署名仍在 `LICENSE` 和 `THIRD_PARTY_NOTICES.md`。内部 `langbai_*` 工具名、历史 schema 和旧数据识别键保留兼容，不是产品展示名称。上游发行记录单独归档，当前 README 不再宣传原项目安装包。

## 功能闭环

| 区域 | 当前实现与验证边界 |
| --- | --- |
| 主工作台 | 迁移文生图、图生图、重绘、参考图、图库/参数回填、提示词、后期及 Agent 等成熟源码；接口 mock/自动测试保留。源码可达不等于所有线上组合已实测。 |
| 记忆 | 8 种类型、4 种来源；角色名/角色特征/画风按英文标签规范化，其他自然语言原样保留。候选先待审，编辑后批准才参与召回；覆盖/合并/并存保留来源与历史。当前/全局范围检索最多 8 条、序列化 12,000 字符，命中记录持久化，旧记忆清理先预览。 |
| 知识库 | 接入真实 Pi runtime，按当次输入关键词选最多 5 条、正文 2,000 字符；外部 JSON 先完整校验再保存。支持路径选择、重新加载、来源/hash；坏文件回退内置并保留设置。V4.5/V5 默认画风分开，V5 原提示词说明与两个只读参考工具已接入。 |
| 素材 | 风格与画师 JSON 可本地导入，预览图需另行选择；冲突默认跳过或另存，已有库保留。画师有查询/分类/选择后插入；备份包含素材索引与图片。手机 24 风格/137 画师的缩略图来源未确认，未作为产品内置资源分发。 |
| 胶囊 | 迁移 MIT 词库覆盖手机运行时 2,218 个去重英文标签；分类位置和中文译名仍有差异，见 [资源审计](evidence/m4-closure/resources/resource-audit.md)。不宣称完全相同的分类体系。 |
| 旧 PC 导入 | 设置 → 绘世资料 → 选择 `workspace.sqlite`，只读预览后显式追加。草稿、图库、风格、画师、记忆和会话映射；校验图片 hash/路径，重复导入去重，不覆盖已存草稿。无法直接映射的安全字段写本地归档；连接/凭据/诊断内容排除。这里针对 Flutter PC schema 1，手机数据库 v22 导入仍单独跟踪。 |
| 兼容网关 | 7877/ikun 独立凭据库，Windows safeStorage 加密，按协议+服务根地址隔离；冻结参数预览后单次确认，过期/重复提交拒绝，取消后不自动重试。首版仅纯文生图；图生图、重绘、角色/Vibe/精准参考等明确阻止，不丢参数降级发送。 |
| Windows 本地超分 | 本机 Real-ESRGAN Anime 4×、Real-CUGAN Conservative 2×/4×；显式选运行目录与图片、预计尺寸、进度、取消、另存。源图 SHA-256 冻结，拒绝覆盖源图与同文件别名，单任务及超时控制。合成图片的 CUGAN 2×命令行与初始打包候选 GUI 流程已通过；其他模型不以此视为验证。当前入口独立于 Agent 工具与图库；最终包内两份超分后端模块与已验收候选的 SHA-256 一致。 |
| 执行确认 | 新 Agent 会话默认每次确认；用户显式保存的全自动选项保留。真实运行层、归一化与 UI 回退一致。知识库/记忆/角色数据不能授予工具或付费权限。 |

## 数据与发行边界

- 开发默认 `PC端/data/electron`；正式路径使用独立 `NAI-WorldPainter-PC` 数据目录与 `worldpainter-desktop.json`。本次 native QA 指向 `.tmp/native-m4-profile`，仅合成记录。
- 不扫描原项目账号目录；旧 Flutter 导入由文件选择与确认发起。原文件未改写，导入资产另存。
- 自动更新在网络/安装动作前禁用，避免连接上游发行通道；无正式发布、推送或安装器验收。
- Electron 使用 contextIsolation 和关闭 NodeIntegration；迁移预加载仍使用 `sandbox:false`，不宣称已全面沙箱化。
- 包含的第三方资源各遵原许可，原手机提示词资源/hash 见 [清单](evidence/m4-closure/resources/bundled-assistant-resources.json)。正式公开分发前仍需按最终资源集合审核许可证。

## 验证记录

最终构建、测试和产物记录见 [verification.json](evidence/m4-closure/verification.json)。自动测试包含源码合同、纯函数、mock、IPC 服务和运行时测试，数量不等同于 GUI 用例数。

已通过的原生交互（Windows 11 x64，隔离 profile，合成数据）：

1. 首次启动、三栏工作台、设置和绘世资料入口。
2. 外部知识库路径校验保存；修改测试文件后，从 2 条重新加载至 3 条。
3. 旧 PC 快照只读预览，确认后各追加 1 条草稿/图库/风格/画师/已审记忆/待审记忆/会话及 1 张校验图片；关闭并冷启动后，草稿、图库图片、固定 Seed 4242、原模型和外部知识库 3 条记录均恢复。
4. 待审核记忆编辑为中英自然语言并审核，待审 1→0、已审 1→2，文字保持原样。
5. 最终包冷启动恢复工作台；深色暖金与浅色蓝主题切换、绘世图标/名称/关于页显示正常。截图：[深色](evidence/m4-closure/windows/final-workbench-dark.jpg)、[浅色](evidence/m4-closure/windows/final-workbench-light.jpg)、[关于页](evidence/m4-closure/windows/final-about.jpg)。

关键截图：[知识库保存](evidence/m4-closure/windows/knowledge-saved.jpg)、[知识库重载](evidence/m4-closure/windows/knowledge-reloaded.jpg)、[旧 PC 导入](evidence/m4-closure/windows/legacy-import-complete.jpg)、[记忆审核](evidence/m4-closure/windows/memory-approved.jpg)。完整证据保存在 [windows](evidence/m4-closure/windows/)。

本地超分执行了真实 Windows Vulkan CUGAN CLI：合成 64×64 → 128×128，输出 PNG 565 bytes；[CLI 记录](evidence/m4-closure/local-sr/verification.json) 与输入/输出/hash 留存，没有网络推理调用。随后在初始打包候选 `build/electron-m4-preview` 中完成了本地超分 GUI 从选择到输出的流程，结果图为 [128×128、565 bytes](evidence/m4-closure/local-sr/native-ui-result.png)。[GUI 截图](evidence/m4-closure/windows/local-sr-native-success.jpg) 对应初始候选。最终包 `build/WorldPainter-0.1.0-preview` 已通过上述工作台和主题检查，超分服务与参数模块经提取确认字节一致；没有重复声称最终包完整超分 GUI 重跑。追加的全新 profile 150% 缩放检查因桌面工具两次报 `foreground window did not report a process id` 停止，未计为通过。逐项记录见 [verification.json](evidence/m4-closure/verification.json)。

本轮真实付费 NovelAI/LLM/网关请求数为 **0**。未读取真实 Token、用户图库或私有提示词；工作区、导入样本和知识库验收数据均为合成数据。

## 第一版之后继续处理

优先处理经过实际使用确认的交互问题，保留完整手机矩阵。明确未闭合项包括：7877/ikun 图生图与重绘、Agent 调用本地超分及其图库回流、手机 v22 显式迁移、Pixiv 发布流程、漫画全流程、真实渠道和长任务压力验收、完整 DPI/多显示器组合。素材许可/分类差异、上游大体积 JS chunk、尚未逐页清理的高级页布局和过多选项也纳入后续质量清单。首版不以保留成熟代码为由宣布这些内容全部可用。

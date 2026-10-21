# 新版局部重绘：实现与验收记录

日期：2026-10-21。新版已接入原局部重绘工作区上方的“旧模式 / 新模式 · 手机端”入口。旧版保留，默认仍为旧模式。本次完成代码、隔离 Windows Electron GUI 和 mock 流程验证；真实付费服务与所有手机网关协议尚未验收，不能据此宣布无差异完全复现。

## 目录、分支与基线

- 指定隔离 clone：`E:\Codex无项目文件夹\2026-10-20\task\uiux-workspace`，分支 `feat/uiux-evidence-audit-20261020`。
- 实施基线：`d493a8653afebd913c55f2cf27adc491727897c5`，沿用已有 A 方向成果；本次未合并其他分支、未改全局布局、未进入用户原始工作目录。
- 开始时已有的未跟踪 `desktop/scripts/uiux-inpaint-fixture.cjs` 和 `docs/evidence/uiux-inpaint-compare-20261020/` 保留，未纳入本次提交。
- 用户更正分支前准备的另一个 clone 留在 `E:\Codex无项目文件夹\2026-10-21\task\pc-mobile-inpaint`，基线 `dfd7caa63ae19bd40651e00127a71efe57b71b4e`，未迁移其中其他成果、未删除或重置。
- 手机行为固定为 `sakiko0901/NAI-WorldPainter@eb8ef2158e3f204ab90f7c198d4050a5967f4439`。PC 自带 mobile fixture 未被用来替代真实手机端。只读源索引和逐项证据见 [行为审计](evidence/mobile-inpaint-source-20261021/MOBILE_INPAINT_BEHAVIOR_AUDIT.md)、[参数与导入审计](evidence/mobile-inpaint-source-20261021/MOBILE_PARAMS_IMPORT_AUDIT.md)、[源码索引](evidence/mobile-inpaint-source-20261021/MOBILE_INPAINT_SOURCE_INDEX.json)。TypeScript 按行为独立实现，未复制 Dart 源码或模型素材。

## 功能对照

| 核对项 | 固定手机行为 | PC 新模式与证据 |
| --- | --- | --- |
| 输出框、处理分辨率 | 屏幕框经图片 transform 换算为 worldRect；框可越界；改变分辨率保持框中心和宽度、按比例改高 | 独立 frame/transform/output；默认 832×1216，手机十个预设及 64–1920、64 倍数自定义；不经过旧 focusedInpaintPlan 裁剪 |
| 移动、缩放、吸附 | 整体、框、图片分别操作；8 屏幕像素吸附、缩放上限与手机一致 | 桌面工具、滚轮、空格/中键平移；释放鼠标后离开画布不继续拖动。真实组件 Electron 合成指针 7/7，完整窗口拖框/编辑提示词复核 |
| 蒙版与图像笔迹 | 画/擦独立目标；源图透明区与越界区自动选中；掩码按 8×8 单元“任一点选中则整单元选中” | 独立笔迹和蒙版栅格；扩展默认 8；Worker 处理不移走活动源图 buffer；不重复套旧版膨胀/羽化 |
| 羽化 | 页面只有一个羽化参数默认 8；内侧未传时自动 min(外侧,2) | 已纠正为一个“羽化”控件，内侧自动推导；新增精确 alpha 测试覆盖 8/2、1/1 与零羽化；见 [修复日志](evidence/mobile-inpaint-source-20261021/feather-validation-20261021.log) |
| 大图、超分后导入 | 以真实像素尺寸导入，不因 >4MP 缩小；2×/3×是普通像素放大 | 2048×1536 合成放大图及 4096×4096 大图全尺寸导入后可框选 1024×1024 处理；没有真实超分模型调用 |
| 参数和请求冻结 | 专用正/负提示词；提交时冻结区域/参数；随机 Seed；不继承主生图角色、参考图与主界面高级设置；手机官方适配固定发送 quality=true、UC=1 | 请求冻结后异步栅格/预检；批次 1–30；官方 infill 只加 image/mask/strength，默认 .96；不套旧 nested img2img；V5 步数上限 28、其它模型 50；官方 quality/UC 固定字段跟随手机，剔除 PC 主生图特有 flags，本地质量扩词仍关闭以保留独立提示词；账户 revision 与 runId 防迟到结果误落当前状态 |
| 候选、贴回、图层 | 完整输出框结果需与提交尺寸一致；候选需手动应用；同批改选替换一个结果层；旧结果不反哺下一轮请求 | before/after 比较、Seed、候选切换、应用、隐藏/移除；同批替换后仍一层。应用层之后再次提交的四个 mock 请求 image/mask 哈希一致 |
| 保存 | 原底图、图像笔迹和可见结果层合成；候选未应用不保存；边界可扩展 | 独立原生 PNG 另存 IPC，wx 独占新建、不覆盖原图；隐藏层 4096² 与底图 RGBA 完全一致，显示层 4762×4096，框覆盖外改动像素数为 0 |
| 撤销与恢复 | 笔迹/蒙版历史与结果层操作区分；未发现手机跨进程工作区恢复 | 支持笔迹、蒙版撤销重做、清空恢复；模式来回保留本次内存草稿。旧蒙版 hash 在新模式操作后不变，Ctrl+Z 改变、Ctrl+Shift+Z 恢复 |

## 明确差异与未验证边界

1. **32 MP 是 PC 新增保护，手机没有这一上限。** 实际阈值为 32×1024×1024 像素，另沿用桌面 32 MB 文件限制。UI 明示上限与恢复路径：超限操作保留当前编辑，可缩小输出框、隐藏/移除越界层后重存；超限原图先缩小或裁剪。8192×4160 合成图导入被阻止后，原 4096² 底图、框和已应用层仍保留。单测覆盖放大/合成在大数组分配前拒绝、未丢现有草稿。
2. 手机图像擦除的预览/导出 alpha 不一致未照搬：PC 以独立 overlay 重算合成，保留原始底图。此为明确修复差异。
3. 手机 2×/3×用 Dart cubic，PC 用 Canvas 高质量插值；未证明逐像素等同。真实 AI 超分效果未测试。
4. PC 沿用现有生成历史，保存原始生成框以减少晚到结果丢失；手机候选为临时队列。工作区编辑本身仅在进程内保存，未增加跨重启恢复。
5. 手机工作区官方请求省略 seed，由服务随机；PC 沿用现有历史接口，在本地抽取独立随机 seed 后显式发送。两者都不继承主生图 seed，但随机来源与请求形状不同；本次不声称字节相同。
6. 当前 PC 账户/兼容接口采用官方形状。手机官方与 7877 不发 ignoreSource/colorCorrect；仅对应通用/ikun 协议发送。UI 已说明这两个选项在当前官方通道不生效，未虚构协议支持。真实官方响应、全部手机网关、付费报价与扣费、服务拒绝/取消/断网均未做真实请求验收。
7. Windows 系统实际缩放为 125%；额外 DPR 1.5/2.0 来自 Electron zoom，不能称为 Windows 150%/200% 系统 DPI 验收。未进行物理鼠标、触控板、跨显示器或长时稳定性验收。

## 自动检查

- 最终代码 `vitest run inpaint src/feature-i18n.test.ts --retry 0`：**22 个文件，724 项通过**；[原始日志](evidence/mobile-inpaint-parity-20261021/checks/mobile-inpaint-final-targeted.log)。
- 官方实际 buildPayload + 新模式适配精确断言覆盖固定 quality/UC、移除 PC-only flags、原样作者词与 V5 上限；[独立协议日志](evidence/mobile-inpaint-source-20261021/official-payload-final-validation-20261021.log)。
- 最终 `npm run typecheck`：renderer 和 Electron 通过；[日志](evidence/mobile-inpaint-parity-20261021/checks/mobile-inpaint-final-targeted-typecheck.log)。`npm run build` 通过；[构建日志](evidence/mobile-inpaint-parity-20261021/checks/mobile-inpaint-final-build.log)。保留现有大 chunk 提示，未生成安装包。
- 全量 `npm test`：454 文件通过、3 文件失败、1 跳过；4184 项通过、2 项失败、2 跳过。失败是基线中已缺失的 `mobile/lib/models/builtin_ui_fonts.dart`、`mobile/lib/models/nai_models.dart`，以及导致 suite 无法载入的 `shared/issue-network-fixtures/public-test-cert.pem`；不是本次删除。没有以跳过或补假 fixture 改绿。全量运行后的小修复另有上述最终 targeted、类型和构建覆盖。[完整日志](evidence/mobile-inpaint-parity-20261021/checks/mobile-inpaint-final-tests.log)。
- [真实组件指针 7 项记录](evidence/mobile-inpaint-parity-20261021/component-pointer/RESULT.json) 使用真实 Canvas/store 的 Electron CDP 合成事件，明确 `physicalPointerTested:false`。

## Windows GUI 实测

使用 Windows 11 build 26200、Electron 42.11.0 / Chromium 148，可见 BrowserWindow、独立 userData/profile、合成图。全程阻止外网并清除凭据环境变量。模型生成 IPC 明确替换为 mock，截图显示“合成测试 · IPC MOCK · 无真实生图 / 收费”；原生导入/保存 IPC 与 PNG 文件写入实际执行，系统选择器目的地用合成路径 stub。没有操作真实图库、工作区或凭据。

| 实际 CSS viewport | 主题 | DPR / 方法 | 覆盖 |
| --- | --- | --- | --- |
| 1280×722 | 深、浅 | 1.25，原生 content size 请求 1280×720 被窗口下限/取整为 722 | 工具折行、画布、图层、可滚动参数、固定生成按钮 |
| 1440×900 | 深、浅 | 1.25，原生窗口 | 完整导入、拖框、参数、候选、应用/替换/隐藏/移除、另存、旧模式回归 |
| 1920×1080 | 深、浅 | 1.25，原生窗口 | 布局及状态保持 |
| 1280×720 | 深、浅 | 1.5，原生 1536×864 + Electron zoom 1.2 | 实际 CSS 720 高度下布局、工具/候选可达 |
| 1280×720 | 深、浅 | 2.0，原生 2048×1152 + Electron zoom 1.6 | 高像素倍率布局与截图；非系统 DPI 切换 |

逐步操作、失败尝试、实际窗口 bounds/contentBounds/viewport/DPR 均保留在 [actions.json](evidence/mobile-inpaint-parity-20261021/actions.json)，没有把请求尺寸当实际尺寸。截图包含早期 CORS/拖动故障与弹窗遮挡的失败尝试，以下最终索引才对应修正后的通过状态。自动化通过 Playwright/CDP 驱动真实 Windows Electron，不是浏览器替代测试，也不是原生模型生图成功。

## 关键证据

- 最终构建候选：[post-feather-candidate-review](evidence/mobile-inpaint-parity-20261021/screenshots/185-post-feather-candidate-review.png)；单一羽化控件：[final-single-feather-control](evidence/mobile-inpaint-parity-20261021/screenshots/190-final-single-feather-control.png)；应用和另存：[post-feather-saved](evidence/mobile-inpaint-parity-20261021/screenshots/192-post-feather-saved.png)。
- 最终 V5 输入 50 后实际 value/max 均为 28：[GUI 步数边界](evidence/mobile-inpaint-parity-20261021/screenshots/235-final-v5-step-value-max-28.png)。
- 深色矩阵：[final-matrix-dark-1440](evidence/mobile-inpaint-parity-20261021/screenshots/254-final-matrix-dark-1440.png)、[final-matrix-dark-1280](evidence/mobile-inpaint-parity-20261021/screenshots/256-final-matrix-dark-1280.png)、[final-matrix-dark-1920](evidence/mobile-inpaint-parity-20261021/screenshots/258-final-matrix-dark-1920.png)。
- 浅色矩阵：[final-matrix-light-1440](evidence/mobile-inpaint-parity-20261021/screenshots/238-final-matrix-light-1440.png)、[final-matrix-light-1280](evidence/mobile-inpaint-parity-20261021/screenshots/240-final-matrix-light-1280.png)、[final-matrix-light-1920](evidence/mobile-inpaint-parity-20261021/screenshots/242-final-matrix-light-1920.png)。
- 1280×720 候选对比：[最终候选控件](evidence/mobile-inpaint-parity-20261021/screenshots/220-final-review-light-controls-1280x720-dpr2.png)。
- 缩放矩阵：[final-dpr15-dark](evidence/mobile-inpaint-parity-20261021/screenshots/260-final-dpr15-dark.png)、[final-dpr20-dark](evidence/mobile-inpaint-parity-20261021/screenshots/262-final-dpr20-dark.png)、[final-dpr15-light](evidence/mobile-inpaint-parity-20261021/screenshots/244-final-dpr15-light.png)、[final-dpr20-light](evidence/mobile-inpaint-parity-20261021/screenshots/246-final-dpr20-light.png)。
- 大图边界与草稿保留：[final-32mp-existing-draft-retained](evidence/mobile-inpaint-parity-20261021/screenshots/128-final-32mp-existing-draft-retained.png)；旧模式恢复：[final-legacy-mask-restored](evidence/mobile-inpaint-parity-20261021/screenshots/163-final-legacy-mask-restored.png)。
- [输出尺寸、RGBA 与 mock 请求哈希核验](evidence/mobile-inpaint-parity-20261021/VERIFICATION.json)，[隐藏层另存](evidence/mobile-inpaint-parity-20261021/outputs/final-composite-hidden.png)、[可见层另存](evidence/mobile-inpaint-parity-20261021/outputs/final-composite-visible.png)、[最终羽化修复后另存](evidence/mobile-inpaint-parity-20261021/outputs/post-feather-composite.png)。

## 遗留与交付状态

实现与隔离 mock GUI 已完成；真实付费 API、实际超分模型、全部手机网关、物理输入和系统 DPI 切换未验证。全量测试三处缺失 fixture 仍属仓库验收阻塞。本任务未推送、合并或发布，未重试此前 403 附件上传。只关闭本任务测试实例；实际提交号见交付回执及本分支 Git 记录。

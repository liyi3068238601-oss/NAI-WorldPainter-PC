# 绘世 PC UI/UX：两个参考项目的实现调查

调查日期：2026-10-20。调查方式：公开 GitHub README、文件树与固定提交源码检查。本记录是启发式工程参考，不是真人研究；没有运行两个参考项目，没有真实登录或调用生图、聊天、标签或其他收费服务。这里的源码结论不能代替绘世 PC 的实际 GUI 复现。

## 快照与证据边界

| 项目 | 本次固定的 main 快照 | 技术与证据范围 |
| --- | --- | --- |
| [YILING0013/novelai_local_web](https://github.com/YILING0013/novelai_local_web) | `d244ec9dfa919cd039789df06cfddfb6e6d8c765` | Next.js / React / MUI，Flask。检查工作台、图库详情、图库批量处理、局部重绘、参数条、提示词快捷键和缓存源码。 |
| [2786886095/novelai-image-desktop](https://github.com/2786886095/novelai-image-desktop) | `650d86304ccdd514dd871d7c2334574f6e3be7cc` | Electron / React / TypeScript，另有 Flutter 手机端。检查字段选择回填、历史菜单、面板调整、图库返回、蒙版会话、Agent 问题和失败提示源码。 |

README 与代码均为调查时的快照；未来 main 会变化，因此下方组件链接使用固定 SHA。两个递归树均成功读取，返回 `truncated:false`。本机 PowerShell 对 `api.github.com` 的请求遇到 DNS 解析失败；改用已连接 GitHub 的只读 `fetch` / `fetch_file` 成功检查源码。这不是自动批准拒绝，没有外部写入。

截图证据须按来源区分：YILING 的 [workspace.png](https://github.com/YILING0013/novelai_local_web/blob/d244ec9dfa919cd039789df06cfddfb6e6d8c765/docs/screenshots/workspace.png)、[image-detail.png](https://github.com/YILING0013/novelai_local_web/blob/d244ec9dfa919cd039789df06cfddfb6e6d8c765/docs/screenshots/image-detail.png)、[local-gallery.png](https://github.com/YILING0013/novelai_local_web/blob/d244ec9dfa919cd039789df06cfddfb6e6d8c765/docs/screenshots/local-gallery.png) 是仓库提供的示例工作区图片。Langbai 的 [workbench-light.png](https://github.com/2786886095/novelai-image-desktop/blob/650d86304ccdd514dd871d7c2334574f6e3be7cc/docs/assets/readme/workbench-light.png) 被其 README 明确标为 **2026-08-30 / v2.0.1 历史实际界面**，不能作为当前包的布局证据；顶部 `furina-workbench.png` 为宣传视觉。此次图片 URL 已核对，工具未返回可检视像素，因此不对截图中的具体间距、颜色、对比度或尺寸作视觉验收结论。

## 可复用的具体交互及实现依据

### 1. 元数据回填分清作用范围

YILING [GalleryDetailDialog.js](https://github.com/YILING0013/novelai_local_web/blob/d244ec9dfa919cd039789df06cfddfb6e6d8c765/next_nai_web/src/components/gallery/GalleryDetailDialog.js) L132 将正向与负向分开应用，L148 单独应用画风，L190–192 提供编辑图片、全部参数、仅提示词入口；L179–182 将用户选中的画风片段放在底部确认区。L82 的长提示词区域采用 `whiteSpace:pre-wrap`、`overflowWrap:anywhere`、高度上限和独立滚动。收益是让用户在复用局部资料时知道将覆盖什么。

Langbai [MetadataApplyPanel.tsx](https://github.com/2786886095/novelai-image-desktop/blob/650d86304ccdd514dd871d7c2334574f6e3be7cc/src/MetadataApplyPanel.tsx) L25–59 显示可回填字段、勾选数量、全选/清空、字段原值和应用成功反馈；[metadata-selection.ts](https://github.com/2786886095/novelai-image-desktop/blob/650d86304ccdd514dd871d7c2334574f6e3be7cc/src/metadata-selection.ts) L11–37 只提取存在的字段，绑定 Seed 与 Seed mode、质量预设与质量开关，使用 `preserveMissing:true`。角色、当前参考图清空和动漫/Furry 模式也是显式选择项。其 UI 同时说明元数据没有附带参考图片文件，后端模型版本仍会影响重现。

**绘世可验证方案：** 若实际回填路径存在覆盖疑惑，先为现有按钮补充明确作用范围和结果反馈；字段选择面板应单独原型演示后再评估。验收用两套明显不同的正负词、Seed、角色和参考图：只应用正向后，其他字段仍等于操作前值；不存在的源字段不清空当前值；成功后可看到变化结果。不能直接把外部项目“默认全选会清空参考图”的行为带入当前创作流程。

### 2. 图库批量处理保留部分成功与可恢复路径

YILING [GalleryWorkspace.js](https://github.com/YILING0013/novelai_local_web/blob/d244ec9dfa919cd039789df06cfddfb6e6d8c765/next_nai_web/src/components/gallery/GalleryWorkspace.js) L60 为搜索作 250ms 防抖，L79–94 用请求版本过滤过期响应；L165–181 聚合成功和失败 ID。L259–268 在选择模式显示选中数量和批量动作，L307–324 区分移入回收站和永久删除确认，部分永久删除失败时保留失败 ID；L271–272 显示错误和进度。导入使用文件拖入状态及反馈（L226–234、L298）。

**绘世可验证方案：** 用 3 张合成图片测试：一张有效、一张解码失败、一张重复。反馈须能指出成功与失败数量，失败后保留可重试项且不重复处理成功项。回收站、永久删除和普通移组不应共用模糊文案。这里只是测试标准，尚未证明绘世存在对应缺陷。

### 3. 历史图片菜单支持完整键盘导航

Langbai [HistoryItemMenu.tsx](https://github.com/2786886095/novelai-image-desktop/blob/650d86304ccdd514dd871d7c2334574f6e3be7cc/src/components/HistoryItemMenu.tsx) L23–29 在打开后测量位置并聚焦首个可用按钮；L40–53 提供 `aria-haspopup/expanded/controls`、menu/menuitem、Escape 关闭并返回触发按钮、上下键循环、Home/End；L33 的外部指针监听关闭菜单，不建立遮挡图片的 backdrop。

**绘世可验证方案：** 菜单打开后按上下键，焦点在可见动作中移动；Escape 回到原图更多按钮；靠近窗口边缘的菜单仍完整可见。图片点击关闭旧菜单的同时是否选择新图，属于需要先确认的一致性交互选择，不能在局部修复时悄悄改变。

### 4. 多面板调整有取消和键盘等价操作

Langbai [HistoryRailControls.tsx](https://github.com/2786886095/novelai-image-desktop/blob/650d86304ccdd514dd871d7c2334574f6e3be7cc/src/components/HistoryRailControls.tsx) L24–27 将分隔条作为可聚焦 separator 并报告当前宽度；L28–45 使用 pointer capture，提交或取消拖拽；L46–63 支持双击恢复 340 宽、左右键调整、Enter/Space 折叠、Escape 取消。YILING [main/page.js](https://github.com/YILING0013/novelai_local_web/blob/d244ec9dfa919cd039789df06cfddfb6e6d8c765/next_nai_web/src/app/main/page.js) L478–499、L684–737 实现隐藏/图标/完整侧栏三档及显式展开状态。

**绘世可验证方案：** 先验证当前面板在 1280×720 下是否挤占主要内容，再决定是否需要可调宽。侧栏三档、默认隐藏或重排工作台都属于核心导航设计，需原型比较和用户决策，不能根据参考仓库直接照搬。

### 5. 详情返回保留查找上下文，同时尊重用户的新操作

Langbai [use-gallery-return.ts](https://github.com/2786886095/novelai-image-desktop/blob/650d86304ccdd514dd871d7c2334574f6e3be7cc/src/use-gallery-return.ts) L14–40 保存列表滚动位置，区分返回列表和转去新搜索；L42–84 等待瀑布流重新测量后恢复，滚轮、指针或键盘输入会取消恢复；L86–105 处理 Alt+Left/BrowserBack，预览比详情高一级，其他模态框优先拥有输入。

**绘世可验证方案：** 搜索→滚动到第 N 张→详情→返回，搜索和滚动都保留；在恢复期间主动滚动不会被拉回；切换新搜索不恢复旧偏移。这种状态修复若实际复现，可保持导航不变而独立完成。

### 6. 提示词连续编辑保留选区，并保护输入法和文字撤销

YILING [usePromptWeightShortcuts.js](https://github.com/YILING0013/novelai_local_web/blob/d244ec9dfa919cd039789df06cfddfb6e6d8c765/next_nai_web/src/components/ai-painting/PromptEditor/usePromptWeightShortcuts.js) L13–30 在调权后恢复选区，L33–42 只对当前输入框处理 Shift+滚轮并阻止页面跟随滚动，L47–54 处理 Alt+上下且排除输入法 composing。其 [promptCache.js](https://github.com/YILING0013/novelai_local_web/blob/d244ec9dfa919cd039789df06cfddfb6e6d8c765/next_nai_web/src/components/ai-painting/utils/promptCache.js) 按模型保存正负词、验证读取结构，只有新缓存落盘成功才删除旧键。

**绘世可验证方案：** 长提示词、中文输入法、部分选中、多次调权和 Ctrl+Z 都测试；切页与切模型的草稿策略须写明。按模型分别存草稿会改变用户预期，需要先看当前约定，不能仅因参考实现存在就采用。

### 7. 局部重绘的撤销、会话返回与源图校验

YILING [InpaintWorkspacePanel.js](https://github.com/YILING0013/novelai_local_web/blob/d244ec9dfa919cd039789df06cfddfb6e6d8c765/next_nai_web/src/components/ai-painting/InpaintWorkspace/InpaintWorkspacePanel.js) L746–782 对快照去重、截断 redo 分支并限制历史长度；L863–882 仅在非文字输入目标上接管 Ctrl+Z/Ctrl+Y。[InpaintControls.js](https://github.com/YILING0013/novelai_local_web/blob/d244ec9dfa919cd039789df06cfddfb6e6d8c765/next_nai_web/src/components/ai-painting/InpaintWorkspace/InpaintControls.js) 显式区分绘制目标（蒙版/图像）、画笔/擦除/选区、移动画布/视口和蒙版透明度。

Langbai [inpaint-edit-session.ts](https://github.com/2786886095/novelai-image-desktop/blob/650d86304ccdd514dd871d7c2334574f6e3be7cc/src/inpaint-edit-session.ts) L5–29 保存成功提交前的源图、蒙版、原图坐标选区和尺寸模式；L32–87 在恢复前解码，核对原图和蒙版尺寸、处理 15 秒解码超时。文案说明“返回编辑”恢复提交前的状态，生成结果继续留在历史。

**绘世可验证方案：** 合成棋盘图→画两笔→擦一笔→撤销/重做→调整选区→切页返回；图像/蒙版目标始终可辨识。离线验证保存与恢复，收费生成后返回仅用隔离模拟响应测试并标记模拟。不能把仅内存会话误写成重启后可恢复草稿。

### 8. 排队和取消准确说明作用范围

YILING [useImageGeneration.js](https://github.com/YILING0013/novelai_local_web/blob/d244ec9dfa919cd039789df06cfddfb6e6d8c765/next_nai_web/src/components/ai-painting/Generation/useImageGeneration.js) L105–146 逐张推进批量，完成后立刻回调显示；出错时记录该张并停止。L149–163 取消批量控制器，页面关闭或路由切换时拦截尚未发送的后续请求，不能据此声称已发送请求已撤销或不会计费。

**绘世可验证方案：** 模拟 3 项队列，取消时区分等待、已发送、已成功。只显示已经证实的取消结果，不自动重试收费请求。真实付费成功/取消/扣费行为此次不得验收。

### 9. Agent 将“方案未准备好”和“图片生成失败”分开

Langbai [agent/image-outcome.ts](https://github.com/2786886095/novelai-image-desktop/blob/650d86304ccdd514dd871d7c2334574f6e3be7cc/src/agent/image-outcome.ts) 定义 proposal/generation 两阶段，区分等待确认、修正方案、生成中、空结果、部分成功和修正失败暂停，并保留返回对话路径。[AgentQuestionCards.tsx](https://github.com/2786886095/novelai-image-desktop/blob/650d86304ccdd514dd871d7c2334574f6e3be7cc/src/components/AgentQuestionCards.tsx) 提供问题进度、推荐项、自由输入、取消、busy fieldset 与 `role=alert` 错误反馈。可复用的是阶段状态与恢复入口，不能仅凭文本正则声称完全理解用户授权。

**绘世可验证方案：** 离线模拟普通聊天、附图、切模型、待确认方案、用户取消、方案错误和部分图片成功。切模型后旧方案是否失效须基于产品现有协议决定。截图明确标注模型回复和生图结果为模拟。

## 对首阶段的应用顺序

1. 先用绘世真实 GUI 证据确认入口发现、点击路径、草稿、返回、长文本、错误和焦点问题；上述模式只作为定位和验收的参照。
2. 优先处理不改创作语义的状态反馈、明确文案、缺失标签、溢出、焦点恢复、详情返回位置等已复现局部缺陷；每项须有前后实际截图和流程重跑。
3. 参数选择回填、可调多面板、侧栏形态、工作台布局、默认草稿策略或新的确认阶段，先基于现有组件做可交互原型，展示深浅色与真实切页状态，让用户作重大取舍。
4. 参考代码的存在不代表功能已在绘世实现或迁移完成。保留 MOBILE_PARITY 未完成项，不以审美调整删除既有功能要求。

实现参考应以重新表达交互为主。YILING 声明 AGPL-3.0，Langbai 声明 MIT 代码许可；具体代码复制需遵循其许可证，宣传图和第三方角色素材不作为绘世资产。此次没有复制产品代码、下载模型或导入图片资产。

## 尚未完成的参考验收

- 两个参考项目未安装、未运行，所有交互运行效果仍待实测；本文件不宣称其 Windows 可用性或视觉质量优于绘世。
- 仓库截图仅核实路径与来源说明，未获取可检视像素；无像素层级比较结论。
- 未测试参考项目的 1280×720 / 1440×900 / 1920×1080、亮暗主题、高 DPI、性能与辅助技术表现。
- 没有真实账户、付费调用、外部写入；不存在待确认的收费操作结果。

# 绘世 PC：首轮 UI/UX 证据审计

日期：2026-10-20。状态：**首轮基线审计交付；没有全面重构，没有产品 React/CSS 修改**。

## 结论与交付边界

绘世已有可用的任务分区、独立编辑/预览/历史区、稳定生成操作区、元数据逐字段回填、蒙版撤销及 Agent 确认门。优先处理的不是整体换皮，而是：小窗口主要输入的发现成本、回填的破坏性默认选择、失败后草稿恢复、长表单操作区，以及旧模型提醒的触发时机。

本轮是同一名审计代理分别采用新用户、熟练 NovelAI 创作者、产品设计与工程三种视角的启发式评估，**不是真人研究**。点击和截图来自 Windows 上运行的真实 Electron 生产构建。界面入口先凭截图寻找，再操作；问题出现后才查源码。没有用 DOM 选择器或产品内部 API 跳转页面。

交付：[截图与动作证据](evidence/uiux-20261020/index.html)、[逐步任务记录](evidence/uiux-20261020/task-records.md)、[原始动作 JSON](evidence/uiux-20261020/actions.json)、[截图像素与 SHA-256](evidence/uiux-20261020/screenshot-manifest.json)、[参考调查](evidence/uiux-20261020/reference-research.md)、[功能与规划地图](evidence/uiux-20261020/project-map.md)、[复跑步骤](UIUX_REPRO_20261020.md)。证据浏览器用于查看实际截图，不是产品交互原型。

## 环境、分支与隔离

- 指定基线：`feat/electron-m4-migration`，`dfd7caa63ae19bd40651e00127a71efe57b71b4e`。
- 独立本地克隆：`E:\Codex无项目文件夹\2026-10-20\task\uiux-workspace`；分支 `feat/uiux-evidence-audit-20261020`。
- 原工作树 `E:\NAI-WorldPainter\PC端` 在 `feat/agent-r4-refactor`，起始 HEAD `f85f73ce841ecf106d452cd3779b95033e5a4282`，已有未跟踪开发文档。没有切换或修改它。用户要求独立工作区优先于 AGENTS.md 中历史的单目录约定。
- 远端分支读取得到上述 SHA；远端 clone 未收到对象后已中止并退出。随后从本机相同 SHA 用 `--local --no-hardlinks --single-branch` 建立独立克隆，不复制未跟踪资料或用户数据。
- Windows `10.0.26200`、x64；Electron `42.11.0`、Chromium `148.0.7778.280`。主显示器 2048×1152 DIP、125% 缩放、240Hz；没有进行帧率测试。详见 [runtime.json](evidence/uiux-20261020/runtime.json)。
- `WORLDPAINTER_DATA_DIR` 与 `NAI_UI_CAPTURE_USER_DATA` 指向同一个全新 `.tmp/uiux-*` profile。APPDATA、LOCALAPPDATA、USERPROFILE、HOME、TEMP、TMP 全部隔离，清除继承的凭据/便携模式变量；跳过旧凭据恢复。没有读取真实图库、真实凭据或真实工作区。
- Windows 控制技能及浏览器技能已阅读，但当前会话没有可调用的控制入口。改用官方 Playwright 的 Electron 驱动：真实可见 BrowserWindow、坐标鼠标/键盘输入、Electron `capturePage` 截图；不是浏览器预览。物理鼠标、Windows 原生弹窗与系统级辅助技术不在验收范围。
- 只有文件选择回执和模型传输被模拟。Electron 原生文件选择器、HTML file chooser 都固定返回 `.tmp` 合成夹具，避免展示个人目录；产品读取/解析/保存代码、React 组件、产品 IPC 和 Agent 工具真实运行。LLM 连接到仅监听 `127.0.0.1:42377` 的模拟服务，无外联代码。没有配置生成账户，没有真实付费生图或模型调用。
- 测试包装器阻断远端 HTTP/fetch/Chromium 请求，保留产品 `nai-local:` 本地协议。公开更新探测被阻断，见 [blocked-network.json](evidence/uiux-20261020/blocked-network.json)。这不是操作系统网络隔离证明。

## 已验证的优点

1. [主工作台](evidence/uiux-20261020/screenshots/003-generate-1280x720-dark.png)把编辑、预览和历史独立分区；固定主按钮没有随长参数滚出窗口。历史日期/分组入口直观。
2. [蒙版绘制](evidence/uiux-20261020/screenshots/036-inpaint-mask-painted.png)、[擦除](evidence/uiux-20261020/screenshots/038-inpaint-mask-erased.png)、[Ctrl+Z 恢复](evidence/uiux-20261020/screenshots/039-inpaint-undo-keyboard.png)和[区域框](evidence/uiux-20261020/screenshots/041-inpaint-region-drag.png)使用同一源图，反馈清楚。
3. [旧资料预览](evidence/uiux-20261020/screenshots/045-legacy-import-preview.png)明确只读检查、条目数和不覆盖草稿的规则；[导入结果](evidence/uiux-20261020/screenshots/046-synthetic-import-confirmed.png)逐项报告新增和跳过。本轮已有草稿被保留，合成历史新增 1 条。
4. [元数据读取失败](evidence/uiux-20261020/screenshots/052-gallery-metadata-open.png)给出重试和显式离线恢复，没有静默换模式；[逐字段选择](evidence/uiux-20261020/screenshots/064-metadata-seed-selected.png)可保留其他草稿。本轮只应用正向词/Seed，负向词和画师串保留，Seed 变为固定 424242，见 [运行后断言](evidence/uiux-20261020/post-run-assertions.json)。
5. [Agent 模型切换](evidence/uiux-20261020/screenshots/092-agent-model-switch-menu.png)显示视觉能力；[确认卡](evidence/uiux-20261020/screenshots/108-agent-real-confirmation-card.png)在工具执行前停住并展示本地费用估算。[取消结果](evidence/uiux-20261020/screenshots/110-agent-cancel-complete.png)明确停止，不自动重试。此过程只发生两次本机模型传输，生成历史仍为 1 条。
6. [漫画入口](evidence/uiux-20261020/screenshots/114-comic-ready.png)通过四步结构说明导入→设置→分镜→生成；[浅色主题](evidence/uiux-20261020/screenshots/125-generate-light-settled.png)保留白/蓝产品身份，深色保留暖金身份。

## 按影响排序的问题

### B01 / P0 构建阻碍：干净克隆缺少静态源码资源（本轮已修复前置条件）

干净克隆安装锁文件依赖后，`npm run build` 首先无法解析 `./data/prompt-edit-templates`、`./data/prompt-templates`、`./data/prompt-templates-v45`；恢复这些资源后 Electron 编译又发现 `electron/data/tag-dictionary.ts` 缺失。不是界面运行结果，证据为[原始错误摘录](evidence/uiux-20261020/baseline-build-failure.txt)。

根因：根 `.gitignore:29` 的 `data/` 同时忽略源码目录。迁移 manifest 列有 10 个文件，但基线 Git 未跟踪。用户无法从指定分支独立构建，审计也无法启动真实客户端。

本轮仅恢复本机源码与固定上游迁移清单 **逐字节 SHA-256 完全相同**的 10 个静态资源，并添加精确目录例外；来源 `7bc76ded4f539949a52f29fba32e2d896d2f89b7`，MIT/嵌套许可沿用原资料。见 [资源恢复清单](evidence/uiux-20261020/restored-source-resources.json)。未复制用户 data。修复后 build、typecheck 通过。验收是新干净克隆能构建，运行时数据目录仍被忽略；本次没有对应“修复前 GUI”，因为它无法构建。

前置修复本地提交 `8207dd2`。Git按仓库属性将文本CRLF规范化为LF；恢复清单记录复制时的上游原字节，[提交版校验](evidence/uiux-20261020/committed-source-resources.json)另记规范化后的字节/hash，不把行尾差异隐藏为相同hash。

### U01 / P1：小窗口首屏无法发现提示词输入

**位置/复现：**全新 profile 跳过向导，生成页，1280×720 请求窗口。[截图003](evidence/uiux-20261020/screenshots/003-generate-1280x720-dark.png)只有模型、Effort 和风格输入，正负词不在首屏；经历滚动过头、回滚后才到[截图005](evidence/uiux-20261020/screenshots/005-prompt-editor-reached.png)。默认较高窗口也只露提示词上沿，见[截图002](evidence/uiux-20261020/screenshots/002-cold-start.png)。

**影响：**新用户得到“在左侧输入”指示却找不到输入；熟练用户每次往返模型、提示词和 Seed 的滚动成本高。固定未配置账户区域在小窗口约占 200 CSS px；未登录时仍显示未知额度、禁用刷新和登录说明。

**根因：**`App.tsx:3092-3094` 仅在 localStorage 为 `"1"` 时折叠，全新 profile 默认展开；`:3138-3158` 无 Token 也显示完整账户详情；`styles.css:383-398` 表单滚动而 footer 不收缩，`:3650-3654` 额外纵向 padding。`App.tsx:2019-2205` 在提示词前放置模型、Effort、风格与预设操作。

**方案/风险：**第一阶段仅对无账户且没有显式偏好的情况默认收起账户详情，保留“设置 API”和主动展开；尊重既有 `"0"/"1"`。先用真实截图验证收益，不预先声称单项就让提示词完整进入首屏。若仍不足，再用真实组件比较“常用输入优先”原型，参数重排留用户确认。风险是隐藏账户信息或覆盖既有折叠偏好。

**验收：**1280×720/1440×900 深浅主题；新 profile、已展开、已折叠、有账户四类状态；设置 API 可达、主按钮可见、草稿不变。参照 YILING 的局部滚动及提示词工作区，不复制品牌或 AGPL 源码。

### U02 / P1 风险：元数据默认全选包含清空当前参考图

**实证：**[截图061](evidence/uiux-20261020/screenshots/061-metadata-apply-fields.png)默认 20/20，包含“清空当前参考图 0”“独立角色提示词与位置 0”和空风格。说明文字在所有选项之后。用户可能以为在恢复图片已有参数，实际也可能清掉当前参考/角色。**本轮验证了默认选择与代码清空路径，没有构造已有参考图被清空的 GUI 丢失场景。**

**根因：**`MetadataApplyPanel.tsx:25-59` 默认全选可应用字段；`metadata-selection.ts:17-33` 构造 patch；`store.ts:1209-1230` 应用角色与参考状态。源图没有嵌入参考文件，也生成清空项。

**方案/风险/决策：**先给破坏性变更摘要和明确“将清空 N 张参考图/角色”；对没有源数据的清空动作独立选择。需要用户决定是默认只恢复有源值的字段，还是保留全选并加强清空确认。不能未经确认改变熟练用户的全量复现语义。第一参考的单向回填保留其他状态是依据，第二参考同样有此默认风险，不能直接照搬。

**验收：**提示词/模型/Seed/角色/Vibe/精准参考分别有现值；仅正向、仅 Seed、全量、显式清空四组场景；取消不变；所选字段与最终 diff 一致。当前实际通过的是仅正向+Seed，未选负向与画师串保留。

### U03 / P1 恢复风险：Agent 未发送文本与附件冷启动恢复不一致

**实证：**[截图097](evidence/uiux-20261020/screenshots/097-agent-request-result.png)发送前置失败后，文字仍留输入框；同一 profile 冷启动，[截图100](evidence/uiux-20261020/screenshots/100-agent-resumed-draft.png)文字清空，合成附件仍恢复。该失败来自测试包装器旧 appPath，不算产品缺陷；这里的问题是已有草稿的恢复差异。

**根因：**`PiAgentPage.tsx:70/162/168/193-196` 文本只写组件 map 和 sessionStorage；新窗口不会恢复旧 sessionStorage。`:217-227` 失败回填仍是临时位置。附件在 `agent-store.ts:772-774/795` 写工作区，`:493-500` 原子落盘；会话类型 `agent/types.ts:236-244` 有 draftAttachments，没有持久化未发送文本字段。

**方案/风险：**文本和附件按 conversation ID 统一持久化，恢复后仍为未发送；输入更新防抖，成功提交清除，失败保留。不要用过期整份 workspace 覆写最新会话。涉及状态持久化，适合独立增量，不能仅改样式。

**验收：**输入+附图不发送→冷启动；消息建立前失败→重开；两会话切换→重开；成功发送→重开不重复。各自恢复且不自动提交。本轮没有模拟操作系统崩溃或断电。

### U04 / P2：Agent 模型长表单把保存/取消推离屏幕

**实证：**[截图070](evidence/uiux-20261020/screenshots/070-agent-model-config-ready.png)首屏看不到保存；滚动后见[截图083](evidence/uiux-20261020/screenshots/083-agent-config-save-discovery.png)。增加第二模型后操作区继续下移，[截图088](evidence/uiux-20261020/screenshots/088-mock-model-settings-saved.png)记录一次按旧位置点击而未保存；再滚动至[截图089](evidence/uiux-20261020/screenshots/089-model-save-after-add-scroll.png)才找到保存。088 文件名是操作意图，不是成功声明；真正保存见091。

**根因：**`AgentProviderSettings.tsx:105/129/135` 在模型集合之后放普通流 footer；`AgentModelCollection.tsx:69-81` 每模型完整展开；`agent-provider-settings.css:3/18/19/32` 无受限滚动；`pi-agent-page.css:295` 整个模态 overflow:auto。

**方案/风险：**该模态限定高度，头部/操作区固定，配置主体单独滚动，错误反馈与按钮同区。不改变 Provider/模型语义。该组件也用于总设置 `App.tsx:6207`，需隔离宿主选择器，避免双重滚动。

**验收：**单/双/多模型、1280×720/1440×900、深浅主题始终可见保存、取消和错误；键盘能到达所有字段；保存前后值一致。可借鉴第一参考设置导航与内容独立滚动的做法。

### U05 / P2：主动选择旧模型后才弹“V5 已上线”

**复现：**全新 profile 默认 V5→下拉选 V4.5 Full→[截图014](evidence/uiux-20261020/screenshots/014-model-v45-selected.png)。提醒描述升级旧项目，却打断刚作出的明确选择；需额外点“保持当前模型”。选择值最终保留，见016。

**根因：**`App.tsx:6961-6973` 直接依赖实时 paramsModel。新 profile 默认 V5 不显示，也不写 seen；后续切旧模型立即满足条件。

**方案/风险：**在恢复完成后的首次挂载固定提醒资格；新默认 V5 不具资格，用户后续切换不触发。保留旧持久化 V4/V4.5 的一次提醒和 seen 标记。避免迁移用户再也看不到必要提示。

**验收：**新 profile V5→V4.5→V5 无提醒；旧 profile 启动仍提示一次；关闭并重开不重复；模型、提示词、画师串均不改。此项与核心导航无关，可独立验证。

## 三种视角的首轮判断

| 视角 | 已观察到的主要摩擦 | 应保留的能力 |
|---|---|---|
| 不懂代码的新用户 | 提示词首屏不可见；API/Provider/协议/模型层级多；模型设置保存在长表单底部 | 未连接与未配置模型提示、导入预览、清楚的重绘空态和漫画四步说明 |
| 熟练创作者 | 模型/词/Seed 往返滚动；参数回填的清空默认；Agent 草稿重开不一致 | 固定 Seed、独立正负词、字段回填、Ctrl+Z、参考能力标识、确认门和失败恢复 |
| 产品设计与工程 | 干净克隆不可构建；持久化保证不一致；操作区不稳定；测试与 GUI 证据不能相互替代 | 现有绘世深浅主题、成熟工作区、冻结方案/授权门、完整手机 parity 范围 |

## 实际覆盖与未覆盖

| 条件/任务 | 本轮结果 |
|---|---|
| 初次启动→生成配置 | 通过可见界面完成；无账户，不提交付费请求 |
| 正负词、模型、画师串、Seed | 实际编辑及截图；正常重开保留生成草稿；元数据后 Seed/负向/画师串有隔离存储断言 |
| 历史过滤、元数据与回填 | 合成历史1条、日期/分组入口、菜单/Escape、离线读取与2字段回填已测；多日期切换、搜索、批量选择与大型图库未测 |
| 重绘导入/画笔/橡皮/撤销/区域 | 实际完成；Windows文件选择器仅回执模拟；蒙版独立保存、重开恢复、候选/付费生成和区域输出未测 |
| Agent | 合成附图、模型配置/切换、超时/恢复草稿、真实准备工具、待确认卡及取消已测；LLM传输模拟，未测试真实模型质量或付费执行 |
| 漫画/工具 | 通过“工具→漫画生成器”切换到四步入口；未生成、导出或验证项目重开 |
| 素材/创作 | 有顶栏/更多入口的静态调查；未完成实际切换和端到端验收，留后续待办 |
| 设置/主题 | API、绘世资料、外观导航实际操作；深→浅切换与浅色生成页截图；无主题全页面矩阵 |
| 1280×720、1440×900 | 初期真实窗口请求成功，003 PNG=1600×903、011 PNG=1800×1125（125%DPI/边框舍入）；不把PNG像素等同CSS尺寸 |
| 1920×1080 | 后期请求但截图仍为1733×1128，**未确认生效，不计通过**；121文件名仅表示请求目标，122再次核对尺寸无变化 |
| 100%/150%/200%、多屏 | 未测；本机实际125%是唯一真实DPI条件，未改Windows缩放 |
| 键盘/拖拽/上下文 | Ctrl+Z、图库菜单Escape、模型下拉键盘、蒙版拖画已测；外部文件拖入、全程纯键盘、屏幕阅读器与原生上下文菜单未测 |
| 长文本/多角色/批量/多面板/性能 | 仅合成短词、两个模型和单历史；未进行长文本/多角色/大图库/批队列/长任务压力、帧时间或内存验收 |
| 加载/失败/取消/队列 | 截图保留懒加载和模型超时、显式恢复、确认取消；没有付费生成的加载/失败/取消/队列验收 |

少量截图为过渡帧，不能据此判定产品闪烁/双选中。031 本地协议误拦、097 包装器路径错误、首次模型超时的网络隔离问题均在记录中说明，不计产品缺陷。所有截图保留原样，未裁切、重绘或合成。

## 自动检查结果

- `npm ci --ignore-scripts --no-audit --no-fund`：605 包安装成功；Electron 官方安装脚本成功。模型下载脚本未运行。
- `npm run build`：修复资源遗漏后通过；保留 Vite 大 chunk 警告。[日志](evidence/uiux-20261020/build-after.txt)。
- `npm run typecheck`：通过。[日志](evidence/uiux-20261020/typecheck.txt)。
- 定向 `vitest run src/ui-consistency.test.ts src/metadata-selection.test.ts src/prompt-template-audit.test.ts electron/ipc/pi-agent-core.test.ts`：4文件、116测试通过。[日志](evidence/uiux-20261020/tests-targeted.txt)。
- 首轮全量：沙箱系统临时目录缓存重命名 EPERM，450文件均未执行测试。不可当产品450项失败。[原日志](evidence/uiux-20261020/tests.txt)。
- 改用工作区 TEMP/TMP 后全量：**402文件通过、47失败、1跳过；3995测试通过、126失败、2跳过，共4123**。[日志](evidence/uiux-20261020/tests-full.txt)。没有把所有失败归为环境：126唯一失败中48明确loopback EACCES、28明确文件系统EPERM、2缺失固定夹具、23通用Connection error、2 DNS/代理路由、22尚未定因（14断言/7 TypeError/1超时）、1 Electron异常退出；另有1缺测试证书的套件载入失败。重复 FAIL 来自重试，不能计379个独立失败。缺失文件是基线未跟踪的固定夹具，不推断版权原因。
- `git diff --check`：通过。没有推送、合并、发布、安装器或真实渠道验收。

## 第一阶段建议与下一增量

1. **当前交付点：**接受首轮问题/证据与限制，保留现有导航和绘世身份；构建完整性前置修复独立提交。暂不实施产品前端局部修复。
2. **首批局部修复候选：**U05提醒资格、U01无账户默认收起、U04模型设置固定操作区，分别提交。每项先保留前图，再跑同样隔离GUI及深浅主题/窄高窗口；功能测试与视觉验收分别记录。
3. **独立状态增量：**U03文本/附件统一草稿持久化，覆盖冷启动、失败、切会话、发送后清理和并发返回；不要仅靠source字符串测试。
4. **需确认的语义：**U02默认恢复字段与清空参考的策略。用真实 `MetadataApplyPanel` 和主题做两种局部交互对比，再确定默认值；不得借此更改生成或导航主流程。
5. **继续补证：**1920×1080真实视口、其余DPI、素材/创作页、重绘保存恢复、历史批量/多日期、多角色、长文本、队列和性能；逐项保留未验收状态。手机 `MOBILE_PARITY.md` 的110项追踪范围不删改，不把当前源码存在或本轮通过项当全量完成。

后续若要改变栏顺序、核心导航或整体视觉，先用现有 React 组件和设计系统搭建可交互原型，包含真实页面切换、空态/加载/失败/确认状态及深浅主题；让用户比较后决定。本轮不为原型延迟审计。

## 参考依据

第一参考 YILING 固定 `d244ec9dfa919cd039789df06cfddfb6e6d8c765`，第二参考固定 `650d86304ccdd514dd871d7c2334574f6e3be7cc`。见[含固定链接的调查](evidence/uiux-20261020/reference-research.md)。YILING 标注 AGPL-3.0；第二参考 MIT；本轮没有复制其新增代码。

- YILING `GalleryDetailDialog.js` / `galleryPromptApplication.test.mjs`：将正向、负向、画风和全部参数区分，单向回填保留其他状态。
- YILING `InlinePromptInput.js` / `PromptSuggestions.js` / `usePromptSuggestions.js`：原生输入、IME组合保护、浮层及光标恢复。后续中文逗号、长词、输入中加载状态应实测。
- 第二参考 `MetadataApplyPanel.tsx`、`InpaintCanvas.tsx`、`inpaint-edit-session.ts`、`HistoryItemMenu.tsx`、`use-gallery-return.ts`：字段回填、撤销、恢复、键盘与图库返回。
- 第二参考 `PiAgentPage.tsx` / `pi-generation-preparation.ts`：真实准备、一次性执行、确认/取消；全自动无额外预算上限不能不加评估地照搬。
- 历史报告 [#68](https://github.com/2786886095/novelai-image-desktop/issues/68)、[#70](https://github.com/2786886095/novelai-image-desktop/issues/70)、[#71](https://github.com/2786886095/novelai-image-desktop/issues/71)转成后续中文逗号、翻译方向持久化、加载时输入框跳动回归场景；**不是本次绘世复现**。

两个参考应用本轮都没有运行。README截图/宣传图不能代替当前界面验收；第二参考工作台图为2026-08-30/v2.0.1历史截图。

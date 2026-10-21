# 绘世 PC UI/UX 阶段状态（进行中）

## 最终检查点：首轮已交付

- 完整报告：`docs/UIUX_AUDIT_20261020.md`；复跑：`docs/UIUX_REPRO_20261020.md`。
- 证据索引：`docs/evidence/uiux-20261020/index.html`；125张原始截图、62次鼠标点击，逐步记录与哈希清单齐备。
- Agent已完成合成附图、模型切换、本机模拟模型→真实准备工具→真实确认卡→取消停止。没有生图；模型传输仅2次loopback请求。
- 深浅主题及漫画入口已补证；1920×1080请求未被实际截图尺寸确认，未计通过。
- build/typecheck通过；定向116通过；全量3995通过/126失败/2跳过，另1套件载入失败，详见报告分组。
- Electron和mock服务已关闭；没有下载/clone/付费任务在等待。产品React/CSS未修改，原工作树未改动。
- 下方保留早期进行中快照，不能当最终覆盖情况。

更新时间：2026-10-20；此文件仅陈述已完成事实，完整审计将另存 docs/UIUX_AUDIT_20261020.md。

- 独立克隆：本目录 uiux-workspace。分支 feat/uiux-evidence-audit-20261020，指定基线 dfd7caa63ae19bd40651e00127a71efe57b71b4e。
- 原工作树 E:\NAI-WorldPainter\PC端 位于 feat/agent-r4-refactor，已有未提交文档；未切换、未改写。
- 远端 clone 无对象返回后已经 Ctrl+C 退出，结果为失败；随后从本机相同基线用 --local --no-hardlinks 建独立克隆成功。没有运行中的 clone 或依赖下载。
- npm ci --ignore-scripts 成功。官方 Electron 安装成功，隔离 Playwright 仅作真实 Electron 坐标输入和截图。
- 干净基线被 .gitignore 的 data/ 误排除源码所阻：恢复迁移清单 SHA256 完全一致的9个 src/data 资源及 electron/data/tag-dictionary.ts，补入忽略例外。build 和 typecheck 已通过。
- 真实 Windows Electron 42.11.0 / Chromium 148.0.7778.280 / x64 正在运行。系统 10.0.26200，显示器 2048×1152 DIP，实际 DPI 125%。1280×720 与1440×900窗口已实测。
- 全新隔离 profile、APPDATA、LOCALAPPDATA、USERPROFILE、HOME、TEMP、TMP；关闭旧凭据迁移；无真实凭据/账户。外联由审计启动器阻断，没有付费请求。
- 截图 docs/evidence/uiux-20261020/screenshots，当前001至052。动作 docs/evidence/uiux-20261020/actions.json；环境 runtime.json。
- 已实测：首次启动/跳过向导；正负词输入；V5→V4.5模型切换；合成画师串；固定Seed4242；正常重开后提示词/画师串保留；重绘导入合成PNG、画笔、橡皮、Ctrl+Z、区域框；设置与绘世资料；合成旧PC工作区只读预览→明确确认→追加导入→刷新；历史1条；更多菜单、Escape；查看原数据及离线失败恢复入口。
- 选择文件回执由测试启动器固定到合成文件，未测试Windows原生文件选择器。产品IPC与真实React界面没有模拟。截图使用真实BrowserWindow.capturePage。
- 测试防护曾误拦nai-local协议，已纠正；031截图为测试工具问题，不能计产品缺陷。后台截图节流导致少量过渡帧，已通过保持后台绘制修正，不能据此做性能结论。
- 已确认待优化：小窗口首屏找不到提示词；新profile主动切旧模型触发V5升级提醒。尚未修改产品React/CSS。前者根因是固定展开的账户额度footer和字段顺序；后者根因是提醒资格错误依赖实时模型。
- 仍待本轮检查：Agent入口/附图/模型与确认、漫画/素材/创作切换、深浅主题、1920×1080；其他DPI、真实模型、付费生图、压力/长任务仍不验收。
- 已检查 .agents/skills：独立克隆和原PC目录均不存在。没有此处附加技能要求。

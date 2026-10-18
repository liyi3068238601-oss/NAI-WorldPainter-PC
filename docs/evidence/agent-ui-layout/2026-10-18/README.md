# Agent 界面布局检查证据

日期：2026-10-18。基线：`cf1205c04ec76701f6e58960a5e0956958804dfe`。本目录随本轮界面修复一起提交；当前提交可由 `git log -1 -- docs/AGENT_UI_LAYOUT_2026-10-18.md` 查询。

全部截图使用独立 Electron userData 和合成记录，不含正常用户 profile、图库、私有提示词或真实凭据。验证用 provider 为本地合成配置，未发送模型或付费图片请求。

## 文件

| 文件 | 来源和含义 |
| --- | --- |
| `final-package-body-link-native-1387x902.jpg` | 最终 Windows x64 目录包冷启动后的实际窗口截图，应用字号 100%、深色；原生截图工具输出大小约 1387×902。 |
| 同名 `.png` / `.json` | 同一实际窗口的 CDP renderer 像素截图与 DOM 几何；CSS 视口 1386×902、环境 DPR 1.25，所以像素截图尺寸与原生 JPG 不同。JSON 中保留原采集路径。 |
| `final-package-home-1387x902.json` / `final-package-end-1387x902.json` | 在最终包用原生键盘调整输入区后，实际高度与 ARIA 数值的对应记录。 |
| `final-scale150-native-1387x902.*` / `final-scale200-native-1387x902.*` | 真实 Electron 主进程/preload/renderer，实际应用字号设置分别为 150、200；JPG 为原生窗口，JSON 为几何。与最终包加载相同的 Agent 构建资源。 |
| `final-scale200-viewport-1280x720.*` | CDP renderer 视口模拟 1280×720，应用字号 200%；非物理窗口调整。 |
| `final-scale200-viewport-800x720.*` | CDP renderer 视口模拟 800×720，应用字号 200%，创作模态抽屉打开；此时遮罩阻止主区输入是预期行为。 |
| `final-scale200-viewport-800x720-panel-closed.*` | 关闭抽屉后的对应截图与几何，固定输入/操作控件点击位置未被遮挡。 |
| `final-light-native-1387x902.*` | 原生窗口浅色主题、应用字号 100% 的对照检查。 |
| `native-verification.json` / `native-verification.source.json` | 原生操作、应用设置与视口模拟的范围、断言、限制和自建进程停止回执。前者将截图相对引用改为本目录文件名，后者逐字节保留采集报告原文及原路径。 |
| `final-native-model-menu-1387x902.jpg` 等菜单截图 | 模型、上下文和生图设置的原生点击检查，操作发生在相同交互实现、较早的输入区空间预算版本；不能替代最终包主图。 |
| `stop-receipt.json` / `final-package-preset-restored.json` | 自建测试进程的路径核对、停止状态，以及包内当前预设已恢复启用的真实 preload 投影。 |
| `renderer-errors.json` | 最终包被监测时段的 renderer 错误事件；不代表未监测时段的完整日志。 |
| `fixture-manifest.json` | 合成资料标识和图片摘要，不包含测试 profile 数据库。 |
| `package-verification.json` | 最终 EXE、app.asar 的 SHA-256 和包内 8 个关键资源与当前构建的一致性。 |
| `vitest-final.json` | 最终全量测试原始 JSON：480 文件、4351 项，4349 通过、0 失败、2 跳过。 |
| `verification-summary.json` | 对归档原始数据的汇总与一致性检查；类型/构建的退出状态来自本轮实际执行回执，并与可重查的包摘要分开记录。 |
| `SHA256SUMS.txt` | 本目录除自身外所有交付文件的字节摘要。证据路径禁用 Git 文本换行转换。 |

## 结论和限制

输入区与设置区已分开计算高度。最终包输入框与发送按钮相隔 8px，固定操作区无重叠或越界，Home／End 与 ARIA 一致。实际应用字号 150%／200%、较小高度与窄视口组合检查通过；模型菜单、上下文、生图设置和会话预设开关经过原生点击检查。

Windows DPI 没有在本轮切换；环境 DPR 为 1.25。应用字号、视口模拟和操作系统 DPI 是不同检查。原生最小宽度仍为 1120px；800px 只证明对应 renderer 布局。局部滚动容器中的图文可在边缘部分可见，不应据此判为固定操作区裁切。没有发出真实请求，因此本证据不证明付费接口、模型生成质量或完整业务链路验收。

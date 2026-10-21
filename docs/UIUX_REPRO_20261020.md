# UI/UX 审计复跑（离线合成数据）

只在独立克隆执行，不使用原工作树、真实 profile、图库、凭据、账户或工作区。不要设置真实生成 Token。不执行真实生图，也不要点击 Agent 的“确认执行”。

## 准备

环境：Windows x64、Node 24；在 `desktop/` 执行：

```powershell
npm.cmd ci --ignore-scripts --no-audit --no-fund
node node_modules/electron/install.js
npm.cmd install --prefix .tmp/uiux-tools --no-save --ignore-scripts --no-audit --no-fund playwright-core@1.58.2
npm.cmd run build
node scripts/create-native-m4-fixture.mjs
node scripts/create-uiux-metadata-fixture.cjs
node scripts/uiux-session.cjs
```

此启动器新建 `.tmp/uiux-时间戳`，隔离所有应用/用户/临时目录，清理继承凭据及便携环境变量，指定相同 `WORLDPAINTER_DATA_DIR`/`NAI_UI_CAPTURE_USER_DATA`，设置正确 appPath 并阻断外部网络。它打开真实 Electron，不加载 uiCapture 查询或模拟 renderer。Windows 启动可能需要执行环境允许的桌面权限。

启动器保持后台绘制，截图不能用于推断前台/后台性能。使用 Electron capturePage；PNG像素尺寸和实际DPI一起记录，不能按文件名判定视口验收。

## 操作与记录

首先观察截图并定位可见入口；不要用 DOM/API 寻找隐藏入口。截图保存在 `docs/evidence/uiux-20261020/screenshots`，动作在 `actions.json`。

控制器读取 `.tmp/uiux-active.txt` 所指目录中的 `request.json`，支持 click/type/key/wheel/drag/resize/snapshot/dialog-fixture/close。例如：

```powershell
$auditRun=(Get-Content .tmp/uiux-active.txt -Raw).Trim()
$auditRequest=@{action='snapshot';label='manual-check'} | ConvertTo-Json -Compress
Set-Content -LiteralPath (Join-Path $auditRun 'request.json') -Value $auditRequest -Encoding UTF8
```

每次只写一个动作，等控制器输出截图文件名或错误后再写下一个，不覆盖未完成请求；错误后先观察，不重复不确定操作。坐标为 CSS/DIP 坐标，截图为125%DPI物理像素，点击前需按实际比例换算。不要把本轮坐标直接用于不同窗口。

`dialog-fixture` 只能接受本克隆 `.tmp` 下的合成文件；它同时替代 Electron 选择器回执和 HTML file chooser，因此不算 Windows 原生文件选择器通过。选择实际入口仍通过可见按钮。测试 PNG为 `.tmp/uiux-fixtures/metadata-fixture.png`；旧PC夹具为 `.tmp/native-m4-fixtures/workspace.sqlite`。后者的生成脚本拒绝覆盖现有夹具，复跑请使用新克隆，不删用户目录。

## 有界任务清单

1. 新profile：观察欢迎页→跳过向导；请求1280×720后核对真实截图尺寸。找到模型、正负词、风格/画师串、固定Seed4242，记录滚动和点击；切V4.5观察V5提醒。
2. 进入重绘；将文件回执设为合成PNG，点击加载；画笔拖画→橡皮→Ctrl+Z→选区超分模式拖框。不要发送生成。返回页面及冷启动后的蒙版保存/恢复应另做用例，本轮未通过。
3. 设置→绘世资料→选择合成workspace.sqlite→只读预览→确认追加→刷新。已有生成草稿应被跳过保留，历史新增1条。
4. 图库更多→查看原数据；联网解析被阻断时点击完全离线。改选含合成元数据PNG→全不选→仅正向/Seed→应用；验证负向、风格不变，Seed固定424242。
5. Agent：确认默认“每次确认”，点击+附合成PNG。通过可见配置表单将本机模拟地址设为`http://127.0.0.1:42377/v1`，Key只用`uiux-local-fixture-only`，选择OpenAI Chat Completions；可添加`uiux-alternate`，原模型保留视觉能力。
6. 与Electron同一Windows网络环境运行 `node scripts/uiux-mock-model.cjs`；先只读GET `/v1/models`确认200。不要在不通时连续重试。沙箱与宿主loopback不互通时，记录具体阻碍，不启动重复服务。
7. 发带`UIUX_CONFIRM`的合成准备请求。模拟端只生成原生tool_calls，真实产品工具产生preparationId；下一步只显示确认卡。**点击取消**，验证停止、无新增生成历史。不要点击确认执行。服务只监听loopback，代码不向外请求。
8. 工具→漫画入口；设置→外观深浅切换。素材/创作、其他DPI、批量/性能等留独立用例，不扩大通过声明。

结束通过 `close` 关闭审计Electron；停止本轮mock服务。若恢复同一已知合成profile，设置 `UIUX_RESUME=1`，不得改为真实profile路径。

## 自动验证

```powershell
npm.cmd run typecheck
$auditTestTemp=Join-Path (Get-Location) '.tmp/uiux-test-temp'
New-Item -ItemType Directory -Path $auditTestTemp -Force | Out-Null
$env:TEMP=$auditTestTemp
$env:TMP=$auditTestTemp
npm.cmd test -- src/ui-consistency.test.ts src/metadata-selection.test.ts src/prompt-template-audit.test.ts electron/ipc/pi-agent-core.test.ts
npm.cmd test -- --reporter=dot
```

本轮定向116通过；全量3995通过/126失败/2跳过，另1套件缺夹具；不能省略失败或用定向结果代替全量。详见审计报告。

任何后续重要前端改动，必须重新构建和运行GUI，保留前后实际截图、同任务回归、自动检查及未解决问题。导航/工作台/视觉方向的大变化先做真实组件原型供用户确认。

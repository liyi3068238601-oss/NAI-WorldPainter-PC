# 第二阶段复跑：隔离 Electron 与原型

只在独立 UI/UX 工作区执行；不要在真实工作区配置环境变量后直接启动产品。本审计不需要账户或付费请求。完整前置环境见 [第一阶段步骤](UIUX_REPRO_20261020.md)。

## 产品 GUI

工作目录 `uiux-workspace/desktop`。已安装的 Electron、Playwright 位于本工作区；干净克隆如缺审计驱动，可用官方 npm 的 `playwright-core@1.58.2` 安装到 `.tmp/uiux-tools`，不是产品依赖。

```powershell
npm.cmd run build
$env:UIUX_EVIDENCE = '../docs/evidence/uiux-phase2-rerun'
Remove-Item Env:UIUX_RESUME -ErrorAction SilentlyContinue
Remove-Item Env:UIUX_PROTOTYPE -ErrorAction SilentlyContinue
node scripts/uiux-session.cjs
```

这会创建全新 `desktop/.tmp/uiux-时间戳`，隔离数据目录、Chromium profile、APPDATA/LOCALAPPDATA/HOME/TEMP，并拦截外部网络。`uiux-active.txt` 只记录本次合成运行位置。不会读取或复制真实账户或图库。控制器输出 ready 后，另开终端在同一目录发送动作；每个动作等待 response 后再发送下一步，超时应先检查结果，不能盲目重试。

```powershell
node scripts/uiux-command.cjs '{"action":"snapshot","label":"manual-inspection"}'
node scripts/uiux-command.cjs '{"action":"resize","width":1280,"height":720,"label":"small-window"}'
```

先看当前原始截图，按可见坐标点击，坐标是 CSS 像素（125% DPI 图像坐标除以 1.25）。不要直接复用不同窗口的坐标。第一阶段与本阶段 `task-records.md` 提供实际入口与操作顺序。

U04：跳过欢迎→生图智能体→配置对话模型；记录顶端截图。用手动模型 ID 新增 `uiux-second-model`，不要加载外部可用模型。运行 `provider-check`；滚动字段至底部后再检查。编辑上下文为 64000 后直接保存，再打开核对；改为 96000 后取消，再打开核对仍为 64000。测试总设置→智能体模型及外观主题。必要时用 snapshot 获得稳定帧，实际 viewport 以动作结果为准。

U05：新配置默认 V5→主动 V4.5；应无提醒。关闭后用 `UIUX_RESUME=1` 启动同一合成 profile，仍无提醒且模型保持。模拟旧配置时，仅将刚才合成 profile 的 `worldpainter-desktop.json` 复制至一个**全新** `desktop/.tmp` 子目录的 `profile/`；不复制 Chromium Local Storage。确认目标不存在、绝对路径仍在本工作区 `.tmp` 内，然后将审计 active 文件指向这个新目录并 resume。应提醒一次；选择保持当前模型、重启后不重复。不能用真实设置构造夹具。

```powershell
node scripts/uiux-command.cjs '{"action":"provider-check","label":"reachable-actions"}'
node scripts/uiux-command.cjs '{"action":"close"}'
```

`verify-uiux-phase2.cjs` 用于复核本次保留的具体合成 profile 与证据；其中 profile 名称固定为本次运行，不能直接当作新运行的通用测试。新复跑应记录新的来源路径与断言。

## 独立原型

在资源管理器进入 `uiux-workspace/docs/prototypes/uiux-20261020`，双击 **workbench.html**。它已内联 React、产品纯 UI 组件与 CSS，无需安装或服务器；不导入产品 App、preload 或账户配置。不要将它当成完整业务演示。

检查顺序：输入正负词→切 A/B→展开/收起账户→切深浅主题→编辑模型/尺寸/Seed（Enter/失焦提交）→切 Agent/漫画/素材/创作/设置再返回→核对草稿。模拟生成先取消、再确认，查看示例元数据与回填。Agent 仅展示模拟确认；长消息需在消息区域滚动，操作区没有额外常驻承诺。关闭/刷新会清空原型内存草稿。

修改原型源码后：

```powershell
node node_modules/typescript/bin/tsc -p prototypes/workbench/tsconfig.json --noEmit
node scripts/build-uiux-prototype.mjs
```

如需隔离 Electron 预览：在全新运行中设置 `UIUX_PROTOTYPE=1`，`UIUX_EVIDENCE='../docs/evidence/uiux-prototype-rerun'`，再启动控制器。此包装器无产品 preload，并将 userData 直接派生为合成 auditRoot/profile。完成后发 close，不保留后台任务。

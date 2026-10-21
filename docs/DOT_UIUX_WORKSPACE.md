# A 分支独立工作副本

当前本地目录：E:/NAI-WorldPainter/dot-uiux。

双击仓库根目录的 `启动绘世-A分支.cmd`。这是现有构建的开发启动入口，不是正式安装包。

- 入口按自身所在位置定位 desktop，启动该副本 node_modules 中的 Electron，不启动旧目录。
- 依赖 desktop/node_modules、desktop/dist 和 desktop/dist-electron；本次迁移已保留并验证。干净克隆需先在 desktop 安装依赖并运行 npm run build。
- 使用 desktop/.tmp/dot-uiux-app/profile 作为本副本独立的持久应用数据；不复制或读取旧账户、用户图库与 profile。后续此副本手动配置的业务数据与原项目分离。
- 启动前清除继承的凭据、旧 dev server、portable 与临时审计变量；不自动发起生成或付费调用。
- CMD 借助本地 Electron 的 Node 模式运行启动器，无需额外全局 Node 来双击启动；Electron 依赖本身仍需存在。
- `启动绘世-A分支.cmd --smoke` 用新建临时 profile 启动相同应用入口，记录路径和空账户状态后关闭。此选项需要本地 desktop/.tmp/uiux-tools 中的 Playwright；正常双击不依赖它。

2026-10-21 迁移复制阶段的分支为 feat/uiux-evidence-audit-20261020、提交 17198f9；源旧副本保留。本目录的 .tmp/migration-20261021/REPORT.md 和 JSON/PNG 保存本地迁移、哈希、GUI 记录；这些本地运行材料不提交远端。

历史验收报告中的旧绝对路径是原测试时的位置；启动脚本使用相对自身的新路径。不要把本副本的修改写入相邻 PC端 或用户原工作目录。

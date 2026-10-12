# NovelAI 参数、Windows 凭据与图片图库

本轮范围：手机端 NovelAI 请求参数、官方 / 7877 / ikun 接入、Windows 凭据管理器和原图图库。保留绘世深色暖金、浅色蓝、三栏工作台与固定生成按钮。本轮不是全部手机功能移植完成，也没有使用真实账号或发起付费生成。

## 可操作的参数

| 分组 | 本轮工作台与快照 |
| --- | --- |
| 基础 | 正负提示词（原样保留权重语法）、模型 / 自定义模型 ID、宽高、steps、CFG scale、CFG rescale、sampler、noise schedule、固定 / 随机 seed |
| 批次 | 1–30 张逐次提交；首张保留固定 seed（包括 0），其余独立随机；提交时冻结整批参数；途中编辑属于下一批 |
| 角色 | 最多 6 个角色，各自正负提示词、启用 / 禁用、上下排序、自动 / 5×5 手动位置、角色参考图片与强度 |
| 参考 | 多个 Vibe、strength、information extracted；精准参考 character / style / character&style 与强度；图片均使用受管资源 ID |
| 图生图 | 导入或选用图库原图、strength；与文生图切换时保留编辑素材，提交时排除当前模式不用的素材 |
| 局部重绘 | 原图、黑白蒙版、strength、禁用原图、色彩校正；支持画布笔迹导出蒙版或导入蒙版 |

工作台使用同一组提示词编辑器显示当前生成任务；手机端独立重绘工作区、区域选择 / 擦除 / 矩形 / 合成候选、交互裁切、Vibe 编码库复用、分块高清仍是后续移植项。API 参数已经建模不等于这些完整工作流已经验收。GPT / Nano Banana 等其他渠道仍按手机全量矩阵推进。

旧版工作区通过新增可选 JSON 字段兼容，无数据库重置；旧角色描述、启用与网格坐标迁入角色列表。真实图片记录保存有效请求参数，回填时恢复其模型、提示词、所有参考与高级值。图库宽高记录实际解码尺寸，请求宽高保留在参数快照中。

## 请求与凭据

- `lib/generation` 为独立实现的参数 / 适配器，按手机端实际 body builder 与官方文档核对；协议细节和能力限制见 [GENERATION_PROTOCOL.md](GENERATION_PROTOCOL.md)。模型名称不是服务支持承诺，不支持的字段组合在发请求前拒绝。
- 官方地址固定为 `https://image.novelai.net`；网关要求 HTTPS，本地回环 HTTP 仅供模拟验证。凭据按协议和规范化完整根地址分别保存，改地址不会沿用旧地址 Key。
- Windows 使用 `CredWriteW / CredReadW / CredDeleteW`（系统用户凭据管理器）；普通 SQLite、图片、日志与 Git 不保存 Token / Key。详见 [Windows 凭据说明](NATIVE_SECURITY_CHANNELS.md)。浏览器只保留本次页面会话内存凭据，重载后需重新输入。
- 请求禁止自动重定向。结果 URL 下载不带认证头，响应大小与图像内容受限；Windows DNS 检查是尽力防护，浏览器无法检查 DNS 解析地址，详见协议文档。
- 错误仅展示预定义类别与必要 HTTP 状态码，不回显服务器响应 / 请求头。没有自动重试付费请求。
- 停止生成会停止等待和后续批次，不能证明服务端撤回已经接收的请求。关窗等待本地任务收尾，再 flush；超时或保存失败会保留窗口。

## 图片与落盘顺序

`ImageAssetStore` 先检查 PNG / JPEG / WebP 格式、尺寸与解码，再保留原始返回字节，SHA-256 命名，临时文件 flush 后原子发布。随后 controller 把图片引用和完整参数写入 SQLite 事务。Web 预览用独立 `assets.sqlite` BLOB；Windows 使用 `data/desktop/image_assets`（开发构建默认），可随工作区存储根覆盖。

读取时校验内容哈希，不用示意图掩盖丢失 / 损坏的原图。收藏、回填、切图、图库筛选沿用同一条记录。取消恰好发生在图片保存期间、或进程在图片发布后索引提交前异常退出，可能留下未索引的内容地址文件；本轮不自动删除它们。恢复索引 / 安全清理界面仍属于 PC-ADD-RECOVERY-01 后续要求。

## 验证入口

- `flutter test --no-pub`：领域序列化、三协议请求、ZIP / JSON / 下载、凭据契约、图片哈希与重开、真实 runtime mock → 图片文件 → SQLite → controller 重开、批量冻结和 seed 0。
- `scripts/probe-credentials.ps1`：同一随机命名空间下，两次独立隐藏 Windows exe 进程依次写入、读取、删除合成凭据。不会访问真实凭据。
- `scripts/probe-windows.ps1`：Windows 实际 exe 中文路径、SQLite / PNG 与关窗保存检查。
- `scripts/mock-image-service.py`：仅绑定 127.0.0.1:5090、不代理外部请求，返回清晰标注 LOCAL MOCK 的几何 PNG；不记录请求体或认证头。
- 内置浏览器固定使用 `http://127.0.0.1:5080/`，验证真实文件显示、参数交互和重开。浏览器成功不替代 Windows 原生平台检查。

最终本轮检查记录、构建和截图收录在 `docs/evidence/generation/`。真实服务兼容性、Windows 可见原生文件对话框、签名安装包 / 自动更新和大图库性能尚未实测。没有真实账号、预算授权时不自动执行计费测试。

## 本轮实测结果（2026-10-12）

- `dart analyze lib test` 无问题；`flutter test --no-pub` **49 项通过**。其中 runtime 集成测试实际使用本地图片文件及 SQLite，覆盖生成、批量参数冻结、seed 0、关闭重开、收藏、原图哈希及参数回填。
- Windows Release 构建成功，最终 C++ 编译 **0 警告、0 错误**。首轮发现的 C4456 局部变量遮蔽已修正，未降低警告标准。
- 最终 Windows exe 的两次隐藏进程完成系统凭据写入、跨进程读取、删除及确认不存在；另两次隐藏进程完成中文路径 SQLite / PNG 保存与重开检查。报告见 [凭据探针](evidence/generation/credentials-probe.json) 和 [存储探针](evidence/generation/storage-probe.txt)。
- Web Release 构建成功。内置浏览器通过本机 mock 生成两条真实 PNG 资源记录，验证 CFG Rescale 从 0.6 回填为生成时的 0.25、多角色新增与排序、收藏筛选、页面重载和关页重开后原图显示。重载后 Web 测试凭据不存在，公开网关地址已恢复，当前渠道切回官方。
- 深色暖金、浅色蓝主题保持；截图见 [工作台](evidence/generation/workbench-dark.jpg)、[参考面板](evidence/generation/references-light.jpg)、[收藏图库](evidence/generation/gallery-favorites.jpg)。截图中的几何图片是明确标注 LOCAL MOCK 的合成服务响应，用于验证原图管线，不代表 AI 生成质量。
- 浏览器检查未发现 console error/warn。Web 编译器仍有 CupertinoIcons 字体声明提示，当前界面使用 MaterialIcons，抽样界面未见缺失图标；不将此提示描述为零构建警告。

本轮没有真实官方或网关账号联调。Windows 原生文件选取已编译，但遵循全程内置浏览器的交互范围，未操作可见原生文件对话框。其他手机功能、完整编辑工作流与导入手机 v22 数据库仍按功能矩阵继续完成。

# 手机端持久化与 Windows 移植下一步

审计日期：2026-10-11。本文记录手机端持久化与 Windows 平台差异的只读源码审计，并给出后续移植顺序。手机源码路径均相对于 `E:\NAI-WorldPainter\手机端`。本次只检查源码和测试，不读取用户数据库、图片或凭据，也不下载模型。

## 已核对的持久化事实

| 区域 | 手机端源码证据 | 对移植的影响 |
| --- | --- | --- |
| 业务数据库 | `lib/data/datasources/local/database_helper.dart:17-71,347-559` 当前 schema 为 v22，表结构和版本升级集中在 `DatabaseHelper`。`test/database_migration_test.dart:17-85` 覆盖的是 v10 迁移场景。 | PC 需要明确的手机 v22 数据导入/迁移方案和合成 fixture；现有迁移测试不能证明真实用户库已兼容。 |
| 草稿与设置 | `lib/data/datasources/local/settings_local_datasource.dart:87-241` 使用 SharedPreferences 保存创作草稿和设置。 | 移植时要逐字段保留提示词、渠道、参数及角色等可编辑状态，不能只持久化屏幕上当前显示的少数值。 |
| Seed | `lib/presentation/viewmodels/generation_viewmodel.dart:1323-1330` 中 Seed 状态仅在内存更新。 | 重启恢复必须补上 Seed 草稿持久化，并验证固定值与随机/未生成值的语义。 |
| 历史记录与图像 | `lib/data/models/generation_task_model.dart:172-224` 的历史模型保存绝对 `image_path`；`lib/core/utils/image_utils.dart:13-20` 定义 `generated_images` 存储位置。`lib/data/repositories/history_repository_impl.dart:48-62,78-98` 最多保留 200 条，淘汰旧项会删对应图像；`clearHistory` 只清索引，不清图像文件。 | 历史数据库与文件系统存在生命周期关系。PC 需迁移为受管路径，并为导入、删除、清空、缺文件、部分失败及重启恢复定义一致行为；不要把绝对手机路径直接当作 PC 可用路径。 |
| 另存图片 | `lib/domain/usecases/save_image.dart:57-64` 走系统相册保存，和应用历史文件分开。 | Windows 需要桌面文件另存行为；相册保存结果不能与图库历史索引混为同一份资产。 |

当前 PC 的 [SQLite workspace store](../lib/storage/sqlite_workspace_store.dart) 是 schema 1 的新工作区快照原型，存有草稿、图库元数据、偏好、编辑器状态和 revision。它**不是手机 schema v22 的业务迁移，也不代表 v22 导入已经完成**；目前没有证据表明 PC 能发现、读取或迁移既有手机数据库。本轮已接入真实生成 runtime、受管原图和参数快照，具体实现与验收见 [GENERATION_REVIEW.md](GENERATION_REVIEW.md)。这不代表既有手机历史库导入或完整业务已经移植。

## Windows 平台与许可风险

- 手机依赖 `sqflite`，没有 Windows 实现；Windows 数据库需由 FFI 路径提供并经真实 Windows 重启测试。PC 原型使用 FFI 只证明当前独立快照存储可以开发验证，不自动证明手机 v22 schema、升级链或用户数据导入可用。
- `image_gallery_saver_plus` 4.0.1 只支持 Android/iOS。`save_image.dart` 的能力要改成 Windows 文件另存，并保持原有结果可见和错误可恢复。
- `flutter_foreground_task` 8.17.0 只支持 Android/iOS。Windows 需要桌面任务生命周期等价行为，包括关闭窗口、重启恢复、取消和进度处理；无需复刻 Android 通知 UI。
- `lib/data/datasources/super_resolution_channel.dart` 通过平台通道连接 `android/app/src/main/kotlin/com/naihuishi/nai_huishi/SuperResolutionPlugin.kt` 和 `android/app/src/main/jniLibs/arm64-v8a/*.so`。这是 Android 原生推理实现，不能直接在 Windows 使用；本地超分仍是完整功能范围的一部分，必须提供 Windows 后端并验证实际输出。
- `lib/data/datasources/local/official_novelai_token_store.dart` 对官方 Token 使用安全存储；普通 API Key、LLM 凭据和 Pixiv Cookie 仍有 SharedPreferences 存储。PC 要先验证 Windows 安全凭据实现，再迁移和清理旧明文值；测试 fixture 不得放入真实凭据。
- 手机 README 声明 MIT，但手机仓库根目录未发现 `LICENSE`；`assets/nai5-prompting/LICENSE` 标明 GPLv3。复制源码、素材或模型前须逐项核对许可证和来源，不能把 README 声明视为全部资源均可按 MIT 复用。

## 下一批实施顺序

生成领域模型、NovelAI 参数与能力契约、Windows 凭据、官方及现有网关适配、受管原图和回填现已实现；本轮实测边界见 [GENERATION_REVIEW.md](GENERATION_REVIEW.md)。下一批继续补齐完整图像编辑工作流、其他手机生图渠道、v22 显式导入与图库生命周期，再按 M3–M6 迁移工具、助手、漫画和 Pixiv。下面列出这些批次涉及的基础设施难度，不表示把全部生图渠道推迟到最后。全部手机端功能最低标准不变。

1. **基础持久化与迁移契约（较低）**：在 PC schema 上定义版本升级、快照原子性和字段映射；制作不含用户信息的 v22 fixture，验证从 v22 到 PC 的显式导入路径、重复导入策略、损坏/未知字段处理和回滚。先覆盖草稿、全部生成参数、Seed、角色、主题及必要设置的保存—关闭—重开。PC schema 1 与手机 v22 必须作为两个独立版本边界处理。
2. **图库元数据与受管图像（中等）**：把历史记录和图像文件关联纳入同一生命周期设计；定义复制/校验、受管路径、元数据与派生图关系、缺失/重复文件处理。逐项验证单条删除、达到上限时淘汰、清空历史、另存副本及进程中断后的恢复，避免“索引已删但文件遗留”或“文件已删但历史仍可见”。
3. **Windows 安全与桌面平台服务（较高）**：验证 Windows 凭据库封装，迁移所有凭据并避免明文导出；实现文件选取/另存、目录权限与中文路径处理，以及可暂停、取消和重启恢复的桌面任务生命周期。分别替换 Android 相册与前台服务机制，不减少对应业务能力。
4. **原生图像处理与完整业务链（最高）**：提供 Windows 超分推理后端并核对模型许可、来源、完整性和画面输出；接齐生图渠道、图库/工具、助手、漫画、Pixiv 等手机端当前范围，并按功能矩阵完成端到端验收。Android 原生实现不可用时，必须实现 Windows 等价能力或先标明未完成，不能用占位按钮或模拟结果算通过。

## 验收下限

- 本轮可先验证 PC 草稿、全部参数、图库记录/文件、收藏、主题及编辑器状态在 Windows 关闭重开后保留；这只是持久化和平台能力的阶段证据，不是全量完成声明。
- 数据库迁移必须用合成 v22 fixture 验证；不得拿真实用户数据库或凭据作为测试输入。需覆盖旧版本、重复启动、迁移中断、未知字段、损坏记录、缺失图像和权限失败。
- 图库记录与图像文件分别校验内容、路径及删除语义。已有手机行为如 200 条上限与 `clearHistory` 留图差异要显式决定并测试；如改进，记录用户影响和恢复策略。
- PC schema 1 的建库、重开、revision 冲突测试不等于手机 v22 导入测试。只有显式 importer、v22 合成 fixture 和 Windows 实际重开证据都通过，才能报告这条迁移完成。
- 手机端所有当前可达功能仍按 [手机端功能基线](MOBILE_PARITY.md) 和 [PC 全量计划](PC_PLAN.md) 验收。先后顺序只控制依赖和风险，**不把任何功能域延期出最低标准，也不以 M1 原型、单个渠道或 Gallery 占位替代全量移植**。

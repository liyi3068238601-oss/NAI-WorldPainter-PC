# V3.2-R4 Final 助手预设兼容、共享编辑与无损迁移

- 状态：**R4 Final 设计与迁移要求；没有产品实现或测试结果。**本文件可独立交给实现人员，不依赖旧 V3 文档来补齐迁移步骤。
- 历史源码基线：`dfd7caa63ae19bd40651e00127a71efe57b71b4e`。以下源码状态仅指该固定 HEAD 的只读复审，不代表当前产品状态；本轮未修改源码原件。基线复审涉及 `desktop/electron/ipc/agent-store.ts`、`desktop/src/agent/types.ts`、`desktop/src/agent/workspace-controls.ts`、`desktop/src/tavern/compat.ts` 与 `desktop/electron/ipc/store.ts`。
- 本轮未修改产品源码，未运行产品测试或模型/图像服务；独立 HTML 浏览器检查另见 VERIFICATION。

## 目标与兼容边界

“助手预设”是影响对话系统提示词的资源，和图片提示词预设、图像模型参数、服务转换模板、角色卡、Skill、批准模式分别存放。预设正文只是数据，不授予工具、联网或付费权限。

助手预设选择、启用状态和正文快照不授予图片参考参与权限。该授权仍按原用户意图、目标、确切附件及修订、role、`referencePurpose` 与授权范围判定；用途或 role 改变默认不参与，除非同一明确用户指令为新范围 opt-in。

固定 HEAD 中的 Pi 内置预设 ID 为 `dsh-infinite-gen-5`、`dsh-infinite-gen-4`、`studio-complete`。酒馆 `samplerPresets[]` 是另一套可迁移记录，Pi 通过 `tavern:<id>` 引用其中的自定义项；旧 `samplerPresetId` 仍是独立字段。迁移不得把这两类选择、图片生成参数或历史的 `studioPresetId` 互相覆盖。见 [`workspace-controls.ts`](../../desktop/src/agent/workspace-controls.ts)、[`types.ts`](../../desktop/src/agent/types.ts) 与 [`agent-store.ts`](../../desktop/electron/ipc/agent-store.ts)。

固定 HEAD 的 `AgentConversation` 有 `studioPresetId` 和 `studioTemplateEnabled`，没有独立的 `studioPresetEnabled` 字段。该基线中的 `studioTemplateEnabled` 控制是否注入选中模板，R4 保持其旧语义。R4 新状态使用版本化绑定 `assistantPresetBinding={presetId, enabled}`，新会话默认使用独立的 `assistantPresetDefaultBinding={presetId, enabled}`；关闭保留 `presetId`，只跳过该助手预设正文，基础规则仍生效。新绑定与旧字段分开保存，不能将 `studioTemplateEnabled` 改名后丢掉原含义。迁移仅由支持相应源版本的 adapter 执行：保留原始旧字段；对已知版本按该版本的既有语义映射，且若旧开关存在则映射其真实值；旧字段缺失时按该版本已核验的既有默认语义映射，不把缺失值直接当作 false；无法证明语义的 legacy/unversioned 记录须保留原文并提示修复，不能猜测。固定 HEAD 中的 `studioSelectedSystemPrompt` 对 Tavern 项按顺序拼接 `systemPrompt` 与 `jailbreakPrompt`；Pi 的该基线路径只取正文，不代表旧 temperature、topP、penalty、stop 等字段已经作用于图片模型。

## 固定 HEAD 的规范化风险

这些是源码事实，不是本轮新发现的生产回归：

1. `normalizeAgentWorkspace` 在 workspace `version` 与当前常量不同时直接返回空工作区，低版本与未知高版本都走此分支（[`agent-store.ts:294–298`](../../desktop/electron/ipc/agent-store.ts)）。`readAgentWorkspace` 会把 `resetLegacyWorkspace` 置位，并在读后调用 `writeAgentWorkspace`（[`agent-store.ts:452–472`](../../desktop/electron/ipc/agent-store.ts)）。因此合法 JSON 的高版本不能交给普通读写/规范化路径；否则可能以空工作区替换活动文件。
2. 缺少 `presetLibraryVersion` 会按 `0` 处理；版本低于当前值时，规范化器先解析预设，再用内置列表整体替换 `samplerPresets`（[`agent-store.ts:306–313`](../../desktop/electron/ipc/agent-store.ts)）。若输入版本高于当前值，虽然不会走这段替换分支，输出仍被写成当前 `TAVERN_PRESET_LIBRARY_VERSION`（同文件 `:434–444`），后续保存会降写原先的高版本标记。`readAgentWorkspace` 对旧版本会把迁移结果写回（同文件 `:457–471`）。不能先 normalize 再试图从返回值恢复被替换的自定义项或未知版本信息。
3. 固定 HEAD 的规范化会把无效的 `samplerPresetId` 改成首个活动预设，把无效的 Pi `studioPresetId` 改成 `STUDIO_DEFAULT_PRESET_ID`（[`agent-store.ts:341–343,373`](../../desktop/electron/ipc/agent-store.ts)）。这会掩盖悬空引用及其原意，迁移时要先保留原始引用并给出可见的修复选择。
4. `normalizeTavernSamplerPreset` 会只输出已知字段，对正文做长度截取、对数值做边界规范化，并限制 stop 数量（[`compat.ts:143–163`](../../desktop/src/tavern/compat.ts)）。未知字段、超长原文和原始格式若先经过它，可能被丢弃、截断或改写。迁移需先留存原始记录；任何需要规范化的改变都应可审阅，不能默默宣称“无损”。
5. 固定 HEAD 的读恢复尝试主文件、`.bak`、`.bak2` 的前提是 parse 抛错；合法 JSON 被逻辑上转换成空工作区不会触发备份回退（[`store.ts:633–659`](../../desktop/electron/ipc/store.ts)）。写入前会轮换最多两代备份，但该操作 best-effort，且后续写入会继续轮换（同文件 `:605–630`）。备份轮换有助恢复，不构成永久保留保证。

迁移入口必须在首次调用会 normalize 的工作区 API 前执行。不得把现有 `.bak/.bak2` 当作迁移前归档的充分替代。

## 可恢复迁移流程

1. **原始快照先行。**暂停针对该工作区的所有写入；按原始字节复制完整工作区文件到独立、带时间戳的迁移归档，计算并记录 SHA-256、大小、源路径、源 workspace/preset-library 版本。归档写入后重新读回并校验 hash。只在此之后解析字段；任何旧 `readAgentWorkspace`、`normalizeAgentWorkspace` 或可能触发它们的 UI 初始化都不能先跑。
2. **按已知旧版本逐字段映射。**每个来源版本有显式 adapter 和迁移日志。保留原始对象及未知扩展字段，不能仅将未知字段丢弃；如果目标 schema 暂不能表达某字段，放入可往返的兼容区或阻止迁移并保留源档。超长正文、非法枚举、错误类型和重复 ID 应形成逐项冲突/修复清单，不得静默截断、换正文或丢引用。
3. **未知高版本只读。**遇到大于当前支持版本的 workspace 或预设库版本时，不调用空白初始化、不把归一化空对象保存回去、不自动降级。展示“版本较新，暂不能写入”，原文件保持逐字节不变；只有专门支持该版本的迁移器才能继续。
4. **事务式落盘。**生成新格式到同目录临时文件，完成 schema、自引用、数量、正文 hash、引用映射与资产存在性校验；在替换活动文件之前，再确认原始归档 hash 未变化。使用原子替换；任一异常时保留原始活动文件与归档，缓存不切换到半成品。成功后记录源/目标 hash、迁移器版本和计数，重启读回再核对一次。
5. **不能证明等价时保留选择。**对悬空 preset ID、重复 ID、未知扩展或旧/新语义不一致，提供原记录、候选映射及差异，让用户确认；不自动替换为默认角色/默认助手，不删除旧字段来使 schema 通过。

## 必须保留的数据

对 `samplerPresets[]` 的每条记录保留：稳定 `id`、原始名称、`systemPrompt`、`jailbreakPrompt`、`temperature`、`topP`、`frequencyPenalty`、`presencePenalty`、`maxOutputTokens`、`stop`、来源类型/文件名/原始 `sourceHash`、创建与修改时间，以及未知兼容字段。正文应按原值验证并计算当前内容 hash；`sourceHash` 代表导入文件来源，不能在用户编辑后被当成正文 hash，也不能因相同源文件重复导入而覆盖用户修改。

内置项稳定 ID 和用户改名/改写状态必须保留。升级时只可在明确规则下呈现新增内置项；若旧格式无法区分“用户主动删除”与“该版本本来没有”，不要猜测并自动复活，先保留原列表并让用户选择是否加入。重复导入相同原始 hash 时，复用现有记录但保留其用户正文、名称、引用和时间，不用源文件回写覆盖。

对话数据至少分开保存：

- `samplerPresetId`：旧酒馆对话选择。
- `studioPresetId`：legacy Pi 对话选择，可指向稳定内置 ID 或 `tavern:<id>`；迁移后保留原值作兼容/审计，不作为新状态写入口。
- `studioTemplateEnabled`：legacy Pi 模板注入开关；语义不变并保留原值。
- `assistantPresetBinding={presetId, enabled}`：R4 当前对话选择与开关；关闭时仍保留选中 ID，仅不注入其自定义正文。
- `assistantPresetDefaultBinding={presetId, enabled}`：R4 新会话默认；显式关闭以保留的 preset ID 加 `enabled=false` 表示，不清除选中项。
- `studioDefaults`：旧工作区默认项；原值逐字段保存，只有版本化迁移器写入新绑定。

不把旧酒馆 `samplerPresetId` 强制映射成 Pi `studioPresetId`，不将任一选择覆盖为首项，不丢失归档会话和共享引用。R4 的当前/默认绑定是新增字段和窄命令；`studioTemplateEnabled` 保持旧义，不能作为新绑定的写入口。未知或无版本记录不走自动归一化，不把缺少 enabled 推断为关闭；先保留原值并提供版本化修复路径。

## 选择、导入和共享编辑

固定 HEAD 中的 `setStudioConversationOptions` 更新当前聊天选项后，也把这些选项写回 `studioDefaults`（[`agent-store.ts:662–675`](../../desktop/electron/ipc/agent-store.ts)）；同一基线中的 `importStudioPresetFiles` 对整个批次先校验，按来源 hash 去重且不覆盖已有用户编辑，然后将首个导入项设为当前聊天预设，同时更新 `studioDefaults`（同文件 `:681–712`）。这些是固定基线证据；R4 新设计改变默认值行为时，需拆成窄命令，不能把该基线耦合保留成隐式副作用。

目标命令分开：

| 用户动作 | 只影响什么 | 不应隐式做什么 |
| --- | --- | --- |
| 选择/启用当前聊天预设 | 更新该聊天的 `assistantPresetBinding={presetId, enabled}`，启用开关单独控制是否注入所选正文 | 不改其他聊天、新会话默认、批准/联网/角色/Skill；关闭不清除所选 ID |
| 显式设为新聊天默认 | 更新 `assistantPresetDefaultBinding={presetId, enabled}` | 不回写已有聊天或在途任务；默认关闭也保留所选 ID |
| 导入预设 | 全批校验后新增/复用预设；兼容当前行为可将首个导入项设为当前聊天选择 | 不因导入而改变新聊天默认；重复 hash 不覆盖已有用户编辑 |
| 更新共享自定义预设 | 该资源的新 revision | 不重写已发送回合、提案、图片参数、已批准快照或排队任务 |
| 另存副本 | 创建新 ID 的独立副本 | 不改原预设及其引用 |

共享更新需先显示正文差异、revision、哈希和受影响引用（活动/归档聊天、默认值、当前是否关闭；关闭状态仍显示保留的 preset ID）；保存携带 `presetId + expectedRevision`。主进程重读 revision 与引用集合，若在预览后发生变化就返回新影响清单并保留编辑草稿，不覆盖并发修改。若预设已共享，保存前明确说明所有新回合的影响范围。取消不写入；失败保留文本；恢复旧文也创建新 revision 并保留审计记录。

## 已发送回合与排队快照

每次发送对话时记录当时的对话模型 ID/revision、助手预设 binding、选中 preset ID、enabled、revision/内容 hash 与实际纳入的正文快照。图片任务入队时冻结最终批准的 prompt、参数、来源附件 ID/revision/hash、发起消息的完整 conversationConfig（对话模型与助手预设；预设含 `presetId/enabled/body/revision/hash`）及独立的图像 provider 配置安全引用。自动点评继承产生该批次 execution 的完整对话模型/预设快照；排队或执行时不得读取运行时当前配置替代它。共享预设更新或聊天选择变化只影响未来生成的回合/任务：不回写已发送消息、已有提案、等待确认项、已批准 execution、排队图片任务或点评上下文。

旧历史/队列若不含足够信息恢复 preset revision，不得把当前新 revision 倒填成它“发送时”的预设；保留现有消息/请求原文，标记 `legacy/unversioned` 或待用户解释。当前固定 HEAD 没有目标 durable execution snapshot，因此该规则是待实现目标；不能声称已兼容旧队列快照。

## 独立迁移验收样本

以下全部待实现、未运行；每项比对原始归档 hash、目标字段、持久文件、重启读回和引用关系：

1. workspace 旧版本：多个用户自定义预设、UTF-8/换行正文、`systemPrompt` 与 `jailbreakPrompt`、旧采样字段、会话选择/默认值、归档聊天与悬空引用；升级后逐字核正文并核对每个 ID。
2. preset-library 低版本或缺版本：多个自定义项、已删除内置项标记、被改名/改写内置项；确认迁移不清空自定义正文、不复活明确删除项、不默认启用旧采样参数。
3. 同一来源文件重复导入后又编辑正文/名称，再次导入：hash 去重后保留手工修改和稳定引用。
4. 同一自定义预设被多个聊天、归档聊天和新会话默认引用；并发窗口改变 revision/引用集合；冲突返回新清单并保留草稿。
5. 已排队图片、待确认 execution、已发送消息与待点评均引用旧 conversationConfig；保存新共享 revision、切换当前 binding 或关闭/重新启用后，核实旧快照的对话模型 ID/revision 与助手预设 `presetId/enabled/body/revision/hash` 不变，新回合使用新 binding。自动点评使用原 execution 快照，即使它等待期间当前模型/预设已改选、关闭或更新。
6. 在原始备份后注入迁移写失败、目标 hash 校验失败、重启中断；确认原文件仍可读、不会进入空工作区，重试可继续。
7. workspace 与 preset-library 未知高版本；确认只读提示，活动文件和原始备份 byte/hash 完全不变。
8. 正文超限、无效类型、重复/冲突 ID 和未知字段；确认迁移中止或呈现逐项修复，不静默截断或删除。

原型截图或 fake-provider UI 演示只能说明操作路径设计，不能替代主进程迁移、真实磁盘落盘、重启读回和内容 hash 证据。

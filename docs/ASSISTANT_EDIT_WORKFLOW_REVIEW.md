# Agent 图像编辑与完整流程复核

日期：2026-10-14。完成本批三项：Agent 图生图、完整助手流程与桌面设置收尾、Agent 局部重绘。没有新增生图渠道；手机端原系统提示词、Skill、知识库及参考正文保持原字节。

## 实现

`generate_image` 使用当前工作台的文生图、图生图或重绘模式，单次最多 2 张。工具只能临时覆写正负词和张数，不能指定任意路径或替换输入素材。读草稿时提供当前操作、强度、输入引用与编辑状态。

图生图冻结已有裁切图与父图，确认前检查尺寸；重绘复用 `ImageEditingSession.prepare/acceptResult`，冻结实际请求区域与黑白蒙版，产出原始响应、透明图层、合成图与父图关系。确认弹窗显示实际提交的源图、蒙版、不同的原始底图及参数，并支持小窗口滚动。确认期间换图、改蒙版或改变裁切会使提案失效。

Workbench 返回本次提交的独立回执，不再通过整个图库前后差集判断结果。并发导入/派生图片不混入结果 ID。部分成功、取消、合成失败与保存失败分别报告；失败后同轮不会自动重新提交。原图已经返回后合成中取消或失败会保留原图并停止后续批次；请求返回前取消仍忽略迟到响应。回填只加入本次新候选，保留用户在生成期间删除的旧候选和修改的主候选选择。

临时编辑会话在完成、拒绝、取消或迟到准备结果时清理。图片资产异常会明确标记尚未保存，不能误报为完整成功。工作区索引保存失败时，实际收到的结果仍保留在当前内存图库，可重试本地保存。图片资产本身写盘失败时不能保证原始字节的持久恢复，不自动重复收费请求。

## 真实服务

测试只读提取绘世已保存、用户授权的 DeepSeek 中转及官方 NovelAI 凭据，使用内存凭据库和独立 SQLite。没有改用户正式配置、会话或图库，没有把密钥写入代码、证据或测试数据库。原手机资源由生产加载器提供，系统覆盖保持为空。

| 流程 | 真实结果 |
| --- | --- |
| 标签→写词→文生图 | DeepSeek 自动读取词框、查询标签、确认写词、确认生成；官方实际返回 1 张。[tags.json](evidence/assistant-edit-workflow/tags.json) |
| 图生图 | DeepSeek 读取当前图生图状态、确认源图和 0.4 强度，官方实际返回 1 张；来源参数随图保存。[img2img.json](evidence/assistant-edit-workflow/img2img.json) |
| 局部重绘 | DeepSeek 读取重绘状态、确认实际源图/蒙版及 0.8 强度，官方实际返回 1 张；原始响应、透明层、合成图保存成功。[inpaint.json](evidence/assistant-edit-workflow/inpaint.json) |
| 记忆完整循环 | DeepSeek 提交待审核候选，查询不能取到该候选；测试层按授权采纳，另一新会话调用检索取到已采纳条目。[memory.json](evidence/assistant-edit-workflow/memory.json) |
| 拒绝与取消 | 真实模型提议写词，确认层拒绝或等待确认时取消后停止，草稿和图库不变；两场均 0 生图。[decline.json](evidence/assistant-edit-workflow/decline.json)、[cancel.json](evidence/assistant-edit-workflow/cancel.json) |

每场关闭数据库后以新句柄重新读取工作区及全部生成资产，证据为各 `*-reopen.json`。真实确认由受限测试层校验当前场景后回答，不冒充人工点击。模型配置 ID 为 `deepseek-v4.1-flash`，中转后端真实实现不能由客户端独立证明。

官方生成共 3 次 POST，每次 `n_samples=1`、768×768、28 steps，分别为 `generate/img2img/infill`。生成前重新查询有效 Opus 与余额，三次均 HTTP 200，观察到合计 0 Anlas 变化；DeepSeek 中转费用未核算。官方请求不自动重试，测试限制每个生成阶段最多一次、总计三次；确认/记忆测试不能生成。忽略目录中的手动探针为 `.tmp/assistant_edit_workflow_live_test.dart`，不属于默认测试或定时任务。

## 图像与像素

图生图保留了木屋、山湖及金色光束的主体布局；本次秋叶/日落文字没有形成明显的季节变化，不能据此声称严格语义编辑通过。重绘区域位于木屋上方的山林，图像纹理发生变化，提示词中的灯笼没有明确出现在成图中。两场用于验证输入、输出、工具调用和编辑合成链路，不作为高要求主体一致性或每个物体指令的验收。

| 图生图 | 重绘合成 |
| --- | --- |
| ![真实图生图](evidence/assistant-edit-workflow/img2img-7a12947c0b3c.png) | ![真实局部重绘](evidence/assistant-edit-workflow/inpaint-250e26cf0059.png) |

透明层有 37,188 个非透明像素，层外 552,636 个像素与同一编辑器渲染的原图基准完全一致；层内 36,663 个像素发生变化。原始 PNG 含 alpha=254 的少量像素，Flutter 直通渲染的预乘/非预乘转换会使其中 42 个 RGB 像素偏差一个色阶；复核以同样的无图层渲染为基准，原始文件保持不变。见 [逐像素复核](evidence/assistant-edit-workflow/inpaint-pixel-validation.json)。

## 桌面与自动化

默认 Flutter 测试 460 项通过，1 项既有可选本地 SR 探针跳过；静态分析无问题。新增测试覆盖图生图/重绘确认、输入变更、回执归属、部分失败、合成中取消、候选并发修改、记忆审核、配置重开与迟到返回。Mock 的 LLM、标签与官方 ZIP 响应明确标为合成证据，不代替上表真实服务结果。

Windows/Web Release 构建通过；Web 保留既有 Cupertino 字体引用提示。两个包及源码的七份原手机资源长度与 SHA-256 全部匹配既有清单，见 [资源包复核](evidence/assistant-edit-workflow/mobile-resource-bundles.json)。

Windows 使用独立工作区，原生录入两份非空测试偏好、保存、正常关闭，重新打开 Release 并进入同一面板，两个值及原资源摘要恢复正确。Computer Use 的批量文本输入未能落入 Flutter 输入框，使用标准英文/数字按键验证成功；这不是长文本或中文输入法的完整兼容验收。证据：[保存](evidence/assistant-edit-workflow/native-preferences-saved.jpg)、[重开](evidence/assistant-edit-workflow/native-preferences-reopened.jpg)。原生图像确认窗的补充复核在启动独立验收程序时被用户物理 Esc 停止，没有再发出界面操作，不计为通过；源图/蒙版弹窗由 Widget 测试和真实请求确认记录覆盖。见 [原生检查边界](evidence/assistant-edit-workflow/native-review.json)。

本批不代表 M4 全部手机工具、更多模型/网关、全分辨率缩放组合或全量手机移植完成。GPT/Nano 等生图渠道保持用户安排的暂缓状态。

## 参考

- [NovelAI 官方 Inpaint](https://docs.novelai.net/en/image/inpaint/)：局部蒙版、强度、区域与透明扩展的预期行为。
- [NovelAI 官方 Image2Image](https://docs.novelai.net/en/image/controltools/)：基于已有图像与提示词生成的强度语义。
- 手机 HEAD `01e85981a52b5d45d3cb6d1ee03a8604fe53d9ab` 的 Agent / GenerationViewModel / inpaint 调用链仅只读参考。PC 复用已有编辑器并采用本次任务回执，避免照搬内部重绘任务不能更新常规完成标志的失败边界。

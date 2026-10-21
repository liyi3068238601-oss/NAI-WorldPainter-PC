# 手机局部重绘参数与导入核查

固定源码：`sakiko0901/NAI-WorldPainter@eb8ef2158e3f204ab90f7c198d4050a5967f4439`。以下行号均对应 `mobile-reference-evidence/eb8ef21/` 快照，只读行为核查，不复制实现到 PC。

| 项目 | 实际行为 | 源码 |
|---|---|---|
| 默认 | strength=0.96；disabledOriginalImage=false；colorCorrect=true | `lib/presentation/viewmodels/generation_viewmodel.dart:414` |
| 局部词 | 重绘独立正负词，修改写入 settings 草稿；参数构造 trim，空负词转 null | VM `749`、`756`、`1543` |
| 请求冻结 | 工作区先构造整批 task 模板，再 await 栅格化；冻结模型、endpoint/protocol、尺寸、CFG/cfgRescale、sampler/noiseSchedule、steps、词与编辑选项 | `lib/presentation/pages/inpaint_workspace_page.dart:1133` |
| seed | buildInpaintTask 接受可选 seed；工作区批次未提供，故为 null 随机；未读主界面 seed | VM `1551`、`1575`；工作区 `1137` |
| 附加控制 | 此工作区 buildInpaintTask 未继承 characters、vibe、precise、SMEA 或主界面UC/quality设置；官方协议构造器另有固定qualityToggle/quality_toggle=true、ucPreset/uc_preset=1，不能把“未继承”误写为传输字段关闭/缺省 | VM `1559`–`1587`；官方API `665`–`668` |
| strength 范围 | UI .01..1，构造再次 clamp .01..1 | 工作区 `2498`；VM `1581` |
| 蒙版 | RGBA 的 R>=128 为选中；每 8×8 中任意选中则整个 latent 单元为255，ceil 网格覆盖尾部；输出原尺寸单通道灰度 PNG | `lib/core/utils/image_utils.dart:291`–`363` |
| 官方请求 | infill分支附加image、mask、strength；共用parameters固定qualityToggle/quality_toggle=true、ucPreset/uc_preset=1，同时input/uc与V4 captions直接使用独立正负词，不在手机本地追加质量/UC词。模型自动补`-inpainting`；不传noise/add_original_image/color_correct | `lib/data/datasources/remote/official_novelai_api_service.dart:620`–`734`，固定字段`665`–`668` |
| 7877 请求 | image、mask、strength、size、n=1、response_format=b64_json；params 包含steps/CFG/cfgRescale/规范化sampler、schedule、可选seed/negative；不传ignore/color/noise | `lib/data/datasources/remote/novelai_api_service.dart:1153`–`1177` |
| 一般/ikun 请求 | strength；noise=0；add_original_image=!disabledOriginalImage；color_correct=colorCorrect；n=1；size/w/h/steps/CFG/cfgRescale/sampler/schedule；可选seed | 同上 `1180`–`1203` |
| 响应 | API解析当普通完整图像返回；工作区将返回图当完整输出框，与蒙版尺寸必须一致；不存在latent patch解码后拼回机制 | 同上 `1233`；`lib/domain/services/inpaint_rasterizer.dart:114` |
| 图片导入 | WorkspaceImageImporter 获取原始真实尺寸与可用PNG元数据；PNG>4M像素只禁stealth检查，不缩图；EXIF 5–8轴换位 | `lib/data/datasources/local/workspace_image_importer.dart:11`–`61` |
| 工作台导入 | displayImportedImage只加session并选中，不提交请求、不替换生成草稿 | VM `2006`–`2014`；`lib/presentation/pages/generate_page.dart:1798` |
| 结果→重绘 | 用当前选中task.imagePath；切inpainting、设source、mask=null；非空词覆盖独立重绘词，空词保留现有；不改selectedResolution | `lib/presentation/pages/generate_page.dart:1332`–`1351` |
| 官方超分→重绘 | 官方工作台超分成功读输出实际尺寸、创建新task id/path/w/h/size，加入session并选中；再导入重绘即导入全尺寸新图 | VM `2039`–`2096` |
| 独立超分页 | 本地超分page和独立官方超分页只有另存相册，没有直接导入重绘按钮；需保存后由工作区导入 | `lib/presentation/pages/image_enhance_page.dart:62`、`308`；`official_upscale_page.dart:93`、`106` |
| 非AI像素放大 | 工作区菜单另有cubic 2x/3x，读取原始source文件，另存PNG并_loadImage重开，重置编辑/结果会话 | 工作区 `217`、`2451` |
| 候选持久化 | transient队列不写history；saveTransient仅确保本地图像文件；候选、框、笔迹、结果层仅State内存。保存合成输出PNG到图库接口；没有发现工作区跨进程恢复 | `lib/core/queue/generation_queue.dart:51`；`lib/domain/usecases/save_image.dart:44`；工作区 `318`、`1310` |

注意：结果导入重绘的注释写“追加”，实际只调用覆盖接口，以上以调用行为为准。官方/7877两个开关未进入payload是当前手机端实现事实，不宜在 PC 无验证地声称两个开关对所有渠道有效。

2026-10-21 最终官方协议复核补充：手机官方构造器620–734未发送legacy、legacy_v3_extend、dynamic_thresholding、skip_cfg_above_sigma、qualityPresetId、tag_hint_qt、V5透明背景提示、deliberate_euler_ancestral_bug、prefer_brownian或v4_negative_prompt.legacy_uc。PC仅新版适配层删除这些PC-only字段，保留独立作者词并固定手机四个quality/UC传输值。generation_viewmodel.dart:1222对V5强制steps≤28；PC新版规范化与UI相应对齐。手机工作区seed=null时省略seed，PC仍采用本地随机seed并传输，作为明确实现差异记录，未声称完全一致。

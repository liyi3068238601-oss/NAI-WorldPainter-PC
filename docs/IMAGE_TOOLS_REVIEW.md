# 图片工具与后期审计及移植进展

审计日期：2026-10-12。手机源码基线为 `375a41844be53136f7d2350c2d6560f221a8c5a5`（采样时工作区干净）。手机端只读，本次未运行手机应用/测试。源码路径均相对于手机端仓库根，44 个文件哈希见 [`source-manifest.json`](evidence/processing/source-manifest.json)。PC 实现与最终验证记录如下。

## 手机端当前可达行为

| 条目 | 当前入口和实际行为 | 范围、默认值与持久化边界 |
| --- | --- | --- |
| MP-GEN-13 分块高清图生图 | 从创作页图生图模式选择「分块高清重绘」。服务读取整张源图，依次裁出块、调用当前图像渠道、按权重拼回一个 PNG。 | 一次 Tiled job 产生 **1 张合成结果**，由 **1–16 个单图请求**组成；不是让用户要 1–16 张候选。固定 640×640 裁区、320 步长、1024×1024 请求块，画布最长边 4096、像素数上限 16MP、块数上限 16，合成图约为原图 1.6×。UI 有块级进度和取消；每块失败报出分块序号，原图不被覆盖。通用批量张数属于普通生成，不代表 Tiled 输出张数。 |
| MP-IMG-04 Director Tools | Settings 的「导演工具」页可选图片、动作、渠道和模型；支持处理状态/错误并把返回图保存到本地图片目录供预览。 | 六动作：去杂物、背景移除、线稿提取、草图化、线稿上色、情感迁移。7877 与 ikun 使用各自配置的模型；官方端不传网关模型。只有线稿上色和情感迁移显示 prompt/Defry，Defry 默认 5、范围 0–5。其他动作不暴露这些字段。官方处理可能消耗 Anlas。 |
| MP-IMG-06 官方 Enhance | 创作页对当前结果、History 详情对当前记录可以发起；History 入口只对 NovelAI 官方记录开放。发送前确认，结果回到本次结果；History 发起时把派生结果保存到历史。 | Normal 默认 scale=1.5、strength=0.3、noise=0.1、Max=false；strength 滑块 0.05–0.60、noise 0–0.50。提示词/模型沿用来源任务，提示词为空时回退当前草稿；负向词、steps/guidance、seed 来自生成任务/当前服务默认。标准模式在本地按 cubic resize，64 对齐且输入不超过 3,145,728 像素。Max 标签为 V5；开启后传 `upscaled_enhance=true`、scale=1.0，由服务端放大；源码会提示 Opus 也可能扣 Anlas，仍需按实际模型支持情况处理，不能只依据 UI 标签推断兼容。 |
| MP-IMG-06 官方 Upscale | Settings 可独立选择本地图片；History 详情和创作结果也有官方放大入口。默认 2×，可切换 4×；4× 明确连续发两次请求。 | 只有 2×/4×；单次官方请求固定放大 2×。超过 3MP 的输入会先等比 cubic 缩小，返回尺寸必须等于当前尺寸的 2× 才保存。官方请求需用户确认并可能消耗 Anlas；独立页面结果可另存到相册。 |
| MP-IMG-05 本地超分 | Agent 工具注册表包含 `upscale_image`，描述标记为副作用并要求用户确认；它读本地源图、生成临时输出路径。 | 可用 Real-ESRGAN anime 4×、RealCUGAN conservative 2×/4×。Agent schema 要求 `image_path`；`engine` 默认 `realesrgan_anime`，`scale` 默认 4，允许 2/4；不匹配时当前实现回退默认 preset。它不会自动写入 History。`ImageEnhancePage` 文件含选图、对比、进度、取消和相册保存界面，但当前 HEAD 中只有页面定义，没有页面构造/导航调用；**该页面不可达不等于本地超分不可达**，Agent 工具链仍属必迁范围。 |
| MP-GEN-14 辅助像素放大 | 局部重绘工作区菜单提供等比例放大 2×/3×，后台 cubic resize 后保存 PNG 并重新载入工作区。 | 这是通用插值 resize，不是神经网络 SR，也不替代 MP-IMG-05 的 Real-ESRGAN/RealCUGAN。 |

另有 `novelai_api_service.dart` 的 `upscaleImage7877()`（`POST /origin/ai/upscale`，body 为 `image` 与固定 `scale:4`）及相应协议测试，但当前 `lib/` 未发现调用者；它不是手机端当前可达的 Upscale 功能。当前可达的 7877/ikun 后期能力是 Director Tools；Tiled 图块按创作页当前选择的生图渠道走单图生成。官方 Enhance/Upscale 只调用官方服务。本轮未把未接线 helper 扩写成手机 parity 能力，也不删除该线索。

## 真实接口字段

| 能力/渠道 | 请求 | 响应解析 |
| --- | --- | --- |
| Director 官方 | `POST /ai/augment-image`；JSON `{image: base64(source bytes), width, height, req_type, defry}`。`req_type` 映射为 `declutter`、`bg-removal`、`lineart`、`sketch`、`colorize`、`emotion`。仅 colorize/emotion 可带非空 `prompt`；emotion 序列化成 `prompt;;defry`。 | 返回二进制图；若是 ZIP 则读取首个 PNG/JPEG/WebP 图片。 |
| Director 7877 | `POST /v1/images/generations`；JSON `{extra: operation, image, width, height, model, response_format:'b64_json', prompt?, defry?}`。operation 为 `director-declutter`、`director-bg-remover`、`director-lineart`、`director-sketch`、`director-colorize`、`director-emotion`。 | 读取 `data[0].b64_json`；允许 data URI 前缀，剥离后 Base64 解码。 |
| Director ikun | 同一 generations endpoint 与响应；operation 字段名改为 `novelai_operation`，其他字段按可选 prompt/defry 和当前模型发送。 | 同 7877。 |
| 官方 Upscale | `POST /ai/upscale`；JSON `{image: base64(bytes), model:'nai-diffusion-5-curated', declared_blur_sigma:0}`。2×一请求，4×两次串联；第 2 次以第 1 次 PNG 为输入。 | 解析二进制/ZIP 图片，解码并检查每次返回宽高都恰为输入的 2×。 |
| 官方 Enhance | `POST /ai/generate-image`；外层 `{input: prompt, model, action:'img2img', parameters:{...}}`。常规 `parameters` 包含 `width,height,image,strength,noise,extra_noise_seed,steps,scale,sampler:'k_euler_ancestral',n_samples:1,negative_prompt,qualityToggle:true,ucPreset:1`，用户 seed 存在时再传 `seed`；Max 再传 `upscaled_enhance:true`。V4+ 模型另附 `use_coords`、`v4_prompt` 和 `v4_negative_prompt`。 | 解析二进制/ZIP 图片；写入新派生图片文件。 |
| 本地 Agent SR | 不走 HTTP。Agent 参数为 `{image_path, engine?, scale?}`，再由 Android MethodChannel/EventChannel 调 Kotlin/ncnn 后端。 | 临时路径/进度事件；需用户自行选择是否保存到相册。 |

官方 Enhance API 的 service 接收强度 0.01–0.99、noise 0–0.99；页面给用户的 Normal 滑块较窄（strength 0.05–0.60、noise 0–0.50）。API 的默认 steps 是 23、guidance scale 是 5.0；具体生成任务可能覆盖它们。Director 官方请求有 `req_type`；7877/ikun 的请求并不使用同一字段，不能把三种协议合并成一个 JSON 形状。

## PC 本轮实现与迁移约束

PC 图片工具工作区在 `lib/prototype/image_tools_panel.dart`，协议适配在 `lib/generation/novelai_generation_service.dart`，参数快照在 `lib/processing/postprocess_parameters.dart`，分块几何/合成在 `lib/processing/tiled_img2img_layout.dart`、`tiled_img2img.dart` 与 `tiled_img2img_rasterizer.dart`。当前入口包含 Tiled、Director、官方 Enhance、官方 Upscale 和本地 SR；Normal Enhance 默认 1.5×/.3/.1，Director Defry 默认 5（0–5）。普通生成保留自己的批量张数；Tiled 参数页不展示通用 batch 控件，每次 job 只新增一个合成 Gallery 结果。

`PostprocessParameters` 序列化操作、源图 asset ref/父记录、图片尺寸、模型、prompt/negative prompt、Director action/Defry、Enhance 的 strength/noise/scale/guidance/steps/seed/Max 和 SR preset。提交前冻结源图与参数；远端请求使用所选官方/7877/ikun 配置。Windows 本地后端公开 `createLocalSuperResolution()`，`upscale(PostprocessParameters, {required Uint8List sourceBytes, onProgress, isCancelled})` 接收资产库读出的 bytes，不按原始路径重新读用户文件。三个 preset 固定为 `realesrganAnime4x`、`realcuganConservative2x`、`realcuganConservative4x`。

源图不被覆盖。成功输出带父图关系、完整有效参数和协议记录，保存为新 Gallery asset；图库结果可通过完整回填重新载入对应源图、图片工具草稿和有效参数（只回填正向提示词仍是单独操作）。后处理保留实际工具模型与参数，同时回填父生成任务的模型、渠道和基础配置，避免本地 SR 模型污染普通生图设置。图库 PNG 可另存；Windows 使用系统保存对话框，Web 使用下载。工作区保存 `imageToolJob` 与逐步进度；重开时将遗留 `running` 标记为 `interrupted`，不自动重发请求。

### Windows 本地 SR 来源与限制

- Real-ESRGAN ncnn Vulkan 使用 [官方 v0.2.5.0 Windows release](https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan/releases/tag/v0.2.5.0)，代码许可 MIT，anime 模型按 BSD-3-Clause 记录。
- Real-CUGAN ncnn Vulkan 使用 [官方 20220728 Windows release](https://github.com/nihui/realcugan-ncnn-vulkan/releases/tag/20220728)，代码和保守模型许可已记入 PC `licenses/`。
- 版本、官方 URL、archive 与抽出文件 SHA-256、许可文件、模型配对和手机/Windows 模型差异见 [`local-sr-runtime-manifest.json`](evidence/local-sr-runtime-manifest.json)。Windows 使用官方发行包中的成对 param/bin；手机 Real-ESRGAN 权重与官方相同但 param 不同，不能交叉混用。Android arm64 `.so` 是 ELF，不能作为 Windows PE 程序复用。
- Setup 脚本将 pinned 发行包默认安装到被忽略的 `.tmp/sr-runtime`；生产默认路径为 exe 同级 `data/sr`，开发可用 `WORLDPAINTER_SR_RUNTIME` 覆盖。最终安装包的 allowlist 应只包含两个 runtime 目录、各自依赖 DLL/模型/许可证和 `install-manifest.json`，排除下载压缩包与临时 staging。
- 后端在调用图片解码器前检查输入/输出各自 64MiB、输入及预期输出各自 32MP；超限会拒绝，不静默缩图。合成 64×64 RGBA PNG 的三个 CLI preset 与最终 Release 中的三个 preset API 均实测通过，输出 256×256 / 128×128 / 256×256。默认 Vulkan 设备为 NVIDIA RTX 5070 Ti。Intel 可枚举，但未验证 Intel-only 运行。

## 凭据与最终验证

用户授权本轮真实测试最多 50 Anlas。凭据只经已部署 Studio 的隔离只读 helper 和匿名管道进入测试进程内存，没有保存明文，也没有修改 Studio 原配置。用户随后要求暂停真实 API；此后的验证全部使用本地模拟服务或注入的 HTTP MockClient，不再查询官方账号或提交官方图片请求。

| 项目 | 结果 |
| --- | --- |
| Flutter tests / analyzer | `flutter test --concurrency=1`：111 项通过；`dart analyze lib test`：无问题。包括来源隔离、取消、SQLite 重开、模式拒绝、模式切换结果隔离、表单作用域、默认参数和 Web 前处理修复回归。 |
| Windows build / runtime bundle | `scripts/build-windows.ps1` 通过；原生编译 0 错误/0 警告。22 个 runtime 文件及安装清单逐项校验 SHA-256 后打包到 `Release/data/sr`；下载 ZIP 和 staging 不进入产物。隐藏启动的 SQLite/Unicode 路径/PNG 哈希与 Windows 凭据跨进程恢复均通过；三个打包 SR 预设 API 实测通过。 |
| Web build / 内置浏览器 | Release 构建通过，仍有既有 Cupertino 字体族提示。仅使用 Codex 内置浏览器手动验收：1440×900 深/浅主题、1280×720、640×480 抽屉；对比拖动、六块合成、线稿处理、PNG 下载、结果作为新原图、图库完整回填和刷新恢复通过。临时视口已恢复默认；最终页面无应用 console error。 |
| 测试接口 | 本地 `127.0.0.1:5090`，只接受 5080 预览 origin，永不转发外网请求。浏览器完成 6 次 1024×1024 tile 请求，合成并下载 1536×1024 PNG；再以其为源生成同尺寸线稿。刷新后请求计数不增加。官方 Enhance/Upscale 与其余协议细节使用 HTTP MockClient 覆盖。 |
| 暂停前真实测试 | 合成源图 320×320，官方单块图生图得到 512×512，Enhance 1.5× 按 64px 对齐得到 448×448，官方 2× 得到 640×640，线稿 320×320，本地 CUGAN 2× 得到 640×640。五项均保存为派生结果并从 SQLite 重开。原始 2 块测试在收到 HTTP 200 后因测试器的余额读取中断停止，未重发该任务；其后使用不同尺寸源图完成单块场景。 |
| 实际花费 | 共 6 次官方图片请求均收到 HTTP 200，核对到累计余额差额 **1 Anlas / 50**，其中官方 2× 为 1，其余已核对操作为 0。费用查询 endpoint 返回 404，因此先按 Studio 的完整付费公式预留，再核对实际余额。详见 [官方测试记录](evidence/processing/official-test-report.json)。 |
| 尚存边界 | 背景移除按 Studio 估算 65，超过本轮预算，未真实调用；其它 Director 动作、V5 Max、4× 远端与网关目前仅 mock 验证。多块真实最终合成、真实绘画品质、Intel-only Vulkan、全新机器安装以及 Windows 另存对话框手动交互未验收。远端响应仍受 HTTP/ZIP/图片大小上限保护。手机端其它模块继续逐项迁移，本轮不代表全量 parity 已完成。 |

Web 修复依据本机 Flutter Web SDK：encoded `ImageDescriptor` 的 width/height getter 不支持 Web，且其 resize 路径禁止放大。前处理改为受格式/头部边界保护的首帧尺寸读取，并显式 `allowUpscaling:true`；没有修改 Flutter SDK。成功通知使用工作区内状态，避免 Snackbar 遮挡连续操作的开始按钮。真实测试在用户暂停前结束，后续兼容性修改使用 mock 回归。

独立最终复核还确认了模式与结果的绑定问题：切换处理模式现会清除当前结果引用/尺寸，图库保留原记录；运行中锁定模式，控制器对程序化改动仍检查源图版本、源图引用和模式一致，旧任务不能挂到新模式。完成后保存期间不再显示工具停止按钮。内置浏览器复验了模式切换清除结果、图库记录仍可完整回填，模拟请求计数仍为 7。

证据汇总见 [validation.json](evidence/processing/validation.json)，截图见 [深色对比](evidence/processing/desktop-dark.jpg)、[浅色对比](evidence/processing/desktop-light.jpg)、[窄窗口参数](evidence/processing/desktop-compact.jpg) 和 [刷新恢复](evidence/processing/recovered-tools.jpg)。这是开发测试版，运行时需保留完整 Release 目录；尚未正式发布安装包。

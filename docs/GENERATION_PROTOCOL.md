# NovelAI 生成协议与参数契约

本文描述 `lib/generation/` 的单图生成接口和三个 NovelAI 适配器。官方字段以 [NovelAI 图像 API 文档](https://image.novelai.net/docs/index.html) 为准；7877 与 ikun 的网关字段依据手机端当前适配代码移植。两个网关各自有不同请求格式，不代表它们与官方 API 或彼此完全兼容。

## 调用接口

`GenerationParameters` 是一张图的不可变参数快照，支持 `toJson()`、`fromJson()` 和 `copyWith()`。嵌套类型为 `GenerationCharacter`、`GenerationCharacterReference`、`VibeReference` 和 `PreciseReference`。图像字段保存 asset ID，不保存路径或字节；调用 `NovelAiGenerationService.generate` 时传入 `resolveImage(String assetId)`，由资产仓库返回 `Uint8List`。

服务调用参数是 `parameters`、`provider`、`credential` 和 `resolveImage`，结果 `GenerationResult` 提供 `imageBytes` 与 `effectiveParameters`。每次调用只请求一张图，批量由上层重复调用并为每张图保存实际 seed。未设置 seed 时，客户端冻结一个安全随机的 uint32；seed `0` 是有效值。

精确类型名如下：

```dart
GenerationOperation.textToImage
GenerationOperation.imageToImage
GenerationOperation.inpaint

NovelAiProtocol.official
NovelAiProtocol.gateway7877
NovelAiProtocol.ikun
```

`GenerationProviderConfig` 包含 protocol、网关 `baseUri` 和仅供本地 mock 使用的 `allowInsecureLoopbackForTesting`。官方协议忽略用户提供的地址并固定访问 `https://image.novelai.net`。凭据由调用方按协议及规范化 endpoint 隔离后传入，不能写入参数 JSON。

## 三种请求格式

| protocol ID / 显示名 | 单图请求 | 关键差异 |
| --- | --- | --- |
| `official` / NovelAI 官方 | `POST /ai/generate-image`，Bearer token；非精确参考时发送 JSON，精确参考使用 multipart 的 `request`、`director_ref_N` 文件和缓存字段 | action 为 `generate`、`img2img` 或 `infill`；Vibe 图像先调 `/ai/encode-vibe`；inpaint 使用 `-inpainting` 模型 ID。V4 角色通过 `v4_prompt` / `v4_negative_prompt` 和 `use_coords` 表达。 |
| `gateway7877` / 7877 网关 | `POST /v1/images/generations`，Bearer key；普通参数位于 `params`，图像结果按网关的 OpenAI 风格 `data[].b64_json`/`url` 解析 | 7877 有自己的 sampler/noiseSchedule 集合；Vibe 通过网关 `extra: encode-vibe` 先编码；角色作为 `characters` 传递。该端点当前不接受 Precise Reference。 |
| `ikun` / ikun 网关 | `POST /v1/images/generations`，Bearer key；按手机端实现分别构造文本、img2img、inpaint 和 precise-reference payload | Ikun 使用独立 sampler/noiseSchedule 集合；Precise Reference 以 `novelai_operation: precise-reference` 和 `references` 数组提交；Vibe 按手机端单图/多图字段提交。img2img、不支持组合在发出请求前拒绝。 |

7877 的模型别名转换只在请求时执行，结果中的 effective model 保留 wire ID：`nai-v4.5-full`/`nai-v4-5-full` → `nai-diffusion-4-5-full`，curated 同理；`nai-v4-full`/`nai-v4-curated` → 对应 `nai-diffusion-4-*`；`nai-v3` → `nai-diffusion-3`；`nai-v3-furry`/`nai-v3-furry-limit` → `nai-diffusion-3-furry`。其他 model ID 原样发送。UI 显示名由上层模型目录负责，不作为协议字段。

## 有效参数与拒绝条件

- 宽高须为 64 的倍数，范围 64–4096，像素总数不超过 4096²；Ikun 单边上限为 1600。非官方 V5 请求上限为 1 MP。
- steps 为 1–50；V5 为 1–28。scale 为 1–10，cfgRescale 为 0–1；所有浮点参数须为有限值。
- 未知 sampler 或 noiseSchedule 会在发送前报 `unsupportedCombination`，不会静默替换。官方 V5 固定使用 `karras`；非 Ikun 的 `native` 归一为 `karras`，并记录在 `effectiveParameters`。
- seed 必须是 0 到 2³²−1。角色最多 6 个、Vibe 最多 4 个；坐标须成对且在 0–1。参考强度须在 0–1。角色提示只对支持的 V4+ 模型发送。
- 官方和 7877 不接受 V5 的 Vibe；7877 不接受 Precise Reference；官方 V5 不接受参考图；ikun 的角色和参考图组合受 operation/model 能力限制。unsupported 组合会在网络请求前失败。
- `textToImage` 不允许携带源图/蒙版 ID；`imageToImage` 需要 `img2imgSourceImageId`；`inpaint` 需要 `sourceImageId` 与 `maskImageId`。图像字节经 resolver 验证 PNG/JPEG/WebP，并限制单张与合计输入大小。

## 响应、错误与网络边界

官方响应支持 ZIP 中的 PNG/JPEG/WebP，也支持 JSON 的 base64 image；网关支持 base64 图片和 HTTPS 图片 URL。ZIP 压缩响应上限 64 MiB，最多 32 个文件，展开总量上限 64 MiB，单张图像上限 32 MiB。ZIP64 不支持。下载 URL 使用不带 Authorization 的请求，且不跟随重定向；服务端错误响应正文不进入异常或 UI message，异常仅提供分类与 HTTP 状态码。

服务代码本身不导入 `dart:io`。Windows/IO 构建在下载 URL 前解析 DNS 并拒绝非公网地址；这是尽力而为检查，HTTP 栈后续再次解析时仍存在 DNS rebinding 窗口。Web 构建无法读取 DNS 结果，会拒绝明显的私有 IP 和本地后缀，但无法验证域名实际解析到的地址。普通网关请求允许用户配置 HTTPS endpoint；明文 HTTP 只允许显式启用的 loopback mock。

## 验证范围与协议局限

测试只使用本地 mock HTTP client，不调用真实 NovelAI 账号。官方 Swagger 描述可用于核对官方 action、JSON/ZIP 响应；Precise Reference 的 multipart cached-image 字段与两个第三方网关的具体 payload 来自手机端既有实现，公开 OpenAPI 不保证这些扩展对其他兼容服务有效。网关 schema 可能随部署变化，服务当前按本地移植契约处理，不会读取模型列表动态推断字段能力。

# 图片资产存储契约

日期：2026-10-11。该模块只保存原始 PNG、JPEG 或 WebP 字节，返回的元数据可写入图库索引。它不导入文件选择器、不生成缩略图，也不修改工作区快照格式。

## API

```dart
import 'dart:typed_data';
import 'package:worldpainter_pc/media/image_asset_store.dart';

final store = await openImageAssetStore(directory: dataDirectory);
try {
  final ImageAsset asset = await store.save(imageBytes);
  final Map<String, Object?> galleryMetadata = asset.toJson();
  final Uint8List originalBytes = await store.read(asset.assetRef);
} finally {
  await store.close();
}
```

`ImageAsset` 包含 `id`、`assetRef`、`width`、`height`、`mime`、`sha256` 和 `byteLength`。`id` 与 `sha256` 都是小写 SHA-256。图库索引保存 `asset.toJson()` 的元数据以及其它业务字段；不要把图片字节或 base64 放进工作区 JSON。`read` 接受 `assetRef`，返回保存时的原始字节。图片只通过 codec 解码校验和读取尺寸，不会重新编码。

调用方先等待 `save` 成功，再把 `asset.toJson()` 与图库记录写入工作区数据库。若图片写盘成功而索引写入失败，磁盘上的未索引资产会保留，可用于之后的恢复；该模块不清理孤儿资产。调用方必须在生命周期结束时调用 `close()`；重复关闭安全，关闭会等待已排队的存储操作。

## 格式与边界

- 默认输入上限为 64 MiB；工厂参数 `maximumImageBytes` 可将上限调低，不能调高。
- 格式由文件签名和 PNG/JPEG/WebP 头部识别；先限制声明尺寸，再用 Flutter 图片 codec 实际解码确认图像有效并校对尺寸。
- 宽高必须为正数，任一边不得超过 32,768 像素，总像素不得超过 100,000,000。
- MIME 与扩展名由解码输入签名推导，不信任外部文件名或调用方 MIME 声明。
- 内容哈希用于稳定身份和去重。若发现已存在的相同哈希引用却对应不同字节，存储会报完整性错误，不覆盖目标文件。

## 平台存储

Windows/原生平台在现有数据目录下管理 `image_assets/sha256/<hash前两位>/<hash>.<扩展名>`。工厂的 `directory` 参数及默认目录优先级与 `openWorkspaceStore` 一致：显式目录、`WORLDPAINTER_DATA_DIR`、编译期目录、Windows `LOCALAPPDATA/WorldPainter/PC`。写入先在目标目录内创建独占临时文件，完整写入并 flush 后再 rename 发布；只访问本模块自己的 `image_assets` 目录，不扫描或删除其它用户文件。资产引用是相对路径，不向图库索引暴露机器绝对路径。

Web 使用当前站点的 `assets.sqlite`，数据库由现有 `sqflite_common_ffi_web` 存储到 IndexedDB。`image_asset` 表把字节存为 BLOB，并保存引用、哈希、MIME、尺寸和长度。它与 `workspace.sqlite` 分开，避免把图片事务混入工作区快照；浏览器存储仍受站点源和浏览器清理策略影响。Web 工厂接受相同的 `directory` 参数以保持调用形式一致，但数据保存在当前站点，不写入本机路径。

两个平台均使用同一引用格式：`sha256/ab/<64位小写SHA-256>.<扩展名>`，例如 `sha256/52/529e...c8b3.png`。调用方应把整个 `assetRef` 当作不透明值保存和传递，不自行拼接绝对路径。

## 依赖与验证

实现使用项目已有的 Flutter `dart:ui` codec、`crypto`、`path`、`sqflite_common_ffi_web` 和 `sqflite_common`，没有增加 `pubspec.yaml` 依赖。独立用例在 `test/media_image_asset_store_test.dart` 覆盖合成 2×2 PNG、原始字节读回、重开、哈希去重、非法内容/引用及大小限制。按工作区协调要求，本次只写入测试，没有启动 Flutter test 或 build。

/// Stable metadata returned after an image is saved to [ImageAssetStore].
///
/// [assetRef] is an opaque, relative reference. It never contains an absolute
/// path and can be stored in the gallery index alongside this metadata.
class ImageAsset {
  const ImageAsset({
    required this.id,
    required this.assetRef,
    required this.width,
    required this.height,
    required this.mime,
    required this.sha256,
    required this.byteLength,
  });

  /// Content identity. This is the lower-case SHA-256 digest of the bytes.
  final String id;

  /// Stable storage reference accepted by `ImageAssetStore.read`.
  final String assetRef;

  final int width;
  final int height;
  final String mime;
  final String sha256;
  final int byteLength;

  /// Metadata suitable for a gallery/index record; image bytes are excluded.
  Map<String, Object?> toJson() => <String, Object?>{
    'id': id,
    'assetRef': assetRef,
    'width': width,
    'height': height,
    'mime': mime,
    'sha256': sha256,
    'byteLength': byteLength,
  };
}

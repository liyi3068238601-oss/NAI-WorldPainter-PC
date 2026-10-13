import 'dart:typed_data';

import 'image_asset.dart';

/// Durable storage for validated, content-addressed image assets.
abstract interface class ImageAssetStore {
  /// Human-readable backend name for diagnostics.
  String get label;

  /// Validates, stores, and deduplicates [bytes].
  Future<ImageAsset> save(Uint8List bytes);

  /// Reads a previously saved asset by its opaque [assetRef].
  Future<Uint8List> read(String assetRef);

  /// Releases the store. Calling this more than once is safe.
  Future<void> close();
}

/// Optional lifecycle operations for stores that can enumerate and remove
/// their own managed assets.
///
/// This is deliberately separate from [ImageAssetStore] so lightweight test
/// stores and callers that only need save/read do not need to implement asset
/// maintenance.
abstract interface class ImageAssetMaintenance {
  /// Lists valid opaque references owned by this store.
  ///
  /// Implementations must omit arbitrary files, malformed references, and
  /// symbolic links. The returned values can be passed to [ImageAssetStore.read]
  /// or [removeAsset].
  Future<List<String>> listAssets();

  /// Removes exactly the managed asset addressed by [assetRef].
  ///
  /// Missing assets are ignored. Invalid references and paths that are not
  /// regular managed files are rejected.
  Future<void> removeAsset(String assetRef);
}

class ImageAssetStoreException implements Exception {
  const ImageAssetStoreException(this.message, {this.cause});

  final String message;
  final Object? cause;

  @override
  String toString() => cause == null
      ? 'ImageAssetStoreException: $message'
      : 'ImageAssetStoreException: $message ($cause)';
}

class ImageAssetValidationException extends ImageAssetStoreException {
  const ImageAssetValidationException(super.message, {super.cause});

  @override
  String toString() => 'ImageAssetValidationException: $message';
}

class ImageAssetNotFoundException extends ImageAssetStoreException {
  const ImageAssetNotFoundException(String assetRef)
    : super('Image asset not found: $assetRef');

  @override
  String toString() => 'ImageAssetNotFoundException: $message';
}

class ImageAssetIntegrityException extends ImageAssetStoreException {
  const ImageAssetIntegrityException(super.message, {super.cause});

  @override
  String toString() => 'ImageAssetIntegrityException: $message';
}

class ImageAssetStoreClosedException extends ImageAssetStoreException {
  const ImageAssetStoreClosedException()
    : super('The image asset store has been closed.');

  @override
  String toString() => 'ImageAssetStoreClosedException: $message';
}

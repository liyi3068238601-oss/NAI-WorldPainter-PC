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

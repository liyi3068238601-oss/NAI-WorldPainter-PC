import 'dart:async';

import 'image_asset_store_contract.dart';

/// Serializes storage operations and makes close wait for work already queued.
abstract class SerializedImageAssetStore implements ImageAssetStore {
  Future<void> _tail = Future<void>.value();
  Future<void>? _closeFuture;
  bool _closed = false;

  Future<T> runSerialized<T>(Future<T> Function() operation) {
    final result = Completer<T>();
    _tail = _tail.then((_) async {
      if (_closed) {
        result.completeError(const ImageAssetStoreClosedException());
        return;
      }
      try {
        result.complete(await operation());
      } catch (error, stackTrace) {
        result.completeError(error, stackTrace);
      }
    });
    return result.future;
  }

  @override
  Future<void> close() {
    final existingClose = _closeFuture;
    if (existingClose != null) return existingClose;

    final result = Completer<void>();
    _closeFuture = result.future;
    _tail = _tail.then((_) async {
      _closed = true;
      try {
        await closeResources();
        result.complete();
      } catch (error, stackTrace) {
        result.completeError(error, stackTrace);
      }
    });
    return result.future;
  }

  Future<void> closeResources();
}

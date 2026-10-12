import 'dart:async';
import 'dart:typed_data';

import 'postprocess_parameters.dart';

/// Local image super-resolution capability, with no dependency on a source
/// asset path. Callers must resolve the selected asset and pass its bytes.
abstract interface class LocalSuperResolution {
  bool get isAvailable;

  LocalSuperResolutionInfo get info;

  Future<Uint8List> upscale(
    PostprocessParameters parameters, {
    required Uint8List sourceBytes,
    FutureOr<void> Function(String message, int current, int total)? onProgress,
    bool Function()? isCancelled,
  });

  Future<void> cancel();
}

class LocalSuperResolutionInfo {
  final bool isAvailable;
  final String? unavailableReason;
  final Set<String> availableModels;
  final String backendVersion;

  LocalSuperResolutionInfo({
    required this.isAvailable,
    required this.availableModels,
    this.unavailableReason,
    this.backendVersion =
        'Real-ESRGAN ncnn-vulkan 20220424; Real-CUGAN ncnn-vulkan 20220728',
  });
}

class LocalSuperResolutionException implements Exception {
  final String message;

  const LocalSuperResolutionException(this.message);

  @override
  String toString() => message;
}

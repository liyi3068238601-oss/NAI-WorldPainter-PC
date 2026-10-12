import 'dart:async';
import 'dart:typed_data';

import 'local_sr_contract.dart';
import 'postprocess_parameters.dart';

LocalSuperResolution createLocalSuperResolution() =>
    _UnavailableLocalSuperResolution();

class _UnavailableLocalSuperResolution implements LocalSuperResolution {
  @override
  bool get isAvailable => false;

  @override
  LocalSuperResolutionInfo get info => LocalSuperResolutionInfo(
    isAvailable: false,
    availableModels: const <String>{},
    unavailableReason: '本地超分目前仅支持 Windows 桌面版。',
  );

  @override
  Future<void> cancel() async {}

  @override
  Future<Uint8List> upscale(
    PostprocessParameters parameters, {
    required Uint8List sourceBytes,
    FutureOr<void> Function(String message, int current, int total)? onProgress,
    bool Function()? isCancelled,
  }) async {
    throw const LocalSuperResolutionException('本地超分目前仅支持 Windows 桌面版。');
  }
}

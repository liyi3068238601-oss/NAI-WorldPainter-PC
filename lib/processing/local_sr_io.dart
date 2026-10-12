import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:path/path.dart' as p;

import 'local_sr_contract.dart';
import 'postprocess_parameters.dart';

const String _runtimeEnvironmentKey = 'WORLDPAINTER_SR_RUNTIME';
const String _tempEnvironmentKey = 'WORLDPAINTER_SR_TEMP';
const Duration _processTimeout = Duration(minutes: 20);
const int _maxInputBytes = 64 * 1024 * 1024;
const int _maxOutputBytes = 64 * 1024 * 1024;
const int _maxPixels = 32 * 1024 * 1024;

LocalSuperResolution createLocalSuperResolution() =>
    _WindowsLocalSuperResolution();

class _WindowsLocalSuperResolution implements LocalSuperResolution {
  Process? _activeProcess;
  bool _cancelRequested = false;
  bool _busy = false;

  String get _runtimeRoot {
    final override = Platform.environment[_runtimeEnvironmentKey]?.trim();
    if (override != null && override.isNotEmpty) {
      return p.normalize(p.absolute(override));
    }
    return p.normalize(
      p.join(File(Platform.resolvedExecutable).parent.path, 'data', 'sr'),
    );
  }

  @override
  bool get isAvailable => info.isAvailable;

  @override
  LocalSuperResolutionInfo get info {
    if (!Platform.isWindows) {
      return LocalSuperResolutionInfo(
        isAvailable: false,
        availableModels: const <String>{},
        unavailableReason: '本地超分目前仅支持 Windows 桌面版。',
      );
    }
    final available = <String>{};
    if (_hasRealEsrganRuntime) {
      available.add('realesrganAnime4x');
    }
    if (_hasRealCuganRuntime(2)) {
      available.add('realcuganConservative2x');
    }
    if (_hasRealCuganRuntime(4)) {
      available.add('realcuganConservative4x');
    }
    final hasAnyModel = available.isNotEmpty;
    return LocalSuperResolutionInfo(
      isAvailable: hasAnyModel,
      availableModels: Set<String>.unmodifiable(available),
      unavailableReason: hasAnyModel ? null : 'Windows 本地超分运行时或模型未安装。',
    );
  }

  String get _realEsrganDirectory => p.join(_runtimeRoot, 'realesrgan');
  String get _realCuganDirectory => p.join(_runtimeRoot, 'realcugan');
  String get _realEsrganExecutable =>
      p.join(_realEsrganDirectory, 'realesrgan-ncnn-vulkan.exe');
  String get _realCuganExecutable =>
      p.join(_realCuganDirectory, 'realcugan-ncnn-vulkan.exe');
  String get _realEsrganModels => p.join(_realEsrganDirectory, 'models');
  String get _realCuganModels => p.join(_realCuganDirectory, 'models-se');

  bool get _hasRealEsrganRuntime =>
      File(_realEsrganExecutable).existsSync() &&
      File(p.join(_realEsrganModels, 'realesrgan-x4plus-anime.param'))
          .existsSync() &&
      File(p.join(_realEsrganModels, 'realesrgan-x4plus-anime.bin'))
          .existsSync();

  bool _hasRealCuganRuntime(int scale) {
    final modelName = 'up${scale}x-conservative';
    return File(_realCuganExecutable).existsSync() &&
        File(p.join(_realCuganModels, '$modelName.param')).existsSync() &&
        File(p.join(_realCuganModels, '$modelName.bin')).existsSync();
  }

  @override
  Future<Uint8List> upscale(
    PostprocessParameters parameters, {
    required Uint8List sourceBytes,
    FutureOr<void> Function(String message, int current, int total)? onProgress,
    bool Function()? isCancelled,
  }) async {
    if (_busy) {
      throw const LocalSuperResolutionException('本地超分任务正在运行。');
    }
    _busy = true;
    _cancelRequested = false;
    Directory? jobDirectory;
    Process? process;
    Timer? cancellationTimer;
    var cancelled = false;
    var timedOut = false;

    try {
      if (!Platform.isWindows) {
        throw const LocalSuperResolutionException('本地超分目前仅支持 Windows 桌面版。');
      }
      try {
        parameters.validate();
      } on PostprocessValidationException catch (_) {
        throw const LocalSuperResolutionException('本地超分参数无效。');
      }
      if (parameters.operation != PostprocessOperation.localSr) {
        throw const LocalSuperResolutionException('操作类型不是本地超分。');
      }
      final model = parameters.model;
      final scale = parameters.scale?.toInt();
      final runtimeAvailable = switch (model) {
        'realesrganAnime4x' => _hasRealEsrganRuntime,
        'realcuganConservative2x' => _hasRealCuganRuntime(2),
        'realcuganConservative4x' => _hasRealCuganRuntime(4),
        _ => false,
      };
      if (!runtimeAvailable) {
        throw const LocalSuperResolutionException('所选本地超分模型尚未安装。');
      }
      if (sourceBytes.isEmpty || sourceBytes.length > _maxInputBytes) {
        throw const LocalSuperResolutionException('源图像为空或超过本地处理上限。');
      }
      final sourceInfo = _readImageInfo(sourceBytes);
      if (sourceInfo == null ||
          sourceInfo.width != parameters.width ||
          sourceInfo.height != parameters.height) {
        throw const LocalSuperResolutionException('源图像格式无效，或尺寸与所选图片不一致。');
      }
      final inputPixels = sourceInfo.width * sourceInfo.height;
      final outputPixels = inputPixels * scale! * scale;
      if (inputPixels > _maxPixels || outputPixels > _maxPixels) {
        throw const LocalSuperResolutionException(
          '本地超分输入或预期结果超过 32MP 上限；请先缩小图片后重试。',
        );
      }
      if (_wasCancelled(isCancelled)) {
        throw const LocalSuperResolutionException('本地超分已取消。');
      }

      final tempRoot = _resolveTempRoot();
      await Directory(tempRoot).create(recursive: true);
      final jobName =
          'job_${DateTime.now().microsecondsSinceEpoch}_${Random.secure().nextInt(1 << 32)}';
      jobDirectory = Directory(p.join(tempRoot, jobName));
      await jobDirectory.create();
      final inputFile = File(
        p.join(jobDirectory.path, 'source.${sourceInfo.extension}'),
      );
      final outputFile = File(p.join(jobDirectory.path, 'result.png'));
      await inputFile.writeAsBytes(sourceBytes, flush: true);

      final command = _commandFor(
        model!,
        scale,
        inputFile.path,
        outputFile.path,
      );
      _emitProgress(onProgress, '正在启动本地超分', 0, 100);
      final startedProcess = await Process.start(
        command.executable,
        command.arguments,
        environment: _childEnvironment(jobDirectory.path),
        includeParentEnvironment: false,
        workingDirectory: command.workingDirectory,
        mode: ProcessStartMode.normal,
        runInShell: false,
      );
      process = startedProcess;
      _activeProcess = startedProcess;
      if (_wasCancelled(isCancelled)) {
        cancelled = true;
        startedProcess.kill();
      }

      var lastPercent = -1;
      void reportPercent(int percent) {
        if (percent == lastPercent) return;
        lastPercent = percent;
        _emitProgress(onProgress, '正在进行本地超分', percent, 100);
      }

      final stdoutDone = _drainProgress(startedProcess.stdout, reportPercent);
      final stderrDone = _drainProgress(startedProcess.stderr, reportPercent);
      cancellationTimer = Timer.periodic(const Duration(milliseconds: 200), (
        _,
      ) {
        if (_wasCancelled(isCancelled)) {
          cancelled = true;
          startedProcess.kill();
        }
      });

      final exitFuture = startedProcess.exitCode;
      late int exitCode;
      try {
        exitCode = await exitFuture.timeout(_processTimeout);
      } on TimeoutException {
        timedOut = true;
        startedProcess.kill();
        try {
          exitCode = await exitFuture.timeout(const Duration(seconds: 5));
        } on TimeoutException {
          exitCode = -1;
        }
      }
      cancellationTimer.cancel();
      cancellationTimer = null;
      try {
        await Future.wait<void>([stdoutDone, stderrDone])
            .timeout(const Duration(seconds: 5));
      } on TimeoutException {
        startedProcess.kill();
        if (!timedOut && !cancelled) {
          throw const LocalSuperResolutionException('本地超分进程未能正常关闭。');
        }
      }
      if (cancelled || _wasCancelled(isCancelled)) {
        throw const LocalSuperResolutionException('本地超分已取消。');
      }
      if (timedOut) {
        throw const LocalSuperResolutionException('本地超分处理超时。');
      }
      if (exitCode != 0) {
        throw const LocalSuperResolutionException(
          '本地超分未能完成，请检查 Windows 图形驱动和运行时安装。',
        );
      }
      if (!await outputFile.exists()) {
        throw const LocalSuperResolutionException('本地超分没有生成结果图像。');
      }
      final outputLength = await outputFile.length();
      if (outputLength < 45 || outputLength > _maxOutputBytes) {
        throw const LocalSuperResolutionException('本地超分结果图像大小无效。');
      }
      final outputBytes = await outputFile.readAsBytes();
      final outputInfo = _readPngInfo(outputBytes);
      final expectedWidth = parameters.width * scale;
      final expectedHeight = parameters.height * scale;
      if (outputInfo == null ||
          outputInfo.width != expectedWidth ||
          outputInfo.height != expectedHeight) {
        throw const LocalSuperResolutionException('本地超分结果格式无效或输出尺寸不正确。');
      }
      _emitProgress(onProgress, '本地超分完成', 100, 100);
      return outputBytes;
    } on LocalSuperResolutionException {
      rethrow;
    } catch (_) {
      throw const LocalSuperResolutionException('本地超分运行失败。');
    } finally {
      cancellationTimer?.cancel();
      if (process != null && _activeProcess == process) {
        if (cancelled || timedOut || _cancelRequested) {
          process.kill();
          try {
            await process.exitCode.timeout(const Duration(seconds: 5));
          } on TimeoutException {
            // Keep cleanup bounded even if the platform fails to terminate it.
          }
        }
        _activeProcess = null;
      }
      if (jobDirectory != null) {
        await _deleteJobDirectory(jobDirectory);
      }
      _busy = false;
      _cancelRequested = false;
    }
  }

  ({String executable, List<String> arguments, String workingDirectory})
  _commandFor(String model, int scale, String inputPath, String outputPath) {
    if (model == 'realesrganAnime4x') {
      return (
        executable: _realEsrganExecutable,
        arguments: <String>[
          '-i',
          inputPath,
          '-o',
          outputPath,
          '-n',
          'realesrgan-x4plus-anime',
          '-s',
          '4',
          '-t',
          '0',
          '-m',
          _realEsrganModels,
          '-f',
          'png',
          '-j',
          '2:1:2',
          '-v',
        ],
        workingDirectory: _realEsrganDirectory,
      );
    }
    if (model == 'realcuganConservative2x' ||
        model == 'realcuganConservative4x') {
      return (
        executable: _realCuganExecutable,
        arguments: <String>[
          '-i',
          inputPath,
          '-o',
          outputPath,
          '-n',
          '-1',
          '-s',
          '$scale',
          '-t',
          '0',
          '-c',
          '0',
          '-m',
          _realCuganModels,
          '-f',
          'png',
          '-j',
          '2:1:2',
          '-v',
        ],
        workingDirectory: _realCuganDirectory,
      );
    }
    throw const LocalSuperResolutionException('不支持所选本地超分模型。');
  }

  String _resolveTempRoot() {
    final override = Platform.environment[_tempEnvironmentKey]?.trim();
    if (override != null && override.isNotEmpty) {
      return p.normalize(p.absolute(override));
    }
    final localAppData = Platform.environment['LOCALAPPDATA']?.trim();
    if (localAppData == null || localAppData.isEmpty) {
      throw const LocalSuperResolutionException('Windows 本地数据目录不可用。');
    }
    return p.join(localAppData, 'WorldPainter', 'PC', 'sr', 'jobs');
  }

  Map<String, String> _childEnvironment(String tempDirectory) {
    // Do not pass API keys or unrelated user environment to the image CLI.
    final environment = <String, String>{
      'TEMP': tempDirectory,
      'TMP': tempDirectory,
    };
    final systemRoot = Platform.environment['SystemRoot']?.trim();
    if (systemRoot != null && systemRoot.isNotEmpty) {
      environment['SystemRoot'] = systemRoot;
      environment['WINDIR'] = systemRoot;
    }
    return environment;
  }

  bool _wasCancelled(bool Function()? isCancelled) {
    if (_cancelRequested) return true;
    try {
      return isCancelled?.call() ?? false;
    } catch (_) {
      return false;
    }
  }

  void _emitProgress(
    FutureOr<void> Function(String, int, int)? onProgress,
    String message,
    int current,
    int total,
  ) {
    if (onProgress == null) return;
    unawaited(
      Future<void>.sync(() => onProgress(message, current, total))
          .catchError((_) {}),
    );
  }

  Future<void> _drainProgress(
    Stream<List<int>> stream,
    void Function(int percent) onPercent,
  ) async {
    final percentPattern = RegExp(r'(?<!\d)(\d{1,3})(?:\.\d+)?\s*%');
    await for (final line in stream.transform(
      const Utf8Decoder(allowMalformed: true),
    )) {
      final match = percentPattern.firstMatch(line);
      if (match == null) continue;
      final percent = int.tryParse(match.group(1)!);
      if (percent != null && percent >= 0 && percent <= 100) {
        onPercent(percent);
      }
    }
  }

  Future<void> _deleteJobDirectory(Directory directory) async {
    for (var attempt = 0; attempt < 10; attempt++) {
      try {
        if (await directory.exists()) await directory.delete(recursive: true);
        return;
      } on FileSystemException {
        await Future<void>.delayed(Duration(milliseconds: 100 * (attempt + 1)));
      }
    }
  }

  @override
  Future<void> cancel() async {
    _cancelRequested = true;
    _activeProcess?.kill();
  }
}

class _ImageInfo {
  final int width;
  final int height;
  final String extension;

  const _ImageInfo(this.width, this.height, this.extension);
}

_ImageInfo? _readImageInfo(Uint8List bytes) {
  final png = _readPngInfo(bytes);
  if (png != null) return _ImageInfo(png.width, png.height, 'png');
  if (_hasAscii(bytes, 0, 'RIFF') &&
      _hasAscii(bytes, 8, 'WEBP') &&
      bytes.length >= 30) {
    final chunkType = String.fromCharCodes(bytes.sublist(12, 16));
    if (chunkType == 'VP8X') {
      return _ImageInfo(
        _readU24(bytes, 24) + 1,
        _readU24(bytes, 27) + 1,
        'webp',
      );
    }
    if (chunkType == 'VP8 ' &&
        bytes.length >= 30 &&
        bytes[23] == 0x9d &&
        bytes[24] == 0x01 &&
        bytes[25] == 0x2a) {
      return _ImageInfo(
        _readU16(bytes, 26) & 0x3fff,
        _readU16(bytes, 28) & 0x3fff,
        'webp',
      );
    }
    if (chunkType == 'VP8L' && bytes.length >= 25 && bytes[20] == 0x2f) {
      final width = 1 + bytes[21] + ((bytes[22] & 0x3f) << 8);
      final height =
          1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10);
      return _ImageInfo(width, height, 'webp');
    }
  }
  final jpeg = _readJpegSize(bytes);
  if (jpeg != null) return _ImageInfo(jpeg.$1, jpeg.$2, 'jpg');
  return null;
}

({int width, int height})? _readPngInfo(Uint8List bytes) {
  const signature = <int>[137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 45) return null;
  for (var i = 0; i < signature.length; i++) {
    if (bytes[i] != signature[i]) return null;
  }
  if (_readU32(bytes, 8) != 13 || !_hasAscii(bytes, 12, 'IHDR')) return null;
  final width = _readU32(bytes, 16);
  final height = _readU32(bytes, 20);
  var offset = 8;
  var foundIend = false;
  var foundIdat = false;
  while (offset + 12 <= bytes.length) {
    final length = _readU32(bytes, offset);
    if (length < 0 || length > bytes.length - offset - 12) return null;
    final type = String.fromCharCodes(bytes.sublist(offset + 4, offset + 8));
    if (type == 'IDAT') foundIdat = true;
    offset += length + 12;
    if (type == 'IEND') {
      foundIend = length == 0;
      break;
    }
  }
  if (!foundIdat || !foundIend || width < 1 || height < 1) return null;
  return (width: width, height: height);
}

(int, int)? _readJpegSize(Uint8List bytes) {
  if (bytes.length < 4 || bytes[0] != 0xff || bytes[1] != 0xd8) return null;
  var offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] != 0xff) return null;
    while (offset < bytes.length && bytes[offset] == 0xff) {
      offset++;
    }
    if (offset >= bytes.length) return null;
    final marker = bytes[offset++];
    if (marker == 0xd9 || marker == 0xda) return null;
    if (marker == 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.length) return null;
    final segmentLength = _readU16(bytes, offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
    if (_isJpegStartOfFrame(marker)) {
      if (segmentLength < 7) return null;
      return (_readU16(bytes, offset + 5), _readU16(bytes, offset + 3));
    }
    offset += segmentLength;
  }
  return null;
}

bool _isJpegStartOfFrame(int marker) => const <int>{
  0xc0,
  0xc1,
  0xc2,
  0xc3,
  0xc5,
  0xc6,
  0xc7,
  0xc9,
  0xca,
  0xcb,
  0xcd,
  0xce,
  0xcf,
}.contains(marker);

bool _hasAscii(Uint8List bytes, int offset, String value) {
  if (offset < 0 || offset + value.length > bytes.length) return false;
  for (var i = 0; i < value.length; i++) {
    if (bytes[offset + i] != value.codeUnitAt(i)) return false;
  }
  return true;
}

int _readU16(Uint8List bytes, int offset) =>
    (bytes[offset] << 8) | bytes[offset + 1];

int _readU24(Uint8List bytes, int offset) =>
    bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);

int _readU32(Uint8List bytes, int offset) =>
    (bytes[offset] << 24) |
    (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) |
    bytes[offset + 3];

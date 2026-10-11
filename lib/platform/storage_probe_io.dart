import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:path/path.dart' as p;

import '../storage/platform_store_io.dart';
import 'desktop_lifecycle.dart';

const _windowChannel = MethodChannel('worldpainter/window');
const _probeTimeout = Duration(seconds: 50);
const _probeGalleryId = 'probe-gallery-001';

/// Runs a Windows persistence phase when launched with `--storage-probe`.
///
/// The returned `true` tells the app entrypoint that the probe owns lifecycle
/// and must not start the normal UI. Calls without the flag have no side
/// effects and return `false`.
Future<bool> runStorageProbe(List<String> args) async {
  if (!args.contains('--storage-probe')) {
    return false;
  }

  final phaseOption = _readOption(args, '--phase');
  final dataDirectoryOption = _readOption(args, '--data-dir');
  final reportPathOption = _readOption(args, '--report');
  if (phaseOption == null ||
      (phaseOption != 'write' && phaseOption != 'read')) {
    stderr.writeln('Storage probe requires --phase=write or --phase=read.');
    exit(2);
  }
  if (dataDirectoryOption == null || dataDirectoryOption.trim().isEmpty) {
    stderr.writeln('Storage probe requires an absolute --data-dir path.');
    exit(2);
  }
  if (reportPathOption == null || reportPathOption.trim().isEmpty) {
    stderr.writeln('Storage probe requires an absolute --report path.');
    exit(2);
  }

  final phase = phaseOption;
  final dataDirectory = dataDirectoryOption;
  final reportPath = reportPathOption;
  final options = _ProbeOptions(
    phase: phase,
    dataDirectory: p.absolute(dataDirectory),
    reportPath: p.absolute(reportPath),
  );
  var reportPathValidated = false;
  try {
    await _validateProbePaths(options);
    reportPathValidated = true;
    if (phase == 'write') {
      await _runWritePhase(options);
    } else {
      await _runReadPhase(options);
      exit(0);
    }
  } catch (error) {
    if (reportPathValidated) {
      try {
        await _writeFailureReport(options, error);
      } catch (reportError) {
        stderr.writeln(
          'Storage probe failed and could not write its report: $reportError',
        );
        exit(1);
      }
    } else {
      stderr.writeln('Storage probe rejected its paths: $error');
      exit(2);
    }
    if (phase == 'read') {
      exit(1);
    }
  }
  return true;
}

Future<void> _runWritePhase(_ProbeOptions options) async {
  final imagePath = p.join(options.dataDirectory, '图片 素材', '探针作品.png');
  final imageFile = File(imagePath);
  await imageFile.parent.create(recursive: true);
  final pngBytes = _createProbePng();
  await imageFile.writeAsBytes(pngBytes, flush: true);
  final imageHash = sha256.convert(await imageFile.readAsBytes()).toString();

  final store = await openWorkspaceStore(directory: options.dataDirectory);
  var storeClosed = false;
  final closeFinished = Completer<bool>();

  DesktopLifecycle.install(() async {
    try {
      final data = _createFixture(imagePath, imageHash);
      final revision = await store.save(data, expectedRevision: 0);
      final persisted = await store.load();
      if (persisted == null || persisted.revision != revision) {
        throw StateError(
          'Saved workspace could not be reopened in the write process.',
        );
      }
      if (!_deepEquals(persisted.data, data)) {
        throw StateError(
          'The workspace changed during its write-process round trip.',
        );
      }
      final onDiskHash = sha256
          .convert(await imageFile.readAsBytes())
          .toString();
      if (onDiskHash != imageHash) {
        throw StateError('The Unicode-path PNG failed its SHA-256 check.');
      }

      await store.close();
      storeClosed = true;
      await _writeReport(options, <String, Object?>{
        'ok': true,
        'phase': options.phase,
        'databasePath': p.join(options.dataDirectory, 'workspace.sqlite'),
        'imagePath': imagePath,
        'imageSha256': imageHash,
        'revision': revision,
        'storeLabel': store.label,
      });
      if (!closeFinished.isCompleted) {
        closeFinished.complete(true);
      }
      return true;
    } catch (error) {
      if (!storeClosed) {
        try {
          await store.close();
          storeClosed = true;
        } catch (_) {
          // Keep the original failure as the probe result.
        }
      }
      await _writeFailureReport(options, error);
      if (!closeFinished.isCompleted) {
        closeFinished.complete(false);
      }
      return false;
    }
  });

  // A zero-size Flutter view starts the Dart platform channel without showing
  // probe UI. The native window is independently kept hidden by its probe flag.
  runApp(const SizedBox.shrink());

  try {
    final started = await _windowChannel
        .invokeMethod<bool>('probeClose')
        .timeout(_probeTimeout);
    if (started != true) {
      throw StateError('The native runner did not start the probe close.');
    }
    final accepted = await closeFinished.future.timeout(_probeTimeout);
    if (!accepted) {
      throw StateError(
        'The native runner rejected the close after save failure.',
      );
    }
  } catch (error) {
    if (!storeClosed) {
      try {
        await store.close();
        storeClosed = true;
      } catch (_) {
        // Preserve the channel/timeout failure in the report.
      }
    }
    await _writeFailureReport(options, error);
  }
}

Future<void> _runReadPhase(_ProbeOptions options) async {
  final databasePath = p.join(options.dataDirectory, 'workspace.sqlite');
  if (!await File(databasePath).exists()) {
    throw StateError('The write phase did not create workspace.sqlite.');
  }

  final imagePath = p.join(options.dataDirectory, '图片 素材', '探针作品.png');
  final imageFile = File(imagePath);
  if (!await imageFile.exists()) {
    throw StateError('The write phase did not create the Unicode-path PNG.');
  }
  final imageHash = sha256.convert(await imageFile.readAsBytes()).toString();

  final store = await openWorkspaceStore(directory: options.dataDirectory);
  var storeClosed = false;
  try {
    final persisted = await store.load();
    if (persisted == null || persisted.revision < 1) {
      throw StateError('The second process could not load a saved workspace.');
    }
    final expectedData = _createFixture(imagePath, imageHash);
    if (!_deepEquals(persisted.data, expectedData)) {
      throw StateError(
        'The second process did not restore all workspace values.',
      );
    }
    final storedImageHash = persisted.data['gallery'] is List
        ? (persisted.data['gallery'] as List).cast<Map>().first['sha256']
        : null;
    if (storedImageHash != imageHash) {
      throw StateError(
        'The persisted gallery hash does not match the PNG file.',
      );
    }

    await store.close();
    storeClosed = true;
    await _writeReport(options, <String, Object?>{
      'ok': true,
      'phase': options.phase,
      'databasePath': databasePath,
      'imagePath': imagePath,
      'imageSha256': imageHash,
      'revision': persisted.revision,
      'storeLabel': store.label,
    });
  } catch (_) {
    if (!storeClosed) {
      await store.close();
    }
    rethrow;
  }
}

Map<String, Object?> _createFixture(String imagePath, String imageHash) =>
    <String, Object?>{
      'draft': <String, Object?>{
        'id': 'probe-draft-001',
        'revision': 7,
        'prompt': '持久化探针：中文、空格与 emoji 🧪',
        'negativePrompt': 'synthetic fixture only',
        'strength': 0.625,
      },
      'gallery': <Map<String, Object?>>[
        <String, Object?>{
          'id': _probeGalleryId,
          'path': imagePath,
          'sha256': imageHash,
          'width': 2,
          'height': 2,
          'title': '绘世探针 - Unicode 图像',
          'tags': <String>['中文', 'space path', '🧪'],
        },
      ],
      'preferences': <String, Object?>{
        'theme': 'dark',
        'galleryColumns': 5,
        'showNsfw': false,
        'nested': <String, Object?>{'locale': 'zh-CN', 'scale': 1.25},
      },
      'editor': <String, Object?>{
        'zoom': 1.25,
        'panX': -14.5,
        'panY': 28.75,
        'mask': <int>[0, 2, 1, 3],
      },
      'selectedId': _probeGalleryId,
      'demoSequence': 42,
      'unknownProbeRootField': <String, Object?>{
        'survives': true,
        'value': '保留未知字段',
      },
    };

Future<void> _validateProbePaths(_ProbeOptions options) async {
  if (!p.isAbsolute(options.dataDirectory) ||
      !p.isAbsolute(options.reportPath)) {
    throw ArgumentError('Probe data and report paths must be absolute.');
  }

  final projectRoot = p.normalize(
    await Directory.current.resolveSymbolicLinks(),
  );
  final temporaryRoot = p.normalize(p.join(projectRoot, '.tmp'));
  final temporaryRootType = await FileSystemEntity.type(
    temporaryRoot,
    followLinks: false,
  );
  if (temporaryRootType == FileSystemEntityType.notFound) {
    await Directory(temporaryRoot).create(recursive: true);
  }
  final canonicalTemporaryRoot = p.normalize(
    await Directory(temporaryRoot).resolveSymbolicLinks(),
  );
  if (!p.isWithin(projectRoot, canonicalTemporaryRoot)) {
    throw ArgumentError(
      'The PC workspace .tmp directory resolves outside the workspace.',
    );
  }
  if (!p.isWithin(temporaryRoot, options.dataDirectory) ||
      !p.isWithin(temporaryRoot, p.dirname(options.reportPath))) {
    throw ArgumentError(
      'Probe data and reports must stay inside the PC workspace .tmp directory.',
    );
  }

  await _createDirectoryInside(canonicalTemporaryRoot, options.dataDirectory);
  final canonicalReportParent = await _createDirectoryInside(
    canonicalTemporaryRoot,
    p.dirname(options.reportPath),
  );
  final reportType = await FileSystemEntity.type(
    options.reportPath,
    followLinks: false,
  );
  if (reportType == FileSystemEntityType.link) {
    final canonicalReportFile = p.normalize(
      await File(options.reportPath).resolveSymbolicLinks(),
    );
    if (!p.isWithin(canonicalTemporaryRoot, canonicalReportFile)) {
      throw ArgumentError(
        'Probe reports must stay inside the PC workspace .tmp directory.',
      );
    }
  }
  if (!p.isWithin(canonicalTemporaryRoot, canonicalReportParent)) {
    throw ArgumentError(
      'Probe reports must stay inside the PC workspace .tmp directory.',
    );
  }
}

Future<String> _createDirectoryInside(String root, String path) async {
  if (!p.isWithin(root, path)) {
    throw ArgumentError('Refusing to create a directory outside .tmp: $path');
  }

  final relativePath = p.relative(path, from: root);
  var current = root;
  for (final component in p.split(relativePath)) {
    if (component.isEmpty || component == '.') {
      continue;
    }
    current = p.join(current, component);
    final entityType = await FileSystemEntity.type(current, followLinks: false);
    if (entityType == FileSystemEntityType.notFound) {
      await Directory(current).create();
    } else if (entityType == FileSystemEntityType.file) {
      throw FileSystemException('Expected a directory', current);
    }

    current = p.normalize(await Directory(current).resolveSymbolicLinks());
    if (!p.isWithin(root, current)) {
      throw ArgumentError('Refusing to follow a directory outside .tmp: $path');
    }
  }
  return current;
}

String? _readOption(List<String> args, String name) {
  final prefix = '$name=';
  for (var index = 0; index < args.length; index++) {
    final argument = args[index];
    if (argument.startsWith(prefix)) {
      return argument.substring(prefix.length);
    }
    if (argument == name && index + 1 < args.length) {
      return args[index + 1];
    }
  }
  return null;
}

Future<void> _writeFailureReport(_ProbeOptions options, Object error) async {
  await _writeReport(options, <String, Object?>{
    'ok': false,
    'phase': options.phase,
    'databasePath': p.join(options.dataDirectory, 'workspace.sqlite'),
    'error': '${error.runtimeType}: $error',
  });
}

Future<void> _writeReport(
  _ProbeOptions options,
  Map<String, Object?> report,
) async {
  await File(options.reportPath).writeAsString(
    const JsonEncoder.withIndent('  ').convert(report),
    flush: true,
  );
}

Uint8List _createProbePng() {
  const pngSignature = <int>[137, 80, 78, 71, 13, 10, 26, 10];
  final rawPixels = <int>[
    0,
    0xff,
    0x1f,
    0x73,
    0xff,
    0x29,
    0xb7,
    0x66,
    0xff,
    0,
    0x21,
    0x66,
    0xcc,
    0xff,
    0xf5,
    0xd5,
    0x7a,
    0xff,
  ];
  final header = ByteData(13)
    ..setUint32(0, 2, Endian.big)
    ..setUint32(4, 2, Endian.big)
    ..setUint8(8, 8)
    ..setUint8(9, 6)
    ..setUint8(10, 0)
    ..setUint8(11, 0)
    ..setUint8(12, 0);
  final compressedPixels = ZLibEncoder().convert(rawPixels);

  final output = BytesBuilder(copy: false)..add(pngSignature);
  _addPngChunk(output, 'IHDR', header.buffer.asUint8List());
  _addPngChunk(output, 'IDAT', compressedPixels);
  _addPngChunk(output, 'IEND', const <int>[]);
  return output.takeBytes();
}

void _addPngChunk(BytesBuilder output, String type, List<int> data) {
  final typeBytes = ascii.encode(type);
  output.add(_uint32Bytes(data.length));
  output.add(typeBytes);
  output.add(data);
  output.add(_uint32Bytes(_crc32(<int>[...typeBytes, ...data])));
}

List<int> _uint32Bytes(int value) =>
    (ByteData(4)..setUint32(0, value, Endian.big)).buffer.asUint8List();

int _crc32(List<int> bytes) {
  var crc = 0xffffffff;
  for (final byte in bytes) {
    crc ^= byte;
    for (var bit = 0; bit < 8; bit++) {
      crc = (crc & 1) == 1 ? (crc >> 1) ^ 0xedb88320 : crc >> 1;
    }
  }
  return (crc ^ 0xffffffff) & 0xffffffff;
}

bool _deepEquals(Object? left, Object? right) {
  if (identical(left, right)) {
    return true;
  }
  if (left is Map && right is Map) {
    if (left.length != right.length) {
      return false;
    }
    for (final key in left.keys) {
      if (!right.containsKey(key) || !_deepEquals(left[key], right[key])) {
        return false;
      }
    }
    return true;
  }
  if (left is List && right is List) {
    if (left.length != right.length) {
      return false;
    }
    for (var index = 0; index < left.length; index++) {
      if (!_deepEquals(left[index], right[index])) {
        return false;
      }
    }
    return true;
  }
  return left == right;
}

class _ProbeOptions {
  const _ProbeOptions({
    required this.phase,
    required this.dataDirectory,
    required this.reportPath,
  });

  final String phase;
  final String dataDirectory;
  final String reportPath;
}

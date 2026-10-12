import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:path/path.dart' as p;

import 'image_asset.dart';
import 'image_asset_store_contract.dart';
import 'image_asset_store_serial.dart';
import 'image_asset_validation.dart';

/// Opens the persistent file-backed image store under the workspace data dir.
///
/// The directory precedence matches `openWorkspaceStore`: explicit argument,
/// environment variable, compile-time directory, then Windows LOCALAPPDATA.
Future<ImageAssetStore> openImageAssetStore({
  String? directory,
  int maximumImageBytes = defaultMaximumImageBytes,
}) async {
  validateMaximumImageBytes(maximumImageBytes);
  final dataDirectory = await _resolveDataDirectory(directory);
  await Directory(dataDirectory).create(recursive: true);

  final assetDirectory = p.absolute(p.join(dataDirectory, 'image_assets'));
  await _ensureDirectory(assetDirectory);
  final canonicalAssetDirectory = await Directory(assetDirectory)
      .resolveSymbolicLinks();
  return _FileImageAssetStore(
    assetDirectory: assetDirectory,
    canonicalAssetDirectory: canonicalAssetDirectory,
    maximumImageBytes: maximumImageBytes,
  );
}

class _FileImageAssetStore extends SerializedImageAssetStore {
  _FileImageAssetStore({
    required this.assetDirectory,
    required this.canonicalAssetDirectory,
    required this.maximumImageBytes,
  });

  final String assetDirectory;
  final String canonicalAssetDirectory;
  final int maximumImageBytes;
  final Random _random = Random.secure();

  @override
  String get label => '图片文件（image_assets）';

  @override
  Future<ImageAsset> save(Uint8List bytes) async {
    final validated = await validateImageAssetBytes(
      bytes,
      maximumBytes: maximumImageBytes,
    );
    return runSerialized(() => _saveValidated(validated));
  }

  @override
  Future<Uint8List> read(String assetRef) async {
    final ref = parseImageAssetRef(assetRef);
    return runSerialized(() => _readRef(ref));
  }

  @override
  Future<void> closeResources() async {}

  Future<ImageAsset> _saveValidated(ValidatedImageAsset validated) async {
    final ref = parseImageAssetRef(validated.asset.assetRef);
    final path = await _assetPath(ref, createDirectories: true);
    final target = File(path);
    final existingType = await FileSystemEntity.type(path, followLinks: false);
    if (existingType != FileSystemEntityType.notFound) {
      if (existingType != FileSystemEntityType.file) {
        throw const ImageAssetIntegrityException(
          'The content-addressed image path is occupied by a non-file.',
        );
      }
      final existing = await _readFile(target, ref);
      if (!imageBytesEqual(existing, validated.bytes)) {
        throw const ImageAssetIntegrityException(
          'A different image already occupies this SHA-256 path.',
        );
      }
      return validated.asset;
    }

    final temporary = await _createTemporaryFile(p.dirname(path), ref.sha256);
    try {
      await temporary.writeAsBytes(validated.bytes, flush: true);
      try {
        await temporary.rename(path);
      } on FileSystemException catch (error) {
        // Another process may have published the same content after our check.
        final racedType = await FileSystemEntity.type(path, followLinks: false);
        if (racedType != FileSystemEntityType.file) {
          throw ImageAssetStoreException(
            'The image could not be atomically published.',
            cause: error,
          );
        }
        final existing = await _readFile(target, ref);
        if (!imageBytesEqual(existing, validated.bytes)) {
          throw const ImageAssetIntegrityException(
            'A different image already occupies this SHA-256 path.',
          );
        }
      }
      return validated.asset;
    } on ImageAssetStoreException {
      rethrow;
    } on FileSystemException catch (error) {
      throw ImageAssetStoreException(
        'The image could not be saved to the asset directory.',
        cause: error,
      );
    } finally {
      await _deleteOwnedTemporaryFile(temporary);
    }
  }

  Future<Uint8List> _readRef(ImageAssetRef ref) async {
    final path = await _assetPath(ref, createDirectories: false);
    final type = await FileSystemEntity.type(path, followLinks: false);
    if (type == FileSystemEntityType.notFound) {
      throw ImageAssetNotFoundException(ref.value);
    }
    if (type != FileSystemEntityType.file) {
      throw const ImageAssetIntegrityException(
        'The image asset path is not a regular file.',
      );
    }
    return _readFile(File(path), ref);
  }

  Future<Uint8List> _readFile(File file, ImageAssetRef ref) async {
    final bytes = BytesBuilder(copy: false);
    var totalBytes = 0;
    try {
      await for (final chunk in file.openRead()) {
        totalBytes += chunk.length;
        if (totalBytes > maximumImageBytes) {
          throw ImageAssetIntegrityException(
            'Stored image exceeds the $maximumImageBytes byte limit.',
          );
        }
        bytes.add(chunk);
      }
    } on ImageAssetIntegrityException {
      rethrow;
    } on FileSystemException catch (error) {
      throw ImageAssetStoreException(
        'The image could not be read from the asset directory.',
        cause: error,
      );
    }

    final result = bytes.takeBytes();
    verifyStoredAsset(result, ref, maximumBytes: maximumImageBytes);
    return Uint8List.fromList(result);
  }

  Future<String> _assetPath(
    ImageAssetRef ref, {
    required bool createDirectories,
  }) async {
    var currentDirectory = assetDirectory;
    for (final segment in <String>['sha256', ref.sha256.substring(0, 2)]) {
      currentDirectory = p.join(currentDirectory, segment);
      final type = await FileSystemEntity.type(
        currentDirectory,
        followLinks: false,
      );
      if (type == FileSystemEntityType.notFound) {
        if (!createDirectories) {
          return p.join(currentDirectory, '${ref.sha256}.${ref.extension}');
        }
        await Directory(currentDirectory).create();
      } else if (type != FileSystemEntityType.directory) {
        throw const ImageAssetIntegrityException(
          'An image asset directory is not a regular directory.',
        );
      }

      final canonicalDirectory = await Directory(currentDirectory)
          .resolveSymbolicLinks();
      if (!_isWithinManagedDirectory(canonicalDirectory)) {
        throw const ImageAssetIntegrityException(
          'An image asset directory resolves outside its managed directory.',
        );
      }
    }
    return p.join(currentDirectory, '${ref.sha256}.${ref.extension}');
  }

  bool _isWithinManagedDirectory(String path) {
    final normalizedPath = p.normalize(p.absolute(path));
    final normalizedRoot = p.normalize(p.absolute(canonicalAssetDirectory));
    if (Platform.isWindows) {
      final candidate = normalizedPath.toLowerCase();
      final root = normalizedRoot.toLowerCase();
      return candidate == root || p.isWithin(root, candidate);
    }
    return normalizedPath == normalizedRoot ||
        p.isWithin(normalizedRoot, normalizedPath);
  }

  Future<File> _createTemporaryFile(String directory, String digest) async {
    for (var attempt = 0; attempt < 8; attempt++) {
      final suffix = _random.nextInt(1 << 32).toRadixString(16).padLeft(8, '0');
      final file = File(p.join(directory, '.${digest}_$suffix.part'));
      try {
        await file.create(exclusive: true);
        return file;
      } on FileSystemException {
        if (attempt == 7) rethrow;
      }
    }
    throw const ImageAssetStoreException(
      'Could not allocate a temporary image file.',
    );
  }

  Future<void> _deleteOwnedTemporaryFile(File file) async {
    try {
      final type = await FileSystemEntity.type(file.path, followLinks: false);
      if (type == FileSystemEntityType.file) await file.delete();
    } on FileSystemException {
      // Temporary cleanup must not hide the save result.
    }
  }
}

Future<void> _ensureDirectory(String path) async {
  var type = await FileSystemEntity.type(path, followLinks: false);
  if (type == FileSystemEntityType.notFound) {
    await Directory(path).create();
    type = await FileSystemEntity.type(path, followLinks: false);
  }
  if (type != FileSystemEntityType.directory) {
    throw ImageAssetStoreException(
      'The managed image asset path is not a regular directory: $path',
    );
  }
}

Future<String> _resolveDataDirectory(String? explicitDirectory) async {
  if (explicitDirectory != null) {
    if (explicitDirectory.trim().isEmpty) {
      throw ArgumentError.value(
        explicitDirectory,
        'directory',
        'Must not be empty.',
      );
    }
    return p.absolute(explicitDirectory);
  }

  final environmentDirectory = Platform.environment['WORLDPAINTER_DATA_DIR'];
  if (environmentDirectory != null && environmentDirectory.trim().isNotEmpty) {
    return p.absolute(environmentDirectory);
  }

  const compileTimeDirectoryBase64 = String.fromEnvironment(
    'WORLDPAINTER_DATA_DIR_BASE64',
  );
  if (compileTimeDirectoryBase64.trim().isNotEmpty) {
    try {
      final decodedDirectory = utf8.decode(
        base64.decode(compileTimeDirectoryBase64),
      );
      if (decodedDirectory.trim().isEmpty) {
        throw StateError(
          'WORLDPAINTER_DATA_DIR_BASE64 decoded to an empty path.',
        );
      }
      return p.absolute(decodedDirectory);
    } on FormatException catch (error) {
      throw StateError(
        'WORLDPAINTER_DATA_DIR_BASE64 is not valid UTF-8 base64: $error',
      );
    }
  }

  const compileTimeDirectory = String.fromEnvironment('WORLDPAINTER_DATA_DIR');
  if (compileTimeDirectory.trim().isNotEmpty) {
    return p.absolute(compileTimeDirectory);
  }

  final localAppData = Platform.environment['LOCALAPPDATA'];
  if (localAppData == null || localAppData.trim().isEmpty) {
    throw StateError('Windows LOCALAPPDATA is unavailable.');
  }
  return p.absolute(p.join(localAppData, 'WorldPainter', 'PC'));
}

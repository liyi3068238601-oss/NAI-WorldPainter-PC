import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
import 'package:worldpainter_pc/media/image_asset_store.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Directory testRoot;
  late Directory dataDirectory;

  setUp(() async {
    testRoot = Directory(
      p.join(Directory.current.path, '.tmp', 'image-asset-maintenance-tests'),
    );
    await testRoot.create(recursive: true);
    dataDirectory = await testRoot.createTemp('worldpainter-assets-');
  });

  tearDown(() async {
    await _deleteTemporaryDirectorySafely(testRoot, dataDirectory);
  });

  test('lists and removes only valid managed references', () async {
    final store = await openImageAssetStore(directory: dataDirectory.path);
    final maintenance = store as ImageAssetMaintenance;
    final asset = await store.save(_createTwoByTwoPng(0xff336699));
    final outside = File(p.join(dataDirectory.path, 'outside.png'));
    await outside.writeAsBytes(_createTwoByTwoPng(0xffcc8844));
    final managedRoot = Directory(
      p.join(dataDirectory.path, 'image_assets', 'sha256'),
    );
    await File(p.join(managedRoot.path, 'not-a-sha-directory.png'))
        .writeAsBytes(<int>[1]);
    await File(
      p.join(managedRoot.path, asset.sha256.substring(0, 2), 'notes.txt'),
    ).writeAsBytes(<int>[2]);

    expect(await maintenance.listAssets(), <String>[asset.assetRef]);
    await expectLater(
      maintenance.removeAsset('../outside.png'),
      throwsA(isA<ImageAssetValidationException>()),
    );
    expect(await outside.exists(), isTrue);

    await maintenance.removeAsset(asset.assetRef);
    await maintenance.removeAsset(asset.assetRef);
    expect(await maintenance.listAssets(), isEmpty);
    await expectLater(
      store.read(asset.assetRef),
      throwsA(isA<ImageAssetNotFoundException>()),
    );
    await store.close();
  });

  test('collects exact references through nested snapshot values', () async {
    final store = await openImageAssetStore(directory: dataDirectory.path);
    final maintenance = store as ImageAssetMaintenance;
    final shared = await store.save(_createTwoByTwoPng(0xff173a5c));
    final unused = await store.save(_createTwoByTwoPng(0xffd5a12b));
    final missingDigest = List<String>.filled(64, 'd').join();
    final missingRef = 'sha256/dd/$missingDigest.png';
    final malformedDigest = List<String>.filled(64, 'a').join();
    final snapshot = <String, Object?>{
      'gallery': <Object?>[
        <String, Object?>{'assetRef': shared.assetRef},
      ],
      'session': <String, Object?>{
        'parameters': <String, Object?>{'sourceImageId': shared.assetRef},
        'parent': <String, Object?>{'assetRef': shared.assetRef},
        'candidates': <Object?>[
          <String, Object?>{'resultAssetRef': shared.assetRef},
        ],
      },
      'library': <String, Object?>{
        'source': <String, Object?>{'image': shared.assetRef},
      },
      'missing': missingRef,
      'malformed': <String>[
        'sha256/../outside.png',
        'sha256/$malformedDigest.png',
        'C:\\private\\image.png',
      ],
    };

    expect(collectImageAssetReferences(snapshot), <String>{
      shared.assetRef,
      missingRef,
    });

    final audit = await auditImageAssets(snapshot: snapshot, store: store);
    expect(audit.referencedRefs, <String>{shared.assetRef, missingRef});
    expect(audit.storedRefs, <String>{shared.assetRef, unused.assetRef});
    expect(audit.missingReferences, <String>{missingRef});
    expect(audit.corruptAssets, isEmpty);
    expect(audit.unusedAssets, <String>{unused.assetRef});

    // Repeated references in independent snapshot locations do not make a
    // shared asset look unused or trigger implicit removal.
    expect(await store.read(shared.assetRef), isNotEmpty);
    expect((await maintenance.listAssets()).length, 2);
    await store.close();
  });

  test(
    'audit reports bytes that fail the stored hash check as corrupt',
    () async {
      final store = await openImageAssetStore(directory: dataDirectory.path);
      final asset = await store.save(_createTwoByTwoPng(0xff7194b7));
      final path = p.joinAll(<String>[
        dataDirectory.path,
        'image_assets',
        ...asset.assetRef.split('/'),
      ]);
      await File(path).writeAsBytes(<int>[1, 2, 3, 4]);

      final audit = await auditImageAssets(
        snapshot: <String, Object?>{'assetRef': asset.assetRef},
        store: store,
      );
      expect(audit.corruptAssets, <String>{asset.assetRef});
      expect(audit.missingReferences, isEmpty);
      await store.close();
    },
  );

  test('does not list, read, or remove a symbolic link as an asset', () async {
    final store = await openImageAssetStore(directory: dataDirectory.path);
    final maintenance = store as ImageAssetMaintenance;
    final asset = await store.save(_createTwoByTwoPng(0xff197753));
    final managedPath = p.joinAll(<String>[
      dataDirectory.path,
      'image_assets',
      ...asset.assetRef.split('/'),
    ]);
    final external = File(p.join(dataDirectory.path, 'external.png'));
    await external.writeAsBytes(_createTwoByTwoPng(0xffab4567));
    await File(managedPath).delete();

    try {
      await Link(managedPath).create(external.path);
    } on FileSystemException catch (error) {
      // Windows may deny symlink creation when Developer Mode or the required
      // privilege is unavailable. Keep the test usable on those machines.
      if (!Platform.isWindows) rethrow;
      // ignore: avoid_print
      print('Symlink assertions skipped: ${error.message}');
      await store.close();
      return;
    }

    expect(await maintenance.listAssets(), isEmpty);
    await expectLater(
      store.read(asset.assetRef),
      throwsA(isA<ImageAssetIntegrityException>()),
    );
    await expectLater(
      maintenance.removeAsset(asset.assetRef),
      throwsA(isA<ImageAssetIntegrityException>()),
    );
    expect(await external.exists(), isTrue);
    await store.close();
  });
}

Future<void> _deleteTemporaryDirectorySafely(
  Directory root,
  Directory target,
) async {
  if (!await target.exists()) return;

  final canonicalRoot = p.normalize(await root.resolveSymbolicLinks());
  final canonicalTarget = p.normalize(await target.resolveSymbolicLinks());
  if (p.equals(canonicalRoot, canonicalTarget) ||
      !p.isWithin(canonicalRoot, canonicalTarget)) {
    throw StateError('Refusing to remove a path outside the test temp root.');
  }
  await Directory(canonicalTarget).delete(recursive: true);
}

Uint8List _createTwoByTwoPng(int color) {
  const pngSignature = <int>[137, 80, 78, 71, 13, 10, 26, 10];
  final red = (color >> 16) & 0xff;
  final green = (color >> 8) & 0xff;
  final blue = color & 0xff;
  final rawPixels = <int>[
    0,
    red,
    green,
    blue,
    0xff,
    red,
    green,
    blue,
    0xff,
    0,
    red,
    green,
    blue,
    0xff,
    red,
    green,
    blue,
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
  final output = BytesBuilder(copy: false)..add(pngSignature);
  _addPngChunk(output, 'IHDR', header.buffer.asUint8List());
  _addPngChunk(output, 'IDAT', ZLibEncoder().convert(rawPixels));
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

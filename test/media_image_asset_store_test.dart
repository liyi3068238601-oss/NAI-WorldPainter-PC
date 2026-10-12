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
    testRoot = Directory(p.join(Directory.current.path, '.tmp', 'media-tests'));
    await testRoot.create(recursive: true);
    dataDirectory = await testRoot.createTemp('worldpainter-image-assets-');
  });

  tearDown(() async {
    await _deleteTemporaryDirectorySafely(testRoot, dataDirectory);
  });

  test(
    'saves original bytes, deduplicates, and reads after reopening',
    () async {
      final bytes = _createTwoByTwoPng();
      final store = await openImageAssetStore(directory: dataDirectory.path);
      final asset = await store.save(bytes);

      expect(asset.id, asset.sha256);
      expect(
        asset.assetRef,
        matches(RegExp(r'^sha256/[0-9a-f]{2}/[0-9a-f]{64}\.png$')),
      );
      expect(asset.assetRef, contains(asset.sha256));
      expect(asset.width, 2);
      expect(asset.height, 2);
      expect(asset.mime, 'image/png');
      expect(asset.byteLength, bytes.length);
      expect(asset.toJson()['assetRef'], asset.assetRef);
      await store.close();

      final reopened = await openImageAssetStore(directory: dataDirectory.path);
      final restored = await reopened.read(asset.assetRef);
      expect(_bytesEqual(restored, bytes), isTrue);

      final duplicate = await reopened.save(bytes);
      expect(duplicate.id, asset.id);
      expect(duplicate.assetRef, asset.assetRef);
      expect(duplicate.byteLength, asset.byteLength);
      await reopened.close();
    },
  );

  test('rejects invalid bytes and references', () async {
    final store = await openImageAssetStore(directory: dataDirectory.path);
    await expectLater(
      store.save(Uint8List.fromList(<int>[1, 2, 3, 4])),
      throwsA(isA<ImageAssetValidationException>()),
    );
    await expectLater(
      store.read('../outside.png'),
      throwsA(isA<ImageAssetValidationException>()),
    );
    await store.close();
  });

  test('enforces the configured image byte limit', () async {
    final bytes = _createTwoByTwoPng();
    final store = await openImageAssetStore(
      directory: dataDirectory.path,
      maximumImageBytes: bytes.length - 1,
    );
    await expectLater(
      store.save(bytes),
      throwsA(isA<ImageAssetValidationException>()),
    );
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

Uint8List _createTwoByTwoPng() {
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

bool _bytesEqual(List<int> left, List<int> right) {
  if (left.length != right.length) return false;
  for (var index = 0; index < left.length; index++) {
    if (left[index] != right[index]) return false;
  }
  return true;
}

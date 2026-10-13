import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:worldpainter_pc/media/image_asset_store_contract.dart';
import 'package:worldpainter_pc/media/image_asset_validation.dart';
import 'package:worldpainter_pc/platform/image_export.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('preserves valid PNG bytes and verifies its dimensions', () async {
    final png = await _createPng(8, 6);
    final original = Uint8List.fromList(png);

    final exported = await preparePngExportBytes(png);

    expect(exported, original);
    expect(detectImageFormat(exported), 'PNG');
    final validated = await validateImageAssetBytes(exported);
    expect((validated.asset.width, validated.asset.height), (8, 6));
  });

  test(
    'converts JPEG bytes to a valid PNG without changing the source',
    () async {
      final jpeg = base64Decode(_jpeg);
      final original = Uint8List.fromList(jpeg);

      final exported = await preparePngExportBytes(jpeg);

      expect(jpeg, original);
      expect(detectImageFormat(exported), 'PNG');
      final validated = await validateImageAssetBytes(exported);
      expect((validated.asset.width, validated.asset.height), (8, 8));
      expect(await _firstPixel(exported), await _firstPixel(jpeg));
    },
  );

  test(
    'converts WebP bytes to a valid PNG without changing the source',
    () async {
      final webp = base64Decode(_webp);
      final original = Uint8List.fromList(webp);

      final exported = await preparePngExportBytes(webp);

      expect(webp, original);
      expect(detectImageFormat(exported), 'PNG');
      final validated = await validateImageAssetBytes(exported);
      expect((validated.asset.width, validated.asset.height), (8, 8));
      expect(await _firstPixel(exported), await _firstPixel(webp));
    },
  );

  test('rejects truncated or unsupported image data', () async {
    await expectLater(
      preparePngExportBytes(Uint8List.fromList(_pngSignature)),
      throwsA(
        isA<ImageAssetValidationException>().having(
          (error) => error.message,
          'message',
          contains('incomplete IHDR'),
        ),
      ),
    );
    await expectLater(
      preparePngExportBytes(Uint8List.fromList(<int>[1, 2, 3, 4])),
      throwsA(isA<ImageAssetValidationException>()),
    );
    await expectLater(
      preparePngExportBytes(_pngWithInvalidPayload()),
      throwsA(
        isA<ImageAssetValidationException>().having(
          (error) => error.message,
          'message',
          contains('could not be decoded'),
        ),
      ),
    );
  });

  test(
    'enforces image dimension and pixel-count limits before decoding',
    () async {
      await expectLater(
        preparePngExportBytes(_pngHeader(32769, 1)),
        throwsA(
          isA<ImageAssetValidationException>().having(
            (error) => error.message,
            'message',
            contains('32768 pixels per side'),
          ),
        ),
      );
      await expectLater(
        preparePngExportBytes(_pngHeader(12000, 10000)),
        throwsA(
          isA<ImageAssetValidationException>().having(
            (error) => error.message,
            'message',
            contains('100000000 pixels'),
          ),
        ),
      );
    },
  );

  test('keeps the 64 MiB input limit', () async {
    final oversized = Uint8List(defaultMaximumImageBytes + 1);

    await expectLater(
      preparePngExportBytes(oversized),
      throwsA(isA<FormatException>()),
    );
  });

  test('sanitizes the PNG filename and bounds its length', () {
    expect(sanitizePngExportFileName('art:work.jpg'), 'art_work.png');
    expect(sanitizePngExportFileName('nUl.webp'), '_nUl.png');
    expect(sanitizePngExportFileName('CON.foo.jpg'), '_CON.foo.png');
    expect(sanitizePngExportFileName('CoM1.preview.jpg'), '_CoM1.preview.png');
    expect(sanitizePngExportFileName('...  '), '绘世-结果.png');
    expect(sanitizePngExportFileName('a' * 200), '${'a' * 140}.png');
    expect(
      sanitizePngExportFileName('C:\\Users\\art?.jpeg'),
      'C__Users_art_.png',
    );
  });

  test(
    'sends JPEG and WebP results as validated PNG bytes to the Windows channel',
    skip: !Platform.isWindows,
    () async {
      const channel = MethodChannel('worldpainter/files');
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      final calls = <MethodCall>[];
      messenger.setMockMethodCallHandler(channel, (call) async {
        calls.add(call);
        return true;
      });
      addTearDown(() => messenger.setMockMethodCallHandler(channel, null));

      expect(
        await exportImage(base64Decode(_jpeg), suggestedName: 'CON.foo.jpg'),
        isTrue,
      );
      expect(
        await exportImage(base64Decode(_webp), suggestedName: 'art:work.webp'),
        isTrue,
      );

      expect(calls, hasLength(2));
      expect(calls.map((call) => call.method), everyElement('savePng'));
      final jpegArguments = calls[0].arguments as Map<Object?, Object?>;
      final webpArguments = calls[1].arguments as Map<Object?, Object?>;
      expect(jpegArguments['suggestedName'], '_CON.foo.png');
      expect(webpArguments['suggestedName'], 'art_work.png');

      final jpegPng = jpegArguments['bytes'] as Uint8List;
      final webpPng = webpArguments['bytes'] as Uint8List;
      expect(detectImageFormat(jpegPng), 'PNG');
      expect(detectImageFormat(webpPng), 'PNG');
      final jpegAsset = await validateImageAssetBytes(jpegPng);
      final webpAsset = await validateImageAssetBytes(webpPng);
      expect((jpegAsset.asset.width, jpegAsset.asset.height), (8, 8));
      expect((webpAsset.asset.width, webpAsset.asset.height), (8, 8));
    },
  );

  test(
    'returns false when the Windows PNG save channel cancels',
    skip: !Platform.isWindows,
    () async {
      const channel = MethodChannel('worldpainter/files');
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(channel, (_) async => false);
      addTearDown(() => messenger.setMockMethodCallHandler(channel, null));

      expect(await exportImage(base64Decode(_jpeg)), isFalse);
    },
  );

  test(
    'rejects invalid image bytes before calling the Windows channel',
    skip: !Platform.isWindows,
    () async {
      const channel = MethodChannel('worldpainter/files');
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      var callCount = 0;
      messenger.setMockMethodCallHandler(channel, (_) async {
        callCount++;
        return true;
      });
      addTearDown(() => messenger.setMockMethodCallHandler(channel, null));

      await expectLater(
        exportImage(Uint8List.fromList(<int>[1, 2, 3, 4])),
        throwsA(isA<ImageAssetValidationException>()),
      );
      expect(callCount, 0);
    },
  );
}

Future<Uint8List> _createPng(int width, int height) async {
  final recorder = ui.PictureRecorder();
  final canvas = ui.Canvas(recorder);
  canvas.drawRect(
    ui.Rect.fromLTWH(0, 0, width.toDouble(), height.toDouble()),
    ui.Paint()..color = const ui.Color(0xff2850a0),
  );
  final picture = recorder.endRecording();
  final image = await picture.toImage(width, height);
  try {
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    return Uint8List.fromList(
      bytes!.buffer.asUint8List(bytes.offsetInBytes, bytes.lengthInBytes),
    );
  } finally {
    image.dispose();
    picture.dispose();
  }
}

Future<(int, int, int, int)> _firstPixel(Uint8List bytes) async {
  final codec = await ui.instantiateImageCodec(bytes);
  try {
    final image = (await codec.getNextFrame()).image;
    try {
      final rgba = await image.toByteData(format: ui.ImageByteFormat.rawRgba);
      return (
        rgba!.getUint8(0),
        rgba.getUint8(1),
        rgba.getUint8(2),
        rgba.getUint8(3),
      );
    } finally {
      image.dispose();
    }
  } finally {
    codec.dispose();
  }
}

Uint8List _pngHeader(int width, int height) {
  final bytes = Uint8List(24);
  bytes.setRange(0, _pngSignature.length, _pngSignature);
  bytes.setRange(12, 16, 'IHDR'.codeUnits);
  ByteData.sublistView(bytes)
    ..setUint32(8, 13, Endian.big)
    ..setUint32(16, width, Endian.big)
    ..setUint32(20, height, Endian.big);
  return bytes;
}

Uint8List _pngWithInvalidPayload() {
  final ihdr = ByteData(13)
    ..setUint32(0, 8, Endian.big)
    ..setUint32(4, 8, Endian.big)
    ..setUint8(8, 8)
    ..setUint8(9, 6)
    ..setUint8(10, 0)
    ..setUint8(11, 0)
    ..setUint8(12, 0);
  final output = BytesBuilder(copy: false)..add(_pngSignature);
  _addPngChunk(output, 'IHDR', ihdr.buffer.asUint8List());
  _addPngChunk(output, 'IDAT', const <int>[0, 1, 2, 3]);
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

Uint8List _uint32Bytes(int value) =>
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

const _pngSignature = <int>[137, 80, 78, 71, 13, 10, 26, 10];

// Synthetic 8x8 JPEG fixture.
const _jpeg =
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAIAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDjKKKK+qPHP//Z';

// Synthetic 8x8 lossless WebP fixture.
const _webp = 'UklGRh4AAABXRUJQVlA4TBEAAAAvB8ABAAdQqKIUtP+BiOh/AAA=';

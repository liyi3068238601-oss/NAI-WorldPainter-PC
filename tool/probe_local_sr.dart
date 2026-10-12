import 'dart:io';
import 'dart:typed_data';

import 'package:worldpainter_pc/processing/local_sr.dart';
import 'package:worldpainter_pc/processing/postprocess_parameters.dart';

Future<void> main() async {
  const width = 64;
  const height = 64;
  final source = _syntheticPng(width, height);
  final superResolution = createLocalSuperResolution();
  final info = superResolution.info;
  if (!info.isAvailable ||
      !info.availableModels.containsAll(PostprocessParameters.localSrModels)) {
    stderr.writeln('Local SR runtime is incomplete.');
    exitCode = 2;
    return;
  }

  for (final preset in const <(String, double)>[
    ('realesrganAnime4x', 4),
    ('realcuganConservative2x', 2),
    ('realcuganConservative4x', 4),
  ]) {
    final parameters = PostprocessParameters(
      operation: PostprocessOperation.localSr,
      sourceAssetRef: 'synthetic-probe',
      width: width,
      height: height,
      model: preset.$1,
      scale: preset.$2,
    );
    final output = await superResolution.upscale(
      parameters,
      sourceBytes: source,
    );
    stdout.writeln(
      '${preset.$1}: ${output.length} bytes, validated dimensions',
    );
  }
  stdout.writeln('Local SR synthetic probe passed.');
}

Uint8List _syntheticPng(int width, int height) {
  final scanlines = BytesBuilder(copy: false);
  for (var y = 0; y < height; y++) {
    scanlines.addByte(0); // PNG filter: None.
    for (var x = 0; x < width; x++) {
      final checker = ((x ~/ 8) + (y ~/ 8)) % 2 == 0;
      scanlines.add(<int>[
        checker ? 220 : 25,
        (x * 4) & 0xff,
        (y * 4) & 0xff,
        255,
      ]);
    }
  }

  final header = ByteData(13)
    ..setUint32(0, width)
    ..setUint32(4, height)
    ..setUint8(8, 8) // 8 bits per channel.
    ..setUint8(9, 6) // RGBA.
    ..setUint8(10, 0)
    ..setUint8(11, 0)
    ..setUint8(12, 0);
  final output = BytesBuilder(copy: false)
    ..add(const <int>[137, 80, 78, 71, 13, 10, 26, 10])
    ..add(_pngChunk('IHDR', header.buffer.asUint8List()))
    ..add(
      _pngChunk(
        'IDAT',
        Uint8List.fromList(ZLibEncoder().convert(scanlines.takeBytes())),
      ),
    )
    ..add(_pngChunk('IEND', Uint8List(0)));
  return output.takeBytes();
}

Uint8List _pngChunk(String type, Uint8List data) {
  final typeBytes = Uint8List.fromList(type.codeUnits);
  final chunk = BytesBuilder(copy: false)
    ..add(_uint32(data.length))
    ..add(typeBytes)
    ..add(data);
  final crcInput = Uint8List.fromList(<int>[...typeBytes, ...data]);
  chunk.add(_uint32(_crc32(crcInput)));
  return chunk.takeBytes();
}

Uint8List _uint32(int value) {
  final bytes = ByteData(4)..setUint32(0, value);
  return bytes.buffer.asUint8List();
}

int _crc32(Uint8List bytes) {
  var crc = 0xffffffff;
  for (final byte in bytes) {
    crc ^= byte;
    for (var bit = 0; bit < 8; bit++) {
      crc = (crc & 1) == 1 ? (crc >> 1) ^ 0xedb88320 : crc >> 1;
    }
  }
  return (crc ^ 0xffffffff) & 0xffffffff;
}

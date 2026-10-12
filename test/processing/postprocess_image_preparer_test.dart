import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter_test/flutter_test.dart';
import 'package:worldpainter_pc/processing/postprocess_image_preparer.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test(
    'reads dimensions from the decoded frame for tiled-sized PNGs',
    () async {
      final png = await _solidPng(1536, 1024);

      expect(await decodePostprocessImageDimensions(png), (1536, 1024));
    },
  );

  test(
    'Enhance preparation can resize an input above its intrinsic size',
    () async {
      final png = await _solidPng(64, 64);

      final prepared = await prepareEnhanceInput(
        bytes: png,
        sourceWidth: 64,
        sourceHeight: 64,
        scale: 2,
        upscaledEnhance: false,
      );

      expect((prepared.width, prepared.height), (128, 128));
      expect(await decodePostprocessImageDimensions(prepared.bytes), (
        128,
        128,
      ));
    },
  );
}

Future<Uint8List> _solidPng(int width, int height) async {
  final pixels = Uint8List(width * height * 4);
  for (var offset = 0; offset < pixels.length; offset += 4) {
    pixels[offset] = 180;
    pixels[offset + 1] = 120;
    pixels[offset + 2] = 60;
    pixels[offset + 3] = 255;
  }

  final buffer = await ui.ImmutableBuffer.fromUint8List(pixels);
  try {
    final descriptor = ui.ImageDescriptor.raw(
      buffer,
      width: width,
      height: height,
      pixelFormat: ui.PixelFormat.rgba8888,
    );
    try {
      final codec = await descriptor.instantiateCodec();
      try {
        final frame = await codec.getNextFrame();
        try {
          final data = await frame.image.toByteData(
            format: ui.ImageByteFormat.png,
          );
          if (data == null) throw StateError('PNG encoding failed.');
          return Uint8List.fromList(
            data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes),
          );
        } finally {
          frame.image.dispose();
        }
      } finally {
        codec.dispose();
      }
    } finally {
      descriptor.dispose();
    }
  } finally {
    buffer.dispose();
  }
}

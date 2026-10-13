import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter_test/flutter_test.dart';
import 'package:worldpainter_pc/processing/tiled_img2img_layout.dart';
import 'package:worldpainter_pc/processing/tiled_img2img_rasterizer.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('samples accepted square responses at their returned scale', () async {
    final plan = buildTiledImg2ImgPlan(64, 64);
    final source = await _solidPng(64, 64, const _Rgb(0, 0, 0));

    for (final size in <int>[512, 1024, 2048]) {
      final response = await _coordinatePng(size, size);
      final raster = await const TiledImg2ImgRasterizer().openSession(
        source,
        plan,
      );
      final accepted = await raster.addGeneratedTile(
        plan.tiles.single,
        response,
      );
      final output = await raster.finish();
      final pixels = await _readPixels(output);

      expect(accepted, (width: size, height: size));
      expect(
        (pixels.width, pixels.height),
        (plan.outputWidth, plan.outputHeight),
      );
      // At 1024x1024 the coordinates remain unchanged. Smaller and larger
      // responses sample the same normalized point in the request image.
      expect(pixels.at(80, 64), <int>[
        80 * size ~/ 1024,
        64 * size ~/ 1024,
        0,
        255,
      ]);
    }
  });

  test(
    'scales non-square returned images independently on each axis',
    () async {
      final plan = buildTiledImg2ImgPlan(64, 64);
      final source = await _solidPng(64, 64, const _Rgb(0, 0, 0));
      final response = await _coordinatePng(512, 2048);
      final raster = await const TiledImg2ImgRasterizer().openSession(
        source,
        plan,
      );

      final accepted = await raster.addGeneratedTile(
        plan.tiles.single,
        response,
      );
      final output = await raster.finish();
      final pixels = await _readPixels(output);

      expect(accepted, (width: 512, height: 2048));
      expect(pixels.at(80, 80), <int>[40, 160, 0, 255]);
    },
  );

  test('keeps padded edge pixels and blends adjacent tile edges', () async {
    final plan = buildTiledImg2ImgPlan(321, 1);
    expect(plan.tiles, hasLength(2));
    final source = await _solidPng(321, 1, const _Rgb(16, 32, 48));
    final raster = await const TiledImg2ImgRasterizer().openSession(
      source,
      plan,
    );

    final edgeTile = await raster.encodeTile(plan.tiles[1]);
    final edgePixels = await _readPixels(edgeTile);
    expect(edgePixels.at(0, 0), <int>[16, 32, 48, 255]);
    expect(edgePixels.at(639, 639), <int>[16, 32, 48, 255]);

    await raster.addGeneratedTile(
      plan.tiles[0],
      await _solidPng(1024, 1024, const _Rgb(20, 40, 60)),
    );
    await raster.addGeneratedTile(
      plan.tiles[1],
      await _solidPng(1024, 1024, const _Rgb(220, 200, 180)),
    );
    final output = await raster.finish();
    final pixels = await _readPixels(output);

    expect(
      (pixels.width, pixels.height),
      (plan.outputWidth, plan.outputHeight),
    );
    expect(pixels.at(0, 0), <int>[20, 40, 60, 255]);
    expect(pixels.at(511, 0), <int>[20, 40, 60, 255]);
    expect(pixels.at(512, 0), <int>[120, 120, 120, 255]);
    expect(pixels.at(513, 1), <int>[120, 120, 120, 255]);
  });
}

Future<Uint8List> _coordinatePng(int width, int height) {
  final pixels = Uint8List(width * height * 4);
  for (var y = 0; y < height; y++) {
    for (var x = 0; x < width; x++) {
      final offset = (y * width + x) * 4;
      pixels[offset] = x & 0xff;
      pixels[offset + 1] = y & 0xff;
      pixels[offset + 3] = 255;
    }
  }
  return _encodePng(width, height, pixels);
}

Future<Uint8List> _solidPng(int width, int height, _Rgb color) {
  final pixels = Uint8List(width * height * 4);
  for (var offset = 0; offset < pixels.length; offset += 4) {
    pixels[offset] = color.red;
    pixels[offset + 1] = color.green;
    pixels[offset + 2] = color.blue;
    pixels[offset + 3] = 255;
  }
  return _encodePng(width, height, pixels);
}

Future<Uint8List> _encodePng(int width, int height, Uint8List pixels) async {
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
          if (data == null) throw StateError('PNG fixture encoding failed.');
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

Future<_Pixels> _readPixels(Uint8List bytes) async {
  final codec = await ui.instantiateImageCodec(bytes);
  try {
    final frame = await codec.getNextFrame();
    try {
      final data = await frame.image.toByteData(
        format: ui.ImageByteFormat.rawStraightRgba,
      );
      if (data == null) throw StateError('PNG fixture decoding failed.');
      return _Pixels(
        frame.image.width,
        frame.image.height,
        Uint8List.fromList(
          data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes),
        ),
      );
    } finally {
      frame.image.dispose();
    }
  } finally {
    codec.dispose();
  }
}

class _Rgb {
  const _Rgb(this.red, this.green, this.blue);

  final int red;
  final int green;
  final int blue;
}

class _Pixels {
  const _Pixels(this.width, this.height, this.data);

  final int width;
  final int height;
  final Uint8List data;

  List<int> at(int x, int y) {
    final offset = (y * width + x) * 4;
    return data.sublist(offset, offset + 4);
  }
}

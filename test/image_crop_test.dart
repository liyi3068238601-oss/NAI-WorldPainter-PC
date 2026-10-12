import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter_test/flutter_test.dart';
import 'package:worldpainter_pc/editing/image_crop.dart';

void main() {
  test('largest crop keeps the requested ratio inside its bounds', () {
    const bounds = ui.Rect.fromLTWH(100, 50, 300, 200);
    final crop = largestImageCropRectForRatio(bounds, 0.5);

    expect(crop.width, closeTo(100, 0.0001));
    expect(crop.height, closeTo(200, 0.0001));
    expect(crop.center, bounds.center);
    expect(crop.left, greaterThanOrEqualTo(bounds.left));
    expect(crop.top, greaterThanOrEqualTo(bounds.top));
    expect(crop.right, lessThanOrEqualTo(bounds.right));
    expect(crop.bottom, lessThanOrEqualTo(bounds.bottom));
    expect(crop.width / crop.height, closeTo(0.5, 0.0001));
  });

  test('source crop conversion preserves an offset selection and ratio', () {
    final crop = imageCropRectToSourcePixels(
      cropRect: const ui.Rect.fromLTWH(110, 70, 150, 150),
      imageRect: const ui.Rect.fromLTWH(10, 20, 400, 300),
      imageWidth: 400,
      imageHeight: 300,
      targetWidth: 1024,
      targetHeight: 1024,
    );

    expect(crop, const ui.Rect.fromLTWH(100, 50, 150, 150));
    expect(crop.left, greaterThanOrEqualTo(0));
    expect(crop.top, greaterThanOrEqualTo(0));
    expect(crop.right, lessThanOrEqualTo(400));
    expect(crop.bottom, lessThanOrEqualTo(300));
    expect(crop.width / crop.height, closeTo(1, 0.0001));
  });

  test(
    'PNG crop samples the selected source pixels and leaves input unchanged',
    () async {
      final sourceBytes = await _makePixelImage();
      final originalBytes = Uint8List.fromList(sourceBytes);
      final croppedBytes = await cropImageToPng(
        sourceBytes: sourceBytes,
        imageWidth: 4,
        imageHeight: 2,
        cropRect: const ui.Rect.fromLTWH(1, 0, 2, 2),
        targetWidth: 2,
        targetHeight: 2,
      );
      final pixels = await _readRgbaPixels(croppedBytes);

      expect(sourceBytes, originalBytes);
      expect(pixels, [
        0, 255, 0, 255, // green
        0, 0, 255, 255, // blue
        0, 0, 0, 255, // black
        0, 255, 255, 255, // cyan
      ]);
    },
  );
}

Future<Uint8List> _makePixelImage() async {
  const colors = <ui.Color>[
    ui.Color(0xffff0000),
    ui.Color(0xff00ff00),
    ui.Color(0xff0000ff),
    ui.Color(0xffffff00),
    ui.Color(0xffffffff),
    ui.Color(0xff000000),
    ui.Color(0xff00ffff),
    ui.Color(0xffff00ff),
  ];
  final recorder = ui.PictureRecorder();
  final canvas = ui.Canvas(recorder);
  final paint = ui.Paint();
  for (var y = 0; y < 2; y++) {
    for (var x = 0; x < 4; x++) {
      paint.color = colors[y * 4 + x];
      canvas.drawRect(
        ui.Rect.fromLTWH(x.toDouble(), y.toDouble(), 1, 1),
        paint,
      );
    }
  }
  final picture = recorder.endRecording();
  final image = await picture.toImage(4, 2);
  try {
    final png = await image.toByteData(format: ui.ImageByteFormat.png);
    return Uint8List.fromList(
      png!.buffer.asUint8List(png.offsetInBytes, png.lengthInBytes),
    );
  } finally {
    image.dispose();
    picture.dispose();
  }
}

Future<List<int>> _readRgbaPixels(Uint8List bytes) async {
  final codec = await ui.instantiateImageCodec(bytes);
  try {
    final frame = await codec.getNextFrame();
    try {
      final rgba = await frame.image.toByteData(
        format: ui.ImageByteFormat.rawRgba,
      );
      return rgba!.buffer.asUint8List(rgba.offsetInBytes, rgba.lengthInBytes);
    } finally {
      frame.image.dispose();
    }
  } finally {
    codec.dispose();
  }
}

import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:worldpainter_pc/processing/tiled_img2img_layout.dart';
import 'package:worldpainter_pc/processing/tiled_img2img_rasterizer.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test('NEW regression: accepted smaller returned tile preserves proportional sampling', () async {
    final plan = buildTiledImg2ImgPlan(64, 64);
    final source = await _image(64, 64, gradient: false);
    final response = await _image(512, 512, gradient: true);
    final raster = await const TiledImg2ImgRasterizer().openSession(
      source,
      plan,
    );
    final accepted = await raster.addGeneratedTile(plan.tiles.single, response);
    final output = await raster.finish();
    final codec = await ui.instantiateImageCodec(output);
    final image = (await codec.getNextFrame()).image;
    final rgba = await image.toByteData(format: ui.ImageByteFormat.rawRgba);
    final actualRed = rgba!.getUint8((50 * image.width + 100) * 4);
    debugPrint(
      'TILED_RESAMPLE_EVIDENCE accepted=${accepted.width}x${accepted.height} requested=1024x1024 output=${image.width}x${image.height} redAt100=$actualRed expectedRed=25',
    );
    image.dispose();
    codec.dispose();
    // The source request covers 640px in a 1024px tile. A 512px response
    // should sample x=50 for output x=100. The red ramp is red=x/2.
    expect(
      actualRed,
      inInclusiveRange(24, 26),
      reason: 'When accepting a smaller returned tile, output pixels must sample x * returned/requested, not x / that ratio. Alternatively reject mismatched dimensions before saving.',
    );
  });
}

Future<Uint8List> _image(
  int width,
  int height, {
  required bool gradient,
}) async {
  final recorder = ui.PictureRecorder();
  final canvas = ui.Canvas(recorder);
  if (gradient) {
    for (var x = 0; x < width; x++) {
      canvas.drawRect(
        ui.Rect.fromLTWH(x.toDouble(), 0, 1, height.toDouble()),
        ui.Paint()
          ..isAntiAlias = false
          ..color = ui.Color.fromARGB(255, x ~/ 2, 0, 0),
      );
    }
  } else {
    canvas.drawRect(
      ui.Rect.fromLTWH(0, 0, width.toDouble(), height.toDouble()),
      ui.Paint()..color = const ui.Color(0xff000000),
    );
  }
  final picture = recorder.endRecording();
  final image = await picture.toImage(width, height);
  final png = await image.toByteData(format: ui.ImageByteFormat.png);
  image.dispose();
  picture.dispose();
  return png!.buffer.asUint8List();
}

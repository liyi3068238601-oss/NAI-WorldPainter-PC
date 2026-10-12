import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter_test/flutter_test.dart';
import 'package:worldpainter_pc/editing/inpaint_document.dart';
import 'package:worldpainter_pc/editing/inpaint_renderer.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const renderer = InpaintRenderer();

  test(
    'mask paint followed by erase removes only the later stroke area',
    () async {
      final source = await _solidPng(16, 16, const ui.Color(0xff203040));
      final document = _document(
        width: 16,
        height: 16,
        strokes: [
          _pointStroke(
            target: InpaintTarget.mask,
            operation: InpaintOperation.paint,
            size: 12,
            point: const ui.Offset(8, 8),
          ),
          _pointStroke(
            target: InpaintTarget.mask,
            operation: InpaintOperation.erase,
            size: 4,
            point: const ui.Offset(8, 8),
          ),
        ],
      );

      final mask = await _pixels(
        await renderer.renderOutputMask(document, sourceBytes: source),
      );

      expect(mask.at(8, 8)[0], 0);
      expect(mask.at(3, 8)[0], 255);
      expect(mask.at(1, 8)[0], 0);
      expect(mask.at(8, 8)[3], 255);
    },
  );

  test('rectangle masks fill the source-pixel rectangle', () async {
    final document = _document(
      width: 12,
      height: 12,
      strokes: [
        InpaintStroke(
          target: InpaintTarget.mask,
          operation: InpaintOperation.paint,
          geometry: InpaintGeometry.rectangle,
          rectangle: const ui.Rect.fromLTRB(2, 2, 7, 7),
          size: 1,
        ),
      ],
    );

    final mask = await _pixels(await renderer.renderOutputMask(document));

    expect(mask.at(4, 4)[0], 255);
    expect(mask.at(1, 4)[0], 0);
    expect(mask.at(7, 4)[0], 0);
  });

  test(
    'mask preview composites a translucent overlay over the source',
    () async {
      final source = await _solidPng(8, 8, const ui.Color(0xff203040));
      final document = _document(
        width: 8,
        height: 8,
        previewOpacity: 0.5,
        strokes: [
          InpaintStroke(
            target: InpaintTarget.mask,
            operation: InpaintOperation.paint,
            geometry: InpaintGeometry.rectangle,
            rectangle: const ui.Rect.fromLTRB(0, 0, 4, 8),
            size: 1,
          ),
        ],
      );

      final preview = await _pixels(
        await renderer.renderMaskPreview(source, document),
      );

      expect(preview.at(1, 1), [144, 63, 72, 255]);
      expect(preview.at(6, 1), [32, 48, 64, 255]);
    },
  );

  test('round and square brushes have distinct PNG pixel footprints', () async {
    final round = _document(
      width: 16,
      height: 16,
      strokes: [
        _pointStroke(
          target: InpaintTarget.mask,
          operation: InpaintOperation.paint,
          size: 8,
          point: const ui.Offset(8, 8),
        ),
      ],
    );
    final square = _document(
      width: 16,
      height: 16,
      strokes: [
        _pointStroke(
          target: InpaintTarget.mask,
          operation: InpaintOperation.paint,
          size: 8,
          point: const ui.Offset(8, 8),
          brushShape: InpaintBrushShape.square,
        ),
      ],
    );

    final roundPixels = await _pixels(await renderer.renderOutputMask(round));
    final squarePixels = await _pixels(await renderer.renderOutputMask(square));

    expect(roundPixels.at(4, 4)[0], 0);
    expect(squarePixels.at(4, 4)[0], 255);
    expect(roundPixels.at(8, 8)[0], 255);
    expect(squarePixels.at(8, 8)[0], 255);
  });

  test(
    'connected round paths fill nodes and the fast gaps between them',
    () async {
      final document = _document(
        width: 36,
        height: 16,
        strokes: [
          InpaintStroke(
            target: InpaintTarget.mask,
            operation: InpaintOperation.paint,
            geometry: InpaintGeometry.path,
            points: const [
              ui.Offset(4, 8),
              ui.Offset(12, 8),
              ui.Offset(20, 8),
              ui.Offset(28, 8),
            ],
            size: 8,
            brushShape: InpaintBrushShape.round,
          ),
        ],
      );

      final mask = await _pixels(await renderer.renderOutputMask(document));

      for (final x in [4, 8, 12, 16, 20, 24, 28]) {
        expect(
          mask.at(x, 8)[0],
          255,
          reason: 'expected continuous path at x=$x',
        );
      }
    },
  );

  test(
    'image eraser restores the immutable source beneath painted pixels',
    () async {
      final source = await _solidPng(16, 16, const ui.Color(0xff204080));
      final document = _document(
        width: 16,
        height: 16,
        strokes: [
          _pointStroke(
            target: InpaintTarget.image,
            operation: InpaintOperation.paint,
            size: 12,
            point: const ui.Offset(8, 8),
            color: 0xffff0000,
          ),
          _pointStroke(
            target: InpaintTarget.image,
            operation: InpaintOperation.erase,
            size: 4,
            point: const ui.Offset(8, 8),
          ),
        ],
      );

      final result = await _pixels(
        await renderer.renderImageLayer(source, document),
      );

      expect(result.at(8, 8), [32, 64, 128, 255]);
      expect(result.at(3, 8)[0], greaterThan(200));
      expect(result.at(1, 8), [32, 64, 128, 255]);
    },
  );

  test(
    'selected regions beyond the source keep transparent image margins',
    () async {
      final source = await _solidPng(8, 8, const ui.Color(0xff00aa44));
      final region = const ui.Rect.fromLTWH(-4, -4, 16, 16);

      final cropped = await _pixels(
        await renderer.prepareRegionInput(
          source,
          region,
          targetWidth: 16,
          targetHeight: 16,
        ),
      );

      expect(cropped.at(0, 0)[3], 0);
      expect(cropped.at(3, 3)[3], 0);
      expect(cropped.at(8, 8), [0, 170, 68, 255]);
    },
  );

  test(
    'request masks are grayscale PNGs with white out-of-source cells',
    () async {
      final source = await _solidPng(8, 8, const ui.Color(0xff00aa44));
      final document = _document(
        width: 8,
        height: 8,
        sourceRect: const ui.Rect.fromLTWH(-4, -4, 16, 16),
        featherPixels: 0,
      );

      final prepared = await renderer.prepareRequest(
        sourceBytes: source,
        document: document,
        targetWidth: 16,
        targetHeight: 16,
      );
      final mask = await _pixels(prepared.maskPng);

      expect(prepared.sourceRect, document.effectiveSourceRect);
      expect(prepared.imagePng, isNotEmpty);
      expect(prepared.maskPng[25], 0, reason: 'PNG color type 0 is grayscale');
      expect(mask.at(0, 0)[0], 255);
      expect(mask.at(15, 15)[0], 255);
      expect(prepared.hasMaskedPixels, isTrue);
    },
  );

  test(
    'transparent source pixels become selected white request mask',
    () async {
      final source = await _solidPng(8, 8, const ui.Color(0x00000000));
      final prepared = await renderer.prepareRequest(
        sourceBytes: source,
        document: _document(
          width: 8,
          height: 8,
          sourceRect: const ui.Rect.fromLTWH(0, 0, 8, 8),
        ),
        targetWidth: 8,
        targetHeight: 8,
      );
      final mask = await _pixels(prepared.maskPng);

      expect(prepared.hasMaskedPixels, isTrue);
      expect(mask.at(4, 4)[0], 255);
    },
  );

  test('empty request mask is reported without failing preparation', () async {
    final source = await _solidPng(8, 8, const ui.Color(0xff00aa44));
    final prepared = await renderer.prepareRequest(
      sourceBytes: source,
      document: _document(
        width: 8,
        height: 8,
        sourceRect: const ui.Rect.fromLTWH(0, 0, 8, 8),
        featherPixels: 0,
      ),
      targetWidth: 16,
      targetHeight: 16,
    );
    final mask = await _pixels(prepared.maskPng);

    expect(prepared.hasMaskedPixels, isFalse);
    expect(mask.at(12, 12)[0], 0);
  });

  test(
    'candidate reinsert preserves source outside the latent mask and region',
    () async {
      final source = await _solidPng(32, 32, const ui.Color(0xff204080));
      final generated = await _solidPng(16, 16, const ui.Color(0xffee3020));
      final document = _document(
        width: 32,
        height: 32,
        sourceRect: const ui.Rect.fromLTWH(8, 8, 16, 16),
        featherPixels: 0,
        strokes: [
          InpaintStroke(
            target: InpaintTarget.mask,
            operation: InpaintOperation.paint,
            geometry: InpaintGeometry.rectangle,
            rectangle: const ui.Rect.fromLTRB(10, 10, 12, 12),
            size: 1,
          ),
        ],
      );

      final composite = await renderer.reinsertCandidate(
        sourceBytes: source,
        candidateBytes: generated,
        document: document,
      );
      final pixels = await _pixels(composite.bytes);

      expect((composite.width, composite.height), (32, 32));
      expect((composite.originX, composite.originY), (0, 0));
      expect(pixels.at(10, 10), [238, 48, 32, 255]);
      expect(pixels.at(14, 14), [238, 48, 32, 255]);
      expect(pixels.at(20, 20), [32, 64, 128, 255]);
      expect(pixels.at(2, 2), [32, 64, 128, 255]);
    },
  );

  test(
    'feathered candidate composites with correct alpha and preserves distance',
    () async {
      final source = await _solidPng(32, 32, const ui.Color(0xff204080));
      final generated = await _solidPng(32, 32, const ui.Color(0xffee3020));
      final document = _document(
        width: 32,
        height: 32,
        sourceRect: const ui.Rect.fromLTWH(0, 0, 32, 32),
        featherPixels: 8,
        strokes: [
          InpaintStroke(
            target: InpaintTarget.mask,
            operation: InpaintOperation.paint,
            geometry: InpaintGeometry.rectangle,
            rectangle: const ui.Rect.fromLTRB(8, 8, 16, 16),
            size: 1,
          ),
        ],
      );

      final composite = await renderer.reinsertCandidate(
        sourceBytes: source,
        candidateBytes: generated,
        document: document,
      );
      final pixels = await _pixels(composite.bytes);

      expect(pixels.at(12, 12), [238, 48, 32, 255]);
      expect(pixels.at(7, 12), [212, 50, 44, 255]);
      expect(pixels.at(2, 2), [32, 64, 128, 255]);
    },
  );

  test(
    'generated output is resampled to mask dimensions before alpha masking',
    () async {
      final generated = await _solidPng(2, 2, const ui.Color(0xffee3020));
      final document = _document(
        width: 4,
        height: 4,
        featherPixels: 0,
        strokes: [
          InpaintStroke(
            target: InpaintTarget.mask,
            operation: InpaintOperation.paint,
            geometry: InpaintGeometry.rectangle,
            rectangle: const ui.Rect.fromLTRB(0, 0, 2, 2),
            size: 1,
          ),
        ],
      );
      final mask = await renderer.renderOutputMask(document);
      final layer = await renderer.maskGeneratedLayer(
        generatedBytes: generated,
        maskBytes: mask,
        outwardFeatherPixels: 0,
      );
      final pixels = await _pixels(layer);

      expect((pixels.width, pixels.height), (4, 4));
      expect(pixels.at(1, 1), [238, 48, 32, 255]);
      expect(pixels.at(3, 3)[3], 0);
    },
  );

  test(
    'generated layer feathers outward from mask and empty mask stays clear',
    () async {
      final generated = await _solidPng(4, 4, const ui.Color(0xffee3020));
      final selectedMask = await renderer.renderOutputMask(
        _document(
          width: 4,
          height: 4,
          strokes: [
            InpaintStroke(
              target: InpaintTarget.mask,
              operation: InpaintOperation.paint,
              geometry: InpaintGeometry.rectangle,
              rectangle: const ui.Rect.fromLTRB(1, 1, 3, 3),
              size: 1,
            ),
          ],
        ),
      );
      final selectedLayer = await renderer.maskGeneratedLayer(
        generatedBytes: generated,
        maskBytes: selectedMask,
        outwardFeatherPixels: 2,
      );
      final selectedPixels = await _pixels(selectedLayer);
      final emptyMask = await renderer.renderOutputMask(
        _document(width: 4, height: 4),
      );
      final emptyLayer = await renderer.maskGeneratedLayer(
        generatedBytes: generated,
        maskBytes: emptyMask,
        outwardFeatherPixels: 2,
      );
      final emptyPixels = await _pixels(emptyLayer);

      expect(selectedPixels.at(1, 1)[3], 255);
      expect(selectedPixels.at(0, 1)[3], greaterThan(0));
      expect(selectedPixels.at(0, 1)[3], lessThan(255));
      expect(emptyPixels.data.every((value) => value == 0), isTrue);
    },
  );

  test('visible layers expand the returned composite bounds', () async {
    final source = await _solidPng(8, 8, const ui.Color(0xff204080));
    final generated = await _solidPng(6, 6, const ui.Color(0x80ee3020));

    final composite = await renderer.composeLayers(
      sourceBytes: source,
      document: _document(width: 8, height: 8, featherPixels: 0),
      layers: [
        InpaintLayer(
          bytes: generated,
          worldRect: const ui.Rect.fromLTWH(-2, -2, 6, 6),
        ),
      ],
    );
    final pixels = await _pixels(composite.bytes);

    expect((composite.width, composite.height), (10, 10));
    expect((composite.originX, composite.originY), (-2, -2));
    expect(pixels.at(0, 0)[3], 128);
    expect(pixels.at(4, 4)[3], 255);
  });

  test('pixel-art scaling uses nearest-neighbor blocks at 2x and 3x', () async {
    final source = await _twoColorPng();

    final doubled = await _pixels(
      await renderer.scalePixelArt(source, factor: 2),
    );
    final tripled = await _pixels(
      await renderer.scalePixelArt(source, factor: 3),
    );

    expect((doubled.width, doubled.height), (4, 2));
    expect(doubled.at(0, 0), [255, 0, 0, 255]);
    expect(doubled.at(1, 1), [255, 0, 0, 255]);
    expect(doubled.at(2, 0), [0, 255, 0, 255]);
    expect(doubled.at(3, 1), [0, 255, 0, 255]);
    expect((tripled.width, tripled.height), (6, 3));
    expect(tripled.at(2, 2), [255, 0, 0, 255]);
    expect(tripled.at(3, 0), [0, 255, 0, 255]);
  });

  test('document JSON round-trips the source-external region and immutable strokes', () {
    final initial = <InpaintStroke>[
      _pointStroke(
        target: InpaintTarget.mask,
        operation: InpaintOperation.paint,
        size: 3,
        point: const ui.Offset(2, 4),
        brushShape: InpaintBrushShape.square,
      ),
    ];
    final document = _document(
      width: 8,
      height: 6,
      sourceRect: const ui.Rect.fromLTWH(-2, -1, 10, 8),
      strokes: initial,
      expandPixels: 3,
      featherPixels: 4,
    );
    initial.clear();

    final restored = InpaintDocument.fromJson(document.toJson());

    expect(document.strokes, hasLength(1));
    expect(restored.sourceRect, document.sourceRect);
    expect(restored.effectiveSourceRect, document.effectiveSourceRect);
    expect(restored.expandPixels, 3);
    expect(restored.featherPixels, 4);
    expect(restored.strokes.single.brushShape, InpaintBrushShape.square);
  });
}

InpaintDocument _document({
  required int width,
  required int height,
  List<InpaintStroke> strokes = const [],
  ui.Rect? sourceRect,
  int expandPixels = 0,
  int featherPixels = 8,
  double previewOpacity = 1,
}) => InpaintDocument(
  sourceAssetRef: 'asset:source',
  sourceWidth: width,
  sourceHeight: height,
  sourceRect: sourceRect,
  strokes: strokes,
  previewOpacity: previewOpacity,
  expandPixels: expandPixels,
  featherPixels: featherPixels,
);

InpaintStroke _pointStroke({
  required InpaintTarget target,
  required InpaintOperation operation,
  required double size,
  required ui.Offset point,
  int color = 0xffff4d4f,
  InpaintBrushShape brushShape = InpaintBrushShape.round,
}) => InpaintStroke(
  target: target,
  operation: operation,
  geometry: InpaintGeometry.brush,
  points: [point],
  size: size,
  color: color,
  brushShape: brushShape,
);

Future<Uint8List> _solidPng(int width, int height, ui.Color color) async {
  final recorder = ui.PictureRecorder();
  final canvas = ui.Canvas(
    recorder,
    ui.Rect.fromLTWH(0, 0, width.toDouble(), height.toDouble()),
  );
  canvas.drawColor(color, ui.BlendMode.src);
  final picture = recorder.endRecording();
  try {
    final image = await picture.toImage(width, height);
    try {
      final data = await image.toByteData(format: ui.ImageByteFormat.png);
      return Uint8List.fromList(
        data!.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes),
      );
    } finally {
      image.dispose();
    }
  } finally {
    picture.dispose();
  }
}

Future<Uint8List> _twoColorPng() async {
  const width = 2;
  const height = 1;
  final recorder = ui.PictureRecorder();
  final canvas = ui.Canvas(
    recorder,
    ui.Rect.fromLTWH(0, 0, width.toDouble(), height.toDouble()),
  );
  canvas
    ..drawColor(const ui.Color(0xff000000), ui.BlendMode.src)
    ..drawRect(
      const ui.Rect.fromLTWH(0, 0, 1, 1),
      ui.Paint()..color = const ui.Color(0xffff0000),
    )
    ..drawRect(
      const ui.Rect.fromLTWH(1, 0, 1, 1),
      ui.Paint()..color = const ui.Color(0xff00ff00),
    );
  final picture = recorder.endRecording();
  try {
    final image = await picture.toImage(width, height);
    try {
      final data = await image.toByteData(format: ui.ImageByteFormat.png);
      return Uint8List.fromList(
        data!.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes),
      );
    } finally {
      image.dispose();
    }
  } finally {
    picture.dispose();
  }
}

Future<_PixelImage> _pixels(Uint8List png) async {
  final codec = await ui.instantiateImageCodec(png);
  try {
    final frame = await codec.getNextFrame();
    try {
      final data = await frame.image.toByteData(
        format: ui.ImageByteFormat.rawStraightRgba,
      );
      return _PixelImage(
        frame.image.width,
        frame.image.height,
        Uint8List.fromList(
          data!.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes),
        ),
      );
    } finally {
      frame.image.dispose();
    }
  } finally {
    codec.dispose();
  }
}

class _PixelImage {
  const _PixelImage(this.width, this.height, this.data);

  final int width;
  final int height;
  final Uint8List data;

  List<int> at(int x, int y) {
    final offset = (y * width + x) * 4;
    return [data[offset], data[offset + 1], data[offset + 2], data[offset + 3]];
  }
}

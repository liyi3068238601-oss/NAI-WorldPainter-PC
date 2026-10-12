import 'dart:typed_data';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:worldpainter_pc/editing/image_editing_session.dart';
import 'package:worldpainter_pc/editing/inpaint_document.dart';
import 'package:worldpainter_pc/editing/inpaint_workspace.dart';
import 'package:worldpainter_pc/media/image_asset_store.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'paint, erase, and undo keep source-pixel strokes in the session',
    (tester) async {
      tester.view.physicalSize = const Size(1300, 1000);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final session = (await tester.runAsync(_createSession))!;
      await tester.pumpWidget(_workspace(session));
      await tester.pumpAndSettle();

      final canvas = find.byKey(const ValueKey('inpaint-editor-canvas'));
      final canvasCenter = tester.getCenter(canvas);
      await _dragInSegments(
        tester,
        canvasCenter + const Offset(-32, -12),
        const Offset(52, 18),
      );
      await tester.pump();

      expect(session.document!.strokes, hasLength(1));
      final paintStroke = session.document!.strokes.single;
      expect(paintStroke.target, InpaintTarget.mask);
      expect(paintStroke.operation, InpaintOperation.paint);
      expect(paintStroke.points.length, greaterThan(1));
      expect(paintStroke.points.first.dx, inInclusiveRange(0, 200));
      expect(paintStroke.points.first.dy, inInclusiveRange(0, 160));

      await tester.tap(find.byKey(const ValueKey('inpaint-tool-erase')));
      await tester.pump();
      await tester.tapAt(canvasCenter + const Offset(18, -18));
      await tester.pump();

      expect(session.document!.strokes, hasLength(2));
      expect(session.document!.strokes.last.operation, InpaintOperation.erase);
      expect(session.document!.strokes.last.points, hasLength(1));

      await _dragInSegments(
        tester,
        canvasCenter + const Offset(24, 16),
        const Offset(-36, 24),
      );
      await tester.pump();

      expect(session.document!.strokes, hasLength(3));
      expect(session.document!.strokes.last.operation, InpaintOperation.erase);
      expect(session.document!.strokes.last.points.length, greaterThan(1));

      await tester.tap(find.byKey(const ValueKey('inpaint-undo')));
      await tester.pump();
      expect(session.document!.strokes, hasLength(2));
      expect(session.document!.strokes.last.operation, InpaintOperation.erase);
      expect(session.document!.strokes.last.points, hasLength(1));

      await tester.pump(const Duration(milliseconds: 140));
      await tester.pumpAndSettle();
      await tester.pumpWidget(const SizedBox.shrink());
      session.dispose();
      await session.assets.close();
    },
  );

  testWidgets('region handles move and resize the source-pixel output frame', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1100, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final session = (await tester.runAsync(_createSession))!;
    await tester.pumpWidget(_workspace(session));
    await tester.pumpAndSettle();

    await tester.tap(find.text('区域').first);
    await tester.pump();
    final before = session.document!.effectiveSourceRect;
    final handle = find.byKey(
      const ValueKey('inpaint-selection-handle-bottomRight'),
    );
    await tester.ensureVisible(handle);
    await tester.pumpAndSettle();
    expect(handle.hitTestable(), findsOneWidget);
    await _dragInSegments(
      tester,
      tester.getCenter(handle),
      const Offset(36, 28),
    );
    await tester.pump();

    final after = session.document!.effectiveSourceRect;
    expect(session.document!.fullImageMode, isFalse);
    expect(after.right, greaterThan(before.right));
    expect(after.bottom, greaterThan(before.bottom));
    expect(after.width / after.height, closeTo(1024 / 1024, 0.03));

    final mouseHandle = find.byKey(
      const ValueKey('inpaint-selection-handle-bottomRight'),
    );
    await tester.ensureVisible(mouseHandle);
    await tester.pumpAndSettle();
    final afterTouchDrag = session.document!.effectiveSourceRect;
    await _dragInSegments(
      tester,
      tester.getCenter(mouseHandle),
      const Offset(30, 22),
      kind: ui.PointerDeviceKind.mouse,
    );
    await tester.pump();
    final afterMouseDrag = session.document!.effectiveSourceRect;
    expect(afterMouseDrag.right, greaterThan(afterTouchDrag.right));
    expect(afterMouseDrag.bottom, greaterThan(afterTouchDrag.bottom));
    expect(
      afterMouseDrag.width / afterMouseDrag.height,
      closeTo(1024 / 1024, 0.03),
    );

    await tester.pump(const Duration(milliseconds: 140));
    await tester.pumpAndSettle();
    await tester.pumpWidget(const SizedBox.shrink());
    session.dispose();
    await session.assets.close();
  });

  testWidgets('grayscale request mask stays aligned to source pixels', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1100, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    final session = (await tester.runAsync(
      () => _createSession(width: 960, height: 640),
    ))!;
    session.changeDocument(
      session.document!.copyWith(
        strokes: <InpaintStroke>[
          InpaintStroke(
            target: InpaintTarget.mask,
            operation: InpaintOperation.paint,
            geometry: InpaintGeometry.rectangle,
            rectangle: const Rect.fromLTWH(432, 408, 96, 80),
            size: 1,
          ),
        ],
        expandPixels: 32,
        previewOpacity: 1,
      ),
    );
    await tester.pumpWidget(_workspace(session));
    await tester.pumpAndSettle();

    final expandedCoverage = await _waitForPreviewColorAt(
      tester,
      const Offset(420, 448),
    );
    expect(
      (expandedCoverage.r * 255).round(),
      greaterThan((expandedCoverage.g * 255).round() + 60),
      reason: 'the prepared grayscale request mask did not cover its expanded source point',
    );

    final rowStrideRegression = await _capturePreviewColorAt(
      tester,
      const Offset(420, 112),
    );
    expect(
      (rowStrideRegression.r * 255).round(),
      lessThan((rowStrideRegression.g * 255).round() + 30),
    );

    await tester.pumpWidget(const SizedBox.shrink());
    session.dispose();
    await session.assets.close();
  });
}

Future<Color> _waitForPreviewColorAt(
  WidgetTester tester,
  Offset sourcePoint,
) async {
  final timer = Stopwatch()..start();
  Color? latest;
  while (timer.elapsed < const Duration(seconds: 10)) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 100)),
    );
    await tester.pump();
    latest = await _capturePreviewColorAt(tester, sourcePoint);
    if ((latest.r * 255).round() > (latest.g * 255).round() + 60) {
      return latest;
    }
  }
  return latest!;
}

Future<Color> _capturePreviewColorAt(
  WidgetTester tester,
  Offset sourcePoint,
) async {
  final finder = find.byKey(const ValueKey('inpaint-request-mask-preview'));
  final color = await tester.runAsync(() async {
    final boundary = tester.renderObject<RenderRepaintBoundary>(finder);
    final size = boundary.size;
    final scale = math.min(size.width / 960, size.height / 640);
    final origin = Offset(
      (size.width - 960 * scale) / 2,
      (size.height - 640 * scale) / 2,
    );
    final x = (origin.dx + sourcePoint.dx * scale).round();
    final y = (origin.dy + sourcePoint.dy * scale).round();
    final image = await boundary.toImage(pixelRatio: 1);
    try {
      final data = await image.toByteData(format: ui.ImageByteFormat.rawRgba);
      if (data == null) throw StateError('预览截图像素不可用');
      final pixels = data.buffer.asUint8List(
        data.offsetInBytes,
        data.lengthInBytes,
      );
      final offset = (y * image.width + x) * 4;
      return Color.fromARGB(
        pixels[offset + 3],
        pixels[offset],
        pixels[offset + 1],
        pixels[offset + 2],
      );
    } finally {
      image.dispose();
    }
  });
  return color!;
}

Future<void> _dragInSegments(
  WidgetTester tester,
  Offset start,
  Offset delta, {
  ui.PointerDeviceKind kind = ui.PointerDeviceKind.touch,
}) async {
  final gesture = await tester.startGesture(start, kind: kind);
  await tester.pump();
  for (var step = 1; step <= 3; step++) {
    await gesture.moveTo(start + delta * (step / 3));
  }
  await gesture.up();
}

Widget _workspace(ImageEditingSession session) => MaterialApp(
  home: Scaffold(
    body: InpaintWorkspace(
      session: session,
      outputWidth: 1024,
      outputHeight: 1024,
      busy: false,
      onImport: () {},
      onUseCurrent: () {},
      onSaveComposite: () async {},
      onApplyResult: () async {},
      onScalePixels: (_) async {},
    ),
  ),
);

Future<ImageEditingSession> _createSession({
  int width = 200,
  int height = 160,
}) async {
  final assets = _MemoryImageAssetStore();
  final bytes = await _makeSourceImage(width: width, height: height);
  assets.values['source-fixture'] = bytes;
  final session = ImageEditingSession(assets: assets, onPersist: (_) {});
  session.setSource(
    ImageAsset(
      id: 'fixture-id',
      assetRef: 'source-fixture',
      width: width,
      height: height,
      mime: 'image/png',
      sha256: 'fixture-sha256',
      byteLength: 0,
    ),
  );
  return session;
}

Future<Uint8List> _makeSourceImage({
  required int width,
  required int height,
}) async {
  final recorder = ui.PictureRecorder();
  final canvas = ui.Canvas(recorder);
  canvas.drawRect(
    ui.Rect.fromLTWH(0, 0, width.toDouble(), height.toDouble()),
    ui.Paint()..color = const ui.Color(0xff69819a),
  );
  canvas.drawCircle(
    const ui.Offset(105, 78),
    38,
    ui.Paint()..color = const ui.Color(0xfff5d57a),
  );
  final picture = recorder.endRecording();
  final image = await picture.toImage(width, height);
  try {
    final data = await image.toByteData(format: ui.ImageByteFormat.png);
    return Uint8List.fromList(
      data!.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes),
    );
  } finally {
    image.dispose();
    picture.dispose();
  }
}

class _MemoryImageAssetStore implements ImageAssetStore {
  final Map<String, Uint8List> values = <String, Uint8List>{};

  @override
  String get label => 'test memory assets';

  @override
  Future<ImageAsset> save(Uint8List bytes) async {
    final assetRef = 'fixture-${values.length}';
    values[assetRef] = Uint8List.fromList(bytes);
    return ImageAsset(
      id: assetRef,
      assetRef: assetRef,
      width: 1,
      height: 1,
      mime: 'image/png',
      sha256: assetRef,
      byteLength: bytes.length,
    );
  }

  @override
  Future<Uint8List> read(String assetRef) async {
    final value = values[assetRef];
    if (value == null) throw ImageAssetNotFoundException(assetRef);
    return Uint8List.fromList(value);
  }

  @override
  Future<void> close() async {}
}

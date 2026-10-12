import 'dart:async';
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:worldpainter_pc/editing/image_editing_session.dart';
import 'package:worldpainter_pc/editing/inpaint_document.dart';
import 'package:worldpainter_pc/generation/generation_parameters.dart';
import 'package:worldpainter_pc/media/image_asset_store.dart';
import 'package:worldpainter_pc/prototype/workbench_controller.dart';
import 'package:worldpainter_pc/storage/sqlite_workspace_store.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  sqfliteFfiInit();

  test('inpaint prompt stays independent of the normal and img2img draft', () {
    final c = WorkbenchController();
    addTearDown(c.dispose);
    c.updatePrompt('normal landscape');
    c.updateNegative('normal negative');
    c.updateAdvanced(
      c.parameters.copyWith(operation: GenerationOperation.inpaint),
    );
    expect(c.prompt, isEmpty);
    c.updatePrompt('repair the golden scarf');
    c.updateNegative('extra hands');
    c.updateAdvanced(
      c.parameters.copyWith(operation: GenerationOperation.imageToImage),
    );
    expect(c.prompt, 'normal landscape');
    expect(c.negative, 'normal negative');
    c.updateAdvanced(
      c.parameters.copyWith(operation: GenerationOperation.inpaint),
    );
    expect(c.prompt, 'repair the golden scarf');
    expect(c.negative, 'extra hands');
  });

  test('inpaint response preserves parent pixels and reopens editor, layers and refill', () async {
    final dir = await Directory('.tmp').createTemp('editing-integration-');
    addTearDown(() => dir.delete(recursive: true));
    var assets = await openImageAssetStore(directory: '${dir.path}/assets');
    var store = await SQLiteWorkspaceStore.open(
      factory: databaseFactoryFfi,
      path: '${dir.path}/workspace.sqlite',
    );
    final blue = await solid(0xff204080), red = await solid(0xffe05040);
    final source = await assets.save(blue), output = await assets.save(red);
    late WorkbenchController c;
    c = WorkbenchController(
      store: store,
      assets: assets,
      generateImage: (params, connection) async {
        expect(params.operation, GenerationOperation.inpaint);
        expect(
          (await pixel(await assets.read(params.maskImageId!), 20, 20)).take(3),
          [255, 255, 255],
        );
        return result(output.assetRef, params);
      },
    );
    var session = ImageEditingSession(
      assets: assets,
      onPersist: c.updateImageEditing,
    );
    session.setSource(source, parentId: 'fixture-parent');
    session.changeDocument(session.document!.copyWith(featherPixels: 0));
    session.addStroke(
      InpaintStroke(
        target: InpaintTarget.mask,
        operation: InpaintOperation.paint,
        geometry: InpaintGeometry.rectangle,
        size: 8,
        rectangle: const ui.Rect.fromLTWH(16, 16, 16, 16),
      ),
    );
    c.setSize(64, 64);
    c.updateAdvanced(
      c.parameters.copyWith(operation: GenerationOperation.inpaint),
    );
    final frozen = await c.prepareEditing(() => session.prepare(64, 64));
    final params = c.parameters.copyWith(
      sourceImageId: frozen.sourceRef,
      maskImageId: frozen.maskRef,
    );
    await c.generate(
      submitted: params,
      processResult: (raw, current) =>
          session.acceptResult(raw, frozen, current),
    );
    expect(c.results.length, 4);
    expect(session.document!.sourceAssetRef, source.assetRef);
    expect(session.candidates.length, 1);
    final saved = c.selected;
    final bytes = await assets.read(saved.assetRef!);
    expect((await pixel(bytes, 2, 2)).take(3), [32, 64, 128]);
    expect((await pixel(bytes, 20, 20)).take(3), [224, 80, 64]);
    expect(saved.editMetadata!['parentAssetRef'], source.assetRef);
    expect(await assets.read(source.assetRef), blue);
    session.toggleVisible(session.candidates.single.raw.id);
    final hidden = await session.compose();
    expect((await pixel(hidden.bytes, 20, 20)).take(3), [32, 64, 128]);
    session.toggleVisible(session.candidates.single.raw.id);
    session.dispose();
    await c.closeStorage();
    c.dispose();

    assets = await openImageAssetStore(directory: '${dir.path}/assets');
    store = await SQLiteWorkspaceStore.open(
      factory: databaseFactoryFfi,
      path: '${dir.path}/workspace.sqlite',
    );
    c = WorkbenchController(
      store: store,
      assets: assets,
      restored: await store.load(),
    );
    session = ImageEditingSession(
      assets: assets,
      onPersist: c.updateImageEditing,
      restored: c.imageEditing,
    );
    expect(session.candidates.length, 1);
    expect(session.document!.strokes.length, 1);
    expect(await assets.read(c.selected.assetRef!), bytes);
    expect((await pixel((await session.compose()).bytes, 20, 20)).take(3), [
      224,
      80,
      64,
    ]);
    c.applyResult(c.selected);
    session.restore(c.imageEditing);
    expect(session.document!.sourceAssetRef, source.assetRef);
    expect(session.document!.strokes.length, 1);
    expect(c.parameters.sourceImageId, frozen.sourceRef);
    session.dispose();
    await c.closeStorage();
    c.dispose();
  });

  test(
    'cancelled edit request never publishes a candidate or replaces its source',
    () async {
      final dir = await Directory('.tmp').createTemp('editing-cancel-');
      addTearDown(() => dir.delete(recursive: true));
      final assets = await openImageAssetStore(directory: '${dir.path}/assets');
      final source = await assets.save(await solid(0xff204080));
      final output = await assets.save(await solid(0xffe05040));
      final gate = Completer<void>(), received = Completer<void>();
      final c = WorkbenchController(
        assets: assets,
        generateImage: (p, _) async {
          received.complete();
          await gate.future;
          return result(output.assetRef, p);
        },
      );
      final session = ImageEditingSession(
        assets: assets,
        onPersist: c.updateImageEditing,
      );
      session.setSource(source);
      session.addStroke(
        InpaintStroke(
          target: InpaintTarget.mask,
          operation: InpaintOperation.paint,
          geometry: InpaintGeometry.rectangle,
          size: 8,
          rectangle: const ui.Rect.fromLTWH(16, 16, 16, 16),
        ),
      );
      final frozen = await session.prepare(64, 64);
      final run = c.generate(
        processResult: (raw, current) =>
            session.acceptResult(raw, frozen, current),
      );
      await received.future;
      c.cancelGeneration();
      gate.complete();
      await run;
      expect(c.results.length, 3);
      expect(session.candidates, isEmpty);
      expect(session.document!.sourceAssetRef, source.assetRef);
      session.dispose();
      await c.closeStorage();
      c.dispose();
    },
  );

  test(
    'late response remains attached to its frozen source after editor switches',
    () async {
      final dir = await Directory('.tmp').createTemp('editing-source-binding-');
      addTearDown(() => dir.delete(recursive: true));
      final assets = await openImageAssetStore(directory: '${dir.path}/assets');
      final original = await assets.save(await solid(0xff204080));
      final next = await assets.save(await solid(0xff208060));
      final generated = await assets.save(await solid(0xffe05040));
      final session = ImageEditingSession(assets: assets, onPersist: (_) {});
      session.setSource(original, parentId: 'original-parent');
      session.addStroke(
        InpaintStroke(
          target: InpaintTarget.mask,
          operation: InpaintOperation.paint,
          geometry: InpaintGeometry.rectangle,
          size: 8,
          rectangle: const ui.Rect.fromLTWH(16, 16, 16, 16),
        ),
      );
      final frozen = await session.prepare(64, 64);
      session.setSource(next, parentId: 'new-parent');
      final edited = await session.acceptResult(
        result(
          generated.assetRef,
          GenerationParameters(
            model: 'nai-diffusion-4-5-full',
            prompt: 'fixture',
            width: 64,
            height: 64,
          ),
        ),
        frozen,
        () => true,
      );
      expect(session.candidates, isEmpty);
      expect(session.document!.sourceAssetRef, next.assetRef);
      expect(edited.editMetadata!['parentAssetRef'], original.assetRef);
      expect(edited.editMetadata!['parentResultId'], 'original-parent');
      expect((await pixel(await assets.read(edited.assetRef!), 2, 2)).take(3), [
        32,
        64,
        128,
      ]);
      session.dispose();
      await assets.close();
    },
  );
}

SceneResult result(String ref, GenerationParameters p) => SceneResult(
  id: 'fixture-result',
  title: 'synthetic edit',
  prompt: p.prompt,
  negative: p.negativePrompt ?? '',
  width: 64,
  height: 64,
  seed: p.seed ?? 0,
  variant: 0,
  favorite: false,
  isDemo: false,
  assetRef: ref,
  parameters: p,
);

Future<Uint8List> solid(int color) async {
  final recorder = ui.PictureRecorder();
  final canvas = ui.Canvas(recorder);
  canvas.drawColor(ui.Color(color), ui.BlendMode.src);
  final picture = recorder.endRecording(),
      image = await picture.toImage(64, 64);
  final bytes = (await image.toByteData(format: ui.ImageByteFormat.png))!.buffer
      .asUint8List();
  image.dispose();
  picture.dispose();
  return bytes;
}

Future<List<int>> pixel(Uint8List png, int x, int y) async {
  final codec = await ui.instantiateImageCodec(png);
  final image = (await codec.getNextFrame()).image;
  final data = await image.toByteData(format: ui.ImageByteFormat.rawRgba);
  final offset = (y * image.width + x) * 4;
  final values = List<int>.generate(4, (i) => data!.getUint8(offset + i));
  image.dispose();
  codec.dispose();
  return values;
}

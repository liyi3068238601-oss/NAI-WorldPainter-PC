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

  for (final scenario in [(0, 0), (null, 1), (123, 2)]) {
    test(
      'composite draft seed ${scenario.$1}, ${scenario.$2} layers reopens intact',
      () async {
        final dir = await Directory('.tmp').createTemp('composite-snapshot-');
        addTearDown(() => dir.delete(recursive: true));
        var assets = await openImageAssetStore(directory: '${dir.path}/assets');
        var store = await SQLiteWorkspaceStore.open(
          factory: databaseFactoryFfi,
          path: '${dir.path}/workspace.sqlite',
        );
        var c = WorkbenchController(store: store, assets: assets);
        final sourceBytes = await _png(64, 64, 0xff204080);
        final source = await assets.save(sourceBytes);
        var editor = ImageEditingSession(
          assets: assets,
          onPersist: c.updateImageEditing,
        );
        editor.setSource(source, parentId: 'synthetic-parent');
        editor.changeDocument(editor.document!.copyWith(featherPixels: 0));
        editor.addStroke(
          InpaintStroke(
            target: InpaintTarget.mask,
            operation: InpaintOperation.paint,
            geometry: InpaintGeometry.rectangle,
            size: 8,
            rectangle: const ui.Rect.fromLTWH(16, 16, 8, 8),
          ),
        );
        final candidates = <EditCandidate>[];
        for (var i = 0; i < scenario.$2; i++) {
          final layer = await assets.save(
            await _png(32, 64, i == 0 ? 0xffe05040 : 0xff40d050),
          );
          candidates.add(
            EditCandidate(
              raw: _record('layer-$i', _params(seed: 991 + i), layer.assetRef),
              compositeRef: layer.assetRef,
              layerRef: layer.assetRef,
              worldRect: ui.Rect.fromLTWH(i * 32.0, 0, 32, 64),
            ),
          );
        }
        editor.restore({
          ...editor.snapshot(),
          'candidates': candidates.map((v) => v.toJson()).toList(),
          'primaryId': candidates.firstOrNull?.raw.id,
        });
        final draft = _params(seed: scenario.$1);
        final saved = await editor.saveComposite(
          draft,
          model: 'NAI Diffusion 4.5 Full',
          provider: '7877 网关',
        );
        expect(saved.parameters!.seed, scenario.$1);
        expect(saved.editMetadata!['actualSeed'], isNull);
        expect(saved.generationSeedDetails.length, scenario.$2);
        expect(saved.prompt, draft.prompt);
        expect((saved.width, saved.height), (64, 64));
        expect(
          (saved.parameters!.width, saved.parameters!.height),
          (832, 1216),
        );
        c.addDerived(saved);
        c.applyResult(saved);
        _expectDraft(c, draft, source.assetRef);
        final output = await assets.read(saved.assetRef!);
        expect(
          (await _pixel(output, 8, 8)).take(3),
          scenario.$2 == 0 ? [32, 64, 128] : [224, 80, 64],
        );
        if (scenario.$2 == 2) {
          expect((await _pixel(output, 48, 8)).take(3), [64, 208, 80]);
        }
        editor.dispose();
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
        c.applyResult(c.selected);
        _expectDraft(c, draft, source.assetRef);
        editor = ImageEditingSession(
          assets: assets,
          onPersist: c.updateImageEditing,
          restored: c.imageEditing,
        );
        expect(editor.candidates.length, scenario.$2);
        expect(editor.document!.strokes.length, 1);
        expect(await assets.read(source.assetRef), sourceBytes);
        expect(await assets.read(c.selected.assetRef!), output);
        expect((await editor.compose()).bytes, output);
        editor.dispose();
        await c.closeStorage();
        c.dispose();
      },
    );
  }

  test(
    'save freezes pixels, visible layers and metadata before asynchronous read',
    () async {
      final dir = await Directory('.tmp').createTemp('composite-freeze-');
      addTearDown(() => dir.delete(recursive: true));
      final backing = await openImageAssetStore(
        directory: '${dir.path}/assets',
      );
      final assets = _GatedAssets(backing);
      final source = await assets.save(await _png(64, 64, 0xff204080));
      final red = await assets.save(await _png(64, 64, 0xffe05040));
      final other = await assets.save(await _png(64, 64, 0xff40d050));
      final editor = ImageEditingSession(assets: assets, onPersist: (_) {});
      editor.setSource(source, parentId: 'before');
      final candidate = EditCandidate(
        raw: _record('candidate', _params(seed: 99), red.assetRef),
        compositeRef: red.assetRef,
        layerRef: red.assetRef,
        worldRect: const ui.Rect.fromLTWH(0, 0, 64, 64),
      );
      editor.restore({
        ...editor.snapshot(),
        'candidates': [candidate.toJson()],
        'primaryId': 'candidate',
      });
      assets.block = true;
      final task = editor.saveComposite(
        _params(seed: null),
        model: 'NAI Diffusion 4.5 Full',
        provider: '7877 网关',
      );
      await assets.entered.future;
      editor.toggleVisible('candidate');
      editor.setSource(other, parentId: 'after');
      assets.release.complete();
      final result = await task;
      expect(result.parameters!.seed, isNull);
      expect(result.editMetadata!['parentAssetRef'], source.assetRef);
      expect(result.editMetadata!['parentResultId'], 'before');
      final session = result.editMetadata!['session'] as Map;
      expect(
        ((session['candidates'] as List).single as Map)['visible'],
        isTrue,
      );
      expect(
        (await _pixel(await assets.read(result.assetRef!), 10, 10)).take(3),
        [224, 80, 64],
      );
      expect(editor.document!.sourceAssetRef, other.assetRef);
      editor.dispose();
      await assets.close();
    },
  );

  test('legacy missing composite snapshot restores known source and preserves unknown fields', () {
    final c = WorkbenchController();
    addTearDown(c.dispose);
    c.updateAdvanced(_params(seed: 777));
    c.setSize(768, 1024);
    c.updateSeed('777');
    final legacy = _record(
      'legacy',
      null,
      'synthetic-output',
      metadata: {
        'operation': 'inpaintComposite',
        'parentAssetRef': 'synthetic-source',
        'session': {
          'version': 1,
          'document': InpaintDocument(
            sourceAssetRef: 'synthetic-source',
            sourceWidth: 64,
            sourceHeight: 64,
          ).toJson(),
          'candidates': [],
          'undo': [],
          'redo': [],
        },
      },
    );
    c.applyResult(legacy);
    expect(c.parameters.operation, GenerationOperation.inpaint);
    expect(c.parameters.sourceImageId, 'synthetic-source');
    expect(c.parameters.cfgRescale, .25);
    expect(c.parameters.inpaintStrength, .6);
    expect(c.parameters.sampler, 'k_dpmpp_2m');
    expect((c.width, c.height), (768, 1024));
    expect(c.seedText, '777');
    expect(legacy.seedDescription, contains('未知'));
    expect(legacy.refillNotice, contains('未知'));
    expect(
      legacy.parameters,
      isNull,
      reason: 'Do not mutate old history into a fabricated snapshot',
    );
  });

  test('legacy session snapshot and candidate provenance remain distinct', () {
    final c = WorkbenchController();
    addTearDown(c.dispose);
    final p = _params(seed: null);
    final legacy = _record(
      'legacy-session',
      null,
      'synthetic-output',
      metadata: {
        'operation': 'inpaintComposite',
        'session': {'generationParameters': p.toJson()},
      },
    );
    c.applyResult(legacy);
    expect(c.seedText, isEmpty);
    expect(c.parameters.cfgRescale, .25);
    final candidateOnly = _record(
      'legacy-candidate',
      _params(seed: 0),
      'synthetic-output',
      metadata: {
        'operation': 'inpaintComposite',
        'session': {
          'version': 1,
          'primaryId': 'only',
          'candidates': [
            {
              'raw': {'id': 'only', 'seed': 0},
              'visible': true,
            },
          ],
        },
      },
    );
    c.applyResult(candidateOnly);
    expect(c.seedText, '0');
    expect(candidateOnly.refillNotice, contains('候选图'));
  });

  for (final otherVisible in [false, true]) {
    test(
      'legacy hidden primary parameters do not describe visible=$otherVisible composite',
      () {
        final c = WorkbenchController();
        addTearDown(c.dispose);
        c.updateSeed('777');
        c.updateAdvanced(_params(seed: 777).copyWith(cfgRescale: .4));
        final old = _record(
          'legacy-hidden',
          _params(seed: 99),
          'synthetic-output',
          metadata: {
            'operation': 'inpaintComposite',
            'session': {
              'version': 1,
              'primaryId': 'primary',
              'candidates': [
                {
                  'raw': {'id': 'primary'},
                  'visible': false,
                },
                {
                  'raw': {'id': 'other'},
                  'visible': otherVisible,
                },
              ],
            },
          },
        );
        c.applyResult(old);
        expect(old.refillParameters, isNull);
        expect(c.seedText, '777');
        expect(c.parameters.cfgRescale, .4);
        expect(old.refillNotice, contains('未知'));
      },
    );
  }

  test(
    'legacy multiple layers never substitute primary parameters for the draft',
    () {
      final c = WorkbenchController();
      addTearDown(c.dispose);
      c.updateAdvanced(_params(seed: null).copyWith(cfgRescale: .4));
      c.updateSeed('');
      final old = _record(
        'legacy-multiple',
        _params(seed: 99),
        'synthetic-output',
        metadata: {
          'operation': 'inpaintComposite',
          'session': {
            'version': 1,
            'document': InpaintDocument(
              sourceAssetRef: 'session-source',
              sourceWidth: 64,
              sourceHeight: 64,
            ).toJson(),
            'candidates': [
              {'visible': true},
              {'visible': true},
            ],
          },
        },
      );
      c.applyResult(old);
      expect(old.refillParameters, isNull);
      expect(old.seedDescription, contains('未知'));
      expect(c.seedText, isEmpty);
      expect(c.parameters.cfgRescale, .4);
      expect(c.parameters.sourceImageId, 'session-source');
      expect(old.parameters!.seed, 99);
    },
  );
}

GenerationParameters _params({required int? seed}) => GenerationParameters(
  operation: GenerationOperation.inpaint,
  model: 'nai-diffusion-4-5-full',
  prompt: 'synthetic current draft',
  negativePrompt: 'synthetic negative',
  width: 832,
  height: 1216,
  steps: 31,
  scale: 5.7,
  cfgRescale: .25,
  sampler: 'k_dpmpp_2m',
  noiseSchedule: 'exponential',
  seed: seed,
  inpaintStrength: .6,
);

SceneResult _record(
  String id,
  GenerationParameters? p,
  String ref, {
  Map<String, Object?>? metadata,
}) => SceneResult(
  id: id,
  title: id,
  prompt: p?.prompt ?? 'legacy prompt',
  negative: p?.negativePrompt ?? '',
  width: 64,
  height: 64,
  seed: p?.seed ?? 0,
  variant: 0,
  favorite: false,
  isDemo: false,
  assetRef: ref,
  parameters: p,
  editMetadata: metadata,
);

void _expectDraft(
  WorkbenchController c,
  GenerationParameters p,
  String sourceRef,
) {
  expect(c.seedText, p.seed?.toString() ?? '');
  expect(c.parameters.toJson(), p.copyWith(sourceImageId: sourceRef).toJson());
}

Future<Uint8List> _png(int width, int height, int color) async {
  final r = ui.PictureRecorder();
  ui.Canvas(r).drawColor(ui.Color(color), ui.BlendMode.src);
  final picture = r.endRecording(),
      image = await picture.toImage(width, height);
  final bytes = (await image.toByteData(format: ui.ImageByteFormat.png))!.buffer
      .asUint8List();
  image.dispose();
  picture.dispose();
  return bytes;
}

Future<List<int>> _pixel(Uint8List bytes, int x, int y) async {
  final codec = await ui.instantiateImageCodec(bytes),
      image = (await codec.getNextFrame()).image;
  final data = (await image.toByteData(format: ui.ImageByteFormat.rawRgba))!
      .buffer
      .asUint8List();
  final value = data.sublist(
    (y * image.width + x) * 4,
    (y * image.width + x) * 4 + 4,
  );
  image.dispose();
  codec.dispose();
  return value;
}

class _GatedAssets implements ImageAssetStore {
  _GatedAssets(this.inner);
  final ImageAssetStore inner;
  final entered = Completer<void>(), release = Completer<void>();
  bool block = false;
  @override
  String get label => inner.label;
  @override
  Future<ImageAsset> save(Uint8List bytes) => inner.save(bytes);
  @override
  Future<Uint8List> read(String ref) async {
    if (block) {
      block = false;
      entered.complete();
      await release.future;
    }
    return inner.read(ref);
  }

  @override
  Future<void> close() => inner.close();
}

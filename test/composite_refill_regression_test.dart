// Isolated QA regressions: invoke the production save-composite callback,
// real PNG asset store and controller refill. No generation service is called.
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:worldpainter_pc/editing/inpaint_workspace.dart';
import 'package:worldpainter_pc/generation/generation_parameters.dart';
import 'package:worldpainter_pc/main.dart';
import 'package:worldpainter_pc/media/image_asset_store.dart';
import 'package:worldpainter_pc/prototype/workbench_controller.dart';

void main() {
  for (final fixedSeed in [0, 123]) {
    test(
      'control: generated parameter snapshot preserves fixed seed $fixedSeed',
      () {
        final c = WorkbenchController();
        addTearDown(c.dispose);
        final parameters = GenerationParameters(
          operation: GenerationOperation.inpaint,
          model: 'nai-diffusion-4-5-full',
          prompt: 'synthetic generated record',
          width: 832,
          height: 1216,
          cfgRescale: 0.25,
          seed: fixedSeed,
        );
        final generated = SceneResult(
          id: 'control-$fixedSeed',
          title: 'Synthetic service result',
          prompt: parameters.prompt,
          negative: '',
          width: 832,
          height: 1216,
          seed: fixedSeed,
          variant: 0,
          favorite: false,
          isDemo: false,
          parameters: parameters,
        );
        c.addDerived(generated);
        c.applyResult(c.selected);
        expect(c.seedText, fixedSeed.toString());
        expect(c.parameters.operation, GenerationOperation.inpaint);
        expect(c.parameters.cfgRescale, 0.25);
      },
    );
  }
  for (final field in ['random seed', 'operation', 'advanced parameters']) {
    testWidgets('ungenerated composite full refill preserves $field', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(1600, 1200);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final dir = (await tester.runAsync(
        () => Directory('.tmp').createTemp('composite-refill-qa-'),
      ))!;
      final assets = (await tester.runAsync(
        () => openImageAssetStore(directory: '${dir.path}/assets'),
      ))!;
      final source = (await tester.runAsync(() async {
        final recorder = ui.PictureRecorder();
        ui.Canvas(recorder)
            .drawColor(const ui.Color(0xff204080), ui.BlendMode.src);
        final picture = recorder.endRecording();
        final image = await picture.toImage(64, 64);
        final data = (await image.toByteData(format: ui.ImageByteFormat.png))!;
        final asset = await assets.save(data.buffer.asUint8List());
        image.dispose();
        picture.dispose();
        return asset;
      }))!;
      var generationCalls = 0;
      final c = WorkbenchController(
        assets: assets,
        generateImage: (_, _) async {
          generationCalls++;
          throw StateError('This test must never generate');
        },
      );
      await tester.pumpWidget(WorldPainterApp(controller: c));
      await tester.pumpAndSettle();
      c.updateAdvanced(
        c.parameters.copyWith(
          operation: GenerationOperation.inpaint,
          sourceImageId: source.assetRef,
          cfgRescale: 0.25,
          inpaintStrength: 0.6,
        ),
      );
      c.updateSeed('');
      c.updatePrompt('synthetic QA composite');
      await tester.pumpAndSettle();
      var workspace = tester.widget<InpaintWorkspace>(
        find.byType(InpaintWorkspace),
      );
      await tester.runAsync(() async {
        workspace.session.setSource(source);
        await Future<void>.delayed(const Duration(milliseconds: 300));
      });
      await tester.pumpAndSettle();
      workspace = tester.widget<InpaintWorkspace>(
        find.byType(InpaintWorkspace),
      );
      expect(workspace.session.candidates, isEmpty);
      expect(c.seedText, isEmpty);
      expect(c.parameters.operation, GenerationOperation.inpaint);
      expect(c.parameters.cfgRescale, 0.25);
      final before = c.results.length;
      await tester.runAsync(workspace.onSaveComposite);
      await tester.pumpAndSettle();
      expect(
        c.results.length,
        before + 1,
        reason: 'Production save must succeed',
      );
      final saved = c.selected;
      expect(saved.title, '重绘合成作品');
      expect(saved.editMetadata?['operation'], 'inpaintComposite');
      expect(saved.assetRef, isNotNull);
      expect(saved.isDemo, isFalse);
      expect(generationCalls, 0);
      c.applyResult(saved);
      final actualSeed = c.seedText;
      final actualOperation = c.parameters.operation;
      final actualRescale = c.parameters.cfgRescale;
      // Keep diagnostic evidence even when the desired invariant fails.
      debugPrint(
        'QA composite: savedSeed=${saved.seed}, '
        'savedParameters=${saved.parameters?.toJson()}, '
        'refillSeed=$actualSeed, refillOperation=$actualOperation, '
        'refillCfgRescale=$actualRescale, generationCalls=$generationCalls',
      );
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.runAsync(() async {
        await assets.close();
        await dir.delete(recursive: true);
      });
      if (field == 'random seed') {
        expect(
          actualSeed,
          isEmpty,
          reason: 'Saving without generation must not invent fixed seed 0',
        );
      } else if (field == 'operation') {
        expect(
          actualOperation,
          GenerationOperation.inpaint,
          reason: 'Full parameter refill must retain the editing operation',
        );
      } else {
        expect(
          actualRescale,
          0.25,
          reason: 'Full parameter refill must retain the saved advanced draft',
        );
      }
    });
  }
}

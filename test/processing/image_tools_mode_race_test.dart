import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:worldpainter_pc/generation/generation_parameters.dart';
import 'package:worldpainter_pc/media/image_asset_store.dart';
import 'package:worldpainter_pc/prototype/workbench_controller.dart';

void main() {
  test('mode changed during processing does not attach the late result', () async {
    final callbackEntered = Completer<void>();
    final finishCallback = Completer<void>();
    final controller = WorkbenchController(
      processImageTool:
          (draft, parameters, connection, onProgress, isCurrent) async {
            callbackEntered.complete();
            await finishCallback.future;
            return _result(
              id: 'late-tiled-result',
              assetRef: 'asset:late-tiled-result',
            );
          },
    );
    addTearDown(controller.dispose);
    controller.setImageToolSource(_source());

    final run = controller.runImageTool();
    await callbackEntered.future;
    controller.updateImageTools({...controller.imageTools, 'mode': 'director'});
    finishCallback.complete();
    await run;

    expect(controller.imageTools['mode'], 'director');
    expect(controller.imageTools['resultAssetRef'], isNull);
    expect(controller.imageTools['resultId'], isNull);
    expect(controller.imageTools['resultWidth'], isNull);
    expect(controller.imageTools['resultHeight'], isNull);
    expect(
      controller.results.any((result) => result.id == 'late-tiled-result'),
      isTrue,
      reason:
          'the completed image remains in Gallery even when the draft changed',
    );
  });

  test(
    'changing mode after completion clears refs but keeps Gallery result',
    () async {
      final controller = WorkbenchController(
        processImageTool:
            (draft, parameters, connection, onProgress, isCurrent) async =>
                _result(
                  id: 'completed-tiled-result',
                  assetRef: 'asset:completed-tiled-result',
                  width: 128,
                  height: 96,
                ),
      );
      addTearDown(controller.dispose);
      controller.setImageToolSource(_source());

      await controller.runImageTool();
      expect(
        controller.imageTools['resultAssetRef'],
        'asset:completed-tiled-result',
      );
      expect(controller.imageTools['resultId'], 'completed-tiled-result');
      expect(controller.imageTools['resultWidth'], 128);
      expect(controller.imageTools['resultHeight'], 96);

      controller.updateImageTools({
        ...controller.imageTools,
        'mode': 'director',
      });

      expect(controller.imageTools['mode'], 'director');
      expect(controller.imageTools['resultAssetRef'], isNull);
      expect(controller.imageTools['resultId'], isNull);
      expect(controller.imageTools['resultWidth'], isNull);
      expect(controller.imageTools['resultHeight'], isNull);
      expect(
        controller.results.any(
          (result) =>
              result.id == 'completed-tiled-result' &&
              result.assetRef == 'asset:completed-tiled-result',
        ),
        isTrue,
        reason: 'changing the active tool draft must not remove the saved Gallery item',
      );
    },
  );
}

ImageAsset _source() => const ImageAsset(
  id: 'source-hash',
  assetRef: 'asset:source',
  width: 64,
  height: 64,
  mime: 'image/png',
  sha256: 'source-hash',
  byteLength: 1,
);

SceneResult _result({
  required String id,
  required String assetRef,
  int width = 64,
  int height = 64,
}) => SceneResult(
  id: id,
  title: 'fixture',
  prompt: 'fixture prompt',
  negative: '',
  width: width,
  height: height,
  seed: 0,
  variant: 0,
  favorite: false,
  isDemo: false,
  assetRef: assetRef,
  parameters: GenerationParameters(
    model: 'nai-diffusion-4-5-full',
    prompt: 'fixture prompt',
    width: 64,
    height: 64,
  ),
);

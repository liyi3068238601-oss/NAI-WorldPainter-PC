import 'package:flutter_test/flutter_test.dart';
import 'package:worldpainter_pc/generation/generation_parameters.dart';
import 'package:worldpainter_pc/media/image_asset_store.dart';
import 'package:worldpainter_pc/prototype/workbench_controller.dart';

void main() {
  test('local SR result refills the parent generation settings', () {
    final controller = WorkbenchController();
    addTearDown(controller.dispose);
    controller.updateProvider('7877 网关');

    final parent = _parentParameters();
    final result = SceneResult(
      id: 'local-sr-result',
      title: '本地超分',
      prompt: parent.prompt,
      negative: parent.negativePrompt!,
      width: 3328,
      height: 4864,
      seed: parent.seed!,
      variant: 0,
      favorite: false,
      isDemo: false,
      model: 'realesrganAnime4x',
      provider: 'Windows 本地超分',
      steps: parent.steps,
      cfg: parent.scale,
      assetRef: 'asset:local-sr-result',
      parameters: parent,
      editMetadata: {
        'imageTools': _toolSnapshot(
          mode: 'localSr',
          generationProtocol: 'gateway7877',
          postprocess: {
            'operation': 'local_sr',
            'source_asset_ref': 'asset:source',
            'width': 832,
            'height': 1216,
            'model': 'realesrganAnime4x',
            'scale': 4,
          },
        ),
      },
    );

    controller.applyResult(result);

    _expectParentSettings(controller, parent);
    expect(controller.seedText, '24680');
    expect(controller.provider, '7877 网关');
    expect(controller.imageTools['active'], isTrue);
    expect(controller.imageTools['mode'], 'localSr');
  });

  test(
    'Enhance result keeps the actual random seed and refills parent settings',
    () {
      final controller = WorkbenchController();
      addTearDown(controller.dispose);
      controller.updateProvider('ikun 网关');

      final parent = _parentParameters().copyWith(clearSeed: true);
      const actualEnhanceSeed = 4294967001;
      final result = SceneResult(
        id: 'enhance-result',
        title: 'Enhance 重绘增强',
        prompt: 'effective enhance prompt',
        negative: 'effective enhance negative',
        width: 1248,
        height: 1824,
        seed: actualEnhanceSeed,
        variant: 0,
        favorite: false,
        isDemo: false,
        model: 'nai-diffusion-5-curated',
        provider: 'NovelAI 官方',
        steps: 18,
        cfg: 6.4,
        assetRef: 'asset:enhance-result',
        parameters: parent,
        editMetadata: {
          'imageTools': _toolSnapshot(
            mode: 'enhance',
            generationProtocol: 'ikun',
            postprocess: {
              'operation': 'enhance',
              'source_asset_ref': 'asset:source',
              'width': 832,
              'height': 1216,
              'model': 'nai-diffusion-5-curated',
              'prompt': 'effective enhance prompt',
              'negative_prompt': 'effective enhance negative',
              'strength': 0.35,
              'noise': 0.04,
              'scale': 1.5,
              'guidance': 6.4,
              'steps': 18,
              'seed': actualEnhanceSeed,
              'upscaled_enhance': false,
            },
          ),
        },
      );

      controller.applyResult(result);

      _expectParentSettings(
        controller,
        parent.copyWith(seed: actualEnhanceSeed),
      );
      expect(controller.seedText, '$actualEnhanceSeed');
      expect(controller.provider, 'ikun 网关');
      expect(controller.imageTools['active'], isTrue);
      expect(
        (controller.imageTools['postprocess'] as Map)['seed'],
        actualEnhanceSeed,
      );
    },
  );

  test('result without tool metadata deactivates the previous tool draft', () {
    final controller = WorkbenchController();
    addTearDown(controller.dispose);
    controller.setImageToolSource(_sourceAsset());

    controller.applyResult(
      SceneResult(
        id: 'ordinary-result',
        title: 'ordinary',
        prompt: 'ordinary prompt',
        negative: '',
        width: 832,
        height: 1216,
        seed: 1,
        variant: 0,
        favorite: false,
        isDemo: false,
      ),
    );

    expect(controller.imageTools['active'], isFalse);
    expect(controller.imageTools['sourceAssetRef'], 'asset:source');
  });
}

GenerationParameters _parentParameters() => GenerationParameters(
  model: 'nai-diffusion-4-5-full',
  prompt: 'parent generation prompt',
  negativePrompt: 'parent negative prompt',
  width: 832,
  height: 1216,
  steps: 31,
  scale: 5.7,
  seed: 24680,
);

Map<String, Object?> _toolSnapshot({
  required String mode,
  required String generationProtocol,
  required Map<String, Object?> postprocess,
}) => {
  'version': 1,
  'mode': mode,
  'active': true,
  'sourceAssetRef': 'asset:source',
  'sourceWidth': 832,
  'sourceHeight': 1216,
  'strength': 0.3,
  'generationProtocol': generationProtocol,
  'postprocess': postprocess,
};

void _expectParentSettings(
  WorkbenchController controller,
  GenerationParameters parent,
) {
  expect(controller.prompt, parent.prompt);
  expect(controller.negative, parent.negativePrompt);
  expect(controller.model, 'NAI Diffusion 4.5 Full');
  expect(controller.width, parent.width);
  expect(controller.height, parent.height);
  expect(controller.steps, parent.steps);
  expect(controller.cfg, parent.scale);
  expect(controller.parameters.toJson(), parent.toJson());
}

ImageAsset _sourceAsset() => const ImageAsset(
  id: 'source',
  assetRef: 'asset:source',
  width: 832,
  height: 1216,
  mime: 'image/png',
  sha256: 'source-hash',
  byteLength: 1,
);

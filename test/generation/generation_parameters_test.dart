import 'package:flutter_test/flutter_test.dart';
import 'package:worldpainter_pc/generation/generation_parameters.dart';

void main() {
  group('GenerationParameters', () {
    test('round trips the full single-image snapshot', () {
      final parameters = GenerationParameters(
        operation: GenerationOperation.imageToImage,
        model: 'nai-diffusion-4-5-curated',
        prompt: '1girl, outdoors',
        negativePrompt: 'low quality',
        width: 1216,
        height: 832,
        steps: 26,
        scale: 5.5,
        cfgRescale: 0.2,
        sampler: 'k_euler_ancestral',
        noiseSchedule: 'exponential',
        seed: 42,
        useCoords: true,
        characters: [
          GenerationCharacter(
            prompt: 'silver hair',
            negativePrompt: 'black hair',
            centerX: 0.3,
            centerY: 0.6,
            referenceImages: const [
              GenerationCharacterReference(
                assetId: 'asset-role-1',
                strength: 0.8,
              ),
            ],
          ),
        ],
        vibeReferences: const [
          VibeReference(
            assetId: 'asset-vibe-1',
            strength: 0.4,
            informationExtracted: 0.7,
            encodedVibe: 'encoded-test-value',
          ),
        ],
        preciseReferences: const [
          PreciseReference(
            assetId: 'asset-precise-1',
            referenceType: 'character',
            strength: 0.9,
          ),
        ],
        img2imgSourceImageId: 'asset-source-1',
        img2imgStrength: 0.65,
      );

      final restored = GenerationParameters.fromJson(parameters.toJson());

      expect(restored.toJson(), parameters.toJson());
    });

    test('copyWith can clear nullable generation inputs', () {
      final original = GenerationParameters(
        model: 'nai-diffusion-4-5-curated',
        prompt: 'test',
        negativePrompt: 'bad hands',
        width: 832,
        height: 1216,
        seed: 123,
        sourceImageId: 'source',
        maskImageId: 'mask',
        img2imgSourceImageId: 'img2img',
        img2imgStrength: 0.7,
        inpaintStrength: 0.8,
      );

      final cleared = original.copyWith(
        clearNegativePrompt: true,
        clearSeed: true,
        clearSourceImageId: true,
        clearMaskImageId: true,
        clearImg2imgSourceImageId: true,
        clearImg2imgStrength: true,
        clearInpaintStrength: true,
      );

      expect(cleared.negativePrompt, isNull);
      expect(cleared.seed, isNull);
      expect(cleared.sourceImageId, isNull);
      expect(cleared.maskImageId, isNull);
      expect(cleared.img2imgSourceImageId, isNull);
      expect(cleared.img2imgStrength, isNull);
      expect(cleared.inpaintStrength, isNull);
      expect(original.seed, 123);
      expect(original.sourceImageId, 'source');
    });

    test('copies nested collections into immutable lists', () {
      final characters = <GenerationCharacter>[
        GenerationCharacter(prompt: 'first'),
      ];
      final parameters = GenerationParameters(
        model: 'nai-diffusion-4-5-curated',
        prompt: 'test',
        width: 832,
        height: 1216,
        characters: characters,
      );

      characters.add(GenerationCharacter(prompt: 'later mutation'));

      expect(parameters.characters, hasLength(1));
      expect(
        () => parameters.characters.add(GenerationCharacter(prompt: 'blocked')),
        throwsUnsupportedError,
      );
    });
  });
}

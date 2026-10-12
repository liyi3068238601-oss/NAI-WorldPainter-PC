import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:worldpainter_pc/generation/generation_parameters.dart';
import 'package:worldpainter_pc/generation/generation_runtime.dart';
import 'package:worldpainter_pc/generation/service_connection.dart';
import 'package:worldpainter_pc/media/image_asset_store.dart';
import 'package:worldpainter_pc/processing/image_tools_runtime.dart';
import 'package:worldpainter_pc/prototype/workbench_controller.dart';
import 'package:worldpainter_pc/security/credential_vault_web.dart';

void main() {
  test(
    'non-generation post-processing does not validate an unrelated seed',
    () async {
      final calls = <String>[];
      final controller = WorkbenchController(
        processImageTool:
            (draft, parameters, connection, onProgress, isCurrent) async {
              calls.add(draft['mode']! as String);
              return SceneResult(
                id: 'result-${draft['mode']}',
                title: 'fixture',
                prompt: parameters.prompt,
                negative: parameters.negativePrompt ?? '',
                width: 64,
                height: 64,
                seed: 0,
                variant: 0,
                favorite: false,
                isDemo: false,
                parameters: parameters,
              );
            },
      );
      addTearDown(controller.dispose);
      controller.setImageToolSource(_asset());
      controller.updateSeed('not-a-seed');

      for (final mode in ['upscale', 'director', 'localSr']) {
        controller.updateImageTools({
          ...controller.imageTools,
          'mode': mode,
          'postprocess': _parametersFor(mode),
        });
        await controller.runImageTool();
      }

      expect(calls, ['upscale', 'director', 'localSr']);
      expect(controller.results, hasLength(6));
      expect(controller.imageToolJob['status'], 'completed');
    },
  );

  test('local SR draft with Director parameters is rejected before source read or HTTP', () async {
    final assets = _NeverReadAssetStore();
    final vault = SessionMemoryCredentialVault();
    final generation = GenerationRuntime(assets: assets, vault: vault);
    var clientCreated = false;
    var httpRequests = 0;
    final runtime = ImageToolsRuntime(
      assets: assets,
      vault: vault,
      generation: generation,
      clientFactory: () {
        clientCreated = true;
        return MockClient((_) async {
          httpRequests++;
          return http.Response('', 500);
        });
      },
    );
    final connection = ServiceConnection(
      protocol: 'official',
      baseUrl: ServiceConnection.officialUrl,
    );

    await expectLater(
      runtime.process(
        {
          'mode': 'localSr',
          'sourceAssetRef': 'asset:source',
          'sourceWidth': 64,
          'sourceHeight': 64,
          'postprocess': {
            'operation': 'director',
            'source_asset_ref': 'asset:source',
            'width': 64,
            'height': 64,
            'director_tool': 'declutter',
          },
        },
        GenerationParameters(
          model: 'nai-diffusion-4-5-full',
          prompt: 'fixture',
          width: 64,
          height: 64,
        ),
        connection,
        (_, _, _) async {},
        () => true,
      ),
      throwsA(
        isA<FormatException>().having(
          (error) => error.message,
          'message',
          contains('处理方式与参数不一致'),
        ),
      ),
    );

    expect(assets.readCount, 0);
    expect(clientCreated, isFalse);
    expect(httpRequests, 0);
  });
}

Map<String, Object?> _parametersFor(String mode) => switch (mode) {
  'upscale' => {
    'operation': 'upscale',
    'source_asset_ref': 'asset:source',
    'width': 64,
    'height': 64,
    'scale': 2,
  },
  'director' => {
    'operation': 'director',
    'source_asset_ref': 'asset:source',
    'width': 64,
    'height': 64,
    'director_tool': 'declutter',
  },
  'localSr' => {
    'operation': 'local_sr',
    'source_asset_ref': 'asset:source',
    'width': 64,
    'height': 64,
    'model': 'realcuganConservative2x',
    'scale': 2,
  },
  _ => throw ArgumentError.value(mode, 'mode'),
};

ImageAsset _asset() => const ImageAsset(
  id: 'source-hash',
  assetRef: 'asset:source',
  width: 64,
  height: 64,
  mime: 'image/png',
  sha256: 'source-hash',
  byteLength: 1,
);

class _NeverReadAssetStore implements ImageAssetStore {
  int readCount = 0;

  @override
  String get label => 'test fake';

  @override
  Future<ImageAsset> save(Uint8List bytes) =>
      throw StateError('save must not be reached');

  @override
  Future<Uint8List> read(String assetRef) async {
    readCount++;
    throw StateError('read must not be reached');
  }

  @override
  Future<void> close() async {}
}

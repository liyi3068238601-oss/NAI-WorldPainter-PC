import 'dart:convert';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:archive/archive.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:worldpainter_pc/generation/novelai_generation_service.dart';
import 'package:worldpainter_pc/processing/postprocess_parameters.dart';

late Uint8List _sourcePng;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() async {
    _sourcePng = await _solidPng(1, 1);
  });

  group('NovelAiGenerationService.processPostprocess', () {
    test(
      'Enhance uses the official img2img contract and ZIP extraction',
      () async {
        final output = await _solidPng(64, 64);
        late _CapturedRequest captured;
        final client = MockClient((request) async {
          captured = _captureRequest(request);
          return http.Response.bytes(
            _zipPng(output),
            201,
            headers: {'content-type': 'application/zip'},
          );
        });
        final result = await NovelAiGenerationService(client: client)
            .processPostprocess(
              parameters: _enhanceParameters(),
              provider: const GenerationProviderConfig(
                protocol: NovelAiProtocol.official,
              ),
              credential: const GenerationCredential('test-official-token'),
              resolveImage: _resolveSource,
            );

        final body = captured.body;
        final requestParameters = body['parameters'] as Map<String, dynamic>;
        expect(
          captured.url,
          Uri.https('image.novelai.net', '/ai/generate-image'),
        );
        expect(captured.headers['authorization'], 'Bearer test-official-token');
        expect(body['action'], 'img2img');
        expect(body['model'], 'nai-diffusion-4-5-curated');
        expect(requestParameters['width'], 64);
        expect(requestParameters['height'], 64);
        expect(requestParameters['strength'], 0.3);
        expect(requestParameters['noise'], 0.1);
        expect(requestParameters['scale'], 5.0);
        expect(requestParameters['upscaled_enhance'], isNull);
        expect(result.inputWidth, 64);
        expect(result.inputHeight, 64);
        expect(result.outputWidth, 64);
        expect(result.outputHeight, 64);
        expect(result.imageBytes, output);
      },
    );

    test('Enhance records and sends the generated seed', () async {
      final output = await _solidPng(64, 64);
      late _CapturedRequest captured;
      final client = MockClient((request) async {
        captured = _captureRequest(request);
        return http.Response.bytes(_zipPng(output), 200);
      });
      final result =
          await NovelAiGenerationService(
            client: client,
            seedGenerator: () => 4294967295,
          ).processPostprocess(
            parameters: _enhanceParameters(seed: null),
            provider: const GenerationProviderConfig(
              protocol: NovelAiProtocol.official,
            ),
            credential: const GenerationCredential('test-official-token'),
            resolveImage: _resolveSource,
          );

      final requestParameters = captured.body['parameters'] as Map;
      expect(requestParameters['seed'], 4294967295);
      expect(requestParameters['extra_noise_seed'], 4294967295);
      expect(result.effectiveParameters.seed, 4294967295);
    });

    test('official Upscale 4x makes two verified 2x passes', () async {
      final firstOutput = await _solidPng(2, 2);
      final secondOutput = await _solidPng(4, 4);
      final requests = <_CapturedRequest>[];
      final client = MockClient((request) async {
        requests.add(_captureRequest(request));
        return http.Response.bytes(
          _zipPng(requests.length == 1 ? firstOutput : secondOutput),
          200,
          headers: {'content-type': 'application/zip'},
        );
      });
      final result = await NovelAiGenerationService(client: client)
          .processPostprocess(
            parameters: PostprocessParameters(
              operation: PostprocessOperation.upscale,
              sourceAssetRef: 'asset-source',
              parentId: 'task-source',
              width: 1,
              height: 1,
              scale: 4,
            ),
            provider: const GenerationProviderConfig(
              protocol: NovelAiProtocol.official,
            ),
            credential: const GenerationCredential('test-official-token'),
            resolveImage: _resolveSource,
          );

      expect(requests, hasLength(2));
      expect(
        requests.map((request) => request.url.path),
        everyElement('/ai/upscale'),
      );
      final firstBody = requests[0].body;
      final secondBody = requests[1].body;
      expect(firstBody['model'], 'nai-diffusion-5-curated');
      expect(firstBody['declared_blur_sigma'], 0);
      expect(secondBody['image'], base64Encode(firstOutput));
      expect(result.inputWidth, 1);
      expect(result.inputHeight, 1);
      expect(result.outputWidth, 4);
      expect(result.outputHeight, 4);
      expect(result.imageBytes, secondOutput);
    });

    test(
      'official Upscale 4x rejects an oversized thin output before HTTP',
      () async {
        final thinSource = await _solidPng(9000, 100);
        var requestCount = 0;
        final client = MockClient((_) async {
          requestCount++;
          return http.Response('{}', 500);
        });

        await expectLater(
          NovelAiGenerationService(client: client).processPostprocess(
            parameters: PostprocessParameters(
              operation: PostprocessOperation.upscale,
              sourceAssetRef: 'thin-source',
              width: 9000,
              height: 100,
              scale: 4,
            ),
            provider: const GenerationProviderConfig(
              protocol: NovelAiProtocol.official,
            ),
            credential: const GenerationCredential('test-official-token'),
            resolveImage: (_) async => thinSource,
          ),
          throwsA(
            isA<GenerationServiceException>().having(
              (error) => error.reason,
              'reason',
              GenerationFailureReason.invalidParameters,
            ),
          ),
        );
        expect(requestCount, 0);
      },
    );

    test('V5 Max Enhance sends the upscaled_enhance flag', () async {
      final output = await _solidPng(128, 128);
      late _CapturedRequest captured;
      final client = MockClient((request) async {
        captured = _captureRequest(request);
        return http.Response.bytes(_zipPng(output), 200);
      });
      final parameters = _enhanceParameters(
        model: 'nai-diffusion-5-curated',
        upscaledEnhance: true,
      );
      final result = await NovelAiGenerationService(client: client)
          .processPostprocess(
            parameters: parameters,
            provider: const GenerationProviderConfig(
              protocol: NovelAiProtocol.official,
            ),
            credential: const GenerationCredential('test-official-token'),
            resolveImage: _resolveSource,
          );

      final requestParameters = captured.body['parameters'] as Map;
      expect(requestParameters['upscaled_enhance'], true);
      expect(requestParameters['width'], 64);
      expect(requestParameters['height'], 64);
      expect(result.outputWidth, 128);
      expect(result.outputHeight, 128);
    });

    test(
      'Director uses the separate official, 7877, and ikun schemas',
      () async {
        final officialBody = await _runDirector(
          protocol: NovelAiProtocol.official,
          tool: PostprocessDirectorTool.colorize,
          model: null,
          prompt: 'blue hair',
          defry: 3,
        );
        expect(officialBody['req_type'], 'colorize');
        expect(officialBody['prompt'], 'blue hair');
        expect(officialBody['defry'], 3);
        expect(officialBody['model'], isNull);

        final gatewayBody = await _runDirector(
          protocol: NovelAiProtocol.gateway7877,
          tool: PostprocessDirectorTool.emotion,
          model: 'gateway-image-model',
          prompt: 'smile',
          defry: 4,
        );
        expect(gatewayBody['extra'], 'director-emotion');
        expect(gatewayBody['model'], 'gateway-image-model');
        expect(gatewayBody['prompt'], 'smile');
        expect(gatewayBody['defry'], 4);

        final ikunBody = await _runDirector(
          protocol: NovelAiProtocol.ikun,
          tool: PostprocessDirectorTool.bgRemoval,
          model: 'ikun-image-model',
        );
        expect(ikunBody['novelai_operation'], 'director-bg-remover');
        expect(ikunBody['model'], 'ikun-image-model');
        expect(ikunBody['extra'], isNull);
      },
    );

    test(
      'rejects unsupported routes and invalid Enhance model combinations',
      () async {
        var requestCount = 0;
        final client = MockClient((_) async {
          requestCount++;
          return http.Response('{}', 200);
        });
        final service = NovelAiGenerationService(client: client);

        await expectLater(
          service.processPostprocess(
            parameters: _enhanceParameters(),
            provider: GenerationProviderConfig(
              protocol: NovelAiProtocol.gateway7877,
              baseUri: Uri.https('gateway.example', '/'),
            ),
            credential: const GenerationCredential('test-gateway-key'),
            resolveImage: _resolveSource,
          ),
          throwsA(
            isA<GenerationServiceException>().having(
              (error) => error.reason,
              'reason',
              GenerationFailureReason.unsupportedCombination,
            ),
          ),
        );

        expect(
          () => PostprocessParameters(
            operation: PostprocessOperation.enhance,
            sourceAssetRef: 'asset-source',
            width: 64,
            height: 64,
            model: 'unlisted-model',
            strength: 0.3,
            noise: 0.1,
            scale: 1.5,
            guidance: 5,
            steps: 23,
          ).validate(),
          throwsA(isA<PostprocessValidationException>()),
        );
        expect(
          () => PostprocessParameters(
            operation: PostprocessOperation.enhance,
            sourceAssetRef: 'asset-source',
            width: 64,
            height: 64,
            model: 'nai-diffusion-4-5-curated',
            strength: 0.3,
            noise: 0.1,
            scale: 1,
            guidance: 5,
            steps: 23,
            upscaledEnhance: true,
          ).validate(),
          throwsA(isA<PostprocessValidationException>()),
        );
        expect(
          () => _enhanceParameters(
            model: 'nai-diffusion-5-curated',
            steps: 29,
          ).validate(),
          throwsA(isA<PostprocessValidationException>()),
        );
        expect(requestCount, 0);
      },
    );

    test('validates official model scope and parameter JSON round trip', () {
      for (final model in PostprocessParameters.officialEnhanceModels) {
        expect(_enhanceParameters(model: model).validate, returnsNormally);
      }
      final original = _enhanceParameters(model: 'nai-diffusion-5-curated');
      final restored = PostprocessParameters.fromJson(original.toJson());
      expect(restored.toJson(), original.toJson());
      expect(
        PostprocessParameters(
          operation: PostprocessOperation.localSr,
          sourceAssetRef: 'asset-source',
          width: 64,
          height: 64,
          model: 'realesrganAnime4x',
          scale: 4,
        ).validate,
        returnsNormally,
      );
    });

    test('maps HTTP failures and rejects invalid response archives', () async {
      final failureClient = MockClient(
        (_) async => http.Response('test-official-token private prompt', 402),
      );
      await expectLater(
        NovelAiGenerationService(client: failureClient).processPostprocess(
          parameters: _enhanceParameters(),
          provider: const GenerationProviderConfig(
            protocol: NovelAiProtocol.official,
          ),
          credential: const GenerationCredential('test-official-token'),
          resolveImage: _resolveSource,
        ),
        throwsA(
          isA<GenerationServiceException>()
              .having(
                (error) => error.reason,
                'reason',
                GenerationFailureReason.insufficientCredits,
              )
              .having(
                (error) => error.toString(),
                'sanitized message',
                isNot(contains('private prompt')),
              ),
        ),
      );

      final invalidArchiveClient = MockClient(
        (_) async => http.Response.bytes([0x50, 0x4b, 0x03, 0x04], 200),
      );
      await expectLater(
        NovelAiGenerationService(client: invalidArchiveClient)
            .processPostprocess(
              parameters: _enhanceParameters(),
              provider: const GenerationProviderConfig(
                protocol: NovelAiProtocol.official,
              ),
              credential: const GenerationCredential('test-official-token'),
              resolveImage: _resolveSource,
            ),
        throwsA(
          isA<GenerationServiceException>().having(
            (error) => error.reason,
            'reason',
            GenerationFailureReason.invalidResponse,
          ),
        ),
      );
    });

    test('4x second pass does not rescale after a service failure', () async {
      var requestCount = 0;
      final client = MockClient((_) async {
        requestCount++;
        if (requestCount == 1) {
          return http.Response.bytes(_zipPng(await _solidPng(2, 2)), 200);
        }
        return http.Response('input too large', 413);
      });

      await expectLater(
        NovelAiGenerationService(client: client).processPostprocess(
          parameters: PostprocessParameters(
            operation: PostprocessOperation.upscale,
            sourceAssetRef: 'asset-source',
            width: 1,
            height: 1,
            scale: 4,
          ),
          provider: const GenerationProviderConfig(
            protocol: NovelAiProtocol.official,
          ),
          credential: const GenerationCredential('test-official-token'),
          resolveImage: _resolveSource,
        ),
        throwsA(
          isA<GenerationServiceException>()
              .having(
                (error) => error.reason,
                'reason',
                GenerationFailureReason.httpFailure,
              )
              .having((error) => error.statusCode, 'status', 413),
        ),
      );
      expect(requestCount, 2);
    });
  });
}

PostprocessParameters _enhanceParameters({
  String model = 'nai-diffusion-4-5-curated',
  bool upscaledEnhance = false,
  int steps = 23,
  int? seed = 17,
}) => PostprocessParameters(
  operation: PostprocessOperation.enhance,
  sourceAssetRef: 'asset-source',
  parentId: 'task-source',
  width: 1,
  height: 1,
  model: model,
  prompt: 'small studio scene',
  negativePrompt: 'blur',
  strength: 0.3,
  noise: 0.1,
  scale: 1,
  guidance: 5,
  steps: steps,
  seed: seed,
  upscaledEnhance: upscaledEnhance,
);

Future<Uint8List> _resolveSource(String assetRef) async {
  if (assetRef != 'asset-source') throw StateError('Unexpected asset ID.');
  return _sourcePng;
}

Future<Map<String, dynamic>> _runDirector({
  required NovelAiProtocol protocol,
  required PostprocessDirectorTool tool,
  required String? model,
  String? prompt,
  int? defry,
}) async {
  late _CapturedRequest captured;
  final client = MockClient((request) async {
    captured = _captureRequest(request);
    if (protocol == NovelAiProtocol.official) {
      return http.Response.bytes(_sourcePng, 200);
    }
    return http.Response(
      jsonEncode({
        'data': [
          {'b64_json': base64Encode(_sourcePng)},
        ],
      }),
      200,
      headers: {'content-type': 'application/json'},
    );
  });
  final provider = protocol == NovelAiProtocol.official
      ? const GenerationProviderConfig(protocol: NovelAiProtocol.official)
      : GenerationProviderConfig(
          protocol: protocol,
          baseUri: Uri.https(
            protocol == NovelAiProtocol.gateway7877
                ? 'gateway.example'
                : 'ikun.example',
            '/',
          ),
        );
  await NovelAiGenerationService(client: client).processPostprocess(
    parameters: PostprocessParameters(
      operation: PostprocessOperation.director,
      sourceAssetRef: 'asset-source',
      width: 1,
      height: 1,
      model: model,
      prompt: prompt,
      defry: defry,
      directorTool: tool,
    ),
    provider: provider,
    credential: const GenerationCredential('test-provider-key'),
    resolveImage: _resolveSource,
  );
  return captured.body;
}

_CapturedRequest _captureRequest(http.Request request) => _CapturedRequest(
  url: request.url,
  headers: Map.unmodifiable({
    for (final entry in request.headers.entries)
      entry.key.toLowerCase(): entry.value,
  }),
  body: jsonDecode(request.body) as Map<String, dynamic>,
);

class _CapturedRequest {
  final Uri url;
  final Map<String, String> headers;
  final Map<String, dynamic> body;

  const _CapturedRequest({
    required this.url,
    required this.headers,
    required this.body,
  });
}

List<int> _zipPng(Uint8List png) {
  final archive = Archive()
    ..addFile(ArchiveFile('processed.png', png.length, png));
  return ZipEncoder().encode(archive);
}

Future<Uint8List> _solidPng(int width, int height) async {
  final pixels = Uint8List(width * height * 4);
  for (var index = 0; index < pixels.length; index += 4) {
    pixels[index] = 180;
    pixels[index + 1] = 120;
    pixels[index + 2] = 60;
    pixels[index + 3] = 255;
  }
  final buffer = await ui.ImmutableBuffer.fromUint8List(pixels);
  try {
    final descriptor = ui.ImageDescriptor.raw(
      buffer,
      width: width,
      height: height,
      pixelFormat: ui.PixelFormat.rgba8888,
    );
    try {
      final codec = await descriptor.instantiateCodec();
      try {
        final frame = await codec.getNextFrame();
        try {
          final data = await frame.image.toByteData(
            format: ui.ImageByteFormat.png,
          );
          if (data == null) throw StateError('PNG encoding failed.');
          return Uint8List.fromList(
            data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes),
          );
        } finally {
          frame.image.dispose();
        }
      } finally {
        codec.dispose();
      }
    } finally {
      descriptor.dispose();
    }
  } finally {
    buffer.dispose();
  }
}

import 'dart:convert';
import 'dart:typed_data';

import 'package:archive/archive.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:worldpainter_pc/generation/generation_parameters.dart';
import 'package:worldpainter_pc/generation/novelai_generation_service.dart';

final Uint8List _png = Uint8List.fromList(
  base64Decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nmN8AAAAASUVORK5CYII=',
  ),
);

void main() {
  group('NovelAiGenerationService', () {
    test(
      'inpaint default and explicit strength survive every protocol',
      () async {
        final zipped = ZipEncoder().encode(
          Archive()..addFile(ArchiveFile('generated.png', _png.length, _png)),
        );
        for (final protocol in NovelAiProtocol.values) {
          for (final strength in <double?>[null, 0.7, 0.43, 1.0]) {
            final expected = strength ?? 0.7;
            final client = _ScriptedClient((request) async {
              final body = _jsonPayload(request);
              final settings = protocol == NovelAiProtocol.official
                  ? body['parameters'] as Map
                  : body;
              expect(
                settings['strength'],
                expected,
                reason: '$protocol with stored strength $strength',
              );
              return protocol == NovelAiProtocol.official
                  ? _response(
                      zipped,
                      headers: {'content-type': 'application/zip'},
                    )
                  : _jsonResponse({
                      'data': [
                        {'b64_json': base64Encode(_png)},
                      ],
                    });
            });
            final result =
                await NovelAiGenerationService(
                  client: client,
                  seedGenerator: () => 77,
                ).generate(
                  parameters: GenerationParameters(
                    operation: GenerationOperation.inpaint,
                    model: 'nai-diffusion-4-5-full',
                    prompt: 'synthetic inpaint',
                    width: 768,
                    height: 768,
                    sourceImageId: 'source',
                    maskImageId: 'mask',
                    inpaintStrength: strength,
                  ),
                  provider: GenerationProviderConfig(
                    protocol: protocol,
                    baseUri: Uri.https('synthetic.invalid'),
                  ),
                  credential: const GenerationCredential(
                    'synthetic-test-token',
                  ),
                  resolveImage: (_) async => _png,
                );
            expect(result.effectiveParameters.inpaintStrength, expected);
            expect(client.requests, hasLength(1));
            client.close();
          }
        }
      },
    );

    test(
      'builds the 7877 image-generations protocol and records effective values',
      () async {
        late _CapturedRequest captured;
        final client = _ScriptedClient((request) async {
          captured = request;
          return _jsonResponse({
            'data': [
              {'b64_json': base64Encode(_png)},
            ],
          });
        });
        final service = NovelAiGenerationService(
          client: client,
          seedGenerator: () => 77,
        );
        final result = await service.generate(
          parameters: GenerationParameters(
            model: 'nai-v4.5-full',
            prompt: '1girl',
            width: 832,
            height: 1216,
            sampler: 'k_euler_ancestral',
            noiseSchedule: 'native',
            characters: [
              GenerationCharacter(
                prompt: 'silver hair',
                negativePrompt: 'brown hair',
                centerX: 0.4,
                centerY: 0.6,
              ),
            ],
          ),
          provider: GenerationProviderConfig(
            protocol: NovelAiProtocol.gateway7877,
            baseUri: Uri(scheme: 'https', host: 'gateway.example'),
          ),
          credential: const GenerationCredential('test-key'),
          resolveImage: _noImages,
        );

        final payload = _jsonPayload(captured);
        final params = payload['params'] as Map<String, dynamic>;
        expect(captured.url.path, '/v1/images/generations');
        expect(captured.headers['authorization'], 'Bearer test-key');
        expect(payload['model'], 'nai-diffusion-4-5-full');
        expect(params['sampler'], 'k_euler_ancestral');
        expect(params['noise_schedule'], 'karras');
        expect(params['seed'], 77);
        expect(params['characters'], [
          {
            'prompt': 'silver hair',
            'uc': 'brown hair',
            'center': {'x': 0.4, 'y': 0.6},
          },
        ]);
        expect(result.imageBytes, _png);
        expect(result.effectiveParameters.model, 'nai-diffusion-4-5-full');
        expect(result.effectiveParameters.seed, 77);
        expect(result.effectiveParameters.noiseSchedule, 'karras');
        expect(captured.bodyText, isNot(contains('test-key')));
      },
    );

    test(
      'rejects unsupported samplers and noise schedules before sending',
      () async {
        final client = _ScriptedClient(
          (request) async => _jsonResponse({
            'data': [
              {'b64_json': base64Encode(_png)},
            ],
          }),
        );
        final service = NovelAiGenerationService(
          client: client,
          seedGenerator: () => 1,
        );
        final provider = GenerationProviderConfig(
          protocol: NovelAiProtocol.gateway7877,
          baseUri: Uri(scheme: 'https', host: 'gateway.example'),
        );

        for (final parameters in [
          GenerationParameters(
            model: 'nai-v4.5-curated',
            prompt: 'test',
            width: 832,
            height: 1216,
            sampler: 'unknown-sampler',
          ),
          GenerationParameters(
            model: 'nai-v4.5-curated',
            prompt: 'test',
            width: 832,
            height: 1216,
            noiseSchedule: 'unknown-schedule',
          ),
        ]) {
          await expectLater(
            service.generate(
              parameters: parameters,
              provider: provider,
              credential: const GenerationCredential('test-key'),
              resolveImage: _noImages,
            ),
            throwsA(
              isA<GenerationServiceException>().having(
                (error) => error.reason,
                'reason',
                GenerationFailureReason.unsupportedCombination,
              ),
            ),
          );
        }
        expect(client.requests, isEmpty);
      },
    );

    test(
      'sends ikun precise references using its dedicated operation payload',
      () async {
        late _CapturedRequest captured;
        final client = _ScriptedClient((request) async {
          captured = request;
          return _jsonResponse({
            'data': [
              {'b64_json': base64Encode(_png)},
            ],
          });
        });
        final result =
            await NovelAiGenerationService(
              client: client,
              seedGenerator: () => 9,
            ).generate(
              parameters: GenerationParameters(
                model: 'nai-diffusion-5-curated',
                prompt: 'portrait',
                width: 1024,
                height: 1024,
                preciseReferences: const [
                  PreciseReference(
                    assetId: 'ref-1',
                    referenceType: 'character',
                    strength: 0.8,
                  ),
                ],
              ),
              provider: GenerationProviderConfig(
                protocol: NovelAiProtocol.ikun,
                baseUri: Uri(scheme: 'https', host: 'ikun.example'),
              ),
              credential: const GenerationCredential('gateway-key'),
              resolveImage: (assetId) async {
                expect(assetId, 'ref-1');
                return _png;
              },
            );

        final payload = _jsonPayload(captured);
        expect(payload['novelai_operation'], 'precise-reference');
        expect(payload['model'], 'nai-diffusion-5-curated');
        expect(payload['seed'], 9);
        expect(payload['references'], [
          {
            'reference_image': base64Encode(_png),
            'reference_type': 'character',
            'strength': 0.8,
            'fidelity': 1.0,
          },
        ]);
        expect(result.imageBytes, _png);
      },
    );

    test(
      'uses the fixed official host and extracts an image from a ZIP',
      () async {
        final archive = Archive()
          ..addFile(ArchiveFile('generated.png', _png.length, _png));
        final zipped = ZipEncoder().encode(archive);
        late _CapturedRequest captured;
        final client = _ScriptedClient((request) async {
          captured = request;
          return _response(
            zipped,
            statusCode: 201,
            headers: {'content-type': 'application/zip'},
          );
        });

        final result =
            await NovelAiGenerationService(
              client: client,
              seedGenerator: () => 1234,
            ).generate(
              parameters: GenerationParameters(
                operation: GenerationOperation.inpaint,
                model: 'nai-diffusion-4-5-curated',
                prompt: 'blue sky',
                negativePrompt: 'text',
                width: 832,
                height: 1216,
                sourceImageId: 'source-1',
                maskImageId: 'mask-1',
                inpaintStrength: 0.9,
                disabledOriginalImage: true,
                colorCorrect: false,
              ),
              provider: GenerationProviderConfig(
                protocol: NovelAiProtocol.official,
                baseUri: Uri(
                  scheme: 'https',
                  host: 'user-value-ignored.example',
                ),
              ),
              credential: const GenerationCredential('official-test-token'),
              resolveImage: (assetId) async => switch (assetId) {
                'source-1' => _png,
                'mask-1' => _png,
                _ => throw StateError('unknown asset'),
              },
            );

        final payload = _jsonPayload(captured);
        final params = payload['parameters'] as Map<String, dynamic>;
        expect(captured.url.host, 'image.novelai.net');
        expect(captured.url.path, '/ai/generate-image');
        expect(captured.headers['authorization'], 'Bearer official-test-token');
        expect(payload['action'], 'infill');
        expect(payload['model'], 'nai-diffusion-4-5-curated-inpainting');
        expect(params['seed'], 1234);
        expect(params['image'], base64Encode(_png));
        expect(params['mask'], base64Encode(_png));
        expect(params['add_original_image'], false);
        expect(params['color_correct'], false);
        expect(result.imageBytes, _png);
      },
    );

    test(
      'official Precise Reference uses the multipart cache contract',
      () async {
        late _CapturedRequest captured;
        final archive = Archive()
          ..addFile(ArchiveFile('generated.png', _png.length, _png));
        final zipped = ZipEncoder().encode(archive);
        final client = _ScriptedClient((request) async {
          captured = request;
          return _response(
            zipped,
            statusCode: 201,
            headers: {'content-type': 'application/zip'},
          );
        });

        await NovelAiGenerationService(
          client: client,
          seedGenerator: () => 3,
        ).generate(
          parameters: GenerationParameters(
            model: 'nai-diffusion-4-5-curated',
            prompt: 'portrait',
            width: 832,
            height: 1216,
            preciseReferences: const [
              PreciseReference(assetId: 'ref-1', referenceType: 'style'),
            ],
          ),
          provider: const GenerationProviderConfig(
            protocol: NovelAiProtocol.official,
          ),
          credential: const GenerationCredential('official-test-token'),
          resolveImage: (assetId) async => _png,
        );

        expect(captured.headers['authorization'], 'Bearer official-test-token');
        expect(
          captured.headers['content-type'],
          startsWith('multipart/form-data;'),
        );
        expect(captured.bodyText, contains('request.json'));
        expect(captured.bodyText, contains('director_reference_images_cached'));
        expect(captured.bodyText, contains('director_ref_0'));
        expect(captured.bodyText, contains('"base_caption":"style"'));
        expect(captured.bodyBytes, containsBytes(_png));
      },
    );

    test(
      'blocks redirects without following them or exposing response text',
      () async {
        final client = _ScriptedClient(
          (request) async => _response(
            utf8.encode('server-secret-test'),
            statusCode: 302,
            headers: {'location': 'https://other.example/image.png'},
          ),
        );
        final service = NovelAiGenerationService(
          client: client,
          seedGenerator: () => 1,
        );

        await expectLater(
          service.generate(
            parameters: GenerationParameters(
              model: 'nai-diffusion-4-5-curated',
              prompt: 'test',
              width: 832,
              height: 1216,
            ),
            provider: GenerationProviderConfig(
              protocol: NovelAiProtocol.gateway7877,
              baseUri: Uri(scheme: 'https', host: 'gateway.example'),
            ),
            credential: const GenerationCredential('test-key'),
            resolveImage: _noImages,
          ),
          throwsA(
            isA<GenerationServiceException>()
                .having(
                  (error) => error.reason,
                  'reason',
                  GenerationFailureReason.redirectBlocked,
                )
                .having(
                  (error) => error.toString(),
                  'message',
                  isNot(contains('server-secret-test')),
                ),
          ),
        );
        expect(client.requests, hasLength(1));
        expect(client.requests.single.redirectsAllowed, isFalse);
      },
    );

    test(
      'downloads returned image URLs without provider authorization',
      () async {
        final client = _ScriptedClient((request) async {
          if (request.method == 'GET') {
            expect(request.headers['authorization'], isNull);
            return _response(_png, headers: {'content-type': 'image/png'});
          }
          return _jsonResponse({
            'data': [
              {'url': 'https://cdn.example.com/generated.png'},
            ],
          });
        });

        final result =
            await NovelAiGenerationService(
              client: client,
              seedGenerator: () => 1,
              hostIsPublic: (_) async => true,
            ).generate(
              parameters: GenerationParameters(
                model: 'nai-diffusion-4-5-curated',
                prompt: 'test',
                width: 832,
                height: 1216,
              ),
              provider: GenerationProviderConfig(
                protocol: NovelAiProtocol.gateway7877,
                baseUri: Uri(scheme: 'https', host: 'gateway.example'),
              ),
              credential: const GenerationCredential('test-key'),
              resolveImage: _noImages,
            );

        expect(result.imageBytes, _png);
        expect(client.requests, hasLength(2));
        expect(client.requests.last.method, 'GET');
        expect(client.requests.last.redirectsAllowed, isFalse);
      },
    );

    test(
      'allows HTTP image URLs only for explicit loopback mock mode',
      () async {
        final client = _ScriptedClient((request) async {
          if (request.method == 'GET') {
            expect(request.headers['authorization'], isNull);
            return _response(_png, headers: {'content-type': 'image/png'});
          }
          return _jsonResponse({
            'data': [
              {'url': 'http://127.0.0.1:8080/generated.png'},
            ],
          });
        });
        final service = NovelAiGenerationService(
          client: client,
          seedGenerator: () => 1,
        );
        final parameters = GenerationParameters(
          model: 'nai-diffusion-4-5-curated',
          prompt: 'test',
          width: 832,
          height: 1216,
        );

        await expectLater(
          service.generate(
            parameters: parameters,
            provider: GenerationProviderConfig(
              protocol: NovelAiProtocol.gateway7877,
              baseUri: Uri(scheme: 'https', host: 'gateway.example'),
            ),
            credential: const GenerationCredential('test-key'),
            resolveImage: _noImages,
          ),
          throwsA(
            isA<GenerationServiceException>().having(
              (error) => error.reason,
              'reason',
              GenerationFailureReason.invalidResponse,
            ),
          ),
        );
        expect(client.requests, hasLength(1));

        client.requests.clear();
        final result = await service.generate(
          parameters: parameters,
          provider: GenerationProviderConfig(
            protocol: NovelAiProtocol.gateway7877,
            baseUri: Uri(scheme: 'https', host: 'gateway.example'),
            allowInsecureLoopbackForTesting: true,
          ),
          credential: const GenerationCredential('test-key'),
          resolveImage: _noImages,
        );
        expect(result.imageBytes, _png);
        expect(client.requests, hasLength(2));
        expect(client.requests.last.url.scheme, 'http');
        expect(client.requests.last.url.host, '127.0.0.1');
        expect(client.requests.last.headers['authorization'], isNull);
      },
    );

    test(
      'allows plain HTTP only for explicit loopback test endpoints',
      () async {
        final service = NovelAiGenerationService(
          client: _ScriptedClient(
            (request) async => _jsonResponse({
              'data': [
                {'b64_json': base64Encode(_png)},
              ],
            }),
          ),
          seedGenerator: () => 1,
        );
        final parameters = GenerationParameters(
          model: 'nai-diffusion-4-5-curated',
          prompt: 'test',
          width: 832,
          height: 1216,
        );

        await expectLater(
          service.generate(
            parameters: parameters,
            provider: GenerationProviderConfig(
              protocol: NovelAiProtocol.ikun,
              baseUri: Uri(scheme: 'http', host: 'localhost', port: 8080),
            ),
            credential: const GenerationCredential('test-key'),
            resolveImage: _noImages,
          ),
          throwsA(
            isA<GenerationServiceException>().having(
              (error) => error.reason,
              'reason',
              GenerationFailureReason.invalidConfiguration,
            ),
          ),
        );

        final result = await service.generate(
          parameters: parameters,
          provider: GenerationProviderConfig(
            protocol: NovelAiProtocol.ikun,
            baseUri: Uri(scheme: 'http', host: '127.0.0.1', port: 8080),
            allowInsecureLoopbackForTesting: true,
          ),
          credential: const GenerationCredential('test-key'),
          resolveImage: _noImages,
        );
        expect(result.imageBytes, _png);
      },
    );
  });
}

Future<Uint8List> _noImages(String assetId) async =>
    throw StateError('Unexpected image resolution: $assetId');

Map<String, dynamic> _jsonPayload(_CapturedRequest request) =>
    jsonDecode(utf8.decode(request.bodyBytes)) as Map<String, dynamic>;

http.StreamedResponse _jsonResponse(Map<String, dynamic> body) => _response(
  utf8.encode(jsonEncode(body)),
  headers: {'content-type': 'application/json'},
);

http.StreamedResponse _response(
  List<int> body, {
  int statusCode = 200,
  Map<String, String> headers = const {},
}) => http.StreamedResponse(
  Stream<List<int>>.value(body),
  statusCode,
  headers: headers,
);

class _CapturedRequest {
  final String method;
  final Uri url;
  final Map<String, String> headers;
  final Uint8List bodyBytes;
  final bool redirectsAllowed;

  const _CapturedRequest({
    required this.method,
    required this.url,
    required this.headers,
    required this.bodyBytes,
    required this.redirectsAllowed,
  });

  String get bodyText => utf8.decode(bodyBytes, allowMalformed: true);
}

class _ScriptedClient extends http.BaseClient {
  final Future<http.StreamedResponse> Function(_CapturedRequest request)
  _handler;
  final requests = <_CapturedRequest>[];

  _ScriptedClient(this._handler);

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    final body = await request.finalize().toBytes();
    final captured = _CapturedRequest(
      method: request.method,
      url: request.url,
      headers: Map.unmodifiable({
        for (final entry in request.headers.entries)
          entry.key.toLowerCase(): entry.value,
      }),
      bodyBytes: Uint8List.fromList(body),
      redirectsAllowed: request.followRedirects,
    );
    requests.add(captured);
    return _handler(captured);
  }
}

Matcher containsBytes(List<int> expected) => predicate<Uint8List>(
  (actual) => _containsSequence(actual, expected),
  'contains the expected bytes',
);

bool _containsSequence(List<int> haystack, List<int> needle) {
  if (needle.isEmpty || needle.length > haystack.length) return false;
  for (var start = 0; start <= haystack.length - needle.length; start++) {
    var matches = true;
    for (var offset = 0; offset < needle.length; offset++) {
      if (haystack[start + offset] != needle[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}

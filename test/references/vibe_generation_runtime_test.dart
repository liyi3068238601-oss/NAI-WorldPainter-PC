import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:worldpainter_pc/generation/generation_parameters.dart';
import 'package:worldpainter_pc/generation/generation_runtime.dart';
import 'package:worldpainter_pc/generation/service_connection.dart';
import 'package:worldpainter_pc/media/image_asset_store.dart';
import 'package:worldpainter_pc/references/vibe_library.dart';
import 'package:worldpainter_pc/security/credential_vault_web.dart';

final Uint8List _png = Uint8List.fromList(
  base64Decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nmN8AAAAASUVORK5CYII=',
  ),
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test(
    'reuses encoding across generations when only strength changes',
    () async {
      final assets = _MemoryAssets({'vibe-source': _png});
      final vault = SessionMemoryCredentialVault();
      final connection = _connection('https://gateway.example');
      await connection.saveSecret(vault, 'mock-credential');
      var encodeRequests = 0;
      var generationRequests = 0;
      final runtime = GenerationRuntime(
        assets: assets,
        vault: vault,
        clientFactory: () => MockClient((request) async {
          final body = _body(request);
          if (body['extra'] == 'encode-vibe') {
            encodeRequests++;
            return _json({
              'data': [
                {'encoding': 'encoded-$encodeRequests'},
              ],
            });
          }
          generationRequests++;
          return _generatedImage();
        }),
      );

      final first = _parameters(strength: 0.15);
      final second = _parameters(strength: 0.85);
      await runtime.generateBytes(first, connection);
      await runtime.generateBytes(second, connection);

      expect(encodeRequests, 1);
      expect(generationRequests, 2);
      expect(runtime.vibeLibrary.cacheEntries, hasLength(1));
    },
  );

  test('re-encodes after info, model, or endpoint scope changes', () async {
    final assets = _MemoryAssets({'vibe-source': _png});
    final vault = SessionMemoryCredentialVault();
    final firstConnection = _connection('https://gateway.example');
    final secondConnection = _connection('https://other-gateway.example');
    await firstConnection.saveSecret(vault, 'mock-credential');
    await secondConnection.saveSecret(vault, 'mock-credential');
    var encodeRequests = 0;
    final runtime = GenerationRuntime(
      assets: assets,
      vault: vault,
      clientFactory: () => MockClient((request) async {
        final body = _body(request);
        if (body['extra'] == 'encode-vibe') {
          encodeRequests++;
          return _json({
            'data': [
              {'encoding': 'encoded-$encodeRequests'},
            ],
          });
        }
        return _generatedImage();
      }),
    );

    await runtime.generateBytes(_parameters(), firstConnection);
    await runtime.generateBytes(
      _parameters(informationExtracted: 0.6),
      firstConnection,
    );
    await runtime.generateBytes(
      _parameters(model: 'nai-v4.5-full', informationExtracted: 0.6),
      firstConnection,
    );
    await runtime.generateBytes(
      _parameters(model: 'nai-v4.5-full', informationExtracted: 0.6),
      secondConnection,
    );

    expect(encodeRequests, 4);
  });

  test('failed encoding is not cached and the retry encodes once', () async {
    final assets = _MemoryAssets({'vibe-source': _png});
    final vault = SessionMemoryCredentialVault();
    final connection = _connection('https://gateway.example');
    await connection.saveSecret(vault, 'mock-credential');
    var encodeRequests = 0;
    var generationRequests = 0;
    final runtime = GenerationRuntime(
      assets: assets,
      vault: vault,
      clientFactory: () => MockClient((request) async {
        final body = _body(request);
        if (body['extra'] == 'encode-vibe') {
          encodeRequests++;
          if (encodeRequests == 1) {
            return http.Response('mock failure', 503);
          }
          return _json({
            'data': [
              {'encoding': 'encoded-after-retry'},
            ],
          });
        }
        generationRequests++;
        return _generatedImage();
      }),
    );

    await expectLater(
      runtime.generateBytes(_parameters(), connection),
      throwsA(isA<FormatException>()),
    );
    expect(runtime.vibeLibrary.cacheEntries, isEmpty);
    await runtime.generateBytes(_parameters(), connection);

    expect(encodeRequests, 2);
    expect(generationRequests, 1);
    expect(runtime.vibeLibrary.cacheEntries, hasLength(1));
  });

  test('restored library cache prevents another encode request', () async {
    final assets = _MemoryAssets({'vibe-source': _png});
    final vault = SessionMemoryCredentialVault();
    final connection = _connection('https://gateway.example');
    await connection.saveSecret(vault, 'mock-credential');
    var encodeRequests = 0;
    var generationRequests = 0;

    final initialRuntime = GenerationRuntime(
      assets: assets,
      vault: vault,
      clientFactory: () => MockClient((request) async {
        final body = _body(request);
        if (body['extra'] == 'encode-vibe') {
          encodeRequests++;
          return _json({
            'data': [
              {'encoding': 'persisted-encoding'},
            ],
          });
        }
        generationRequests++;
        return _generatedImage();
      }),
    );
    await initialRuntime.generateBytes(_parameters(), connection);
    final savedLibrary = Map<String, dynamic>.from(
      initialRuntime.vibeLibrary.toJson(),
    );

    final restoredRuntime = GenerationRuntime(
      assets: assets,
      vault: vault,
      vibeLibrary: VibeLibrary.fromJson(savedLibrary),
      clientFactory: () => MockClient((request) async {
        final body = _body(request);
        if (body['extra'] == 'encode-vibe') {
          encodeRequests++;
          return _json({
            'data': [
              {'encoding': 'unexpected-encoding'},
            ],
          });
        }
        generationRequests++;
        return _generatedImage();
      }),
    );
    await restoredRuntime.generateBytes(_parameters(), connection);

    expect(encodeRequests, 1);
    expect(generationRequests, 2);
  });

  test('encode-only API creates a named library entry', () async {
    final assets = _MemoryAssets({'vibe-source': _png});
    final vault = SessionMemoryCredentialVault();
    final connection = _connection('https://gateway.example');
    await connection.saveSecret(vault, 'mock-credential');
    var encodeRequests = 0;
    var generationRequests = 0;
    final runtime = GenerationRuntime(
      assets: assets,
      vault: vault,
      clientFactory: () => MockClient((request) async {
        final body = _body(request);
        if (body['extra'] == 'encode-vibe') {
          encodeRequests++;
          return _json({
            'data': [
              {'encoding': 'standalone-encoding'},
            ],
          });
        }
        generationRequests++;
        return _generatedImage();
      }),
    );

    final entry = await runtime.encodeVibe(
      sourceAssetRef: 'vibe-source',
      title: 'Blue Lantern',
      model: 'nai-v4.5-curated',
      connection: connection,
      informationExtracted: 0.68,
      strength: 0.32,
    );

    expect(encodeRequests, 1);
    expect(generationRequests, 0);
    expect(runtime.vibeLibrary.entries, [entry]);
    expect(entry.encodedValue, 'standalone-encoding');
    expect(entry.informationExtracted, 0.68);
    expect(entry.strength, 0.32);
    expect(entry.toReference().hasScopedEncodedVibe, isTrue);
  });

  test(
    'confirmed imported encoding is sent only for its assigned scope',
    () async {
      final assets = _MemoryAssets(const {});
      final vault = SessionMemoryCredentialVault();
      final connection = _connection('https://gateway.example');
      final otherConnection = _connection('https://other-gateway.example');
      await connection.saveSecret(vault, 'mock-credential');
      await otherConnection.saveSecret(vault, 'mock-credential');
      final imported = VibeLibrary().addPreEncodedValue(
        title: 'Imported',
        encodedValue: 'confirmed-encoding',
        model: 'nai-v4.5-curated',
        providerProtocol: 'gateway7877',
        endpoint: Uri.parse('https://gateway.example/'),
        informationExtracted: 0.8,
      );
      var requests = 0;
      var encodingRequests = 0;
      final runtime = GenerationRuntime(
        assets: assets,
        vault: vault,
        clientFactory: () => MockClient((request) async {
          requests++;
          final body = _body(request);
          if (body['extra'] == 'encode-vibe') encodingRequests++;
          return _generatedImage();
        }),
      );
      final parameters = GenerationParameters(
        model: 'nai-v4.5-curated',
        prompt: 'test prompt',
        width: 832,
        height: 1216,
        seed: 13,
        vibeReferences: [imported.toReference()],
      );

      await runtime.generateBytes(parameters, connection);
      expect(requests, 1);
      expect(encodingRequests, 0);
      await expectLater(
        runtime.generateBytes(parameters, otherConnection),
        throwsA(isA<FormatException>()),
      );
      expect(requests, 1);
    },
  );
}

GenerationParameters _parameters({
  String model = 'nai-v4.5-curated',
  double strength = 0.3,
  double informationExtracted = 0.72,
}) => GenerationParameters(
  model: model,
  prompt: 'test prompt',
  width: 832,
  height: 1216,
  seed: 13,
  vibeReferences: [
    VibeReference(
      assetId: 'vibe-source',
      strength: strength,
      informationExtracted: informationExtracted,
    ),
  ],
);

ServiceConnection _connection(String baseUrl) =>
    ServiceConnection(protocol: 'gateway7877', baseUrl: baseUrl);

Map<String, dynamic> _body(http.Request request) =>
    Map<String, dynamic>.from(jsonDecode(request.body) as Map);

http.Response _json(Map<String, Object?> value) => http.Response(
  jsonEncode(value),
  200,
  headers: const {'content-type': 'application/json'},
);

http.Response _generatedImage() => _json({
  'data': [
    {'b64_json': base64Encode(_png)},
  ],
});

class _MemoryAssets implements ImageAssetStore {
  _MemoryAssets(this.values);

  final Map<String, Uint8List> values;

  @override
  String get label => 'mock asset store';

  @override
  Future<ImageAsset> save(Uint8List bytes) =>
      throw UnimplementedError('These tests call generateBytes only.');

  @override
  Future<Uint8List> read(String assetRef) async {
    final value = values[assetRef];
    if (value == null) throw StateError('Missing test asset: $assetRef');
    return Uint8List.fromList(value);
  }

  @override
  Future<void> close() async {}
}

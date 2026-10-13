import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:path/path.dart' as p;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:worldpainter_pc/generation/generation_parameters.dart';
import 'package:worldpainter_pc/generation/generation_runtime.dart';
import 'package:worldpainter_pc/generation/service_connection.dart';
import 'package:worldpainter_pc/media/image_asset_store.dart';
import 'package:worldpainter_pc/prototype/workbench_controller.dart';
import 'package:worldpainter_pc/references/vibe_library.dart';
import 'package:worldpainter_pc/security/credential_vault_web.dart';
import 'package:worldpainter_pc/storage/sqlite_workspace_store.dart';

final Uint8List _png = Uint8List.fromList(
  base64Decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nmN8AAAAASUVORK5CYII=',
  ),
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  sqfliteFfiInit();

  test('controller persists the Vibe cache through a SQLite reopen', () async {
    final testRoot = Directory(
      p.join(Directory.current.path, '.tmp', 'vibe-library-tests'),
    );
    await testRoot.create(recursive: true);
    final directory = await testRoot.createTemp('reopen-');
    SQLiteWorkspaceStore? store;
    WorkbenchController? controller;
    final assets = _MemoryAssets({'vibe-source': _png});
    final vault = SessionMemoryCredentialVault();
    const connection = ServiceConnection(
      protocol: 'gateway7877',
      baseUrl: 'https://mock.example',
    );
    await connection.saveSecret(vault, 'synthetic-vibe-reopen-token');
    var encodeRequests = 0;
    var generationRequests = 0;

    http.Client createClient() => MockClient((request) async {
      final body = Map<String, dynamic>.from(jsonDecode(request.body) as Map);
      if (body['extra'] == 'encode-vibe') {
        encodeRequests++;
        return _json({
          'data': [
            {'encoding': 'durable-vibe-encoding'},
          ],
        });
      }
      generationRequests++;
      return _json({
        'data': [
          {'b64_json': base64Encode(_png)},
        ],
      });
    });

    try {
      final dbPath = p.join(directory.path, 'workspace.sqlite');
      store = await SQLiteWorkspaceStore.open(
        factory: databaseFactoryFfi,
        path: dbPath,
      );
      final library = VibeLibrary();
      final runtime = GenerationRuntime(
        assets: assets,
        vault: vault,
        vibeLibrary: library,
        clientFactory: createClient,
      );
      controller = WorkbenchController(
        store: store,
        assets: assets,
        vault: vault,
        vibeLibrary: library,
        generateImage: runtime.generate,
        cancelRequest: runtime.cancel,
      );
      _configureController(controller, connection);

      await controller.generate();
      await controller.flush();
      expect(encodeRequests, 1);
      expect(generationRequests, 1);
      expect(controller.vibeLibrary.cacheEntries, hasLength(1));

      await controller.closeStorage();
      controller.dispose();
      controller = null;
      store = null;

      store = await SQLiteWorkspaceStore.open(
        factory: databaseFactoryFfi,
        path: dbPath,
      );
      final restored = await store.load();
      expect(restored, isNotNull);
      final persistedLibrary = restored!.data['vibeLibrary'];
      expect(persistedLibrary, isA<Map>());
      final restoredLibrary = VibeLibrary.fromJson(
        Map<String, dynamic>.from(persistedLibrary! as Map),
      );
      expect(restoredLibrary.cacheEntries, hasLength(1));

      final restoredRuntime = GenerationRuntime(
        assets: assets,
        vault: vault,
        vibeLibrary: restoredLibrary,
        clientFactory: createClient,
      );
      controller = WorkbenchController(
        store: store,
        restored: restored,
        assets: assets,
        vault: vault,
        vibeLibrary: restoredLibrary,
        generateImage: restoredRuntime.generate,
        cancelRequest: restoredRuntime.cancel,
      );
      expect(
        controller.results
            .firstWhere((result) => !result.isDemo)
            .parameters!
            .vibeReferences
            .single
            .encodedVibe,
        'durable-vibe-encoding',
      );

      await controller.generate();
      await controller.flush();

      expect(encodeRequests, 1);
      expect(generationRequests, 2);
    } finally {
      final activeController = controller;
      if (activeController != null) {
        if (!activeController.closing) await activeController.closeStorage();
        activeController.dispose();
      } else {
        await store?.close();
      }
      await assets.close();
      final rootPath = p.normalize(await testRoot.resolveSymbolicLinks());
      final targetPath = p.normalize(await directory.resolveSymbolicLinks());
      if (!p.isWithin(rootPath, targetPath)) {
        throw StateError('Refusing cleanup outside the Vibe test root');
      }
      await Directory(targetPath).delete(recursive: true);
    }
  });
}

void _configureController(
  WorkbenchController controller,
  ServiceConnection connection,
) {
  controller
    ..updateProvider(ServiceConnection.labels[connection.protocol]!)
    ..updateConnection(connection)
    ..updateAdvanced(
      GenerationParameters(
        model: 'nai-v4.5-curated',
        prompt: 'mocked sqlite Vibe persistence',
        width: 832,
        height: 1216,
        steps: 24,
        scale: 5,
        seed: 13,
        vibeReferences: const [
          VibeReference(
            assetId: 'vibe-source',
            strength: 0.42,
            informationExtracted: 0.74,
          ),
        ],
      ),
    )
    ..updateModel('NAI Diffusion 4.5 Curated')
    ..updatePrompt('mocked sqlite Vibe persistence')
    ..updateSeed('13');
}

http.Response _json(Map<String, Object?> value) => http.Response(
  jsonEncode(value),
  200,
  headers: const {'content-type': 'application/json'},
);

class _MemoryAssets implements ImageAssetStore {
  _MemoryAssets(this.values);

  final Map<String, Uint8List> values;

  @override
  String get label => 'mock asset store';

  @override
  Future<ImageAsset> save(Uint8List bytes) async {
    final digest = sha256.convert(bytes).toString();
    final assetRef = 'sha256/${digest.substring(0, 2)}/$digest.png';
    values[assetRef] = Uint8List.fromList(bytes);
    return ImageAsset(
      id: digest,
      assetRef: assetRef,
      width: 1,
      height: 1,
      mime: 'image/png',
      sha256: digest,
      byteLength: bytes.length,
    );
  }

  @override
  Future<Uint8List> read(String assetRef) async {
    final value = values[assetRef];
    if (value == null) throw StateError('Missing test asset: $assetRef');
    return Uint8List.fromList(value);
  }

  @override
  Future<void> close() async {}
}

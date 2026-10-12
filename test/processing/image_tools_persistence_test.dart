import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:worldpainter_pc/generation/generation_runtime.dart';
import 'package:worldpainter_pc/generation/service_connection.dart';
import 'package:worldpainter_pc/media/image_asset_store.dart';
import 'package:worldpainter_pc/processing/image_tools_runtime.dart';
import 'package:worldpainter_pc/prototype/workbench_controller.dart';
import 'package:worldpainter_pc/security/credential_vault_web.dart';
import 'package:worldpainter_pc/storage/sqlite_workspace_store.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  sqfliteFfiInit();

  test('tiled derived result preserves source, freezes parameters and reopens full tool state', () async {
    final directory = await Directory('.tmp').createTemp('tool-persistence-');
    addTearDown(() => directory.delete(recursive: true));
    var assets = await openImageAssetStore(
      directory: '${directory.path}/assets',
    );
    var store = await SQLiteWorkspaceStore.open(
      factory: databaseFactoryFfi,
      path: '${directory.path}/workspace.sqlite',
    );
    final sourceBytes = await _png(320, 160, 0xff203040);
    final otherBytes = await _png(100, 80, 0xff405060);
    final generated = await _png(1024, 1024, 0xffc03050);
    final source = await assets.save(sourceBytes);
    final other = await assets.save(otherBytes);
    final vault = SessionMemoryCredentialVault();
    final connection = ServiceConnection(
      protocol: 'ikun',
      baseUrl: 'https://fixture.example',
    );
    await connection.saveSecret(vault, 'synthetic-fixture-only');
    final received = Completer<void>(), gate = Completer<void>();
    final requests = <Map<String, dynamic>>[];
    final generation = GenerationRuntime(
      assets: assets,
      vault: vault,
      clientFactory: () => MockClient((request) async {
        requests.add(jsonDecode(request.body) as Map<String, dynamic>);
        received.complete();
        await gate.future;
        return http.Response(
          jsonEncode({
            'data': [
              {'b64_json': base64Encode(generated)},
            ],
          }),
          200,
        );
      }),
    );
    final runtime = ImageToolsRuntime(
      assets: assets,
      vault: vault,
      generation: generation,
    );
    var controller = WorkbenchController(
      store: store,
      assets: assets,
      vault: vault,
      processImageTool: runtime.process,
      cancelRequest: runtime.cancel,
    );
    controller.updateConnection(connection);
    controller.updatePrompt('frozen tiled moon fixture');
    controller.updateSeed('0');
    controller.setImageToolSource(source, parentId: 'parent-source');
    controller.updateImageTools({
      ...controller.imageTools,
      'mode': 'tiled',
      'protocol': 'ikun',
      'strength': .3,
    });
    final task = controller.runImageTool();
    await received.future;
    controller.updatePrompt('next task only');
    controller.setImageToolSource(other, parentId: 'new-source');
    gate.complete();
    await task;
    expect(requests, hasLength(1));
    expect(controller.results, hasLength(4));
    final result = controller.selected;
    expect((result.width, result.height), (512, 256));
    expect(result.prompt, 'frozen tiled moon fixture');
    expect(result.seed, 0);
    expect(result.editMetadata!['parentAssetRef'], source.assetRef);
    expect(result.editMetadata!['parentResultId'], 'parent-source');
    expect(controller.imageTools['sourceAssetRef'], other.assetRef);
    expect(
      controller.imageTools['resultAssetRef'],
      isNull,
      reason: 'Late output must not attach to a different source workspace.',
    );
    expect(await assets.read(source.assetRef), sourceBytes);
    expect(
      (await _pixel(await assets.read(result.assetRef!), 240, 120)).take(3),
      [192, 48, 80],
    );

    controller.applyResult(result);
    expect(controller.imageTools['sourceAssetRef'], source.assetRef);
    expect(controller.imageTools['resultAssetRef'], result.assetRef);
    expect(controller.imageTools['strength'], .3);
    expect(controller.parameters.img2imgSourceImageId, source.assetRef);
    await controller.closeStorage();
    controller.dispose();
    assets = await openImageAssetStore(directory: '${directory.path}/assets');
    store = await SQLiteWorkspaceStore.open(
      factory: databaseFactoryFfi,
      path: '${directory.path}/workspace.sqlite',
    );
    controller = WorkbenchController(
      store: store,
      assets: assets,
      restored: await store.load(),
    );
    expect(controller.imageTools['active'], isTrue);
    expect(controller.imageTools['sourceAssetRef'], source.assetRef);
    expect(controller.imageTools['resultAssetRef'], result.assetRef);
    expect(controller.imageToolJob['status'], 'completed');
    expect(await assets.read(source.assetRef), sourceBytes);
    expect(await assets.read(result.assetRef!), isNotEmpty);
    await controller.closeStorage();
    controller.dispose();
  });

  test('cancelled tool response never creates gallery output and recorded interruption does not rerun', () async {
    final entered = Completer<void>(), released = Completer<void>();
    var invocations = 0;
    final controller = WorkbenchController(
      processImageTool:
          (draft, parameters, connection, progress, current) async {
            invocations++;
            await progress('processing 0/1', 0, 1);
            entered.complete();
            await released.future;
            return const SceneResult(
              id: 'late',
              title: 'late fixture',
              prompt: '',
              negative: '',
              width: 64,
              height: 64,
              seed: 0,
              variant: 0,
              favorite: false,
              isDemo: false,
            );
          },
    );
    controller.setImageToolSource(_asset('source'), parentId: 'source-parent');
    final pending = controller.runImageTool();
    await entered.future;
    final interrupted = controller.exportWorkspace();
    controller.cancelGeneration();
    released.complete();
    await pending;
    expect(controller.results, hasLength(3));
    expect(controller.imageToolJob['status'], 'cancelled');
    final reopened = WorkbenchController(
      restored: StoredWorkspace(revision: 0, data: interrupted),
      processImageTool: (_, _, _, _, _) async {
        invocations++;
        throw StateError('must not rerun');
      },
    );
    expect(reopened.imageToolJob['status'], 'interrupted');
    expect(reopened.imageTools['sourceAssetRef'], 'source');
    expect(invocations, 1);
    reopened.dispose();
    controller.dispose();
  });

  test('postprocess settings survive source replacement and failures preserve draft', () async {
    final controller = WorkbenchController(
      processImageTool: (_, _, _, _, _) async =>
          throw const FormatException('fixture HTTP failure'),
    );
    controller.setImageToolSource(_asset('original'));
    controller.updateImageTools({
      ...controller.imageTools,
      'mode': 'director',
      'postprocess': {
        'operation': 'director',
        'source_asset_ref': 'original',
        'width': 64,
        'height': 64,
        'director_tool': 'colorize',
        'prompt': 'warm red coat',
        'defry': 3,
      },
    });
    controller.setImageToolSource(_asset('replacement'));
    expect(
      (controller.imageTools['postprocess'] as Map)['prompt'],
      'warm red coat',
    );
    expect(
      (controller.imageTools['postprocess'] as Map)['source_asset_ref'],
      'replacement',
    );
    await controller.runImageTool();
    expect(controller.imageToolJob['status'], 'failed');
    expect(controller.results, hasLength(3));
    expect(controller.imageTools['sourceAssetRef'], 'replacement');
    controller.dispose();
  });
}

ImageAsset _asset(String ref) => ImageAsset(
  id: ref,
  assetRef: ref,
  width: 64,
  height: 64,
  mime: 'image/png',
  sha256: ref,
  byteLength: 1,
);

Future<Uint8List> _png(int width, int height, int color) async {
  final recorder = ui.PictureRecorder();
  // Draw a deterministic solid fixture without external image assets.
  final painting = ui.Canvas(recorder);
  painting.drawColor(ui.Color(color), ui.BlendMode.src);
  final picture = recorder.endRecording();
  final image = await picture.toImage(width, height);
  try {
    final data = await image.toByteData(format: ui.ImageByteFormat.png);
    return Uint8List.view(data!.buffer, data.offsetInBytes, data.lengthInBytes);
  } finally {
    image.dispose();
    picture.dispose();
  }
}

Future<Uint8List> _pixel(Uint8List bytes, int x, int y) async {
  final codec = await ui.instantiateImageCodec(bytes);
  final image = (await codec.getNextFrame()).image;
  try {
    final data = await image.toByteData(
      format: ui.ImageByteFormat.rawStraightRgba,
    );
    return Uint8List.fromList(
      data!.buffer.asUint8List(
        data.offsetInBytes + (y * image.width + x) * 4,
        4,
      ),
    );
  } finally {
    image.dispose();
    codec.dispose();
  }
}

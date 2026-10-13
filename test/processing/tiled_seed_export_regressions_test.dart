import 'dart:convert';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:worldpainter_pc/generation/generation_parameters.dart';
import 'package:worldpainter_pc/generation/generation_runtime.dart';
import 'package:worldpainter_pc/generation/service_connection.dart';
import 'package:worldpainter_pc/media/image_asset_store.dart';
import 'package:worldpainter_pc/media/image_asset_validation.dart';
import 'package:worldpainter_pc/platform/image_export.dart';
import 'package:worldpainter_pc/processing/image_tools_runtime.dart';
import 'package:worldpainter_pc/prototype/workbench_controller.dart';
import 'package:worldpainter_pc/security/credential_vault_web.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const connection = ServiceConnection(
    protocol: 'gateway7877',
    baseUrl: 'http://127.0.0.1:5090',
  );
  test('NEW regression: tiled Apply all parameters preserves the submitted base seed', () async {
    final store = _MemoryAssets();
    final source = await store.save(await _png(64, 64));
    final tilePng = await _png(1024, 1024);
    final vault = SessionMemoryCredentialVault();
    await connection.saveSecret(vault, 'synthetic-mock-key');
    final capturedSeeds = <Object?>[];
    http.Client clientFactory() => MockClient((request) async {
      final payload = jsonDecode(request.body) as Map;
      capturedSeeds.add((payload['params'] as Map)['seed']);
      return http.Response(
        jsonEncode({
          'data': [
            {'b64_json': base64Encode(tilePng)},
          ],
        }),
        200,
      );
    });
    final runtime = ImageToolsRuntime(
      assets: store,
      vault: vault,
      generation: GenerationRuntime(
        assets: store,
        vault: vault,
        clientFactory: clientFactory,
      ),
      clientFactory: clientFactory,
    );
    final controller = WorkbenchController(processImageTool: runtime.process);
    addTearDown(controller.dispose);
    controller.updateConnection(connection);
    controller.updateProvider(connection.label);
    controller.updateSeed('123');
    controller.setImageToolSource(source);
    controller.updateImageTools({
      ...controller.imageTools,
      'protocol': 'gateway7877',
    });
    await controller.runImageTool();
    expect(controller.imageToolJob['status'], 'completed');
    final result = controller.results.first;
    expect(result.parameters!.seed, 123);
    expect(result.seed, 123);
    controller.applyResult(result);
    final refillSeed = controller.seedText;
    await controller.runImageTool();
    expect(controller.imageToolJob['status'], 'completed');
    debugPrint(
      'TILED_SEED_EVIDENCE submitted=123 firstResult=${result.seed} refill=$refillSeed secondResult=${controller.results.first.seed} wireSeeds=$capturedSeeds',
    );
    expect(
      refillSeed,
      '123',
      reason: 'Full refill must use the submitted base seed, not rehash the first tile seed.',
    );
  });

  test('NEW regression: a supported JPEG Director result can be exported through PNG action', () async {
    final store = _MemoryAssets();
    final source = await store.save(await _png(8, 8));
    final vault = SessionMemoryCredentialVault();
    await connection.saveSecret(vault, 'synthetic-mock-key');
    final jpeg = base64Decode(_jpeg);
    var requests = 0;
    http.Client clientFactory() => MockClient((request) async {
      requests++;
      expect(request.url.path, '/v1/images/generations');
      expect((jsonDecode(request.body) as Map)['extra'], 'director-lineart');
      return http.Response(
        jsonEncode({
          'data': [
            {'b64_json': base64Encode(jpeg)},
          ],
        }),
        200,
      );
    });
    final runtime = ImageToolsRuntime(
      assets: store,
      vault: vault,
      generation: GenerationRuntime(
        assets: store,
        vault: vault,
        clientFactory: clientFactory,
      ),
      clientFactory: clientFactory,
    );
    final result = await runtime.process(
      {
        'version': 1,
        'mode': 'director',
        'sourceAssetRef': source.assetRef,
        'sourceWidth': 8,
        'sourceHeight': 8,
        'postprocess': {
          'operation': 'director',
          'source_asset_ref': source.assetRef,
          'width': 8,
          'height': 8,
          'model': 'nai-diffusion-4-5-full',
          'director_tool': 'lineart',
        },
      },
      GenerationParameters(
        model: 'nai-diffusion-4-5-full',
        prompt: 'synthetic fixture',
        width: 8,
        height: 8,
      ),
      connection,
      (_, _, _) async {},
      () => true,
    );
    final saved = await store.read(result.assetRef!);
    expect(requests, 1);
    expect(result.assetRef, endsWith('.jpg'));
    expect(saved, jpeg);
    debugPrint(
      'JPEG_EXPORT_EVIDENCE requests=$requests saved=${result.assetRef} output=${result.width}x${result.height} format=${detectImageFormat(saved)}',
    );
    // Linux returns false at the platform save-dialog boundary for a valid PNG.
    // This test checks format preparation only; it does not require Windows UI.
    await expectLater(
      exportImage(saved),
      completes,
      reason: 'The UI offers PNG export for every accepted result, so JPEG should be converted before platform export.',
    );
  });
}

class _MemoryAssets implements ImageAssetStore {
  final data = <String, Uint8List>{};
  @override
  String get label => 'isolated regression test assets';
  @override
  Future<ImageAsset> save(Uint8List bytes) async {
    final value = await validateImageAssetBytes(bytes);
    data[value.asset.assetRef] = value.bytes;
    return value.asset;
  }

  @override
  Future<Uint8List> read(String assetRef) async => data[assetRef]!;
  @override
  Future<void> close() async {}
}

Future<Uint8List> _png(int width, int height) async {
  final recorder = ui.PictureRecorder();
  final canvas = ui.Canvas(recorder);
  canvas.drawRect(
    ui.Rect.fromLTWH(0, 0, width.toDouble(), height.toDouble()),
    ui.Paint()..color = const ui.Color(0xff2850a0),
  );
  final picture = recorder.endRecording();
  final image = await picture.toImage(width, height);
  final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
  image.dispose();
  picture.dispose();
  return bytes!.buffer.asUint8List();
}

const _jpeg =
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAIAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDjKKKK+qPHP//Z';

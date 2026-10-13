import 'dart:convert';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:worldpainter_pc/generation/generation_runtime.dart';
import 'package:worldpainter_pc/generation/service_connection.dart';
import 'package:worldpainter_pc/media/image_asset_store.dart';
import 'package:worldpainter_pc/media/image_asset_validation.dart';
import 'package:worldpainter_pc/processing/image_tools_runtime.dart';
import 'package:worldpainter_pc/processing/tiled_img2img.dart';
import 'package:worldpainter_pc/prototype/workbench_controller.dart';
import 'package:worldpainter_pc/security/credential_vault_web.dart';
import 'package:worldpainter_pc/storage/workspace_store.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('fixed seeds replay after refill and reopen', () async {
    final fixture = await _SeedFixture.create();

    for (final baseSeed in <int>[0, 123, 4294967295]) {
      var controller = fixture.newController();
      try {
        fixture.configure(controller, seedText: '$baseSeed');
        final firstRequestStart = fixture.wireSeeds.length;
        await controller.runImageTool();

        expect(controller.imageToolJob['status'], 'completed');
        final first = controller.results.first;
        final firstRecord = _recordFrom(first);
        final firstWireSeeds = fixture.seedsFrom(firstRequestStart);
        expect(firstWireSeeds, hasLength(2));
        expect(first.parameters?.seed, baseSeed);
        expect(first.seed, baseSeed);
        expect(firstRecord.submittedParameters.seed, baseSeed);
        _expectRecordedTileSeeds(first, firstRecord, firstWireSeeds);

        controller.applyResult(first);
        expect(controller.seedText, '$baseSeed');
        expect(
          controller.parameters.toJson(),
          firstRecord.submittedParameters.toJson(),
          reason: 'Apply all must restore the submitted base parameters.',
        );

        final reopened = _jsonWorkspaceRoundTrip(controller);
        controller.dispose();
        controller = fixture.newController(restored: reopened);

        expect(controller.seedText, '$baseSeed');
        expect(
          controller.parameters.toJson(),
          firstRecord.submittedParameters.toJson(),
          reason: 'The stored workspace must retain the submitted seed.',
        );

        final secondRequestStart = fixture.wireSeeds.length;
        await controller.runImageTool();
        expect(controller.imageToolJob['status'], 'completed');
        final second = controller.results.first;
        final secondRecord = _recordFrom(second);
        final secondWireSeeds = fixture.seedsFrom(secondRequestStart);

        expect(secondWireSeeds, firstWireSeeds);
        expect(second.parameters?.seed, baseSeed);
        expect(second.seed, baseSeed);
        expect(secondRecord.submittedParameters.seed, baseSeed);
        _expectRecordedTileSeeds(second, secondRecord, secondWireSeeds);
      } finally {
        controller.dispose();
      }
    }
  });

  test('random base stays blank and records actual tile seeds', () async {
    final fixture = await _SeedFixture.create();
    var controller = fixture.newController();
    try {
      fixture.configure(controller, seedText: '');
      final firstRequestStart = fixture.wireSeeds.length;
      await controller.runImageTool();

      expect(controller.imageToolJob['status'], 'completed');
      final first = controller.results.first;
      final firstRecord = _recordFrom(first);
      final firstWireSeeds = fixture.seedsFrom(firstRequestStart);
      expect(firstWireSeeds, hasLength(2));
      expect(first.parameters?.seed, isNull);
      expect(first.seed, 0);
      expect(firstRecord.submittedParameters.seed, isNull);
      expect(
        firstRecord.executions.map((item) => item.requestedParameters.seed),
        everyElement(isNull),
      );
      _expectRecordedTileSeeds(first, firstRecord, firstWireSeeds);

      controller.applyResult(first);
      expect(controller.seedText, isEmpty);
      expect(controller.parameters.seed, isNull);
      final reopened = _jsonWorkspaceRoundTrip(controller);
      controller.dispose();
      controller = fixture.newController(restored: reopened);

      expect(controller.seedText, isEmpty);
      expect(controller.parameters.seed, isNull);
      final secondRequestStart = fixture.wireSeeds.length;
      await controller.runImageTool();

      expect(controller.imageToolJob['status'], 'completed');
      final second = controller.results.first;
      final secondRecord = _recordFrom(second);
      final secondWireSeeds = fixture.seedsFrom(secondRequestStart);
      expect(secondWireSeeds, hasLength(2));
      expect(second.parameters?.seed, isNull);
      expect(second.seed, 0);
      expect(secondRecord.submittedParameters.seed, isNull);
      _expectRecordedTileSeeds(second, secondRecord, secondWireSeeds);

      controller.applyResult(second);
      expect(controller.seedText, isEmpty);
      expect(controller.parameters.seed, isNull);
    } finally {
      controller.dispose();
    }
  });

  test('legacy tile seed refills base with tile provenance', () async {
    final fixture = await _SeedFixture.create();
    final controller = fixture.newController();
    addTearDown(controller.dispose);
    fixture.configure(controller, seedText: '123');
    final requestStart = fixture.wireSeeds.length;
    await controller.runImageTool();

    expect(controller.imageToolJob['status'], 'completed');
    final current = controller.results.first;
    final record = _recordFrom(current);
    final actualTileSeeds = fixture.seedsFrom(requestStart);
    _expectRecordedTileSeeds(current, record, actualTileSeeds);
    expect(record.submittedParameters.seed, 123);
    expect(current.parameters?.seed, 123);
    expect(actualTileSeeds.first, isNot(123));

    final legacy = SceneResult(
      id: current.id,
      title: current.title,
      prompt: current.prompt,
      negative: current.negative,
      width: current.width,
      height: current.height,
      seed: actualTileSeeds.first,
      variant: current.variant,
      favorite: current.favorite,
      isDemo: current.isDemo,
      model: current.model,
      provider: current.provider,
      steps: current.steps,
      cfg: current.cfg,
      assetRef: current.assetRef,
      parameters: current.parameters,
      editMetadata: current.editMetadata,
    );

    expect(legacy.seed, actualTileSeeds.first);
    expect(legacy.parameters?.seed, 123);
    expect(legacy.refillParameters?.seed, 123);
    expect(
      legacy.generationSeedDetails,
      _tileSeedDetails(actualTileSeeds),
      reason: 'The tile provenance must continue to show actual request seeds.',
    );

    controller.applyResult(legacy);
    expect(controller.seedText, '123');
    expect(controller.parameters.seed, 123);
    expect(controller.parameters.toJson(), record.submittedParameters.toJson());
  });
}

class _SeedFixture {
  _SeedFixture({
    required this.source,
    required this.connection,
    required this.runtime,
    required this.wireSeeds,
  });

  final ImageAsset source;
  final ServiceConnection connection;
  final ImageToolsRuntime runtime;
  final List<Object?> wireSeeds;

  static Future<_SeedFixture> create() async {
    final assets = _MemoryAssets();
    final source = await assets.save(await _png(321, 64, 0xff203040));
    final tileResponse = await _png(1024, 1024, 0xffc03050);
    const connection = ServiceConnection(
      protocol: 'gateway7877',
      baseUrl: 'http://127.0.0.1:5090',
    );
    final vault = SessionMemoryCredentialVault();
    await connection.saveSecret(vault, 'synthetic-mock-key');
    final wireSeeds = <Object?>[];

    http.Client clientFactory() => MockClient((request) async {
      expect(request.url.path, '/v1/images/generations');
      final payload = jsonDecode(request.body) as Map;
      final parameters = payload['params'] as Map;
      wireSeeds.add(parameters['seed']);
      return http.Response(
        jsonEncode({
          'data': [
            {'b64_json': base64Encode(tileResponse)},
          ],
        }),
        200,
        headers: const {'content-type': 'application/json'},
      );
    });

    final generation = GenerationRuntime(
      assets: assets,
      vault: vault,
      clientFactory: clientFactory,
    );
    return _SeedFixture(
      source: source,
      connection: connection,
      runtime: ImageToolsRuntime(
        assets: assets,
        vault: vault,
        generation: generation,
        clientFactory: clientFactory,
      ),
      wireSeeds: wireSeeds,
    );
  }

  WorkbenchController newController({StoredWorkspace? restored}) =>
      WorkbenchController(
        restored: restored,
        processImageTool: runtime.process,
      );

  void configure(WorkbenchController controller, {required String seedText}) {
    controller.updateConnection(connection);
    controller.updateProvider(connection.label);
    controller.updatePrompt('tiled seed replay fixture');
    controller.updateNegative('synthetic negative fixture');
    controller.updateSeed(seedText);
    controller.setImageToolSource(source, parentId: 'seed-replay-source');
    controller.updateImageTools({
      ...controller.imageTools,
      'mode': 'tiled',
      'protocol': 'gateway7877',
      'strength': 0.3,
    });
  }

  List<int> seedsFrom(int start) => wireSeeds
      .skip(start)
      .map((seed) {
        if (seed is! int) {
          throw StateError(
            'The mocked gateway did not receive an integer seed.',
          );
        }
        return seed;
      })
      .toList(growable: false);
}

class _MemoryAssets implements ImageAssetStore {
  final Map<String, Uint8List> _data = <String, Uint8List>{};

  @override
  String get label => 'isolated tiled seed fixture assets';

  @override
  Future<ImageAsset> save(Uint8List bytes) async {
    final validated = await validateImageAssetBytes(bytes);
    _data[validated.asset.assetRef] = validated.bytes;
    return validated.asset;
  }

  @override
  Future<Uint8List> read(String assetRef) async {
    final bytes = _data[assetRef];
    if (bytes == null) throw ImageAssetNotFoundException(assetRef);
    return Uint8List.fromList(bytes);
  }

  @override
  Future<void> close() async {}
}

StoredWorkspace _jsonWorkspaceRoundTrip(WorkbenchController controller) =>
    StoredWorkspace(
      revision: 0,
      data: Map<String, Object?>.from(
        jsonDecode(jsonEncode(controller.exportWorkspace())) as Map,
      ),
    );

TiledImg2ImgRecord _recordFrom(SceneResult result) {
  final raw = result.editMetadata?['tiledImg2Img'];
  if (raw is! Map) throw StateError('The result has no tiled provenance.');
  return TiledImg2ImgRecord.fromJson(Map<String, Object?>.from(raw));
}

void _expectRecordedTileSeeds(
  SceneResult result,
  TiledImg2ImgRecord record,
  List<int> wireSeeds,
) {
  final effectiveSeeds = record.executions
      .map((execution) => execution.effectiveParameters.seed)
      .toList(growable: false);
  expect(effectiveSeeds, wireSeeds);
  expect(result.generationSeedDetails, _tileSeedDetails(wireSeeds));
}

List<String> _tileSeedDetails(List<int> seeds) => [
  for (var index = 0; index < seeds.length; index++)
    '图块 ${index + 1}：${seeds[index]}',
];

Future<Uint8List> _png(int width, int height, int color) async {
  final recorder = ui.PictureRecorder();
  final canvas = ui.Canvas(recorder);
  canvas.drawRect(
    ui.Rect.fromLTWH(0, 0, width.toDouble(), height.toDouble()),
    ui.Paint()..color = ui.Color(color),
  );
  final picture = recorder.endRecording();
  final image = await picture.toImage(width, height);
  try {
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    if (bytes == null) throw StateError('Could not encode PNG fixture.');
    return Uint8List.fromList(
      bytes.buffer.asUint8List(bytes.offsetInBytes, bytes.lengthInBytes),
    );
  } finally {
    image.dispose();
    picture.dispose();
  }
}

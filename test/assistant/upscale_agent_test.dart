import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:worldpainter_pc/assistant/agent_contract.dart';
import 'package:worldpainter_pc/assistant/agent_engine.dart';
import 'package:worldpainter_pc/assistant/workspace_tools.dart';
import 'package:worldpainter_pc/generation/generation_parameters.dart';
import 'package:worldpainter_pc/generation/generation_runtime.dart';
import 'package:worldpainter_pc/generation/service_connection.dart';
import 'package:worldpainter_pc/media/image_asset_store.dart';
import 'package:worldpainter_pc/processing/image_tools_runtime.dart';
import 'package:worldpainter_pc/processing/local_sr.dart';
import 'package:worldpainter_pc/prototype/workbench_controller.dart';
import 'package:worldpainter_pc/security/credential_vault_web.dart';
import 'package:worldpainter_pc/storage/sqlite_workspace_store.dart';

const _provider = AssistantProvider(
  id: 'fixture',
  name: 'fixture',
  baseUrl: 'https://fixture.invalid/v1',
  model: 'fixture-model',
);

const _presets = <String, int>{
  'realesrganAnime4x': 4,
  'realcuganConservative2x': 2,
  'realcuganConservative4x': 4,
};

AgentCall _call(String id, String name, Map<String, dynamic> arguments) =>
    AgentCall(id: id, name: name, arguments: jsonEncode(arguments));

class _FakeTransport implements AgentTransport {
  _FakeTransport(this.replies);

  final List<AgentReply> replies;
  final List<List<Map<String, dynamic>>> requests = [];

  @override
  Future<AgentReply> complete({
    required AssistantProvider provider,
    required List<Map<String, dynamic>> messages,
    required List<Map<String, dynamic>> tools,
    required String toolChoice,
    required AgentCancellation cancellation,
    void Function(String accumulatedText)? onText,
  }) async {
    cancellation.check();
    requests.add(
      messages
          .map(
            (message) =>
                jsonDecode(jsonEncode(message)) as Map<String, dynamic>,
          )
          .toList(),
    );
    if (replies.isEmpty) throw StateError('No fake reply remains.');
    return replies.removeAt(0);
  }
}

class _MemoryAssets implements ImageAssetStore {
  @override
  String get label => 'upscale fixture';

  @override
  Future<ImageAsset> save(Uint8List bytes) async =>
      _asset('saved', width: 1, height: 1);

  @override
  Future<Uint8List> read(String assetRef) async => Uint8List.fromList([1]);

  @override
  Future<void> close() async {}
}

class _ToggleWorkspaceStore implements WorkspaceStore {
  bool failCompletedJobSave = false;
  int revision = 0;
  StoredWorkspace? snapshot;

  @override
  String get label => 'upscale test store';

  @override
  Future<StoredWorkspace?> load() async => snapshot;

  @override
  Future<int> save(
    Map<String, Object?> data, {
    required int expectedRevision,
  }) async {
    final job = data['imageToolJob'];
    if (failCompletedJobSave && job is Map && job['status'] == 'completed') {
      throw StateError('injected completed image job save failure');
    }
    revision = expectedRevision + 1;
    snapshot = StoredWorkspace(data: data, revision: revision);
    return revision;
  }

  @override
  Future<void> close() async {}
}

ImageAsset _asset(String id, {int width = 64, int height = 32}) => ImageAsset(
  id: id,
  assetRef: 'asset:$id',
  width: width,
  height: height,
  mime: 'image/png',
  sha256: id.padRight(64, '0'),
  byteLength: 1,
);

void _addSource(WorkbenchController workbench, ImageAsset asset, String title) {
  workbench.addImported(asset, title: title);
}

Future<Uint8List> _syntheticPng() async {
  final recorder = ui.PictureRecorder();
  final canvas = ui.Canvas(recorder);
  canvas.drawRect(
    const ui.Rect.fromLTWH(0, 0, 64, 64),
    ui.Paint()..color = const ui.Color(0xff557799),
  );
  canvas.drawCircle(
    const ui.Offset(32, 32),
    22,
    ui.Paint()..color = const ui.Color(0xfff5d57a),
  );
  canvas.drawLine(
    const ui.Offset(8, 56),
    const ui.Offset(56, 8),
    ui.Paint()
      ..color = const ui.Color(0xff18222f)
      ..strokeWidth = 3,
  );
  final picture = recorder.endRecording();
  final image = await picture.toImage(64, 64);
  picture.dispose();
  try {
    final data = await image.toByteData(format: ui.ImageByteFormat.png);
    if (data == null) throw StateError('Flutter did not encode synthetic PNG.');
    return data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes);
  } finally {
    image.dispose();
  }
}

SceneResult _derivedResult({
  required String id,
  required String assetRef,
  required int width,
  required int height,
  required String model,
}) => SceneResult(
  id: id,
  title: '派生超分图',
  prompt: 'fixture prompt',
  negative: '',
  width: width,
  height: height,
  seed: 0,
  variant: 0,
  favorite: false,
  isDemo: false,
  model: model,
  provider: 'Windows 本地超分',
  assetRef: assetRef,
  editMetadata: const {'operation': 'localSr'},
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  sqfliteFfiInit();

  test(
    'lists managed Gallery IDs and confirms a frozen local source and preset',
    () async {
      late WorkbenchController workbench;
      final processed = <Map<String, Object?>>[];
      workbench = WorkbenchController(
        assets: _MemoryAssets(),
        localSrAvailable: true,
        processImageTool:
            (draft, parameters, connection, onProgress, isCurrent) async {
              final postprocess = Map<String, Object?>.from(
                draft['postprocess']! as Map,
              );
              processed.add({
                'draft': Map<String, Object?>.from(draft),
                'connection': connection,
                'parameters': parameters,
              });
              expect(isCurrent(), isTrue);
              return _derivedResult(
                id: 'derived-real-id-1',
                assetRef: 'asset:derived-1',
                width:
                    (draft['sourceWidth']! as int) *
                    (postprocess['scale']! as num).toInt(),
                height:
                    (draft['sourceHeight']! as int) *
                    (postprocess['scale']! as num).toInt(),
                model: postprocess['model']! as String,
              ).copyWith(
                editMetadata: {
                  'operation': 'localSr',
                  'parentAssetRef': draft['sourceAssetRef'],
                  'parentResultId': draft['parentId'],
                },
              );
            },
      );
      addTearDown(workbench.dispose);
      final sourceA = _asset('source-a');
      final sourceB = _asset('source-b', width: 80, height: 40);
      _addSource(workbench, sourceA, '源图 A');
      _addSource(workbench, sourceB, '源图 B');
      workbench.setImageToolSource(sourceA, parentId: 'import-source-a');
      final tools = {
        for (final tool in WorkspaceAgentTools(workbench).build())
          tool.name: tool,
      };
      final galleryPlan = await tools['read_gallery']!.prepare(
        {},
        AgentCancellation(),
      );
      final gallery = await galleryPlan.execute();
      final galleryIds = (gallery['images']! as List)
          .map((item) => (item as Map)['id'])
          .toSet();
      expect(galleryIds, contains('import-source-a'));
      expect(galleryIds, contains('import-source-b'));
      expect(galleryIds, isNot(contains('demo-moonlit-ridge')));

      final upscaleTool = tools['upscale_image']!;
      final schema = upscaleTool.parameters['properties'] as Map;
      expect((schema['preset'] as Map)['enum'], unorderedEquals(_presets.keys));
      expect(schema, isNot(contains('scale')));
      final previews = <Map<String, dynamic>>[];
      for (final entry in _presets.entries) {
        final plan = await upscaleTool.prepare({
          'image_id': 'import-source-a',
          'preset': entry.key,
        }, AgentCancellation());
        expect(plan.confirm, isTrue);
        expect(plan.preview['图片 ID'], 'import-source-a');
        expect(plan.preview['assetRef'], 'asset:source-a');
        expect(plan.preview['图片'], '源图 A');
        expect(plan.preview['模型'], isNotEmpty);
        expect(plan.preview['倍率'], '${entry.value}×');
        expect(plan.preview['输入尺寸'], '64 × 32');
        expect(
          plan.preview['预期输出尺寸'],
          '${64 * entry.value} × ${32 * entry.value}',
        );
        previews.add(plan.preview);
      }
      expect(
        processed,
        isEmpty,
        reason: 'prepare and preview must not execute',
      );

      final transport = _FakeTransport([
        AgentReply(calls: [_call('gallery-1', 'read_gallery', {})]),
        AgentReply(
          calls: [
            _call('upscale-1', 'upscale_image', {
              'image_id': 'import-source-a',
              'preset': 'realcuganConservative2x',
            }),
          ],
        ),
        const AgentReply(content: '本地超分完成。'),
      ]);
      Map<String, dynamic>? confirmedPreview;
      await AgentEngine(transport: transport, tools: tools.values.toList()).run(
        provider: _provider,
        context: const [
          {'role': 'user', 'content': '放大源图 A'},
        ],
        cancellation: AgentCancellation(),
        requireFirstTool: true,
        confirm: (call, plan) async {
          expect(call.name, 'upscale_image');
          confirmedPreview = plan.preview;
          // Changing the UI source while confirmation is open must not retarget
          // this approved request or attach its result to the new draft.
          workbench.setImageToolSource(sourceB, parentId: 'import-source-b');
          return true;
        },
        onMessage: (_) {},
        onTrace: (_) {},
      );

      expect(confirmedPreview, containsPair('图片 ID', 'import-source-a'));
      expect(confirmedPreview, containsPair('assetRef', 'asset:source-a'));
      expect(processed, hasLength(1));
      final submitted = processed.single['draft']! as Map<String, Object?>;
      expect(submitted['mode'], 'localSr');
      expect(submitted['sourceAssetRef'], 'asset:source-a');
      expect(submitted['sourceWidth'], 64);
      expect(submitted['sourceHeight'], 32);
      expect(processed.single['connection'], isA<ServiceConnection>());
      expect(
        (processed.single['connection']! as ServiceConnection).protocol,
        'official',
        reason: 'local SR is routed through the local processor path only',
      );
      final params = submitted['postprocess']! as Map;
      expect(params['operation'], 'local_sr');
      expect(params['source_asset_ref'], 'asset:source-a');
      expect(params['model'], 'realcuganConservative2x');
      expect(params['scale'], 2.0);
      expect(submitted['parentId'], 'import-source-a');
      expect(workbench.imageTools['sourceAssetRef'], 'asset:source-b');
      expect(workbench.imageTools['resultId'], isNull);
      expect(
        workbench.results.map((result) => result.id),
        contains('derived-real-id-1'),
      );

      final sourceToolResult = transport.requests[2].firstWhere(
        (message) =>
            message['role'] == 'tool' && message['tool_call_id'] == 'upscale-1',
      );
      final result = jsonDecode(sourceToolResult['content'] as String) as Map;
      expect(result['ok'], isTrue);
      expect(result['image_id'], 'derived-real-id-1');
      expect(result['image_id'], isNot('made-up-id'));
      expect(result['source_image_id'], 'import-source-a');
      expect(result['width'], 128);
      expect(result['height'], 64);
      expect(workbench.imageToolJob['status'], 'completed');
    },
  );

  test(
    'rejects unknown, demo, removed and oversized gallery sources',
    () async {
      var processCalls = 0;
      final workbench = WorkbenchController(
        assets: _MemoryAssets(),
        localSrAvailable: true,
        processImageTool: (_, _, _, _, _) async {
          processCalls++;
          throw StateError('must not process an invalid source');
        },
      );
      addTearDown(workbench.dispose);
      final source = _asset('source-a');
      _addSource(workbench, source, '源图 A');
      final tool = {
        for (final item in WorkspaceAgentTools(workbench).build())
          item.name: item,
      }['upscale_image']!;
      final token = AgentCancellation();

      await expectLater(
        tool.prepare({
          'image_id': 'arbitrary-path.png',
          'preset': 'realesrganAnime4x',
        }, token),
        throwsA(isA<AgentException>()),
      );
      await expectLater(
        tool.prepare({
          'image_id': 'demo-moonlit-ridge',
          'preset': 'realesrganAnime4x',
        }, token),
        throwsA(isA<AgentException>()),
      );
      await expectLater(
        tool.prepare({
          'image_id': 'import-large',
          'preset': 'realcuganConservative4x',
        }, token),
        throwsA(isA<AgentException>()),
      );
      _addSource(workbench, _asset('large', width: 4096, height: 2048), '过大源图');
      await expectLater(
        tool.prepare({
          'image_id': 'import-large',
          'preset': 'realcuganConservative4x',
        }, token),
        throwsA(isA<AgentException>()),
      );

      final plan = await tool.prepare({
        'image_id': 'import-source-a',
        'preset': 'realcuganConservative2x',
      }, token);
      await workbench.removeGalleryRecords({'import-source-a'});
      await expectLater(plan.execute(), throwsA(isA<AgentException>()));
      expect(processCalls, 0);
    },
  );

  test(
    'cancelling a running upscale cancels the shared processing task',
    () async {
      final entered = Completer<void>();
      var isCurrentAfterCancel = true;
      final workbench = WorkbenchController(
        assets: _MemoryAssets(),
        localSrAvailable: true,
        processImageTool:
            (draft, parameters, connection, onProgress, isCurrent) async {
              if (!entered.isCompleted) entered.complete();
              await Future<void>.delayed(Duration.zero);
              isCurrentAfterCancel = isCurrent();
              return _derivedResult(
                id: 'late-result',
                assetRef: 'asset:late-result',
                width: 128,
                height: 64,
                model: 'realcuganConservative2x',
              );
            },
      );
      addTearDown(workbench.dispose);
      _addSource(workbench, _asset('source-a'), '源图 A');
      final tool = {
        for (final item in WorkspaceAgentTools(workbench).build())
          item.name: item,
      }['upscale_image']!;
      final cancellation = AgentCancellation();
      final plan = await tool.prepare({
        'image_id': 'import-source-a',
        'preset': 'realcuganConservative2x',
      }, cancellation);
      final execution = plan.execute();
      await entered.future;
      cancellation.cancel();
      await expectLater(execution, throwsA(isA<AgentCancelled>()));

      expect(isCurrentAfterCancel, isFalse);
      expect(workbench.imageToolJob['status'], 'cancelled');
      expect(
        workbench.results.any((result) => result.id == 'late-result'),
        isFalse,
      );
      expect(
        workbench.results.any((result) => result.id == 'import-source-a'),
        isTrue,
      );
    },
  );

  test(
    'closing the workbench cancels a running upscale and ignores late output',
    () async {
      final entered = Completer<void>();
      final releasedByClose = Completer<void>();
      final workbench = WorkbenchController(
        assets: _MemoryAssets(),
        localSrAvailable: true,
        cancelRequest: () {
          if (!releasedByClose.isCompleted) releasedByClose.complete();
        },
        processImageTool:
            (draft, parameters, connection, onProgress, isCurrent) async {
              if (!entered.isCompleted) entered.complete();
              await releasedByClose.future;
              return _derivedResult(
                id: 'late-after-close',
                assetRef: 'asset:late-after-close',
                width: 128,
                height: 64,
                model: 'realcuganConservative2x',
              ).copyWith(
                editMetadata: {
                  'operation': 'localSr',
                  'parentAssetRef': 'asset:source-close',
                  'parentResultId': 'import-source-close',
                },
              );
            },
      );
      addTearDown(workbench.dispose);
      final source = _asset('source-close');
      _addSource(workbench, source, '关闭前源图');
      final tool = {
        for (final item in WorkspaceAgentTools(workbench).build())
          item.name: item,
      }['upscale_image']!;
      final plan = await tool.prepare({
        'image_id': 'import-source-close',
        'preset': 'realcuganConservative2x',
      }, AgentCancellation());
      final execution = plan.execute();
      final executionExpectation = expectLater(
        execution,
        throwsA(isA<AgentException>()),
      );
      await entered.future;
      await workbench.closeStorage();
      await executionExpectation;

      expect(workbench.imageToolJob['status'], 'cancelled');
      expect(
        workbench.results.any((result) => result.id == 'late-after-close'),
        isFalse,
      );
    },
  );

  test(
    'fails without returning an ID when processing fails or saves no asset',
    () async {
      final failedController = WorkbenchController(
        assets: _MemoryAssets(),
        localSrAvailable: true,
        processImageTool: (_, _, _, _, _) async =>
            throw const FormatException('本地模型运行失败'),
      );
      addTearDown(failedController.dispose);
      _addSource(failedController, _asset('failed-source'), '失败源图');
      final failedTool = {
        for (final item in WorkspaceAgentTools(failedController).build())
          item.name: item,
      }['upscale_image']!;
      final failedPlan = await failedTool.prepare({
        'image_id': 'import-failed-source',
        'preset': 'realcuganConservative2x',
      }, AgentCancellation());
      await expectLater(
        failedPlan.execute(),
        throwsA(
          isA<AgentException>().having(
            (error) => error.message,
            'message',
            contains('本地模型运行失败'),
          ),
        ),
      );
      expect(failedController.imageToolJob['status'], 'failed');

      final noOutputController = WorkbenchController(
        assets: _MemoryAssets(),
        localSrAvailable: true,
        processImageTool:
            (draft, parameters, connection, onProgress, isCurrent) async =>
                _derivedResult(
                  id: 'missing-asset-result',
                  assetRef: '',
                  width: 128,
                  height: 64,
                  model: 'realcuganConservative2x',
                ),
      );
      addTearDown(noOutputController.dispose);
      _addSource(noOutputController, _asset('no-output-source'), '无输出源图');
      final noOutputTool = {
        for (final item in WorkspaceAgentTools(noOutputController).build())
          item.name: item,
      }['upscale_image']!;
      final noOutputPlan = await noOutputTool.prepare({
        'image_id': 'import-no-output-source',
        'preset': 'realcuganConservative2x',
      }, AgentCancellation());
      await expectLater(noOutputPlan.execute(), throwsA(isA<AgentException>()));
      expect(noOutputController.imageToolJob['status'], 'failed');
      expect(
        noOutputController.results.any(
          (item) => item.id == 'missing-asset-result',
        ),
        isFalse,
      );
    },
  );

  test('does not return a derived ID when the Gallery save fails', () async {
    final store = _ToggleWorkspaceStore();
    final workbench = WorkbenchController(
      store: store,
      assets: _MemoryAssets(),
      localSrAvailable: true,
      processImageTool:
          (draft, parameters, connection, onProgress, isCurrent) async =>
              _derivedResult(
                id: 'unsaved-derived-result',
                assetRef: 'asset:unsaved-derived-result',
                width: 128,
                height: 64,
                model: 'realcuganConservative2x',
              ).copyWith(
                editMetadata: {
                  'operation': 'localSr',
                  'parentAssetRef': 'asset:save-failure-source',
                  'parentResultId': 'import-save-failure-source',
                },
              ),
    );
    addTearDown(workbench.dispose);
    _addSource(workbench, _asset('save-failure-source'), '保存失败源图');
    await workbench.flush();
    store.failCompletedJobSave = true;
    final tool = {
      for (final item in WorkspaceAgentTools(workbench).build())
        item.name: item,
    }['upscale_image']!;
    final plan = await tool.prepare({
      'image_id': 'import-save-failure-source',
      'preset': 'realcuganConservative2x',
    }, AgentCancellation());

    await expectLater(plan.execute(), throwsA(isA<AgentException>()));
    expect(workbench.saveFailed, isTrue);
    expect(workbench.imageToolJob['status'], 'failed');
    expect(
      workbench.results.any((item) => item.id == 'unsaved-derived-result'),
      isTrue,
      reason: 'the failed write remains visible only in this unsaved window',
    );
  });

  test(
    'blocks upscale while generation, encoding, or Gallery maintenance runs',
    () async {
      final processingEntered = Completer<void>();
      final allowProcessing = Completer<void>();
      final allowEncoding = Completer<void>();
      final workbench = WorkbenchController(
        generationDelay: const Duration(seconds: 30),
        assets: _MemoryAssets(),
        localSrAvailable: true,
        encodeVibe:
            ({
              required sourceAssetRef,
              required title,
              required model,
              required connection,
              informationExtracted = 1.0,
              strength = 0.3,
            }) async {
              await allowEncoding.future;
              throw StateError('fixture encoding complete');
            },
        processImageTool:
            (draft, parameters, connection, onProgress, isCurrent) async {
              if (!processingEntered.isCompleted) processingEntered.complete();
              await allowProcessing.future;
              return _derivedResult(
                id: 'held-result',
                assetRef: 'asset:held-result',
                width: 128,
                height: 64,
                model: 'realcuganConservative2x',
              ).copyWith(
                editMetadata: {
                  'operation': 'localSr',
                  'parentAssetRef': draft['sourceAssetRef'],
                  'parentResultId': draft['parentId'],
                },
              );
            },
      );
      addTearDown(workbench.dispose);
      final source = _asset('source-a');
      _addSource(workbench, source, '源图 A');
      final tool = {
        for (final item in WorkspaceAgentTools(workbench).build())
          item.name: item,
      }['upscale_image']!;

      final generation = workbench.generate();
      await expectLater(
        tool.prepare({
          'image_id': 'import-source-a',
          'preset': 'realcuganConservative2x',
        }, AgentCancellation()),
        throwsA(isA<AgentException>()),
      );
      workbench.cancelGeneration();
      await generation;

      final maintenanceGate = Completer<void>();
      final maintenance = workbench.maintainAssets(
        () => maintenanceGate.future,
      );
      await expectLater(
        tool.prepare({
          'image_id': 'import-source-a',
          'preset': 'realcuganConservative2x',
        }, AgentCancellation()),
        throwsA(isA<AgentException>()),
      );
      maintenanceGate.complete();
      await maintenance;

      final token = AgentCancellation();
      final encoding = workbench.saveVibeReference(
        VibeReference(assetId: source.assetRef),
        'fixture encoding',
      );
      await Future<void>.delayed(Duration.zero);
      await expectLater(
        tool.prepare({
          'image_id': 'import-source-a',
          'preset': 'realcuganConservative2x',
        }, token),
        throwsA(isA<AgentException>()),
      );
      allowEncoding.complete();
      await expectLater(encoding, throwsA(isA<StateError>()));

      // A running image-processing job uses the same busy guard as generation.
      final plan = await tool.prepare({
        'image_id': 'import-source-a',
        'preset': 'realcuganConservative2x',
      }, AgentCancellation());
      final execution = plan.execute();
      await processingEntered.future;
      await expectLater(
        tool.prepare({
          'image_id': 'import-source-a',
          'preset': 'realcuganConservative2x',
        }, AgentCancellation()),
        throwsA(isA<AgentException>()),
      );
      allowProcessing.complete();
      await execution;
    },
  );

  test(
    'opt-in Windows probe runs all local SR presets and reopens SQLite results',
    () async {
      final tempRoot = Directory('.tmp').absolute;
      await tempRoot.create(recursive: true);
      final directory = await tempRoot.createTemp('agent-sr-probe-');
      await File('.tmp/assistant-images-sr-probe-path.txt')
          .writeAsString('${directory.absolute.path}\n', flush: true);
      final configuredRuntime = Platform.environment['WORLDPAINTER_SR_RUNTIME'];
      expect(configuredRuntime, isNotNull);
      expect(
        configuredRuntime!.replaceAll('\\', '/').replaceAll(RegExp(r'/+$'), ''),
        endsWith('/.tmp/sr-runtime'),
      );
      WorkbenchController? activeController;
      addTearDown(() async {
        final controller = activeController;
        if (controller != null) {
          try {
            await controller.closeStorage();
          } catch (_) {}
          controller.dispose();
        }
      });

      var assets = await openImageAssetStore(
        directory: '${directory.path}/assets',
      );
      var store = await SQLiteWorkspaceStore.open(
        factory: databaseFactoryFfi,
        path: '${directory.path}/workspace.sqlite',
      );
      final sourceBytes = await _syntheticPng();
      final source = await assets.save(sourceBytes);
      final vault = SessionMemoryCredentialVault();
      final localSr = createLocalSuperResolution();
      expect(localSr.info.availableModels, containsAll(_presets.keys));
      final generation = GenerationRuntime(assets: assets, vault: vault);
      final runtime = ImageToolsRuntime(
        assets: assets,
        vault: vault,
        generation: generation,
        localSr: localSr,
        clientFactory: () => throw StateError(
          'local upscale must never create a remote HTTP client',
        ),
      );
      activeController = WorkbenchController(
        store: store,
        assets: assets,
        vault: vault,
        processImageTool: runtime.process,
        cancelRequest: runtime.cancel,
        localSrAvailable: true,
        localSrInfo: 'Windows 本地超分可用',
      );
      activeController.addImported(source, title: '合成 64×64 源图');

      final derivedIds = <String>[];
      for (final preset in _presets.entries) {
        final callId = 'upscale-${preset.key}';
        final transport = _FakeTransport([
          AgentReply(
            calls: [
              _call(callId, 'upscale_image', {
                'image_id': 'import-${source.id}',
                'preset': preset.key,
              }),
            ],
          ),
          const AgentReply(content: 'local probe completed'),
        ]);
        Map<String, dynamic>? preview;
        await AgentEngine(
          transport: transport,
          tools: WorkspaceAgentTools(activeController).build(),
        ).run(
          provider: _provider,
          context: const [
            {'role': 'user', 'content': 'Run the opted-in local SR probe.'},
          ],
          cancellation: AgentCancellation(),
          requireFirstTool: true,
          confirm: (call, plan) async {
            expect(call.name, 'upscale_image');
            preview = plan.preview;
            return true;
          },
          onMessage: (_) {},
          onTrace: (_) {},
        );

        final expectedSize = 64 * preset.value;
        expect(preview?['图片 ID'], 'import-${source.id}');
        expect(preview?['预期输出尺寸'], '$expectedSize × $expectedSize');
        final toolMessage = transport.requests[1].firstWhere(
          (message) =>
              message['role'] == 'tool' && message['tool_call_id'] == callId,
        );
        final toolResult = jsonDecode(toolMessage['content'] as String) as Map;
        expect(toolResult['ok'], isTrue);
        expect(toolResult['width'], expectedSize);
        expect(toolResult['height'], expectedSize);
        final derivedId = toolResult['image_id'] as String;
        final derived = activeController.results.firstWhere(
          (item) => item.id == derivedId,
        );
        expect(derived.assetRef, isNotEmpty);
        expect(derived.width, expectedSize);
        expect(derived.height, expectedSize);
        expect(derived.editMetadata?['parentAssetRef'], source.assetRef);
        expect(derived.editMetadata?['parentResultId'], 'import-${source.id}');
        expect(
          (derived.editMetadata?['postprocess'] as Map)['model'],
          preset.key,
        );
        expect(await assets.read(derived.assetRef!), isNotEmpty);
        derivedIds.add(derivedId);
      }

      expect(derivedIds, hasLength(3));
      expect(derivedIds.toSet(), hasLength(3));
      expect(await assets.read(source.assetRef), sourceBytes);
      await activeController.closeStorage();
      activeController.dispose();
      activeController = null;

      assets = await openImageAssetStore(directory: '${directory.path}/assets');
      store = await SQLiteWorkspaceStore.open(
        factory: databaseFactoryFfi,
        path: '${directory.path}/workspace.sqlite',
      );
      activeController = WorkbenchController(
        store: store,
        assets: assets,
        restored: await store.load(),
      );
      expect(activeController.imageToolJob['status'], 'completed');
      for (var index = 0; index < _presets.length; index++) {
        final preset = _presets.entries.elementAt(index);
        final derived = activeController.results.firstWhere(
          (item) => item.id == derivedIds[index],
        );
        expect(derived.width, 64 * preset.value);
        expect(derived.height, 64 * preset.value);
        expect(derived.editMetadata?['parentAssetRef'], source.assetRef);
        expect(await assets.read(derived.assetRef!), isNotEmpty);
      }
      expect(await assets.read(source.assetRef), sourceBytes);
      await activeController.closeStorage();
      activeController.dispose();
      activeController = null;
    },
    skip:
        Platform.environment['WORLDPAINTER_AGENT_SR_PROBE'] != '1' ||
        !Platform.isWindows,
  );
}

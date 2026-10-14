import 'dart:convert';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:worldpainter_pc/assistant/agent_contract.dart';
import 'package:worldpainter_pc/assistant/agent_engine.dart';
import 'package:worldpainter_pc/assistant/workspace_tools.dart';
import 'package:worldpainter_pc/editing/image_editing_session.dart';
import 'package:worldpainter_pc/generation/generation_parameters.dart';
import 'package:worldpainter_pc/generation/service_connection.dart';
import 'package:worldpainter_pc/media/image_asset_store.dart';
import 'package:worldpainter_pc/prototype/workbench_controller.dart';

const _provider = AssistantProvider(
  id: 'fixture',
  name: 'fixture',
  baseUrl: 'https://fixture.invalid/v1',
  model: 'fixture-model',
);

AgentCall _call(String id, String name, Map<String, dynamic> arguments) =>
    AgentCall(id: id, name: name, arguments: jsonEncode(arguments));

class _FakeTransport implements AgentTransport {
  _FakeTransport(this.replies, {this.requestLog});

  final List<AgentReply> replies;
  final List<List<Map<String, dynamic>>>? requestLog;

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
    requestLog?.add([
      for (final message in messages) Map<String, dynamic>.from(message),
    ]);
    if (replies.isEmpty) throw StateError('No fake reply remains.');
    return replies.removeAt(0);
  }
}

class _MemoryAssets implements ImageAssetStore {
  final Map<String, Uint8List> _bytesByRef = {};
  int _next = 0;

  @override
  String get label => 'generation agent fixture';

  @override
  Future<ImageAsset> save(Uint8List bytes) async {
    final codec = await ui.instantiateImageCodec(bytes);
    late final int width;
    late final int height;
    try {
      final frame = await codec.getNextFrame();
      width = frame.image.width;
      height = frame.image.height;
      frame.image.dispose();
    } finally {
      codec.dispose();
    }
    final id = sha256.convert(bytes).toString();
    final assetRef = 'asset:generation-${++_next}';
    _bytesByRef[assetRef] = Uint8List.fromList(bytes);
    return ImageAsset(
      id: id,
      assetRef: assetRef,
      width: width,
      height: height,
      mime: 'image/png',
      sha256: id,
      byteLength: bytes.length,
    );
  }

  @override
  Future<Uint8List> read(String assetRef) async {
    final bytes = _bytesByRef[assetRef];
    if (bytes == null) throw ImageAssetNotFoundException(assetRef);
    return Uint8List.fromList(bytes);
  }

  @override
  Future<void> close() async {}
}

typedef _Generate = Future<SceneResult> Function(
  GenerationParameters parameters,
  ServiceConnection connection,
  _MemoryAssets assets,
  int callNumber,
);

class _Fixture {
  _Fixture({
    required this.workbench,
    required this.assets,
    required this.source,
    required this.mask,
    required this.editing,
    required this.calls,
  });

  final WorkbenchController workbench;
  final _MemoryAssets assets;
  final ImageAsset source;
  final ImageAsset mask;
  final ImageEditingSession editing;
  final List<GenerationParameters> calls;
}

Future<_Fixture> _fixture({
  GenerationOperation operation = GenerationOperation.textToImage,
  bool includeSource = true,
  bool includeMask = true,
  int? failOnCall,
  _Generate? generate,
}) async {
  final assets = _MemoryAssets();
  final source = await assets.save(await _png(64, 64, 0xff557799));
  final mask = await assets.save(await _png(64, 64, 0xffffffff));
  final calls = <GenerationParameters>[];
  var callNumber = 0;
  late final WorkbenchController workbench;
  workbench = WorkbenchController(
    generationDelay: Duration.zero,
    assets: assets,
    generateImage: (parameters, connection) async {
      callNumber++;
      calls.add(parameters);
      if (generate != null) {
        return generate(parameters, connection, assets, callNumber);
      }
      if (failOnCall == callNumber) {
        throw StateError('synthetic generation failure');
      }
      final image = await assets.save(
        await _png(parameters.width, parameters.height, 0xfff5d57a),
      );
      return SceneResult(
        id: 'generated-$callNumber',
        title: 'Synthetic image $callNumber',
        prompt: parameters.prompt,
        negative: parameters.negativePrompt ?? '',
        width: image.width,
        height: image.height,
        seed: parameters.seed ?? callNumber,
        variant: 0,
        favorite: false,
        isDemo: false,
        model: parameters.model,
        provider: connection.label,
        assetRef: image.assetRef,
        parameters: parameters,
      );
    },
  );
  workbench.setSize(64, 64);
  workbench.updateAdvanced(
    workbench.parameters.copyWith(
      operation: operation,
      sourceImageId: operation == GenerationOperation.inpaint && includeSource
          ? source.assetRef
          : null,
      img2imgSourceImageId:
          operation == GenerationOperation.imageToImage && includeSource
          ? source.assetRef
          : null,
      img2imgStrength: 0.42,
      inpaintStrength: 0.61,
    ),
  );
  workbench.updatePrompt('draft prompt');
  workbench.updateNegative('draft negative');
  workbench.updateConnection(
    const ServiceConnection(
      protocol: 'official',
      baseUrl: 'https://image.novelai.net',
    ),
  );
  final editing = ImageEditingSession(
    assets: assets,
    onPersist: workbench.updateImageEditing,
  );
  if (operation == GenerationOperation.inpaint && includeSource) {
    editing.setSource(source, parentId: 'source-result');
    if (includeMask) {
      editing.changeDocument(
        editing.document!.copyWith(importedMaskAssetRef: mask.assetRef),
      );
    }
  } else if (operation == GenerationOperation.imageToImage && includeSource) {
    editing.setImg2img({
      'originalAssetRef': source.assetRef,
      'preparedAssetRef': source.assetRef,
      'originalWidth': source.width,
      'originalHeight': source.height,
      'targetWidth': 64,
      'targetHeight': 64,
      'crop': [0, 0, 64, 64],
      'parentResultId': 'source-result',
    });
  }
  return _Fixture(
    workbench: workbench,
    assets: assets,
    source: source,
    mask: mask,
    editing: editing,
    calls: calls,
  );
}

Future<Uint8List> _png(int width, int height, int color) async {
  final recorder = ui.PictureRecorder();
  final canvas = ui.Canvas(recorder);
  canvas.drawRect(
    ui.Rect.fromLTWH(0, 0, width.toDouble(), height.toDouble()),
    ui.Paint()..color = ui.Color(color),
  );
  final picture = recorder.endRecording();
  final image = await picture.toImage(width, height);
  picture.dispose();
  try {
    final data = await image.toByteData(format: ui.ImageByteFormat.png);
    if (data == null) throw StateError('Failed to encode fixture PNG.');
    return data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes);
  } finally {
    image.dispose();
  }
}

Future<List<Map<String, dynamic>>> _run(
  _Fixture fixture,
  List<AgentReply> replies, {
  AgentConfirm? confirm,
  AgentCancellation? cancellation,
  List<List<Map<String, dynamic>>>? requestLog,
}) async {
  final messages = <Map<String, dynamic>>[];
  final tools = WorkspaceAgentTools(fixture.workbench).build();
  await AgentEngine(
    transport: _FakeTransport(replies, requestLog: requestLog),
    tools: tools,
  ).run(
    provider: _provider,
    context: const [
      {
        'role': 'user',
        'content': 'Use the current workbench generation settings.',
      },
    ],
    cancellation: cancellation ?? AgentCancellation(),
    requireFirstTool: true,
    confirm: confirm,
    onMessage: messages.add,
    onTrace: (_) {},
  );
  return [
    for (final message in messages.where((item) => item['role'] == 'tool'))
      jsonDecode(message['content'] as String) as Map<String, dynamic>,
  ];
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test(
    'img2img uses the current crop and reports only receipt image IDs',
    () async {
      final fixture = await _fixture(
        operation: GenerationOperation.imageToImage,
      );
      addTearDown(() async {
        fixture.editing.dispose();
        fixture.workbench.dispose();
        await fixture.assets.close();
      });
      fixture.workbench.addImported(fixture.source, title: 'Current source');

      final tools = {
        for (final tool in WorkspaceAgentTools(fixture.workbench).build())
          tool.name: tool,
      };
      final generationSchema =
          (tools['generate_image']!.parameters['properties']
              as Map<String, dynamic>);
      expect((generationSchema['batch_count'] as Map)['maximum'], 2);
      expect(
        generationSchema.keys,
        unorderedEquals(['prompt', 'negative_prompt', 'batch_count']),
      );

      Map<String, dynamic>? preview;
      final results = await _run(
        fixture,
        [
          AgentReply(calls: [_call('read-1', 'read_current_prompts', {})]),
          AgentReply(
            calls: [
              _call('generate-1', 'generate_image', {
                'prompt': 'temporary assistant prompt',
                'negative_prompt': 'temporary negative',
                'batch_count': 2,
              }),
            ],
          ),
          const AgentReply(content: 'The confirmed images were generated.'),
        ],
        confirm: (call, plan) async {
          expect(call.name, 'generate_image');
          preview = plan.preview;
          return true;
        },
      );

      expect(fixture.calls, hasLength(2));
      expect(
        fixture.calls.map((parameters) => parameters.operation),
        everyElement(GenerationOperation.imageToImage),
      );
      expect(
        fixture.calls.map((parameters) => parameters.prompt),
        everyElement('temporary assistant prompt'),
      );
      expect(fixture.workbench.parameters.prompt, 'draft prompt');
      expect(preview, containsPair('操作', '图生图'));
      expect(preview, containsPair('图生图强度', 0.42));
      expect(jsonEncode(preview), contains(fixture.source.assetRef));

      expect(results, hasLength(2));
      expect(results.first['operation'], 'image_to_image');
      expect(results.last, containsPair('ok', true));
      expect(results.last['completed'], 2);
      expect(results.last['image_ids'], ['generated-1', 'generated-2']);
      expect(
        results.last['image_ids'],
        isNot(contains('import-${fixture.source.id}')),
      );
      final current = results.first;
      expect(current['source_image_ref'], fixture.source.assetRef);
      expect(current['img2img_strength'], 0.42);
      expect(current['editor_input_state']['img2img_crop_ready'], true);
    },
  );

  test(
    'inpaint rasterizes the current source and mask before confirmation',
    () async {
      final fixture = await _fixture(operation: GenerationOperation.inpaint);
      addTearDown(() async {
        fixture.editing.dispose();
        fixture.workbench.dispose();
        await fixture.assets.close();
      });

      Map<String, dynamic>? preview;
      final results = await _run(
        fixture,
        [
          AgentReply(calls: [_call('read-1', 'read_current_prompts', {})]),
          AgentReply(
            calls: [
              _call('generate-1', 'generate_image', {
                'prompt': 'repainted subject',
                'batch_count': 1,
              }),
            ],
          ),
          const AgentReply(content: 'The inpaint result was saved.'),
        ],
        confirm: (_, plan) async {
          preview = plan.preview;
          expect(plan.preview['操作'], '局部重绘');
          expect(plan.preview['maskAssetRef'], isNotEmpty);
          return true;
        },
      );

      expect(fixture.calls, hasLength(1));
      final parameters = fixture.calls.single;
      expect(parameters.operation, GenerationOperation.inpaint);
      expect(parameters.sourceImageId, isNot(fixture.source.assetRef));
      expect(parameters.maskImageId, isNotEmpty);
      expect(parameters.inpaintStrength, 0.61);
      expect(jsonEncode(preview), contains(fixture.source.assetRef));
      expect(results.first['operation'], 'inpaint');
      expect(results.first['source_image_ref'], fixture.source.assetRef);
      expect(results.first['mask_image_ref'], fixture.mask.assetRef);
      expect(results.first['inpaint_strength'], 0.61);
      expect(
        results.first['editor_input_state']['inpaint_document_ready'],
        true,
      );
      expect(results.first['editor_input_state']['mask_ready'], true);
      expect(results.last['ok'], true);
      expect(results.last['image_ids'], ['generated-1']);
      expect(
        fixture.workbench.results
            .firstWhere((item) => item.id == 'generated-1')
            .editMetadata?['operation'],
        'inpaint',
      );
    },
  );

  test(
    'inpaint refuses a missing source or mask before any generation call',
    () async {
      for (final fixture in [
        await _fixture(
          operation: GenerationOperation.inpaint,
          includeSource: false,
        ),
        await _fixture(
          operation: GenerationOperation.inpaint,
          includeMask: false,
        ),
      ]) {
        addTearDown(() async {
          fixture.editing.dispose();
          fixture.workbench.dispose();
          await fixture.assets.close();
        });
        final tool = WorkspaceAgentTools(fixture.workbench)
            .build()
            .firstWhere((item) => item.name == 'generate_image');
        await expectLater(
          tool.prepare({'batch_count': 1}, AgentCancellation()),
          throwsA(isA<AgentException>()),
        );
        expect(fixture.calls, isEmpty);
      }
    },
  );

  for (final changedInput in ['source', 'mask']) {
    test(
      'a $changedInput change during approval invalidates the generation',
      () async {
        final fixture = await _fixture(operation: GenerationOperation.inpaint);
        addTearDown(() async {
          fixture.editing.dispose();
          fixture.workbench.dispose();
          await fixture.assets.close();
        });
        final replacement = await fixture.assets.save(
          await _png(64, 64, changedInput == 'mask' ? 0xff00ff00 : 0xff112233),
        );
        var confirmations = 0;
        final requestLog = <List<Map<String, dynamic>>>[];

        await expectLater(
          _run(
            fixture,
            [
              AgentReply(
                calls: [
                  _call('generate-1', 'generate_image', {
                    'prompt': 'must not be submitted',
                    'batch_count': 1,
                  }),
                ],
              ),
              AgentReply(
                calls: [
                  _call('generate-2', 'generate_image', {
                    'prompt': 'retry after source change',
                    'batch_count': 1,
                  }),
                ],
              ),
              AgentReply(
                calls: [
                  _call('generate-3', 'generate_image', {
                    'prompt': 'retry again after source change',
                    'batch_count': 1,
                  }),
                ],
              ),
            ],
            requestLog: requestLog,
            confirm: (_, plan) async {
              confirmations++;
              expect(plan.preview['操作'], '局部重绘');
              if (changedInput == 'source') {
                fixture.editing.setSource(replacement, parentId: 'replacement');
              } else {
                fixture.editing.changeDocument(
                  fixture.editing.document!.copyWith(
                    importedMaskAssetRef: replacement.assetRef,
                  ),
                );
              }
              return true;
            },
          ),
          throwsA(isA<AgentException>()),
        );
        expect(fixture.calls, isEmpty);
        expect(confirmations, 1);
        expect(requestLog, hasLength(3));
        final firstRetryTools = requestLog[1]
            .where((message) => message['role'] == 'tool')
            .toList();
        expect(firstRetryTools, hasLength(1));
        final firstRetryResult = jsonDecode(
          firstRetryTools.single['content'] as String,
        ) as Map<String, dynamic>;
        expect(firstRetryResult['ok'], false);
        expect(firstRetryResult['error'], contains('创作草稿已在本轮之外发生修改'));
        expect(
          requestLog[2].where((message) => message['role'] == 'tool'),
          hasLength(2),
        );
      },
    );
  }

  test(
    'refusal and cancellation while awaiting approval do not submit images',
    () async {
      final refused = await _fixture();
      addTearDown(() async {
        refused.editing.dispose();
        refused.workbench.dispose();
        await refused.assets.close();
      });
      await expectLater(
        _run(refused, [
          AgentReply(
            calls: [
              _call('generate-1', 'generate_image', {'batch_count': 1}),
            ],
          ),
        ], confirm: (_, _) async => false),
        throwsA(isA<AgentException>()),
      );
      expect(refused.calls, isEmpty);

      final cancelled = await _fixture();
      addTearDown(() async {
        cancelled.editing.dispose();
        cancelled.workbench.dispose();
        await cancelled.assets.close();
      });
      final token = AgentCancellation();
      await expectLater(
        _run(
          cancelled,
          [
            AgentReply(
              calls: [
                _call('generate-2', 'generate_image', {'batch_count': 1}),
              ],
            ),
          ],
          cancellation: token,
          confirm: (_, _) async {
            token.cancel();
            return true;
          },
        ),
        throwsA(isA<AgentCancelled>()),
      );
      expect(cancelled.calls, isEmpty);
    },
  );

  test(
    'a partial paid batch cannot be automatically submitted again this turn',
    () async {
      final fixture = await _fixture(failOnCall: 2);
      addTearDown(() async {
        fixture.editing.dispose();
        fixture.workbench.dispose();
        await fixture.assets.close();
      });
      var confirmations = 0;
      final results = await _run(
        fixture,
        [
          AgentReply(
            calls: [
              _call('generate-1', 'generate_image', {'batch_count': 2}),
            ],
          ),
          AgentReply(
            calls: [
              _call('generate-2', 'generate_image', {'batch_count': 2}),
            ],
          ),
          AgentReply(calls: [_call('read-1', 'read_current_prompts', {})]),
          const AgentReply(content: 'The partial result remains available.'),
        ],
        confirm: (_, _) async {
          confirmations++;
          return true;
        },
      );

      expect(fixture.calls, hasLength(2));
      expect(confirmations, 1);
      expect(results.first['ok'], false);
      expect(results.first['attempted'], 2);
      expect(results.first['image_ids'], ['generated-1']);
      expect(results[1]['error'], contains('已经开始'));
    },
  );
}

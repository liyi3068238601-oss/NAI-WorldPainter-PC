import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:archive/archive.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:path/path.dart' as p;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:worldpainter_pc/assistant/agent_contract.dart';
import 'package:worldpainter_pc/assistant/assistant_controller.dart';
import 'package:worldpainter_pc/assistant/assistant_mobile_resources.dart';
import 'package:worldpainter_pc/assistant/assistant_preferences.dart';
import 'package:worldpainter_pc/assistant/prompt_memory.dart';
import 'package:worldpainter_pc/assistant/prompting_knowledge.dart';
import 'package:worldpainter_pc/assistant/wd_tagger.dart';
import 'package:worldpainter_pc/generation/generation_parameters.dart';
import 'package:worldpainter_pc/generation/generation_runtime.dart';
import 'package:worldpainter_pc/generation/service_connection.dart';
import 'package:worldpainter_pc/media/image_asset_store.dart';
import 'package:worldpainter_pc/prototype/workbench_controller.dart';
import 'package:worldpainter_pc/security/credential_vault_web.dart';
import 'package:worldpainter_pc/storage/sqlite_workspace_store.dart';
import 'package:worldpainter_pc/tags/danbooru_client.dart';

import '../support/tag_agent_fixture.dart';

// This is a deterministic local integration fixture. The AgentTransport is
// scripted and NovelAI HTTP is intercepted by MockClient; it is not evidence
// of a real LLM, live tag service, NovelAI account, or paid generation.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() async {
    sqfliteFfiInit();
    _syntheticPng = await _createSyntheticPng();
  });

  test('tags -> confirmed prompt -> confirmed NovelAI generation persists a synthetic asset and settings', () async {
    final transport = _ScriptedAgentTransport({
      _tagRequest: _Scenario([
        _Step('read_prompting_reference', {'reference': 'writing'}),
        _Step('read_current_prompts', const {}),
        _Step(
          'search_danbooru',
          {'query': '月光森林', 'limit': 5, 'show_nsfw': false},
          verifyResult: (result) {
            expect(result['source'], tagFixtureRoot);
            expect(result['count'], 3);
            expect(result['ok'], true);
          },
        ),
        _Step(
          'write_prompt',
          {'target': 'positive', 'mode': 'append', 'content': tagFixtureSuffix},
          verifyResult: (result) {
            expect(result['target'], 'positive');
            expect(result['saved'], true);
          },
        ),
        _Step(
          'generate_image',
          const {},
          verifyResult: (result) {
            expect(result['ok'], true);
            expect(result['requested'], 1);
            expect(result['attempted'], 1);
            expect(result['completed'], 1);
            expect(result['persisted'], true);
            expect(result['cancelled'], false);
            expect(result['post_processing_failed'], false);
            expect(result['image_ids'], hasLength(1));
          },
        ),
      ], finalText: '已完成合成标签与图片流程。'),
      _memoryRequest: _Scenario([
        _Step(
          'save_memory',
          {
            'trigger': '银羽',
            'content': '银羽喜欢银色星光；合成待审核候选。',
            'type': 'character_feature',
          },
          verifyResult: (result) {
            expect(result['status'], 'pending_review');
            expect(result['active'], false);
          },
        ),
        _Step(
          'get_memories',
          {'query': '银羽'},
          verifyResult: (result) {
            _preApprovalMemories = result;
            final values = result['memories'] as List;
            expect(values.length, lessThanOrEqualTo(8));
            expect(
              values.every(
                (entry) => !(entry as Map)['content'].toString().contains(
                  _candidateText,
                ),
              ),
              true,
            );
            expect(
              values.any(
                (entry) => (entry as Map)['content'].toString().contains(
                  _privateSentinel,
                ),
              ),
              false,
            );
          },
        ),
      ], finalText: '候选仍待审核。'),
      _memoryRecallRequest: _Scenario([
        _Step(
          'get_memories',
          {'query': '银羽'},
          verifyResult: (result) {
            _postApprovalMemories = result;
            final values = result['memories'] as List;
            expect(values.length, lessThanOrEqualTo(8));
            final serializedLength = values.fold<int>(
              0,
              (total, entry) =>
                  total +
                  (entry as Map)['trigger'].toString().length +
                  entry['content'].toString().length,
            );
            expect(serializedLength, lessThanOrEqualTo(12000));
            expect(
              values.any(
                (entry) => (entry as Map)['content'].toString().contains(
                  _candidateText,
                ),
              ),
              true,
            );
            expect(
              values.any(
                (entry) => (entry as Map)['content'].toString().contains(
                  _privateSentinel,
                ),
              ),
              false,
            );
          },
        ),
        _Step(
          'get_memories',
          {'query': 'budget-token'},
          verifyResult: (result) {
            _budgetMemories = result;
            final values = result['memories'] as List;
            expect(values, hasLength(6));
            final serializedLength = values.fold<int>(
              0,
              (total, entry) =>
                  total +
                  (entry as Map)['trigger'].toString().length +
                  entry['content'].toString().length,
            );
            expect(serializedLength, lessThanOrEqualTo(12000));
          },
        ),
      ], finalText: '已读取当前查询匹配的合成记忆。'),
    });
    final tagClient = FixtureTagClient();
    final harness = await _Harness.create(
      transport: transport,
      tagClient: tagClient,
    );
    addTearDown(harness.dispose);

    final c = harness.controller!;
    final mobileSnapshot = await c.assistant.loadMobileResources();
    final bundledSystemPrompt = c.assistant.mobileResources.systemPrompt;
    final bundledV5Skill = c.assistant.mobileResources.v5Skill;
    expect(mobileSnapshot.source, AssistantMobileResources.sourceLabel);
    expect(
      mobileSnapshot.systemPromptPath,
      AssistantMobileResources.systemPromptAssetPath,
    );
    expect(mobileSnapshot.skillPath, AssistantMobileResources.skillAssetPath);
    expect(bundledSystemPrompt, isNotEmpty);
    expect(bundledV5Skill, isNotEmpty);
    expect(c.assistant.state.systemPrompt, isEmpty);

    c.assistant.updateInput(_tagRequest);
    final workflow = c.assistant.send(requireTool: true);

    final writeReview = await _waitForInteraction(c.assistant);
    expect(writeReview.title, contains('positive'));
    expect(writeReview.preview['修改前'], _basePrompt);
    expect(writeReview.preview['修改后'], _taggedPrompt);
    expect(harness.generationRequests, isEmpty);
    c.assistant.answer('approve');

    final generationReview = await _waitForInteraction(
      c.assistant,
      after: writeReview,
    );
    expect(generationReview.title, contains('使用额度'));
    expect(generationReview.preview['正向'], _taggedPrompt);
    // Prompt approval is not generation approval; no mock POST exists yet.
    expect(harness.generationRequests, isEmpty);
    c.assistant.answer('approve');
    await workflow;

    final modelContext = transport.requests
        .firstWhere((request) => request.userText == _tagRequest)
        .messages;
    final transmittedSystemPrompt = modelContext.first['content'] as String;
    final expectedSystemPrompt = c.assistant.mobileResources.buildSystemPrompt(
      systemPromptOverride: '',
      preferences: c.assistant.state.preferences,
      version: PromptingVersion.v5,
    );
    expect(transmittedSystemPrompt, expectedSystemPrompt);
    expect(transmittedSystemPrompt, startsWith(bundledSystemPrompt));
    expect(transmittedSystemPrompt, contains(bundledV5Skill));
    expect(transmittedSystemPrompt, contains(_v5StyleWords));

    expect(
      c.assistant.session.turns.single.status,
      'complete',
      reason: _generationFailureDiagnostic(
        turnError: c.assistant.session.turns.single.error,
        traces: c.assistant.session.turns.single.traces,
        requests: harness.generationRequests,
        responses: harness.generationResponses,
        errors: harness.generationErrors,
      ),
    );
    expect(c.prompt, _taggedPrompt);
    expect(tagClient.requests, hasLength(1));
    expect(tagClient.requests.single['query'], '月光森林');
    expect(tagClient.requests.single['baseUrl'], tagFixtureRoot);
    expect(tagClient.requests.single['showNsfw'], false);
    expect(harness.generationRequests, hasLength(1));
    final generationRequest = harness.generationRequests.single;
    expect(generationRequest.url.host, 'image.novelai.net');
    expect(generationRequest.url.path, '/ai/generate-image');
    expect(
      generationRequest.headers['authorization'],
      'Bearer $_generationSecret',
    );
    final generationPayload =
        jsonDecode(generationRequest.body) as Map<String, dynamic>;
    expect(generationPayload['action'], 'generate');
    expect(generationPayload['input'], _taggedPrompt);
    expect(generationPayload['model'], 'nai-diffusion-4-5-full');
    final generationParameters =
        generationPayload['parameters'] as Map<String, dynamic>;
    expect(generationParameters['width'], 832);
    expect(generationParameters['height'], 1216);
    expect(generationRequest.body, isNot(contains(_generationSecret)));

    final generated = c.results.firstWhere(
      (result) => !result.isDemo && result.assetRef != null,
    );
    expect(generated.prompt, _taggedPrompt);
    expect(generated.width, 832);
    expect(generated.height, 1216);
    expect(await harness.assets!.read(generated.assetRef!), _syntheticPng);

    // Seed synthetic records with a shared query token and an unrelated
    // sentinel. The accepted entries are deliberately old so an approved
    // candidate is the highest-ranked match after a fresh-session query.
    for (var i = 0; i < 8; i++) {
      c.assistant.state.memories.save(
        trigger: 'fixture-anchor-$i',
        content: '银羽 synthetic accepted reference $i',
        kind: MemoryKind.characterFeature,
        now: DateTime.utc(2020, 1, 1).add(Duration(seconds: i)),
      );
    }
    c.assistant.state.memories.save(
      trigger: 'bluebird',
      content: _privateSentinel,
      kind: MemoryKind.fact,
      now: DateTime.utc(2020, 1, 1),
    );
    c.assistant.changed();
    await c.flush();

    c.assistant.newSession();
    c.assistant.updateInput(_memoryRequest);
    await c.assistant.send(requireTool: true);
    final candidate = c.assistant.state.memories.entries.singleWhere(
      (entry) => entry.content == _candidateText,
    );
    expect(candidate.source, MemorySource.pendingLlmCandidate);
    expect(candidate.isRetrievable, false);
    expect((_preApprovalMemories!['memories'] as List), hasLength(8));
    expect(
      c.assistant.session.turns.single.traces
          .where((trace) => trace['name'] == 'get_memories')
          .single['status'],
      'completed',
    );

    await c.assistant.approveMemory(
      candidate.id,
      expectedRevision: c.assistant.state.memories.revision,
    );
    expect(
      c.assistant.state.memories.entries
          .singleWhere((entry) => entry.id == candidate.id)
          .source,
      MemorySource.llmCandidate,
    );

    for (var i = 0; i < 8; i++) {
      c.assistant.state.memories.save(
        trigger: 'budget-anchor-$i',
        content: 'budget-token ${List.filled(1800, 'y').join()}-$i',
        kind: MemoryKind.fact,
        now: DateTime.utc(2021, 1, 1).add(Duration(seconds: i)),
      );
    }
    c.assistant.changed();
    await c.flush();

    c.assistant.newSession();
    expect(c.assistant.session.turns, isEmpty);
    c.assistant.updateInput(_memoryRecallRequest);
    await c.assistant.send(requireTool: true);
    expect((_postApprovalMemories!['memories'] as List), hasLength(8));
    expect((_budgetMemories!['memories'] as List), hasLength(6));
    expect(
      c.assistant.state.memories.entries
          .singleWhere((entry) => entry.id == candidate.id)
          .hitCount,
      1,
    );
    final recallRequest = transport.requests
        .where((request) => request.userText == _memoryRecallRequest)
        .first;
    expect(
      recallRequest.messages.where((message) => message['role'] == 'user'),
      hasLength(1),
    );
    expect(
      recallRequest.messages.singleWhere(
        (message) => message['role'] == 'user',
      )['content'],
      _memoryRecallRequest,
    );

    await c.flush();
    final savedWorkspace = c.exportWorkspace();
    final serialized = jsonEncode(savedWorkspace);
    expect(serialized, isNot(contains(_assistantSecret)));
    expect(serialized, isNot(contains(_generationSecret)));
    final originalAssistantState = savedWorkspace['assistant'] as Map;
    final originalPreferences = originalAssistantState['preferences'] as Map;
    expect(originalPreferences['v45StyleWords'], isNotEmpty);
    expect(originalPreferences['v5StyleWords'], isNotEmpty);

    await harness.reopen();
    final reopened = harness.controller!;
    expect(reopened.assistant.state.contextTurns, 2);
    expect(reopened.assistant.state.systemPrompt, '');
    expect(reopened.assistant.state.promptingVersion, PromptingVersion.v5);
    expect(reopened.assistant.state.preferences.v45StyleWords, _v45StyleWords);
    expect(reopened.assistant.state.preferences.v5StyleWords, _v5StyleWords);
    expect(reopened.assistant.state.wdTagger.toJson(), _wdSettings.toJson());
    expect(
      reopened.connectionFor('official').baseUrl,
      ServiceConnection.officialUrl,
    );
    expect(reopened.assistant.state.providers.single.toJson(), {
      'id': 'assistant-fixture',
      'name': '合成 Agent',
      'baseUrl': 'https://assistant.fixture.invalid/v1',
      'model': 'synthetic-agent-model',
      'streaming': true,
      'requireKey': true,
    });
    final reopenedImage = reopened.results.firstWhere(
      (result) => !result.isDemo && result.assetRef == generated.assetRef,
    );
    expect(reopenedImage.prompt, _taggedPrompt);
    expect(reopenedImage.width, 832);
    expect(reopenedImage.height, 1216);
    expect(await harness.assets!.read(reopenedImage.assetRef!), _syntheticPng);
    expect(
      reopened.assistant.state.memories.entries
          .singleWhere((entry) => entry.id == candidate.id)
          .source,
      MemorySource.llmCandidate,
    );

    final reopenedSnapshot = await reopened.assistant.loadMobileResources();
    expect(reopenedSnapshot.source, mobileSnapshot.source);
    expect(reopenedSnapshot.systemPromptPath, mobileSnapshot.systemPromptPath);
    expect(
      reopenedSnapshot.systemPromptSha256,
      mobileSnapshot.systemPromptSha256,
    );
    expect(
      reopenedSnapshot.systemPromptByteLength,
      mobileSnapshot.systemPromptByteLength,
    );
    expect(reopenedSnapshot.skillPath, mobileSnapshot.skillPath);
    expect(reopenedSnapshot.skillSha256, mobileSnapshot.skillSha256);
    expect(reopenedSnapshot.skillByteLength, mobileSnapshot.skillByteLength);
    expect(
      reopenedSnapshot.ideationReferencePath,
      mobileSnapshot.ideationReferencePath,
    );
    expect(
      reopenedSnapshot.ideationReferenceSha256,
      mobileSnapshot.ideationReferenceSha256,
    );
    expect(
      reopenedSnapshot.writingReferencePath,
      mobileSnapshot.writingReferencePath,
    );
    expect(
      reopenedSnapshot.writingReferenceSha256,
      mobileSnapshot.writingReferenceSha256,
    );
    expect(reopenedSnapshot.knowledgePath, mobileSnapshot.knowledgePath);
    expect(reopenedSnapshot.knowledgeSha256, mobileSnapshot.knowledgeSha256);
    expect(
      reopenedSnapshot.knowledgeByteLength,
      mobileSnapshot.knowledgeByteLength,
    );
    expect(
      reopenedSnapshot.knowledgeEntryCount,
      mobileSnapshot.knowledgeEntryCount,
    );
    expect(
      reopened.assistant.mobileResources.systemPrompt,
      bundledSystemPrompt,
    );
    expect(reopened.assistant.mobileResources.v5Skill, bundledV5Skill);
    expect(reopened.assistant.state.systemPrompt, isEmpty);

    final databaseText = latin1.decode(
      await File(harness.databasePath).readAsBytes(),
      allowInvalid: true,
    );
    expect(databaseText, isNot(contains(_assistantSecret)));
    expect(databaseText, isNot(contains(_generationSecret)));
  });

  test('refusing write_prompt or generate_image confirmation causes no mocked NovelAI POST', () async {
    final transport = _ScriptedAgentTransport({
      _refuseWriteRequest: _Scenario([
        _Step('read_current_prompts', const {}),
        _Step('write_prompt', {
          'target': 'positive',
          'mode': 'append',
          'content': 'unapproved synthetic tag',
        }),
      ], finalText: '拒绝写入后停止。'),
      _refuseGenerationRequest: _Scenario([
        _Step('read_current_prompts', const {}),
        _Step('write_prompt', {
          'target': 'positive',
          'mode': 'append',
          'content': 'approved synthetic tag',
        }, verifyResult: (result) => expect(result['saved'], true)),
        _Step('generate_image', const {}),
      ], finalText: '拒绝生成后停止。'),
    });
    final harness = await _Harness.create(transport: transport);
    addTearDown(harness.dispose);
    final c = harness.controller!;
    c.assistant.updateInput(_refuseWriteRequest);
    final refuseWrite = c.assistant.send(requireTool: true);
    final writeReview = await _waitForInteraction(c.assistant);
    expect(writeReview.preview['修改前'], _basePrompt);
    expect(
      writeReview.preview['修改后'],
      '$_basePrompt, unapproved synthetic tag',
    );
    c.assistant.answer('reject');
    await refuseWrite;
    expect(c.prompt, _basePrompt);
    expect(harness.generationRequests, isEmpty);
    expect(c.assistant.session.turns.single.traces.last['status'], 'denied');

    c.assistant.newSession();
    c.assistant.updateInput(_refuseGenerationRequest);
    final refuseGeneration = c.assistant.send(requireTool: true);
    final secondWriteReview = await _waitForInteraction(c.assistant);
    expect(secondWriteReview.preview['修改前'], _basePrompt);
    c.assistant.answer('approve');
    final generationReview = await _waitForInteraction(
      c.assistant,
      after: secondWriteReview,
    );
    expect(
      generationReview.preview['正向'],
      '$_basePrompt, approved synthetic tag',
    );
    expect(harness.generationRequests, isEmpty);
    c.assistant.answer('reject');
    await refuseGeneration;

    expect(c.prompt, '$_basePrompt, approved synthetic tag');
    expect(harness.generationRequests, isEmpty);
    expect(c.assistant.session.turns.single.traces.last['status'], 'denied');
  });

  test('cancelling a pending tag lookup ignores its late result and never posts generation', () async {
    final transport = _ScriptedAgentTransport({
      _cancelTagRequest: _Scenario([
        _Step('read_current_prompts', const {}),
        _Step('search_danbooru', {
          'query': '月光森林',
          'limit': 5,
          'show_nsfw': false,
        }),
        _Step('write_prompt', {
          'target': 'positive',
          'mode': 'append',
          'content': tagFixtureSuffix,
        }),
        _Step('generate_image', const {}),
      ], finalText: '不应收到这条迟到结果。'),
    });
    final lateResult = Completer<DanbooruSearchResult>();
    final tagClient = FixtureTagClient()..handler = () => lateResult.future;
    final harness = await _Harness.create(
      transport: transport,
      tagClient: tagClient,
    );
    addTearDown(harness.dispose);
    final c = harness.controller!;
    c.assistant.updateInput(_cancelTagRequest);
    final request = c.assistant.send(requireTool: true);
    await _waitUntil(() => tagClient.requests.isNotEmpty);
    final cancellation = tagClient.token;
    expect(cancellation, isNotNull);

    c.assistant.cancel();
    await request;
    lateResult.complete(
      DanbooruSearchResult(
        tags: tagFixtureTags,
        source: tagFixtureRoot,
        query: '月光森林',
      ),
    );
    await Future<void>.delayed(const Duration(milliseconds: 10));

    expect(cancellation!.isCancelled, true);
    expect(c.prompt, _basePrompt);
    expect(c.assistant.session.turns.single.status, 'cancelled');
    expect(
      c.assistant.session.turns.single.traces.any(
        (trace) =>
            trace['name'] == 'write_prompt' && trace['status'] == 'completed',
      ),
      false,
    );
    expect(harness.generationRequests, isEmpty);
  });
}

const _tagRequest = '请检索月光森林标签，确认追加后按当前 NovelAI 参数生成合成图片。';
const _memoryRequest = '保存银羽的合成记忆候选，并查询当前可用记忆。';
const _memoryRecallRequest = '请为银羽绘图，读取本地相关记忆。';
const _refuseWriteRequest = '合成拒绝测试：请提议追加标签。';
const _refuseGenerationRequest = '合成拒绝测试：先提议提示词，再请求生成。';
const _cancelTagRequest = '合成取消测试：检索标签并继续等待确认。';
const _basePrompt = 'synthetic v5 style, synthetic base prompt';
const _taggedPrompt = '$_basePrompt, $tagFixtureSuffix';
const _v45StyleWords = 'synthetic v4.5 style';
const _v5StyleWords = 'synthetic v5 style';
const _candidateText = '银羽喜欢银色星光；合成待审核候选。';
const _privateSentinel = 'SYNTHETIC_UNRELATED_PROFILE_SENTINEL';
const _assistantSecret = 'synthetic-assistant-secret';
const _generationSecret = 'synthetic-novelai-secret';
const _assistantProvider = AssistantProvider(
  id: 'assistant-fixture',
  name: '合成 Agent',
  baseUrl: 'https://assistant.fixture.invalid/v1',
  model: 'synthetic-agent-model',
  requireKey: true,
);
const _officialConnection = ServiceConnection(
  protocol: 'official',
  baseUrl: ServiceConnection.officialUrl,
);
const _wdSettings = WdTaggerSettings(
  enabled: true,
  baseUrl: 'https://wd.fixture.invalid',
  model: 'SmilingWolf/wd-vit-tagger-v3',
  generalThreshold: 0.42,
  characterThreshold: 0.88,
  generalMcut: true,
  characterMcut: false,
);
late Uint8List _syntheticPng;
Map<String, dynamic>? _preApprovalMemories;
Map<String, dynamic>? _postApprovalMemories;
Map<String, dynamic>? _budgetMemories;

class _Harness {
  _Harness({
    required this.root,
    required this.directory,
    required this.workspace,
    required this.assets,
    required this.vault,
    required this.controller,
    required this.generationRequests,
    required this.generationResponses,
    required this.generationErrors,
  });

  final Directory root;
  final Directory directory;
  SQLiteWorkspaceStore? workspace;
  ImageAssetStore? assets;
  final SessionMemoryCredentialVault vault;
  WorkbenchController? controller;
  final List<http.Request> generationRequests;
  final List<Map<String, Object?>> generationResponses;
  final List<String> generationErrors;

  String get databasePath => p.join(directory.path, 'workspace.sqlite');

  static Future<_Harness> create({
    required _ScriptedAgentTransport transport,
    FixtureTagClient? tagClient,
  }) async {
    final root = Directory(
      p.join(Directory.current.path, '.tmp', 'assistant-full-workflow-tests'),
    );
    await root.create(recursive: true);
    final directory = await root.createTemp('run-');
    SQLiteWorkspaceStore? workspace;
    ImageAssetStore? assets;
    WorkbenchController? controller;
    final vault = SessionMemoryCredentialVault();
    final generationRequests = <http.Request>[];
    final generationResponses = <Map<String, Object?>>[];
    final generationErrors = <String>[];
    try {
      workspace = await SQLiteWorkspaceStore.open(
        factory: databaseFactoryFfi,
        path: p.join(directory.path, 'workspace.sqlite'),
      );
      assets = await openImageAssetStore(
        directory: p.join(directory.path, 'assets'),
      );
      final runtime = GenerationRuntime(
        assets: assets,
        vault: vault,
        clientFactory: () => MockClient((request) async {
          generationRequests.add(request);
          final responseBytes = _zipPng(_syntheticPng);
          generationResponses.add({
            'status': 201,
            'contentType': 'application/zip',
            'bodyLength': responseBytes.length,
          });
          return http.Response.bytes(
            responseBytes,
            201,
            headers: const {'content-type': 'application/zip'},
          );
        }),
      );

      Future<SceneResult> tracedGenerate(
        GenerationParameters parameters,
        ServiceConnection connection,
      ) async {
        try {
          return await runtime.generate(parameters, connection);
        } on Object catch (error) {
          var message = error
              .toString()
              .replaceAll(_assistantSecret, '[redacted]')
              .replaceAll(_generationSecret, '[redacted]');
          if (message.length > 240) message = message.substring(0, 240);
          generationErrors.add('${error.runtimeType}: $message');
          rethrow;
        }
      }

      controller = WorkbenchController(
        store: workspace,
        assets: assets,
        vault: vault,
        generateImage: tracedGenerate,
        cancelRequest: runtime.cancel,
        assistantTransport: transport,
        tagSearchClient: tagClient ?? FixtureTagClient(),
        mobileResources: AssistantMobileResources(),
      );
      await controller.assistant.saveProvider(
        _assistantProvider,
        secret: _assistantSecret,
      );
      await controller.assistant.savePreferences(
        AssistantPreferences(
          v45StyleWords: _v45StyleWords,
          v5StyleWords: _v5StyleWords,
        ),
      );
      controller.assistant.updateSettings(
        systemPrompt: '',
        contextTurns: 2,
        promptingVersion: PromptingVersion.v5,
      );
      controller.assistant.updateWdTaggerSettings(_wdSettings);
      controller
        ..updateConnection(_officialConnection)
        ..updateAdvanced(
          GenerationParameters(
            operation: GenerationOperation.textToImage,
            model: 'nai-diffusion-4-5-full',
            prompt: _basePrompt,
            negativePrompt: 'synthetic negative prompt',
            width: 832,
            height: 1216,
            steps: 28,
            scale: 5,
            seed: 1234,
          ),
        )
        ..updatePrompt(_basePrompt)
        ..updateNegative('synthetic negative prompt')
        ..configureTagSearch(baseUrl: tagFixtureRoot, showNsfw: false);
      await _officialConnection.saveSecret(vault, _generationSecret);
      await controller.flush();
      return _Harness(
        root: root,
        directory: directory,
        workspace: workspace,
        assets: assets,
        vault: vault,
        controller: controller,
        generationRequests: generationRequests,
        generationResponses: generationResponses,
        generationErrors: generationErrors,
      );
    } catch (_) {
      if (controller != null) {
        await controller.closeStorage();
        controller.dispose();
      } else {
        await workspace?.close();
        await assets?.close();
      }
      await _deleteTemporaryDirectorySafely(root, directory);
      rethrow;
    }
  }

  Future<void> reopen() async {
    await _closeOpenResources();
    workspace = await SQLiteWorkspaceStore.open(
      factory: databaseFactoryFfi,
      path: databasePath,
    );
    assets = await openImageAssetStore(
      directory: p.join(directory.path, 'assets'),
    );
    controller = WorkbenchController(
      store: workspace,
      restored: await workspace!.load(),
      assets: assets,
      vault: vault,
      assistantTransport: _ScriptedAgentTransport(const {}),
      mobileResources: AssistantMobileResources(),
    );
  }

  Future<void> _closeOpenResources() async {
    final activeController = controller;
    if (activeController != null) {
      if (!activeController.closing) await activeController.closeStorage();
      activeController.dispose();
      controller = null;
      workspace = null;
      assets = null;
      return;
    }
    await workspace?.close();
    await assets?.close();
    workspace = null;
    assets = null;
  }

  Future<void> dispose() async {
    await _closeOpenResources();
    await _deleteTemporaryDirectorySafely(root, directory);
  }
}

class _Scenario {
  _Scenario(this.steps, {required this.finalText});

  final List<_Step> steps;
  final String finalText;
  int next = 0;
}

class _Step {
  const _Step(this.name, this.arguments, {this.verifyResult});

  final String name;
  final Map<String, dynamic> arguments;
  final void Function(Map<String, dynamic> result)? verifyResult;
}

class _CapturedAgentRequest {
  const _CapturedAgentRequest({required this.userText, required this.messages});

  final String userText;
  final List<Map<String, dynamic>> messages;
}

class _ScriptedAgentTransport implements AgentTransport {
  _ScriptedAgentTransport(this.scenarios);

  final Map<String, _Scenario> scenarios;
  final List<_CapturedAgentRequest> requests = [];

  @override
  Future<AgentReply> complete({
    required AssistantProvider provider,
    required List<Map<String, dynamic>> messages,
    required List<Map<String, dynamic>> tools,
    required String toolChoice,
    required AgentCancellation cancellation,
    void Function(String)? onText,
  }) async {
    cancellation.check();
    final copied = (jsonDecode(jsonEncode(messages)) as List)
        .map((message) => Map<String, dynamic>.from(message as Map))
        .toList(growable: false);
    final userText =
        copied.where((message) => message['role'] == 'user').last['content']
            as String;
    requests.add(_CapturedAgentRequest(userText: userText, messages: copied));
    final scenario = scenarios[userText];
    if (scenario == null) {
      throw StateError('No synthetic Agent scenario for this user turn.');
    }
    if (scenario.next > 0) {
      final previous = scenario.steps[scenario.next - 1];
      final callId = 'fixture-${scenario.next}';
      final toolMessage = copied.lastWhere(
        (message) => message['role'] == 'tool',
        orElse: () => const <String, dynamic>{},
      );
      expect(toolMessage['tool_call_id'], callId);
      final decoded =
          jsonDecode(toolMessage['content'] as String) as Map<String, dynamic>;
      previous.verifyResult?.call(decoded);
    }
    if (scenario.next == scenario.steps.length) {
      return AgentReply(content: scenario.finalText);
    }

    final index = scenario.next++;
    final step = scenario.steps[index];
    expect(
      tools.map((tool) => (tool['function'] as Map)['name']),
      contains(step.name),
    );
    if (index == 0) expect(toolChoice, 'required');
    return AgentReply(
      calls: [
        AgentCall(
          id: 'fixture-${index + 1}',
          name: step.name,
          arguments: jsonEncode(step.arguments),
        ),
      ],
      finishReason: 'tool_calls',
    );
  }
}

Future<AssistantInteraction> _waitForInteraction(
  AssistantController assistant, {
  AssistantInteraction? after,
}) async {
  for (var attempt = 0; attempt < 1000; attempt++) {
    final current = assistant.interaction;
    if (current != null && !identical(current, after)) return current;
    await Future<void>.delayed(const Duration(milliseconds: 5));
  }
  throw StateError('The expected synthetic Agent confirmation did not appear.');
}

Future<void> _waitUntil(bool Function() condition) async {
  for (var attempt = 0; attempt < 1000; attempt++) {
    if (condition()) return;
    await Future<void>.delayed(const Duration(milliseconds: 5));
  }
  throw StateError('The expected synthetic workflow state did not appear.');
}

Future<Uint8List> _createSyntheticPng() async {
  final recorder = ui.PictureRecorder();
  final canvas = ui.Canvas(recorder);
  canvas
    ..drawColor(const ui.Color(0xff263b57), ui.BlendMode.src)
    ..drawRect(
      const ui.Rect.fromLTWH(0, 0, 832, 760),
      ui.Paint()..color = const ui.Color(0xff7397b7),
    )
    ..drawCircle(
      const ui.Offset(658, 284),
      104,
      ui.Paint()..color = const ui.Color(0xfff0d78a),
    )
    ..drawOval(
      const ui.Rect.fromLTWH(-80, 648, 610, 568),
      ui.Paint()..color = const ui.Color(0xff314c49),
    )
    ..drawOval(
      const ui.Rect.fromLTWH(264, 704, 712, 512),
      ui.Paint()..color = const ui.Color(0xff435d4d),
    );
  final picture = recorder.endRecording();
  final image = await picture.toImage(832, 1216);
  picture.dispose();
  try {
    final data = await image.toByteData(format: ui.ImageByteFormat.png);
    if (data == null) {
      throw StateError('Flutter did not encode the synthetic PNG.');
    }
    return data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes);
  } finally {
    image.dispose();
  }
}

String _generationFailureDiagnostic({
  required String? turnError,
  required List<Map<String, dynamic>> traces,
  required List<http.Request> requests,
  required List<Map<String, Object?>> responses,
  required List<String> errors,
}) => jsonEncode({
  'turnError': turnError,
  'generateTrace': traces
      .where((trace) => trace['name'] == 'generate_image')
      .map((trace) => {'status': trace['status'], 'result': trace['result']})
      .toList(growable: false),
  'requests': requests
      .map((request) {
        final summary = <String, Object?>{
          'method': request.method,
          'url': request.url.toString(),
          'contentType': request.headers['content-type'],
          'authorizationPresent': request.headers.containsKey('authorization'),
          'bodyLength': request.bodyBytes.length,
        };
        try {
          final body = jsonDecode(request.body);
          if (body is Map) {
            summary['action'] = body['action'];
            summary['model'] = body['model'];
          }
        } catch (_) {
          summary['bodyJson'] = 'invalid';
        }
        return summary;
      })
      .toList(growable: false),
  'responses': responses,
  'runtimeErrors': errors,
});

Future<void> _deleteTemporaryDirectorySafely(
  Directory root,
  Directory target,
) async {
  if (!await target.exists()) return;
  final canonicalRoot = p.normalize(await root.resolveSymbolicLinks());
  final canonicalTarget = p.normalize(await target.resolveSymbolicLinks());
  if (p.equals(canonicalRoot, canonicalTarget) ||
      !p.isWithin(canonicalRoot, canonicalTarget)) {
    throw StateError('Refusing to remove a path outside the test temp root.');
  }
  await Directory(canonicalTarget).delete(recursive: true);
}

List<int> _zipPng(Uint8List png) => ZipEncoder().encode(
  Archive()..addFile(ArchiveFile('synthetic-scene.png', png.length, png)),
);

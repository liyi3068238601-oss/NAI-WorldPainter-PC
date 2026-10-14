import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:worldpainter_pc/assistant/agent_contract.dart';
import 'package:worldpainter_pc/assistant/assistant_state.dart';
import 'package:worldpainter_pc/media/image_asset.dart';
import 'package:worldpainter_pc/media/image_asset_store_contract.dart';
import 'package:worldpainter_pc/media/image_asset_validation.dart';
import 'package:worldpainter_pc/prototype/workbench_controller.dart';
import 'package:worldpainter_pc/security/credential_vault_contract.dart';
import 'package:worldpainter_pc/storage/sqlite_workspace_store.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(sqfliteFfiInit);

  group('AssistantController', () {
    test('creates, switches, and deletes sessions without mixing drafts', () {
      final workbench = _workbench(_FakeTransport());
      _trackWorkbench(workbench);
      final assistant = workbench.assistant;
      final first = assistant.session;

      assistant.updateInput('第一个会话的草稿');
      assistant.newSession();
      final second = assistant.session;
      assistant.updateInput('第二个会话的草稿');

      assistant.selectSession(first.id);
      expect(assistant.session.input, '第一个会话的草稿');
      assistant.selectSession(second.id);
      expect(assistant.session.input, '第二个会话的草稿');

      assistant.deleteSession();
      expect(assistant.state.sessions, hasLength(1));
      expect(assistant.state.activeSessionId, first.id);
      expect(assistant.session.input, '第一个会话的草稿');
      assistant.clearSessions();
      expect(assistant.state.sessions, hasLength(1));
      expect(assistant.session.input, isEmpty);
    });

    test(
      'stores provider credentials outside the workspace and binds both roles',
      () async {
        final vault = _MemoryVault();
        final workbench = _workbench(_FakeTransport(), vault: vault);
        _trackWorkbench(workbench);
        final main = _provider('main-provider', requireKey: true);
        final vision = _provider('vision-provider');

        await workbench.assistant.saveProvider(
          main,
          secret: 'assistant-secret-never-in-sqlite',
        );
        await workbench.assistant.saveProvider(vision);
        workbench.assistant.selectProvider(main.id);
        workbench.assistant.selectProvider(vision.id, vision: true);
        await workbench.flush();

        final exported = workbench.exportWorkspace();
        final encoded = jsonEncode(exported);
        final assistantJson = exported['assistant']! as Map<String, dynamic>;
        expect(assistantJson['mainProviderId'], main.id);
        expect(assistantJson['visionProviderId'], vision.id);
        expect(assistantJson['providers'], hasLength(2));
        expect(workbench.assistant.state.mainProvider?.model, main.model);
        expect(workbench.assistant.state.visionProvider?.model, vision.model);
        expect(
          await main.readSecret(vault),
          'assistant-secret-never-in-sqlite',
        );
        expect(encoded, isNot(contains('assistant-secret-never-in-sqlite')));
        expect(encoded, isNot(contains('apiKey')));
      },
    );

    test(
      'persists SQLite state and interrupts in-flight work after reopen',
      () async {
        final directory = await _newTestDirectory();
        SQLiteWorkspaceStore? store;
        WorkbenchController? workbench;
        try {
          store = await _openStore(directory);
          final transport = _FakeTransport();
          workbench = WorkbenchController(
            generationDelay: Duration.zero,
            store: store,
            assistantTransport: transport,
          );
          final assistant = workbench.assistant;
          final provider = _provider('sqlite-provider');
          assistant.state.providers.add(provider);
          assistant.state.mainProviderId = provider.id;
          assistant.state.visionProviderId = provider.id;
          final active = assistant.session;
          active
            ..title = 'SQLite 会话'
            ..input = '尚未发送的草稿'
            ..turns.add(
              AssistantTurn(
                id: 'running-turn',
                userText: '持久化中的请求',
                attachments: [_imageRef()],
                status: 'running',
                messages: [
                  {
                    'role': 'assistant',
                    'content': null,
                    'tool_calls': [
                      AgentCall(
                        id: 'call-1',
                        name: 'write_prompt',
                        arguments: '{"target":"positive","content":"新词"}',
                      ).toJson(),
                    ],
                  },
                ],
                traces: [
                  {
                    'callId': 'call-1',
                    'name': 'write_prompt',
                    'arguments': '{"target":"positive","content":"新词"}',
                    'status': 'waiting',
                    'durationMs': 15,
                  },
                ],
              ),
            );
          assistant.state.sessions.add(
            AssistantSession(
              id: 'older-session',
              title: '已完成的旧会话',
              turns: [
                AssistantTurn(
                  id: 'complete-turn',
                  userText: '完成的中文请求',
                  status: 'complete',
                  messages: [
                    {'role': 'assistant', 'content': '完整回复'},
                  ],
                ),
              ],
            ),
          );
          assistant.changed();
          await workbench.flush();
          await workbench.closeStorage();
          workbench.dispose();
          workbench = null;
          store = null;

          store = await _openStore(directory);
          final stored = await store.load();
          expect(stored, isNotNull);
          final reopenedTransport = _FakeTransport();
          workbench = WorkbenchController(
            generationDelay: Duration.zero,
            store: store,
            restored: stored,
            assistantTransport: reopenedTransport,
          );

          final restored = workbench.assistant.state;
          expect(restored.mainProvider?.id, 'sqlite-provider');
          expect(restored.visionProvider?.id, 'sqlite-provider');
          expect(restored.activeSession!.title, 'SQLite 会话');
          expect(restored.activeSession!.input, '尚未发送的草稿');
          final recoveredTurn = restored.activeSession!.turns.single;
          expect(recoveredTurn.status, 'interrupted');
          expect(recoveredTurn.attachments, [_imageRef()]);
          expect(recoveredTurn.messages.single['tool_calls'], isNotEmpty);
          expect(recoveredTurn.traces.single['status'], 'interrupted');
          expect(restored.sessions.last.turns.single.status, 'complete');
          expect(reopenedTransport.requests, isEmpty);
          await workbench.flush();
        } finally {
          if (workbench != null) {
            if (!workbench.closing) await workbench.closeStorage();
            workbench.dispose();
          } else if (store != null) {
            await store.close();
          }
          await _deleteTestDirectorySafely(directory);
        }
      },
    );

    test(
      'reuses the saved vision description in the next turn context',
      () async {
        final imageBytes = await _makeTestPng();
        final validated = await validateImageAssetBytes(imageBytes);
        final assets = _MemoryAssets({validated.asset.assetRef: imageBytes});
        const marker = 'VISION_CONTEXT_MARKER_青色的纸灯';
        final transport = _FakeTransport(
          responder: (request) async => AgentReply(
            content: request.provider.id == 'vision-provider' ? marker : '收到。',
          ),
        );
        final workbench = _workbench(transport, assets: assets);
        _trackWorkbench(workbench);
        _bindProvider(workbench, _provider('main-provider'));
        _bindProvider(
          workbench,
          _provider('vision-provider'),
          main: false,
          vision: true,
        );
        final session = workbench.assistant.session;
        session
          ..input = '描述图片里的灯笼'
          ..attachments.add(validated.asset.assetRef);
        workbench.assistant.changed();

        await workbench.assistant.send();
        expect(
          session.turns.single.traces.any(
            (trace) => trace['name'] == 'vision' && trace['result'] == marker,
          ),
          isTrue,
        );
        expect(session.turns.single.attachments, [validated.asset.assetRef]);
        final persistedAssistant = jsonEncode(
          workbench.assistant.state.toJson(),
        );
        expect(persistedAssistant, isNot(contains('data:image/png;base64')));

        workbench.assistant.updateInput('继续说说它的颜色');
        await workbench.assistant.send();
        final mainCalls = transport.requests
            .where((request) => request.provider.id == 'main-provider')
            .toList();
        expect(mainCalls, hasLength(2));
        expect(jsonEncode(mainCalls.last.messages), contains(marker));
      },
    );

    test('keeps attach busy until a slow asset save is mounted', () async {
      final saveStarted = Completer<void>();
      final saveGate = Completer<void>();
      final assets = _MemoryAssets(
        {},
        saveStarted: saveStarted,
        saveGate: saveGate,
      );
      final transport = _FakeTransport();
      final workbench = _workbench(transport, assets: assets);
      _trackWorkbench(workbench);
      _bindProvider(workbench, _provider('attach-provider'));
      final assistant = workbench.assistant;
      final first = assistant.session;
      assistant.newSession();
      final second = assistant.session;
      assistant.selectSession(first.id);
      assistant.updateInput('请看这张图片');

      final imageBytes = await _makeTestPng();
      final attaching = assistant.attachImage(imageBytes);
      try {
        await saveStarted.future.timeout(const Duration(seconds: 5));
        expect(assistant.attaching, isTrue);
        expect(assistant.busy, isTrue);
        expect(() => assistant.send(), throwsA(isA<AgentException>()));
        expect(
          () => assistant.selectSession(second.id),
          throwsA(isA<AgentException>()),
        );
        expect(workbench.canMaintainAssets, isFalse);
        await expectLater(
          workbench.maintainAssets(() async => 0),
          throwsA(isA<FormatException>()),
        );
        expect(transport.requests, isEmpty);
        expect(assistant.state.activeSessionId, first.id);
        expect(first.attachments, isEmpty);
      } finally {
        if (!saveGate.isCompleted) saveGate.complete();
        await attaching.timeout(const Duration(seconds: 5));
      }

      expect(assistant.attaching, isFalse);
      expect(assistant.busy, isFalse);
      expect(assistant.state.activeSessionId, first.id);
      expect(first.attachments, hasLength(1));
      final storedBytes = await assets.read(first.attachments.single);
      expect(storedBytes, imageBytes);
      expect(workbench.canMaintainAssets, isTrue);
      var maintenanceRan = false;
      await workbench.maintainAssets(() async {
        maintenanceRan = true;
        return 0;
      });
      expect(maintenanceRan, isTrue);
      assistant.selectSession(second.id);
      expect(assistant.session.id, second.id);
    });

    test('replays reasoning_content for the same endpoint and model', () async {
      final request = await _reasoningReplayRequest();

      final replayedAssistant = request.messages.singleWhere(
        (message) => message['role'] == 'assistant',
      );
      expect(
        replayedAssistant['reasoning_content'],
        'SAME_PROVIDER_REASONING_MARKER',
      );
    });

    test(
      'drops provider-specific reasoning when only the endpoint changes',
      () async {
        final request = await _reasoningReplayRequest(
          changedEndpoint: 'https://second-gateway.example/v1',
        );

        final replayedAssistant = request.messages.singleWhere(
          (message) => message['role'] == 'assistant',
        );
        expect(replayedAssistant['content'], '第一轮答复');
        expect(replayedAssistant.containsKey('reasoning_content'), isFalse);
      },
    );

    test(
      'drops provider-specific reasoning when only the model changes',
      () async {
        final request = await _reasoningReplayRequest(
          changedModel: 'other-model',
        );

        final replayedAssistant = request.messages.singleWhere(
          (message) => message['role'] == 'assistant',
        );
        expect(replayedAssistant['content'], '第一轮答复');
        expect(replayedAssistant.containsKey('reasoning_content'), isFalse);
      },
    );

    test(
      'cancel keeps the running session isolated and does not auto-resume',
      () async {
        final reachedTransport = Completer<void>();
        final lateReply = Completer<AgentReply>();
        final transport = _FakeTransport(
          responder: (_) {
            if (!reachedTransport.isCompleted) reachedTransport.complete();
            return lateReply.future;
          },
        );
        final workbench = _workbench(transport);
        _trackWorkbench(workbench);
        _bindProvider(workbench, _provider('cancel-provider'));
        final assistant = workbench.assistant;
        final first = assistant.session;
        assistant.updateInput('停止中的请求');
        assistant.newSession();
        final second = assistant.session;
        assistant.updateInput('另一会话草稿');
        assistant.selectSession(first.id);

        final running = assistant.send();
        await reachedTransport.future.timeout(const Duration(seconds: 5));
        expect(
          () => assistant.selectSession(second.id),
          throwsA(isA<AgentException>()),
        );
        assistant.cancel();
        await running.timeout(const Duration(seconds: 5));
        lateReply.complete(AgentReply(content: '延迟到达的回复'));

        expect(first.turns.single.status, 'cancelled');
        expect(transport.requests, hasLength(1));
        expect(assistant.state.activeSessionId, first.id);
        assistant.selectSession(second.id);
        assistant.updateInput('已独立编辑的草稿');
        expect(second.input, '已独立编辑的草稿');
        expect(first.input, isEmpty);
        expect(first.turns.single.status, 'cancelled');
      },
    );

    test('forking an edited turn resends from cloned history and isolates attachments', () async {
      final transport = _FakeTransport(
        replies: [AgentReply(content: '分支中的新回复')],
      );
      final workbench = _workbench(transport);
      _trackWorkbench(workbench);
      final assistant = workbench.assistant;
      _bindProvider(workbench, _provider('branch-provider'));
      final source = assistant.session;
      final previous = AssistantTurn(
        id: 'previous-turn',
        userText: '保留的历史',
        status: 'complete',
        messages: [
          {'role': 'assistant', 'content': '旧回复'},
        ],
      );
      final edited = AssistantTurn(
        id: 'edited-turn',
        userText: '从这里重新编辑',
        status: 'failed',
        attachments: [_imageRef()],
      );
      source.turns.addAll([previous, edited]);

      assistant.forkFromTurn(edited);
      final fork = assistant.session;
      expect(fork.id, isNot(source.id));
      expect(fork.turns, hasLength(1));
      expect(fork.turns.single.id, isNot(previous.id));
      expect(fork.turns.single.userText, previous.userText);
      expect(fork.turns.single.messages, previous.messages);
      expect(
        AssistantState.fromJson(assistant.state.toJson()).sessions,
        hasLength(2),
      );
      expect(identical(fork.turns.single, previous), isFalse);
      expect(fork.input, edited.userText);
      expect(fork.attachments, edited.attachments);

      assistant.updateInput('只修改分支草稿');
      assistant.removeAttachment(_imageRef());
      expect(fork.input, '只修改分支草稿');
      expect(fork.attachments, isEmpty);
      expect(edited.userText, '从这里重新编辑');
      expect(edited.attachments, [_imageRef()]);
      expect(source.turns, hasLength(2));

      assistant.updateInput('重新编辑后的请求');
      await assistant.send();
      expect(fork.turns, hasLength(2));
      expect(fork.turns.last.userText, '重新编辑后的请求');
      expect(fork.turns.last.status, 'complete');
      expect(source.turns, hasLength(2));
      expect(transport.requests, hasLength(1));
    });

    test(
      'tool diagnostics fail when the model returns no structured call',
      () async {
        final transport = _FakeTransport(
          replies: [AgentReply(content: '工具调用成功！')],
        );
        final workbench = _workbench(transport);
        _trackWorkbench(workbench);
        _bindProvider(workbench, _provider('diagnostic-provider'));

        await workbench.assistant.send(diagnostic: true);

        final turn = workbench.assistant.session.turns.single;
        expect(turn.status, 'failed');
        expect(turn.error, contains('未返回工具调用'));
        expect(workbench.assistant.status, isNot(contains('诊断通过')));
        expect(transport.requests, hasLength(1));
        expect(transport.requests.single.toolChoice, 'required');
        expect(
          (transport.requests.single.tools.single['function'] as Map)['name'],
          'diagnostic_echo',
        );
      },
    );

    test(
      'rejecting a write_prompt confirmation leaves the prompt unchanged',
      () async {
        final transport = _FakeTransport(
          replies: [
            AgentReply(
              calls: [
                AgentCall(
                  id: 'read-call',
                  name: 'read_current_prompts',
                  arguments: '{}',
                ),
              ],
            ),
            AgentReply(
              calls: [
                AgentCall(
                  id: 'write-call',
                  name: 'write_prompt',
                  arguments: jsonEncode({
                    'target': 'positive',
                    'content': '新词条',
                    'mode': 'replace',
                  }),
                ),
              ],
            ),
          ],
        );
        final workbench = _workbench(transport);
        _trackWorkbench(workbench);
        _bindProvider(workbench, _provider('write-provider'));
        const original = '原始正向提示词 {{weight::1.15}}';
        workbench.updatePrompt(original);
        workbench.assistant.updateInput('替换主提示词');
        final shown = Completer<void>();
        void observeInteraction() {
          if (workbench.assistant.interaction != null && !shown.isCompleted) {
            shown.complete();
          }
        }

        workbench.assistant.addListener(observeInteraction);
        try {
          final pending = workbench.assistant.send();
          await shown.future.timeout(const Duration(seconds: 5));
          expect(workbench.assistant.interaction!.preview['修改前'], original);
          expect(workbench.assistant.interaction!.preview['修改后'], '新词条');
          workbench.assistant.answer('拒绝');
          await pending;
        } finally {
          workbench.assistant.removeListener(observeInteraction);
        }

        expect(workbench.prompt, original);
        expect(workbench.assistant.session.turns.single.status, 'failed');
        expect(
          workbench.assistant.session.turns.single.traces.last['status'],
          'denied',
        );
        expect(transport.requests, hasLength(2));
      },
    );
  });
}

WorkbenchController _workbench(
  AgentTransport transport, {
  CredentialVault? vault,
  ImageAssetStore? assets,
}) => WorkbenchController(
  generationDelay: Duration.zero,
  assistantTransport: transport,
  vault: vault,
  assets: assets,
);

Future<_FakeRequest> _reasoningReplayRequest({
  String? changedEndpoint,
  String? changedModel,
}) async {
  final transport = _FakeTransport(
    replies: const [
      AgentReply(
        content: '第一轮答复',
        reasoningContent: 'SAME_PROVIDER_REASONING_MARKER',
      ),
      AgentReply(content: '第二轮答复'),
    ],
  );
  final workbench = _workbench(transport);
  _trackWorkbench(workbench);
  final assistant = workbench.assistant;
  final initial = _provider('reasoning-provider');
  await assistant.saveProvider(initial);
  assistant.updateInput('第一轮请求');
  await assistant.send();

  if (changedEndpoint != null || changedModel != null) {
    await assistant.saveProvider(
      AssistantProvider(
        id: initial.id,
        name: initial.name,
        baseUrl: changedEndpoint ?? initial.baseUrl,
        model: changedModel ?? initial.model,
        streaming: initial.streaming,
        requireKey: initial.requireKey,
      ),
    );
  }
  assistant.updateInput('第二轮请求');
  await assistant.send();
  return transport.requests.last;
}

Future<Uint8List> _makeTestPng() async {
  final recorder = ui.PictureRecorder();
  final canvas = ui.Canvas(recorder);
  canvas.drawRect(
    const ui.Rect.fromLTWH(0, 0, 2, 2),
    ui.Paint()..color = const ui.Color(0xff467ca1),
  );
  final picture = recorder.endRecording();
  final image = await picture.toImage(2, 2);
  try {
    final data = await image.toByteData(format: ui.ImageByteFormat.png);
    if (data == null) {
      throw StateError('Flutter could not encode the test PNG.');
    }
    return Uint8List.fromList(
      data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes),
    );
  } finally {
    image.dispose();
    picture.dispose();
  }
}

void _trackWorkbench(WorkbenchController workbench) {
  addTearDown(() async {
    if (!workbench.closing) await workbench.closeStorage();
    workbench.dispose();
  });
}

void _bindProvider(
  WorkbenchController workbench,
  AssistantProvider provider, {
  bool main = true,
  bool vision = false,
}) {
  workbench.assistant.state.providers.add(provider);
  if (main) workbench.assistant.state.mainProviderId = provider.id;
  if (vision) workbench.assistant.state.visionProviderId = provider.id;
}

AssistantProvider _provider(String id, {bool requireKey = false}) =>
    AssistantProvider(
      id: id,
      name: '$id 测试连接',
      baseUrl: 'https://$id.example/v1',
      model: '$id-model',
      streaming: false,
      requireKey: requireKey,
    );

String _imageRef() {
  final digest = List<String>.filled(64, 'a').join();
  return 'sha256/${digest.substring(0, 2)}/$digest.png';
}

Future<SQLiteWorkspaceStore> _openStore(Directory directory) =>
    SQLiteWorkspaceStore.open(
      factory: databaseFactoryFfi,
      path: p.join(directory.path, 'assistant.sqlite'),
      label: '助手控制器测试',
    );

Future<Directory> _newTestDirectory() async {
  final projectRoot = p.normalize(
    await Directory.current.resolveSymbolicLinks(),
  );
  if (!await File(p.join(projectRoot, 'pubspec.yaml')).exists()) {
    throw StateError('Controller tests must run from the PC project root.');
  }
  final temporaryRoot = Directory(
    p.join(projectRoot, '.tmp', 'assistant-controller-tests'),
  );
  await temporaryRoot.create(recursive: true);
  final canonicalProject = p.normalize(projectRoot);
  final canonicalTemporary = p.normalize(
    await Directory(p.join(projectRoot, '.tmp')).resolveSymbolicLinks(),
  );
  final canonicalRoot = p.normalize(await temporaryRoot.resolveSymbolicLinks());
  if (!p.isWithin(canonicalProject, canonicalTemporary) ||
      !p.isWithin(canonicalTemporary, canonicalRoot)) {
    throw StateError(
      'Refusing to create controller test data outside PC/.tmp.',
    );
  }
  return temporaryRoot.createTemp('case-');
}

Future<void> _deleteTestDirectorySafely(Directory target) async {
  if (!await target.exists()) return;
  final projectRoot = p.normalize(
    await Directory.current.resolveSymbolicLinks(),
  );
  final canonicalTemporary = p.normalize(
    await Directory(p.join(projectRoot, '.tmp')).resolveSymbolicLinks(),
  );
  final canonicalRoot = p.normalize(
    await Directory(p.join(projectRoot, '.tmp', 'assistant-controller-tests'))
        .resolveSymbolicLinks(),
  );
  final canonicalTarget = p.normalize(await target.resolveSymbolicLinks());
  if (!p.isWithin(projectRoot, canonicalTemporary) ||
      !p.isWithin(canonicalTemporary, canonicalRoot) ||
      p.equals(canonicalRoot, canonicalTarget) ||
      !p.isWithin(canonicalRoot, canonicalTarget)) {
    throw StateError('Refusing to remove a path outside PC/.tmp test storage.');
  }
  await Directory(canonicalTarget).delete(recursive: true);
}

class _FakeTransport implements AgentTransport {
  _FakeTransport({List<AgentReply> replies = const [], this.responder})
    : _replies = List<AgentReply>.of(replies);

  final List<AgentReply> _replies;
  final Future<AgentReply> Function(_FakeRequest request)? responder;
  final List<_FakeRequest> requests = [];

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
    final request = _FakeRequest(
      provider: provider,
      messages: _cloneMaps(messages),
      tools: _cloneMaps(tools),
      toolChoice: toolChoice,
    );
    requests.add(request);
    final reply = responder == null ? _nextReply() : await responder!(request);
    if (reply.content.isNotEmpty) onText?.call(reply.content);
    return reply;
  }

  AgentReply _nextReply() {
    if (_replies.isEmpty) {
      throw StateError('The fake transport has no scripted reply.');
    }
    return _replies.removeAt(0);
  }
}

class _FakeRequest {
  const _FakeRequest({
    required this.provider,
    required this.messages,
    required this.tools,
    required this.toolChoice,
  });

  final AssistantProvider provider;
  final List<Map<String, dynamic>> messages;
  final List<Map<String, dynamic>> tools;
  final String toolChoice;
}

List<Map<String, dynamic>> _cloneMaps(List<Map<String, dynamic>> source) =>
    (jsonDecode(jsonEncode(source)) as List)
        .map((item) => Map<String, dynamic>.from(item as Map))
        .toList();

class _MemoryVault implements CredentialVault {
  final Map<String, String> _values = {};

  String _mapKey(String provider, String key) => '$provider|$key';

  @override
  Future<String?> read({required String provider, required String key}) async =>
      _values[_mapKey(provider, key)];

  @override
  Future<void> save({
    required String provider,
    required String key,
    required String secret,
  }) async {
    _values[_mapKey(provider, key)] = secret;
  }

  @override
  Future<void> delete({required String provider, required String key}) async {
    _values.remove(_mapKey(provider, key));
  }
}

class _MemoryAssets implements ImageAssetStore {
  _MemoryAssets(Map<String, Uint8List> bytes, {this.saveStarted, this.saveGate})
    : _bytes = {
        for (final entry in bytes.entries)
          entry.key: Uint8List.fromList(entry.value),
      };

  final Map<String, Uint8List> _bytes;
  final Completer<void>? saveStarted;
  final Completer<void>? saveGate;
  bool closed = false;

  @override
  String get label => '合成内存图片';

  @override
  Future<ImageAsset> save(Uint8List bytes) async {
    if (saveStarted != null && !saveStarted!.isCompleted) {
      saveStarted!.complete();
    }
    if (saveGate != null) await saveGate!.future;
    final validated = await validateImageAssetBytes(bytes);
    _bytes[validated.asset.assetRef] = Uint8List.fromList(validated.bytes);
    return validated.asset;
  }

  @override
  Future<Uint8List> read(String assetRef) async {
    final bytes = _bytes[assetRef];
    if (bytes == null) throw ImageAssetNotFoundException(assetRef);
    return Uint8List.fromList(bytes);
  }

  @override
  Future<void> close() async {
    closed = true;
  }
}

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:worldpainter_pc/assistant/agent_contract.dart';
import 'package:worldpainter_pc/assistant/assistant_state.dart';
import 'package:worldpainter_pc/assistant/prompting_knowledge.dart';
import 'package:worldpainter_pc/generation/generation_parameters.dart';
import 'package:worldpainter_pc/prototype/workbench_controller.dart';
import 'package:worldpainter_pc/storage/sqlite_workspace_store.dart';

const _proposal =
    '{"positive":"1.2::moonlight::, forest\\nsoft light",'
    '"negative":"blurry", "characters":[{"positive":"silver hair"}],'
    '"reason":"明确主体和月光方向"}';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(sqfliteFfiInit);

  test('old snapshots default to v45 and versions stay bound to sessions', () {
    final c = _workbench();
    addTearDown(c.dispose);
    final a = c.assistant;
    final first = a.session.id;
    a.newSession();
    a.updateSettings(
      systemPrompt: '',
      contextTurns: 8,
      promptingVersion: PromptingVersion.v5,
    );
    a.selectSession(first);
    expect(a.promptingVersion, PromptingVersion.v45);
    a.newSession();
    expect(a.promptingVersion, PromptingVersion.v5);
    final saved =
        jsonDecode(jsonEncode(a.state.toJson())) as Map<String, dynamic>;
    expect(
      AssistantState.fromJson(saved).activeSession!.promptingVersion,
      PromptingVersion.v5,
    );
    saved.remove('promptingVersion');
    for (final s in saved['sessions'] as List) {
      (s as Map).remove('promptingVersion');
    }
    final old = AssistantState.fromJson(saved);
    expect(old.promptingVersion, PromptingVersion.v45);
    for (final bad in [null, 'v6', 5]) {
      expect(
        () => AssistantState.fromJson({...saved, 'promptingVersion': bad}),
        throwsFormatException,
      );
    }
  });

  test('v5 calls reference, leaves proposal untouched until partial approval, SQLite reopens receipt', () async {
    final dir = await Directory('.tmp/prompting-integration')
        .create(recursive: true);
    final run = await dir.createTemp('reopen-');
    final path = '${run.path}/workspace.sqlite';
    var store = await SQLiteWorkspaceStore.open(
      factory: databaseFactoryFfi,
      path: path,
    );
    final transport = _Transport(reference: true);
    var c = _workbench(transport: transport, store: store);
    try {
      final a = c.assistant;
      a.updateSettings(
        systemPrompt: '',
        contextTurns: 8,
        promptingVersion: PromptingVersion.v5,
      );
      a.updateInput('请查阅参考资料，提出月光森林修改方案。');
      await a.send(requireTool: true);
      final turn = a.session.turns.single;
      expect(turn.status, 'complete', reason: turn.error);
      expect(turn.traces.single['name'], 'read_prompting_reference');
      expect(turn.traces.single['status'], 'completed');
      expect(c.prompt, 'synthetic before');
      expect(c.parameters.characters, isEmpty);
      await File('.tmp/prompting-native-fixture.json')
          .writeAsString(jsonEncode(c.exportWorkspace()));
      final review = a.preparePromptProposal(turn);
      expect(
        review.proposal.fields.keys,
        containsAll(['positive', 'negative', 'character_1']),
      );
      await a.applyPromptProposal(
        review,
        targets: {'positive', 'character_1'},
        reason: '只采纳主体与光线',
      );
      expect(c.negative, 'synthetic negative');
      expect(c.parameters.characters.single.prompt, 'silver hair');
      expect(turn.promptApplication!.before['character_1'], '');
      expect(
        turn.promptApplication!.after.keys,
        unorderedEquals(['positive', 'character_1']),
      );
      expect(
        () => a.preparePromptProposal(turn),
        throwsA(isA<AgentException>()),
      );
      await c.closeStorage();
      c.dispose();
      store = await SQLiteWorkspaceStore.open(
        factory: databaseFactoryFfi,
        path: path,
      );
      c = WorkbenchController(store: store, restored: await store.load());
      expect(c.prompt, '1.2::moonlight::, forest\nsoft light');
      expect(c.assistant.promptingVersion, PromptingVersion.v5);
      final receipt = c.assistant.session.turns.single.promptApplication!;
      expect(receipt.version, PromptingVersion.v5);
      expect(receipt.reason, '只采纳主体与光线');
      expect(receipt.before['positive'], 'synthetic before');
      expect(DateTime.tryParse(receipt.appliedAt), isNotNull);
    } finally {
      await c.closeStorage();
      c.dispose();
    }
  });

  test('v45 and plain chat do not advertise v5 reference tools', () async {
    final t = _Transport();
    final c = _workbench(transport: t);
    addTearDown(c.dispose);
    c.assistant.updateInput('合成提案');
    await c.assistant.send();
    expect(t.advertised.single, isNot(contains('read_prompting_reference')));
    c.assistant.updateSettings(
      systemPrompt: '',
      contextTurns: 8,
      promptingVersion: PromptingVersion.v5,
    );
    c.assistant.updateInput('只讨论');
    await c.assistant.send(agent: false);
    expect(t.advertised.last, isEmpty);
    expect(t.systems.last, contains('V5'));
  });

  test(
    'draft edited during response cannot be overwritten by late proposal',
    () async {
      final t = _Transport()..pending = Completer<AgentReply>();
      final c = _workbench(transport: t);
      addTearDown(c.dispose);
      c.assistant.updateInput('合成提案');
      final request = c.assistant.send();
      await t.started.future;
      expect(
        () => c.assistant.updateSettings(
          systemPrompt: '',
          contextTurns: 8,
          promptingVersion: PromptingVersion.v5,
        ),
        throwsA(isA<AgentException>()),
      );
      c.updatePrompt('newer user edit');
      t.pending!.complete(const AgentReply(content: _proposal));
      await request;
      expect(
        () =>
            c.assistant.preparePromptProposal(c.assistant.session.turns.single),
        throwsA(isA<AgentException>()),
      );
      expect(c.prompt, 'newer user edit');
    },
  );

  test('draft edited after preview blocks all fields atomically', () async {
    final c = _workbench();
    addTearDown(c.dispose);
    c.assistant.updateInput('合成提案');
    await c.assistant.send();
    final turn = c.assistant.session.turns.single;
    final review = c.assistant.preparePromptProposal(turn);
    c.updateNegative('new negative');
    await expectLater(
      c.assistant.applyPromptProposal(
        review,
        targets: review.proposal.fields.keys.toSet(),
        reason: '测试',
      ),
      throwsA(isA<AgentException>()),
    );
    expect(c.prompt, 'synthetic before');
    expect(c.parameters.characters, isEmpty);
    expect(turn.promptApplication, isNull);
  });

  test(
    'session change, unexpected target and modified reply cannot reuse preview',
    () async {
      final c = _workbench();
      addTearDown(c.dispose);
      final a = c.assistant;
      a.updateInput('合成提案');
      await a.send();
      final turn = a.session.turns.single;
      final review = a.preparePromptProposal(turn);
      await expectLater(
        a.applyPromptProposal(
          review,
          targets: {'inpaint_positive'},
          reason: '测试',
        ),
        throwsA(isA<AgentException>()),
      );
      turn.messages.last['content'] = '{"positive":"changed model text"}';
      await expectLater(
        a.applyPromptProposal(review, targets: {'positive'}, reason: '测试'),
        throwsA(isA<AgentException>()),
      );
      turn.messages.last['content'] = _proposal;
      a.newSession();
      await expectLater(
        a.applyPromptProposal(review, targets: {'positive'}, reason: '测试'),
        throwsA(isA<AgentException>()),
      );
      expect(c.prompt, 'synthetic before');
    },
  );

  test(
    'cancelled response and legacy turns cannot become applicable proposals',
    () async {
      final t = _Transport()..pending = Completer<AgentReply>();
      final c = _workbench(transport: t);
      addTearDown(c.dispose);
      final a = c.assistant;
      a.updateInput('合成提案');
      final pending = a.send();
      await t.started.future;
      a.cancel();
      await pending;
      t.pending!.complete(const AgentReply(content: _proposal));
      final turn = a.session.turns.single;
      expect(turn.status, 'cancelled');
      expect(a.proposalForTurn(turn), isNull);
      final old = AssistantTurn(
        id: 'old',
        userText: 'old',
        status: 'complete',
        messages: [
          {'role': 'assistant', 'content': _proposal},
        ],
      );
      a.session.turns.add(old);
      expect(
        () => a.preparePromptProposal(old),
        throwsA(isA<AgentException>()),
      );
    },
  );

  test('diagnostic registry remains isolated from prompting mode', () async {
    final t = _Transport();
    final c = _workbench(transport: t);
    addTearDown(c.dispose);
    c.assistant.updateSettings(
      systemPrompt: '',
      contextTurns: 8,
      promptingVersion: PromptingVersion.v5,
    );
    await c.assistant.send(diagnostic: true);
    expect(t.advertised.single, ['diagnostic_echo']);
    expect(c.assistant.session.turns.single.proposalDraftFingerprint, isEmpty);
  });

  test('inpaint proposals name the actual targets and leave generation words intact', () async {
    final c = _workbench();
    addTearDown(c.dispose);
    c.updateAdvanced(
      c.parameters.copyWith(operation: GenerationOperation.inpaint),
    );
    c.updatePrompt('inpaint before');
    c.assistant.updateInput('合成局部重绘提案');
    await c.assistant.send();
    final turn = c.assistant.session.turns.single;
    final review = c.assistant.preparePromptProposal(turn);
    expect(
      review.proposal.fields.keys,
      containsAll(['inpaint_positive', 'inpaint_negative']),
    );
    await c.assistant.applyPromptProposal(
      review,
      targets: {'inpaint_positive'},
      reason: '局部重绘主体',
    );
    expect(turn.promptApplication!.before, {
      'inpaint_positive': 'inpaint before',
    });
    c.updateAdvanced(
      c.parameters.copyWith(operation: GenerationOperation.textToImage),
    );
    expect(c.prompt, 'synthetic before');
  });

  test('all prompt targets are validated before any draft mutation', () {
    final c = _workbench();
    addTearDown(c.dispose);
    expect(
      () => c.applyAssistantPrompts({
        'positive': 'would be wrong',
        'inpaint_negative': 'wrong mode',
      }),
      throwsA(isA<AgentException>()),
    );
    expect(c.prompt, 'synthetic before');
    expect(
      () => c.applyAssistantPrompts({
        'positive': 'would be wrong',
        'character_7': 'outside six slots',
      }),
      throwsA(isA<AgentException>()),
    );
    expect(c.prompt, 'synthetic before');
  });

  test(
    'versioned conversation forks keep prior receipts with unique turn IDs',
    () async {
      final c = _workbench(store: _FailingStore());
      addTearDown(c.dispose);
      final a = c.assistant;
      a.updateSettings(
        systemPrompt: '',
        contextTurns: 8,
        promptingVersion: PromptingVersion.v5,
      );
      a.updateInput('第一条合成提案');
      await a.send();
      final first = a.session.turns.single;
      await a.applyPromptProposal(
        a.preparePromptProposal(first),
        targets: {'positive'},
        reason: '合成首轮',
      );
      a.updateInput('第二条合成提案');
      await a.send();
      a.forkFromTurn(a.session.turns.last);
      await c.flush();
      expect(a.promptingVersion, PromptingVersion.v5);
      expect(a.session.turns.single.id, isNot(first.id));
      expect(a.session.turns.single.promptApplication!.reason, '合成首轮');
      expect(AssistantState.fromJson(a.state.toJson()).sessions, hasLength(2));
    },
  );

  test(
    'failed save retains matching receipt and draft then retries one snapshot',
    () async {
      final store = _FailingStore();
      final c = _workbench(store: store);
      addTearDown(c.dispose);
      c.assistant.updateInput('合成保存失败');
      await c.assistant.send();
      final turn = c.assistant.session.turns.single;
      final review = c.assistant.preparePromptProposal(turn);
      store.fail = true;
      await expectLater(
        c.assistant.applyPromptProposal(
          review,
          targets: {'positive'},
          reason: '验证保存失败',
        ),
        throwsA(isA<AgentException>()),
      );
      expect(c.prompt, review.proposal.fields['positive']);
      expect(turn.promptApplication!.after['positive'], c.prompt);
      expect(
        () => c.assistant.preparePromptProposal(turn),
        throwsA(isA<AgentException>()),
      );
      store.fail = false;
      await c.flush(retry: true);
      final reopened = WorkbenchController(restored: await store.load());
      addTearDown(reopened.dispose);
      expect(reopened.prompt, c.prompt);
      expect(
        reopened.assistant.session.turns.single.promptApplication!.reason,
        '验证保存失败',
      );
    },
  );
}

WorkbenchController _workbench({_Transport? transport, WorkspaceStore? store}) {
  final c = WorkbenchController(
    assistantTransport: transport ?? _Transport(),
    store: store,
  );
  c.updatePrompt('synthetic before');
  c.updateNegative('synthetic negative');
  c.assistant.state.providers.add(
    const AssistantProvider(
      id: 'prompting-fixture',
      name: '本地提案测试',
      baseUrl: 'http://127.0.0.1:5123/v1',
      model: 'synthetic-prompt-model',
      requireKey: false,
    ),
  );
  c.assistant.state.mainProviderId = 'prompting-fixture';
  return c;
}

class _FailingStore implements WorkspaceStore {
  bool fail = false;
  StoredWorkspace? saved;
  @override
  String get label => 'synthetic failing store';
  @override
  Future<StoredWorkspace?> load() async => saved;
  @override
  Future<void> close() async {}
  @override
  Future<int> save(
    Map<String, Object?> data, {
    required int expectedRevision,
  }) async {
    if (fail) throw const FileSystemException('synthetic storage failure');
    saved = StoredWorkspace(
      data: Map<String, Object?>.from(jsonDecode(jsonEncode(data)) as Map),
      revision: expectedRevision + 1,
    );
    return expectedRevision + 1;
  }
}

class _Transport implements AgentTransport {
  _Transport({this.reference = false});
  final bool reference;
  final started = Completer<void>();
  Completer<AgentReply>? pending;
  final advertised = <List<String>>[];
  final systems = <String>[];
  @override
  Future<AgentReply> complete({
    required AssistantProvider provider,
    required List<Map<String, dynamic>> messages,
    required List<Map<String, dynamic>> tools,
    required String toolChoice,
    required AgentCancellation cancellation,
    void Function(String)? onText,
  }) async {
    advertised.add(tools.map((t) => t['function']['name'] as String).toList());
    systems.add(messages.first['content'] as String);
    if (!started.isCompleted) started.complete();
    if (pending != null) return pending!.future;
    if (reference && advertised.length == 1) {
      final tool = tools.singleWhere(
        (t) => t['function']['name'] == 'read_prompting_reference',
      );
      final properties = tool['function']['parameters']['properties'] as Map;
      final key = properties.keys.first as String;
      final topic = properties[key]['enum'][0];
      return AgentReply(
        calls: [
          AgentCall(
            id: 'reference-1',
            name: 'read_prompting_reference',
            arguments: jsonEncode({key: topic}),
          ),
        ],
        finishReason: 'tool_calls',
      );
    }
    if (reference) {
      expect(messages.last['role'], 'tool');
      expect(messages.last['content'], contains('https://docs.novelai.net/'));
    }
    return const AgentReply(content: _proposal);
  }
}

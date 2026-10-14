import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:worldpainter_pc/assistant/agent_contract.dart';
import 'package:worldpainter_pc/assistant/assistant_state.dart';
import 'package:worldpainter_pc/assistant/prompt_memory.dart';
import 'package:worldpainter_pc/assistant/workspace_tools.dart';
import 'package:worldpainter_pc/prototype/workbench_controller.dart';
import 'package:worldpainter_pc/storage/sqlite_workspace_store.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(sqfliteFfiInit);

  test('older assistant snapshot defaults memories; malformed memory stays an error', () {
    final old = AssistantState().toJson()..remove('memories');
    expect(AssistantState.fromJson(old).memories.entries, isEmpty);
    expect(
      () => AssistantState.fromJson({...old, 'memories': null}),
      throwsFormatException,
    );
    expect(
      () => AssistantState.fromJson({
        ...old,
        'memories': {'schema': 999},
      }),
      throwsFormatException,
    );
  });

  test(
    'agent proposal is not retrievable until a user explicitly approves it',
    () async {
      final transport = _MemoryTransport();
      final c = WorkbenchController(assistantTransport: transport);
      addTearDown(c.dispose);
      c.assistant.state.providers.add(
        const AssistantProvider(
          id: 'memory-fixture',
          name: 'synthetic',
          baseUrl: 'http://127.0.0.1:9999/v1',
          model: 'synthetic',
          requireKey: false,
        ),
      );
      c.assistant.state.mainProviderId = 'memory-fixture';
      c.assistant.updateInput('记住星璃喜欢银色月光');
      await c.assistant.send(requireTool: true);
      expect(c.assistant.session.turns.single.status, 'complete');
      final candidate = c.assistant.state.memories.entries.single;
      expect(candidate.source, MemorySource.pendingLlmCandidate);
      expect(candidate.isRetrievable, false);
      expect(transport.queryResult!['count'], 0);
      expect(transport.submissionResult!['active'], false);
      final revision = c.assistant.state.memories.revision;
      await c.assistant.approveMemory(candidate.id, expectedRevision: revision);
      final get = WorkspaceAgentTools(c)
          .build()
          .singleWhere((t) => t.name == 'get_memories');
      final plan = await get.prepare({'query': '请画星璃'}, AgentCancellation());
      final result = await plan.execute();
      expect(result['count'], 1);
      expect(
        (result['memories'] as List).single['content'],
        'silver moonlight',
      );
      expect(c.assistant.state.memories.entries.single.hitCount, 1);
      c.assistant.clearSessions();
      expect(c.assistant.state.memories.entries.single.id, candidate.id);
    },
  );

  test('cancelled proposal cannot create a candidate', () async {
    final c = WorkbenchController();
    addTearDown(c.dispose);
    final tool = WorkspaceAgentTools(c)
        .build()
        .singleWhere((t) => t.name == 'save_memory');
    final token = AgentCancellation()..cancel();
    await expectLater(
      tool.prepare({'trigger': '星璃', 'content': 'silver hair'}, token),
      throwsA(isA<AgentCancelled>()),
    );
    expect(c.assistant.state.memories.entries, isEmpty);
  });

  test(
    'memory conflicts, pending state and hits survive real SQLite reopen',
    () async {
      final tempRoot = Directory(
        p.join(Directory.current.path, '.tmp', 'memory-tests'),
      );
      await tempRoot.create(recursive: true);
      final directory = await tempRoot.createTemp('roundtrip-');
      SQLiteWorkspaceStore? store;
      WorkbenchController? c;
      try {
        store = await SQLiteWorkspaceStore.open(
          factory: databaseFactoryFfi,
          path: p.join(directory.path, 'workspace.sqlite'),
        );
        c = WorkbenchController(store: store);
        final original = await c.assistant.saveMemory(
          trigger: '月光',
          content: 'soft light',
          kind: MemoryKind.style,
        );
        final replacement = await c.assistant.saveMemory(
          trigger: '月光',
          content: 'silver moonlight',
          kind: MemoryKind.style,
          resolution: MemoryResolution.replace,
        );
        final candidate = await c.assistant.saveMemory(
          trigger: '星璃',
          content: 'silver hair',
          kind: MemoryKind.characterFeature,
          source: MemorySource.pendingLlmCandidate,
        );
        c.assistant.state.memories.retrieve('月光');
        c.assistant.changed();
        await c.closeStorage();
        c.dispose();
        c = null;
        store = null;
        store = await SQLiteWorkspaceStore.open(
          factory: databaseFactoryFfi,
          path: p.join(directory.path, 'workspace.sqlite'),
        );
        c = WorkbenchController(store: store, restored: await store.load());
        final entries = c.assistant.state.memories.entries;
        expect(
          entries.singleWhere((e) => e.id == original.id).supersededBy,
          replacement.id,
        );
        expect(entries.singleWhere((e) => e.id == replacement.id).hitCount, 1);
        expect(
          entries.singleWhere((e) => e.id == candidate.id).isRetrievable,
          false,
        );
        expect(c.assistant.state.memories.retrieve('星璃'), isEmpty);
      } finally {
        if (c != null) {
          await c.closeStorage();
          c.dispose();
        } else {
          await store?.close();
        }
        final resolvedRoot = await tempRoot.resolveSymbolicLinks();
        final resolvedDir = await directory.resolveSymbolicLinks();
        if (!p.isWithin(resolvedRoot, resolvedDir)) {
          throw StateError('Unsafe test cleanup path');
        }
        await directory.delete(recursive: true);
      }
    },
  );
}

class _MemoryTransport implements AgentTransport {
  int round = 0;
  Map<String, dynamic>? submissionResult, queryResult;
  @override
  Future<AgentReply> complete({
    required AssistantProvider provider,
    required List<Map<String, dynamic>> messages,
    required List<Map<String, dynamic>> tools,
    required String toolChoice,
    required AgentCancellation cancellation,
    void Function(String)? onText,
  }) async {
    round++;
    expect(
      tools.map((t) => t['function']['name']),
      containsAll(['get_memories', 'save_memory']),
    );
    if (round == 1) {
      return AgentReply(
        calls: [
          AgentCall(
            id: 'candidate-call',
            name: 'save_memory',
            arguments: jsonEncode({
              'trigger': '星璃',
              'content': 'silver moonlight',
              'type': 'preference',
            }),
          ),
        ],
        finishReason: 'tool_calls',
      );
    }
    if (round == 2) {
      expect(messages.last['tool_call_id'], 'candidate-call');
      submissionResult = jsonDecode(
        messages.last['content'] as String,
      ) as Map<String, dynamic>;
      return const AgentReply(
        calls: [
          AgentCall(
            id: 'query-call',
            name: 'get_memories',
            arguments: '{"query":"星璃"}',
          ),
        ],
        finishReason: 'tool_calls',
      );
    }
    expect(messages.last['tool_call_id'], 'query-call');
    queryResult =
        jsonDecode(messages.last['content'] as String) as Map<String, dynamic>;
    return const AgentReply(content: '已提交待审核候选，尚未生效。');
  }
}

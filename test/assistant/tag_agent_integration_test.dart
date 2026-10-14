import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:worldpainter_pc/assistant/agent_contract.dart';
import 'package:worldpainter_pc/assistant/workspace_tools.dart';
import 'package:worldpainter_pc/prototype/workbench_controller.dart';
import 'package:worldpainter_pc/storage/sqlite_workspace_store.dart';
import 'package:worldpainter_pc/tags/danbooru_client.dart';

import '../support/tag_agent_fixture.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(sqfliteFfiInit);

  test('tag settings default for old snapshots and reject malformed persisted settings', () {
    final old = WorkbenchController();
    addTearDown(old.dispose);
    final snapshot = old.exportWorkspace();
    final restored = WorkbenchController(
      restored: StoredWorkspace(data: snapshot, revision: 1),
    );
    addTearDown(restored.dispose);
    expect(restored.tagSearchBaseUrl, defaultDanbooruBaseUrl);
    expect(restored.tagSearchShowNsfw, true);
    for (final invalid in [
      null,
      {'schema': 999},
      {'schema': 1, 'baseUrl': 'http://external.invalid', 'showNsfw': true},
    ]) {
      expect(
        () => WorkbenchController(
          restored: StoredWorkspace(
            data: {...snapshot, 'tagSearch': invalid},
            revision: 1,
          ),
        ),
        throwsA(anyOf(isA<FormatException>(), isA<AgentException>())),
      );
    }
  });

  test('agent reads memory and tags, approves a diff, then reopens SQLite history and settings', () async {
    final root = Directory(
      p.join(Directory.current.path, '.tmp', 'tag-agent-tests'),
    );
    await root.create(recursive: true);
    final directory = await root.createTemp('roundtrip-');
    final databasePath = p.join(directory.path, 'workspace.sqlite');
    final transport = FixtureTagTransport();
    final tags = FixtureTagClient();
    var store = await SQLiteWorkspaceStore.open(
      factory: databaseFactoryFfi,
      path: databasePath,
    );
    var c = WorkbenchController(
      store: store,
      assistantTransport: transport,
      tagSearchClient: tags,
    );
    try {
      configureTagFixture(c);
      final request = c.assistant.send(requireTool: true);
      for (
        var i = 0;
        i < 300 && c.assistant.interaction == null && c.assistant.busy;
        i++
      ) {
        await Future<void>.delayed(const Duration(milliseconds: 10));
      }
      expect(c.assistant.interaction, isNotNull);
      expect(c.prompt, 'synthetic base prompt');
      expect(
        c.assistant.interaction!.preview['修改后'],
        'synthetic base prompt, $tagFixtureSuffix',
      );
      expect(
        () => c.configureTagSearch(
          baseUrl: 'https://other.invalid',
          showNsfw: true,
        ),
        throwsA(isA<AgentException>()),
      );
      c.assistant.answer('approve');
      await request;
      expect(c.assistant.session.turns.single.status, 'complete');
      expect(c.assistant.session.turns.single.traces.map((e) => e['name']), [
        'read_current_prompts',
        'get_memories',
        'search_danbooru',
        'write_prompt',
      ]);
      expect(
        c.assistant.session.turns.single.traces.every(
          (e) => e['status'] == 'completed',
        ),
        true,
      );
      expect(tags.requests.single['showNsfw'], false);
      await c.closeStorage();
      c.dispose();
      store = await SQLiteWorkspaceStore.open(
        factory: databaseFactoryFfi,
        path: databasePath,
      );
      c = WorkbenchController(store: store, restored: await store.load());
      expect(c.prompt, 'synthetic base prompt, $tagFixtureSuffix');
      expect(c.tagSearchBaseUrl, tagFixtureRoot);
      expect(c.tagSearchShowNsfw, false);
      expect(c.assistant.session.turns.single.traces, hasLength(4));
      expect(c.assistant.state.memories.entries.single.hitCount, 1);
    } finally {
      await c.closeStorage();
      c.dispose();
      if (!p.isWithin(
        await root.resolveSymbolicLinks(),
        await directory.resolveSymbolicLinks(),
      )) {
        throw StateError('Unsafe cleanup path');
      }
      await directory.delete(recursive: true);
    }
  });

  test('tag errors return a failed tool result instead of empty success or a write', () async {
    final tags = FixtureTagClient()
      ..handler = () async => throw const AgentException('模拟 HTTP 503');
    final transport = FixtureTagTransport();
    final c = WorkbenchController(
      assistantTransport: transport,
      tagSearchClient: tags,
    );
    addTearDown(c.dispose);
    configureTagFixture(c);
    await c.assistant.send(requireTool: true);
    expect(transport.searchResult!['ok'], false);
    expect(transport.searchResult!.containsKey('tags'), false);
    expect(c.prompt, 'synthetic base prompt');
    expect(c.assistant.interaction, isNull);
    expect(c.assistant.session.turns.single.traces.last['status'], 'failed');
  });

  test(
    'cancelling pending tags ignores a late result and never proposes a write',
    () async {
      final late = Completer<DanbooruSearchResult>();
      final tags = FixtureTagClient()..handler = () => late.future;
      final transport = FixtureTagTransport();
      final c = WorkbenchController(
        assistantTransport: transport,
        tagSearchClient: tags,
      );
      addTearDown(c.dispose);
      configureTagFixture(c);
      final request = c.assistant.send(requireTool: true);
      for (var i = 0; i < 100 && tags.token == null; i++) {
        await Future<void>.delayed(Duration.zero);
      }
      expect(tags.token, isNotNull);
      c.assistant.cancel();
      await request;
      late.complete(
        DanbooruSearchResult(
          tags: tagFixtureTags,
          source: tagFixtureRoot,
          query: '星璃 月光森林',
        ),
      );
      await Future<void>.delayed(Duration.zero);
      expect(tags.token!.isCancelled, true);
      expect(transport.round, 3);
      expect(c.prompt, 'synthetic base prompt');
      expect(c.assistant.session.turns.single.status, 'cancelled');
      expect(c.assistant.interaction, isNull);
    },
  );

  test(
    'tool freezes source and cannot enable a disabled NSFW filter',
    () async {
      final tags = FixtureTagClient();
      final c = WorkbenchController(tagSearchClient: tags);
      addTearDown(c.dispose);
      c.configureTagSearch(baseUrl: tagFixtureRoot, showNsfw: false);
      final tool = WorkspaceAgentTools(c)
          .build()
          .singleWhere((t) => t.name == 'search_danbooru');
      c.configureTagSearch(baseUrl: 'https://other.invalid', showNsfw: true);
      final plan = await tool.prepare({
        'query': 'moonlight',
        'show_nsfw': true,
      }, AgentCancellation());
      expect(plan.confirm, false);
      final result = await plan.execute();
      expect(tags.requests.single['baseUrl'], tagFixtureRoot);
      expect(result['show_nsfw'], false);
    },
  );
}

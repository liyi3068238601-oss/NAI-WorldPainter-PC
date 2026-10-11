import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:worldpainter_pc/prototype/workbench_controller.dart';
import 'package:worldpainter_pc/storage/sqlite_workspace_store.dart';

void main() {
  setUpAll(sqfliteFfiInit);

  group('WorkbenchController persistence', () {
    test(
      'restores draft, generated gallery, preferences and editor after reopen',
      () async {
        final directory = await _newEvidenceDirectory();
        addTearDown(() async {
          if (await directory.exists()) await directory.delete(recursive: true);
        });
        final databasePath = p.join(directory.path, 'workbench.sqlite');
        final firstStore = await _openStore(databasePath);
        addTearDown(firstStore.close);
        final first = WorkbenchController(
          generationDelay: Duration.zero,
          store: firstStore,
        );
        addTearDown(first.dispose);

        first
          ..updatePrompt('moonlit cedar forest, silver lake')
          ..updateNegative('text, watermark, blurry')
          ..updateModel('Fixture Model 4')
          ..updateProvider('Fixture Local Provider')
          ..setSize(1024, 768)
          ..updateSteps(37)
          ..updateCfg(6.75)
          ..updateSeed('20261011');
        await first.generate();

        final generated = first.results.first;
        expect(generated.id, 'demo-generated-1');
        first
          ..toggleFavorite(generated.id)
          ..updatePreferences(darkTheme: false, reduceMotion: true)
          ..updateEditor({
            'character': 'Aster',
            'characterEnabled': true,
            'position': 'B3',
            'brush': 24.0,
            'masks': {
              generated.id: [
                [
                  [0.1, 0.2],
                  [0.8, 0.7],
                ],
              ],
            },
            'redo': {
              generated.id: [
                [
                  [0.3, 0.4],
                ],
              ],
            },
          });
        await first.flush();
        await first.closeStorage();

        final reopenedStore = await _openStore(databasePath);
        addTearDown(reopenedStore.close);
        final stored = await reopenedStore.load();
        expect(stored, isNotNull);
        final restored = WorkbenchController(
          generationDelay: Duration.zero,
          store: reopenedStore,
          restored: stored,
        );
        addTearDown(restored.dispose);

        expect(restored.wasRestored, isTrue);
        expect(restored.prompt, 'moonlit cedar forest, silver lake');
        expect(restored.negative, 'text, watermark, blurry');
        expect(restored.model, 'Fixture Model 4');
        expect(restored.provider, 'Fixture Local Provider');
        expect(restored.width, 1024);
        expect(restored.height, 768);
        expect(restored.steps, 37);
        expect(restored.cfg, 6.75);
        expect(restored.seedText, '20261011');
        expect(restored.darkTheme, isFalse);
        expect(restored.reduceMotion, isTrue);
        expect(restored.selected.id, generated.id);
        expect(restored.selected.favorite, isTrue);
        expect(restored.selected.prompt, 'moonlit cedar forest, silver lake');
        expect(restored.selected.seed, 20261011);
        expect(restored.editor, {
          'character': 'Aster',
          'characterEnabled': true,
          'position': 'B3',
          'brush': 24.0,
          'masks': {
            generated.id: [
              [
                [0.1, 0.2],
                [0.8, 0.7],
              ],
            ],
          },
          'redo': {
            generated.id: [
              [
                [0.3, 0.4],
              ],
            ],
          },
        });

        await restored.generate();
        expect(restored.results.first.id, 'demo-generated-2');
        await restored.flush();
        final finalSnapshot = await reopenedStore.load();
        expect(finalSnapshot!.revision, greaterThan(stored!.revision));
        expect(
          (finalSnapshot.data['gallery']! as List).map(
            (item) => (item! as Map)['id'],
          ),
          containsAll(['demo-generated-1', 'demo-generated-2']),
        );
        await restored.closeStorage();
      },
    );

    test(
      'reports a failed save and retry commits the latest content',
      () async {
        final store = _ControllableWorkspaceStore()..failNextSave = true;
        final controller = WorkbenchController(store: store);
        addTearDown(controller.dispose);

        controller.updatePrompt('first attempted draft');
        await expectLater(controller.flush(), throwsA(isA<StateError>()));
        expect(controller.saveFailed, isTrue);
        expect(controller.saveStatus, '未保存 · 点击重试');
        expect(store.current, isNull);

        controller
          ..updatePrompt('latest draft after failure')
          ..updateSteps(19);
        await controller.flush(retry: true);

        expect(controller.saveFailed, isFalse);
        expect(controller.saveStatus, '已保存');
        final saved = store.current!.data;
        expect(
          (saved['draft']! as Map)['prompt'],
          'latest draft after failure',
        );
        expect((saved['draft']! as Map)['steps'], 19);
        await controller.closeStorage();
      },
    );

    test('rejects invalid updates without saving and preserves unknown preferences', () async {
      final seed = WorkbenchController();
      final snapshot = seed.exportWorkspace();
      seed.dispose();
      snapshot['preferences'] = {
        ...(snapshot['preferences']! as Map<String, Object?>),
        'futurePreference': {'enabled': true},
      };
      final store = _ControllableWorkspaceStore()..writeExternally(snapshot);
      final controller = WorkbenchController(
        store: store,
        restored: store.current,
      );
      addTearDown(controller.dispose);

      expect(
        () => controller.updateEditor({'character': 'Aster'}),
        throwsA(isA<FormatException>()),
      );
      expect(() => controller.updateSteps(0), throwsArgumentError);
      expect(() => controller.updateSteps(51), throwsArgumentError);
      expect(() => controller.updateCfg(0.5), throwsArgumentError);
      expect(() => controller.updateCfg(10.5), throwsArgumentError);
      expect(store.attempts, isEmpty);
      expect(controller.editor, isEmpty);
      expect(controller.steps, 28);
      expect(controller.cfg, 5.0);

      controller.updatePreferences(darkTheme: false);
      await controller.flush();
      expect(store.attempts, isNotEmpty);
      expect(
        store.attempts.map(
          (attempt) =>
              (attempt['preferences']!
                  as Map<String, Object?>)['futurePreference'],
        ),
        everyElement(equals({'enabled': true})),
      );
      await controller.closeStorage();
    });

    test('coalesces fast updates and persists a final revert during an in-flight save', () async {
      final store = _ControllableWorkspaceStore();
      final controller = WorkbenchController(store: store);
      addTearDown(controller.dispose);

      controller.updatePrompt('already saved');
      await controller.flush();
      final attemptStart = store.attempts.length;

      final inFlight = store.blockNextSave();
      controller.updatePrompt('in-flight intermediate');
      await inFlight.started.future;
      controller
        ..updatePrompt('quick edit one')
        ..updatePrompt('quick edit two')
        ..updatePrompt('already saved');
      inFlight.release.complete();
      await controller.flush();

      final writes = store.attempts.skip(attemptStart).toList();
      expect(writes, hasLength(2));
      expect(_draftPrompt(writes[0]), 'in-flight intermediate');
      expect(_draftPrompt(writes[1]), 'already saved');
      expect(_draftPrompt(store.current!.data), 'already saved');
      expect(store.current!.revision, 3);
      await controller.closeStorage();
    });

    test(
      'a revision conflict preserves the other writer and is surfaced',
      () async {
        final store = _ControllableWorkspaceStore();
        final controller = WorkbenchController(store: store);
        addTearDown(controller.dispose);

        controller.updatePrompt('shared baseline');
        await controller.flush();
        final external = _copy(store.current!.data);
        (external['draft']! as Map<String, Object?>)['prompt'] =
            'other window edit';
        store.writeExternally(external);

        controller.updatePrompt('local edit that must not overwrite');
        await expectLater(
          controller.flush(),
          throwsA(isA<WorkspaceConflictException>()),
        );

        expect(controller.saveFailed, isTrue);
        expect(controller.saveErrorMessage, contains('另一个窗口已修改'));
        expect(_draftPrompt(store.current!.data), 'other window edit');
        expect(store.current!.revision, 2);
        await store.close();
      },
    );
  });
}

Future<Directory> _newEvidenceDirectory() async {
  final root = Directory(
    p.join(Directory.current.path, '.tmp', 'workbench-persistence-tests'),
  );
  await root.create(recursive: true);
  return root.createTemp('close-reopen-');
}

Future<SQLiteWorkspaceStore> _openStore(String path) =>
    SQLiteWorkspaceStore.open(
      factory: databaseFactoryFfi,
      path: path,
      label: 'Workbench persistence test',
    );

String _draftPrompt(Map<String, Object?> snapshot) =>
    (snapshot['draft']! as Map<String, Object?>)['prompt']! as String;

Map<String, Object?> _copy(Map<String, Object?> value) =>
    Map<String, Object?>.from(jsonDecode(jsonEncode(value)) as Map);

class _BlockedSave {
  _BlockedSave() : started = Completer<void>(), release = Completer<void>();

  final Completer<void> started;
  final Completer<void> release;
}

class _ControllableWorkspaceStore implements WorkspaceStore {
  StoredWorkspace? _stored;
  _BlockedSave? _nextBlock;
  bool failNextSave = false;
  bool closed = false;
  final List<Map<String, Object?>> attempts = [];

  StoredWorkspace? get current => _stored == null
      ? null
      : StoredWorkspace(
          data: _copy(_stored!.data),
          revision: _stored!.revision,
        );

  @override
  String get label => 'Controllable test store';

  @override
  Future<StoredWorkspace?> load() async => current;

  _BlockedSave blockNextSave() {
    final block = _BlockedSave();
    _nextBlock = block;
    return block;
  }

  void writeExternally(Map<String, Object?> data) {
    final revision = (_stored?.revision ?? 0) + 1;
    _stored = StoredWorkspace(data: _copy(data), revision: revision);
  }

  @override
  Future<int> save(
    Map<String, Object?> data, {
    required int expectedRevision,
  }) async {
    if (closed) throw StateError('Store is closed.');
    final snapshot = _copy(data);
    attempts.add(snapshot);
    final block = _nextBlock;
    if (block != null) {
      _nextBlock = null;
      block.started.complete();
      await block.release.future;
    }
    if (failNextSave) {
      failNextSave = false;
      throw StateError('Injected save failure.');
    }
    final actualRevision = _stored?.revision ?? 0;
    if (expectedRevision != actualRevision) {
      throw WorkspaceConflictException(
        expectedRevision: expectedRevision,
        actualRevision: actualRevision,
      );
    }
    final nextRevision = actualRevision + 1;
    _stored = StoredWorkspace(data: snapshot, revision: nextRevision);
    return nextRevision;
  }

  @override
  Future<void> close() async {
    closed = true;
  }
}

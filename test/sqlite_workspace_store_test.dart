import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:worldpainter_pc/storage/sqlite_workspace_store.dart';

var _evidenceCounter = 0;

void main() {
  setUpAll(sqfliteFfiInit);

  group('SQLiteWorkspaceStore', () {
    test(
      'restores every root field and unknown fields after close and reopen',
      () async {
        final databasePath = await _newDatabasePath('完整快照 重开');
        final first = await _openStore(databasePath);
        addTearDown(first.close);

        expect(await first.load(), isNull);
        final data = _snapshot();
        expect(await first.save(data, expectedRevision: 0), 1);
        await first.close();

        final reopened = await _openStore(databasePath);
        addTearDown(reopened.close);
        final stored = await reopened.load();

        expect(stored, isNotNull);
        expect(stored!.revision, 1);
        expect(stored.data, equals(data));
        expect(stored.data['unknownRootField'], {
          'kept': true,
          'nested': ['原样', 7],
        });
      },
    );

    test('preserves gallery order and removes only deleted ids', () async {
      final databasePath = await _newDatabasePath('图库顺序 删除');
      final store = await _openStore(databasePath);
      addTearDown(store.close);

      final original = _snapshot(
        gallery: [
          _galleryItem('a', 'A'),
          _galleryItem('b', 'B'),
          _galleryItem('c', 'C'),
        ],
      );
      await store.save(original, expectedRevision: 0);

      final updated = _snapshot(
        gallery: [
          _galleryItem('c', 'C 改动', favorite: true),
          _galleryItem('a', 'A'),
        ],
        selectedId: 'c',
        draftPrompt: '更新后的草稿',
      );
      expect(await store.save(updated, expectedRevision: 1), 2);

      final loaded = await store.load();
      expect(loaded!.revision, 2);
      final gallery = loaded.data['gallery']! as List<Object?>;
      expect(gallery.map((value) => (value! as Map<String, Object?>)['id']), [
        'c',
        'a',
      ]);
      expect((gallery.first! as Map<String, Object?>)['title'], 'C 改动');
      expect(loaded.data['selectedId'], 'c');
      expect(
        (loaded.data['draft']! as Map<String, Object?>)['prompt'],
        '更新后的草稿',
      );
    });

    test('rolls back a mid-transaction SQLite constraint failure', () async {
      final databasePath = await _newDatabasePath('事务回滚 故障证据');
      final store = await _openStore(databasePath);
      addTearDown(store.close);

      final original = _snapshot(gallery: [_galleryItem('original', '原始项')]);
      await store.save(original, expectedRevision: 0);

      final rawDatabase = await _openRawDatabase(databasePath);
      addTearDown(() async {
        if (rawDatabase.isOpen) await rawDatabase.close();
      });
      await rawDatabase.execute('''
        CREATE TRIGGER fail_on_insert
        BEFORE INSERT ON gallery
        WHEN NEW.id = 'trigger-failure'
        BEGIN
          SELECT RAISE(ABORT, 'injected gallery constraint failure');
        END
      ''');
      await rawDatabase.close();

      final attempted = _snapshot(
        gallery: [_galleryItem('trigger-failure', '这次应回滚')],
        draftPrompt: '事务中间的新草稿',
      );
      await expectLater(
        store.save(attempted, expectedRevision: 1),
        throwsA(isA<DatabaseException>()),
      );

      final loaded = await store.load();
      expect(loaded!.revision, 1);
      expect(loaded.data, equals(original));
    });

    test('two independent connections use revision compare-and-swap', () async {
      final databasePath = await _newDatabasePath('双连接 CAS');
      final first = await _openStore(databasePath);
      addTearDown(first.close);
      final second = await _openStore(databasePath);
      addTearDown(second.close);

      Future<Object> trySave(
        SQLiteWorkspaceStore store,
        Map<String, Object?> data,
      ) async {
        try {
          return await store.save(data, expectedRevision: 0);
        } on Object catch (error) {
          return error;
        }
      }

      final results = await Future.wait([
        trySave(first, _snapshot(draftPrompt: '连接一')),
        trySave(second, _snapshot(draftPrompt: '连接二')),
      ]);
      expect(results.whereType<int>(), [1]);
      final conflict = results.whereType<WorkspaceConflictException>().single;
      expect(conflict.expectedRevision, 0);
      expect(conflict.actualRevision, 1);

      final stored = await first.load();
      expect(stored!.revision, 1);
      expect([
        '连接一',
        '连接二',
      ], contains((stored.data['draft']! as Map<String, Object?>)['prompt']));
    });

    test('rejects a future schema without changing its data', () async {
      final databasePath = await _newDatabasePath('未来Schema 保留原库');
      final store = await _openStore(databasePath);
      await store.save(_snapshot(), expectedRevision: 0);
      await store.close();

      final rawDatabase = await _openRawDatabase(databasePath);
      await rawDatabase.execute('PRAGMA user_version = 77');
      await rawDatabase.close();

      await expectLater(
        SQLiteWorkspaceStore.open(
          factory: databaseFactoryFfi,
          path: databasePath,
        ),
        throwsA(isA<WorkspaceFormatException>()),
      );

      final verificationDatabase = await _openRawDatabase(databasePath);
      addTearDown(() async {
        if (verificationDatabase.isOpen) await verificationDatabase.close();
      });
      final versionRows = await verificationDatabase.rawQuery(
        'PRAGMA user_version',
      );
      final metaRows = await verificationDatabase.query('meta');
      final draftRows = await verificationDatabase.query('draft');
      expect(versionRows.single['user_version'], 77);
      expect(metaRows.single['revision'], 1);
      expect(draftRows.single['payload'], contains('完整提示词'));
    });

    test('rejects malformed JSON payloads when loading', () async {
      final databasePath = await _newDatabasePath('坏JSON 拒绝');
      final store = await _openStore(databasePath);
      await store.save(_snapshot(), expectedRevision: 0);
      await store.close();

      final rawDatabase = await _openRawDatabase(databasePath);
      await rawDatabase.update(
        'draft',
        {'payload': '{broken json'},
        where: 'id = ?',
        whereArgs: const [1],
      );
      await rawDatabase.close();

      final reopened = await _openStore(databasePath);
      addTearDown(reopened.close);
      await expectLater(
        reopened.load(),
        throwsA(isA<WorkspaceFormatException>()),
      );
    });

    test('rejects unsupported root values and duplicate gallery ids', () async {
      final databasePath = await _newDatabasePath('输入校验 中文路径');
      final store = await _openStore(databasePath);
      addTearDown(store.close);

      final invalidValue = _snapshot()..['unknown'] = Object();
      await expectLater(
        store.save(invalidValue, expectedRevision: 0),
        throwsA(isA<WorkspaceFormatException>()),
      );
      final duplicateIds = _snapshot(
        gallery: [_galleryItem('same', '第一项'), _galleryItem('same', '第二项')],
      );
      await expectLater(
        store.save(duplicateIds, expectedRevision: 0),
        throwsA(isA<WorkspaceFormatException>()),
      );
      expect(await store.load(), isNull);
    });
  });
}

Future<String> _newDatabasePath(String testName) async {
  final uniqueName =
      '$testName ${DateTime.now().microsecondsSinceEpoch}-${_evidenceCounter++}';
  final evidenceDirectory = Directory(
    p.join(Directory.current.path, '.tmp', 'sqlite-tests', uniqueName),
  );
  await evidenceDirectory.create(recursive: true);
  return p.join(evidenceDirectory.path, '工作区 存储.sqlite');
}

Future<SQLiteWorkspaceStore> _openStore(String path) =>
    SQLiteWorkspaceStore.open(
      factory: databaseFactoryFfi,
      path: path,
      label: '测试 SQLite',
    );

Future<Database> _openRawDatabase(String path) => databaseFactoryFfi
    .openDatabase(path, options: OpenDatabaseOptions(singleInstance: false));

Map<String, Object?> _snapshot({
  List<Map<String, Object?>>? gallery,
  String selectedId = 'gallery-a',
  String draftPrompt = '完整提示词',
}) => {
  'draft': {
    'id': 'draft-main',
    'prompt': draftPrompt,
    'negative': '低质量, 水印',
    'model': 'NAI Diffusion 4.5 Full',
    'dimensions': {'width': 832, 'height': 1216},
  },
  'gallery': gallery ?? [_galleryItem('gallery-a', '月下远山')],
  'preferences': {
    'theme': 'dark',
    'language': 'zh-CN',
    'nested': {'preserved': true},
  },
  'editor': {
    'activeTool': 'brush',
    'zoom': 1.25,
    'selection': [1, 4, 7],
  },
  'selectedId': selectedId,
  'demoSequence': 42,
  'unknownRootField': {
    'kept': true,
    'nested': ['原样', 7],
  },
};

Map<String, Object?> _galleryItem(
  String id,
  String title, {
  bool favorite = false,
}) => {
  'id': id,
  'title': title,
  'favorite': favorite,
  'generation': {'prompt': '森林, 日落', 'seed': 123456},
};

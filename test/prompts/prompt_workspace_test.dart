import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:worldpainter_pc/prototype/workbench_controller.dart';
import 'package:worldpainter_pc/media/image_asset_maintenance.dart';
import 'package:worldpainter_pc/prompts/prompt_insertion.dart';
import 'package:worldpainter_pc/storage/sqlite_workspace_store.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  sqfliteFfiInit();

  test('saved style previews participate in asset reference protection', () {
    final c = WorkbenchController();
    final ref = 'sha256/ab/${'ab' * 32}.png';
    final style = c.promptLibrary.addStyle(
      name: '预览',
      prompt: 'fog',
      negative: '',
      category: '',
      previewAssetRef: ref,
    );
    expect(collectImageAssetReferences(c.exportWorkspace()), contains(ref));
    c.promptLibrary.deleteStyle(style.id);
    expect(
      collectImageAssetReferences(c.exportWorkspace()),
      isNot(contains(ref)),
    );
    c.dispose();
  });

  test('append preserves original weighted text and line breaks', () {
    expect(
      appendPromptText('  1.25::fog::\n云 ', '2::light::'),
      '  1.25::fog::\n云 , 2::light::',
    );
    expect(appendPromptText('fog, ', 'cloud'), 'fog,  cloud');
    expect(appendPromptText('fog\n', 'cloud'), 'fog\n cloud');
    expect(appendPromptText('fog', ''), 'fog');
    expect(appendPromptText('', '  cloud\n'), '  cloud\n');
  });

  test(
    'legacy workspace opens with empty library; malformed library is rejected',
    () {
      final initial = WorkbenchController();
      final old = initial.exportWorkspace()..remove('promptLibrary');
      initial.dispose();
      final restored = WorkbenchController(
        restored: StoredWorkspace(revision: 1, data: old),
      );
      expect(restored.promptLibrary.styles, isEmpty);
      restored.dispose();
      old['promptLibrary'] = {'schema': 99};
      expect(
        () => WorkbenchController(
          restored: StoredWorkspace(revision: 1, data: old),
        ),
        throwsFormatException,
      );
    },
  );

  test('library autosaves and survives SQLite reopen without changing generation settings', () async {
    final root = Directory(
      p.join(Directory.current.path, '.tmp', 'prompt-library-tests'),
    );
    await root.create(recursive: true);
    final dir = await root.createTemp('reopen-');
    final dbPath = p.join(dir.path, 'workspace.sqlite');
    var store = await SQLiteWorkspaceStore.open(
      factory: databaseFactoryFfi,
      path: dbPath,
    );
    var c = WorkbenchController(store: store);
    try {
      c.updatePrompt('1.2::moon::\n云');
      c.updateNegative('text');
      final before = Map.of(c.parameters.toJson())
        ..remove('prompt')
        ..remove('negative_prompt');
      c.promptLibrary.addGroup('常用');
      final style = c.promptLibrary.addStyle(
        name: '合成测试风格',
        prompt: 'soft lighting',
        negative: 'blur',
        category: '风景',
      );
      final artist = c.promptLibrary.addArtist(
        name: '合成测试画师',
        prompt: 'artist:fixture',
        categories: ['常用'],
        defaultWeight: 1.25,
      );
      c.appendPrompts(style.prompt, style.negative);
      await c.flush();
      final expected = jsonEncode(c.exportWorkspace()['promptLibrary']);
      await c.closeStorage();
      c.dispose();
      store = await SQLiteWorkspaceStore.open(
        factory: databaseFactoryFfi,
        path: dbPath,
      );
      c = WorkbenchController(store: store, restored: await store.load());
      expect(jsonEncode(c.exportWorkspace()['promptLibrary']), expected);
      expect(c.prompt, '1.2::moon::\n云, soft lighting');
      expect(c.negative, 'text, blur');
      final after = Map.of(c.parameters.toJson())
        ..remove('prompt')
        ..remove('negative_prompt');
      expect(after, before);
      expect(
        c.promptLibrary.composeArtistPrompt({artist.id: 1.25}),
        '1.25::artist:fixture::',
      );
      c.promptLibrary.renameGroup('常用', '风景');
      await c.flush();
      expect(c.promptLibrary.artists.single.categories, ['风景']);
      expect(c.promptLibrary.styles.single.id, style.id);
    } finally {
      await c.closeStorage();
      c.dispose();
      final resolved = await dir.resolveSymbolicLinks();
      if (!p.isWithin(await root.resolveSymbolicLinks(), resolved)) {
        throw StateError('Unsafe cleanup');
      }
      await Directory(resolved).delete(recursive: true);
    }
  });
}

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:worldpainter_pc/generation/generation_parameters.dart';
import 'package:worldpainter_pc/media/image_asset_store.dart';
import 'package:worldpainter_pc/metadata/image_metadata_parser.dart';
import 'package:worldpainter_pc/prototype/workbench_controller.dart';
import 'package:worldpainter_pc/references/vibe_library.dart';
import 'package:worldpainter_pc/storage/sqlite_workspace_store.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(sqfliteFfiInit);

  test('imported metadata survives SQLite reopen and repeated import enriches the same record', () async {
    final directory = await _newTestDirectory();
    addTearDown(() => _deleteTemporaryDirectorySafely(directory));
    final asset = ImageAsset(
      id: _digest('c'),
      assetRef: _assetRef('c'),
      width: 2,
      height: 2,
      mime: 'image/png',
      sha256: _digest('c'),
      byteLength: 3,
    );
    final firstStore = await _openSqliteWorkspace(directory);
    final first = WorkbenchController(store: firstStore);
    first.addImported(asset, title: '元数据往返');
    first.toggleFavorite(first.selected.id);
    final importedAt = first.selected.createdAt;
    first.addImported(
      asset,
      metadata: ImageMetadataResult(
        fields: {
          'prompt': '合成测试提示词',
          'negative_prompt': '',
          'seed': 0,
          'steps': 32,
          'width': 832,
          'height': 1216,
          'characters': <Object?>[],
        },
      ),
    );
    expect(first.results.where((r) => r.isImported), hasLength(1));
    expect(first.selected.favorite, isTrue);
    expect(first.selected.title, '元数据往返');
    expect(first.selected.createdAt, importedAt);
    await first.closeStorage();
    first.dispose();

    final secondStore = await _openSqliteWorkspace(directory);
    final second = WorkbenchController(
      store: secondStore,
      restored: await secondStore.load(),
    );
    addTearDown(() async {
      if (!second.closing) await second.closeStorage();
      second.dispose();
    });
    final imported = second.selected;
    expect(imported.isImported, isTrue);
    expect(imported.width, 2);
    expect(imported.importedMetadata!.fields['width'], 832);
    expect(imported.seedDescription, '原图 Seed：0');
    second.updateCfg(7.2);
    second.updateSeed('9876');
    second.applyResult(imported);
    expect(second.prompt, '合成测试提示词');
    expect(second.negative, '');
    expect(second.seedText, '0');
    expect(second.steps, 32);
    expect(second.width, 832);
    expect(second.cfg, 7.2);
    expect(second.parameters.characters, isEmpty);
    await second.closeStorage();
  });

  test(
    'removeGalleryRecords persists empty index and selection, keeping bytes',
    () async {
      final directory = await _newTestDirectory();
      addTearDown(() => _deleteTemporaryDirectorySafely(directory));
      final assetRef = _assetRef('a');
      var assets = _MemoryImageAssets(<String, Uint8List>{
        assetRef: Uint8List.fromList(<int>[1, 2, 3]),
      });
      var workspace = await _openSqliteWorkspace(directory);
      var controller = WorkbenchController(store: workspace, assets: assets);
      addTearDown(() async {
        if (!controller.closing) await controller.closeStorage();
        controller.dispose();
      });

      controller.addImported(
        ImageAsset(
          id: _digest('a'),
          assetRef: assetRef,
          width: 2,
          height: 2,
          mime: 'image/png',
          sha256: _digest('a'),
          byteLength: 3,
        ),
        title: '导入图',
      );
      await controller.flush();
      final ids = controller.results.map((result) => result.id).toSet();
      expect(ids, isNotEmpty);

      await controller.removeGalleryRecords(ids);

      expect(controller.results, isEmpty);
      expect(controller.exportWorkspace()['selectedId'], '');
      expect(assets.removedRefs, isEmpty);
      expect(await assets.listAssets(), <String>[assetRef]);
      await controller.closeStorage();
      controller.dispose();

      assets = _MemoryImageAssets(<String, Uint8List>{
        assetRef: Uint8List.fromList(<int>[1, 2, 3]),
      });
      workspace = await _openSqliteWorkspace(directory);
      controller = WorkbenchController(
        store: workspace,
        assets: assets,
        restored: await workspace.load(),
      );
      addTearDown(() async {
        if (!controller.closing) await controller.closeStorage();
        controller.dispose();
      });

      expect(controller.results, isEmpty);
      expect(controller.selected.id, WorkbenchController.emptySelection.id);
      expect(controller.exportWorkspace()['selectedId'], '');
      expect(assets.removedRefs, isEmpty);
      expect(await assets.listAssets(), <String>[assetRef]);
      await controller.closeStorage();
    },
  );

  test('cleanup protects draft, editing parent/candidate, and serialized Vibe sources', () async {
    final refs = _LifecycleRefs();
    final assets = _MemoryImageAssets({
      for (final ref in refs.all) ref: Uint8List.fromList(<int>[1, 2, 3]),
      refs.unused: Uint8List.fromList(<int>[4, 5, 6]),
    });
    final workspace = _MemoryWorkspaceStore();
    final snapshot = _lifecycleSnapshot(refs);
    workspace.seed(snapshot);
    final controller = WorkbenchController(
      store: workspace,
      assets: assets,
      restored: await workspace.load(),
    );
    addTearDown(() async {
      if (!controller.closing) await controller.closeStorage();
      controller.dispose();
    });

    final found = collectImageAssetReferences(controller.exportWorkspace());
    expect(
      found,
      containsAll(<String>{
        refs.draftSource,
        refs.draftVibe,
        refs.candidate,
        refs.parent,
        refs.composite,
        refs.layer,
        refs.vibeLibrary,
        refs.gallery,
      }),
    );

    final removedCount = await controller.cleanUnusedAssets(<String>{
      ...refs.all,
      refs.unused,
    });

    expect(removedCount, 1);
    expect(assets.removedRefs, <String>[refs.unused]);
    expect(await assets.listAssets(), unorderedEquals(refs.all));
    await controller.closeStorage();
  });

  test(
    'maintainAssets runs a read-only audit and blocks overlapping edits',
    () async {
      final refs = _LifecycleRefs();
      final assets = _MemoryImageAssets({
        for (final ref in refs.all) ref: Uint8List.fromList(<int>[1, 2, 3]),
        refs.unused: Uint8List.fromList(<int>[4, 5, 6]),
      });
      final workspace = _MemoryWorkspaceStore()..seed(_lifecycleSnapshot(refs));
      final controller = WorkbenchController(
        store: workspace,
        assets: assets,
        restored: await workspace.load(),
      );
      addTearDown(() async {
        if (!controller.closing) await controller.closeStorage();
        controller.dispose();
      });

      final audit = await controller.maintainAssets(() async {
        expect(controller.maintainingAssets, isTrue);
        await expectLater(
          controller.prepareEditing(() async => null),
          throwsA(isA<FormatException>()),
        );
        return auditImageAssets(
          snapshot: controller.exportWorkspace(),
          store: assets,
        );
      });

      expect(audit.unusedAssets, <String>{refs.unused});
      expect(assets.removedRefs, isEmpty);
      expect(await assets.listAssets(), hasLength(refs.all.length + 1));
      expect(controller.maintainingAssets, isFalse);
      await controller.closeStorage();
    },
  );

  test('cleanup rechecks references before each approved removal', () async {
    final refs = _LifecycleRefs();
    final newlyReferenced = _assetRef('b');
    final assets = _MemoryImageAssets({
      for (final ref in refs.all) ref: Uint8List.fromList(<int>[1, 2, 3]),
      refs.unused: Uint8List.fromList(<int>[4, 5, 6]),
      newlyReferenced: Uint8List.fromList(<int>[7, 8, 9]),
    });
    final workspace = _MemoryWorkspaceStore()..seed(_lifecycleSnapshot(refs));
    final controller = WorkbenchController(
      store: workspace,
      assets: assets,
      restored: await workspace.load(),
    );
    addTearDown(() async {
      if (!controller.closing) await controller.closeStorage();
      controller.dispose();
    });
    assets.onRemove = (removedRef) {
      if (removedRef == refs.unused) {
        controller.vibeLibrary.addPreEncodedEntry(
          id: 'new-reference-during-cleanup',
          title: '并发新增的引用',
          encodedBytes: Uint8List.fromList(<int>[65, 66, 67]),
          sourceAssetRef: newlyReferenced,
          sourceSha256: _assetDigestFromRef(newlyReferenced),
          model: 'fixture-model',
          providerProtocol: 'official',
          endpoint: Uri.parse('https://example.test/'),
          informationExtracted: 0.5,
        );
      }
    };

    final removedCount = await controller.cleanUnusedAssets(<String>{
      refs.unused,
      newlyReferenced,
    });
    await controller.flush();

    expect(removedCount, 1);
    expect(assets.removedRefs, <String>[refs.unused]);
    expect(await assets.listAssets(), contains(newlyReferenced));
    expect(
      collectImageAssetReferences(controller.exportWorkspace()),
      contains(newlyReferenced),
    );
    await controller.closeStorage();
  });

  test('save failure prevents approved asset removal', () async {
    final refs = _LifecycleRefs();
    final assets = _MemoryImageAssets({
      for (final ref in refs.all) ref: Uint8List.fromList(<int>[1, 2, 3]),
      refs.unused: Uint8List.fromList(<int>[4, 5, 6]),
    });
    final workspace = _MemoryWorkspaceStore(
      initial: StoredWorkspace(data: _lifecycleSnapshot(refs), revision: 1),
      failSaves: true,
    );
    final controller = WorkbenchController(
      store: workspace,
      assets: assets,
      restored: await workspace.load(),
    );
    addTearDown(() async {
      controller.dispose();
      await assets.close();
      await workspace.close();
    });

    controller.updatePrompt('需要保存但失败的草稿');
    await expectLater(controller.flush(), throwsA(isA<StateError>()));
    expect(controller.saveFailed, isTrue);

    await expectLater(
      controller.cleanUnusedAssets(<String>{refs.unused}),
      throwsA(isA<StateError>()),
    );
    expect(assets.removedRefs, isEmpty);
    expect(await assets.listAssets(), hasLength(refs.all.length + 1));
    expect(workspace.saveAttempts, greaterThanOrEqualTo(1));
  });

  test(
    'pending prepareEditing prevents maintenance until it settles',
    () async {
      final refs = _LifecycleRefs();
      final assets = _MemoryImageAssets({
        for (final ref in refs.all) ref: Uint8List.fromList(<int>[1, 2, 3]),
        refs.unused: Uint8List.fromList(<int>[4, 5, 6]),
      });
      final workspace = _MemoryWorkspaceStore()..seed(_lifecycleSnapshot(refs));
      final controller = WorkbenchController(
        store: workspace,
        assets: assets,
        restored: await workspace.load(),
      );
      addTearDown(() async {
        if (!controller.closing) await controller.closeStorage();
        controller.dispose();
      });

      final entered = Completer<void>();
      final release = Completer<void>();
      final pendingEdit = controller.prepareEditing(() async {
        entered.complete();
        await release.future;
      });
      await entered.future;

      expect(controller.canMaintainAssets, isFalse);
      try {
        await expectLater(
          controller.cleanUnusedAssets(<String>{refs.unused}),
          throwsA(isA<FormatException>()),
        );
        expect(assets.removedRefs, isEmpty);
      } finally {
        release.complete();
      }
      await pendingEdit;
      expect(controller.canMaintainAssets, isTrue);
      expect(await controller.cleanUnusedAssets(<String>{refs.unused}), 1);
      expect(assets.removedRefs, <String>[refs.unused]);
      await controller.closeStorage();
    },
  );

  test('applyMetadata preserves currently known values for absent fields', () {
    final controller = WorkbenchController();
    addTearDown(controller.dispose);
    controller
      ..updatePrompt('当前提示词')
      ..updateNegative('当前负面词')
      ..setSize(768, 1024)
      ..updateSteps(37)
      ..updateCfg(6.4)
      ..updateSeed('12345');
    final metadata = ImageMetadataResult(
      fields: <String, dynamic>{'prompt': '导入提示词', 'width': 512},
      format: 'PNG',
      source: 'fixture',
    );

    controller.applyMetadata(
      metadata,
      selectedFields: <String>{
        'prompt',
        'negative_prompt',
        'width',
        'height',
        'steps',
        'scale',
        'seed',
      },
    );

    expect(controller.prompt, '导入提示词');
    expect(controller.negative, '当前负面词');
    expect(controller.width, 512);
    expect(controller.height, 1024);
    expect(controller.steps, 37);
    expect(controller.cfg, 6.4);
    expect(controller.seedText, '12345');
  });
}

class _LifecycleRefs {
  final draftSource = _assetRef('1');
  final draftVibe = _assetRef('2');
  final candidate = _assetRef('3');
  final parent = _assetRef('4');
  final composite = _assetRef('5');
  final layer = _assetRef('6');
  final vibeLibrary = _assetRef('7');
  final gallery = _assetRef('9');
  final unused = _assetRef('a');

  Set<String> get all => <String>{
    draftSource,
    draftVibe,
    candidate,
    parent,
    composite,
    layer,
    vibeLibrary,
    gallery,
  };
}

Map<String, Object?> _lifecycleSnapshot(_LifecycleRefs refs) {
  final demo = WorkbenchController();
  final snapshot = demo.exportWorkspace();
  demo.dispose();

  final draft = Map<String, Object?>.from(snapshot['draft']! as Map);
  final parameters = GenerationParameters.fromJson(
    Map<String, dynamic>.from(draft['generation']! as Map),
  );
  draft['generation'] = parameters
      .copyWith(
        img2imgSourceImageId: refs.draftSource,
        vibeReferences: <VibeReference>[VibeReference(assetId: refs.draftVibe)],
      )
      .toJson();
  snapshot['draft'] = draft;

  final vibeLibrary = VibeLibrary();
  vibeLibrary.addPreEncodedEntry(
    id: 'fixture-vibe',
    title: '测试 Vibe',
    encodedBytes: Uint8List.fromList(<int>[1, 2, 3]),
    sourceAssetRef: refs.vibeLibrary,
    sourceSha256: _assetDigestFromRef(refs.vibeLibrary),
    model: 'fixture-model',
    providerProtocol: 'fixture-provider',
    endpoint: Uri.parse('https://example.test/'),
    informationExtracted: 0.5,
  );
  snapshot['vibeLibrary'] = vibeLibrary.toJson();

  snapshot['gallery'] = <Map<String, Object?>>[
    _scene(
      'gallery-record',
      assetRef: refs.gallery,
      editMetadata: <String, Object?>{
        'operation': 'derived',
        'parentAssetRef': refs.parent,
      },
    ).toJson(),
  ];
  snapshot['selectedId'] = 'gallery-record';
  snapshot['imageEditing'] = <String, Object?>{
    'version': 1,
    'parentAssetRef': refs.parent,
    'candidates': <Map<String, Object?>>[
      <String, Object?>{
        'raw': _scene('editing-candidate', assetRef: refs.candidate).toJson(),
        'rect': <double>[0, 0, 1, 1],
        'compositeRef': refs.composite,
        'layerRef': refs.layer,
      },
    ],
  };
  return snapshot;
}

SceneResult _scene(
  String id, {
  String? assetRef,
  Map<String, Object?>? editMetadata,
}) => SceneResult(
  id: id,
  title: '生命周期测试',
  prompt: 'fixture prompt',
  negative: 'fixture negative',
  width: 832,
  height: 1216,
  seed: 123,
  variant: 0,
  favorite: false,
  isDemo: false,
  assetRef: assetRef,
  editMetadata: editMetadata,
);

String _assetRef(String digit) {
  final digest = _digest(digit);
  return 'sha256/${digest.substring(0, 2)}/$digest.png';
}

String _digest(String digit) => List<String>.filled(64, digit).join();

String _assetDigestFromRef(String assetRef) =>
    assetRef.split('/').last.split('.').first;

Future<Directory> _newTestDirectory() async {
  final root = Directory(
    p.join(Directory.current.path, '.tmp', 'gallery-lifecycle-tests'),
  );
  await root.create(recursive: true);
  return root.createTemp('workspace-');
}

Future<void> _deleteTemporaryDirectorySafely(Directory target) async {
  if (!await target.exists()) return;
  final root = Directory(
    p.join(Directory.current.path, '.tmp', 'gallery-lifecycle-tests'),
  );
  final canonicalRoot = p.normalize(await root.resolveSymbolicLinks());
  final canonicalTarget = p.normalize(await target.resolveSymbolicLinks());
  if (p.equals(canonicalRoot, canonicalTarget) ||
      !p.isWithin(canonicalRoot, canonicalTarget)) {
    throw StateError(
      'Refusing to remove a path outside the gallery test root.',
    );
  }
  await Directory(canonicalTarget).delete(recursive: true);
}

Future<SQLiteWorkspaceStore> _openSqliteWorkspace(Directory directory) =>
    SQLiteWorkspaceStore.open(
      factory: databaseFactoryFfi,
      path: p.join(directory.path, '工作区.sqlite'),
      label: '图库生命周期测试',
    );

class _MemoryWorkspaceStore implements WorkspaceStore {
  _MemoryWorkspaceStore({this.initial, this.failSaves = false});

  StoredWorkspace? initial;
  final bool failSaves;
  int saveAttempts = 0;
  bool closed = false;

  void seed(Map<String, Object?> data) {
    initial = StoredWorkspace(
      data: _clone(data),
      revision: initial?.revision ?? 1,
    );
  }

  @override
  String get label => 'Lifecycle fake workspace store';

  @override
  Future<StoredWorkspace?> load() async => initial == null
      ? null
      : StoredWorkspace(
          data: _clone(initial!.data),
          revision: initial!.revision,
        );

  @override
  Future<int> save(
    Map<String, Object?> data, {
    required int expectedRevision,
  }) async {
    saveAttempts++;
    if (failSaves) throw StateError('injected workspace save failure');
    final revision = expectedRevision + 1;
    initial = StoredWorkspace(data: _clone(data), revision: revision);
    return revision;
  }

  @override
  Future<void> close() async {
    closed = true;
  }
}

class _MemoryImageAssets implements ImageAssetStore, ImageAssetMaintenance {
  _MemoryImageAssets(Map<String, Uint8List> initial)
    : _assets = <String, Uint8List>{
        for (final entry in initial.entries)
          entry.key: Uint8List.fromList(entry.value),
      };

  final Map<String, Uint8List> _assets;
  final List<String> removedRefs = <String>[];
  void Function(String assetRef)? onRemove;
  bool closed = false;

  @override
  String get label => 'Lifecycle fake image assets';

  @override
  Future<ImageAsset> save(Uint8List bytes) =>
      throw UnsupportedError('save is not used by this lifecycle fixture');

  @override
  Future<Uint8List> read(String assetRef) async {
    final bytes = _assets[assetRef];
    if (bytes == null) throw ImageAssetNotFoundException(assetRef);
    return Uint8List.fromList(bytes);
  }

  @override
  Future<List<String>> listAssets() async => _assets.keys.toList()..sort();

  @override
  Future<void> removeAsset(String assetRef) async {
    if (_assets.remove(assetRef) != null) {
      removedRefs.add(assetRef);
      onRemove?.call(assetRef);
    }
  }

  @override
  Future<void> close() async {
    closed = true;
  }
}

Map<String, Object?> _clone(Map<String, Object?> value) =>
    Map<String, Object?>.from(jsonDecode(jsonEncode(value)) as Map);

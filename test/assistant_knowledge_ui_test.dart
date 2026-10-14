import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:worldpainter_pc/assistant/prompt_memory.dart';
import 'package:worldpainter_pc/main.dart';
import 'package:worldpainter_pc/prototype/workbench_controller.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() async {
    await (FontLoader(
      'NotoSansSC',
    )..addFont(rootBundle.load('assets/fonts/NotoSansSC.ttf'))).load();
    await (FontLoader(
      'MaterialIcons',
    )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
  });

  testWidgets(
    'desktop memory management edits and replaces a pending candidate safely',
    (tester) async {
      _setViewport(tester, const Size(1440, 900), 1);
      final fixture = _conflictFixture(DateTime.now());
      final boundary = GlobalKey();
      await _openMemoryManager(tester, fixture.controller, boundary);

      final library = fixture.controller.assistant.state.memories;
      final revisionBeforeSearch = library.revision;
      await tester.enterText(
        find.byKey(const ValueKey('assistant-memory-search')),
        '星璃',
      );
      await tester.pumpAndSettle();
      expect(library.revision, revisionBeforeSearch);
      expect(_entry(library, fixture.previous.id).hitCount, 0);
      expect(_entry(library, fixture.pending.id).hitCount, 0);
      await _capture(tester, boundary, 'desktop-search.png');

      await tester.enterText(
        find.byKey(const ValueKey('assistant-memory-search')),
        '',
      );
      await tester.tap(
        find.byKey(const ValueKey('assistant-memory-tab-pending')),
      );
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(
          ValueKey('assistant-memory-edit-approve-${fixture.pending.id}'),
        ),
      );
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('assistant-memory-trigger')),
        '星璃',
      );
      await tester.enterText(
        find.byKey(const ValueKey('assistant-memory-content')),
        '新正式设定：银蓝发与星芒披风。',
      );
      await tester.tap(
        find.byKey(const ValueKey('assistant-memory-save-pending')),
      );
      // Review keeps an indeterminate busy bar visible while the conflict
      // choice is open, so wait for the route transition without settling.
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 350));

      expect(find.text('发现相同触发词'), findsOneWidget);
      expect(find.textContaining('旧正式设定：银发与星芒徽记。'), findsOneWidget);
      expect(find.text('新正式设定：银蓝发与星芒披风。'), findsOneWidget);
      await _capture(tester, boundary, 'desktop-conflict.png');
      await tester.tap(
        find.byKey(const ValueKey('assistant-memory-conflict-replace')),
      );
      await tester.pumpAndSettle();

      final previous = _entry(library, fixture.previous.id);
      final approved = _entry(library, fixture.pending.id);
      expect(previous.supersededBy, fixture.pending.id);
      expect(previous.isRetrievable, isFalse);
      expect(approved.id, fixture.pending.id);
      expect(approved.source, MemorySource.llmCandidate);
      expect(approved.isRetrievable, isTrue);
      expect(approved.content, '新正式设定：银蓝发与星芒披风。');

      await tester.tap(find.byKey(const ValueKey('assistant-memory-tab-all')));
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(ValueKey('assistant-memory-delete-${fixture.pending.id}')),
      );
      await tester.pumpAndSettle();
      expect(find.text('删除记忆'), findsOneWidget);
      final deletePreview = find.byType(AlertDialog).last;
      expect(
        find.descendant(
          of: deletePreview,
          matching: find.textContaining('旧正式设定：银发与星芒徽记。'),
        ),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: deletePreview,
          matching: find.textContaining('旧归档记录'),
        ),
        findsOneWidget,
      );
      await _capture(tester, boundary, 'desktop-delete-history-preview.png');

      final revisionBeforeCancel = library.revision;
      await tester.tap(find.text('取消'));
      await tester.pumpAndSettle();
      expect(library.revision, revisionBeforeCancel);
      expect(
        library.entries.map((entry) => entry.id),
        containsAll([fixture.previous.id, fixture.pending.id]),
      );
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'stale cleanup lists only selected old active memories and previews before deletion',
    (tester) async {
      _setViewport(tester, const Size(1440, 900), 1);
      final now = DateTime.now();
      final fixture = _staleFixture(now);
      final boundary = GlobalKey();
      await _openMemoryManager(tester, fixture.controller, boundary);
      final library = fixture.controller.assistant.state.memories;

      await tester.tap(
        find.byKey(const ValueKey('assistant-memory-tab-stale')),
      );
      await tester.pumpAndSettle();
      expect(find.text('长期未用记忆'), findsOneWidget);
      expect(find.text('刚建立记忆'), findsNothing);
      expect(find.text('待审核旧记忆'), findsNothing);
      expect(find.text('已命中过的旧记忆'), findsNothing);
      await _capture(tester, boundary, 'desktop-stale-list.png');

      await tester.tap(find.text('选择清理项'));
      await tester.pumpAndSettle();
      final previewButton = find.widgetWithText(FilledButton, '预览清理 (0)');
      expect(tester.widget<FilledButton>(previewButton).onPressed, isNull);

      final staleCard = find.ancestor(
        of: find.text('长期未用记忆'),
        matching: find.byType(Card),
      );
      await tester.tap(
        find.descendant(of: staleCard, matching: find.byType(Checkbox)),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('预览清理 (1)'));
      await tester.pumpAndSettle();
      expect(find.text('长期未命中清理预览'), findsOneWidget);
      expect(find.textContaining('长期未用记忆'), findsWidgets);
      expect(find.textContaining('刚建立记忆'), findsNothing);
      expect(find.textContaining('待审核旧记忆'), findsNothing);
      await _capture(tester, boundary, 'desktop-stale-delete-preview.png');

      final revisionBeforeCancel = library.revision;
      await tester.tap(find.text('返回修改选择'));
      await tester.pumpAndSettle();
      expect(library.revision, revisionBeforeCancel);
      expect(
        library.entries.map((entry) => entry.id),
        containsAll([
          fixture.stale.id,
          fixture.recent.id,
          fixture.pending.id,
          fixture.used.id,
        ]),
      );

      await tester.tap(find.text('预览清理 (1)'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('确认删除选中记忆'));
      await tester.pumpAndSettle();
      expect(
        library.entries.map((entry) => entry.id),
        isNot(contains(fixture.stale.id)),
      );
      expect(
        library.entries.map((entry) => entry.id),
        containsAll([fixture.recent.id, fixture.pending.id, fixture.used.id]),
      );
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'compact high DPI memory editor and long conflict content stay scrollable',
    (tester) async {
      _setViewport(tester, const Size(1280, 960), 2);
      final fixture = _conflictFixture(DateTime.now(), longContent: true);
      final boundary = GlobalKey();
      await _openMemoryManager(
        tester,
        fixture.controller,
        boundary,
        compact: true,
      );
      await _capture(tester, boundary, 'compact-memory-list.png');

      await tester.tap(
        find.byKey(
          ValueKey('assistant-memory-edit-approve-${fixture.pending.id}'),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('编辑候选并采纳'), findsOneWidget);
      expect(find.byType(SingleChildScrollView), findsWidgets);
      await _capture(tester, boundary, 'compact-memory-editor.png');

      await tester.enterText(
        find.byKey(const ValueKey('assistant-memory-trigger')),
        '星璃',
      );
      await tester.enterText(
        find.byKey(const ValueKey('assistant-memory-content')),
        List.filled(80, '新版本长内容片段。').join(),
      );
      await tester.tap(
        find.byKey(const ValueKey('assistant-memory-save-pending')),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 350));
      expect(find.text('发现相同触发词'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('assistant-memory-conflict-replace')),
        findsOneWidget,
      );
      expect(find.byType(Scrollable), findsWidgets);
      await _capture(tester, boundary, 'compact-memory-conflict.png');
      expect(tester.takeException(), isNull);

      await tester.tap(
        find.byKey(const ValueKey('assistant-memory-conflict-replace')),
      );
      await tester.pumpAndSettle();
      expect(
        _entry(
          fixture.controller.assistant.state.memories,
          fixture.pending.id,
        ).isRetrievable,
        isTrue,
      );
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );
}

class _ConflictFixture {
  const _ConflictFixture({
    required this.controller,
    required this.previous,
    required this.pending,
  });

  final WorkbenchController controller;
  final MemoryEntry previous;
  final MemoryEntry pending;
}

_ConflictFixture _conflictFixture(DateTime now, {bool longContent = false}) {
  final controller = WorkbenchController();
  final library = controller.assistant.state.memories;
  final previous = library.save(
    trigger: '星璃',
    content: longContent
        ? List.filled(80, '旧正式设定长内容片段。').join()
        : '旧正式设定：银发与星芒徽记。',
    kind: MemoryKind.characterFeature,
    source: MemorySource.manual,
    now: now.subtract(const Duration(days: 160)),
  );
  final pending = library.save(
    trigger: '星璃',
    content: '待审核版本：银发与星芒披风。',
    kind: MemoryKind.characterFeature,
    source: MemorySource.pendingLlmCandidate,
    now: now.subtract(const Duration(days: 2)),
  );
  return _ConflictFixture(
    controller: controller,
    previous: previous,
    pending: pending,
  );
}

class _StaleFixture {
  const _StaleFixture({
    required this.controller,
    required this.stale,
    required this.recent,
    required this.pending,
    required this.used,
  });

  final WorkbenchController controller;
  final MemoryEntry stale;
  final MemoryEntry recent;
  final MemoryEntry pending;
  final MemoryEntry used;
}

_StaleFixture _staleFixture(DateTime now) {
  final controller = WorkbenchController();
  final library = controller.assistant.state.memories;
  final stale = library.save(
    trigger: '长期未用记忆',
    content: '这是一条已超过九十天且从未命中的正式记忆。',
    kind: MemoryKind.fact,
    source: MemorySource.manual,
    now: now.subtract(const Duration(days: 120)),
  );
  final recent = library.save(
    trigger: '刚建立记忆',
    content: '新建的未命中记忆不应立即进入清理列表。',
    kind: MemoryKind.preference,
    source: MemorySource.manual,
    now: now,
  );
  final pending = library.save(
    trigger: '待审核旧记忆',
    content: '待审核候选不属于长期未命中正式记忆。',
    kind: MemoryKind.fact,
    source: MemorySource.pendingLlmCandidate,
    now: now.subtract(const Duration(days: 150)),
  );
  final used = library.save(
    trigger: '已命中过的旧记忆',
    content: '有命中历史的旧正式记忆不应进入清理列表。',
    kind: MemoryKind.observation,
    source: MemorySource.manual,
    now: now.subtract(const Duration(days: 150)),
  );
  library.retrieve('已命中过的旧记忆', now: now);
  return _StaleFixture(
    controller: controller,
    stale: stale,
    recent: recent,
    pending: pending,
    used: used,
  );
}

MemoryEntry _entry(PromptMemoryLibrary library, String id) =>
    library.entries.singleWhere((entry) => entry.id == id);

void _setViewport(WidgetTester tester, Size physicalSize, double dpr) {
  tester.view.physicalSize = physicalSize;
  tester.view.devicePixelRatio = dpr;
  addTearDown(() {
    tester.view.resetPhysicalSize();
    tester.view.resetDevicePixelRatio();
  });
}

Future<void> _openMemoryManager(
  WidgetTester tester,
  WorkbenchController controller,
  GlobalKey boundary, {
  bool compact = false,
}) async {
  await tester.pumpWidget(
    RepaintBoundary(
      key: boundary,
      child: WorldPainterApp(controller: controller),
    ),
  );
  await tester.pumpAndSettle();
  if (compact) {
    await tester.tap(find.byIcon(Icons.menu_rounded).first);
    await tester.pumpAndSettle();
  }
  await tester.tap(find.text('AI 助手').first);
  await tester.pumpAndSettle();
  final memoriesButton = find.byKey(const ValueKey('assistant-memories'));
  await tester.ensureVisible(memoriesButton);
  await tester.tap(memoriesButton);
  await tester.pumpAndSettle();
  expect(find.byKey(const ValueKey('assistant-memory-dialog')), findsOneWidget);
}

Future<void> _capture(
  WidgetTester tester,
  GlobalKey boundary,
  String name,
) async {
  await tester.runAsync(() async {
    final image =
        await (boundary.currentContext!.findRenderObject()!
                as RenderRepaintBoundary)
            .toImage(pixelRatio: tester.view.devicePixelRatio);
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    image.dispose();
    final output = File('.tmp/assistant-knowledge-ui/$name');
    await output.parent.create(recursive: true);
    await output.writeAsBytes(bytes!.buffer.asUint8List());
  });
}

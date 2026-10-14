import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:worldpainter_pc/assistant/assistant_mobile_resources.dart';
import 'package:worldpainter_pc/prototype/assistant_panel.dart';
import 'package:worldpainter_pc/prototype/assistant_preferences_dialog.dart';
import 'package:worldpainter_pc/prototype/workbench_controller.dart';
import 'package:worldpainter_pc/storage/workspace_store.dart';

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

  testWidgets('assistant settings exposes the mobile resources entry', (
    tester,
  ) async {
    _setViewport(tester, const Size(1440, 900), 1);
    final controller = WorkbenchController();
    await tester.pumpWidget(
      MaterialApp(
        theme: ThemeData(fontFamily: 'NotoSansSC'),
        home: Scaffold(body: AssistantPanel(workbench: controller)),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('assistant-settings')));
    await tester.pumpAndSettle();

    expect(
      find.byKey(const ValueKey('assistant-style-knowledge-settings')),
      findsOneWidget,
    );
    expect(find.text('画风偏好与手机端资料'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('saves separate V4.5 and V5 defaults to the workspace', (
    tester,
  ) async {
    final store = _MemoryWorkspaceStore();
    final controller = WorkbenchController(store: store);
    await _openDialog(
      tester,
      controller,
      loadResources: () async => _snapshot(),
    );

    await tester.enterText(
      find.byKey(const ValueKey('assistant-style-words-v45')),
      'synthetic-v45-default',
    );
    await tester.enterText(
      find.byKey(const ValueKey('assistant-style-words-v5')),
      'synthetic-v5-default',
    );
    await tester.tap(find.byKey(const ValueKey('assistant-preferences-save')));
    await tester.pumpAndSettle();

    expect(
      controller.assistant.state.preferences.v45StyleWords,
      'synthetic-v45-default',
    );
    expect(
      controller.assistant.state.preferences.v5StyleWords,
      'synthetic-v5-default',
    );
    final preferences = _storedAssistant(store)['preferences'] as Map;
    expect(preferences['v45StyleWords'], 'synthetic-v45-default');
    expect(preferences['v5StyleWords'], 'synthetic-v5-default');
    expect(find.text('画风偏好已保存到本地工作区。'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('shows only mobile source metadata and load status', (
    tester,
  ) async {
    final controller = WorkbenchController();
    final boundary = GlobalKey();
    await _openDialog(
      tester,
      controller,
      loadResources: () async => _snapshot(),
      boundary: boundary,
    );

    expect(find.text('来源：手机端原始内置资源'), findsOneWidget);
    expect(find.text('已加载'), findsNWidgets(5));
    expect(
      find.textContaining('来源：assets/assistant/mobile/system_prompt.txt'),
      findsOneWidget,
    );
    expect(
      find.textContaining('来源：assets/assistant/mobile/nsfw_knowledge.json'),
      findsOneWidget,
    );
    expect(find.text('12 条目'), findsOneWidget);
    expect(find.textContaining(_hash('a')), findsOneWidget);
    expect(find.text('不应显示的合成知识正文'), findsNothing);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('resource load errors offer a retry that can recover', (
    tester,
  ) async {
    final controller = WorkbenchController();
    var attempts = 0;
    await _openDialog(
      tester,
      controller,
      loadResources: () async {
        attempts++;
        if (attempts == 1) throw const FormatException('synthetic failure');
        return _snapshot();
      },
    );

    expect(attempts, 1);
    expect(
      find.byKey(const ValueKey('assistant-mobile-resources-error')),
      findsOneWidget,
    );
    expect(find.text('重试加载'), findsOneWidget);
    final retry = find.byKey(
      const ValueKey('assistant-mobile-resources-retry'),
    );
    await tester.ensureVisible(retry);
    await tester.pump();
    await tester.tap(retry);
    await tester.pumpAndSettle();
    expect(attempts, 2);
    expect(
      find.byKey(const ValueKey('assistant-mobile-resources-error')),
      findsNothing,
    );
    expect(find.text('12 条目'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('late mobile snapshot is ignored after leaving the dialog', (
    tester,
  ) async {
    final controller = WorkbenchController();
    final result = Completer<MobileAssistantResourcesSnapshot>();
    await _openDialog(tester, controller, loadResources: () => result.future);

    await tester.tap(find.byKey(const ValueKey('assistant-preferences-close')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    result.complete(_snapshot());
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    expect(
      find.byKey(const ValueKey('assistant-preferences-dialog')),
      findsNothing,
    );
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'narrow 640 by 480 at DPR 2 scrolls and captures the read-only view',
    (tester) async {
      _setViewport(tester, const Size(1280, 960), 2);
      final controller = WorkbenchController();
      final boundary = GlobalKey();
      await _openDialog(
        tester,
        controller,
        loadResources: () async => _snapshot(),
        boundary: boundary,
      );

      expect(find.byType(SingleChildScrollView), findsWidgets);
      await tester.drag(
        find.byType(SingleChildScrollView).last,
        const Offset(0, -900),
      );
      await tester.pumpAndSettle();
      expect(find.text('内置知识库'), findsOneWidget);
      expect(find.text('12 条目'), findsOneWidget);
      await _capture(tester, boundary, 'compact-640x480-dpr2.png');
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );
}

Future<void> _openDialog(
  WidgetTester tester,
  WorkbenchController controller, {
  required Future<MobileAssistantResourcesSnapshot> Function() loadResources,
  GlobalKey? boundary,
}) async {
  final app = MaterialApp(
    theme: ThemeData(fontFamily: 'NotoSansSC'),
    home: Builder(
      builder: (context) => Scaffold(
        body: Center(
          child: FilledButton(
            onPressed: () => showDialog<void>(
              context: context,
              builder: (_) => AssistantPreferencesDialog(
                controller: controller.assistant,
                loadResources: loadResources,
              ),
            ),
            child: const Text('打开设置'),
          ),
        ),
      ),
    ),
  );
  await tester.pumpWidget(
    boundary == null ? app : RepaintBoundary(key: boundary, child: app),
  );
  await tester.tap(find.text('打开设置'));
  // The resource loader may intentionally remain pending, leaving an
  // indeterminate progress animation active. Pump the dialog transition
  // directly instead of waiting for all scheduled frames to settle.
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 300));
  await tester.pump();
  expect(
    find.byKey(const ValueKey('assistant-preferences-dialog')),
    findsOneWidget,
  );
}

MobileAssistantResourcesSnapshot _snapshot() =>
    MobileAssistantResourcesSnapshot(
      source: '手机端原始内置资源',
      systemPromptPath: 'assets/assistant/mobile/system_prompt.txt',
      systemPromptSha256: _hash('a'),
      systemPromptByteLength: 123,
      skillPath: 'assets/assistant/mobile/nai5-prompting/SKILL.md',
      skillSha256: _hash('b'),
      skillByteLength: 234,
      ideationReferencePath:
          'assets/assistant/mobile/nai5-prompting/references/通用构思.md',
      ideationReferenceSha256: _hash('c'),
      ideationReferenceByteLength: 345,
      writingReferencePath:
          'assets/assistant/mobile/nai5-prompting/references/通用写法.md',
      writingReferenceSha256: _hash('d'),
      writingReferenceByteLength: 456,
      knowledgePath: 'assets/assistant/mobile/nsfw_knowledge.json',
      knowledgeSha256: _hash('e'),
      knowledgeByteLength: 567,
      knowledgeEntryCount: 12,
    );

String _hash(String character) => List.filled(64, character).join();

Map<String, dynamic> _storedAssistant(_MemoryWorkspaceStore store) =>
    Map<String, dynamic>.from(store.saved!.data['assistant'] as Map);

void _setViewport(WidgetTester tester, Size physicalSize, double dpr) {
  tester.view.physicalSize = physicalSize;
  tester.view.devicePixelRatio = dpr;
  addTearDown(() {
    tester.view.resetPhysicalSize();
    tester.view.resetDevicePixelRatio();
  });
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
    final file = File('.tmp/assistant-preferences-ui/$name');
    await file.parent.create(recursive: true);
    await file.writeAsBytes(bytes!.buffer.asUint8List());
  });
}

class _MemoryWorkspaceStore implements WorkspaceStore {
  StoredWorkspace? saved;

  @override
  String get label => 'synthetic preference test store';

  @override
  Future<StoredWorkspace?> load() async => saved;

  @override
  Future<int> save(
    Map<String, Object?> data, {
    required int expectedRevision,
  }) async {
    if (expectedRevision != (saved?.revision ?? 0)) {
      throw StateError('synthetic workspace revision conflict');
    }
    final revision = expectedRevision + 1;
    saved = StoredWorkspace(
      data: Map<String, Object?>.from(jsonDecode(jsonEncode(data)) as Map),
      revision: revision,
    );
    return revision;
  }

  @override
  Future<void> close() async {}
}

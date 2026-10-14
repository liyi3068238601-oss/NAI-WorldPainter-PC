import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:worldpainter_pc/assistant/assistant_mobile_resources.dart';
import 'package:worldpainter_pc/main.dart';
import 'package:worldpainter_pc/prototype/workbench_controller.dart';

import 'support/tag_agent_fixture.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() async {
    await (FontLoader(
      'NotoSansSC',
    )..addFont(rootBundle.load('assets/fonts/NotoSansSC.ttf'))).load();
    await (FontLoader(
      'MaterialIcons',
    )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
    await AssistantMobileResources.shared.load();
  });
  testWidgets(
    'assistant previews tag and memory driven changes before approval',
    (tester) async {
      tester.view.physicalSize = const Size(1440, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });
      final c = WorkbenchController(
        assistantTransport: FixtureTagTransport(),
        tagSearchClient: FixtureTagClient(),
      );
      configureTagFixture(c);
      final boundary = GlobalKey();
      await tester.pumpWidget(
        RepaintBoundary(
          key: boundary,
          child: WorldPainterApp(controller: c),
        ),
      );
      await tester.pumpAndSettle();
      final original = c.prompt;
      await tester.tap(find.text('AI 助手').first);
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('assistant-input')),
        tagFixtureInput,
      );
      await tester.runAsync(() async {
        final output = File('.tmp/tag-agent-native-fixture.json');
        await output.parent.create(recursive: true);
        await output.writeAsString(jsonEncode(c.exportWorkspace()));
      });
      await tester.tap(find.byKey(const ValueKey('assistant-send')));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 350));
      expect(c.assistant.interaction, isNotNull);
      expect(c.prompt, original);
      await tester.tap(find.text('查看并确认'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 350));
      expect(find.text('修改前'), findsOneWidget);
      expect(find.text('修改后'), findsOneWidget);
      await capture(tester, boundary, 'assistant-tags-confirm.png');
      await tester.tap(find.byKey(const ValueKey('assistant-approve')));
      await tester.pumpAndSettle();
      expect(c.prompt, '$original, $tagFixtureSuffix');
      expect(c.assistant.session.turns.single.status, 'complete');
      expect(
        c.assistant.session.turns.single.traces.map((t) => t['status']),
        List.filled(4, 'completed'),
      );
      await capture(tester, boundary, 'assistant-tags-complete.png');
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );
}

Future<void> capture(
  WidgetTester tester,
  GlobalKey boundary,
  String name,
) async {
  await tester.runAsync(() async {
    final image =
        await (boundary.currentContext!.findRenderObject()!
                as RenderRepaintBoundary)
            .toImage();
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    image.dispose();
    final file = File('.tmp/tag-search-ui/$name');
    await file.parent.create(recursive: true);
    await file.writeAsBytes(bytes!.buffer.asUint8List());
  });
}

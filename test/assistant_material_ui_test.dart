import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:worldpainter_pc/assistant/prompt_memory.dart';
import 'package:worldpainter_pc/main.dart';
import 'package:worldpainter_pc/prompts/prompt_capsules.dart';
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
  for (final compact in [false, true]) {
    testWidgets(
      'assistant material insertion and clear chats ${compact ? 'compact' : 'desktop'}',
      (tester) async {
        tester.view.physicalSize = compact
            ? const Size(1280, 960)
            : const Size(1440, 900);
        tester.view.devicePixelRatio = compact ? 2 : 1;
        addTearDown(() {
          tester.view.resetPhysicalSize();
          tester.view.resetDevicePixelRatio();
        });
        final c = WorkbenchController();
        // Do not carry AssetBundle futures from another test's fake clock.
        rootBundle.evict(promptCapsulesAssetPath);
        await tester.runAsync(() async {
          await rootBundle.loadString(promptCapsulesAssetPath);
        });
        final style = c.promptLibrary.addStyle(
          name: '合成月光风格',
          prompt: 'silver moonlight',
          negative: 'harsh shadow',
          category: '测试素材',
        );
        final artist = c.promptLibrary.addArtist(
          name: '合成画师',
          prompt: 'synthetic artist',
          defaultWeight: 1.2,
        );
        await c.assistant.saveMemory(
          trigger: '合成偏好',
          content: 'soft light',
          kind: MemoryKind.preference,
        );
        c.assistant.updateInput('保留原有聊天草稿');
        final boundary = GlobalKey();
        await tester.pumpWidget(
          RepaintBoundary(
            key: boundary,
            child: WorldPainterApp(controller: c),
          ),
        );
        await tester.pumpAndSettle();
        final draft = c.prompt;
        final negative = c.negative;
        if (compact) {
          await tester.tap(find.byIcon(Icons.menu_rounded).first);
          await tester.pumpAndSettle();
        }
        final assistantNavigationItem = find.text('AI 助手').first;
        if (compact) {
          await tester.ensureVisible(assistantNavigationItem);
          await tester.pumpAndSettle();
        }
        await tester.tap(assistantNavigationItem);
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('assistant-material')));
        await tester.pumpAndSettle();
        expect(find.text(style.name), findsOneWidget);
        expect(tester.takeException(), isNull);
        await _capture(
          tester,
          boundary,
          'material-${compact ? 'compact' : 'desktop'}.png',
        );
        await tester.tap(find.text(style.name));
        await tester.pumpAndSettle();
        expect(c.assistant.session.input, startsWith('保留原有聊天草稿\n\n'));
        expect(
          c.assistant.session.input,
          contains('正向：silver moonlight\n负向：harsh shadow'),
        );
        expect(c.assistant.session.turns, isEmpty);
        expect(c.prompt, draft);
        expect(c.negative, negative);

        await tester.tap(find.byKey(const ValueKey('assistant-material')));
        await tester.pumpAndSettle();
        await tester.tap(find.widgetWithText(ChoiceChip, '画师'));
        await tester.pumpAndSettle();
        await tester.tap(find.text(artist.name));
        await tester.pumpAndSettle();
        expect(
          c.assistant.session.input,
          contains(c.promptLibrary.composeArtistPrompt({artist.id: 1.2})),
        );
        expect(c.promptLibrary.artists.single.useCount, 0);
        await tester.tap(find.byKey(const ValueKey('assistant-material')));
        await tester.pumpAndSettle();
        await tester.tap(find.widgetWithText(ChoiceChip, '胶囊'));
        await tester.pump();
        // AssetBundle decodes the large JSON asset on a real isolate; allow
        // it to complete outside the widget test's fake clock.
        await tester.runAsync(() async {
          await Future<void>.delayed(const Duration(milliseconds: 500));
        });
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
        final capsules = find.descendant(
          of: find.byType(AlertDialog),
          matching: find.byType(ListTile),
        );
        expect(capsules, findsWidgets);
        await tester.tap(capsules.first);
        await tester.pumpAndSettle();
        expect(c.assistant.session.input, contains('胶囊参考：'));
        expect(c.assistant.session.turns, isEmpty);
        expect(c.prompt, draft);

        await tester.ensureVisible(find.byTooltip('会话操作'));
        await tester.tap(find.byTooltip('会话操作'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('清空全部会话'));
        await tester.pumpAndSettle();
        await tester.tap(find.widgetWithText(TextButton, '取消'));
        await tester.pumpAndSettle();
        expect(c.assistant.session.input, contains('胶囊参考：'));
        await tester.tap(find.byTooltip('会话操作'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('清空全部会话'));
        await tester.pumpAndSettle();
        await tester.tap(find.widgetWithText(FilledButton, '确认'));
        await tester.pumpAndSettle();
        expect(c.assistant.session.input, isEmpty);
        expect(c.assistant.state.memories.entries, hasLength(1));
        expect(c.promptLibrary.styles.single.id, style.id);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
      },
    );
  }
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

import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:worldpainter_pc/assistant/agent_contract.dart';
import 'package:worldpainter_pc/assistant/assistant_mobile_resources.dart';
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
    await AssistantMobileResources.shared.load();
  });
  testWidgets(
    'assistant runs read confirm write result loop and keeps history',
    (tester) async {
      tester.view.physicalSize = const Size(1440, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });
      final transport = _ScriptedTransport();
      final c = WorkbenchController(assistantTransport: transport);
      c.assistant.state.providers.add(
        const AssistantProvider(
          id: 'fixture',
          name: '本地契约测试',
          baseUrl: 'http://127.0.0.1:5099/v1',
          model: 'synthetic-tool-model',
          requireKey: false,
        ),
      );
      c.assistant.state.mainProviderId = 'fixture';
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
        '先读取当前提示词，追加柔和的月光。',
      );
      await tester.runAsync(() async {
        final file = File('.tmp/assistant-native-fixture.json');
        await file.parent.create(recursive: true);
        await file.writeAsString(jsonEncode(c.exportWorkspace()));
      });
      await tester.tap(find.byKey(const ValueKey('assistant-send')));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      expect(c.assistant.interaction, isNotNull);
      expect(c.prompt, original);
      await tester.tap(find.text('查看并确认'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      expect(find.text('修改前'), findsOneWidget);
      expect(find.text('修改后'), findsOneWidget);
      await _capture(tester, boundary, 'assistant-confirm.png');
      await tester.tap(find.byKey(const ValueKey('assistant-approve')));
      await tester.pumpAndSettle();
      expect(c.prompt, '$original, soft moonlight');
      expect(c.assistant.session.turns.single.status, 'complete');
      expect(c.assistant.session.turns.single.traces.map((t) => t['status']), [
        'completed',
        'completed',
      ]);
      expect(transport.round, 3);
      await _capture(tester, boundary, 'assistant-desktop.png');
      await tester.tap(find.byKey(const ValueKey('assistant-settings')));
      await tester.pumpAndSettle();
      expect(find.text('识图模型（只处理你发送的附图）'), findsOneWidget);
      await _capture(tester, boundary, 'assistant-settings.png');
      await tester.tap(find.widgetWithText(TextButton, '关闭'));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('编辑为新分支 / 重试'));
      await tester.pumpAndSettle();
      expect(c.assistant.state.sessions.length, 2);
      expect(c.assistant.session.input, '先读取当前提示词，追加柔和的月光。');
      expect(c.assistant.session.turns, isEmpty);
      await tester.pumpWidget(const SizedBox());
    },
  );
  testWidgets(
    'compact high DPI assistant exposes compose and connection controls',
    (tester) async {
      tester.view.physicalSize = const Size(1280, 960);
      tester.view.devicePixelRatio = 2;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });
      final c = WorkbenchController();
      final boundary = GlobalKey();
      await tester.pumpWidget(
        RepaintBoundary(
          key: boundary,
          child: WorldPainterApp(controller: c),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byIcon(Icons.menu_rounded).first);
      await tester.pumpAndSettle();
      final assistantNavigationItem = find.text('AI 助手').first;
      await tester.ensureVisible(assistantNavigationItem);
      await tester.pumpAndSettle();
      await tester.tap(assistantNavigationItem);
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      expect(find.byKey(const ValueKey('assistant-input')), findsOneWidget);
      expect(find.byKey(const ValueKey('assistant-send')), findsOneWidget);
      await _capture(tester, boundary, 'assistant-compact.png');
      await tester.tap(find.byKey(const ValueKey('assistant-settings')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('assistant-add-provider')));
      await tester.pumpAndSettle();
      expect(find.widgetWithText(TextField, '模型 ID'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await _capture(tester, boundary, 'assistant-provider-compact.png');
      await tester.pumpWidget(const SizedBox());
    },
  );
}

class _ScriptedTransport implements AgentTransport {
  int round = 0;
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
    if (round == 1) {
      return const AgentReply(
        calls: [
          AgentCall(
            id: 'read-1',
            name: 'read_current_prompts',
            arguments: '{}',
          ),
        ],
        finishReason: 'tool_calls',
      );
    }
    if (round == 2) {
      expect(messages.last['tool_call_id'], 'read-1');
      expect(
        jsonDecode(messages.last['content'] as String)['positive'],
        isNotEmpty,
      );
      return const AgentReply(
        calls: [
          AgentCall(
            id: 'write-1',
            name: 'write_prompt',
            arguments: '{"target":"positive","content":"soft moonlight","mode":"append"}',
          ),
        ],
        finishReason: 'tool_calls',
      );
    }
    expect(messages.last['tool_call_id'], 'write-1');
    expect(jsonDecode(messages.last['content'] as String)['ok'], true);
    return const AgentReply(
      content: '已按你确认的方案追加 soft moonlight，原有提示词和负向词保持不变。',
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
    final output = File('.tmp/assistant-ui/$name');
    await output.parent.create(recursive: true);
    await output.writeAsBytes(bytes!.buffer.asUint8List());
  });
}

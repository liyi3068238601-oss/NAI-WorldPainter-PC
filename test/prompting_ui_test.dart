import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:worldpainter_pc/assistant/agent_contract.dart';
import 'package:worldpainter_pc/assistant/assistant_mobile_resources.dart';
import 'package:worldpainter_pc/assistant/assistant_state.dart';
import 'package:worldpainter_pc/assistant/prompt_application.dart';
import 'package:worldpainter_pc/assistant/prompting_knowledge.dart';
import 'package:worldpainter_pc/main.dart';
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
    await AssistantMobileResources.shared.load();
  });

  testWidgets('v5 knowledge mode is saved and restored with the assistant', (
    tester,
  ) async {
    _setSize(tester, const Size(1440, 900));
    final c = _controller();
    await _mountAssistant(tester, c);

    await tester.tap(find.byKey(const ValueKey('assistant-settings')));
    await tester.pumpAndSettle();
    final selector = find.byKey(
      ValueKey('assistant-prompting-version-${PromptingVersion.v45.name}'),
    );
    await tester.tap(selector);
    await tester.pumpAndSettle();
    await tester.tap(find.text(PromptingVersion.v5.label).last);
    await tester.pumpAndSettle();
    expect(find.text('只切换助手使用的提示词知识，不会改变生图模型。'), findsOneWidget);
    await tester.tap(find.text('保存偏好'));
    await tester.pumpAndSettle();

    final snapshot = c.exportWorkspace();
    final restored = WorkbenchController(
      restored: StoredWorkspace(data: snapshot, revision: 1),
    );
    expect(restored.assistant.promptingVersion, PromptingVersion.v5);
    expect(restored.assistant.session.promptingVersion, PromptingVersion.v5);
    restored.dispose();
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'ordinary replies have no proposal action and cancel keeps draft',
    (tester) async {
      _setSize(tester, const Size(1440, 900));
      final transport = _PromptTransport('只是普通的合成回复。');
      final c = _controller(transport: transport);
      final boundary = await _mountAssistant(tester, c);
      c.updatePrompt('unchanged draft');
      await _turnOffAgent(tester);

      await _send(tester, '给我一句普通说明。');
      expect(c.assistant.session.turns.last.status, 'complete');
      expect(find.text('查看提示词提案'), findsNothing);

      transport.response = '{"positive":"synthetic proposed prompt","negative":"synthetic negative","reason":"合成预览"}';
      await _send(tester, '提出合成提示词修改。');
      expect(find.text('查看提示词提案'), findsOneWidget);
      final before = c.prompt;
      await tester.tap(find.text('查看提示词提案'));
      await tester.pumpAndSettle();
      expect(find.text('审阅提示词提案'), findsOneWidget);
      expect(find.text('修改前'), findsWidgets);
      expect(find.text('修改后'), findsWidgets);
      await _captureWithBoundary(tester, boundary, 'proposal-preview.png');
      await tester.tap(find.byKey(const ValueKey('prompt-proposal-cancel')));
      await tester.pumpAndSettle();
      expect(c.prompt, before);
      expect(c.assistant.session.turns.last.promptApplication, isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'user can apply selected fields and reopen the read only receipt',
    (tester) async {
      _setSize(tester, const Size(1440, 900));
      final transport = _PromptTransport(
        '{"positive":"synthetic after","negative":"synthetic negative","reason":"合成部分采纳"}',
      );
      final c = _controller(transport: transport);
      final boundary = await _mountAssistant(tester, c);
      c.updatePrompt('synthetic before');
      c.updateNegative('negative before');
      await _turnOffAgent(tester);
      await _send(tester, '只采纳正向词。');

      final turn = c.assistant.session.turns.last;
      await tester.tap(find.byKey(ValueKey('assistant-proposal-${turn.id}')));
      await tester.pumpAndSettle();
      expect(find.text('正向提示词'), findsOneWidget);
      expect(find.text('负向提示词'), findsOneWidget);
      await tester.tap(
        find.byKey(const ValueKey('prompt-proposal-target-negative')),
      );
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('prompt-proposal-reason')),
        '😀' * 501,
      );
      await tester.pumpAndSettle();
      expect(find.text('变更原因过长，请缩短。'), findsOneWidget);
      expect(
        tester
            .widget<FilledButton>(
              find.byKey(const ValueKey('prompt-proposal-apply')),
            )
            .onPressed,
        isNull,
      );
      await tester.enterText(
        find.byKey(const ValueKey('prompt-proposal-reason')),
        '仅采纳正向词的合成记录',
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('prompt-proposal-apply')));
      await tester.pumpAndSettle();

      expect(c.prompt, 'synthetic after');
      expect(c.assistant.status, contains('仅在内存中保留'));
      expect(c.parameters.negativePrompt, 'negative before');
      expect(turn.promptApplication, isNotNull);
      expect(turn.promptApplication!.reason, '仅采纳正向词的合成记录');
      expect(
        find.text('已应用提案 · ${PromptingVersion.v45.label}'),
        findsOneWidget,
      );
      expect(find.text('查看提示词提案'), findsNothing);
      await tester.tap(find.text('已应用提案 · ${PromptingVersion.v45.label}'));
      await tester.pumpAndSettle();
      expect(find.text('修改前'), findsOneWidget);
      expect(find.text('修改后'), findsOneWidget);
      expect(find.text('synthetic before'), findsOneWidget);
      expect(find.text('synthetic after'), findsOneWidget);
      expect(find.byKey(const ValueKey('prompt-proposal-apply')), findsNothing);
      await _captureWithBoundary(tester, boundary, 'application-reopened.png');

      final snapshot = c.exportWorkspace();
      await tester.pumpWidget(const SizedBox());
      final restored = _controller(
        restored: StoredWorkspace(data: snapshot, revision: 1),
      );
      await _mountAssistant(tester, restored);
      expect(
        find.text('已应用提案 · ${PromptingVersion.v45.label}'),
        findsOneWidget,
      );
      await tester.tap(find.text('已应用提案 · ${PromptingVersion.v45.label}'));
      await tester.pumpAndSettle();
      expect(find.text('synthetic before'), findsOneWidget);
      expect(find.text('synthetic after'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('proposal draft changes while review is open are rejected', (
    tester,
  ) async {
    _setSize(tester, const Size(1440, 900));
    final c = _controller(
      transport: _PromptTransport(
        '{"positive":"synthetic proposal","reason":"过期保护"}',
      ),
    );
    await _mountAssistant(tester, c);
    c.updatePrompt('draft captured at send');
    await _turnOffAgent(tester);
    await _send(tester, '检查过期保护。');
    final turn = c.assistant.session.turns.last;
    await tester.tap(find.byKey(ValueKey('assistant-proposal-${turn.id}')));
    await tester.pumpAndSettle();

    c.updatePrompt('newer user draft');
    await tester.tap(find.byKey(const ValueKey('prompt-proposal-apply')));
    await tester.pumpAndSettle();

    expect(
      find.byKey(const ValueKey('prompt-proposal-dialog')),
      findsOneWidget,
    );
    expect(find.textContaining('草稿'), findsWidgets);
    expect(c.prompt, 'newer user draft');
    expect(turn.promptApplication, isNull);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'old proposal records stay read only and compact dialog scrolls',
    (tester) async {
      _setSize(tester, const Size(420, 820));
      final c = _controller();
      c.assistant.session.turns.add(
        AssistantTurn(
          id: 'old-proposal-turn',
          userText: '旧记录合成提案',
          status: 'complete',
          providerLabel: '合成测试服务',
          messages: const [
            {
              'role': 'assistant',
              'content': '{"positive":"legacy proposal value","reason":"旧版提案"}',
            },
          ],
          // Missing promptingVersion and fingerprint intentionally model a legacy turn.
        ),
      );
      c.assistant.session.turns.add(
        AssistantTurn(
          id: 'receipt-turn',
          userText: '带收据的旧记录',
          status: 'complete',
          providerLabel: '合成测试服务',
          promptingVersion: PromptingVersion.v45,
          proposalDraftFingerprint: List.filled(64, 'a').join(),
          messages: const [
            {'role': 'assistant', 'content': '已应用过的合成提案。'},
          ],
          promptApplication: PromptApplication(
            version: PromptingVersion.v45,
            reason: '用于重开审阅的合成记录',
            appliedAt: '2026-10-14T08:30:00.000Z',
            before: const {'positive': 'receipt before'},
            after: const {'positive': 'receipt after'},
          ),
        ),
      );
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
      await tester.tap(find.text('AI 助手').first);
      await tester.pumpAndSettle();

      expect(
        find.byKey(const ValueKey('assistant-proposal-old-proposal-turn')),
        findsOneWidget,
      );
      expect(
        find.text('已应用提案 · ${PromptingVersion.v45.label}'),
        findsOneWidget,
      );
      final oldProposalButton = find.byKey(
        const ValueKey('assistant-proposal-old-proposal-turn'),
      );
      await tester.ensureVisible(oldProposalButton);
      await tester.pumpAndSettle();
      await _captureWithBoundary(tester, boundary, 'compact-assistant.png');
      await tester.tap(oldProposalButton);
      await tester.pumpAndSettle();
      expect(find.text('这条旧提案没有可核对的草稿版本，当前仅供查看，不能应用。'), findsOneWidget);
      expect(find.text('legacy proposal value'), findsOneWidget);
      final applyButton = find.byKey(const ValueKey('prompt-proposal-apply'));
      expect(tester.widget<FilledButton>(applyButton).onPressed, isNull);
      await tester.ensureVisible(applyButton);
      expect(tester.getRect(applyButton).bottom, lessThanOrEqualTo(820));
      await _captureWithBoundary(tester, boundary, 'compact-old-record.png');
      await tester.tap(find.byKey(const ValueKey('prompt-proposal-cancel')));
      await tester.pumpAndSettle();

      await tester.ensureVisible(
        find.text('已应用提案 · ${PromptingVersion.v45.label}'),
      );
      await tester.tap(find.text('已应用提案 · ${PromptingVersion.v45.label}'));
      await tester.pumpAndSettle();
      expect(find.text('receipt before'), findsOneWidget);
      expect(find.text('receipt after'), findsOneWidget);
      await tester.pumpWidget(const SizedBox());
    },
  );
}

WorkbenchController _controller({
  AgentTransport? transport,
  StoredWorkspace? restored,
}) {
  final c = WorkbenchController(
    assistantTransport: transport,
    restored: restored,
  );
  if (c.assistant.state.providers.isEmpty) {
    c.assistant.state.providers.add(
      const AssistantProvider(
        id: 'prompting-ui-fixture',
        name: '提示词 UI 合成测试',
        baseUrl: 'http://127.0.0.1:5099/v1',
        model: 'synthetic-prompt-model',
        requireKey: false,
      ),
    );
    c.assistant.state.mainProviderId = 'prompting-ui-fixture';
  }
  return c;
}

Future<GlobalKey> _mountAssistant(
  WidgetTester tester,
  WorkbenchController c,
) async {
  final boundary = GlobalKey();
  await tester.pumpWidget(
    RepaintBoundary(
      key: boundary,
      child: WorldPainterApp(controller: c),
    ),
  );
  await tester.pumpAndSettle();
  if (tester.view.physicalSize.width / tester.view.devicePixelRatio < 700) {
    await tester.tap(find.byIcon(Icons.menu_rounded).first);
    await tester.pumpAndSettle();
  }
  await tester.tap(find.text('AI 助手').first);
  await tester.pumpAndSettle();
  return boundary;
}

Future<void> _turnOffAgent(WidgetTester tester) async {
  await tester.tap(find.widgetWithText(FilterChip, 'Agent 工具'));
  await tester.pumpAndSettle();
}

Future<void> _send(WidgetTester tester, String text) async {
  await tester.enterText(find.byKey(const ValueKey('assistant-input')), text);
  await tester.tap(find.byKey(const ValueKey('assistant-send')));
  await tester.pumpAndSettle();
}

void _setSize(WidgetTester tester, Size size) {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(() {
    tester.view.resetPhysicalSize();
    tester.view.resetDevicePixelRatio();
  });
}

class _PromptTransport implements AgentTransport {
  _PromptTransport(this.response);
  String response;

  @override
  Future<AgentReply> complete({
    required AssistantProvider provider,
    required List<Map<String, dynamic>> messages,
    required List<Map<String, dynamic>> tools,
    required String toolChoice,
    required AgentCancellation cancellation,
    void Function(String)? onText,
  }) async {
    cancellation.check();
    onText?.call(response);
    return AgentReply(content: response);
  }
}

Future<void> _captureWithBoundary(
  WidgetTester tester,
  GlobalKey boundary,
  String name,
) async {
  await tester.runAsync(() async {
    final renderObject =
        boundary.currentContext!.findRenderObject()! as RenderRepaintBoundary;
    final image = await renderObject.toImage(
      pixelRatio: tester.view.devicePixelRatio,
    );
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    image.dispose();
    final output = File('.tmp/prompting-ui/$name');
    await output.parent.create(recursive: true);
    await output.writeAsBytes(bytes!.buffer.asUint8List());
  });
}

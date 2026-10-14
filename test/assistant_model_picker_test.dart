import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:worldpainter_pc/assistant/agent_contract.dart';
import 'package:worldpainter_pc/prototype/assistant_model_picker.dart';

void main() {
  testWidgets('loads once, filters IDs, and returns the exact long model ID', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1600, 1000);
    tester.view.devicePixelRatio = 1;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });

    final completion = Completer<List<String>>();
    var loadCount = 0;
    String? selectedModel;
    final longModelId =
        'vendor/large-context-model-${List.filled(140, 'x').join()}';
    await tester.pumpWidget(
      _harness(
        loadModels: (_) {
          loadCount++;
          return completion.future;
        },
        onSelected: (model) => selectedModel = model,
      ),
    );

    await tester.tap(find.text('打开选择器'));
    await tester.pump();
    expect(loadCount, 1);
    expect(find.text('正在读取模型列表…'), findsOneWidget);

    completion.complete(['openai/gpt-4.1', longModelId, 'deepseek-v3']);
    await tester.pump();
    await tester.pumpAndSettle();
    expect(loadCount, 1);
    expect(find.text(longModelId), findsOneWidget);

    await tester.enterText(
      find.byKey(const ValueKey('assistant-model-picker-search')),
      'large-context',
    );
    await tester.pumpAndSettle();
    expect(find.text('openai/gpt-4.1'), findsNothing);
    expect(find.text(longModelId), findsOneWidget);

    await tester.tap(
      find.byKey(const ValueKey('assistant-model-picker-option-0')),
    );
    await tester.pumpAndSettle();
    expect(selectedModel, longModelId);
    expect(tester.takeException(), isNull);
  });

  testWidgets('cancel and close cancel requests and ignore late results', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(640, 480);
    tester.view.devicePixelRatio = 1;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });

    final completions = [Completer<List<String>>(), Completer<List<String>>()];
    final tokens = <AgentCancellation>[];
    var loadCount = 0;
    await tester.pumpWidget(
      _harness(
        loadModels: (token) {
          tokens.add(token);
          return completions[loadCount++].future;
        },
        onSelected: (_) {},
      ),
    );

    await tester.tap(find.text('打开选择器'));
    await tester.pump(const Duration(milliseconds: 300));
    expect(loadCount, 1);
    expect(find.text('正在读取模型列表…'), findsOneWidget);
    await tester.tap(
      find.byKey(const ValueKey('assistant-model-picker-cancel')),
    );
    await tester.pump(const Duration(milliseconds: 300));
    expect(tokens[0].isCancelled, isTrue);
    completions[0].complete(['late-model-one']);
    await tester.pump();
    expect(tester.takeException(), isNull);

    await tester.tap(find.text('打开选择器'));
    await tester.pump(const Duration(milliseconds: 300));
    expect(loadCount, 2);
    await tester.tap(
      find.byKey(const ValueKey('assistant-model-picker-close')),
    );
    await tester.pump(const Duration(milliseconds: 300));
    expect(tokens[1].isCancelled, isTrue);
    completions[1].complete(['late-model-two']);
    await tester.pump();
    expect(tester.takeException(), isNull);
  });

  testWidgets('shows an error without retrying and retries only on request', (
    tester,
  ) async {
    var loadCount = 0;
    await tester.pumpWidget(
      _harness(
        loadModels: (_) {
          loadCount++;
          if (loadCount == 1) {
            return Future<List<String>>.error(const AgentException('服务暂时不可用。'));
          }
          return Future.value(const <String>[]);
        },
        onSelected: (_) {},
      ),
    );

    await tester.tap(find.text('打开选择器'));
    await tester.pumpAndSettle();
    expect(find.text('服务暂时不可用。'), findsOneWidget);
    expect(loadCount, 1);

    await tester.tap(
      find.byKey(const ValueKey('assistant-model-picker-retry')),
    );
    await tester.pumpAndSettle();
    expect(loadCount, 2);
    expect(
      find.byKey(const ValueKey('assistant-model-picker-empty')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('assistant-model-picker-retry')),
      findsNothing,
    );
    expect(tester.takeException(), isNull);
  });
}

Widget _harness({
  required Future<List<String>> Function(AgentCancellation) loadModels,
  required ValueChanged<String?> onSelected,
}) => MaterialApp(
  home: Builder(
    builder: (context) => Scaffold(
      body: Center(
        child: FilledButton(
          onPressed: () {
            unawaited(
              pickAssistantModel(
                context,
                loadModels: loadModels,
              ).then(onSelected),
            );
          },
          child: const Text('打开选择器'),
        ),
      ),
    ),
  ),
);

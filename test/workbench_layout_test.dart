import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:worldpainter_pc/main.dart';

void setLogicalViewport(
  WidgetTester tester,
  Size logicalSize, {
  double devicePixelRatio = 1,
}) {
  tester.view.devicePixelRatio = devicePixelRatio;
  tester.view.physicalSize = Size(
    logicalSize.width * devicePixelRatio,
    logicalSize.height * devicePixelRatio,
  );
}

void resetViewport(WidgetTester tester) {
  tester.view.resetPhysicalSize();
  tester.view.resetDevicePixelRatio();
}

void main() {
  group('WorldPainterApp workbench layout and interactions', () {
    testWidgets('lays out at desktop, compact, and high-DPI logical sizes', (
      tester,
    ) async {
      addTearDown(() => resetViewport(tester));
      final viewports = [
        (logical: const Size(1440, 900), dpr: 1.0),
        (logical: const Size(1280, 720), dpr: 1.0),
        (logical: const Size(960, 720), dpr: 1.0),
        (logical: const Size(640, 480), dpr: 2.0),
      ];
      final layoutErrors = <String>[];

      for (final viewport in viewports) {
        setLogicalViewport(
          tester,
          viewport.logical,
          devicePixelRatio: viewport.dpr,
        );
        await tester.pumpWidget(const WorldPainterApp());
        await tester.pumpAndSettle();

        final exception = tester.takeException();
        if (exception != null) {
          layoutErrors.add(
            '${viewport.logical.width}x${viewport.logical.height} logical '
            'pixels, DPR ${viewport.dpr}: $exception',
          );
        }

        await tester.pumpWidget(const SizedBox.shrink());
      }

      expect(layoutErrors, isEmpty, reason: layoutErrors.join('\n'));
    });

    testWidgets(
      'keeps the prompt draft when navigation collapses and expands',
      (tester) async {
        addTearDown(() => resetViewport(tester));
        setLogicalViewport(tester, const Size(1440, 900));
        await tester.pumpWidget(const WorldPainterApp());
        await tester.pumpAndSettle();

        final prompt = find.byKey(const ValueKey('positive'));
        await tester.enterText(prompt, 'draft preserved across navigation');
        await tester.pump();
        expect(find.text('WORLDPAINTER'), findsOneWidget);

        await tester.tap(find.byTooltip('收展导航'));
        await tester.pumpAndSettle();
        expect(find.text('WORLDPAINTER'), findsNothing);
        expect(
          tester.widget<TextField>(prompt).controller!.text,
          'draft preserved across navigation',
        );

        await tester.tap(find.byTooltip('收展导航'));
        await tester.pumpAndSettle();
        expect(find.text('WORLDPAINTER'), findsOneWidget);
        expect(
          tester.widget<TextField>(prompt).controller!.text,
          'draft preserved across navigation',
        );
      },
    );

    testWidgets('switches between dark and light themes', (tester) async {
      addTearDown(() => resetViewport(tester));
      setLogicalViewport(tester, const Size(1440, 900));
      await tester.pumpWidget(const WorldPainterApp());
      await tester.pumpAndSettle();

      MaterialApp app() => tester.widget<MaterialApp>(find.byType(MaterialApp));
      expect(app().theme!.brightness, Brightness.dark);

      final lightThemeButton = find.byWidgetPredicate(
        (widget) => widget is IconButton && widget.tooltip == '切换浅色主题',
      );
      expect(lightThemeButton.hitTestable(), findsOneWidget);
      await tester.tap(lightThemeButton);
      await tester.pumpAndSettle();
      expect(app().theme!.brightness, Brightness.light);
      expect(find.byTooltip('切换深色主题'), findsOneWidget);

      final darkThemeButton = find.byWidgetPredicate(
        (widget) => widget is IconButton && widget.tooltip == '切换深色主题',
      );
      expect(darkThemeButton.hitTestable(), findsOneWidget);
      await tester.tap(darkThemeButton);
      await tester.pumpAndSettle();
      expect(app().theme!.brightness, Brightness.dark);
    });

    testWidgets(
      'prompt editor cancellation discards edits and apply writes them back',
      (tester) async {
        addTearDown(() => resetViewport(tester));
        setLogicalViewport(tester, const Size(1440, 900));
        await tester.pumpWidget(const WorldPainterApp());
        await tester.pumpAndSettle();

        final prompt = find.byKey(const ValueKey('positive'));
        final initialPrompt = tester.widget<TextField>(prompt).controller!.text;

        await tester.tap(find.byTooltip('展开提示词编辑器'));
        await tester.pumpAndSettle();
        final editor = find.descendant(
          of: find.byType(Dialog),
          matching: find.byType(TextField),
        );
        expect(editor, findsOneWidget);
        await tester.enterText(editor, 'discarded dialog draft');
        await tester.tap(
          find.descendant(of: find.byType(Dialog), matching: find.text('取消')),
        );
        await tester.pumpAndSettle();
        expect(
          tester.widget<TextField>(prompt).controller!.text,
          initialPrompt,
        );

        await tester.tap(find.byTooltip('展开提示词编辑器'));
        await tester.pumpAndSettle();
        final reopenedEditor = find.descendant(
          of: find.byType(Dialog),
          matching: find.byType(TextField),
        );
        await tester.enterText(reopenedEditor, 'applied dialog draft');
        await tester.tap(
          find.descendant(of: find.byType(Dialog), matching: find.text('应用更改')),
        );
        await tester.pumpAndSettle();

        expect(
          tester.widget<TextField>(prompt).controller!.text,
          'applied dialog draft',
        );
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets(
      'narrow window exposes the generate button in the settings drawer',
      (tester) async {
        addTearDown(() => resetViewport(tester));
        setLogicalViewport(tester, const Size(640, 480), devicePixelRatio: 2);
        await tester.pumpWidget(const WorldPainterApp());
        await tester.pumpAndSettle();

        await tester.tap(find.byTooltip('打开生成设置'));
        await tester.pumpAndSettle();

        final generateButton = find.byKey(const Key('generate'));
        expect(generateButton, findsOneWidget);
        expect(generateButton.hitTestable(), findsOneWidget);
        final rect = tester.getRect(generateButton);
        expect(rect.left, greaterThanOrEqualTo(0));
        expect(rect.top, greaterThanOrEqualTo(0));
        expect(rect.right, lessThanOrEqualTo(640));
        expect(rect.bottom, lessThanOrEqualTo(480));
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets('main navigation drawer fits a 640x480 high-DPI viewport', (
      tester,
    ) async {
      addTearDown(() => resetViewport(tester));
      setLogicalViewport(tester, const Size(640, 480), devicePixelRatio: 2);
      await tester.pumpWidget(const WorldPainterApp());
      await tester.pumpAndSettle();

      await tester.tap(find.byTooltip('打开导航'));
      await tester.pumpAndSettle();

      expect(
        tester.takeException(),
        isNull,
        reason: 'The main navigation drawer must fit 640x480 logical pixels.',
      );
      expect(find.text('WORLDPAINTER'), findsOneWidget);
      expect(find.text('偏好设置'), findsOneWidget);
      expect(find.byTooltip('切换浅色主题'), findsOneWidget);
    });
  });
}

import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:worldpainter_pc/assistant/agent_contract.dart';
import 'package:worldpainter_pc/prototype/assistant_image_settings.dart';
import 'package:worldpainter_pc/prototype/assistant_panel.dart';
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

  testWidgets(
    'WD-Tagger settings validate, save, and roundtrip through a workspace snapshot',
    (tester) async {
      tester.view.physicalSize = const Size(1440, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      final workbench = WorkbenchController();
      final boundary = GlobalKey();
      await tester.pumpWidget(
        RepaintBoundary(
          key: boundary,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: ThemeData(
              brightness: Brightness.dark,
              fontFamily: 'NotoSansSC',
              colorScheme: ColorScheme.fromSeed(
                seedColor: const Color(0xfff5d57a),
                brightness: Brightness.dark,
              ),
            ),
            home: Scaffold(body: AssistantPanel(workbench: workbench)),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byTooltip('附加图片（分析：未配置）'), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('assistant-settings')));
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const ValueKey('assistant-wd-tagger-settings')),
      );
      await tester.pumpAndSettle();

      expect(find.text('WD-Tagger 图片识别'), findsOneWidget);
      expect(
        tester
            .widget<SwitchListTile>(
              find.byKey(const ValueKey('wd-tagger-enabled')),
            )
            .value,
        isFalse,
      );
      expect(
        find.byKey(
          const ValueKey('wd-tagger-model-SmilingWolf/wd-swinv2-tagger-v3'),
        ),
        findsOneWidget,
      );
      expect(
        tester
            .widget<TextFormField>(
              find.byKey(const ValueKey('wd-tagger-base-url')),
            )
            .controller!
            .text,
        'https://smilingwolf-wd-tagger.hf.space',
      );
      expect(
        tester
            .widget<TextFormField>(
              find.byKey(const ValueKey('wd-tagger-general-threshold')),
            )
            .controller!
            .text,
        '0.35',
      );
      expect(
        tester
            .widget<TextFormField>(
              find.byKey(const ValueKey('wd-tagger-character-threshold')),
            )
            .controller!
            .text,
        '0.85',
      );
      expect(find.textContaining('不使用小助手的 LLM 凭据'), findsOneWidget);
      await _captureWithBoundary(tester, boundary, 'normal.png');

      await tester.enterText(
        find.byKey(const ValueKey('wd-tagger-general-threshold')),
        '1.2',
      );
      await tester.tap(find.byKey(const ValueKey('wd-tagger-save')));
      await tester.pumpAndSettle();
      expect(find.text('请输入 0 到 1 之间的数值。'), findsOneWidget);
      expect(workbench.assistant.state.wdTagger.enabled, isFalse);

      await tester.enterText(
        find.byKey(const ValueKey('wd-tagger-general-threshold')),
        '0.42',
      );
      await tester.ensureVisible(
        find.byKey(const ValueKey('wd-tagger-character-threshold')),
      );
      await tester.enterText(
        find.byKey(const ValueKey('wd-tagger-character-threshold')),
        '0.91',
      );
      await tester.ensureVisible(
        find.byKey(const ValueKey('wd-tagger-enabled')),
      );
      await tester.tap(find.byKey(const ValueKey('wd-tagger-enabled')));
      await tester.ensureVisible(
        find.byKey(const ValueKey('wd-tagger-general-mcut')),
      );
      await tester.tap(find.byKey(const ValueKey('wd-tagger-general-mcut')));
      await tester.tap(find.byKey(const ValueKey('wd-tagger-save')));
      await tester.pumpAndSettle();

      final saved = workbench.assistant.state.wdTagger;
      expect(saved.enabled, isTrue);
      expect(saved.generalThreshold, 0.42);
      expect(saved.characterThreshold, 0.91);
      expect(saved.generalMcut, isTrue);
      expect(
        find.byWidgetPredicate(
          (widget) =>
              widget is IconButton &&
              (widget.tooltip?.startsWith('附加图片（分析：WD-Tagger') ?? false),
        ),
        findsOneWidget,
      );

      workbench.assistant.state.providers.add(
        const AssistantProvider(
          id: 'vision-fixture',
          name: '合成识图连接',
          baseUrl: 'http://127.0.0.1:5111/v1',
          model: 'synthetic-vision-model',
          requireKey: false,
        ),
      );
      workbench.assistant.state.visionProviderId = 'vision-fixture';
      workbench.assistant.changed();
      await tester.pump();
      expect(
        find.byWidgetPredicate(
          (widget) =>
              widget is IconButton &&
              (widget.tooltip?.contains('WD-Tagger') ?? false) &&
              (widget.tooltip?.contains('识图模型（合成识图连接）') ?? false),
        ),
        findsOneWidget,
      );

      final restored = WorkbenchController(
        restored: StoredWorkspace(
          data: workbench.exportWorkspace(),
          revision: 1,
        ),
      );
      expect(restored.assistant.state.wdTagger.toJson(), saved.toJson());

      await tester.pumpWidget(const SizedBox());
      workbench.dispose();
      restored.dispose();
    },
  );

  testWidgets('WD-Tagger settings remain scrollable in a narrow window', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(360, 560);
    tester.view.devicePixelRatio = 1;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });

    final workbench = WorkbenchController();
    final boundary = GlobalKey();
    await tester.pumpWidget(
      RepaintBoundary(
        key: boundary,
        child: MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: ThemeData(
            brightness: Brightness.dark,
            fontFamily: 'NotoSansSC',
            colorScheme: ColorScheme.fromSeed(
              seedColor: const Color(0xfff5d57a),
              brightness: Brightness.dark,
            ),
          ),
          home: Scaffold(
            body: Builder(
              builder: (context) => Center(
                child: TextButton(
                  onPressed: () =>
                      showWdTaggerSettingsDialog(context, workbench.assistant),
                  child: const Text('打开 WD 设置'),
                ),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('打开 WD 设置'));
    await tester.pumpAndSettle();
    await _captureWithBoundary(tester, boundary, 'narrow.png');
    await tester.ensureVisible(
      find.byKey(const ValueKey('wd-tagger-character-threshold')),
    );
    await tester.pumpAndSettle();
    expect(
      find.byKey(const ValueKey('wd-tagger-character-mcut')),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);

    await tester.pumpWidget(const SizedBox());
    workbench.dispose();
  });
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
    try {
      final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
      final output = File('.tmp/assistant-images-ui/$name');
      await output.parent.create(recursive: true);
      await output.writeAsBytes(bytes!.buffer.asUint8List());
    } finally {
      image.dispose();
    }
  });
}

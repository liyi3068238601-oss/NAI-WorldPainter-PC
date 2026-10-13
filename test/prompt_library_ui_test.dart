import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
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
  testWidgets('desktop creates style, edits groups and composes artists', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1440, 900);
    tester.view.devicePixelRatio = 1;
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
    await tester.tap(find.text('提示词素材').first);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('add-style')));
    await tester.pumpAndSettle();
    await tester.enterText(find.widgetWithText(TextField, '名称'), '柔光山景');
    await tester.enterText(
      find.widgetWithText(TextField, '风格正向提示词'),
      '1.2::soft lighting::\nmountains',
    );
    await tester.enterText(
      find.widgetWithText(TextField, '风格负向提示词（可选）'),
      'blur',
    );
    await tester.enterText(find.widgetWithText(TextField, '分类（可选）'), '风景');
    await tester.tap(find.widgetWithText(FilledButton, '保存'));
    await tester.pumpAndSettle();
    expect(c.promptLibrary.styles.single.name, '柔光山景');
    final before = c.prompt;
    await tester.tap(find.text('追加风格'));
    await tester.pumpAndSettle();
    expect(c.prompt, '$before, 1.2::soft lighting::\nmountains');
    expect(c.negative, endsWith(', blur'));
    await capture(tester, boundary, 'styles-desktop.png');
    await tester.tap(find.text('画师串'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('管理分组'));
    await tester.pumpAndSettle();
    await tester.enterText(find.widgetWithText(TextField, '新分组名称'), '个人收藏');
    await tester.tap(find.text('新增分组'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('完成'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('add-artist')));
    await tester.pumpAndSettle();
    await tester.enterText(find.widgetWithText(TextField, '名称'), '示例画师');
    await tester.enterText(
      find.widgetWithText(TextField, '画师标签 / 提示词'),
      'artist:fixture',
    );
    await tester.enterText(
      find.widgetWithText(TextField, '默认权重 · 0.1–8.0'),
      '1.25',
    );
    await tester.tap(find.text('个人收藏'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, '保存'));
    await tester.pumpAndSettle();
    final id = c.promptLibrary.artists.single.id;
    await tester.tap(find.byKey(ValueKey('choose-artist-$id')));
    await tester.pumpAndSettle();
    expect(find.text('1.25::artist:fixture::'), findsOneWidget);
    await tester.tap(find.text('追加到正向'));
    await tester.pumpAndSettle();
    expect(c.prompt, endsWith('1.25::artist:fixture::'));
    await capture(tester, boundary, 'artists-desktop.png');
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    c.dispose();
  });

  testWidgets(
    'capsules route negative selection correctly and fit compact high DPI',
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
      await tester.tap(find.byTooltip('打开导航'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('提示词素材').first);
      await tester.pumpAndSettle();
      await tester.tap(find.text('灵感胶囊'));
      await tester.pump();
      await tester.runAsync(() async {
        await Future<void>.delayed(const Duration(milliseconds: 500));
      });
      await tester.pumpAndSettle();
      await tester.tap(find.text('负向词'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('prompt-library-search')),
        'lowres',
      );
      await tester.pumpAndSettle();
      final item = find
          .byWidgetPredicate(
            (w) =>
                w is InkWell &&
                w.key is ValueKey<String> &&
                (w.key as ValueKey<String>).value.startsWith('capsule-'),
          )
          .first;
      expect(item, findsOneWidget);
      await tester.tap(item);
      await tester.pumpAndSettle();
      final before = c.prompt;
      await tester.tap(find.text('追加到负向'));
      await tester.pumpAndSettle();
      expect(c.prompt, before);
      expect(c.negative, contains('lowres'));
      await capture(tester, boundary, 'capsules-compact.png');
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      c.dispose();
    },
  );
}

Future<void> capture(WidgetTester tester, GlobalKey key, String name) async {
  await tester.runAsync(() async {
    final image =
        await (key.currentContext!.findRenderObject() as RenderRepaintBoundary)
            .toImage(pixelRatio: tester.view.devicePixelRatio);
    try {
      final ByteData? data = await image.toByteData(
        format: ui.ImageByteFormat.png,
      );
      final folder = Directory(
        '${Directory.current.path}/.tmp/prompt-library-ui',
      );
      await folder.create(recursive: true);
      await File('${folder.path}/$name')
          .writeAsBytes(data!.buffer.asUint8List());
    } finally {
      image.dispose();
    }
  });
}

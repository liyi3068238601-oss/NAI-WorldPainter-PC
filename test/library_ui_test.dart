import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show RenderRepaintBoundary;
import 'package:flutter/services.dart' show FontLoader, rootBundle;
import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
import 'package:worldpainter_pc/generation/service_connection.dart';
import 'package:worldpainter_pc/main.dart';
import 'package:worldpainter_pc/metadata/image_metadata_parser.dart';
import 'package:worldpainter_pc/prototype/metadata_selection_dialog.dart';
import 'package:worldpainter_pc/prototype/workbench_controller.dart';
import 'package:worldpainter_pc/references/vibe_library.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() async {
    final fontData = await rootBundle.load('assets/fonts/NotoSansSC.ttf');
    final fontLoader = FontLoader('NotoSansSC')
      ..addFont(Future<ByteData>.value(fontData));
    await fontLoader.load();
    final icons = FontLoader('MaterialIcons')
      ..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'));
    await icons.load();
  });

  testWidgets('gallery navigation, confirmed clear, and viewport screenshots', (
    tester,
  ) async {
    addTearDown(() => _resetViewport(tester));
    _setViewport(tester, const Size(1440, 900));

    final desktopController = WorkbenchController();
    final desktopBoundaryKey = GlobalKey();
    await tester.pumpWidget(
      RepaintBoundary(
        key: desktopBoundaryKey,
        child: WorldPainterApp(controller: desktopController),
      ),
    );
    await tester.pumpAndSettle();
    await _navigateToGallery(tester, const Size(1440, 900));

    expect(find.text('月下远山'), findsOneWidget);
    await _captureScreenshot(
      tester,
      desktopBoundaryKey,
      'ui-1440x900-gallery.png',
    );
    await tester.tap(find.text('清空历史'));
    await tester.pumpAndSettle();
    expect(find.text('清空 3 条图库记录？'), findsOneWidget);
    await tester.tap(find.text('确认移除记录'));
    await tester.pumpAndSettle();

    expect(desktopController.results, isEmpty);
    expect(find.text('图库还没有作品。导入一张图片，或开始创作。'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pump(const Duration(seconds: 5));
    await tester.pumpAndSettle();
    await _captureScreenshot(
      tester,
      desktopBoundaryKey,
      'ui-1440x900-empty-gallery.png',
    );

    await tester.pumpWidget(const SizedBox.shrink());

    _setViewport(tester, const Size(640, 480), devicePixelRatio: 2);
    final compactController = WorkbenchController();
    final compactBoundaryKey = GlobalKey();
    await tester.pumpWidget(
      RepaintBoundary(
        key: compactBoundaryKey,
        child: WorldPainterApp(controller: compactController),
      ),
    );
    await tester.pumpAndSettle();
    await _navigateToGallery(tester, const Size(640, 480));

    expect(find.text('图库与素材'), findsWidgets);
    expect(tester.takeException(), isNull);
    await _captureScreenshot(
      tester,
      compactBoundaryKey,
      'ui-640x480-gallery.png',
    );
  });

  testWidgets(
    'metadata dialog applies selected fields and preserves prompt and missing values',
    (tester) async {
      addTearDown(() => _resetViewport(tester));
      _setViewport(tester, const Size(1440, 900));
      final controller = WorkbenchController()
        ..updatePrompt('保留当前提示词')
        ..updateNegative('保留当前负面词')
        ..setSize(768, 1024);
      addTearDown(controller.dispose);
      final screenshotBoundaryKey = GlobalKey();
      final metadata = ImageMetadataResult(
        fields: <String, dynamic>{
          'prompt': '图片内的提示词',
          'width': 512,
          'vibe_references': <Object?>[
            <String, Object?>{'encoded_vibe': 'synthetic-vibe-fixture'},
          ],
        },
        format: 'PNG',
        source: 'synthetic fixture',
      );

      await tester.pumpWidget(
        MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: ThemeData(
            useMaterial3: true,
            fontFamily: 'NotoSansSC',
            brightness: Brightness.dark,
            colorScheme:
                ColorScheme.fromSeed(
                  seedColor: const Color(0xFFF5D57A),
                  brightness: Brightness.dark,
                ).copyWith(
                  primary: const Color(0xFFF5D57A),
                  onPrimary: const Color(0xFF211D13),
                  surface: const Color(0xFF1C1C21),
                  onSurface: const Color(0xFFF0F0F4),
                  onSurfaceVariant: const Color(0xFF92929E),
                  outlineVariant: const Color(0xFF2E2E35),
                ),
            scaffoldBackgroundColor: const Color(0xFF0A0A0C),
            textTheme: const TextTheme(
              bodyMedium: TextStyle(fontSize: 13, height: 1.55),
              bodySmall: TextStyle(fontSize: 11, height: 1.5),
              titleSmall: TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
            ),
          ),
          home: Scaffold(
            body: Builder(
              builder: (context) => Center(
                child: FilledButton(
                  onPressed: () async {
                    final selected = await showDialog<Set<String>>(
                      context: context,
                      builder: (_) => RepaintBoundary(
                        key: screenshotBoundaryKey,
                        child: MetadataSelectionDialog(metadata: metadata),
                      ),
                    );
                    if (selected != null) {
                      controller.applyMetadata(
                        metadata,
                        selectedFields: selected,
                      );
                    }
                  },
                  child: const Text('选择图片参数'),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('选择图片参数'));
      await tester.pumpAndSettle();

      final promptTile = find.widgetWithText(CheckboxListTile, '正向提示词');
      final widthTile = find.widgetWithText(CheckboxListTile, '请求宽度');
      final vibeTile = find.widgetWithText(CheckboxListTile, 'Vibe 编码参考');
      expect(tester.widget<CheckboxListTile>(promptTile).value, isTrue);
      expect(tester.widget<CheckboxListTile>(widthTile).value, isTrue);
      expect(tester.widget<CheckboxListTile>(vibeTile).value, isFalse);
      expect(find.textContaining('图片没有记录的参数保留当前值；原图不会被改写。'), findsOneWidget);
      await _captureScreenshot(
        tester,
        screenshotBoundaryKey,
        'ui-metadata-dialog-1440x900.png',
      );

      // Keep the current prompt while applying the selected width. The source
      // does not contain negative_prompt, so that current value must survive too.
      await tester.tap(promptTile);
      await tester.tap(find.text('应用所选参数'));
      await tester.pumpAndSettle();

      expect(controller.prompt, '保留当前提示词');
      expect(controller.negative, '保留当前负面词');
      expect(controller.width, 512);
      expect(controller.height, 1024);
      expect(controller.parameters.vibeReferences, isEmpty);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('Vibe library applies, renames, and deletes a named fixture', (
    tester,
  ) async {
    addTearDown(() => _resetViewport(tester));
    _setViewport(tester, const Size(1440, 900));

    final library = VibeLibrary()
      ..addPreEncodedValue(
        id: 'fixture-vibe-entry',
        title: '命名测试氛围',
        encodedValue: 'synthetic-encoded-vibe-value',
        model: 'nai-diffusion-4-5-full',
        providerProtocol: 'official',
        endpoint: Uri.parse(ServiceConnection.officialUrl),
        informationExtracted: 0.5,
      );
    final controller = WorkbenchController(vibeLibrary: library);
    final screenshotBoundaryKey = GlobalKey();
    await tester.pumpWidget(
      RepaintBoundary(
        key: screenshotBoundaryKey,
        child: WorldPainterApp(controller: controller),
      ),
    );
    await tester.pumpAndSettle();
    await _navigateToGallery(tester, const Size(1440, 900));

    await tester.tap(find.text('Vibe 编码库').first);
    await tester.pumpAndSettle();
    expect(find.text('命名测试氛围'), findsOneWidget);
    await _captureScreenshot(
      tester,
      screenshotBoundaryKey,
      'ui-vibe-dialog-1440x900.png',
    );
    final join = find.widgetWithText(FilledButton, '加入当前参考');
    expect(tester.widget<FilledButton>(join).onPressed, isNotNull);
    await tester.tap(join);
    await tester.pumpAndSettle();

    expect(controller.parameters.vibeReferences, hasLength(1));
    expect(
      controller.parameters.vibeReferences.single.encodedVibe,
      'synthetic-encoded-vibe-value',
    );

    await _navigateToGallery(tester, const Size(1440, 900));
    await tester.tap(find.text('Vibe 编码库').first);
    await tester.pumpAndSettle();
    await tester.tap(find.text('重命名'));
    await tester.pumpAndSettle();
    final renameDialog = find.byType(AlertDialog).last;
    await tester.enterText(
      find.descendant(of: renameDialog, matching: find.byType(TextFormField)),
      '已重命名氛围',
    );
    await tester.tap(find.text('保存名称'));
    await tester.pumpAndSettle();
    expect(controller.vibeLibrary.entries.single.title, '已重命名氛围');
    expect(find.text('已重命名氛围'), findsOneWidget);

    await tester.tap(find.text('删除'));
    await tester.pumpAndSettle();
    expect(find.text('删除这份编码？'), findsOneWidget);
    await tester.tap(find.text('删除编码'));
    await tester.pumpAndSettle();
    expect(controller.vibeLibrary.entries, isEmpty);
    expect(find.textContaining('还没有保存的氛围'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('Vibe library disables applying a scope-mismatched fixture', (
    tester,
  ) async {
    addTearDown(() => _resetViewport(tester));
    _setViewport(tester, const Size(1440, 900));
    final library = VibeLibrary()
      ..addPreEncodedValue(
        id: 'fixture-vibe-mismatch',
        title: '不兼容测试氛围',
        encodedValue: 'synthetic-mismatched-vibe-value',
        model: 'different-model',
        providerProtocol: 'official',
        endpoint: Uri.parse(ServiceConnection.officialUrl),
        informationExtracted: 0.5,
      );
    final controller = WorkbenchController(vibeLibrary: library);
    await tester.pumpWidget(WorldPainterApp(controller: controller));
    await tester.pumpAndSettle();
    await _navigateToGallery(tester, const Size(1440, 900));

    await tester.tap(find.text('Vibe 编码库').first);
    await tester.pumpAndSettle();

    expect(find.text('不兼容测试氛围'), findsOneWidget);
    expect(find.textContaining('当前模型或服务地址不同'), findsOneWidget);
    final join = find.widgetWithText(FilledButton, '加入当前参考');
    expect(tester.widget<FilledButton>(join).onPressed, isNull);
    expect(tester.takeException(), isNull);
  });
}

Future<void> _navigateToGallery(WidgetTester tester, Size logicalSize) async {
  if (logicalSize.width < 700) {
    await tester.tap(find.byTooltip('打开导航'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('图库与素材').first);
  } else {
    await tester.tap(find.text('图库与素材').first);
  }
  await tester.pumpAndSettle();
}

void _setViewport(
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

void _resetViewport(WidgetTester tester) {
  tester.view.resetPhysicalSize();
  tester.view.resetDevicePixelRatio();
}

Future<void> _captureScreenshot(
  WidgetTester tester,
  GlobalKey boundaryKey,
  String name,
) async {
  await tester.runAsync<void>(() async {
    final boundary = boundaryKey.currentContext?.findRenderObject();
    if (boundary is! RenderRepaintBoundary) {
      throw StateError('The app screenshot boundary was not mounted.');
    }
    final image = await boundary.toImage(
      pixelRatio: tester.view.devicePixelRatio,
    );
    try {
      final data = await image.toByteData(format: ui.ImageByteFormat.png);
      if (data == null) {
        throw StateError('Could not encode the UI screenshot.');
      }
      final outputDirectory = Directory(
        p.join(Directory.current.path, '.tmp', 'asset-library'),
      );
      await outputDirectory.create(recursive: true);
      final workspaceRoot = p.normalize(
        await Directory.current.resolveSymbolicLinks(),
      );
      final resolvedOutputDirectory = p.normalize(
        await outputDirectory.resolveSymbolicLinks(),
      );
      if (p.equals(workspaceRoot, resolvedOutputDirectory) ||
          !p.isWithin(workspaceRoot, resolvedOutputDirectory)) {
        throw StateError(
          'Refusing to write a screenshot outside the workspace.',
        );
      }
      final screenshotPath = p.join(outputDirectory.path, name);
      final existingType = await FileSystemEntity.type(
        screenshotPath,
        followLinks: false,
      );
      if (existingType != FileSystemEntityType.notFound &&
          existingType != FileSystemEntityType.file) {
        throw StateError('Refusing to replace a non-file screenshot target.');
      }
      await File(screenshotPath).writeAsBytes(
        data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes),
        flush: true,
      );
    } finally {
      image.dispose();
    }
  });
}

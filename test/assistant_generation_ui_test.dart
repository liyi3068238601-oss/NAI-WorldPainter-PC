import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:worldpainter_pc/assistant/assistant_controller.dart';
import 'package:worldpainter_pc/media/image_asset_store.dart';
import 'package:worldpainter_pc/prototype/assistant_panel.dart';
import 'package:worldpainter_pc/prototype/stored_image.dart';
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

  testWidgets(
    'image confirmation previews submitted image, distinct original, mask, and fields in a scrollable 640x480 window',
    (tester) async {
      tester.view.physicalSize = const Size(1280, 960);
      tester.view.devicePixelRatio = 2;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      const submittedRef = r'C:\private\submitted-crop.png';
      const originalRef = r'C:\private\original-source.png';
      const maskRef = r'C:\private\redraw-mask.png';
      final assets = _MemoryImageAssets({
        submittedRef: _transparentPng,
        originalRef: _transparentPng,
        maskRef: _transparentPng,
      });
      final workbench = WorkbenchController(assets: assets);
      final interaction = AssistantInteraction(
        title: '即将对选定区域执行重绘',
        preview: {
          '模式': '重绘',
          'assetRef': submittedRef,
          'maskAssetRef': maskRef,
          'originalAssetRef': originalRef,
          'sourceCaption': '图库中的「夜色庭院」',
          '强度': 0.72,
          '渠道': 'NovelAI 官方',
          '模型': 'NAI Diffusion 4.5 Full',
          '尺寸': '832 × 1216',
          '张数': 2,
          '步数': 28,
          'CFG': 5,
          'Seed': 12345,
          '正向': '夜色庭院，暖色灯笼，细腻笔触',
          '负向': '低清晰度，模糊，文字，水印',
          '输出区域': '画面左侧窗台',
          '忽略原图': false,
          '色彩校正': true,
        },
      );
      workbench.assistant.interaction = interaction;
      workbench.assistant.changed();

      await tester.pumpWidget(_assistantApp(workbench));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('查看并确认'));
      await tester.tap(find.text('查看并确认'));
      await tester.pumpAndSettle();

      expect(find.text('确认图像操作'), findsOneWidget);
      expect(
        find.descendant(
          of: find.byType(AlertDialog),
          matching: find.text('即将对选定区域执行重绘'),
        ),
        findsOneWidget,
      );
      expect(find.text('源图标签'), findsOneWidget);
      expect(find.text('图库中的「夜色庭院」'), findsOneWidget);
      expect(find.text('本次输入图像'), findsOneWidget);
      expect(find.text('原始底图'), findsOneWidget);
      expect(find.text('黑白蒙版'), findsOneWidget);
      expect(find.text('输出区域'), findsOneWidget);
      expect(find.text('忽略原图'), findsOneWidget);
      expect(find.text('色彩校正'), findsOneWidget);

      final imageRefs = tester
          .widgetList<StoredImage>(find.byType(StoredImage))
          .map((image) => image.assetRef)
          .toSet();
      expect(imageRefs, {submittedRef, originalRef, maskRef});
      expect(assets.readRefs.toSet(), {submittedRef, originalRef, maskRef});
      expect(find.text(submittedRef), findsNothing);
      expect(find.text(originalRef), findsNothing);
      expect(find.text(maskRef), findsNothing);

      final scroll = find.byKey(const ValueKey('assistant-interaction-scroll'));
      expect(tester.getSize(scroll).height, lessThan(300));
      await tester.ensureVisible(find.text('色彩校正'));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);

      await tester.tap(find.text('拒绝'));
      await tester.pumpAndSettle();
      expect(await interaction.response.future, isNull);

      await tester.pumpWidget(const SizedBox());
      workbench.dispose();
    },
  );

  testWidgets(
    'legacy upscale assetRef preview remains visible and confirmable',
    (tester) async {
      tester.view.physicalSize = const Size(1440, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      const sourceRef = r'C:\private\gallery-source.png';
      final assets = _MemoryImageAssets({sourceRef: _transparentPng});
      final workbench = WorkbenchController(assets: assets);
      final interaction = AssistantInteraction(
        title: '本地超分 · Real-CUGAN 保守 2× · 夜色庭院',
        preview: {
          '图片 ID': 'gallery-image-1',
          '图片': '夜色庭院',
          'assetRef': sourceRef,
          '模型': 'Real-CUGAN 保守 2×',
          '倍率': '2×',
          '输入尺寸': '832 × 1216',
          '预期输出尺寸': '1664 × 2432',
          '处理方式': 'Windows 本机处理，不调用远程图片服务',
        },
      );
      workbench.assistant.interaction = interaction;
      workbench.assistant.changed();

      await tester.pumpWidget(_assistantApp(workbench));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('查看并确认'));
      await tester.tap(find.text('查看并确认'));
      await tester.pumpAndSettle();

      expect(find.text('确认图像操作'), findsOneWidget);
      expect(find.text('本次输入图像'), findsOneWidget);
      expect(find.text('Real-CUGAN 保守 2×'), findsOneWidget);
      expect(find.text('1664 × 2432'), findsOneWidget);
      expect(
        tester
            .widgetList<StoredImage>(find.byType(StoredImage))
            .single
            .assetRef,
        sourceRef,
      );
      expect(find.text(sourceRef), findsNothing);

      await tester.tap(find.text('确认执行'));
      await tester.pumpAndSettle();
      expect(await interaction.response.future, 'approve');

      await tester.pumpWidget(const SizedBox());
      workbench.dispose();
    },
  );
}

Widget _assistantApp(WorkbenchController workbench) => MaterialApp(
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
);

const _transparentPng = <int>[
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  0x00,
  0x00,
  0x00,
  0x0d,
  0x49,
  0x48,
  0x44,
  0x52,
  0x00,
  0x00,
  0x00,
  0x01,
  0x00,
  0x00,
  0x00,
  0x01,
  0x08,
  0x06,
  0x00,
  0x00,
  0x00,
  0x1f,
  0x15,
  0xc4,
  0x89,
  0x00,
  0x00,
  0x00,
  0x0a,
  0x49,
  0x44,
  0x41,
  0x54,
  0x78,
  0x9c,
  0x63,
  0x60,
  0x00,
  0x02,
  0x00,
  0x00,
  0x05,
  0x00,
  0x01,
  0xa5,
  0xf6,
  0x45,
  0x40,
  0x00,
  0x00,
  0x00,
  0x00,
  0x49,
  0x45,
  0x4e,
  0x44,
  0xae,
  0x42,
  0x60,
  0x82,
];

class _MemoryImageAssets implements ImageAssetStore {
  _MemoryImageAssets(Map<String, List<int>> bytes)
    : _bytes = {
        for (final entry in bytes.entries)
          entry.key: Uint8List.fromList(entry.value),
      };

  final Map<String, Uint8List> _bytes;
  final List<String> readRefs = [];

  @override
  String get label => 'Widget 测试内存图片';

  @override
  Future<ImageAsset> save(Uint8List bytes) async => ImageAsset(
    id: 'widget-test-image',
    assetRef: 'widget-test://saved-image',
    width: 1,
    height: 1,
    mime: 'image/png',
    sha256: List.filled(64, '0').join(),
    byteLength: bytes.length,
  );

  @override
  Future<Uint8List> read(String assetRef) {
    readRefs.add(assetRef);
    final bytes = _bytes[assetRef];
    if (bytes == null) {
      return Future<Uint8List>.error(ImageAssetNotFoundException(assetRef));
    }
    return Future<Uint8List>.value(Uint8List.fromList(bytes));
  }

  @override
  Future<void> close() async {}
}

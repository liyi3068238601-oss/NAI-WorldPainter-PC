import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:archive/archive.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:worldpainter_pc/assistant/agent_contract.dart';
import 'package:worldpainter_pc/assistant/wd_tagger.dart';
import 'package:worldpainter_pc/main.dart';
import 'package:worldpainter_pc/media/image_asset_store.dart';
import 'package:worldpainter_pc/prototype/workbench_controller.dart';
import 'package:worldpainter_pc/tags/image_tag_review.dart';

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
    'real workbench navigation reads synthetic metadata and confirms prompt writes',
    (tester) async {
      _setViewport(tester, const Size(1440, 900), 1);
      final harness = (await tester.runAsync(_createHarness))!;
      final boundary = GlobalKey();
      await _openApp(tester, harness.workbench, boundary);
      await _openImageTagPage(tester);
      await _chooseSyntheticGalleryImage(tester, harness);

      final analyze = find.byKey(const ValueKey('image-tag-analyze'));
      expect(
        ImageTagReviewState.fromJson(harness.workbench.imageTagReview)
            .sourceAssetRef,
        isNotNull,
      );
      final analyzeAction = tester.widget<FilledButton>(analyze).onPressed;
      expect(analyzeAction, isNotNull);
      await _invokeActionUntil(
        tester,
        analyzeAction!,
        () =>
            ImageTagReviewState.fromJson(harness.workbench.imageTagReview)
                .analyzed,
      );

      final state = ImageTagReviewState.fromJson(
        harness.workbench.imageTagReview,
      );
      final errorFinder = find.byKey(const ValueKey('image-tag-error'));
      final errorMessage = errorFinder.evaluate().isEmpty
          ? null
          : tester.widget<Text>(errorFinder).data;
      expect(state.analyzed, isTrue, reason: 'review error: $errorMessage');
      expect(state.metadataSource, 'png-text');
      expect(state.metadataFields['seed'], 28471);
      expect(find.byKey(const ValueKey('image-tag-general-0')), findsOneWidget);
      expect(find.textContaining('来源 png-text'), findsOneWidget);
      expect(find.textContaining('Seed 28471'), findsOneWidget);
      expect(
        state.generalTags.map((tag) => tag.tag),
        _positiveFixtureTags.take(3),
      );
      expect(state.characterTags.single.tag, _positiveFixtureTags.last);
      await _capture(tester, boundary, 'weighted-metadata-review.png');

      final generalInvert = find.widgetWithText(TextButton, '反选').first;
      await tester.ensureVisible(generalInvert);
      await tester.tap(generalInvert);
      await tester.pump();
      expect(_selected(tester, 'image-tag-general-0'), isFalse);
      await tester.ensureVisible(find.widgetWithText(TextButton, '全选').first);
      await tester.tap(find.widgetWithText(TextButton, '全选').first);
      await tester.pump();
      expect(_selected(tester, 'image-tag-general-0'), isTrue);
      expect(_selected(tester, 'image-tag-general-1'), isTrue);

      final clipboard = <String>[];
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
        if (call.method == 'Clipboard.setData') {
          clipboard.add(
            (call.arguments as Map<Object?, Object?>)['text'] as String,
          );
        }
        return null;
      });
      addTearDown(
        () => messenger.setMockMethodCallHandler(SystemChannels.platform, null),
      );
      final copyButton = find.byKey(const ValueKey('image-tag-copy'));
      await tester.ensureVisible(copyButton);
      await tester.tap(copyButton);
      await _pumpUi(tester);
      expect(clipboard, hasLength(1));
      expect(clipboard.single, contains(_weightedPrompt));
      expect(clipboard.single, contains('【正向】'));
      expect(clipboard.single, contains('lowres, bad_hands'));

      harness.workbench
        ..updatePrompt('保留的正向草稿')
        ..updateNegative('保留的负向草稿');
      await tester.pump();
      final apply = find.byKey(const ValueKey('image-tag-apply'));
      await tester.ensureVisible(apply);
      await tester.tap(apply);
      await _pumpUi(tester);
      expect(
        find.byKey(const ValueKey('image-tag-prompt-confirmation')),
        findsOneWidget,
      );
      _expectPromptPreview(
        tester,
        before: '保留的正向草稿',
        after: '保留的正向草稿, ${_positiveFixtureTags.join(', ')}',
      );
      await _capture(tester, boundary, 'append-confirmation.png');
      await tester.tap(find.byKey(const ValueKey('image-tag-prompt-cancel')));
      await _pumpUi(tester);
      expect(harness.workbench.prompt, '保留的正向草稿');
      expect(
        find.byKey(const ValueKey('image-tag-prompt-confirmation')),
        findsNothing,
      );

      await tester.tap(find.text('替换'));
      await tester.pump();
      expect(
        tester
            .widget<SegmentedButton<bool>>(
              find.byKey(const ValueKey('image-tag-write-mode')),
            )
            .selected,
        contains(true),
      );
      await tester.ensureVisible(find.byKey(const ValueKey('image-tag-apply')));
      await tester.tap(find.byKey(const ValueKey('image-tag-apply')));
      await _pumpUi(tester);
      _expectPromptPreview(
        tester,
        before: '保留的正向草稿',
        after: _positiveFixtureTags.join(', '),
      );
      await tester.tap(find.byKey(const ValueKey('image-tag-prompt-approve')));
      await _pumpUi(tester);
      expect(harness.workbench.prompt, _positiveFixtureTags.join(', '));

      await _selectPromptTarget(tester, 'positive', '负向词框');
      await tester.ensureVisible(find.byKey(const ValueKey('image-tag-apply')));
      await tester.tap(find.byKey(const ValueKey('image-tag-apply')));
      await _pumpUi(tester);
      _expectPromptPreview(
        tester,
        before: '保留的负向草稿',
        after: 'lowres, bad_hands, extra_fingers',
      );
      await tester.tap(find.byKey(const ValueKey('image-tag-prompt-approve')));
      await _pumpUi(tester);
      expect(harness.workbench.negative, 'lowres, bad_hands, extra_fingers');

      await _selectPromptTarget(tester, 'negative', '角色 1 正向词框');
      await tester.ensureVisible(find.byKey(const ValueKey('image-tag-apply')));
      await tester.tap(find.byKey(const ValueKey('image-tag-apply')));
      await _pumpUi(tester);
      expect(find.text('确认替换 角色 1 正向词框'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('image-tag-prompt-approve')));
      await _pumpUi(tester);
      expect(
        harness.workbench.parameters.characters.single.prompt,
        _positiveFixtureTags.join(', '),
      );
      expect(tester.takeException(), isNull);
      await _disposeHarness(tester, harness.workbench, harness.directory);
    },
  );

  testWidgets('640x480 logical viewport at DPR 2 remains scrollable', (
    tester,
  ) async {
    _setViewport(tester, const Size(1280, 960), 2);
    final harness = (await tester.runAsync(_createHarness))!;
    await _openApp(tester, harness.workbench, GlobalKey());
    await _openImageTagPage(tester, compact: true);
    await _chooseSyntheticGalleryImage(tester, harness);
    final analyzeFinder = find.byKey(const ValueKey('image-tag-analyze'));
    await tester.scrollUntilVisible(
      analyzeFinder,
      280,
      scrollable: find.byType(Scrollable).last,
    );
    await tester.pump();
    final analyze = tester.widget<FilledButton>(analyzeFinder);
    await _invokeActionUntil(
      tester,
      analyze.onPressed!,
      () =>
          ImageTagReviewState.fromJson(harness.workbench.imageTagReview)
              .analyzed,
    );

    expect(find.byType(Scrollable), findsWidgets);
    final apply = find.byKey(const ValueKey('image-tag-apply'));
    await tester.scrollUntilVisible(
      apply,
      280,
      scrollable: find.byType(Scrollable).last,
    );
    await tester.pump();
    expect(apply, findsOneWidget);
    expect(tester.takeException(), isNull);
    await _disposeHarness(tester, harness.workbench, harness.directory);
  });

  testWidgets('leaving review cancels pending WD and ignores its late result', (
    tester,
  ) async {
    _setViewport(tester, const Size(1440, 900), 1);
    final wd = _PendingWdTagger();
    final harness = (await tester.runAsync(
      () => _createHarness(wdTagger: wd),
    ))!;
    await _openApp(tester, harness.workbench, GlobalKey());
    await _openImageTagPage(tester);
    await _chooseSyntheticGalleryImage(tester, harness);
    await tester.tap(find.text('在线 WD-Tagger'));
    await _pumpUi(tester);
    final analyze = tester.widget<FilledButton>(
      find.byKey(const ValueKey('image-tag-analyze')),
    );
    await _invokeActionUntil(
      tester,
      analyze.onPressed!,
      () => wd.cancellation != null,
    );
    expect(wd.cancellation, isNotNull);

    await _goToWorkbench(tester);
    expect(wd.cancellation!.isCancelled, isTrue);
    wd.pending.complete(
      WdTaggerResult(
        caption: 'synthetic late response',
        generalTags: {'late_tag': .99},
        characterTags: const {},
        ratingTags: const {},
      ),
    );
    await _pumpUi(tester);

    final state = ImageTagReviewState.fromJson(
      harness.workbench.imageTagReview,
    );
    expect(state.analyzed, isFalse);
    expect(state.generalTags, isEmpty);
    expect(tester.takeException(), isNull);
    await _disposeHarness(tester, harness.workbench, harness.directory);
  });

  testWidgets(
    'leaving review cancels pending translation and ignores late JSON',
    (tester) async {
      _setViewport(tester, const Size(1440, 900), 1);
      final transport = _PendingAgentTransport();
      final harness = (await tester.runAsync(
        () => _createHarness(transport: transport),
      ))!;
      await _openApp(tester, harness.workbench, GlobalKey());
      await _openImageTagPage(tester);
      await _chooseSyntheticGalleryImage(tester, harness);
      final analyze = tester.widget<FilledButton>(
        find.byKey(const ValueKey('image-tag-analyze')),
      );
      await _invokeActionUntil(
        tester,
        analyze.onPressed!,
        () =>
            ImageTagReviewState.fromJson(harness.workbench.imageTagReview)
                .analyzed,
      );
      final translate = find.byKey(const ValueKey('image-tag-translate'));
      await tester.ensureVisible(translate);
      final translateAction = tester
          .widget<OutlinedButton>(translate)
          .onPressed;
      expect(translateAction, isNotNull);
      await _invokeActionUntil(
        tester,
        translateAction!,
        () => transport.cancellation != null,
      );
      expect(transport.tools.single, isEmpty);
      expect(transport.toolChoices.single, 'none');

      await _goToWorkbench(tester);
      expect(transport.cancellation!.isCancelled, isTrue);
      transport.pending.complete(
        const AgentReply(content: '{"1.2::{red hair,\nblue eyes}::":"迟到翻译"}'),
      );
      await _pumpUi(tester);

      final state = ImageTagReviewState.fromJson(
        harness.workbench.imageTagReview,
      );
      expect(state.translations, isEmpty);
      expect(state.generalTags.first.tag, _positiveFixtureTags.first);
      expect(tester.takeException(), isNull);
      await _disposeHarness(tester, harness.workbench, harness.directory);
    },
  );
}

const String _weightedPrompt =
    '1.2::{red hair,\nblue eyes}::, [long hair, wavy hair], (smile, open mouth)';
const List<String> _positiveFixtureTags = [
  '1.2::{red hair,\nblue eyes}::',
  '[long hair, wavy hair]',
  '(smile, open mouth)',
  '3::red coat, silver trim::',
];

Future<_Harness> _createHarness({
  WdTaggerClient? wdTagger,
  AgentTransport? transport,
}) async {
  final root = await Directory('.tmp/assistant-tag-ui').absolute
      .create(recursive: true);
  final directory = await root.createTemp('assets-');
  final diskAssets = await openImageAssetStore(directory: directory.path);
  final bytes = _fixturePng();
  final storedAsset = await diskAssets.save(bytes);
  final assets = _SyntheticImageAssetStore(
    delegate: diskAssets,
    initialAssetRef: storedAsset.assetRef,
    initialBytes: bytes,
  );
  final workbench =
      WorkbenchController(
          assets: assets,
          wdTaggerClient: wdTagger,
          assistantTransport: transport,
        )
        ..updatePrompt('保留的正向草稿')
        ..updateNegative('保留的负向草稿');
  workbench.assistant.state.providers.add(
    const AssistantProvider(
      id: 'synthetic-main',
      name: '合成主模型',
      baseUrl: 'https://assistant.example.test/v1',
      model: 'synthetic',
      requireKey: false,
    ),
  );
  workbench.assistant.state.mainProviderId = 'synthetic-main';
  workbench.assistant.changed();

  workbench.addImported(storedAsset, title: 'Synthetic NAI 权重测试图');
  return _Harness(
    workbench: workbench,
    assets: assets,
    directory: directory,
    sourceId: workbench.results.first.id,
  );
}

Future<void> _openApp(
  WidgetTester tester,
  WorkbenchController workbench,
  GlobalKey boundary,
) async {
  await tester.pumpWidget(
    RepaintBoundary(
      key: boundary,
      child: WorldPainterApp(controller: workbench),
    ),
  );
  await _pumpUi(tester);
}

Future<void> _openImageTagPage(
  WidgetTester tester, {
  bool compact = false,
}) async {
  if (compact) {
    await tester.tap(find.byTooltip('打开导航'));
    for (var frame = 0; frame < 10; frame++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
  }
  final entry = find.text('图片反推').first;
  await tester.ensureVisible(entry);
  await tester.tap(entry);
  await _pumpUi(tester);
  if (compact) {
    for (var frame = 0; frame < 10; frame++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(find.text('图片反推审阅'), findsOneWidget);
    expect(find.byKey(const ValueKey('image-tag-gallery')), findsOneWidget);
  } else {
    expect(find.byKey(const ValueKey('image-tag-mode')), findsOneWidget);
  }
}

Future<void> _chooseSyntheticGalleryImage(
  WidgetTester tester,
  _Harness harness,
) async {
  final galleryButton = find.byKey(const ValueKey('image-tag-gallery'));
  await tester.scrollUntilVisible(
    galleryButton,
    200,
    scrollable: find.byType(Scrollable).last,
  );
  await tester.pump();
  await tester.tap(galleryButton);
  await _pumpUi(tester);
  await tester.tap(
    find.byKey(ValueKey('image-tag-source-${harness.sourceId}')),
  );
  await _pumpUi(tester);
  expect(find.text('Synthetic NAI 权重测试图'), findsOneWidget);
}

Future<void> _selectPromptTarget(
  WidgetTester tester,
  String current,
  String nextLabel,
) async {
  final dropdown = find.byKey(ValueKey('image-tag-target-$current'));
  await tester.ensureVisible(dropdown);
  await tester.tap(dropdown);
  await _pumpUi(tester);
  await tester.tap(find.text(nextLabel).last);
  await _pumpUi(tester);
}

Future<void> _goToWorkbench(WidgetTester tester) async {
  await tester.tap(find.text('创作工作台').first);
  await _pumpUi(tester);
}

bool _selected(WidgetTester tester, String key) => tester
    .widget<FilterChip>(
      find.descendant(
        of: find.byKey(ValueKey(key)),
        matching: find.byType(FilterChip),
      ),
    )
    .selected;

void _expectPromptPreview(
  WidgetTester tester, {
  required String before,
  required String after,
}) {
  final previews = tester
      .widgetList<SelectableText>(find.byType(SelectableText))
      .map((widget) => widget.data ?? '')
      .toList();
  expect(previews, contains(before));
  expect(previews, contains(after));
}

Future<void> _pumpUi(WidgetTester tester) async {
  await tester.pump(const Duration(milliseconds: 400));
  await tester.pump();
}

Future<void> _invokeActionUntil(
  WidgetTester tester,
  VoidCallback action,
  bool Function() predicate,
) async {
  final finished = await tester.runAsync(() async {
    action();
    for (var attempt = 0; attempt < 150 && !predicate(); attempt++) {
      await Future<void>.delayed(const Duration(milliseconds: 20));
    }
    return predicate();
  });
  await _pumpUi(tester);
  final errorFinder = find.byKey(const ValueKey('image-tag-error'));
  final errorMessage = errorFinder.evaluate().isEmpty
      ? null
      : tester.widget<Text>(errorFinder).data;
  expect(
    finished,
    isTrue,
    reason:
        'asynchronous UI action did not finish; error=$errorMessage; '
        'analyzing=${find.text("分析中…").evaluate().isNotEmpty}',
  );
}

Future<void> _disposeHarness(
  WidgetTester tester,
  WorkbenchController workbench,
  Directory directory,
) async {
  await tester.runAsync(() async {
    if (!workbench.closing) await workbench.closeStorage();
  });
  await tester.pumpWidget(const SizedBox.shrink());
  workbench.dispose();
  await tester.runAsync(() => directory.delete(recursive: true));
}

void _setViewport(WidgetTester tester, Size physicalSize, double dpr) {
  tester.view.physicalSize = physicalSize;
  tester.view.devicePixelRatio = dpr;
  addTearDown(() {
    tester.view.resetPhysicalSize();
    tester.view.resetDevicePixelRatio();
  });
}

Future<void> _capture(
  WidgetTester tester,
  GlobalKey boundary,
  String name,
) async {
  await tester.runAsync(() async {
    final image =
        (boundary.currentContext!.findRenderObject()! as RenderRepaintBoundary)
            .toImage(pixelRatio: tester.view.devicePixelRatio);
    final snapshot = await image;
    try {
      final bytes = await snapshot.toByteData(format: ui.ImageByteFormat.png);
      final output = File('.tmp/assistant-tag-ui/$name');
      await output.parent.create(recursive: true);
      await output.writeAsBytes(bytes!.buffer.asUint8List());
    } finally {
      snapshot.dispose();
    }
  });
}

Uint8List _fixturePng() {
  const width = 64;
  const height = 64;
  final header = ByteData(13)
    ..setUint32(0, width, Endian.big)
    ..setUint32(4, height, Endian.big)
    ..setUint8(8, 8)
    ..setUint8(9, 6)
    ..setUint8(10, 0)
    ..setUint8(11, 0)
    ..setUint8(12, 0);
  final chunks = <List<int>>[
    _pngChunk('IHDR', header.buffer.asUint8List()),
    _pngChunk('tEXt', [
      ...latin1.encode('Comment'),
      0,
      ...utf8.encode(
        jsonEncode({
          'prompt': _weightedPrompt,
          'uc': 'lowres, bad_hands',
          'seed': 28471,
          'width': width,
          'height': height,
          'steps': 24,
          'model': 'nai-diffusion-4-5-full',
          'characters': [
            {'prompt': '3::red coat, silver trim::', 'uc': 'extra_fingers'},
          ],
        }),
      ),
    ]),
  ];
  final scanlines = Uint8List(height * (width * 4 + 1));
  for (var y = 0; y < height; y++) {
    final row = y * (width * 4 + 1);
    scanlines[row] = 0;
    for (var x = 0; x < width; x++) {
      final pixel = row + 1 + x * 4;
      scanlines.setRange(pixel, pixel + 4, const [112, 139, 168, 255]);
    }
  }
  chunks.add(_pngChunk('IDAT', const ZLibEncoder().encodeBytes(scanlines)));
  chunks.add(_pngChunk('IEND', const []));
  return Uint8List.fromList([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...chunks.expand((chunk) => chunk),
  ]);
}

List<int> _pngChunk(String type, List<int> data) {
  final size = ByteData(4)..setUint32(0, data.length, Endian.big);
  final typeBytes = latin1.encode(type);
  final checksum = _crc32([...typeBytes, ...data]);
  final crc = ByteData(4)..setUint32(0, checksum, Endian.big);
  return [
    ...size.buffer.asUint8List(),
    ...typeBytes,
    ...data,
    ...crc.buffer.asUint8List(),
  ];
}

int _crc32(List<int> bytes) {
  var crc = 0xffffffff;
  for (final byte in bytes) {
    crc ^= byte;
    for (var bit = 0; bit < 8; bit++) {
      crc = (crc & 1) == 1 ? (crc >> 1) ^ 0xedb88320 : crc >> 1;
    }
  }
  return crc ^ 0xffffffff;
}

class _Harness {
  const _Harness({
    required this.workbench,
    required this.assets,
    required this.directory,
    required this.sourceId,
  });

  final WorkbenchController workbench;
  final ImageAssetStore assets;
  final Directory directory;
  final String sourceId;
}

class _SyntheticImageAssetStore implements ImageAssetStore {
  _SyntheticImageAssetStore({
    required this.delegate,
    required String initialAssetRef,
    required Uint8List initialBytes,
  }) : _assets = {initialAssetRef: Uint8List.fromList(initialBytes)};

  final ImageAssetStore delegate;
  final Map<String, Uint8List> _assets;

  @override
  String get label => 'synthetic test image assets';

  @override
  Future<ImageAsset> save(Uint8List bytes) async {
    final asset = await delegate.save(bytes);
    _assets[asset.assetRef] = Uint8List.fromList(bytes);
    return asset;
  }

  @override
  Future<Uint8List> read(String assetRef) async {
    final bytes = _assets[assetRef];
    if (bytes != null) return Uint8List.fromList(bytes);
    return delegate.read(assetRef);
  }

  @override
  Future<void> close() => delegate.close();
}

class _PendingWdTagger extends WdTaggerClient {
  final Completer<WdTaggerResult> pending = Completer<WdTaggerResult>();
  AgentCancellation? cancellation;

  @override
  Future<WdTaggerResult> analyze({
    required Uint8List bytes,
    required WdTaggerSettings settings,
    required AgentCancellation cancellation,
  }) {
    this.cancellation = cancellation;
    return pending.future;
  }
}

class _PendingAgentTransport implements AgentTransport {
  final Completer<AgentReply> pending = Completer<AgentReply>();
  final tools = <List<Map<String, dynamic>>>[];
  final toolChoices = <String>[];
  AgentCancellation? cancellation;

  @override
  Future<AgentReply> complete({
    required AssistantProvider provider,
    required List<Map<String, dynamic>> messages,
    required List<Map<String, dynamic>> tools,
    required String toolChoice,
    required AgentCancellation cancellation,
    void Function(String accumulatedText)? onText,
  }) {
    this.cancellation = cancellation;
    this.tools.add(tools);
    toolChoices.add(toolChoice);
    return pending.future;
  }
}

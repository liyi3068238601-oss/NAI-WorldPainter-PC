import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:worldpainter_pc/assistant/agent_contract.dart';
import 'package:worldpainter_pc/main.dart';
import 'package:worldpainter_pc/prototype/workbench_controller.dart';
import 'package:worldpainter_pc/tags/danbooru_client.dart';

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

  testWidgets('searches Chinese and English only on explicit submit', (
    tester,
  ) async {
    _setViewport(tester, const Size(1440, 900), 1);
    final client = _FakeDanbooruSearchClient()
      ..handler = (call) async => _result(
        query: call.query,
        source: 'third-party-index.example',
        tags: call.query == 'not found'
            ? const []
            : [_tag(tag: call.query == 'moonlight' ? 'white_serafuku' : '月光')],
      );
    final controller = WorkbenchController(tagSearchClient: client);
    final boundary = GlobalKey();
    await _openTagSearch(tester, controller, boundary);
    expect(find.byKey(const ValueKey('tag-search-initial')), findsOneWidget);

    final input = find.byKey(const ValueKey('tag-search-input'));
    await tester.enterText(input, 'moonlight');
    await tester.pumpAndSettle();
    expect(client.calls, isEmpty, reason: 'editing the query must not search');
    await tester.tap(find.byKey(const ValueKey('tag-search-submit')));
    await tester.pumpAndSettle();
    expect(client.calls.single.query, 'moonlight');
    expect(client.calls.single.limit, 30);
    expect(client.calls.single.showNsfw, isTrue);
    expect(
      find.byKey(const ValueKey('tag-search-prompt-text-0')),
      findsOneWidget,
    );
    expect(find.textContaining('第三方标签索引'), findsOneWidget);
    expect(
      find.textContaining('索引来源：third-party-index.example'),
      findsOneWidget,
    );
    expect(find.textContaining('查询发送到：'), findsOneWidget);
    await _capture(tester, boundary, 'english-results.png');

    await tester.ensureVisible(find.byKey(const ValueKey('tag-search-copy-0')));
    final copied = <String>[];
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.setData') {
        copied.add((call.arguments as Map<Object?, Object?>)['text'] as String);
      }
      return null;
    });
    addTearDown(
      () => messenger.setMockMethodCallHandler(SystemChannels.platform, null),
    );
    await tester.tap(find.byKey(const ValueKey('tag-search-copy-0')));
    await tester.pumpAndSettle();
    expect(copied, contains('white serafuku'));

    await tester.ensureVisible(
      find.byKey(const ValueKey('tag-search-result-0')),
    );
    await tester.tap(find.byKey(const ValueKey('tag-search-result-0')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('tag-search-details')), findsOneWidget);
    expect(find.byKey(const ValueKey('tag-search-wiki')), findsOneWidget);
    expect(find.byType(SingleChildScrollView), findsWidgets);
    expect(
      tester
          .widget<SelectableText>(find.byKey(const ValueKey('tag-search-wiki')))
          .data,
      contains('全量 Wiki 释义'),
    );
    await _capture(tester, boundary, 'tag-details.png');
    await tester.tap(find.byKey(const ValueKey('tag-search-details-close')));
    await tester.pumpAndSettle();

    await tester.enterText(input, '月光');
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('tag-search-result-0')), findsNothing);
    expect(client.calls, hasLength(1));
    await tester.tap(find.byKey(const ValueKey('tag-search-submit')));
    await tester.pumpAndSettle();
    expect(client.calls, hasLength(2));
    expect(client.calls.last.query, '月光');
    expect(
      find.byKey(const ValueKey('tag-search-prompt-text-0')),
      findsOneWidget,
    );

    await tester.enterText(input, 'not found');
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('tag-search-submit')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('tag-search-empty')), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('settings save endpoint and NSFW choice before searching', (
    tester,
  ) async {
    _setViewport(tester, const Size(1440, 900), 1);
    final client = _FakeDanbooruSearchClient()
      ..handler = (call) async => _result(
        query: call.query,
        source: 'configured-index.example',
        tags: [_tag(tag: 'blue_eyes')],
      );
    final controller = WorkbenchController(tagSearchClient: client);
    await _openTagSearch(tester, controller, GlobalKey());

    await tester.tap(find.text('搜索设置'));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.byKey(const ValueKey('tag-search-base-url')),
      'https://tags.example.test',
    );
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('tag-search-preset-hf')));
    await tester.pumpAndSettle();
    expect(
      tester
          .widget<TextField>(find.byKey(const ValueKey('tag-search-base-url')))
          .controller!
          .text,
      defaultDanbooruBaseUrl,
    );
    expect(controller.tagSearchBaseUrl, defaultDanbooruBaseUrl);
    await tester.tap(
      find.byKey(const ValueKey('tag-search-preset-modelscope')),
    );
    await tester.pumpAndSettle();
    expect(
      tester
          .widget<TextField>(find.byKey(const ValueKey('tag-search-base-url')))
          .controller!
          .text,
      'https://sakizuki-danboorusearchonline.ms.show',
    );
    expect(controller.tagSearchBaseUrl, defaultDanbooruBaseUrl);
    await tester.enterText(
      find.byKey(const ValueKey('tag-search-base-url')),
      'https://tags.example.test',
    );
    await tester.tap(find.byKey(const ValueKey('tag-search-show-nsfw')));
    await tester.pumpAndSettle();
    expect(client.calls, isEmpty);

    await tester.ensureVisible(
      find.byKey(const ValueKey('tag-search-save-settings')),
    );
    await tester.tap(find.byKey(const ValueKey('tag-search-save-settings')));
    await tester.pumpAndSettle();
    expect(
      controller.tagSearchBaseUrl,
      normalizeDanbooruBaseUrl('https://tags.example.test'),
    );
    expect(controller.tagSearchShowNsfw, isFalse);

    await tester.enterText(
      find.byKey(const ValueKey('tag-search-input')),
      'blue',
    );
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('tag-search-submit')));
    await tester.pumpAndSettle();
    expect(client.calls.single.baseUrl, controller.tagSearchBaseUrl);
    expect(client.calls.single.showNsfw, isFalse);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets(
    'errors are distinct and a late response cannot replace a newer query',
    (tester) async {
      _setViewport(tester, const Size(1440, 900), 1);
      final pending = <Completer<DanbooruSearchResult>>[];
      final client = _FakeDanbooruSearchClient()
        ..handler = (_) {
          final completer = Completer<DanbooruSearchResult>();
          pending.add(completer);
          return completer.future;
        };
      final controller = WorkbenchController(tagSearchClient: client);
      await _openTagSearch(tester, controller, GlobalKey());
      final input = find.byKey(const ValueKey('tag-search-input'));
      final submit = find.byKey(const ValueKey('tag-search-submit'));

      await tester.enterText(input, 'first');
      await tester.pump();
      await tester.tap(submit);
      await tester.pump();
      expect(find.byKey(const ValueKey('tag-search-loading')), findsOneWidget);
      await tester.enterText(input, 'second');
      await tester.pump();
      await tester.tap(submit);
      await tester.pump();
      expect(client.calls, hasLength(2));

      pending.first.complete(
        _result(
          query: 'first',
          source: 'stale-index.example',
          tags: [_tag(tag: 'stale_result')],
        ),
      );
      await tester.pump();
      expect(find.text('stale result'), findsNothing);

      pending.last.complete(
        _result(
          query: 'second',
          source: 'current-index.example',
          tags: [_tag(tag: 'current_result')],
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('current result'), findsOneWidget);
      expect(find.text('stale result'), findsNothing);

      await tester.enterText(input, 'cancel me');
      await tester.pump();
      await tester.tap(submit);
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('tag-search-cancel')));
      await tester.pump();
      pending.last.complete(
        _result(
          query: 'cancel me',
          source: 'late-index.example',
          tags: [_tag(tag: 'late_result')],
        ),
      );
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('tag-search-cancelled')),
        findsOneWidget,
      );
      expect(find.text('late result'), findsNothing);

      await tester.enterText(input, 'settings race');
      await tester.pump();
      await tester.tap(submit);
      await tester.pump();
      await tester.tap(find.text('搜索设置'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 250));
      await tester.tap(
        find.byKey(const ValueKey('tag-search-preset-modelscope')),
      );
      await tester.pump();
      expect(client.calls.last.cancellation.isCancelled, isTrue);
      pending.last.complete(
        _result(
          query: 'settings race',
          source: 'late-config-index.example',
          tags: [_tag(tag: 'late_config_result')],
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('late config result'), findsNothing);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('network failure has a retry state', (tester) async {
    _setViewport(tester, const Size(1440, 900), 1);
    final client = _FakeDanbooruSearchClient()
      ..handler = (_) async => throw StateError('private response detail');
    final controller = WorkbenchController(tagSearchClient: client);
    await _openTagSearch(tester, controller, GlobalKey());
    await tester.enterText(
      find.byKey(const ValueKey('tag-search-input')),
      '猫耳',
    );
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('tag-search-submit')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('tag-search-error')), findsOneWidget);
    expect(find.text('查询标签失败，请检查地址、网络或服务状态后重试。'), findsOneWidget);
    expect(find.textContaining('private response detail'), findsNothing);
    expect(find.byKey(const ValueKey('tag-search-retry')), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('leaving the page cancels work and ignores a late response', (
    tester,
  ) async {
    _setViewport(tester, const Size(1440, 900), 1);
    final pending = Completer<DanbooruSearchResult>();
    final client = _FakeDanbooruSearchClient()..handler = (_) => pending.future;
    final controller = WorkbenchController(tagSearchClient: client);
    await _openTagSearch(tester, controller, GlobalKey());
    await tester.enterText(
      find.byKey(const ValueKey('tag-search-input')),
      'closing page',
    );
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('tag-search-submit')));
    await tester.pump();
    expect(find.byKey(const ValueKey('tag-search-loading')), findsOneWidget);

    await tester.tap(find.text('创作工作台').first);
    await tester.pumpAndSettle();
    expect(client.calls.single.cancellation.isCancelled, isTrue);
    pending.complete(
      _result(
        query: 'closing page',
        source: 'late-index.example',
        tags: [_tag(tag: 'late_page_result')],
      ),
    );
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('tag-search-input')), findsNothing);
    expect(find.text('late page result'), findsNothing);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('640x480 logical workspace at DPR 2 remains scrollable', (
    tester,
  ) async {
    _setViewport(tester, const Size(1280, 960), 2);
    final client = _FakeDanbooruSearchClient()
      ..handler = (call) async => _result(
        query: call.query,
        source: 'compact-index.example',
        tags: [
          _tag(
            tag: List.filled(14, 'very_long_tag').join('_'),
            cnName: List.filled(35, '很长的中文标签名称').join('，'),
            wiki: List.filled(80, '这是移动高密度屏幕上的完整 Wiki 释义。').join('\n'),
          ),
        ],
      );
    final controller = WorkbenchController(tagSearchClient: client);
    final boundary = GlobalKey();
    await _openTagSearch(tester, controller, boundary, compact: true);
    expect(find.byKey(const ValueKey('tag-search-input')), findsOneWidget);
    expect(find.byType(Scrollable), findsWidgets);
    await tester.enterText(
      find.byKey(const ValueKey('tag-search-input')),
      'compact detail',
    );
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('tag-search-submit')));
    await tester.pumpAndSettle();
    expect(client.calls, hasLength(1));
    await tester.drag(
      find.byKey(const ValueKey('tag-search-scroll-view')),
      const Offset(0, -500),
    );
    await tester.pumpAndSettle();
    await tester.ensureVisible(
      find.byKey(const ValueKey('tag-search-result-0')),
    );
    await tester.tap(find.byKey(const ValueKey('tag-search-result-0')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('tag-search-details')), findsOneWidget);
    expect(
      find.byKey(const ValueKey('tag-search-detail-cn-name')),
      findsOneWidget,
    );
    expect(find.byType(SingleChildScrollView), findsWidgets);
    await _capture(tester, boundary, 'compact-640x480-dpr2-details.png');
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
  });
}

class _SearchCall {
  const _SearchCall({
    required this.query,
    required this.baseUrl,
    required this.limit,
    required this.showNsfw,
    required this.cancellation,
  });

  final String query;
  final String baseUrl;
  final int limit;
  final bool showNsfw;
  final AgentCancellation cancellation;
}

class _FakeDanbooruSearchClient implements DanbooruSearchClient {
  final calls = <_SearchCall>[];
  Future<DanbooruSearchResult> Function(_SearchCall call)? handler;

  @override
  Future<DanbooruSearchResult> search({
    required String query,
    required AgentCancellation cancellation,
    String baseUrl = defaultDanbooruBaseUrl,
    int limit = 30,
    bool showNsfw = true,
  }) {
    final call = _SearchCall(
      query: query,
      baseUrl: baseUrl,
      limit: limit,
      showNsfw: showNsfw,
      cancellation: cancellation,
    );
    calls.add(call);
    final currentHandler = handler;
    if (currentHandler != null) return currentHandler(call);
    return Future.value(
      _result(query: query, source: 'fake-index.example', tags: const []),
    );
  }
}

DanbooruTag _tag({
  required String tag,
  String cnName = '白色水手服',
  String? wiki,
}) => DanbooruTag(
  tag: tag,
  cnName: cnName,
  category: 'Clothing',
  nsfw: 'safe',
  count: 4200,
  score: .928,
  wiki: wiki ?? '全量 Wiki 释义：\n${List.filled(35, '这是可滚动查看的完整释义。').join('\n')}',
);

DanbooruSearchResult _result({
  required String query,
  required String source,
  required List<DanbooruTag> tags,
}) => DanbooruSearchResult(tags: tags, source: source, query: query);

void _setViewport(WidgetTester tester, Size physicalSize, double dpr) {
  tester.view.physicalSize = physicalSize;
  tester.view.devicePixelRatio = dpr;
  addTearDown(() {
    tester.view.resetPhysicalSize();
    tester.view.resetDevicePixelRatio();
  });
}

Future<void> _openTagSearch(
  WidgetTester tester,
  WorkbenchController controller,
  GlobalKey boundary, {
  bool compact = false,
}) async {
  await tester.pumpWidget(
    RepaintBoundary(
      key: boundary,
      child: WorldPainterApp(controller: controller),
    ),
  );
  await tester.pumpAndSettle();
  if (compact) {
    await tester.tap(find.byIcon(Icons.menu_rounded).first);
    await tester.pumpAndSettle();
  }
  final entry = find.text('标签搜索').first;
  await tester.ensureVisible(entry);
  await tester.tap(entry);
  await tester.pumpAndSettle();
  expect(find.byKey(const ValueKey('tag-search-input')), findsOneWidget);
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
    final output = File('.tmp/tag-search-ui/$name');
    await output.parent.create(recursive: true);
    await output.writeAsBytes(bytes!.buffer.asUint8List());
  });
}

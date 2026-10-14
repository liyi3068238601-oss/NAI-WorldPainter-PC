import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:archive/archive.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:worldpainter_pc/assistant/agent_contract.dart';
import 'package:worldpainter_pc/assistant/wd_tagger.dart';
import 'package:worldpainter_pc/media/image_asset_store.dart';
import 'package:worldpainter_pc/prototype/workbench_controller.dart';
import 'package:worldpainter_pc/security/credential_vault.dart';
import 'package:worldpainter_pc/storage/workspace_store.dart';
import 'package:worldpainter_pc/tags/image_tag_controller.dart';
import 'package:worldpainter_pc/tags/image_tag_review.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('ImageTagReviewState', () {
    test('accepts an empty state and round trips the fixed schema', () {
      expect(
        ImageTagReviewState.fromJson({}).toJson(),
        ImageTagReviewState.empty.toJson(),
      );
      final state = ImageTagReviewState(
        mode: ImageTagAnalysisMode.wdTagger,
        sourceAssetRef: 'sha256/aa/${List.filled(64, 'a').join()}.png',
        analyzed: true,
        wdSettings: const ImageTagWdSettings(
          baseUrl: defaultWdTaggerBaseUrl,
          model: defaultWdTaggerModel,
          generalThreshold: .35,
          characterThreshold: .85,
          generalMcut: false,
          characterMcut: false,
        ),
        generalTags: const [
          ImageTagCandidate(tag: '1girl', confidence: .97, selected: true),
        ],
      );

      expect(
        ImageTagReviewState.fromJson(state.toJson()).toJson(),
        state.toJson(),
      );
      expect(jsonEncode(state.toJson()), isNot(contains('"path"')));
      expect(state.toJson()['wdSettings'], isNot(contains('enabled')));
    });

    test(
      'rejects paths, unknown fields, invalid scores, and oversized state',
      () {
        final empty = ImageTagReviewState.empty.toJson();
        expect(
          () => ImageTagReviewState.fromJson({...empty, 'unexpected': 1}),
          throwsFormatException,
        );
        expect(
          () => ImageTagReviewState.fromJson({
            ...empty,
            'sourceAssetRef': r'C:\private\image.png',
          }),
          throwsFormatException,
        );
        expect(
          () => ImageTagCandidate.fromJson({
            'tag': 'invalid',
            'confidence': 1.5,
            'selected': true,
            'group': null,
          }),
          throwsFormatException,
        );
        expect(
          () => ImageTagReviewState(
            analyzed: true,
            sourceAssetRef: 'sha256/aa/${List.filled(64, 'a').join()}.png',
            generalTags: List.generate(
              ImageTagReviewState.maxCandidates + 1,
              (index) => ImageTagCandidate(
                tag: 'tag_$index',
                confidence: .5,
                selected: true,
              ),
            ),
          ),
          throwsFormatException,
        );
      },
    );
  });

  test(
    'local import is managed and stores no source path or image bytes',
    () async {
      final harness = await _harness();
      final review = ImageTagController(workbench: harness.workbench);
      addTearDown(() => _close(harness, review));
      final original = _pngWithText([
        _textChunk('Comment', jsonEncode({'prompt': 'synthetic'})),
      ]);

      final asset = await review.importLocalImage(original);

      expect(review.sourceAssetRef, asset.assetRef);
      expect(review.sourceTitle(), '本地导入原图');
      expect(await harness.assets.read(asset.assetRef), original);
      final persisted = jsonEncode(harness.workbench.imageTagReview);
      expect(persisted, contains(asset.assetRef));
      expect(persisted, isNot(contains('synthetic')));
      expect(persisted, isNot(contains('path')));
    },
  );

  test(
    'NAI mode extracts tags and safe metadata without changing the original',
    () async {
      final harness = await _harness();
      final review = ImageTagController(workbench: harness.workbench);
      addTearDown(() => _close(harness, review));
      final original = _pngWithText([
        _textChunk(
          'Comment',
          jsonEncode({
            'prompt': '1girl, blue_hair',
            'uc': 'bad_hands',
            'seed': 17,
            'width': 64,
            'height': 64,
            'steps': 20,
            'scale': 5.0,
            'model': 'nai-diffusion-4-5-full',
            'characters': [
              {
                'prompt': 'smile, open_mouth',
                'negative_prompt': 'extra_fingers',
              },
            ],
          }),
        ),
      ]);
      final asset = await harness.assets.save(original);
      harness.workbench.addImported(asset);
      review.selectGalleryImage(harness.workbench.selected);

      await review.analyze();

      expect(review.review.analyzed, isTrue);
      expect(review.review.metadataSource, 'png-text');
      expect(review.review.generalTags.map((tag) => tag.tag), [
        '1girl',
        'blue_hair',
      ]);
      expect(review.review.characterTags.map((tag) => tag.tag), [
        'smile',
        'open_mouth',
      ]);
      expect(review.review.negativeTags.map((tag) => tag.tag), [
        'bad_hands',
        'extra_fingers',
      ]);
      expect(review.review.characterTags.first.group, '角色1 正向');
      expect(review.review.metadataFields, containsPair('seed', 17));
      expect(review.review.metadataFields, isNot(contains('prompt')));
      expect(await harness.assets.read(asset.assetRef), original);
    },
  );

  test('NAI weighted and bracketed groups stay intact through selection and write', () async {
    final harness = await _harness();
    final review = ImageTagController(workbench: harness.workbench);
    addTearDown(() => _close(harness, review));
    const prompt =
        '1.2::{red hair,\nblue eyes}::, [long hair, wavy hair], (smile, open mouth)';
    final asset = await harness.assets.save(
      _pngWithText([
        _textChunk('Comment', jsonEncode({'prompt': prompt})),
      ]),
    );
    harness.workbench.addImported(asset);
    review.selectGalleryImage(harness.workbench.selected);

    await review.analyze();

    expect(review.review.generalTags.map((tag) => tag.tag), [
      '1.2::{red hair,\nblue eyes}::',
      '[long hair, wavy hair]',
      '(smile, open mouth)',
    ]);
    expect(review.selectedCopyText(), contains(prompt));
    expect(
      review.previewPromptChange(target: 'positive', replace: false).after,
      prompt,
    );
  });

  test('unbalanced NAI groups are preserved whole with a warning', () async {
    final harness = await _harness();
    final review = ImageTagController(workbench: harness.workbench);
    addTearDown(() => _close(harness, review));
    const prompt = '{red hair, blue eyes, long hair';
    final asset = await harness.assets.save(
      _pngWithText([
        _textChunk('Comment', jsonEncode({'prompt': prompt})),
      ]),
    );
    harness.workbench.addImported(asset);
    review.selectGalleryImage(harness.workbench.selected);

    await review.analyze();

    expect(review.review.generalTags.map((tag) => tag.tag), [prompt]);
    expect(review.review.metadataWarnings, contains(contains('不平衡')));
    expect(review.selectedCopyText(), contains(prompt));
  });

  test(
    'WD action works with global disabled and uploads metadata-free PNG',
    () async {
      final wd = _FakeWd();
      final harness = await _harness(wd: wd);
      final review = ImageTagController(workbench: harness.workbench);
      addTearDown(() => _close(harness, review));
      final original = _pngWithText([
        _textChunk(
          'Comment',
          jsonEncode({'prompt': 'PRIVATE_SYNTHETIC_PROMPT'}),
        ),
      ]);
      final asset = await harness.assets.save(original);
      harness.workbench.addImported(asset);
      harness.workbench.assistant.updateWdTaggerSettings(
        const WdTaggerSettings(
          enabled: false,
          generalThreshold: .42,
          characterThreshold: .88,
        ),
      );
      review.setMode(ImageTagAnalysisMode.wdTagger);
      review.selectGalleryImage(harness.workbench.selected);

      await review.analyze();

      expect(wd.settings.single.enabled, isTrue);
      expect(wd.settings.single.generalThreshold, .42);
      expect(harness.workbench.assistant.state.wdTagger.enabled, isFalse);
      expect(
        latin1.decode(wd.images.single),
        isNot(contains('PRIVATE_SYNTHETIC_PROMPT')),
      );
      expect(await harness.assets.read(asset.assetRef), original);
      expect(review.review.generalTags.single.selected, isTrue);
      expect(review.review.characterTags.single.selected, isTrue);
      expect(review.review.ratingTags.single.selected, isFalse);
    },
  );

  test('translation reuses the phone prompt, has no tools, and keeps English labels', () async {
    final transport = _FakeTransport(
      reply: const AgentReply(content: '{"1girl":"1个女孩","blue_hair":"蓝发"}'),
    );
    final harness = await _harness(transport: transport, withProvider: true);
    final review = ImageTagController(workbench: harness.workbench);
    addTearDown(() => _close(harness, review));
    final asset = await harness.assets.save(
      _pngWithText([
        _textChunk('Comment', jsonEncode({'prompt': '1girl, blue_hair'})),
      ]),
    );
    harness.workbench.addImported(asset);
    review.selectGalleryImage(harness.workbench.selected);
    await review.analyze();

    await review.translateSelectedTags();

    expect(review.review.translations, {'1girl': '1个女孩', 'blue_hair': '蓝发'});
    expect(review.selectedCopyText(), contains('1girl, blue_hair'));
    expect(review.selectedCopyText(), isNot(contains('1个女孩')));
    expect(transport.tools.single, isEmpty);
    expect(transport.toolChoices.single, 'none');
    expect(
      transport.requests.single.first['content'],
      '你是一个 Danbooru 标签翻译器。用户会给你一串英文标签（逗号分隔），'
      '你需要把每个标签翻译成简体中文，返回一个 JSON 对象，key 是原英文标签，'
      'value 是中文翻译。只输出 JSON，不要任何其他文字。例如：\n'
      '输入：1girl, long_hair, blue_eyes\n'
      '输出：{"1girl": "1个女孩", "long_hair": "长发", "blue_eyes": "蓝眼睛"}',
    );
    expect(transport.requests.single.last['content'], '1girl, blue_hair');
  });

  test(
    'translation falls back to vision when the main model has no key',
    () async {
      final transport = _FakeTransport(
        reply: const AgentReply(content: '{"1girl":"1个女孩"}'),
      );
      final harness = await _harness(
        transport: transport,
        withProvider: true,
        mainRequiresKey: true,
        withVision: true,
        vault: _Vault(),
      );
      final review = ImageTagController(workbench: harness.workbench);
      addTearDown(() => _close(harness, review));
      final asset = await harness.assets.save(
        _pngWithText([
          _textChunk('Comment', jsonEncode({'prompt': '1girl'})),
        ]),
      );
      harness.workbench.addImported(asset);
      review.selectGalleryImage(harness.workbench.selected);
      await review.analyze();

      await review.translateSelectedTags();

      expect(transport.providers.single.id, 'vision');
      expect(review.review.translations, {'1girl': '1个女孩'});
    },
  );

  test('late translation is ignored after timeout', () async {
    final pending = Completer<AgentReply>();
    final transport = _FakeTransport(pending: pending);
    final harness = await _harness(transport: transport, withProvider: true);
    final review = ImageTagController(
      workbench: harness.workbench,
      translationTimeout: const Duration(milliseconds: 20),
    );
    addTearDown(() => _close(harness, review));
    final asset = await harness.assets.save(
      _pngWithText([
        _textChunk('Comment', jsonEncode({'prompt': '1girl'})),
      ]),
    );
    harness.workbench.addImported(asset);
    review.selectGalleryImage(harness.workbench.selected);
    await review.analyze();

    await review.translateSelectedTags();
    pending.complete(const AgentReply(content: '{"1girl":"迟到翻译"}'));
    await Future<void>.delayed(const Duration(milliseconds: 1));

    expect(review.error, contains('超时'));
    expect(review.review.translations, isEmpty);
    expect(review.review.generalTags.single.tag, '1girl');
  });

  test(
    'approval rejects draft changes and consumes a successful write once',
    () async {
      final harness = await _harness();
      final review = ImageTagController(workbench: harness.workbench);
      addTearDown(() => _close(harness, review));
      final asset = await harness.assets.save(
        _pngWithText([
          _textChunk('Comment', jsonEncode({'prompt': '1girl'})),
        ]),
      );
      harness.workbench.addImported(asset);
      review.selectGalleryImage(harness.workbench.selected);
      await review.analyze();
      harness.workbench.updatePrompt('existing');
      final stale = review.previewPromptChange(
        target: 'positive',
        replace: false,
      );
      harness.workbench.updatePrompt('changed during confirmation');
      await expectLater(
        review.commitPromptChange(stale),
        throwsA(isA<AgentException>()),
      );
      expect(harness.workbench.prompt, 'changed during confirmation');

      final current = review.previewPromptChange(
        target: 'positive',
        replace: false,
      );
      await review.commitPromptChange(current);
      expect(harness.workbench.prompt, 'changed during confirmation, 1girl');
      await expectLater(
        review.commitPromptChange(current),
        throwsA(isA<AgentException>()),
      );
      expect(harness.workbench.prompt, 'changed during confirmation, 1girl');
    },
  );

  test(
    'a failed save cannot cause a confirmed prompt append to repeat',
    () async {
      final store = _FailingWorkspaceStore();
      final harness = await _harness(store: store);
      final review = ImageTagController(workbench: harness.workbench);
      addTearDown(() => _close(harness, review));
      final asset = await harness.assets.save(
        _pngWithText([
          _textChunk('Comment', jsonEncode({'prompt': '1girl'})),
        ]),
      );
      harness.workbench.addImported(asset);
      review.selectGalleryImage(harness.workbench.selected);
      await review.analyze();
      harness.workbench.updatePrompt('existing');
      final change = review.previewPromptChange(
        target: 'positive',
        replace: false,
      );
      await harness.workbench.flush(retry: true);
      store.failNextSave = true;

      await expectLater(
        review.commitPromptChange(change),
        throwsA(isA<ImageTagPromptSaveException>()),
      );
      expect(harness.workbench.prompt, 'existing, 1girl');
      await expectLater(
        review.commitPromptChange(change),
        throwsA(isA<AgentException>()),
      );
      expect(harness.workbench.prompt, 'existing, 1girl');
      await review.retryPromptSave();
      expect(store.saveCalls, greaterThan(1));
    },
  );
}

Future<_Harness> _harness({
  _FakeWd? wd,
  _FakeTransport? transport,
  WorkspaceStore? store,
  bool withProvider = false,
  bool mainRequiresKey = false,
  bool withVision = false,
  CredentialVault? vault,
}) async {
  final root = await Directory('.tmp/image-tag-review-tests').absolute
      .create(recursive: true);
  final directory = await root.createTemp('case-');
  final assets = await openImageAssetStore(directory: directory.path);
  final workbench = WorkbenchController(
    store: store,
    assets: assets,
    vault: vault,
    assistantTransport: transport,
    wdTaggerClient: wd,
  );
  if (withProvider) {
    workbench.assistant.state.providers.add(
      AssistantProvider(
        id: 'main',
        name: '合成主模型',
        baseUrl: 'https://main.invalid/v1',
        model: 'synthetic',
        requireKey: mainRequiresKey,
      ),
    );
    workbench.assistant.state.mainProviderId = 'main';
  }
  if (withVision) {
    workbench.assistant.state.providers.add(
      const AssistantProvider(
        id: 'vision',
        name: '合成识图模型',
        baseUrl: 'https://vision.invalid/v1',
        model: 'synthetic',
        requireKey: false,
      ),
    );
    workbench.assistant.state.visionProviderId = 'vision';
  }
  return _Harness(workbench: workbench, assets: assets, directory: directory);
}

Future<void> _close(_Harness harness, ImageTagController review) async {
  review.dispose();
  await harness.workbench.closeStorage();
  harness.workbench.dispose();
  await harness.directory.delete(recursive: true);
}

class _Harness {
  const _Harness({
    required this.workbench,
    required this.assets,
    required this.directory,
  });
  final WorkbenchController workbench;
  final ImageAssetStore assets;
  final Directory directory;
}

class _FakeWd extends WdTaggerClient {
  final images = <Uint8List>[];
  final settings = <WdTaggerSettings>[];

  @override
  Future<WdTaggerResult> analyze({
    required Uint8List bytes,
    required WdTaggerSettings settings,
    required AgentCancellation cancellation,
  }) async {
    cancellation.check();
    images.add(Uint8List.fromList(bytes));
    this.settings.add(settings);
    return WdTaggerResult(
      caption: 'synthetic caption',
      generalTags: {'landscape': .91},
      characterTags: {'1girl': .84},
      ratingTags: {'general': .99},
    );
  }
}

class _FakeTransport implements AgentTransport {
  _FakeTransport({this.reply, this.pending});
  final AgentReply? reply;
  final Completer<AgentReply>? pending;
  final requests = <List<Map<String, dynamic>>>[];
  final tools = <List<Map<String, dynamic>>>[];
  final toolChoices = <String>[];
  final providers = <AssistantProvider>[];

  @override
  Future<AgentReply> complete({
    required AssistantProvider provider,
    required List<Map<String, dynamic>> messages,
    required List<Map<String, dynamic>> tools,
    required String toolChoice,
    required AgentCancellation cancellation,
    void Function(String accumulatedText)? onText,
  }) {
    providers.add(provider);
    requests.add(messages);
    this.tools.add(tools);
    toolChoices.add(toolChoice);
    cancellation.check();
    if (pending != null) return pending!.future;
    return Future.value(reply!);
  }
}

class _Vault implements CredentialVault {
  @override
  Future<void> delete({required String provider, required String key}) async {}

  @override
  Future<String?> read({required String provider, required String key}) async =>
      null;

  @override
  Future<void> save({
    required String provider,
    required String key,
    required String secret,
  }) async {}
}

class _FailingWorkspaceStore implements WorkspaceStore {
  int saveCalls = 0;
  bool failNextSave = false;

  @override
  String get label => 'synthetic-failing-store';

  @override
  Future<StoredWorkspace?> load() async => null;

  @override
  Future<int> save(
    Map<String, Object?> data, {
    required int expectedRevision,
  }) async {
    saveCalls++;
    if (failNextSave) {
      failNextSave = false;
      throw StateError('synthetic save failure');
    }
    return expectedRevision + 1;
  }

  @override
  Future<void> close() async {}
}

Uint8List _pngWithText(
  List<List<int>> textChunks, {
  int width = 8,
  int height = 8,
}) {
  final chunks = <List<int>>[];
  final header = ByteData(13)
    ..setUint32(0, width, Endian.big)
    ..setUint32(4, height, Endian.big)
    ..setUint8(8, 8)
    ..setUint8(9, 6)
    ..setUint8(10, 0)
    ..setUint8(11, 0)
    ..setUint8(12, 0);
  chunks.add(_pngChunk('IHDR', header.buffer.asUint8List()));
  for (final item in textChunks) {
    chunks.add(_pngChunk(latin1.decode(item.sublist(0, 4)), item.sublist(4)));
  }
  final scanlines = Uint8List(height * (width * 4 + 1));
  for (var y = 0; y < height; y++) {
    final row = y * (width * 4 + 1);
    scanlines[row] = 0;
    for (var x = 0; x < width; x++) {
      final pixel = row + 1 + x * 4;
      scanlines.setRange(pixel, pixel + 4, const [128, 128, 128, 255]);
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

List<int> _textChunk(String keyword, String value) => [
  ...latin1.encode('tEXt'),
  ...latin1.encode(keyword),
  0,
  ...latin1.encode(value),
];

List<int> _pngChunk(String type, List<int> data) {
  final header = ByteData(4)..setUint32(0, data.length, Endian.big);
  final typeBytes = latin1.encode(type);
  final checksum = _crc32([...typeBytes, ...data]);
  final crc = ByteData(4)..setUint32(0, checksum, Endian.big);
  return [
    ...header.buffer.asUint8List(),
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

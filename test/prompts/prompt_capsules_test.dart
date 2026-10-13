import 'dart:convert';

import 'package:flutter/foundation.dart' show FlutterError;
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:worldpainter_pc/prompts/prompt_capsules.dart';

class _MemoryAssetBundle extends CachingAssetBundle {
  _MemoryAssetBundle(this.assets);

  final Map<String, String> assets;

  @override
  Future<ByteData> load(String key) async {
    final source = assets[key];
    if (source == null) throw FlutterError('Missing test asset: $key');
    final bytes = Uint8List.fromList(utf8.encode(source));
    return ByteData.view(bytes.buffer);
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test('bundled MIT corpus has complete unique records and license', () async {
    final all = await loadPromptCapsules();
    expect(all, hasLength(4121));
    expect(all.map((v) => v.id).toSet().length, all.length);
    expect(all.where((v) => v.negative), hasLength(119));
    expect(all.map((v) => v.category).toSet(), hasLength(14));
    expect(
      await rootBundle.loadString('licenses/CAPSULES_MIT.txt'),
      contains('Copyright (c) 2026 Langbai'),
    );
  });
  const capsules = [
    PromptCapsule(
      id: '人物/发型/long_hair',
      category: '人物',
      subgroup: '发型',
      en: 'long_hair',
      zh: '长发',
      negative: false,
    ),
    PromptCapsule(
      id: '人物/发型/blue_hair',
      category: '人物',
      subgroup: '发型',
      en: 'blue_hair',
      zh: '蓝发',
      negative: false,
    ),
    PromptCapsule(
      id: '反向提示词/常用负面/lowres',
      category: '反向提示词',
      subgroup: '常用负面',
      en: 'lowres',
      zh: '低分辨率',
      negative: true,
    ),
  ];

  test('formats underscore tags as prompt text while preserving the tag', () {
    expect(capsules.first.en, 'long_hair');
    expect(capsules.first.promptText, 'long hair');
  });

  test('loads capsule records from an injected asset bundle', () async {
    final bundle = _MemoryAssetBundle({
      promptCapsulesAssetPath: jsonEncode([
        {
          'id': '反向提示词/常用负面/lowres',
          'category': '反向提示词',
          'subgroup': '常用负面',
          'en': 'lowres',
          'zh': '低分辨率',
          'negative': true,
        },
      ]),
    });

    final loaded = await loadPromptCapsules(bundle: bundle);

    expect(loaded, hasLength(1));
    expect(loaded.single.id, capsules.last.id);
    expect(loaded.single.negative, isTrue);
    expect(() => loaded.add(capsules.first), throwsUnsupportedError);
  });

  test(
    'queries by English or Chinese text, category, subgroup, and polarity',
    () {
      expect(
        queryPromptCapsules(capsules, search: 'LONG').map((item) => item.id),
        ['人物/发型/long_hair'],
      );
      expect(
        queryPromptCapsules(capsules, search: '低分辨率').single,
        capsules.last,
      );
      expect(
        queryPromptCapsules(capsules, category: '人物', subgroup: '发型'),
        capsules.take(2),
      );
      expect(queryPromptCapsules(capsules, negative: true), [capsules.last]);
      expect(queryPromptCapsules(capsules, negative: false), capsules.take(2));
    },
  );
}

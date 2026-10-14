import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:crypto/crypto.dart';
import 'package:worldpainter_pc/assistant/agent_contract.dart';
import 'package:worldpainter_pc/assistant/assistant_mobile_resources.dart';
import 'package:worldpainter_pc/assistant/assistant_preferences.dart';
import 'package:worldpainter_pc/assistant/prompting_knowledge.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('AssistantMobileResources', () {
    test('loads original asset paths, byte hashes, and entry count', () async {
      final resources = AssistantMobileResources();
      final snapshot = await resources.load();

      expect(snapshot.source, AssistantMobileResources.sourceLabel);
      expect(
        snapshot.systemPromptPath,
        'assets/assistant/mobile/system_prompt.txt',
      );
      expect(
        snapshot.systemPromptSha256,
        '644fef0d802ee47aa61893054e59520181cdc087feda0bcc197ba29cb7e36c77',
      );
      expect(snapshot.systemPromptByteLength, 9098);
      expect(
        snapshot.knowledgePath,
        'assets/assistant/mobile/nsfw_knowledge.json',
      );
      expect(
        snapshot.knowledgeSha256,
        'fe8788cb82dd8a6ef7ebf5bd11b39d7fa7b1dec4f912835d5bf525bb7d9ac66c',
      );
      expect(snapshot.knowledgeByteLength, 8882911);
      expect(snapshot.knowledgeEntryCount, 12738);
      expect(
        snapshot.skillSha256,
        'c2461185579f280f4db68266dd9bee4f83604e48233074a095c95bee3455c360',
      );
      expect(
        snapshot.ideationReferenceSha256,
        '9fdc8cce237496737d016ffee42a76a68d2689f00f280835abff1318437fec63',
      );
      expect(
        snapshot.writingReferenceSha256,
        '494dc7526c99c353e29f0786861a465f1581aef042b3fda298c63197e66e0426',
      );
      expect(sha256Of(resources.systemPrompt), snapshot.systemPromptSha256);
      expect(resources.systemPrompt.length, greaterThan(0));
      expect(identical(await resources.load(), snapshot), isTrue);
    });

    test(
      'matches English whole words and Chinese substrings in id order',
      () async {
        final resources = AssistantMobileResources(
          loader: _fixtureLoader([
            _entry(8, ['artist'], _repeat('A', 1200)),
            _entry(2, ['猫'], _repeat('B', 1500)),
            _entry(3, ['cat'], _repeat('C', 100)),
          ]),
        );
        await resources.load();

        final matches = resources.matchKnowledge('a cat and 猫咪 artist');
        expect(matches.map((entry) => entry.id), [2, 3, 8]);
        expect(matches.map((entry) => entry.content.length), [1500, 100, 400]);
        expect(
          resources.matchKnowledge('concatenate').map((entry) => entry.id),
          isEmpty,
        );
        expect(resources.matchKnowledge('CAT!').map((entry) => entry.id), [3]);
      },
    );

    test('applies mobile result count and content length caps', () async {
      final resources = AssistantMobileResources(
        loader: _fixtureLoader(
          List.generate(
            7,
            (index) => _entry(index + 1, ['cat'], _repeat('x', 300)),
          ),
        ),
      );
      await resources.load();

      final matches = resources.matchKnowledge('cat', maxResults: 99);
      expect(matches, hasLength(5));
      expect(
        resources
            .matchKnowledge('cat', maxTotalLength: 500)
            .map((e) => e.content.length),
        [300],
      );
    });

    test(
      'retries failed loads and caches the first successful snapshot',
      () async {
        var shouldFail = true;
        var reads = 0;
        final fixture = _fixtureLoader([
          _entry(1, ['cat'], 'fixture'),
        ]);
        final resources = AssistantMobileResources(
          loader: (path) async {
            reads++;
            if (shouldFail &&
                path == AssistantMobileResources.knowledgeAssetPath) {
              throw const FormatException('synthetic fixture failure');
            }
            return fixture(path);
          },
        );

        await expectLater(resources.load(), throwsFormatException);
        final failedReadCount = reads;
        shouldFail = false;
        final snapshot = await resources.load();
        final successfulReadCount = reads;
        expect(successfulReadCount, greaterThan(failedReadCount));
        expect(identical(await resources.load(), snapshot), isTrue);
        expect(reads, successfulReadCount);
      },
    );

    test('rejects duplicate keys, duplicate IDs, unknown nested fields, and deep JSON', () async {
      final duplicateKey = _fixtureLoaderRaw(
        '{"version":8,"date":"fixture","total":0,"entries":[],"entries":[]}',
      );
      await expectLater(
        AssistantMobileResources(loader: duplicateKey).load(),
        throwsFormatException,
      );

      final duplicateIds = _fixtureLoader([
        _entry(1, ['cat'], 'one'),
        _entry(1, ['dog'], 'two'),
      ]);
      await expectLater(
        AssistantMobileResources(loader: duplicateIds).load(),
        throwsFormatException,
      );

      final unknownField = _fixtureLoader([
        {
          ..._entry(1, ['cat'], 'one'),
          'nested': {'instruction': 'ignored'},
        },
      ]);
      await expectLater(
        AssistantMobileResources(loader: unknownField).load(),
        throwsFormatException,
      );

      final nested = '${_repeat('[', 33)}0${_repeat(']', 33)}';
      final deepJson = _fixtureLoaderRaw(
        '{"version":8,"date":"fixture","total":0,"entries":[],"extra":$nested}',
      );
      await expectLater(
        AssistantMobileResources(loader: deepJson).load(),
        throwsFormatException,
      );
    });

    test('uses the mobile version/style and V5 resource templates', () async {
      final resources = AssistantMobileResources(
        loader: _fixtureLoader(
          [
            _entry(1, ['cat'], 'fixture'),
          ],
          systemPrompt: 'synthetic mobile system',
          skill: '\n synthetic skill \n',
          ideation: '\n synthetic ideation \n',
          writing: '\n synthetic writing \n',
        ),
      );
      await resources.load();

      final preferences = AssistantPreferences(
        v45StyleWords: 'v45 default, artist:a',
        v5StyleWords: 'v5 default, artist:b',
      );
      final v45 = resources.buildSystemPrompt(
        systemPromptOverride: '',
        preferences: preferences,
        version: PromptingVersion.v45,
      );
      expect(v45, startsWith('synthetic mobile system'));
      expect(v45, contains('## 当前 NovelAI 画风版本\n本会话使用 v4.5 画风。'));
      expect(v45, contains('`v45 default, artist:a`'));
      expect(v45, isNot(contains('synthetic skill')));

      final v5 = resources.buildSystemPrompt(
        systemPromptOverride: 'synthetic user override',
        preferences: preferences,
        version: PromptingVersion.v5,
      );
      expect(v5, startsWith('synthetic user override'));
      expect(v5, contains('`v5 default, artist:b`'));
      expect(v5, contains('## V5 提示词 Skill\nsynthetic skill'));
      expect(v5, contains('read-then-write 约束'));
      expect(v5, contains('`read_prompting_reference`'));
      expect(v5, isNot(contains('synthetic mobile system')));
    });

    test(
      'V5 reference tool uses the mobile schema and loaded reference text',
      () async {
        final resources = AssistantMobileResources(
          loader: _fixtureLoader(
            [
              _entry(1, ['cat'], 'fixture'),
            ],
            ideation: '\n synthetic ideation \n',
            writing: '\n synthetic writing \n',
          ),
        );
        await resources.load();
        final tool = resources.buildPromptingTools(PromptingVersion.v5).single;
        expect(tool.name, 'read_prompting_reference');
        expect((tool.parameters['properties'] as Map).keys, ['reference']);
        expect(
          ((tool.parameters['properties'] as Map)['reference'] as Map)['enum'],
          ['ideation', 'writing'],
        );
        final prepared = await tool.prepare({
          'reference': 'ideation',
        }, AgentCancellation());
        final result = await prepared.execute();
        expect(result['content'], 'synthetic ideation');
        expect(resources.buildPromptingTools(PromptingVersion.v45), isEmpty);
      },
    );

    test(
      'accepts a UTF-8 BOM in JSON while hashing the original bytes',
      () async {
        final fixture = _fixtureLoader([
          _entry(1, ['猫'], 'fixture'),
        ]);
        final resources = AssistantMobileResources(
          loader: (path) async {
            final bytes = await fixture(path);
            if (path == AssistantMobileResources.knowledgeAssetPath) {
              return Uint8List.fromList([0xef, 0xbb, 0xbf, ...bytes]);
            }
            return bytes;
          },
        );
        final snapshot = await resources.load();
        expect(snapshot.knowledgeEntryCount, 1);
        expect(resources.matchKnowledge('猫猫'), hasLength(1));
      },
    );

    test(
      'rejects resources above the total byte limit and oversized entries',
      () async {
        final oversizedPrompt = Uint8List(12 * 1024 * 1024 + 1);
        final normalAssets = _fixtureLoader([
          _entry(1, ['cat'], 'fixture'),
        ]);
        final oversizedResources = AssistantMobileResources(
          loader: (path) async =>
              path == AssistantMobileResources.systemPromptAssetPath
              ? oversizedPrompt
              : normalAssets(path),
        );
        await expectLater(oversizedResources.load(), throwsFormatException);

        final longEntry = _fixtureLoader([
          _entry(1, ['cat'], _repeat('x', 40001)),
        ]);
        await expectLater(
          AssistantMobileResources(loader: longEntry).load(),
          throwsFormatException,
        );
      },
    );
  });
}

String sha256Of(String value) => sha256.convert(utf8.encode(value)).toString();

MobileAssetLoader _fixtureLoader(
  List<Map<String, Object?>> entries, {
  String systemPrompt = 'synthetic system',
  String skill = 'synthetic skill',
  String ideation = 'synthetic ideation',
  String writing = 'synthetic writing',
}) => _fixtureLoaderRaw(
  jsonEncode({
    'version': 8,
    'date': 'fixture',
    'total': entries.length,
    'entries': entries,
  }),
  systemPrompt: systemPrompt,
  skill: skill,
  ideation: ideation,
  writing: writing,
);

MobileAssetLoader _fixtureLoaderRaw(
  String knowledgeJson, {
  String systemPrompt = 'synthetic system',
  String skill = 'synthetic skill',
  String ideation = 'synthetic ideation',
  String writing = 'synthetic writing',
}) {
  final fixture = <String, Uint8List>{
    AssistantMobileResources.systemPromptAssetPath: _bytes(systemPrompt),
    AssistantMobileResources.knowledgeAssetPath: _bytes(knowledgeJson),
    AssistantMobileResources.skillAssetPath: _bytes(skill),
    AssistantMobileResources.ideationReferenceAssetPath: _bytes(ideation),
    AssistantMobileResources.writingReferenceAssetPath: _bytes(writing),
  };
  return (path) async => Uint8List.fromList(fixture[path]!);
}

Map<String, Object?> _entry(int id, List<String> keywords, String content) => {
  'id': id,
  'title': 'fixture title $id',
  'source': 'fixture source',
  'keywords': keywords,
  'content': content,
};

Uint8List _bytes(String value) => Uint8List.fromList(utf8.encode(value));

String _repeat(String character, int count) =>
    List.filled(count, character).join();

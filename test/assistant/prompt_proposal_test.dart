import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:worldpainter_pc/assistant/prompt_proposal.dart';

void main() {
  group('parsePromptProposal', () {
    test('parses pure JSON and preserves prompt strings exactly', () {
      const positive = '  1girl, {{{blue hair}}}\r\n(weight:1.2)  ';
      const negative = '低质量, 文字\n';
      final proposal = parsePromptProposal(
        jsonEncode({
          'positive': positive,
          'negative': negative,
          'characters': [
            {'positive': '角色一: 雪音', 'negative': ''},
            {'negative': 'muted colors'},
          ],
          'reason': '按角色拆分，并保留权重。',
        }),
      );

      expect(proposal, isNotNull);
      expect(proposal!.fields, {
        'positive': positive,
        'negative': negative,
        'character_1': '角色一: 雪音',
        'character_2_uc': 'muted colors',
      });
      expect(proposal.reason, '按角色拆分，并保留权重。');
      expect(
        () => proposal.fields['positive'] = 'changed',
        throwsUnsupportedError,
      );
    });

    test('parses one fenced JSON proposal and omits empty fields', () {
      final proposal = parsePromptProposal('''
方案：
```json
{"positive":"青い髪, {glow:1.1}","negative":"","characters":[{"positive":"猫耳"}],"reason":"统一颜色"}
```
以上是建议。
''');

      expect(proposal!.fields, {
        'positive': '青い髪, {glow:1.1}',
        'character_1': '猫耳',
      });
      expect(proposal.reason, '统一颜色');
    });

    test(
      'maps explicit Chinese labels and inpaint labels to workbench targets',
      () {
        final proposal = parsePromptProposal('''
负向提示词：
```text
text, watermark
```
通用底模词：
```
masterpiece
```
角色 A 正向：
```
银发
```
角色1负向：
```
花纹
```
角色二：
```
青い目
```
角色六负面：
```
低饱和
```
inpaint_positive:
```
局部细节
```
inpaint_negative:
```
模糊
```
''');

        expect(proposal!.fields, {
          'negative': 'text, watermark',
          'positive': 'masterpiece',
          'character_1': '银发',
          'character_1_uc': '花纹',
          'character_2': '青い目',
          'character_6_uc': '低饱和',
          'inpaint_positive': '局部细节',
          'inpaint_negative': '模糊',
        });

        final english = parsePromptProposal('''
positive:
```
bright eyes
```
''');
        expect(english!.fields, {'positive': 'bright eyes'});
      },
    );

    test(
      'preserves CRLF, indentation, and intentional blank lines in blocks',
      () {
        final content =
            '正向：\r\n'
            '```text\r\n'
            '  first line\r\n'
            '\r\n'
            '(weight:1.3)\r\n'
            '```';
        final proposal = parsePromptProposal(content);

        expect(
          proposal!.fields['positive'],
          '  first line\r\n\r\n(weight:1.3)',
        );
      },
    );

    test(
      'returns null for no proposal, empty proposals, and reason-only JSON',
      () {
        expect(parsePromptProposal('只是解释，没有代码块。'), isNull);
        expect(parsePromptProposal('```dart\nprint("positive");\n```'), isNull);
        expect(
          parsePromptProposal('''
这里是普通代码：
```python
positive = "not a prompt target"
```
'''),
          isNull,
        );
        expect(parsePromptProposal('{"positive":"","negative":""}'), isNull);
        expect(parsePromptProposal('{"reason":"只说明原因，没有提示词"}'), isNull);
        expect(
          parsePromptProposal(
            '{"name":"apply_prompt","arguments":{"target":"positive","content":"x"}}',
          ),
          isNull,
        );
        expect(
          parsePromptProposal(
            '{"tool_calls":[{"function":{"name":"apply_prompt","arguments":"{}"}}]}',
          ),
          isNull,
        );
        expect(parsePromptProposal('{"unrelated":{"value":1}}'), isNull);
      },
    );

    test('rejects malformed JSON and strict type mismatches', () {
      expect(
        () => parsePromptProposal('{"positive":"red",'),
        throwsA(isA<FormatException>()),
      );
      expect(
        () => parsePromptProposal('{"positive":123}'),
        throwsA(isA<FormatException>()),
      );
      expect(
        () => parsePromptProposal('{"characters":"one"}'),
        throwsA(isA<FormatException>()),
      );
      expect(
        () => parsePromptProposal('{"characters":["not an object"]}'),
        throwsA(isA<FormatException>()),
      );
      expect(
        () => parsePromptProposal('{"reason":false,"positive":"x"}'),
        throwsA(isA<FormatException>()),
      );
      expect(
        () => parsePromptProposal(
          jsonEncode({
            'positive': 'x',
            'reason': List.filled(1001, 'r').join(),
          }),
        ),
        throwsA(isA<FormatException>()),
      );
      final maxReasonProposal = parsePromptProposal(
        jsonEncode({'positive': 'x', 'reason': List.filled(1000, 'r').join()}),
      );
      expect(maxReasonProposal!.reason.length, 1000);
    });

    test(
      'rejects excessive JSON nesting without a runtime recursion error',
      () {
        final deeplyNestedValue = '${'[' * 40}0${']' * 40}';
        expect(
          () => parsePromptProposal(
            '{"positive":"proposal","nestedvalue":$deeplyNestedValue}',
          ),
          throwsA(isA<FormatException>()),
        );
        expect(parsePromptProposal('{"unrelated":$deeplyNestedValue}'), isNull);
      },
    );

    test('rejects duplicate JSON fields, duplicate targets, and multiple JSON proposals', () {
      expect(
        () => parsePromptProposal('{"positive":"a","positive":"b"}'),
        throwsA(isA<FormatException>()),
      );
      expect(
        () => parsePromptProposal(
          '{"characters":[{"positive":"a","positive":"b"}]}',
        ),
        throwsA(isA<FormatException>()),
      );
      expect(
        () => parsePromptProposal('''
正向：
```
one
```
positive:
```
two
```
'''),
        throwsA(isA<FormatException>()),
      );
      expect(
        () => parsePromptProposal('''
```json
{"positive":"one"}
```
```json
{"negative":"two"}
```
'''),
        throwsA(isA<FormatException>()),
      );
      expect(
        () => parsePromptProposal(
          '{"positive":"one"}\n```json\n{"negative":"two"}\n```',
        ),
        throwsA(isA<FormatException>()),
      );
    });

    test('rejects invalid role labels and unsupported JSON fields', () {
      for (final label in ['角色0', '角色7', '角色七', '角色G', '角色负向']) {
        expect(
          () => parsePromptProposal('$label：\n```\nx\n```'),
          throwsA(isA<FormatException>()),
          reason: 'label $label',
        );
      }
      expect(
        () => parsePromptProposal('{"positive":"x","extra":"y"}'),
        throwsA(isA<FormatException>()),
      );
    });

    test('enforces field, aggregate, and input limits', () {
      expect(
        () => parsePromptProposal(jsonEncode({'positive': 'x' * 24001})),
        throwsA(isA<FormatException>()),
      );
      expect(
        () => parsePromptProposal(
          jsonEncode({
            'positive': 'x' * 20000,
            'negative': 'x' * 20000,
            'characters': [
              {'positive': 'x' * 20000},
              {'positive': 'x' * 20000},
              {'positive': 'x' * 20000},
            ],
          }),
        ),
        throwsA(isA<FormatException>()),
      );
      expect(
        () => parsePromptProposal('x' * 200001),
        throwsA(isA<FormatException>()),
      );
      expect(
        () => parsePromptProposal(
          jsonEncode({
            'characters': List.generate(7, (_) => {'positive': 'x'}),
          }),
        ),
        throwsA(isA<FormatException>()),
      );
    });
  });
}

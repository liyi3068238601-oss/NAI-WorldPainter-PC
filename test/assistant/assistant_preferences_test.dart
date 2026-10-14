import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:worldpainter_pc/assistant/assistant_preferences.dart';
import 'package:worldpainter_pc/assistant/assistant_state.dart';
import 'package:worldpainter_pc/assistant/prompting_knowledge.dart';

void main() {
  group('AssistantPreferences', () {
    test(
      'defaults are empty and style lookup follows the prompting version',
      () {
        final defaults = AssistantPreferences();
        expect(defaults.v45StyleWords, isEmpty);
        expect(defaults.v5StyleWords, isEmpty);

        final preferences = AssistantPreferences(
          v45StyleWords: 'ink wash, artist-a',
          v5StyleWords: 'soft pastel, artist-b',
        );
        expect(
          preferences.styleWordsFor(PromptingVersion.v45),
          'ink wash, artist-a',
        );
        expect(
          preferences.styleWordsFor(PromptingVersion.v5),
          'soft pastel, artist-b',
        );
        expect(
          AssistantPreferences.fromJson(
            jsonDecode(jsonEncode(preferences.toJson()))
                as Map<String, dynamic>,
          ).toJson(),
          preferences.toJson(),
        );
      },
    );

    test('rejects missing, extra, non-string, and oversized fields', () {
      expect(
        () => AssistantPreferences.fromJson({'v45StyleWords': ''}),
        throwsFormatException,
      );
      expect(
        () => AssistantPreferences.fromJson({
          'v45StyleWords': '',
          'v5StyleWords': '',
          'unexpected': true,
        }),
        throwsFormatException,
      );
      expect(
        () => AssistantPreferences.fromJson({
          'v45StyleWords': 2,
          'v5StyleWords': '',
        }),
        throwsFormatException,
      );
      expect(
        () => AssistantPreferences(
          v45StyleWords: List<String>.filled(
            AssistantPreferences.maxStyleWordsLength + 1,
            'x',
          ).join(),
        ),
        throwsFormatException,
      );
    });
  });

  group('AssistantState assistant preferences compatibility', () {
    test('old snapshots default absent preferences', () {
      final oldSnapshot = AssistantState().toJson()..remove('preferences');

      final restored = AssistantState.fromJson(oldSnapshot);
      expect(restored.preferences.v45StyleWords, isEmpty);
      expect(restored.preferences.v5StyleWords, isEmpty);
      expect(restored.toJson().containsKey('knowledgeBase'), isFalse);
    });

    test(
      'rejects present malformed preferences and ignores legacy library',
      () {
        final badPreferences = AssistantState().toJson()
          ..['preferences'] = {'v45StyleWords': false, 'v5StyleWords': ''};
        expect(
          () => AssistantState.fromJson(badPreferences),
          throwsFormatException,
        );

        final oldLibrarySnapshot = AssistantState().toJson()
          ..['knowledgeBase'] = {'legacy': 'not read into persistent state'};
        final restored = AssistantState.fromJson(oldLibrarySnapshot);
        expect(restored.toJson().containsKey('knowledgeBase'), isFalse);
      },
    );
  });
}

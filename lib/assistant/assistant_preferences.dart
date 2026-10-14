import 'prompting_knowledge.dart' show PromptingVersion;

/// User-authored defaults for assistant prompt proposals.
///
/// These values are preferences for image-prompt wording, not generation
/// settings. Callers should apply them only when relevant to the current user
/// request and must keep them separate from diagnostic turns.
class AssistantPreferences {
  AssistantPreferences({this.v45StyleWords = '', this.v5StyleWords = ''}) {
    validate();
  }

  static const int maxStyleWordsLength = 12000;

  final String v45StyleWords;
  final String v5StyleWords;

  String styleWordsFor(PromptingVersion version) => switch (version) {
    PromptingVersion.v45 => v45StyleWords,
    PromptingVersion.v5 => v5StyleWords,
  };

  void validate() {
    _validateStyleWords(v45StyleWords, 'v45StyleWords');
    _validateStyleWords(v5StyleWords, 'v5StyleWords');
  }

  Map<String, dynamic> toJson() {
    validate();
    return {'v45StyleWords': v45StyleWords, 'v5StyleWords': v5StyleWords};
  }

  factory AssistantPreferences.fromJson(Map<String, dynamic> json) {
    _requireKeys(json, const {'v45StyleWords', 'v5StyleWords'});
    final v45StyleWords = json['v45StyleWords'];
    final v5StyleWords = json['v5StyleWords'];
    if (v45StyleWords is! String || v5StyleWords is! String) {
      throw const FormatException(
        'Assistant style preferences must be strings.',
      );
    }
    try {
      return AssistantPreferences(
        v45StyleWords: v45StyleWords,
        v5StyleWords: v5StyleWords,
      );
    } on FormatException {
      rethrow;
    } catch (error) {
      throw FormatException('Invalid assistant preferences: $error');
    }
  }
}

void _validateStyleWords(String value, String name) {
  if (value.length > AssistantPreferences.maxStyleWordsLength) {
    throw FormatException(
      '$name exceeds ${AssistantPreferences.maxStyleWordsLength} characters.',
    );
  }
  if (value.contains('\u0000')) {
    throw FormatException('$name cannot contain a NUL character.');
  }
}

void _requireKeys(Map<String, dynamic> json, Set<String> expected) {
  if (json.keys.toSet().difference(expected).isNotEmpty ||
      expected.difference(json.keys.toSet()).isNotEmpty) {
    throw const FormatException('Assistant preferences have an invalid shape.');
  }
}

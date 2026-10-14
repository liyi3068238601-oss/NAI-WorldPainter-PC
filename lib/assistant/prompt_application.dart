import 'prompting_knowledge.dart';

/// A local receipt for a user-approved text proposal, never a model tool result.
class PromptApplication {
  PromptApplication({
    required this.version,
    required this.reason,
    required this.appliedAt,
    required Map<String, String> before,
    required Map<String, String> after,
  }) : before = Map.unmodifiable(before),
       after = Map.unmodifiable(after) {
    if (reason.trim().isEmpty ||
        reason.length > 1000 ||
        DateTime.tryParse(appliedAt) == null ||
        before.isEmpty ||
        before.length != after.length ||
        !before.keys.every(after.containsKey)) {
      throw const FormatException('提示词应用记录无效。');
    }
    for (final fields in [before, after]) {
      if (fields.length > 16 ||
          fields.values.fold<int>(0, (n, s) => n + s.length) > 512000 ||
          fields.entries.any(
            (e) => !_target.hasMatch(e.key) || e.value.length > 32000,
          )) {
        throw const FormatException('提示词应用记录字段无效。');
      }
    }
  }

  final PromptingVersion version;
  final String reason, appliedAt;
  final Map<String, String> before, after;
  static final _target = RegExp(
    r'^(positive|negative|inpaint_positive|inpaint_negative|character_[1-6](_uc)?)$',
  );

  Map<String, dynamic> toJson() => {
    'version': version.name,
    'reason': reason,
    'appliedAt': appliedAt,
    'before': before,
    'after': after,
  };

  factory PromptApplication.fromJson(Map<String, dynamic> json) {
    try {
      return PromptApplication(
        version: PromptingVersion.values.byName(json['version'] as String),
        reason: json['reason'] as String,
        appliedAt: json['appliedAt'] as String,
        before: Map<String, String>.from(json['before'] as Map),
        after: Map<String, String>.from(json['after'] as Map),
      );
    } catch (_) {
      throw const FormatException('提示词应用记录无法读取。');
    }
  }
}

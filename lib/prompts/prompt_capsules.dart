import 'dart:convert';

import 'package:flutter/services.dart';

const promptCapsulesAssetPath = 'assets/prompts/capsules.json';

class PromptCapsule {
  final String id;
  final String category;
  final String subgroup;
  final String en;
  final String zh;
  final bool negative;

  const PromptCapsule({
    required this.id,
    required this.category,
    required this.subgroup,
    required this.en,
    required this.zh,
    required this.negative,
  });

  String get promptText => en.replaceAll('_', ' ').trim();

  factory PromptCapsule.fromJson(Object? value) {
    if (value is! Map || value.keys.any((key) => key is! String)) {
      throw const FormatException('Prompt capsule must be a JSON object.');
    }

    final json = Map<String, dynamic>.from(value);
    String requiredString(String key) {
      final field = json[key];
      if (field is! String || field.trim().isEmpty) {
        throw FormatException('Prompt capsule field "$key" must be a string.');
      }
      return field;
    }

    final negative = json['negative'];
    if (negative is! bool) {
      throw const FormatException(
        'Prompt capsule field "negative" must be a boolean.',
      );
    }

    return PromptCapsule(
      id: requiredString('id'),
      category: requiredString('category'),
      subgroup: requiredString('subgroup'),
      en: requiredString('en'),
      zh: requiredString('zh'),
      negative: negative,
    );
  }
}

Future<List<PromptCapsule>> loadPromptCapsules({AssetBundle? bundle}) async {
  final source = await (bundle ?? rootBundle).loadString(
    promptCapsulesAssetPath,
  );
  final decoded = jsonDecode(source);
  if (decoded is! List) {
    throw const FormatException(
      'Prompt capsule asset must contain a JSON list.',
    );
  }

  return List<PromptCapsule>.unmodifiable(decoded.map(PromptCapsule.fromJson));
}

List<PromptCapsule> queryPromptCapsules(
  Iterable<PromptCapsule> capsules, {
  String? search,
  String? category,
  String? subgroup,
  bool? negative,
}) {
  final needle = search?.trim().toLowerCase() ?? '';
  final categoryFilter = category?.trim();
  final subgroupFilter = subgroup?.trim();

  return capsules
      .where((capsule) {
        if (categoryFilter != null &&
            categoryFilter.isNotEmpty &&
            capsule.category != categoryFilter) {
          return false;
        }
        if (subgroupFilter != null &&
            subgroupFilter.isNotEmpty &&
            capsule.subgroup != subgroupFilter) {
          return false;
        }
        if (negative != null && capsule.negative != negative) return false;
        if (needle.isEmpty) return true;

        return capsule.en.toLowerCase().contains(needle) ||
            capsule.zh.toLowerCase().contains(needle) ||
            capsule.category.toLowerCase().contains(needle) ||
            capsule.subgroup.toLowerCase().contains(needle);
      })
      .toList(growable: false);
}

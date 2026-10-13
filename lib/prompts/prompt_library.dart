import 'dart:collection';
import 'dart:convert';

import '../media/image_asset_store_contract.dart';
import '../media/image_asset_validation.dart';

/// A reusable positive/negative prompt pair.
class PromptStyle {
  PromptStyle({
    required this.id,
    required this.name,
    required this.prompt,
    required this.negative,
    required this.category,
    this.previewAssetRef,
    required this.createdAt,
    required this.updatedAt,
  }) {
    _validate();
  }

  final String id;
  final String name;
  final String prompt;
  final String negative;
  final String category;
  final String? previewAssetRef;
  final DateTime createdAt;
  final DateTime updatedAt;

  PromptStyle copyWith({
    String? id,
    String? name,
    String? prompt,
    String? negative,
    String? category,
    String? previewAssetRef,
    bool clearPreviewAssetRef = false,
    DateTime? createdAt,
    DateTime? updatedAt,
  }) => PromptStyle(
    id: id ?? this.id,
    name: name ?? this.name,
    prompt: prompt ?? this.prompt,
    negative: negative ?? this.negative,
    category: category ?? this.category,
    previewAssetRef: clearPreviewAssetRef
        ? null
        : previewAssetRef ?? this.previewAssetRef,
    createdAt: createdAt ?? this.createdAt,
    updatedAt: updatedAt ?? this.updatedAt,
  );

  Map<String, Object?> toJson() => <String, Object?>{
    'id': id,
    'name': name,
    'prompt': prompt,
    'negative': negative,
    'category': category,
    'preview_asset_ref': previewAssetRef,
    'created_at': createdAt.toIso8601String(),
    'updated_at': updatedAt.toIso8601String(),
  };

  factory PromptStyle.fromJson(Map<String, dynamic> json) {
    _requireExactKeys(json, const {
      'id',
      'name',
      'prompt',
      'negative',
      'category',
      'preview_asset_ref',
      'created_at',
      'updated_at',
    }, '提示词风格');
    final previewAssetRef = json['preview_asset_ref'];
    if (previewAssetRef != null && previewAssetRef is! String) {
      throw const FormatException('提示词风格预览资产引用格式无效。');
    }
    return PromptStyle(
      id: _readString(json, 'id', '提示词风格'),
      name: _readString(json, 'name', '提示词风格'),
      prompt: _readString(json, 'prompt', '提示词风格'),
      negative: _readString(json, 'negative', '提示词风格'),
      category: _readString(json, 'category', '提示词风格'),
      previewAssetRef: previewAssetRef as String?,
      createdAt: _readDateTime(json, 'created_at', '提示词风格'),
      updatedAt: _readDateTime(json, 'updated_at', '提示词风格'),
    );
  }

  void _validate() {
    if (id.trim().isEmpty || name.trim().isEmpty) {
      throw const FormatException('提示词风格的 ID 和名称不能为空。');
    }
    if (prompt.trim().isEmpty && negative.trim().isEmpty) {
      throw const FormatException('风格的正向提示词和负向提示词不能同时为空。');
    }
    final assetRef = previewAssetRef;
    if (assetRef != null) {
      try {
        parseImageAssetRef(assetRef);
      } on ImageAssetValidationException {
        throw const FormatException('预览图必须引用受管图像资产。');
      }
    }
  }
}

/// An artist prompt, with its assigned categories and local usage information.
class PromptArtist {
  PromptArtist({
    required this.id,
    required this.name,
    required this.prompt,
    required Iterable<String> categories,
    required this.defaultWeight,
    required this.useCount,
    this.lastUsedAt,
    required this.danbooruCount,
    required this.createdAt,
    required this.updatedAt,
  }) : categories = List<String>.unmodifiable(categories) {
    _validate();
  }

  final String id;
  final String name;
  final String prompt;
  final List<String> categories;
  final double defaultWeight;
  final int useCount;
  final DateTime? lastUsedAt;
  final int danbooruCount;
  final DateTime createdAt;
  final DateTime updatedAt;

  PromptArtist copyWith({
    String? id,
    String? name,
    String? prompt,
    Iterable<String>? categories,
    double? defaultWeight,
    int? useCount,
    DateTime? lastUsedAt,
    bool clearLastUsedAt = false,
    int? danbooruCount,
    DateTime? createdAt,
    DateTime? updatedAt,
  }) => PromptArtist(
    id: id ?? this.id,
    name: name ?? this.name,
    prompt: prompt ?? this.prompt,
    categories: categories ?? this.categories,
    defaultWeight: defaultWeight ?? this.defaultWeight,
    useCount: useCount ?? this.useCount,
    lastUsedAt: clearLastUsedAt ? null : lastUsedAt ?? this.lastUsedAt,
    danbooruCount: danbooruCount ?? this.danbooruCount,
    createdAt: createdAt ?? this.createdAt,
    updatedAt: updatedAt ?? this.updatedAt,
  );

  Map<String, Object?> toJson() => <String, Object?>{
    'id': id,
    'name': name,
    'prompt': prompt,
    'categories': categories,
    'default_weight': defaultWeight,
    'use_count': useCount,
    'last_used_at': lastUsedAt?.toIso8601String(),
    'danbooru_count': danbooruCount,
    'created_at': createdAt.toIso8601String(),
    'updated_at': updatedAt.toIso8601String(),
  };

  factory PromptArtist.fromJson(Map<String, dynamic> json) {
    _requireExactKeys(json, const {
      'id',
      'name',
      'prompt',
      'categories',
      'default_weight',
      'use_count',
      'last_used_at',
      'danbooru_count',
      'created_at',
      'updated_at',
    }, '画师');
    final rawCategories = json['categories'];
    if (rawCategories is! List ||
        rawCategories.any((value) => value is! String)) {
      throw const FormatException('画师分类列表格式无效。');
    }
    final weight = json['default_weight'];
    final useCount = json['use_count'];
    final danbooruCount = json['danbooru_count'];
    if (weight is! num || useCount is! int || danbooruCount is! int) {
      throw const FormatException('画师权重或计数格式无效。');
    }
    return PromptArtist(
      id: _readString(json, 'id', '画师'),
      name: _readString(json, 'name', '画师'),
      prompt: _readString(json, 'prompt', '画师'),
      categories: rawCategories.cast<String>(),
      defaultWeight: weight.toDouble(),
      useCount: useCount,
      lastUsedAt: _readNullableDateTime(json, 'last_used_at', '画师'),
      danbooruCount: danbooruCount,
      createdAt: _readDateTime(json, 'created_at', '画师'),
      updatedAt: _readDateTime(json, 'updated_at', '画师'),
    );
  }

  void _validate() {
    if (id.trim().isEmpty || name.trim().isEmpty) {
      throw const FormatException('画师 ID 和名称不能为空。');
    }
    if (prompt.trim().isEmpty) {
      throw const FormatException('画师提示词不能为空。');
    }
    _validateWeight(defaultWeight);
    if (useCount < 0 || danbooruCount < 0) {
      throw const FormatException('画师计数不能为负数。');
    }
    if (categories.any((category) => category.trim().isEmpty) ||
        categories.toSet().length != categories.length) {
      throw const FormatException('画师分类列表无效。');
    }
  }
}

enum PromptSortOrder { name, recent, popularity }

/// In-memory prompt domain model. The owner persists [toJson] in [onChanged].
class PromptLibrary {
  PromptLibrary({
    Iterable<PromptStyle> styles = const [],
    Iterable<PromptArtist> artists = const [],
    Iterable<String> groups = const [],
    this.onChanged,
  }) {
    for (final group in groups) {
      _validateGroupName(group);
      if (_groupKeyExists(group)) {
        throw const FormatException('提示词分组名称重复。');
      }
      _groups[group] = group;
    }
    for (final style in styles) {
      if (_styles.containsKey(style.id)) {
        throw const FormatException('提示词风格 ID 重复。');
      }
      _styles[style.id] = style;
    }
    for (final artist in artists) {
      if (_artists.containsKey(artist.id)) {
        throw const FormatException('画师 ID 重复。');
      }
      _validateCategories(artist.categories);
      _artists[artist.id] = artist;
    }
  }

  static const int currentSchema = 1;
  static const String ungroupedCategory = '未分组';

  static int _idSequence = 0;

  final LinkedHashMap<String, PromptStyle> _styles =
      LinkedHashMap<String, PromptStyle>();
  final LinkedHashMap<String, PromptArtist> _artists =
      LinkedHashMap<String, PromptArtist>();
  final LinkedHashMap<String, String> _groups = LinkedHashMap<String, String>();

  /// Called synchronously after each successful mutation.
  void Function(PromptLibrary library)? onChanged;

  List<PromptStyle> get styles =>
      List<PromptStyle>.unmodifiable(_styles.values);
  List<PromptArtist> get artists =>
      List<PromptArtist>.unmodifiable(_artists.values);
  List<String> get groups => List<String>.unmodifiable(_groups.values);

  PromptStyle addStyle({
    required String name,
    required String prompt,
    required String negative,
    required String category,
    String? previewAssetRef,
    String? id,
    DateTime? createdAt,
  }) {
    final created = createdAt ?? _now();
    final style = PromptStyle(
      id: id ?? _newId('style'),
      name: name,
      prompt: prompt,
      negative: negative,
      category: category,
      previewAssetRef: previewAssetRef,
      createdAt: created,
      updatedAt: created,
    );
    if (_styles.containsKey(style.id)) {
      throw ArgumentError.value(style.id, 'id', '风格 ID 已存在。');
    }
    _styles[style.id] = style;
    _changed();
    return style;
  }

  PromptStyle updateStyle(PromptStyle style) {
    final current = _styles[style.id];
    if (current == null) throw StateError('找不到提示词风格：${style.id}');
    final updated = style.copyWith(
      createdAt: current.createdAt,
      updatedAt: _now(),
    );
    _styles[updated.id] = updated;
    _changed();
    return updated;
  }

  bool deleteStyle(String id) {
    if (_styles.remove(id) == null) return false;
    _changed();
    return true;
  }

  PromptArtist addArtist({
    required String name,
    required String prompt,
    Iterable<String> categories = const [],
    double defaultWeight = 1.0,
    int useCount = 0,
    DateTime? lastUsedAt,
    int danbooruCount = 0,
    String? id,
    DateTime? createdAt,
  }) {
    final created = createdAt ?? _now();
    final normalizedCategories = _normalizeCategories(categories);
    _validateCategories(normalizedCategories);
    final artist = PromptArtist(
      id: id ?? _newId('artist'),
      name: name,
      prompt: prompt,
      categories: normalizedCategories,
      defaultWeight: defaultWeight,
      useCount: useCount,
      lastUsedAt: lastUsedAt,
      danbooruCount: danbooruCount,
      createdAt: created,
      updatedAt: created,
    );
    if (_artists.containsKey(artist.id)) {
      throw ArgumentError.value(artist.id, 'id', '画师 ID 已存在。');
    }
    _artists[artist.id] = artist;
    _changed();
    return artist;
  }

  PromptArtist updateArtist(PromptArtist artist) {
    final current = _artists[artist.id];
    if (current == null) throw StateError('找不到画师：${artist.id}');
    final normalizedCategories = _normalizeCategories(artist.categories);
    _validateCategories(normalizedCategories);
    final updated = artist.copyWith(
      categories: normalizedCategories,
      createdAt: current.createdAt,
      updatedAt: _now(),
    );
    _artists[updated.id] = updated;
    _changed();
    return updated;
  }

  bool deleteArtist(String id) {
    if (_artists.remove(id) == null) return false;
    _changed();
    return true;
  }

  /// Records local use without changing [PromptArtist.updatedAt], which is
  /// reserved for the same edit/recent ordering used by the phone manager.
  PromptArtist recordArtistUse(String id, {DateTime? usedAt}) {
    final current = _artists[id];
    if (current == null) throw StateError('找不到画师：$id');
    final used = usedAt ?? _now();
    final updated = current.copyWith(
      useCount: current.useCount + 1,
      lastUsedAt: used,
    );
    _artists[id] = updated;
    _changed();
    return updated;
  }

  void addGroup(String name) {
    final group = name.trim();
    _validateGroupName(group);
    if (_groupKeyExists(group)) {
      throw const FormatException('分组名称已存在。');
    }
    _groups[group] = group;
    _changed();
  }

  bool renameGroup(String oldName, String newName) {
    final oldGroup = oldName.trim();
    final newGroup = newName.trim();
    if (!_groups.containsKey(oldGroup)) return false;
    _validateGroupName(newGroup);
    if (oldGroup == newGroup) return false;
    if (_groupKeyExists(newGroup) &&
        oldGroup.toLowerCase() != newGroup.toLowerCase()) {
      throw const FormatException('分组名称已存在。');
    }
    final nextGroups = <String, String>{};
    for (final group in _groups.values) {
      final value = group == oldGroup ? newGroup : group;
      nextGroups[value] = value;
    }
    _groups
      ..clear()
      ..addAll(nextGroups);
    final now = _now();
    for (final artist in artists) {
      if (!artist.categories.contains(oldGroup)) continue;
      final categories = artist.categories
          .map((category) => category == oldGroup ? newGroup : category)
          .toList(growable: false);
      _artists[artist.id] = artist.copyWith(
        categories: categories,
        updatedAt: now,
      );
    }
    _changed();
    return true;
  }

  bool deleteGroup(String name) {
    final group = name.trim();
    if (_groups.remove(group) == null) return false;
    final now = _now();
    for (final artist in artists) {
      if (!artist.categories.contains(group)) continue;
      final categories = artist.categories
          .where((category) => category != group)
          .toList();
      if (categories.isEmpty) categories.add(ungroupedCategory);
      _artists[artist.id] = artist.copyWith(
        categories: categories,
        updatedAt: now,
      );
    }
    _changed();
    return true;
  }

  List<PromptStyle> searchStyles(String query, {String? category}) {
    final normalized = query.trim().toLowerCase();
    return List<PromptStyle>.unmodifiable(
      styles.where((style) {
        final categoryMatches =
            category == null || category == '全部' || style.category == category;
        final queryMatches =
            normalized.isEmpty ||
            <String>[
              style.name,
              style.prompt,
              style.negative,
              style.category,
            ].join('\n').toLowerCase().contains(normalized);
        return categoryMatches && queryMatches;
      }),
    );
  }

  List<PromptArtist> searchArtists(String query, {String? category}) {
    final normalized = query.trim().toLowerCase();
    return List<PromptArtist>.unmodifiable(
      artists.where((artist) {
        final categoryMatches =
            category == null ||
            category == '全部' ||
            artist.categories.contains(category);
        final queryMatches =
            normalized.isEmpty ||
            artist.name.toLowerCase().contains(normalized) ||
            artist.prompt.toLowerCase().contains(normalized);
        return categoryMatches && queryMatches;
      }),
    );
  }

  List<PromptStyle> sortedStyles({
    PromptSortOrder order = PromptSortOrder.recent,
    String query = '',
    String? category,
  }) {
    if (order == PromptSortOrder.popularity) {
      throw ArgumentError('提示词风格没有热度字段，不能按热度排序。');
    }
    final result = searchStyles(query, category: category).toList();
    switch (order) {
      case PromptSortOrder.name:
        result.sort(_compareStyleNames);
        break;
      case PromptSortOrder.recent:
        result.sort((a, b) {
          final recent = b.updatedAt.compareTo(a.updatedAt);
          return recent == 0 ? a.id.compareTo(b.id) : recent;
        });
        break;
      case PromptSortOrder.popularity:
        break;
    }
    return List<PromptStyle>.unmodifiable(result);
  }

  List<PromptArtist> sortedArtists({
    PromptSortOrder order = PromptSortOrder.recent,
    String query = '',
    String? category,
  }) {
    final result = searchArtists(query, category: category).toList();
    switch (order) {
      case PromptSortOrder.name:
        result.sort(_compareArtistNames);
        break;
      case PromptSortOrder.recent:
        result.sort((a, b) {
          final recent = b.updatedAt.compareTo(a.updatedAt);
          return recent == 0 ? a.id.compareTo(b.id) : recent;
        });
        break;
      case PromptSortOrder.popularity:
        result.sort((a, b) {
          final popularity = b.danbooruCount.compareTo(a.danbooruCount);
          return popularity == 0 ? a.id.compareTo(b.id) : popularity;
        });
        break;
    }
    return List<PromptArtist>.unmodifiable(result);
  }

  /// Composes selected artists in recent-edit order, matching the phone manager.
  /// A weight of exactly 1 emits the prompt unchanged; other weights use NAI's
  /// `weight::prompt::` syntax without trimming or rewriting prompt text.
  String composeArtistPrompt(Map<String, double> weights) {
    for (final entry in weights.entries) {
      if (!_artists.containsKey(entry.key)) {
        throw ArgumentError.value(entry.key, 'weights', '所选画师不存在。');
      }
      _validateWeight(entry.value);
    }
    final parts = <String>[];
    for (final artist in sortedArtists()) {
      final weight = weights[artist.id];
      if (weight == null) continue;
      parts.add(
        weight == 1.0
            ? artist.prompt
            : '${weight.toString()}::${artist.prompt}::',
      );
    }
    return parts.join(', ');
  }

  Map<String, Object?> toJson() => <String, Object?>{
    'schema': currentSchema,
    'styles': _styles.values.map((style) => style.toJson()).toList(),
    'artists': _artists.values.map((artist) => artist.toJson()).toList(),
    'groups': _groups.values.toList(),
  };

  factory PromptLibrary.fromJson(
    Map<String, dynamic> json, {
    void Function(PromptLibrary library)? onChanged,
  }) {
    _requireExactKeys(json, const {
      'schema',
      'styles',
      'artists',
      'groups',
    }, '提示词库');
    final schema = json['schema'];
    if (schema is! int || schema != currentSchema) {
      throw const FormatException('不支持的提示词库 schema。');
    }
    final rawStyles = _readObjectList(json['styles'], '提示词风格');
    final rawArtists = _readObjectList(json['artists'], '画师');
    final rawGroups = json['groups'];
    if (rawGroups is! List || rawGroups.any((group) => group is! String)) {
      throw const FormatException('提示词分组列表格式无效。');
    }
    try {
      return PromptLibrary(
        styles: rawStyles.map(PromptStyle.fromJson),
        artists: rawArtists.map(PromptArtist.fromJson),
        groups: rawGroups.cast<String>(),
        onChanged: onChanged,
      );
    } on FormatException {
      rethrow;
    } on Object {
      throw const FormatException('提示词库数据无效。');
    }
  }

  /// Returns the legacy v12 export consumed by the phone manager.
  /// Numeric IDs are unique within this export; phone import assigns its own
  /// database IDs and does not treat the exported values as durable IDs.
  String toMobileExportJson() {
    final artistsJson = <Map<String, Object?>>[];
    var numericId = 1;
    for (final artist in _artists.values) {
      final categories = artist.categories
          .where((category) => category != ungroupedCategory)
          .toList(growable: false);
      artistsJson.add(<String, Object?>{
        'id': numericId++,
        'name': artist.name,
        'tag': artist.prompt,
        'imageUrl': '',
        'categories': categories.isEmpty ? <String>['未分类'] : categories,
        'danbooruCount': artist.danbooruCount,
        'createdAt': artist.createdAt.millisecondsSinceEpoch,
      });
    }
    final data = <String, Object?>{
      'version': 12,
      'artists': artistsJson,
      'categories': _groups.values.toList(),
      'presets': const <Object?>[],
    };
    return const JsonEncoder.withIndent('  ').convert(data);
  }

  void _validateCategories(Iterable<String> categories) {
    for (final category in categories) {
      if (category == ungroupedCategory) continue;
      if (!_groups.containsKey(category)) {
        throw FormatException('画师引用了不存在的分组：$category');
      }
    }
  }

  List<String> _normalizeCategories(Iterable<String> categories) {
    final result = <String>[];
    for (final category in categories) {
      final normalized = category.trim();
      if (normalized.isEmpty || result.contains(normalized)) continue;
      result.add(normalized);
    }
    if (result.isEmpty) result.add(ungroupedCategory);
    return result;
  }

  bool _groupKeyExists(String group) => _groups.keys.any(
    (existing) => existing.toLowerCase() == group.toLowerCase(),
  );

  void _validateGroupName(String name) {
    if (name.trim().isEmpty ||
        name != name.trim() ||
        name == ungroupedCategory ||
        name == '全部') {
      throw const FormatException('分组名称无效。');
    }
  }

  DateTime _now() => DateTime.now().toUtc();

  void _changed() => onChanged?.call(this);

  static String _newId(String prefix) {
    _idSequence++;
    return '$prefix-${DateTime.now().microsecondsSinceEpoch}-$_idSequence';
  }
}

int _compareStyleNames(PromptStyle a, PromptStyle b) {
  final byName = a.name.toLowerCase().compareTo(b.name.toLowerCase());
  return byName == 0 ? a.id.compareTo(b.id) : byName;
}

int _compareArtistNames(PromptArtist a, PromptArtist b) {
  final byName = a.name.toLowerCase().compareTo(b.name.toLowerCase());
  return byName == 0 ? a.id.compareTo(b.id) : byName;
}

void _validateWeight(double weight) {
  if (!weight.isFinite || weight < 0.1 || weight > 8.0) {
    throw const FormatException('画师权重必须是 0.1 到 8.0 之间的有限数字。');
  }
}

void _requireExactKeys(
  Map<dynamic, dynamic> json,
  Set<String> expected,
  String context,
) {
  if (json.length != expected.length ||
      json.keys.any((key) => key is! String || !expected.contains(key))) {
    throw FormatException('$context字段缺失或包含未知字段。');
  }
}

String _readString(Map<String, dynamic> json, String key, String context) {
  final value = json[key];
  if (value is! String) throw FormatException('$context字段 $key 格式无效。');
  return value;
}

DateTime _readDateTime(Map<String, dynamic> json, String key, String context) {
  final value = json[key];
  if (value is! String) throw FormatException('$context字段 $key 格式无效。');
  final date = DateTime.tryParse(value);
  if (date == null) throw FormatException('$context字段 $key 日期无效。');
  return date;
}

DateTime? _readNullableDateTime(
  Map<String, dynamic> json,
  String key,
  String context,
) {
  final value = json[key];
  if (value == null) return null;
  if (value is! String) throw FormatException('$context字段 $key 格式无效。');
  final date = DateTime.tryParse(value);
  if (date == null) throw FormatException('$context字段 $key 日期无效。');
  return date;
}

List<Map<String, dynamic>> _readObjectList(Object? value, String context) {
  if (value is! List) throw FormatException('$context列表格式无效。');
  return value
      .map((item) {
        if (item is! Map || item.keys.any((key) => key is! String)) {
          throw FormatException('$context条目格式无效。');
        }
        return Map<String, dynamic>.from(item);
      })
      .toList(growable: false);
}

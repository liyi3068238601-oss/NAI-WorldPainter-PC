import 'dart:convert';

import '../assistant/wd_tagger.dart';
import '../media/image_asset_store_contract.dart';
import '../media/image_asset_validation.dart';

enum ImageTagAnalysisMode { naiMetadata, wdTagger }

/// One reviewable label. [group] is used for role prompts found in NAI data.
class ImageTagCandidate {
  const ImageTagCandidate({
    required this.tag,
    required this.confidence,
    required this.selected,
    this.group,
  });

  final String tag;
  final double confidence;
  final bool selected;
  final String? group;

  ImageTagCandidate copyWith({bool? selected}) => ImageTagCandidate(
    tag: tag,
    confidence: confidence,
    selected: selected ?? this.selected,
    group: group,
  );

  Map<String, Object?> toJson() => {
    'tag': tag,
    'confidence': confidence,
    'selected': selected,
    'group': group,
  };

  factory ImageTagCandidate.fromJson(Map<String, Object?> json) {
    if (!_hasExactKeys(json, const {
      'tag',
      'confidence',
      'selected',
      'group',
    })) {
      throw const FormatException('图片标签候选字段无效。');
    }
    final tag = json['tag'];
    final confidence = json['confidence'];
    final selected = json['selected'];
    final group = json['group'];
    if (tag is! String ||
        tag.trim().isEmpty ||
        tag.length > _maxTagLength ||
        confidence is! num ||
        !confidence.isFinite ||
        confidence < 0 ||
        confidence > 1 ||
        selected is! bool ||
        (group != null && (group is! String || group.length > 80))) {
      throw const FormatException('图片标签候选值无效。');
    }
    return ImageTagCandidate(
      tag: tag,
      confidence: confidence.toDouble(),
      selected: selected,
      group: group as String?,
    );
  }
}

/// WD parameters captured for a single explicit analysis action.
///
/// The global `enabled` setting is intentionally not part of this value: a
/// user can explicitly analyze one image without changing that assistant
/// preference.
class ImageTagWdSettings {
  const ImageTagWdSettings({
    required this.baseUrl,
    required this.model,
    required this.generalThreshold,
    required this.characterThreshold,
    required this.generalMcut,
    required this.characterMcut,
  });

  final String baseUrl;
  final String model;
  final double generalThreshold;
  final double characterThreshold;
  final bool generalMcut;
  final bool characterMcut;

  factory ImageTagWdSettings.fromWdTagger(WdTaggerSettings settings) =>
      ImageTagWdSettings(
        baseUrl: settings.baseUrl,
        model: settings.model,
        generalThreshold: settings.generalThreshold,
        characterThreshold: settings.characterThreshold,
        generalMcut: settings.generalMcut,
        characterMcut: settings.characterMcut,
      )..toWdTaggerSettings();

  WdTaggerSettings toWdTaggerSettings() {
    final settings = WdTaggerSettings(
      enabled: true,
      baseUrl: baseUrl,
      model: model,
      generalThreshold: generalThreshold,
      characterThreshold: characterThreshold,
      generalMcut: generalMcut,
      characterMcut: characterMcut,
    );
    settings.validate();
    return settings;
  }

  Map<String, Object?> toJson() => {
    'baseUrl': baseUrl,
    'model': model,
    'generalThreshold': generalThreshold,
    'characterThreshold': characterThreshold,
    'generalMcut': generalMcut,
    'characterMcut': characterMcut,
  };

  factory ImageTagWdSettings.fromJson(Map<String, Object?> json) {
    if (!_hasExactKeys(json, const {
      'baseUrl',
      'model',
      'generalThreshold',
      'characterThreshold',
      'generalMcut',
      'characterMcut',
    })) {
      throw const FormatException('图片分析中的 WD 设置字段无效。');
    }
    final baseUrl = json['baseUrl'];
    final model = json['model'];
    final generalThreshold = json['generalThreshold'];
    final characterThreshold = json['characterThreshold'];
    final generalMcut = json['generalMcut'];
    final characterMcut = json['characterMcut'];
    if (baseUrl is! String ||
        model is! String ||
        generalThreshold is! num ||
        characterThreshold is! num ||
        !generalThreshold.isFinite ||
        !characterThreshold.isFinite ||
        generalMcut is! bool ||
        characterMcut is! bool) {
      throw const FormatException('图片分析中的 WD 设置值无效。');
    }
    return ImageTagWdSettings(
      baseUrl: baseUrl,
      model: model,
      generalThreshold: generalThreshold.toDouble(),
      characterThreshold: characterThreshold.toDouble(),
      generalMcut: generalMcut,
      characterMcut: characterMcut,
    )..toWdTaggerSettings();
  }
}

/// Persisted, versioned state for the independent image-tag review page.
///
/// Only a content-addressed `assetRef` is stored for the source. Original image
/// bytes and local paths never enter this state.
class ImageTagReviewState {
  ImageTagReviewState({
    this.mode = ImageTagAnalysisMode.naiMetadata,
    this.sourceAssetRef,
    this.sourceGalleryId,
    this.analyzed = false,
    this.wdSettings,
    Map<String, Object?> metadataFields = const {},
    this.metadataSource,
    List<String> metadataWarnings = const [],
    List<ImageTagCandidate> generalTags = const [],
    List<ImageTagCandidate> characterTags = const [],
    List<ImageTagCandidate> ratingTags = const [],
    List<ImageTagCandidate> negativeTags = const [],
    Map<String, String> translations = const {},
  }) : metadataFields = Map.unmodifiable(_copyJsonMap(metadataFields)),
       metadataWarnings = List.unmodifiable(metadataWarnings),
       generalTags = List.unmodifiable(generalTags),
       characterTags = List.unmodifiable(characterTags),
       ratingTags = List.unmodifiable(ratingTags),
       negativeTags = List.unmodifiable(negativeTags),
       translations = Map.unmodifiable(translations) {
    _validate();
  }

  static const int schema = 1;
  static const int maxCandidates = 2500;
  static const int _maxTagLength = 256;
  static const int _maxMetadataJsonBytes = 256 * 1024;
  static const int _maxStateJsonBytes = 1024 * 1024;

  static final ImageTagReviewState empty = ImageTagReviewState();

  final ImageTagAnalysisMode mode;
  final String? sourceAssetRef;
  final String? sourceGalleryId;
  final bool analyzed;
  final ImageTagWdSettings? wdSettings;
  final Map<String, Object?> metadataFields;
  final String? metadataSource;
  final List<String> metadataWarnings;
  final List<ImageTagCandidate> generalTags;
  final List<ImageTagCandidate> characterTags;
  final List<ImageTagCandidate> ratingTags;
  final List<ImageTagCandidate> negativeTags;
  final Map<String, String> translations;

  int get candidateCount =>
      generalTags.length +
      characterTags.length +
      ratingTags.length +
      negativeTags.length;

  bool get hasSelectedCandidates =>
      generalTags.any((item) => item.selected) ||
      characterTags.any((item) => item.selected) ||
      ratingTags.any((item) => item.selected) ||
      negativeTags.any((item) => item.selected);

  Map<String, Object?> toJson() => {
    'schema': schema,
    'mode': mode.name,
    'sourceAssetRef': sourceAssetRef,
    'sourceGalleryId': sourceGalleryId,
    'analyzed': analyzed,
    'wdSettings': wdSettings?.toJson(),
    'metadataFields': _copyJsonMap(metadataFields),
    'metadataSource': metadataSource,
    'metadataWarnings': metadataWarnings,
    'generalTags': generalTags.map((item) => item.toJson()).toList(),
    'characterTags': characterTags.map((item) => item.toJson()).toList(),
    'ratingTags': ratingTags.map((item) => item.toJson()).toList(),
    'negativeTags': negativeTags.map((item) => item.toJson()).toList(),
    'translations': translations,
  };

  ImageTagReviewState copyWith({
    ImageTagAnalysisMode? mode,
    String? sourceAssetRef,
    bool clearSourceAssetRef = false,
    String? sourceGalleryId,
    bool clearSourceGalleryId = false,
    bool? analyzed,
    ImageTagWdSettings? wdSettings,
    bool clearWdSettings = false,
    Map<String, Object?>? metadataFields,
    String? metadataSource,
    bool clearMetadataSource = false,
    List<String>? metadataWarnings,
    List<ImageTagCandidate>? generalTags,
    List<ImageTagCandidate>? characterTags,
    List<ImageTagCandidate>? ratingTags,
    List<ImageTagCandidate>? negativeTags,
    Map<String, String>? translations,
  }) => ImageTagReviewState(
    mode: mode ?? this.mode,
    sourceAssetRef: clearSourceAssetRef
        ? null
        : (sourceAssetRef ?? this.sourceAssetRef),
    sourceGalleryId: clearSourceGalleryId
        ? null
        : (sourceGalleryId ?? this.sourceGalleryId),
    analyzed: analyzed ?? this.analyzed,
    wdSettings: clearWdSettings ? null : (wdSettings ?? this.wdSettings),
    metadataFields: metadataFields ?? this.metadataFields,
    metadataSource: clearMetadataSource
        ? null
        : (metadataSource ?? this.metadataSource),
    metadataWarnings: metadataWarnings ?? this.metadataWarnings,
    generalTags: generalTags ?? this.generalTags,
    characterTags: characterTags ?? this.characterTags,
    ratingTags: ratingTags ?? this.ratingTags,
    negativeTags: negativeTags ?? this.negativeTags,
    translations: translations ?? this.translations,
  );

  factory ImageTagReviewState.fromJson(Map<String, Object?> json) {
    if (json.isEmpty) return empty;
    const keys = {
      'schema',
      'mode',
      'sourceAssetRef',
      'sourceGalleryId',
      'analyzed',
      'wdSettings',
      'metadataFields',
      'metadataSource',
      'metadataWarnings',
      'generalTags',
      'characterTags',
      'ratingTags',
      'negativeTags',
      'translations',
    };
    if (!_hasExactKeys(json, keys) || json['schema'] != schema) {
      throw const FormatException('图片审阅状态版本或字段无效。');
    }
    final mode = switch (json['mode']) {
      'naiMetadata' => ImageTagAnalysisMode.naiMetadata,
      'wdTagger' => ImageTagAnalysisMode.wdTagger,
      _ => throw const FormatException('图片分析模式无效。'),
    };
    final sourceAssetRef = json['sourceAssetRef'];
    final sourceGalleryId = json['sourceGalleryId'];
    final analyzed = json['analyzed'];
    final wdSettingsJson = json['wdSettings'];
    final metadataJson = json['metadataFields'];
    final metadataSource = json['metadataSource'];
    final warningsJson = json['metadataWarnings'];
    final translationsJson = json['translations'];
    if ((sourceAssetRef != null && sourceAssetRef is! String) ||
        (sourceGalleryId != null && sourceGalleryId is! String) ||
        analyzed is! bool ||
        (wdSettingsJson != null && wdSettingsJson is! Map) ||
        metadataJson is! Map ||
        (metadataSource != null && metadataSource is! String) ||
        warningsJson is! List ||
        translationsJson is! Map) {
      throw const FormatException('图片审阅状态值无效。');
    }
    final warnings = <String>[];
    for (final warning in warningsJson) {
      if (warning is! String) {
        throw const FormatException('图片元数据警告无效。');
      }
      warnings.add(warning);
    }
    final translations = <String, String>{};
    for (final entry in translationsJson.entries) {
      if (entry.key is! String || entry.value is! String) {
        throw const FormatException('图片标签翻译无效。');
      }
      translations[entry.key as String] = entry.value as String;
    }
    ImageTagWdSettings? wdSettings;
    if (wdSettingsJson != null) {
      wdSettings = ImageTagWdSettings.fromJson(
        Map<String, Object?>.from(wdSettingsJson as Map),
      );
    }
    return ImageTagReviewState(
      mode: mode,
      sourceAssetRef: sourceAssetRef as String?,
      sourceGalleryId: sourceGalleryId as String?,
      analyzed: analyzed,
      wdSettings: wdSettings,
      metadataFields: Map<String, Object?>.from(metadataJson),
      metadataSource: metadataSource as String?,
      metadataWarnings: warnings,
      generalTags: _parseCandidates(json['generalTags']),
      characterTags: _parseCandidates(json['characterTags']),
      ratingTags: _parseCandidates(json['ratingTags']),
      negativeTags: _parseCandidates(json['negativeTags']),
      translations: translations,
    );
  }

  void _validate() {
    if (sourceAssetRef != null) {
      try {
        parseImageAssetRef(sourceAssetRef!);
      } on ImageAssetValidationException {
        throw const FormatException('图片审阅状态只能保存受管图片引用。');
      }
    }
    if (sourceGalleryId != null &&
        (sourceAssetRef == null ||
            sourceGalleryId!.isEmpty ||
            sourceGalleryId!.length > 200)) {
      throw const FormatException('图片图库来源无效。');
    }
    if (metadataSource != null && metadataSource!.length > 80) {
      throw const FormatException('图片元数据来源无效。');
    }
    const metadataKeys = {
      'model',
      'width',
      'height',
      'steps',
      'scale',
      'cfg_rescale',
      'sampler',
      'noise_schedule',
      'seed',
      'use_coords',
    };
    if (metadataFields.keys.any((key) => !metadataKeys.contains(key))) {
      throw const FormatException('图片元数据包含未允许保存的字段。');
    }
    for (final entry in metadataFields.entries) {
      final value = entry.value;
      final valid = switch (entry.key) {
        'model' ||
        'sampler' ||
        'noise_schedule' => value is String && value.length <= 256,
        'width' || 'height' => value is int && value > 0 && value <= 4096,
        'steps' => value is int && value >= 1 && value <= 50,
        'seed' => value is int && value >= 0,
        'scale' => value is num && value.isFinite && value >= 1 && value <= 10,
        'cfg_rescale' =>
          value is num && value.isFinite && value >= 0 && value <= 1,
        'use_coords' => value is bool,
        _ => false,
      };
      if (!valid) throw const FormatException('图片元数据字段值无效。');
    }
    if (metadataWarnings.length > 50 ||
        metadataWarnings.any((item) => item.length > 512)) {
      throw const FormatException('图片元数据警告超出支持范围。');
    }
    if (candidateCount > maxCandidates) {
      throw const FormatException('图片标签数量超出支持范围。');
    }
    final candidates = [
      ...generalTags,
      ...characterTags,
      ...ratingTags,
      ...negativeTags,
    ];
    if (candidates.any(
      (item) =>
          item.tag.trim().isEmpty ||
          item.tag.length > _maxTagLength ||
          !item.confidence.isFinite ||
          item.confidence < 0 ||
          item.confidence > 1 ||
          (item.group?.length ?? 0) > 80,
    )) {
      throw const FormatException('图片标签候选无效。');
    }
    final allTagNames = candidates.map((item) => item.tag).toSet();
    if (translations.length > maxCandidates ||
        translations.entries.any(
          (entry) =>
              !allTagNames.contains(entry.key) ||
              entry.value.trim().isEmpty ||
              entry.value.length > _maxTagLength,
        )) {
      throw const FormatException('图片标签翻译超出支持范围。');
    }
    if (!analyzed &&
        (wdSettings != null ||
            metadataFields.isNotEmpty ||
            metadataSource != null ||
            metadataWarnings.isNotEmpty ||
            candidates.isNotEmpty ||
            translations.isNotEmpty)) {
      throw const FormatException('尚未分析的图片不能包含结果。');
    }
    if (analyzed && sourceAssetRef == null) {
      throw const FormatException('图片分析结果缺少受管来源引用。');
    }
    if (mode == ImageTagAnalysisMode.wdTagger &&
        analyzed != (wdSettings != null)) {
      throw const FormatException('WD 分析设置与结果状态不一致。');
    }
    if (mode == ImageTagAnalysisMode.wdTagger &&
        (metadataFields.isNotEmpty || metadataSource != null)) {
      throw const FormatException('WD 结果不能包含 NAI 元数据。');
    }
    if (mode == ImageTagAnalysisMode.naiMetadata && wdSettings != null) {
      throw const FormatException('NAI 元数据结果不能包含 WD 设置。');
    }
    final metadataJson = jsonEncode(metadataFields);
    if (utf8.encode(metadataJson).length > _maxMetadataJsonBytes ||
        utf8.encode(jsonEncode(toJson())).length > _maxStateJsonBytes) {
      throw const FormatException('图片审阅状态超出存储大小限制。');
    }
  }
}

const int _maxTagLength = ImageTagReviewState._maxTagLength;

List<ImageTagCandidate> _parseCandidates(Object? raw) {
  if (raw is! List) throw const FormatException('图片标签列表无效。');
  return raw
      .map(
        (item) =>
            ImageTagCandidate.fromJson(Map<String, Object?>.from(item as Map)),
      )
      .toList();
}

Map<String, Object?> _copyJsonMap(Map<String, Object?> value) =>
    Map<String, Object?>.from(jsonDecode(jsonEncode(value)) as Map);

bool _hasExactKeys(Map<dynamic, dynamic> json, Set<String> expected) =>
    json.length == expected.length &&
    json.keys.every((key) => key is String && expected.contains(key));

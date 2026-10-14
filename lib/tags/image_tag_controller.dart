import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../assistant/agent_contract.dart';
import '../assistant/image_analysis.dart';
import '../assistant/wd_tagger.dart';
import '../media/image_asset.dart';
import '../metadata/image_metadata_parser.dart';
import '../platform/image_picker.dart' show pickImage;
import '../prompts/prompt_insertion.dart';
import '../prototype/workbench_controller.dart';
import '../security/credential_vault.dart';
import 'image_tag_review.dart';

enum ImageTagCategory { general, character, rating, negative }

class ImageTagPromptChange {
  ImageTagPromptChange._({
    required this.target,
    required this.before,
    required this.after,
    required this.sourceVersion,
    required this.reviewRevision,
    required this.draftFingerprint,
  });

  final String target;
  final String before;
  final String after;
  final int sourceVersion;
  final int reviewRevision;
  final String draftFingerprint;
  bool _committed = false;

  bool get committed => _committed;
}

class ImageTagPromptSaveException implements Exception {
  const ImageTagPromptSaveException(this.cause);
  final Object cause;

  @override
  String toString() => '提示词已应用，但保存失败：$cause';
}

/// Coordinates image tagging without entering the assistant conversation loop.
///
/// Network work begins only after an explicit analysis or translation action.
/// Each operation freezes its input and is cancelled when its source changes or
/// this page controller is disposed.
class ImageTagController extends ChangeNotifier {
  ImageTagController({
    required this.workbench,
    WdTaggerClient? wdTaggerClient,
    this.translationTimeout = const Duration(seconds: 45),
  }) : wdTaggerClient = wdTaggerClient ?? workbench.assistant.wdTaggerClient,
       _review = ImageTagReviewState.fromJson(workbench.imageTagReview) {
    workbench.addListener(_workbenchChanged);
  }

  static const int maxTranslationTags = 300;
  static const int maxTranslationTextLength = 12000;

  final WorkbenchController workbench;
  final WdTaggerClient wdTaggerClient;
  final Duration translationTimeout;

  ImageTagReviewState _review;
  AgentCancellation? _analysisCancellation;
  AgentCancellation? _translationCancellation;
  Timer? _translationTimer;
  bool _disposed = false;
  int _sourceVersion = 0;
  int _reviewRevision = 0;
  int _analysisOperation = 0;
  int _translationOperation = 0;

  bool isAnalyzing = false;
  bool isImporting = false;
  bool isTranslating = false;
  String? error;

  ImageTagReviewState get review => _review;
  ImageTagAnalysisMode get mode => _review.mode;
  int get sourceVersion => _sourceVersion;
  int get reviewRevision => _reviewRevision;
  bool get hasSource => _review.sourceAssetRef != null;
  String? get sourceAssetRef => _review.sourceAssetRef;
  bool get canApplyPrompt =>
      hasSource &&
      _review.hasSelectedCandidates &&
      !isAnalyzing &&
      !isImporting &&
      !workbench.assistant.busy &&
      !workbench.generating &&
      !workbench.maintainingAssets &&
      !workbench.encodingVibe &&
      !workbench.closing;

  List<ImageTagCandidate> tagsFor(ImageTagCategory category) =>
      switch (category) {
        ImageTagCategory.general => _review.generalTags,
        ImageTagCategory.character => _review.characterTags,
        ImageTagCategory.rating => _review.ratingTags,
        ImageTagCategory.negative => _review.negativeTags,
      };

  void _workbenchChanged() {
    if (!_disposed) notifyListeners();
  }

  Future<ImageAsset?> pickLocalImage() async {
    final bytes = await pickImage();
    if (bytes == null || _disposed) return null;
    return importLocalImage(bytes);
  }

  Future<ImageAsset> importLocalImage(Uint8List bytes) async {
    if (workbench.assets == null) {
      throw const AgentException('当前工作区没有可用的图片资产存储。');
    }
    if (_disposed || workbench.closing || workbench.maintainingAssets) {
      throw const AgentException('当前工作区不能导入图片。');
    }
    _cancelOperations();
    final operation = ++_sourceVersion;
    isImporting = true;
    error = null;
    notifyListeners();
    try {
      final frozenBytes = Uint8List.fromList(bytes);
      late final ImageAsset asset;
      await workbench.prepareEditing(() async {
        asset = await workbench.assets!.save(frozenBytes);
      });
      if (_disposed || operation != _sourceVersion) return asset;
      _replaceReview(
        ImageTagReviewState(mode: _review.mode, sourceAssetRef: asset.assetRef),
        sourceChanged: false,
      );
      await workbench.flush(retry: true);
      return asset;
    } catch (caught) {
      if (!_disposed && operation == _sourceVersion) {
        error = _publicError(caught, fallback: '图片导入或保存失败。');
        notifyListeners();
      }
      rethrow;
    } finally {
      if (!_disposed && operation == _sourceVersion) {
        isImporting = false;
        notifyListeners();
      }
    }
  }

  void selectGalleryImage(SceneResult result) {
    final ref = result.assetRef;
    if (ref == null) {
      error = '这张图库记录没有受管原图，无法进行图片反推。';
      notifyListeners();
      return;
    }
    if (isAnalyzing || isImporting) return;
    _cancelOperations();
    _sourceVersion++;
    error = null;
    _replaceReview(
      ImageTagReviewState(
        mode: _review.mode,
        sourceAssetRef: ref,
        sourceGalleryId: result.id,
      ),
      sourceChanged: false,
    );
  }

  void clearSource() {
    if (isAnalyzing || isImporting) return;
    _cancelOperations();
    _sourceVersion++;
    error = null;
    _replaceReview(
      ImageTagReviewState(mode: _review.mode),
      sourceChanged: false,
    );
  }

  void setMode(ImageTagAnalysisMode next) {
    if (next == _review.mode || isAnalyzing || isImporting) return;
    _cancelOperations();
    _sourceVersion++;
    error = null;
    _replaceReview(
      ImageTagReviewState(
        mode: next,
        sourceAssetRef: _review.sourceAssetRef,
        sourceGalleryId: _review.sourceGalleryId,
      ),
      sourceChanged: false,
    );
  }

  Future<void> analyze() async {
    final sourceRef = _review.sourceAssetRef;
    if (sourceRef == null) throw const AgentException('请先选择或导入一张图片。');
    if (workbench.assets == null) {
      throw const AgentException('当前工作区没有可用的图片资产存储。');
    }
    if (isAnalyzing || isImporting || _disposed) return;

    _cancelOperations();
    _sourceVersion++;
    final sourceVersion = _sourceVersion;
    final operation = ++_analysisOperation;
    final modeSnapshot = _review.mode;
    final galleryId = _review.sourceGalleryId;
    // Copy all public WD parameters now. The per-action enabled bit is set
    // only on this local request snapshot, never in assistant.state.
    final wdSnapshot = modeSnapshot == ImageTagAnalysisMode.wdTagger
        ? ImageTagWdSettings.fromWdTagger(workbench.assistant.state.wdTagger)
        : null;
    final cancellation = AgentCancellation();
    _analysisCancellation = cancellation;
    isAnalyzing = true;
    error = null;
    _replaceReview(
      ImageTagReviewState(
        mode: modeSnapshot,
        sourceAssetRef: sourceRef,
        sourceGalleryId: galleryId,
      ),
      sourceChanged: false,
      cancelOperations: false,
    );
    notifyListeners();

    try {
      final bytes = await cancellation.bind(workbench.assets!.read(sourceRef));
      cancellation.check();
      final ImageTagReviewState result;
      if (modeSnapshot == ImageTagAnalysisMode.naiMetadata) {
        final metadata = await parseImageMetadata(bytes);
        cancellation.check();
        result = _fromMetadata(
          metadata,
          sourceAssetRef: sourceRef,
          sourceGalleryId: galleryId,
        );
      } else {
        final png = await prepareAssistantImage(bytes, cancellation);
        final wdResult = await cancellation.bind(
          wdTaggerClient.analyze(
            bytes: png,
            settings: wdSnapshot!.toWdTaggerSettings(),
            cancellation: cancellation,
          ),
        );
        cancellation.check();
        result = _fromWdResult(
          wdResult,
          sourceAssetRef: sourceRef,
          sourceGalleryId: galleryId,
          settings: wdSnapshot,
        );
      }
      if (!_isCurrentAnalysis(operation, sourceVersion, cancellation)) return;
      _replaceReview(result, sourceChanged: false, cancelOperations: false);
    } on AgentCancelled {
      if (_isCurrentAnalysis(operation, sourceVersion, cancellation)) {
        error = '分析已取消。';
      }
    } catch (caught) {
      if (_isCurrentAnalysis(operation, sourceVersion, cancellation)) {
        error = _publicError(caught, fallback: '图片分析失败。');
      }
    } finally {
      if (!_disposed && operation == _analysisOperation) {
        _analysisCancellation = null;
        isAnalyzing = false;
        notifyListeners();
      }
    }
  }

  void cancelAnalysis() {
    _analysisCancellation?.cancel();
  }

  void toggleTag(ImageTagCategory category, int index) {
    final items = [...tagsFor(category)];
    if (index < 0 || index >= items.length) return;
    items[index] = items[index].copyWith(selected: !items[index].selected);
    _replaceReview(_withCategory(category, items));
  }

  void selectAll(ImageTagCategory category) {
    _replaceReview(
      _withCategory(
        category,
        tagsFor(category).map((item) => item.copyWith(selected: true)).toList(),
      ),
    );
  }

  void invertSelection(ImageTagCategory category) {
    _replaceReview(
      _withCategory(
        category,
        tagsFor(category)
            .map((item) => item.copyWith(selected: !item.selected))
            .toList(),
      ),
    );
  }

  Future<void> translateSelectedTags() async {
    if (!canTranslate || isTranslating) return;
    final tags = _selectedUniqueTags();
    if (tags.isEmpty) {
      error = '请先勾选要翻译的标签。';
      notifyListeners();
      return;
    }
    final totalLength = tags.fold<int>(0, (sum, tag) => sum + tag.length);
    if (tags.length > maxTranslationTags ||
        totalLength > maxTranslationTextLength) {
      error = '当前勾选的标签较多，请减少到 $maxTranslationTags 个以内再翻译。';
      notifyListeners();
      return;
    }

    _translationCancellation?.cancel();
    final cancellation = AgentCancellation();
    _translationCancellation = cancellation;
    final sourceVersion = _sourceVersion;
    final reviewRevision = _reviewRevision;
    final operation = ++_translationOperation;
    var timedOut = false;
    isTranslating = true;
    error = null;
    _translationTimer?.cancel();
    _translationTimer = Timer(translationTimeout, () {
      timedOut = true;
      cancellation.cancel();
    });
    notifyListeners();

    try {
      final provider = await _chooseTranslationProvider(cancellation);
      cancellation.check();
      final reply = await cancellation.bind(
        workbench.assistant.transport.complete(
          provider: provider,
          messages: [
            {
              'role': 'system',
              'content':
                  '你是一个 Danbooru 标签翻译器。用户会给你一串英文标签（逗号分隔），'
                  '你需要把每个标签翻译成简体中文，返回一个 JSON 对象，key 是原英文标签，'
                  'value 是中文翻译。只输出 JSON，不要任何其他文字。例如：\n'
                  '输入：1girl, long_hair, blue_eyes\n'
                  '输出：{"1girl": "1个女孩", "long_hair": "长发", "blue_eyes": "蓝眼睛"}',
            },
            {'role': 'user', 'content': tags.join(', ')},
          ],
          tools: const [],
          toolChoice: 'none',
          cancellation: cancellation,
        ),
      );
      cancellation.check();
      if (reply.calls.isNotEmpty ||
          reply.finishReason == 'length' ||
          reply.content.trim().isEmpty) {
        throw const AgentException('模型没有返回完整的标签翻译 JSON。');
      }
      final translations = _parseTranslations(reply.content, tags.toSet());
      if (!_isCurrentTranslation(
        operation,
        sourceVersion,
        reviewRevision,
        tags,
      )) {
        return;
      }
      final merged = Map<String, String>.from(_review.translations)
        ..addAll(translations);
      _translationCancellation = null;
      _replaceReview(
        _review.copyWith(translations: merged),
        cancelOperations: false,
      );
    } on AgentCancelled {
      if (!_disposed && operation == _translationOperation) {
        error = timedOut ? '标签翻译超时，未采用迟到的回复。' : '标签翻译已取消。';
      }
    } catch (caught) {
      if (!_disposed && operation == _translationOperation) {
        error = _publicError(caught, fallback: '标签翻译失败；英文标签保持不变。');
      }
    } finally {
      if (operation == _translationOperation) {
        _translationTimer?.cancel();
        _translationTimer = null;
        _translationCancellation = null;
        if (!_disposed) {
          isTranslating = false;
          notifyListeners();
        }
      }
    }
  }

  bool get canTranslate =>
      hasSource &&
      _review.analyzed &&
      _review.hasSelectedCandidates &&
      !isImporting;

  void cancelTranslation() {
    _translationTimer?.cancel();
    _translationTimer = null;
    _translationCancellation?.cancel();
  }

  ImageTagPromptChange previewPromptChange({
    required String target,
    required bool replace,
  }) {
    if (!canApplyPrompt) {
      throw const AgentException('当前工作区或图片审阅状态不允许写入提示词。');
    }
    final positiveTarget =
        !target.endsWith('negative') && !target.endsWith('_uc');
    final tags = _selectedTagsForTarget(positive: positiveTarget);
    if (tags.isEmpty) throw const AgentException('目标词框没有对应的已选标签。');
    final before = workbench.assistantPromptValue(target);
    final addition = tags.join(', ');
    final after = replace ? addition : appendPromptText(before, addition);
    return ImageTagPromptChange._(
      target: target,
      before: before,
      after: after,
      sourceVersion: _sourceVersion,
      reviewRevision: _reviewRevision,
      draftFingerprint: workbench.assistantDraftFingerprint,
    );
  }

  Future<void> commitPromptChange(ImageTagPromptChange change) async {
    if (change._committed) {
      throw const AgentException('这次提示词确认已处理，不能重复应用。');
    }
    if (!canApplyPrompt ||
        change.sourceVersion != _sourceVersion ||
        change.reviewRevision != _reviewRevision ||
        change.draftFingerprint != workbench.assistantDraftFingerprint ||
        workbench.assistantPromptValue(change.target) != change.before) {
      throw const AgentException('确认期间图片选择、标签或草稿发生变化；请重新预览。');
    }
    workbench.applyAssistantPrompts({change.target: change.after});
    change._committed = true;
    try {
      await workbench.flush(retry: true);
    } catch (caught) {
      throw ImageTagPromptSaveException(caught);
    }
  }

  Future<void> retryPromptSave() => workbench.flush(retry: true);

  String selectedCopyText() {
    final parts = <String>[];
    final positive = _selectedTagsForTarget(positive: true);
    final negative = _selectedTagsForTarget(positive: false);
    if (positive.isNotEmpty) parts.add('【正向】\n${positive.join(', ')}');
    if (negative.isNotEmpty) parts.add('【负向】\n${negative.join(', ')}');
    return parts.join('\n\n');
  }

  String? sourceTitle() {
    final id = _review.sourceGalleryId;
    if (id == null) return hasSource ? '本地导入原图' : null;
    return workbench.results
            .where((item) => item.id == id)
            .firstOrNull
            ?.title ??
        '图库原图';
  }

  void _replaceReview(
    ImageTagReviewState next, {
    bool sourceChanged = false,
    bool cancelOperations = true,
  }) {
    if (_disposed) return;
    if (cancelOperations) _cancelOperations();
    _review = next;
    _reviewRevision++;
    if (sourceChanged) _sourceVersion++;
    workbench.updateImageTagReview(next.toJson());
    notifyListeners();
  }

  void _cancelOperations() {
    _analysisCancellation?.cancel();
    _analysisCancellation = null;
    isAnalyzing = false;
    cancelTranslation();
    isTranslating = false;
    _analysisOperation++;
    _translationOperation++;
  }

  bool _isCurrentAnalysis(
    int operation,
    int sourceVersion,
    AgentCancellation cancellation,
  ) =>
      !_disposed &&
      operation == _analysisOperation &&
      sourceVersion == _sourceVersion &&
      !cancellation.isCancelled;

  bool _isCurrentTranslation(
    int operation,
    int sourceVersion,
    int reviewRevision,
    List<String> tags,
  ) =>
      !_disposed &&
      operation == _translationOperation &&
      sourceVersion == _sourceVersion &&
      reviewRevision == _reviewRevision &&
      listEquals(tags, _selectedUniqueTags());

  Future<AssistantProvider> _chooseTranslationProvider(
    AgentCancellation cancellation,
  ) async {
    final state = workbench.assistant.state;
    final candidates = <AssistantProvider>[
      if (state.mainProvider != null) state.mainProvider!,
      if (state.visionProvider != null &&
          state.visionProvider!.id != state.mainProvider?.id)
        state.visionProvider!,
    ];
    if (candidates.isEmpty) {
      throw const AgentException('请先配置主模型或识图模型连接。');
    }
    for (final provider in candidates) {
      cancellation.check();
      if (!provider.requireKey) return provider;
      try {
        final vault = workbench.vault ?? createCredentialVault();
        final secret = await cancellation
            .bind(provider.readSecret(vault))
            .timeout(translationTimeout);
        if (secret?.trim().isNotEmpty == true) return provider;
      } on AgentCancelled {
        rethrow;
      } on TimeoutException {
        if (cancellation.isCancelled) rethrow;
      } catch (_) {
        // A missing primary credential falls through to the configured vision
        // provider, matching the requested main-then-vision behavior.
      }
    }
    throw const AgentException('主模型和识图模型都没有可用的已保存凭据。');
  }

  List<String> _selectedUniqueTags() {
    final result = <String>[];
    final seen = <String>{};
    for (final item in [
      ..._review.generalTags,
      ..._review.characterTags,
      ..._review.ratingTags,
      ..._review.negativeTags,
    ]) {
      if (item.selected && seen.add(item.tag)) result.add(item.tag);
    }
    return result;
  }

  List<String> _selectedTagsForTarget({required bool positive}) {
    final candidates = positive
        ? [
            ..._review.generalTags,
            ..._review.characterTags,
            ..._review.ratingTags,
          ]
        : _review.negativeTags;
    final seen = <String>{};
    return [
      for (final item in candidates)
        if (item.selected && seen.add(item.tag)) item.tag,
    ];
  }

  ImageTagReviewState _withCategory(
    ImageTagCategory category,
    List<ImageTagCandidate> tags,
  ) => switch (category) {
    ImageTagCategory.general => _review.copyWith(generalTags: tags),
    ImageTagCategory.character => _review.copyWith(characterTags: tags),
    ImageTagCategory.rating => _review.copyWith(ratingTags: tags),
    ImageTagCategory.negative => _review.copyWith(negativeTags: tags),
  };

  ImageTagReviewState _fromWdResult(
    WdTaggerResult result, {
    required String sourceAssetRef,
    required String? sourceGalleryId,
    required ImageTagWdSettings settings,
  }) {
    final warnings = <String>[];
    var remaining = ImageTagReviewState.maxCandidates;
    List<ImageTagCandidate> take(Map<String, double> scores, bool selected) {
      final entries = scores.entries.toList()
        ..sort((left, right) => right.value.compareTo(left.value));
      final kept = entries.take(remaining).toList(growable: false);
      remaining -= kept.length;
      if (kept.length < entries.length &&
          !warnings.contains('标签数量超过显示上限，已按置信度截断。')) {
        warnings.add('标签数量超过显示上限，已按置信度截断。');
      }
      return [
        for (final entry in kept)
          ImageTagCandidate(
            tag: entry.key,
            confidence: entry.value,
            selected: selected,
          ),
      ];
    }

    final general = take(result.generalTags, true);
    final characters = take(result.characterTags, true);
    final ratings = take(result.ratingTags, false);
    return ImageTagReviewState(
      mode: ImageTagAnalysisMode.wdTagger,
      sourceAssetRef: sourceAssetRef,
      sourceGalleryId: sourceGalleryId,
      analyzed: true,
      wdSettings: settings,
      metadataWarnings: warnings,
      generalTags: general,
      characterTags: characters,
      ratingTags: ratings,
    );
  }

  ImageTagReviewState _fromMetadata(
    ImageMetadataResult metadata, {
    required String sourceAssetRef,
    required String? sourceGalleryId,
  }) {
    final warnings = [...metadata.warnings];
    if (!metadata.recognized) warnings.insert(0, '未检测到可用的 NovelAI 原图元数据。');
    final total = _CandidateCounter(warnings);
    final general = total.fromPrompt(metadata.fields['prompt']);
    final negative = total.fromPrompt(metadata.fields['negative_prompt']);
    final characters = <ImageTagCandidate>[];
    final negativeCharacters = <ImageTagCandidate>[];
    final rawCharacters = metadata.fields['characters'];
    if (rawCharacters is List) {
      for (var index = 0; index < rawCharacters.length; index++) {
        final raw = rawCharacters[index];
        if (raw is! Map) continue;
        final character = Map<String, dynamic>.from(raw);
        final role = '角色${index + 1}';
        characters.addAll(
          total.fromPrompt(character['prompt'], group: '$role 正向'),
        );
        negativeCharacters.addAll(
          total.fromPrompt(character['negative_prompt'], group: '$role 负向'),
        );
      }
    }
    final metadataSummary = <String, Object?>{};
    for (final key in const [
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
    ]) {
      final value = metadata.fields[key];
      if (value != null) metadataSummary[key] = value;
    }
    return ImageTagReviewState(
      mode: ImageTagAnalysisMode.naiMetadata,
      sourceAssetRef: sourceAssetRef,
      sourceGalleryId: sourceGalleryId,
      analyzed: true,
      metadataFields: metadataSummary,
      metadataSource: metadata.source,
      metadataWarnings: warnings.take(50).toList(),
      generalTags: general,
      characterTags: characters,
      negativeTags: [...negative, ...negativeCharacters],
    );
  }

  Map<String, String> _parseTranslations(
    String text,
    Set<String> expectedTags,
  ) {
    final Object? decoded;
    try {
      decoded = jsonDecode(text.trim());
    } on FormatException {
      throw const AgentException('标签翻译不是严格 JSON；英文标签保持不变。');
    }
    if (decoded is! Map || decoded.length != expectedTags.length) {
      throw const AgentException('标签翻译 JSON 的键与输入标签不一致。');
    }
    final translations = <String, String>{};
    for (final entry in decoded.entries) {
      if (entry.key is! String ||
          !expectedTags.contains(entry.key) ||
          entry.value is! String ||
          (entry.value as String).trim().isEmpty ||
          (entry.value as String).length > 256) {
        throw const AgentException('标签翻译 JSON 的内容无效；英文标签保持不变。');
      }
      translations[entry.key as String] = (entry.value as String).trim();
    }
    if (translations.keys.toSet().length != expectedTags.length) {
      throw const AgentException('标签翻译 JSON 缺少标签。');
    }
    return translations;
  }

  String _publicError(Object error, {required String fallback}) =>
      error is AgentException ? error.message : fallback;

  @override
  void dispose() {
    _disposed = true;
    _cancelOperations();
    workbench.removeListener(_workbenchChanged);
    super.dispose();
  }
}

class _CandidateCounter {
  _CandidateCounter(this.warnings);
  final List<String> warnings;
  int count = 0;
  bool warned = false;

  List<ImageTagCandidate> fromPrompt(Object? value, {String? group}) {
    if (value is! String || value.trim().isEmpty) return const [];
    final result = <ImageTagCandidate>[];
    final split = _splitPromptTags(value);
    if (split == null) {
      _warn('提示词括号或权重组不平衡，已将整段保留为单个候选。');
      _addCandidate(result, value, group);
      return result;
    }
    for (final raw in split) {
      final tag = raw.trim();
      _addCandidate(result, tag, group);
    }
    return result;
  }

  void _addCandidate(
    List<ImageTagCandidate> result,
    String tag,
    String? group,
  ) {
    if (tag.isEmpty) return;
    if (tag.length > 256) {
      _warn('部分元数据标签过长，已跳过。');
      return;
    }
    if (count >= ImageTagReviewState.maxCandidates) {
      if (!warned) _warn('标签数量超过显示上限，已截断。');
      warned = true;
      return;
    }
    count++;
    result.add(
      ImageTagCandidate(tag: tag, confidence: 1, selected: true, group: group),
    );
  }

  void _warn(String message) {
    if (warnings.length < 50 && !warnings.contains(message)) {
      warnings.add(message);
    }
  }
}

/// Splits only on top-level commas, retaining weighted and bracketed groups.
/// Returns null when a bracket or numeric `weight::group::` is unbalanced.
List<String>? _splitPromptTags(String prompt) {
  final parts = <String>[];
  final brackets = <int>[];
  var start = 0;
  var inWeightGroup = false;
  for (var index = 0; index < prompt.length; index++) {
    final code = prompt.codeUnitAt(index);
    if (code == 0x3a &&
        index + 1 < prompt.length &&
        prompt.codeUnitAt(index + 1) == 0x3a) {
      if (inWeightGroup) {
        inWeightGroup = false;
        index++;
        continue;
      }
      if (_hasNumericWeightPrefix(prompt, index)) inWeightGroup = true;
      index++;
      continue;
    }
    if (code == 0x7b || code == 0x5b || code == 0x28) {
      brackets.add(code);
      continue;
    }
    if (code == 0x7d || code == 0x5d || code == 0x29) {
      if (brackets.isEmpty || !_matchingBracket(brackets.last, code)) {
        return null;
      }
      brackets.removeLast();
      continue;
    }
    if (code == 0x2c && brackets.isEmpty && !inWeightGroup) {
      parts.add(prompt.substring(start, index));
      start = index + 1;
    }
  }
  if (brackets.isNotEmpty || inWeightGroup) return null;
  parts.add(prompt.substring(start));
  return parts;
}

bool _hasNumericWeightPrefix(String prompt, int markerIndex) {
  var start = markerIndex;
  while (start > 0 && _isWeightNumberCode(prompt.codeUnitAt(start - 1))) {
    start--;
  }
  if (start == markerIndex ||
      !_numericWeightPattern.hasMatch(prompt.substring(start, markerIndex))) {
    return false;
  }
  if (start == 0) return true;
  final previous = prompt.codeUnitAt(start - 1);
  return previous == 0x2c ||
      previous == 0x7b ||
      previous == 0x5b ||
      previous == 0x28 ||
      _isPromptWhitespace(previous);
}

bool _isWeightNumberCode(int code) =>
    (code >= 0x30 && code <= 0x39) ||
    code == 0x2b ||
    code == 0x2d ||
    code == 0x2e;

bool _isPromptWhitespace(int code) =>
    code == 0x20 || code == 0x09 || code == 0x0a || code == 0x0d;

bool _matchingBracket(int opening, int closing) =>
    (opening == 0x7b && closing == 0x7d) ||
    (opening == 0x5b && closing == 0x5d) ||
    (opening == 0x28 && closing == 0x29);

final RegExp _numericWeightPattern = RegExp(r'^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$');

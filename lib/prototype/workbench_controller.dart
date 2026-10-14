import 'dart:async';
import 'dart:convert';

import '../prompts/prompt_library.dart';
import '../prompts/prompt_insertion.dart';

import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:crypto/crypto.dart';

import '../assistant/agent_contract.dart';
import '../assistant/assistant_controller.dart';
import '../assistant/assistant_state.dart';
import '../assistant/wd_tagger.dart';
import '../tags/danbooru_client.dart';

import '../storage/workspace_store.dart';
import '../generation/generation_parameters.dart';
import '../generation/service_connection.dart';
import '../media/image_asset_store.dart';
import '../security/credential_vault.dart';
import '../editing/inpaint_document.dart';
import '../processing/postprocess_parameters.dart';
import '../metadata/image_metadata_parser.dart';
import '../references/vibe_library.dart';

typedef EncodeVibe = Future<VibeLibraryEntry> Function({
  required String sourceAssetRef,
  required String title,
  required String model,
  required ServiceConnection connection,
  double informationExtracted,
  double strength,
});

typedef GenerateImage = Future<SceneResult> Function(
  GenerationParameters parameters,
  ServiceConnection connection,
);

typedef ProcessGenerationResult = Future<SceneResult> Function(
  SceneResult raw,
  bool Function() isCurrent,
);

typedef ImageToolProgress = Future<void> Function(
  String stage,
  int done,
  int total,
);
typedef ProcessImageTool = Future<SceneResult> Function(
  Map<String, Object?> draft,
  GenerationParameters parameters,
  ServiceConnection connection,
  ImageToolProgress onProgress,
  bool Function() isCurrent,
);

/// One immutable gallery record. Demo artwork is reproduced from its variant.
@immutable
class SceneResult {
  const SceneResult({
    required this.id,
    required this.title,
    required this.prompt,
    required this.negative,
    required this.width,
    required this.height,
    required this.seed,
    required this.variant,
    required this.favorite,
    required this.isDemo,
    this.model = 'NAI Diffusion 4.5 Full',
    this.provider = 'NovelAI 官方',
    this.steps = 28,
    this.cfg = 5.0,
    this.assetRef,
    this.parameters,
    this.editMetadata,
    this.createdAt,
  }) : assert(variant >= 0 && variant <= 2);

  final String id;
  final String title;
  final String prompt;
  final String negative;
  final int width;
  final int height;
  final int seed;
  final int variant;
  final bool favorite;
  final bool isDemo;
  final String model;
  final String provider;
  final int steps;
  final double cfg;
  final String? assetRef;
  final GenerationParameters? parameters;

  /// Source, crop and editor snapshot for a derived image. Contains asset IDs only.
  final Map<String, Object?>? editMetadata;
  final DateTime? createdAt;
  bool get isImported =>
      editMetadata?['operation'] == 'imported' || id.startsWith('import-');
  ImageMetadataResult? get importedMetadata =>
      isImported && editMetadata?['metadataFields'] is Map
      ? ImageMetadataResult(
          fields: Map<String, dynamic>.from(
            editMetadata!['metadataFields'] as Map,
          ),
          warnings: const [],
          format: 'PNG',
          source: '图库记录',
          recognized: true,
        )
      : null;

  bool get isComposite => editMetadata?['operation'] == 'inpaintComposite';
  bool get isTiled => editMetadata?['operation'] == 'tiled';
  bool get hasEditingDraftSnapshot {
    final session = editMetadata?['session'];
    return editMetadata?['parameterScope'] == 'editingDraft' ||
        (session is Map && session['generationParameters'] is Map);
  }

  /// Whole-task parameters, including historical records whose top-level
  /// seed contains a candidate or first tile's actual seed.
  GenerationParameters? get refillParameters {
    final tiled = editMetadata?['tiledImg2Img'];
    final session = editMetadata?['session'];
    final snapshot = isTiled && tiled is Map
        ? tiled['submittedParameters']
        : isComposite && session is Map
        ? session['generationParameters']
        : null;
    if (snapshot is Map) {
      return GenerationParameters.fromJson(Map<String, dynamic>.from(snapshot));
    }
    // Old records stored the primary candidate even when it was hidden. Only
    // trust candidate parameters when that candidate is the sole visible layer.
    if (isComposite && !hasEditingDraftSnapshot) {
      final candidates = session is Map ? session['candidates'] : null;
      if (candidates is! List) return null;
      final visible = candidates
          .whereType<Map>()
          .where((v) => v['visible'] != false)
          .toList();
      if (visible.length != 1) return null;
      final raw = visible.single['raw'];
      if (raw is! Map || raw['id'] != (session as Map)['primaryId']) {
        return null;
      }
      final candidateParameters = raw['parameters'];
      return candidateParameters is Map
          ? GenerationParameters.fromJson(
              Map<String, dynamic>.from(candidateParameters),
            )
          : parameters;
    }
    return parameters;
  }

  String? get refillNotice {
    if (isComposite && refillParameters == null) {
      return '旧合成记录未保存完整草稿；缺失的高级参数、请求尺寸和 Seed 未知，回填时保留当前值。';
    }
    if (isComposite && !hasEditingDraftSnapshot) {
      return '旧合成记录的参数来自候选图，保存时的编辑草稿未知。';
    }
    if (isTiled && refillParameters == null) {
      return '旧分块记录缺少基础 Seed，回填时保留当前 Seed。';
    }
    return null;
  }

  String get seedDescription {
    if (isImported) {
      return '原图 Seed：${(editMetadata?['metadataFields'] as Map?)?['seed'] ?? '未知'}';
    }
    if (isComposite || isTiled) {
      final snapshot = refillParameters;
      final value = snapshot == null ? '未知' : snapshot.seed?.toString() ?? '随机';
      return isTiled
          ? '基础 Seed：$value · 实际 Seed 按图块记录'
          : '${snapshot != null && !hasEditingDraftSnapshot ? '候选' : '草稿'} Seed：$value · 合成图无单一实际 Seed';
    }
    if (const [
      'director',
      'upscale',
      'localSr',
    ].contains(editMetadata?['operation'])) {
      final value = parameters == null
          ? '未知'
          : parameters!.seed?.toString() ?? '随机';
      return '生成草稿 Seed：$value · 此处理无独立 Seed';
    }
    return isDemo ? 'Seed：演示图片' : '实际 Seed：$seed';
  }

  List<String> get generationSeedDetails {
    final tiled = editMetadata?['tiledImg2Img'];
    if (isTiled && tiled is Map && tiled['executions'] is List) {
      return (tiled['executions'] as List).indexed.map((entry) {
        final execution = entry.$2 as Map;
        final effective = execution['effectiveParameters'] as Map?;
        return '图块 ${entry.$1 + 1}：${effective?['seed'] ?? '未知'}';
      }).toList();
    }
    final session = editMetadata?['session'];
    if (isComposite && session is Map && session['candidates'] is List) {
      return (session['candidates'] as List).indexed.map((entry) {
        final candidate = entry.$2 as Map, raw = candidate['raw'] as Map;
        return '图层 ${entry.$1 + 1}${candidate['visible'] == false ? '（隐藏）' : ''}：${raw['seed'] ?? '未知'}';
      }).toList();
    }
    return const [];
  }

  Map<String, Object?> toJson() => {
    'id': id,
    'title': title,
    'prompt': prompt,
    'negative': negative,
    'width': width,
    'height': height,
    'seed': seed,
    'variant': variant,
    'favorite': favorite,
    'isDemo': isDemo,
    'model': model,
    'provider': provider,
    'steps': steps,
    'cfg': cfg,
    if (assetRef != null) 'assetRef': assetRef,
    if (parameters != null) 'parameters': parameters!.toJson(),
    if (editMetadata != null) 'editMetadata': editMetadata,
    if (createdAt != null) 'createdAt': createdAt!.toIso8601String(),
  };

  factory SceneResult.fromJson(Map<String, dynamic> data) {
    final result = SceneResult(
      id: data['id'] as String,
      title: data['title'] as String,
      prompt: data['prompt'] as String,
      negative: data['negative'] as String,
      width: data['width'] as int,
      height: data['height'] as int,
      seed: data['seed'] as int,
      variant: data['variant'] as int,
      favorite: data['favorite'] as bool,
      isDemo: data['isDemo'] as bool,
      model: data['model'] as String,
      provider: data['provider'] as String,
      steps: data['steps'] as int,
      cfg: (data['cfg'] as num).toDouble(),
      assetRef: data['assetRef'] as String?,
      createdAt: data['createdAt'] is String
          ? DateTime.tryParse(data['createdAt'])
          : null,
      parameters: data['parameters'] == null
          ? null
          : GenerationParameters.fromJson(
              Map<String, dynamic>.from(data['parameters'] as Map),
            ),
      editMetadata: data['editMetadata'] == null
          ? null
          : Map<String, Object?>.from(data['editMetadata'] as Map),
    );
    if (result.id.isEmpty ||
        result.width <= 0 ||
        result.height <= 0 ||
        result.variant < 0 ||
        result.variant > 2 ||
        !result.cfg.isFinite) {
      throw const FormatException('Invalid gallery record');
    }
    return result;
  }

  SceneResult copyWith({
    bool? favorite,
    String? assetRef,
    String? title,
    int? width,
    int? height,
    Map<String, Object?>? editMetadata,
    DateTime? createdAt,
  }) => SceneResult(
    id: id,
    title: title ?? this.title,
    prompt: prompt,
    negative: negative,
    width: width ?? this.width,
    height: height ?? this.height,
    seed: seed,
    variant: variant,
    favorite: favorite ?? this.favorite,
    isDemo: isDemo,
    model: model,
    provider: provider,
    steps: steps,
    cfg: cfg,
    assetRef: assetRef ?? this.assetRef,
    parameters: parameters,
    editMetadata: editMetadata ?? this.editMetadata,
    createdAt: createdAt ?? this.createdAt,
  );
}

/// UI state for the PC workbench prototype.
///
/// Generation remains simulated; an optional store persists the workspace.
class WorkbenchController extends ChangeNotifier {
  WorkbenchController({
    Duration generationDelay = const Duration(seconds: 3),
    this.store,
    StoredWorkspace? restored,
    this.generateImage,
    this.cancelRequest,
    this.assets,
    this.vault,
    this.processImageTool,
    this.localSrAvailable = false,
    this.localSrInfo = '本地超分后端尚未配置',
    VibeLibrary? vibeLibrary,
    PromptLibrary? promptLibrary,
    AgentTransport? assistantTransport,
    WdTaggerClient? wdTaggerClient,
    DanbooruSearchClient? tagSearchClient,
    this.encodeVibe,
  }) : wasRestored = restored != null,
       tagSearchClient = tagSearchClient ?? HttpDanbooruSearchClient(),
       promptLibrary =
           promptLibrary ??
           (restored != null && restored.data.containsKey('promptLibrary')
               ? PromptLibrary.fromJson(
                   Map<String, dynamic>.from(
                     restored.data['promptLibrary'] as Map,
                   ),
                 )
               : PromptLibrary()),
       vibeLibrary =
           vibeLibrary ??
           (restored?.data['vibeLibrary'] is Map
               ? VibeLibrary.fromJson(
                   Map<String, dynamic>.from(
                     restored!.data['vibeLibrary'] as Map,
                   ),
                 )
               : VibeLibrary()),
       _generationDelay = generationDelay.isNegative
           ? Duration.zero
           : generationDelay {
    assistant = AssistantController(
      workbench: this,
      transport: assistantTransport,
      state: restored != null && restored.data.containsKey('assistant')
          ? AssistantState.fromJson(
              Map<String, dynamic>.from(restored.data['assistant'] as Map),
            )
          : null,
      wdTaggerClient: wdTaggerClient,
    );
    if (generateImage != null) _status = '请配置接入凭据；生成将使用当前渠道额度。';
    _results.addAll(const [
      SceneResult(
        id: 'demo-moonlit-ridge',
        title: '月下远山',
        prompt: 'moonlit mountain ridge, quiet lake, silver clouds, painterly landscape',
        negative: 'low quality, blurry, text, watermark',
        width: 832,
        height: 1216,
        seed: 0,
        variant: 0,
        favorite: false,
        isDemo: true,
      ),
      SceneResult(
        id: 'demo-misty-valley',
        title: '晴岚山谷',
        prompt: 'sunlit misty valley, layered green hills, winding river, soft brushwork',
        negative: 'low quality, blurry, text, watermark',
        width: 832,
        height: 1216,
        seed: 0,
        variant: 1,
        favorite: false,
        isDemo: true,
      ),
      SceneResult(
        id: 'demo-sunset-coast',
        title: '落日海岸',
        prompt:
            'sunset coast, warm orange horizon, gentle waves, distant sailboat',
        negative: 'low quality, blurry, text, watermark',
        width: 832,
        height: 1216,
        seed: 0,
        variant: 2,
        favorite: false,
        isDemo: true,
      ),
    ]);
    _selectedId = _results.first.id;
    if (restored != null) {
      _restore(restored);
      _lastSaved = jsonEncode(exportWorkspace());
    }
    this.vibeLibrary.onChanged = (_) => notifyListeners();
    this.promptLibrary.onChanged = (_) => notifyListeners();
  }

  final WorkspaceStore? store;
  final VibeLibrary vibeLibrary;
  final PromptLibrary promptLibrary;
  final DanbooruSearchClient tagSearchClient;

  String get tagSearchBaseUrl =>
      (_extra['tagSearch'] as Map?)?['baseUrl'] as String? ??
      defaultDanbooruBaseUrl;
  bool get tagSearchShowNsfw =>
      (_extra['tagSearch'] as Map?)?['showNsfw'] as bool? ?? true;

  void configureTagSearch({required String baseUrl, required bool showNsfw}) {
    if (_disposed || _closing || _maintenance || assistant.busy) {
      throw const AgentException('请等待助手完成，并在工作区可编辑时修改标签搜索设置。');
    }
    final normalized = normalizeDanbooruBaseUrl(baseUrl);
    _update(() {
      _extra['tagSearch'] = {
        'schema': 1,
        'baseUrl': normalized,
        'showNsfw': showNsfw,
      };
    });
  }

  late final AssistantController assistant;
  final EncodeVibe? encodeVibe;
  bool _encodingVibe = false;
  bool get encodingVibe => _encodingVibe;
  void cancelVibeEncoding() {
    if (!_disposed && _encodingVibe) cancelRequest?.call();
  }

  Future<VibeLibraryEntry> saveVibeReference(
    VibeReference reference,
    String title,
  ) async {
    if (encodeVibe == null ||
        generating ||
        _encodingVibe ||
        _closing ||
        _maintenance) {
      throw const FormatException('请等待任务完成后再编码');
    }
    final model = parameters.model;
    final target = connection;
    _encodingVibe = true;
    notifyListeners();
    try {
      return await prepareEditing(() async {
        final entry = await encodeVibe!(
          sourceAssetRef: reference.assetId,
          title: title,
          model: model,
          connection: target,
          informationExtracted: reference.informationExtracted,
          strength: reference.strength,
        );
        await flush();
        return entry;
      });
    } finally {
      _encodingVibe = false;
      if (!_disposed) notifyListeners();
    }
  }

  final GenerateImage? generateImage;
  final VoidCallback? cancelRequest;
  final ImageAssetStore? assets;
  final CredentialVault? vault;
  final ProcessImageTool? processImageTool;
  final bool localSrAvailable;
  final String localSrInfo;
  bool get liveGeneration => generateImage != null;
  int _batchCount = 1;
  int get batchCount => _batchCount;
  int _refillRevision = 0;
  int get refillRevision => _refillRevision;
  GenerationParameters _advanced = GenerationParameters(
    model: 'nai-diffusion-4-5-full',
    prompt: '',
    width: 832,
    height: 1216,
  );
  final Map<String, String> _connections = Map.of(ServiceConnection.defaults);
  static const modelIds = {
    'NAI Diffusion 4.5 Full': 'nai-diffusion-4-5-full',
    'NAI Diffusion 4.5 Curated': 'nai-diffusion-4-5-curated',
    'NAI Diffusion 5 Full': 'nai-diffusion-5-full',
    'NAI Diffusion 5 Curated': 'nai-diffusion-5-curated',
    'NAI Diffusion 4': 'nai-diffusion-4-full',
    'NAI Diffusion 3': 'nai-diffusion-3',
  };
  GenerationParameters get parameters => _advanced.copyWith(
    model: modelIds[_model] ?? _model,
    prompt: _prompt,
    negativePrompt: _negative,
    width: _width,
    height: _height,
    steps: _steps,
    scale: _cfg,
    seed: int.tryParse(_seedText),
    clearSeed: _seedText.isEmpty,
  );
  ServiceConnection get connection {
    final id =
        ServiceConnection.labels.entries
            .where((e) => e.value == _provider)
            .firstOrNull
            ?.key ??
        'unsupported';
    return ServiceConnection(protocol: id, baseUrl: _connections[id] ?? '');
  }

  ServiceConnection connectionFor(String protocol) => ServiceConnection(
    protocol: protocol,
    baseUrl: _connections[protocol] ?? '',
  );

  void updateConnection(ServiceConnection value) => _update(() {
    _connections[value.protocol] = value.uri.toString();
  });
  void updateAdvanced(GenerationParameters value) => _update(() {
    final previous = _advanced.operation == GenerationOperation.inpaint
        ? 'inpaint'
        : 'generation';
    final next = value.operation == GenerationOperation.inpaint
        ? 'inpaint'
        : 'generation';
    if (previous != next) {
      final prompts = Map<String, Object?>.from(
        _extra['operationPrompts'] as Map? ?? {},
      );
      prompts[previous] = {'prompt': _prompt, 'negative': _negative};
      final saved = prompts[next] as Map?;
      _prompt = saved?['prompt'] as String? ?? '';
      _negative = saved?['negative'] as String? ?? '';
      _extra['operationPrompts'] = prompts;
    }
    _advanced = value;
  });
  void moveCharacter(int index, int delta) => _update(() {
    final list = [..._advanced.characters];
    final target = index + delta;
    if (index < 0 ||
        index >= list.length ||
        target < 0 ||
        target >= list.length) {
      return;
    }
    final item = list.removeAt(index);
    list.insert(target, item);
    _advanced = _advanced.copyWith(characters: list);
    _refillRevision++;
  });
  void updateBatch(int value) =>
      _update(() => _batchCount = value.clamp(1, 30));
  void addImported(
    ImageAsset asset, {
    ImageMetadataResult? metadata,
    String title = '导入图片',
  }) => _update(() {
    final id = 'import-${asset.id}';
    final previousIndex = _results.indexWhere((r) => r.id == id);
    if (previousIndex < 0) {
      _results.insert(
        0,
        SceneResult(
          id: id,
          title: title,
          prompt: metadata?.fields['prompt'] as String? ?? '',
          negative: metadata?.fields['negative_prompt'] as String? ?? '',
          width: asset.width,
          height: asset.height,
          seed: 0,
          variant: 0,
          favorite: false,
          isDemo: false,
          assetRef: asset.assetRef,
          createdAt: DateTime.now(),
          model: metadata?.fields['model'] as String? ?? '未知模型',
          provider: '本地导入',
          editMetadata: {
            'operation': 'imported',
            'metadataFields': metadata?.fields ?? <String, Object?>{},
          },
        ),
      );
    } else if (metadata != null && metadata.fields.isNotEmpty) {
      final previous = _results[previousIndex];
      final data = previous.toJson();
      data['prompt'] = metadata.fields['prompt'] ?? previous.prompt;
      data['negative'] =
          metadata.fields['negative_prompt'] ?? previous.negative;
      data['model'] = metadata.fields['model'] ?? previous.model;
      data['editMetadata'] = {
        ...?previous.editMetadata,
        'operation': 'imported',
        'metadataFields': {
          ...?previous.importedMetadata?.fields,
          ...metadata.fields,
        },
      };
      _results[previousIndex] = SceneResult.fromJson(data);
    }
    _selectedId = id;
  });
  WorkspaceStore? get _store => store;
  Map<String, Object?> _extra = {};
  Map<String, Object?> get imageTools => Map<String, Object?>.from(
    jsonDecode(jsonEncode(_extra['imageTools'] ?? {})) as Map,
  );
  Map<String, Object?> get imageToolJob => Map<String, Object?>.from(
    jsonDecode(jsonEncode(_extra['imageToolJob'] ?? {})) as Map,
  );
  void updateImageTools(Map<String, Object?> value) => _update(() {
    final next = Map<String, Object?>.from(value);
    if (imageTools['mode'] != next['mode']) {
      for (final key in const [
        'resultAssetRef',
        'resultId',
        'resultWidth',
        'resultHeight',
      ]) {
        next.remove(key);
      }
    }
    _validateImageTools(next);
    _extra['imageTools'] = jsonDecode(jsonEncode(next));
  });

  void setImageToolSource(ImageAsset asset, {String? parentId}) {
    final draft = imageTools;
    draft.addAll({
      'version': 1,
      'mode': draft['mode'] ?? 'tiled',
      'active': true,
      'sourceAssetRef': asset.assetRef,
      'sourceWidth': asset.width,
      'sourceHeight': asset.height,
      'parentId': parentId,
      'sourceRevision': DateTime.now().microsecondsSinceEpoch.toString(),
      'strength': draft['strength'] ?? 0.3,
    });
    draft.remove('resultAssetRef');
    draft.remove('resultId');
    draft.remove('resultWidth');
    draft.remove('resultHeight');
    if (draft['postprocess'] is Map) {
      draft['postprocess'] = {
        ...Map<String, Object?>.from(draft['postprocess'] as Map),
        'source_asset_ref': asset.assetRef,
        'parent_id': parentId,
        'width': asset.width,
        'height': asset.height,
      };
    }
    updateImageTools(draft);
  }

  Map<String, Object?> get imageEditing => Map<String, Object?>.from(
    jsonDecode(jsonEncode(_extra['imageEditing'] ?? {})) as Map,
  );
  void updateImageEditing(Map<String, Object?> value) => _update(() {
    _validateImageEditing(value);
    _extra['imageEditing'] = jsonDecode(jsonEncode(value));
  });
  void addDerived(SceneResult result) => _update(() {
    if (!_results.any((r) => r.id == result.id)) {
      _results.insert(
        0,
        result.copyWith(createdAt: result.createdAt ?? DateTime.now()),
      );
    }
    _selectedId = result.id;
  });
  Future<T> prepareEditing<T>(Future<T> Function() action) async {
    if (_disposed || _closing) throw const FormatException('工作区正在关闭');
    if (_maintenance) throw const FormatException('正在整理图库，请稍后再试');
    final done = Completer<void>();
    _settlingGenerations.add(done.future);
    try {
      return await action();
    } finally {
      done.complete();
      _settlingGenerations.remove(done.future);
    }
  }

  Map<String, Object?> _preferenceExtra = {};
  final bool wasRestored;
  int _revision = 0;
  String? _lastSaved;
  String? _pending;
  Future<void>? _saving;
  Object? _saveError;
  bool _darkTheme = true, _reduceMotion = false;
  bool _closing = false;
  bool get closing => _closing;
  Map<String, Object?> _editor = {};
  bool get darkTheme => _darkTheme;
  bool get reduceMotion => _reduceMotion;
  Map<String, Object?> get editor =>
      Map<String, Object?>.from(jsonDecode(jsonEncode(_editor)) as Map);
  bool get hasStore => _store != null;
  String get storageLabel => _store?.label ?? '会话预览';
  bool get saving => _saving != null;
  bool get saveFailed => _saveError != null;
  String get saveStatus => !hasStore
      ? '会话预览'
      : saveFailed
      ? '未保存 · 点击重试'
      : saving || _pending != null
      ? '保存中…'
      : '已保存';
  String get saveErrorMessage => _saveError is WorkspaceConflictException
      ? '另一个窗口已修改数据。请保留当前内容并重新打开工作台，避免覆盖。'
      : '本地保存失败，修改仍保留在当前窗口。请检查磁盘空间和目录权限后重试。';

  void updatePreferences({bool? darkTheme, bool? reduceMotion}) => _update(() {
    _darkTheme = darkTheme ?? _darkTheme;
    _reduceMotion = reduceMotion ?? _reduceMotion;
  });
  void updateEditor(Map<String, Object?> value) => _update(() {
    final next = Map<String, Object?>.from(
      jsonDecode(jsonEncode(value)) as Map,
    );
    _validateEditor(next);
    _editor = next;
  });

  Map<String, Object?> exportWorkspace() => {
    ..._extra,
    'draft': {
      'prompt': _prompt,
      'negative': _negative,
      'model': _model,
      'provider': _provider,
      'width': _width,
      'height': _height,
      'steps': _steps,
      'cfg': _cfg,
      'seedText': _seedText,
      'generation': parameters.toJson(),
      'batchCount': _batchCount,
      'connections': _connections,
    },
    'gallery': _results.map((item) => item.toJson()).toList(),
    'preferences': {
      ..._preferenceExtra,
      'darkTheme': _darkTheme,
      'reduceMotion': _reduceMotion,
    },
    'editor': _editor,
    'selectedId': _selectedId ?? '',
    'demoSequence': _demoSequence,
    'vibeLibrary': vibeLibrary.toJson(),
    'promptLibrary': promptLibrary.toJson(),
    'assistant': assistant.state.toJson(),
  };

  void _restore(StoredWorkspace stored) {
    final data = stored.data;
    if (data.containsKey('tagSearch')) {
      final settings = data['tagSearch'];
      if (settings is! Map ||
          settings['schema'] != 1 ||
          settings['baseUrl'] is! String ||
          settings['showNsfw'] is! bool) {
        throw const FormatException('无效的标签搜索设置');
      }
      normalizeDanbooruBaseUrl(settings['baseUrl'] as String);
    }
    _extra = Map<String, Object?>.from(data)
      ..removeWhere(
        (key, _) => const [
          'draft',
          'gallery',
          'preferences',
          'editor',
          'selectedId',
          'demoSequence',
        ].contains(key),
      );
    final draft = data['draft'] as Map;
    final preferences = data['preferences'] as Map;
    _preferenceExtra = Map<String, Object?>.from(preferences)
      ..remove('darkTheme')
      ..remove('reduceMotion');
    final results = (data['gallery'] as List)
        .map(
          (item) =>
              SceneResult.fromJson(Map<String, dynamic>.from(item as Map)),
        )
        .toList();
    if (results.map((r) => r.id).toSet().length != results.length) {
      throw const FormatException('Invalid gallery');
    }
    _prompt = draft['prompt'] as String;
    _negative = draft['negative'] as String;
    _model = draft['model'] as String;
    _provider = draft['provider'] as String;
    _width = draft['width'] as int;
    _height = draft['height'] as int;
    _steps = draft['steps'] as int;
    _cfg = (draft['cfg'] as num).toDouble();
    _seedText = draft['seedText'] as String;
    if (draft['generation'] is Map) {
      _advanced = GenerationParameters.fromJson(
        Map<String, dynamic>.from(draft['generation'] as Map),
      );
    } else if ((data['editor'] as Map)['character'] is String &&
        ((data['editor'] as Map)['character'] as String).isNotEmpty) {
      final old = data['editor'] as Map;
      final pos = old['position'] as String;
      _advanced = _advanced.copyWith(
        characters: [
          GenerationCharacter(
            prompt: old['character'] as String,
            enabled: old['characterEnabled'] as bool,
            centerX: (pos.codeUnitAt(0) - 65 + .5) / 5,
            centerY: (int.parse(pos[1]) - .5) / 5,
          ),
        ],
      );
    }
    _batchCount = (draft['batchCount'] as int? ?? 1).clamp(1, 30);
    if (draft['connections'] is Map) {
      for (final id in ServiceConnection.labels.keys) {
        final value = (draft['connections'] as Map)[id];
        if (value is String) _connections[id] = value;
      }
    }
    _darkTheme = preferences['darkTheme'] as bool;
    _reduceMotion = preferences['reduceMotion'] as bool;
    _editor = Map<String, Object?>.from(data['editor'] as Map);
    _selectedId = data['selectedId'] as String;
    _demoSequence = data['demoSequence'] as int;
    if (_width <= 0 ||
        _height <= 0 ||
        _steps < 1 ||
        _steps > 50 ||
        !_cfg.isFinite ||
        _cfg < 1 ||
        _cfg > 10 ||
        _demoSequence < 0 ||
        (results.isNotEmpty && !results.any((r) => r.id == _selectedId)) ||
        (results.isEmpty && _selectedId != '')) {
      throw const FormatException('Invalid draft');
    }
    _results
      ..clear()
      ..addAll(results);
    _revision = stored.revision;
    _validateEditor(_editor);
    _validateImageEditing(imageEditing);
    _validateImageTools(imageTools);
    if (imageToolJob['status'] == 'running') {
      _extra['imageToolJob'] = {
        ...imageToolJob,
        'status': 'interrupted',
        'stage': '上次任务已中断；未自动重新请求。源图与参数仍保留。',
      };
    }
  }

  static void _validateImageTools(Map<String, Object?> value) {
    if (value.isEmpty) return;
    if (value['version'] != 1 ||
        !const [
          'tiled',
          'director',
          'enhance',
          'upscale',
          'localSr',
        ].contains(value['mode'])) {
      throw const FormatException('无效图片工具草稿');
    }
    if (value['sourceAssetRef'] != null &&
        (value['sourceAssetRef'] is! String ||
            value['sourceWidth'] is! int ||
            (value['sourceWidth'] as int) <= 0 ||
            value['sourceHeight'] is! int ||
            (value['sourceHeight'] as int) <= 0)) {
      throw const FormatException('无效图片工具原图');
    }
    final strength = value['strength'];
    if (strength != null &&
        (strength is! num ||
            !strength.isFinite ||
            strength < 0 ||
            strength > 1)) {
      throw const FormatException('无效分块强度');
    }
    if (value['postprocess'] is Map) {
      final parameters = PostprocessParameters.fromJson(
        Map<String, dynamic>.from(value['postprocess'] as Map),
      );
      final modeOperation = value['mode'] == 'localSr'
          ? 'local_sr'
          : value['mode'];
      if (parameters.toJson()['operation'] != modeOperation ||
          parameters.sourceAssetRef != value['sourceAssetRef'] ||
          parameters.width != value['sourceWidth'] ||
          parameters.height != value['sourceHeight']) {
        throw const FormatException('处理方式、参数与原图不一致。');
      }
    }
  }

  static void _validateImageEditing(Map<String, Object?> value) {
    if (value.isEmpty) return;
    if (value['version'] != 1) throw const FormatException('未知图片编辑工作区版本');
    if (value['document'] is Map) {
      InpaintDocument.fromJson(
        Map<String, Object?>.from(value['document'] as Map),
      );
    }
    for (final name in ['undo', 'redo']) {
      for (final doc in value[name] as List? ?? const []) {
        InpaintDocument.fromJson(Map<String, Object?>.from(doc as Map));
      }
    }
    final crop = value['img2img'];
    if (crop is Map) {
      final rect = crop['crop'];
      if (crop['originalAssetRef'] is! String ||
          crop['preparedAssetRef'] is! String ||
          rect is! List ||
          rect.length != 4 ||
          rect.any((v) => v is! num || !v.isFinite) ||
          (rect[2] as num) <= 0 ||
          (rect[3] as num) <= 0) {
        throw const FormatException('无效裁切草稿');
      }
      for (final key in [
        'originalWidth',
        'originalHeight',
        'targetWidth',
        'targetHeight',
      ]) {
        if (crop[key] is! int || (crop[key] as int) <= 0) {
          throw const FormatException('无效裁切尺寸');
        }
      }
    }
    for (final candidate in value['candidates'] as List? ?? const []) {
      final data = candidate as Map;
      SceneResult.fromJson(Map<String, dynamic>.from(data['raw'] as Map));
      final rect = data['rect'] as List;
      if (rect.length != 4 ||
          rect.any((v) => v is! num || !v.isFinite) ||
          (rect[2] as num) <= 0 ||
          (rect[3] as num) <= 0 ||
          data['compositeRef'] is! String ||
          data['layerRef'] is! String) {
        throw const FormatException('无效重绘结果图层');
      }
    }
  }

  static void _validateEditor(Map<String, Object?> editor) {
    if (editor.isEmpty) return;
    if (editor['character'] is! String ||
        editor['characterEnabled'] is! bool ||
        editor['position'] is! String ||
        !RegExp(r'^[A-E][1-5]$').hasMatch(editor['position'] as String) ||
        editor['brush'] is! num ||
        (editor['brush'] as num) < 8 ||
        (editor['brush'] as num) > 60 ||
        !(editor['brush'] as num).isFinite) {
      throw const FormatException('Invalid editor');
    }
    for (final name in ['masks', 'redo']) {
      for (final strokes in (editor[name] as Map).values) {
        for (final stroke in strokes as List) {
          for (final point in stroke as List) {
            if (point is! List ||
                point.length != 2 ||
                point.any((v) => v is! num || !v.isFinite || v < 0 || v > 1)) {
              throw const FormatException('Invalid mask point');
            }
          }
        }
      }
    }
  }

  @override
  void notifyListeners() {
    if (_disposed) return;
    if (_store != null) {
      final snapshot = jsonEncode(exportWorkspace());
      _pending = snapshot != _lastSaved || _saving != null ? snapshot : null;
      if (_pending != null && _saving == null && _saveError == null) {
        _saving = _drain();
      }
    }
    super.notifyListeners();
  }

  Future<void> _drain() async {
    // Yield once so _saving is assigned before a synchronous adapter can finish.
    await Future<void>.value();
    while (_pending != null && _saveError == null) {
      final snapshot = _pending!;
      _pending = null;
      try {
        _revision = await _store!.save(
          Map<String, Object?>.from(jsonDecode(snapshot) as Map),
          expectedRevision: _revision,
        );
        _lastSaved = snapshot;
      } catch (error) {
        _pending ??= snapshot;
        _saveError = error;
      }
    }
    _saving = null;
    if (!_disposed) super.notifyListeners();
  }

  Future<void> flush({bool retry = false}) async {
    if (_store == null) return;
    if (retry) _saveError = null;
    notifyListeners();
    while (_saving != null) {
      await _saving;
    }
    if (_saveError != null) throw _saveError!;
  }

  Future<void> closeStorage() async {
    final pendingGeneration = _activeGeneration;
    _closing = true;
    cancelGeneration();
    cancelVibeEncoding();
    try {
      await assistant.settle().timeout(const Duration(seconds: 10));
      await Future.wait<void>([..._settlingGenerations, ?pendingGeneration])
          .timeout(const Duration(seconds: 10));
      await flush();
      await _store?.close();
      await assets?.close();
    } catch (_) {
      _closing = false;
      if (!_disposed) super.notifyListeners();
      rethrow;
    }
  }

  final Duration _generationDelay;
  final List<SceneResult> _results = [];

  String _prompt = '';
  String _negative = '';
  String _model = 'NAI Diffusion 4.5 Full';
  String _provider = 'NovelAI 官方';
  int _width = 832;
  int _height = 1216;
  int _steps = 28;
  double _cfg = 5.0;
  String _seedText = '';

  String? _selectedId;
  bool _generating = false;
  String _status = '演示模式：未连接生图服务';
  bool _disposed = false;
  int _generationToken = 0;
  int _demoSequence = 0;
  Completer<void>? _cancellation;
  Future<void>? _activeGeneration;
  final Set<Future<void>> _settlingGenerations = {};

  String get prompt => _prompt;
  String get negative => _negative;
  String get model => _model;
  String get provider => _provider;
  int get width => _width;
  int get height => _height;
  int get steps => _steps;
  double get cfg => _cfg;
  String get seedText => _seedText;

  List<SceneResult> get results => List<SceneResult>.unmodifiable(_results);

  SceneResult get selected => _results.firstWhere(
    (result) => result.id == _selectedId,
    orElse: () => _results.isEmpty ? emptySelection : _results.first,
  );
  static const emptySelection = SceneResult(
    id: 'empty-workspace',
    title: '尚无作品',
    prompt: '',
    negative: '',
    width: 832,
    height: 1216,
    seed: 0,
    variant: 0,
    favorite: false,
    isDemo: true,
  );

  bool get generating => _generating;
  String get status => _status;

  void applyMetadata(
    ImageMetadataResult metadata, {
    required Set<String> selectedFields,
  }) {
    _update(() {
      final next = metadata.applyTo(parameters, selectedFields: selectedFields);
      _advanced = next;
      _prompt = next.prompt;
      _negative = next.negativePrompt ?? '';
      _width = next.width;
      _height = next.height;
      _steps = next.steps;
      _cfg = next.scale;
      _seedText = next.seed?.toString() ?? '';
      _model =
          modelIds.entries
              .where((e) => e.value == next.model)
              .firstOrNull
              ?.key ??
          next.model;
      _refillRevision++;
    });
  }

  Map<String, int> get dailySuccessCounts => {
    for (final entry in (_extra['dailySuccessCounts'] as Map? ?? {}).entries)
      if (entry.key is String && entry.value is int && entry.value >= 0)
        entry.key as String: entry.value as int,
  };
  static String dayKey(DateTime date) =>
      '${date.year.toString().padLeft(4, '0')}-${date.month.toString().padLeft(2, '0')}-${date.day.toString().padLeft(2, '0')}';
  void _recordSuccess() {
    final counts = dailySuccessCounts;
    final day = dayKey(DateTime.now());
    counts[day] = (counts[day] ?? 0) + 1;
    _extra['dailySuccessCounts'] = counts;
  }

  /// Removing records never deletes source bytes. Cleanup is a separate,
  /// explicit operation and only considers committed, unreferenced assets.
  Future<void> removeGalleryRecords(Set<String> ids) async {
    if (_closing || _disposed || _maintenance) {
      throw const FormatException('工作区暂时忙碌');
    }
    _update(() {
      _results.removeWhere((r) => ids.contains(r.id));
      if (!_results.any((r) => r.id == _selectedId)) {
        _selectedId = _results.firstOrNull?.id ?? '';
      }
    });
    await flush();
  }

  bool _maintenance = false;
  bool get maintainingAssets => _maintenance;
  bool get canMaintainAssets =>
      !_closing &&
      !_disposed &&
      !assistant.busy &&
      !_generating &&
      !_maintenance &&
      _settlingGenerations.isEmpty;

  Future<T> maintainAssets<T>(Future<T> Function() action) async {
    if (!canMaintainAssets) {
      throw const FormatException('请等待当前生成、导入或图片处理完成后再整理图库');
    }
    _maintenance = true;
    final done = Completer<void>();
    _settlingGenerations.add(done.future);
    notifyListeners();
    try {
      await flush();
      return await action();
    } finally {
      _maintenance = false;
      done.complete();
      _settlingGenerations.remove(done.future);
      if (!_disposed) notifyListeners();
    }
  }

  Future<int> cleanUnusedAssets(Set<String> approvedRefs) =>
      maintainAssets(() async {
        if (assets is! ImageAssetMaintenance || !hasStore) {
          throw const FormatException('当前存储不支持文件清理');
        }
        // Even an unchanged window must prove it still owns the current
        // revision before it performs an irreversible file operation.
        final checkpoint = jsonEncode(exportWorkspace());
        try {
          _revision = await _store!.save(
            Map<String, Object?>.from(jsonDecode(checkpoint) as Map),
            expectedRevision: _revision,
          );
          _lastSaved = checkpoint;
        } catch (error) {
          _pending = checkpoint;
          _saveError = error;
          rethrow;
        }
        var removed = 0;
        final listed = (await (assets as ImageAssetMaintenance).listAssets())
            .toSet();
        for (final ref in approvedRefs) {
          if (!listed.contains(ref)) continue;
          if (collectImageAssetReferences(exportWorkspace()).contains(ref)) {
            continue;
          }
          await (assets as ImageAssetMaintenance).removeAsset(ref);
          removed++;
        }
        return removed;
      });

  void updatePrompt(String value) => _update(() => _prompt = value);

  void appendPrompts(String positive, String negative) => _update(() {
    _prompt = appendPromptText(_prompt, positive);
    _negative = appendPromptText(_negative, negative);
  });

  String get assistantDraftFingerprint => sha256
      .convert(
        utf8.encode(
          jsonEncode({
            'parameters': parameters.toJson(),
            'provider': _provider,
            'seed': _seedText,
            'connections': _connections,
            'operationPrompts': _extra['operationPrompts'],
          }),
        ),
      )
      .toString();

  Map<String, dynamic> get assistantPromptSnapshot {
    final inpaint = parameters.operation == GenerationOperation.inpaint;
    final saved = _extra['operationPrompts'] as Map? ?? {};
    final generation = saved['generation'] as Map? ?? {};
    final painting = saved['inpaint'] as Map? ?? {};
    return {
      'positive': inpaint ? generation['prompt'] ?? '' : _prompt,
      'negative': inpaint ? generation['negative'] ?? '' : _negative,
      'inpaint_positive': inpaint ? _prompt : painting['prompt'] ?? '',
      'inpaint_negative': inpaint ? _negative : painting['negative'] ?? '',
      'is_inpainting_mode': inpaint,
      'version': assistantDraftFingerprint,
      'characters': [
        for (var i = 0; i < parameters.characters.length; i++)
          {'index': i + 1, ...parameters.characters[i].toJson()},
      ],
    };
  }

  String assistantPromptValue(String target) {
    final inpaint = parameters.operation == GenerationOperation.inpaint;
    if (const [
      'positive',
      'negative',
      'inpaint_positive',
      'inpaint_negative',
    ].contains(target)) {
      if (target.startsWith('inpaint_') != inpaint) {
        throw const AgentException('目标词框与当前创作模式不一致；请切换模式后重新发送请求。');
      }
      return target.endsWith('negative') ? _negative : _prompt;
    }
    final match = RegExp(r'^character_([1-6])(_uc)?$').firstMatch(target);
    if (match == null) throw const AgentException('提示词目标无效。');
    final index = int.parse(match.group(1)!) - 1;
    if (index >= parameters.characters.length) return '';
    final character = parameters.characters[index];
    return match.group(2) == null
        ? character.prompt
        : character.negativePrompt ?? '';
  }

  void applyAssistantPrompt(String target, String content) =>
      applyAssistantPrompts({target: content});

  /// Validate every target before one synchronous draft mutation/notification.
  void applyAssistantPrompts(Map<String, String> fields) {
    if (_closing || _disposed || _maintenance || _generating || _encodingVibe) {
      throw const AgentException('当前工作区不允许写入草稿。');
    }
    for (final entry in fields.entries) {
      assistantPromptValue(entry.key);
      if (entry.value.length > 32000) {
        throw const AgentException('提示词超过 32000 字符。');
      }
    }
    _update(() {
      for (final entry in fields.entries) {
        final target = entry.key;
        final content = entry.value;
        final match = RegExp(r'^character_([1-6])(_uc)?$').firstMatch(target);
        if (match == null) {
          if (target.endsWith('negative')) {
            _negative = content;
          } else {
            _prompt = content;
          }
        } else {
          final index = int.parse(match.group(1)!) - 1;
          final characters = [...parameters.characters];
          while (characters.length <= index) {
            characters.add(GenerationCharacter(prompt: ''));
          }
          characters[index] = match.group(2) == null
              ? characters[index].copyWith(prompt: content)
              : characters[index].copyWith(negativePrompt: content);
          _advanced = _advanced.copyWith(characters: characters);
        }
      }
    });
  }

  void applyAssistantCharacters(List<GenerationCharacter> characters) {
    if (_closing || _disposed || _maintenance || _generating) {
      throw const AgentException('当前工作区不允许修改角色。');
    }
    _update(() => _advanced = _advanced.copyWith(characters: characters));
  }

  void updateNegative(String value) => _update(() => _negative = value);

  void setSize(int width, int height) {
    if (width <= 0 || height <= 0) {
      throw ArgumentError('Width and height must be positive.');
    }
    _update(() {
      _width = width;
      _height = height;
    });
  }

  void updateModel(String value) => _update(() => _model = value);

  void updateProvider(String value) => _update(() => _provider = value);

  /// Steps are discrete; slider values are rounded to the nearest integer.
  void updateSteps(double value) {
    if (!value.isFinite || value < 1 || value > 50) {
      throw ArgumentError.value(value, 'value', 'Must be between 1 and 50.');
    }
    _update(() => _steps = value.round());
  }

  void updateCfg(double value) {
    if (!value.isFinite || value < 1 || value > 10) {
      throw ArgumentError.value(value, 'value', 'Must be between 1 and 10.');
    }
    _update(() => _cfg = value);
  }

  void updateSeed(String value) => _update(() => _seedText = value);

  void selectResult(String id) {
    if (_disposed || _closing || !_results.any((result) => result.id == id)) {
      return;
    }
    if (_selectedId == id) return;
    _selectedId = id;
    notifyListeners();
  }

  /// Applies the selected result's parameters to the editable workbench.
  /// With [promptOnly], only its positive prompt is copied.
  void applyResult(SceneResult result, {bool promptOnly = false}) {
    if (_disposed || _closing) return;
    if (result.isImported) {
      final metadata = result.importedMetadata;
      if (metadata != null) {
        applyMetadata(
          metadata,
          selectedFields: promptOnly
              ? {'prompt'}
              : metadata.fields.keys.toSet(),
        );
      }
      return;
    }
    final previousProvider = _provider;
    final previousParameters = parameters, previousSeed = _seedText;
    final saved = result.refillParameters;
    final editing = result.editMetadata?['session'];
    final savedDocument = editing is Map ? editing['document'] : null;
    if (!promptOnly) {
      final prompts = Map<String, Object?>.from(
        _extra['operationPrompts'] as Map? ?? {},
      );
      prompts[_advanced.operation == GenerationOperation.inpaint
          ? 'inpaint'
          : 'generation'] = {
        'prompt': _prompt,
        'negative': _negative,
      };
      _extra['operationPrompts'] = prompts;
    }
    _refillRevision++;
    _prompt = result.prompt;
    if (!promptOnly) {
      _negative = result.negative;
      _width = result.width;
      _height = result.height;
      _seedText = result.seed == 0 ? '' : result.seed.toString();
      _model = result.model;
      _provider = result.provider;
      _steps = result.steps;
      _cfg = result.cfg;
      _advanced =
          saved ??
          (result.isComposite
              ? previousParameters.copyWith(
                  operation: GenerationOperation.inpaint,
                  model: modelIds[result.model] ?? result.model,
                  prompt: result.prompt,
                  negativePrompt: result.negative,
                  steps: result.steps,
                  scale: result.cfg,
                  sourceImageId:
                      (result.editMetadata?['parentAssetRef'] ??
                              (savedDocument is Map
                                  ? savedDocument['sourceAssetRef']
                                  : null))
                          as String?,
                  clearMaskImageId: true,
                )
              : GenerationParameters(
                  model: modelIds[result.model] ?? result.model,
                  prompt: result.prompt,
                  width: result.width,
                  height: result.height,
                ));
      if (saved != null || result.isComposite) {
        _width = _advanced.width;
        _height = _advanced.height;
        _prompt = _advanced.prompt;
        _negative = _advanced.negativePrompt ?? '';
        _model =
            modelIds.entries
                .where((entry) => entry.value == _advanced.model)
                .firstOrNull
                ?.key ??
            _advanced.model;
        _steps = _advanced.steps;
        _cfg = _advanced.scale;
      }
      if (result.isComposite || result.isTiled) {
        _seedText = saved == null ? previousSeed : saved.seed?.toString() ?? '';
      } else if (!result.isDemo) {
        _seedText = result.seed.toString();
      }
      if (editing is Map) {
        _extra['imageEditing'] = jsonDecode(jsonEncode(editing));
      }
      final tools = result.editMetadata?['imageTools'];
      if (tools is Map) {
        final draft = Map<String, Object?>.from(tools);
        _validateImageTools(draft);
        // Processing models and local backends belong to the tool settings.
        // Restore the parent generation snapshot when returning to the canvas.
        if (draft['mode'] != 'tiled' && saved != null) {
          final parent = saved;
          _prompt = parent.prompt;
          _negative = parent.negativePrompt ?? '';
          _model =
              modelIds.entries
                  .where((entry) => entry.value == parent.model)
                  .firstOrNull
                  ?.key ??
              parent.model;
          _steps = parent.steps;
          _cfg = parent.scale;
          _seedText = draft['mode'] == 'enhance'
              ? result.seed.toString()
              : (parent.seed?.toString() ?? '');
          final protocol = draft['generationProtocol'] as String?;
          _provider = ServiceConnection.labels[protocol] ?? previousProvider;
        }
        _extra['imageTools'] = jsonDecode(
          jsonEncode({...draft, 'active': true}),
        );
      } else if (imageTools.isNotEmpty) {
        _extra['imageTools'] = {...imageTools, 'active': false};
      }
    }
    if (_results.any((item) => item.id == result.id)) {
      _selectedId = result.id;
    }
    notifyListeners();
  }

  void toggleFavorite(String id) {
    if (_disposed || _closing) return;
    final index = _results.indexWhere((result) => result.id == id);
    if (index < 0) return;
    _results[index] = _results[index].copyWith(
      favorite: !_results[index].favorite,
    );
    notifyListeners();
  }

  /// Adds one delayed demo record. The submitted values are captured before
  /// the first asynchronous wait, so edits made during the wait affect only
  /// the next submission.
  Future<void> generate({
    ProcessGenerationResult? processResult,
    GenerationParameters? submitted,
    ServiceConnection? submittedConnection,
    int? count,
  }) {
    if (_disposed || _closing || _generating || _maintenance || _encodingVibe) {
      return _activeGeneration ?? Future<void>.value();
    }
    if (generateImage != null) {
      return _generateReal(
        processResult: processResult,
        submitted: submitted,
        submittedConnection: submittedConnection,
        count: count,
      );
    }

    final snapshot = _GenerationSnapshot(
      prompt: _prompt,
      negative: _negative,
      model: _model,
      provider: _provider,
      width: _width,
      height: _height,
      steps: _steps,
      cfg: _cfg,
      seedText: _seedText,
    );
    final token = ++_generationToken;
    final cancellation = Completer<void>();
    final activeGeneration = Completer<void>();
    _cancellation = cancellation;
    _activeGeneration = activeGeneration.future;
    _generating = true;
    _status = '参数已冻结，正在模拟排队';
    notifyListeners();

    unawaited(
      _runGeneration(token, snapshot, cancellation).then<void>(
        (_) {
          if (!activeGeneration.isCompleted) activeGeneration.complete();
        },
        onError: (Object error, StackTrace stackTrace) {
          if (!activeGeneration.isCompleted) {
            activeGeneration.completeError(error, stackTrace);
          }
        },
      ),
    );
    return activeGeneration.future;
  }

  void cancelGeneration() {
    if (_disposed || !_generating) return;
    ++_generationToken;
    cancelRequest?.call();
    final cancellation = _cancellation;
    _cancellation = null;
    _activeGeneration = null;
    _generating = false;
    _status = liveGeneration ? '已停止等待；服务端已接收的请求可能继续执行。' : '演示任务已取消';
    if (imageToolJob['status'] == 'running') {
      _extra['imageToolJob'] = {
        ...imageToolJob,
        'status': 'cancelled',
        'stage': '任务已取消，原图与参数仍保留；不会自动重试。',
      };
    }
    if (cancellation != null && !cancellation.isCompleted) {
      cancellation.complete();
    }
    notifyListeners();
  }

  Future<void> _runGeneration(
    int token,
    _GenerationSnapshot snapshot,
    Completer<void> cancellation,
  ) async {
    final phaseDurations = _splitDelay(_generationDelay, 3);
    final phaseStatuses = ['正在模拟排队', '正在模拟生成', '正在整理演示结果'];

    for (var index = 0; index < phaseStatuses.length; index++) {
      if (!_isCurrent(token)) return;
      _status = phaseStatuses[index];
      notifyListeners();

      await Future.any<void>([
        Future<void>.delayed(phaseDurations[index]),
        cancellation.future,
      ]);
    }

    if (!_isCurrent(token)) return;

    final sequence = ++_demoSequence;
    final result = SceneResult(
      id: 'demo-generated-$sequence',
      title: '演示草图 $sequence',
      prompt: snapshot.prompt,
      negative: snapshot.negative,
      width: snapshot.width,
      height: snapshot.height,
      // Zero means no service-produced seed is available in this prototype.
      seed: int.tryParse(snapshot.seedText.trim()) ?? 0,
      variant: (sequence - 1) % 3,
      favorite: false,
      isDemo: true,
      model: snapshot.model,
      provider: snapshot.provider,
      steps: snapshot.steps,
      cfg: snapshot.cfg,
    );
    _results.insert(0, result);
    _selectedId = result.id;
    _status = '演示结果已加入当前会话（未调用生图服务）';
    _generating = false;
    _cancellation = null;
    _activeGeneration = null;
    notifyListeners();
  }

  bool _isCurrent(int token) =>
      !_disposed && !_closing && token == _generationToken;

  Future<void> runImageTool() async {
    await _runImageTool();
  }

  /// Runs a user-confirmed Agent SR request against the exact managed Gallery
  /// image shown in its confirmation preview. The active image-tool draft is
  /// left untouched, while progress, cancellation and persistence still use
  /// the ordinary image-processing job path.
  Future<SceneResult?> runAssistantLocalSr({
    required String sourceId,
    required String sourceAssetRef,
    required int sourceWidth,
    required int sourceHeight,
    required String model,
    required AgentCancellation cancellation,
  }) async {
    cancellation.check();
    if (_disposed || _closing) throw const AgentException('工作区正在关闭。');
    if (_maintenance) throw const AgentException('图库正在维护，请稍后重试。');
    if (_generating || _encodingVibe) {
      throw const AgentException('当前有图像处理或编码任务正在运行，请等待完成。');
    }
    if (!localSrAvailable) {
      throw AgentException(localSrInfo);
    }
    if (assets == null || processImageTool == null) {
      throw const AgentException('当前工作区没有可用的受管图库或本地超分后端。');
    }

    final source = _results
        .where(
          (result) =>
              result.id == sourceId &&
              !result.isDemo &&
              result.assetRef == sourceAssetRef &&
              result.width == sourceWidth &&
              result.height == sourceHeight,
        )
        .firstOrNull;
    if (source == null) {
      throw const AgentException('确认时的图库图片已变化或已移除；请重新读取图库并确认。');
    }

    final scale = switch (model) {
      'realcuganConservative2x' => 2,
      'realesrganAnime4x' || 'realcuganConservative4x' => 4,
      _ => throw const AgentException('本地超分预设无效。'),
    };
    final postprocess = PostprocessParameters(
      operation: PostprocessOperation.localSr,
      sourceAssetRef: sourceAssetRef,
      parentId: sourceId,
      width: sourceWidth,
      height: sourceHeight,
      model: model,
      scale: scale.toDouble(),
    );
    try {
      postprocess.validate();
    } on PostprocessValidationException {
      throw const AgentException('本地超分预设与倍率不匹配。');
    }

    final taskDraft = <String, Object?>{
      'version': 1,
      'mode': 'localSr',
      'active': true,
      'sourceAssetRef': sourceAssetRef,
      'sourceWidth': sourceWidth,
      'sourceHeight': sourceHeight,
      'parentId': sourceId,
      'sourceRevision': 'assistant-${DateTime.now().microsecondsSinceEpoch}',
      'postprocess': postprocess.toJson(),
    };

    var settled = false;
    unawaited(
      cancellation.whenCancelled.then((_) {
        if (!settled) cancelGeneration();
      }),
    );
    try {
      cancellation.check();
      return await _runImageTool(
        submittedDraft: taskDraft,
        updateActiveDraft: false,
        validateLocalSrResult: true,
      );
    } finally {
      settled = true;
    }
  }

  Future<SceneResult?> _runImageTool({
    Map<String, Object?>? submittedDraft,
    bool updateActiveDraft = true,
    bool validateLocalSrResult = false,
  }) async {
    if (_disposed || _closing || _generating || _maintenance || _encodingVibe) {
      return null;
    }
    if (processImageTool == null) {
      _status = '当前预览未连接图片处理后端。';
      notifyListeners();
      return null;
    }
    final draft = Map<String, Object?>.from(submittedDraft ?? imageTools);
    // Preserve the existing canvas snapshot: this records the selected
    // generation connection, independently of the processing connection below.
    draft['generationProtocol'] = connection.protocol;
    try {
      _validateImageTools(draft);
    } on FormatException catch (error) {
      _status = error.message;
      notifyListeners();
      return null;
    }
    if (draft['sourceAssetRef'] == null) {
      _status = '请先导入图片或使用当前图库原图。';
      notifyListeners();
      return null;
    }
    if (const ['tiled', 'enhance'].contains(draft['mode']) &&
        _seedText.isNotEmpty &&
        (int.tryParse(_seedText) == null ||
            int.parse(_seedText) < 0 ||
            int.parse(_seedText) > 4294967295)) {
      _status = 'Seed 必须为 0–4294967295 的整数，或留空随机。';
      notifyListeners();
      return null;
    }
    final submitted = parameters;
    final mode = draft['mode'] as String;
    final protocol = const ['enhance', 'upscale', 'localSr'].contains(mode)
        ? 'official'
        : draft['protocol'] as String? ?? connection.protocol;
    final submittedConnection = connectionFor(protocol);
    final token = ++_generationToken;
    final jobId = 'processing-${DateTime.now().microsecondsSinceEpoch}';
    final done = Completer<void>();
    _settlingGenerations.add(done.future);
    _activeGeneration = done.future;
    _generating = true;
    _extra['imageToolJob'] = {
      'id': jobId,
      'status': 'running',
      'stage': '正在准备原图与参数',
      'done': 0,
      'total': 1,
      'draft': draft,
      'parameters': submitted.toJson(),
      'protocol': protocol,
    };
    _status = '正在准备图片处理任务';
    notifyListeners();
    SceneResult? completedResult;
    try {
      await flush();
      final result = await processImageTool!(
        draft,
        submitted,
        submittedConnection,
        (stage, completed, total) async {
          if (!_isCurrent(token)) return;
          _status = stage;
          _extra['imageToolJob'] = {
            ...imageToolJob,
            'stage': stage,
            'done': completed,
            'total': total,
          };
          notifyListeners();
          await flush();
        },
        () => _isCurrent(token),
      );
      if (!_isCurrent(token)) return null;
      if (validateLocalSrResult && mode == 'localSr') {
        final postprocess = PostprocessParameters.fromJson(
          Map<String, dynamic>.from(draft['postprocess']! as Map),
        );
        final scale = postprocess.scale!.toInt();
        final expectedWidth = postprocess.width * scale;
        final expectedHeight = postprocess.height * scale;
        final metadata = result.editMetadata;
        if (result.isDemo ||
            result.assetRef == null ||
            result.assetRef!.trim().isEmpty ||
            result.width != expectedWidth ||
            result.height != expectedHeight ||
            result.model != postprocess.model ||
            metadata?['operation'] != 'localSr' ||
            metadata?['parentAssetRef'] != postprocess.sourceAssetRef ||
            metadata?['parentResultId'] != draft['parentId']) {
          throw const FormatException('本地超分未保存与已确认源图及预期尺寸匹配的真实派生图片。');
        }
      }
      final storedResult = result.copyWith(
        createdAt: result.createdAt ?? DateTime.now(),
      );
      completedResult = storedResult;
      _results.insert(0, storedResult);
      if (draft['mode'] == 'tiled') _recordSuccess();
      _selectedId = result.id;
      if (updateActiveDraft &&
          imageTools['sourceRevision'] == draft['sourceRevision'] &&
          imageTools['sourceAssetRef'] == draft['sourceAssetRef'] &&
          imageTools['mode'] == draft['mode']) {
        _extra['imageTools'] = {
          ...imageTools,
          'resultAssetRef': result.assetRef,
          'resultId': result.id,
          'resultWidth': result.width,
          'resultHeight': result.height,
        };
      }
      _extra['imageToolJob'] = {
        ...imageToolJob,
        'status': 'completed',
        'stage': '结果与完整参数已保存到图库。',
        'resultId': result.id,
      };
      _status = '图片处理完成，原图保留，派生结果已保存到图库。';
      notifyListeners();
      await flush();
      return completedResult;
    } catch (error) {
      if (_isCurrent(token)) {
        _status = saveFailed
            ? saveErrorMessage
            : error is FormatException
            ? error.message
            : '图片处理失败，原图与草稿仍保留。';
        _extra['imageToolJob'] = {
          ...imageToolJob,
          'status': 'failed',
          'stage': _status,
        };
        notifyListeners();
      }
      return null;
    } finally {
      if (_isCurrent(token)) {
        _generating = false;
        _activeGeneration = null;
      }
      done.complete();
      _settlingGenerations.remove(done.future);
      if (!_disposed) notifyListeners();
    }
  }

  Future<void> _generateReal({
    ProcessGenerationResult? processResult,
    GenerationParameters? submitted,
    ServiceConnection? submittedConnection,
    int? count,
  }) async {
    final validateCurrentDraft = submitted == null;
    submitted ??= parameters;
    if (validateCurrentDraft &&
        _seedText.isNotEmpty &&
        (int.tryParse(_seedText) == null ||
            int.parse(_seedText) < 0 ||
            int.parse(_seedText) > 4294967295)) {
      _status = 'Seed 必须为 0–4294967295 的整数，或留空随机。';
      notifyListeners();
      return;
    }
    submittedConnection ??= connection;
    count = (count ?? _batchCount).clamp(1, 30);
    final token = ++_generationToken;
    _generating = true;
    final done = Completer<void>();
    _settlingGenerations.add(done.future);
    _activeGeneration = done.future;
    try {
      await flush();
      for (var i = 0; i < count && _isCurrent(token); i++) {
        _status = '正在生成 ${i + 1}/$count';
        notifyListeners();
        final randomSeed =
            Random.secure().nextInt(65536) * 65536 +
            Random.secure().nextInt(65536);
        final frozen = submitted.copyWith(
          seed: i == 0 ? submitted.seed ?? randomSeed : randomSeed,
        );
        var result = await generateImage!(frozen, submittedConnection);
        if (!_isCurrent(token)) break;
        if (processResult != null) {
          result = await processResult(result, () => _isCurrent(token));
        }
        if (!_isCurrent(token)) break;
        _results.insert(
          0,
          result.copyWith(createdAt: result.createdAt ?? DateTime.now()),
        );
        _recordSuccess();
        _selectedId = result.id;
        notifyListeners();
        await flush();
      }
      if (_isCurrent(token)) _status = '生成完成，图片与完整参数已保存到图库。';
    } catch (error) {
      if (_isCurrent(token)) {
        _status = saveFailed
            ? saveErrorMessage
            : error is FormatException
            ? error.message
            : '生成失败，请检查接入配置、网络与当前模型支持的参数后重试。';
      }
    } finally {
      if (_isCurrent(token)) {
        _generating = false;
        _activeGeneration = null;
      }
      if (!done.isCompleted) done.complete();
      _settlingGenerations.remove(done.future);
      if (!_disposed) notifyListeners();
    }
  }

  void _update(void Function() change) {
    if (_disposed || _closing || _maintenance) return;
    change();
    notifyListeners();
  }

  static List<Duration> _splitDelay(Duration delay, int parts) {
    final totalMicros = delay.inMicroseconds;
    final baseMicros = totalMicros ~/ parts;
    final remainder = totalMicros % parts;
    return List<Duration>.generate(
      parts,
      (index) =>
          Duration(microseconds: baseMicros + (index < remainder ? 1 : 0)),
      growable: false,
    );
  }

  @override
  void dispose() {
    if (_disposed) return;
    assistant.dispose();
    cancelRequest?.call();
    _disposed = true;
    ++_generationToken;
    _generating = false;
    final cancellation = _cancellation;
    _cancellation = null;
    _activeGeneration = null;
    if (cancellation != null && !cancellation.isCompleted) {
      cancellation.complete();
    }
    super.dispose();
  }
}

/// Captures basic generation inputs at submission time for future service wiring.
@immutable
class _GenerationSnapshot {
  const _GenerationSnapshot({
    required this.prompt,
    required this.negative,
    required this.model,
    required this.provider,
    required this.width,
    required this.height,
    required this.steps,
    required this.cfg,
    required this.seedText,
  });

  final String prompt;
  final String negative;
  final String model;
  final String provider;
  final int width;
  final int height;
  final int steps;
  final double cfg;
  final String seedText;
}

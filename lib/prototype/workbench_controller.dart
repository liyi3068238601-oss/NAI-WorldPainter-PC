import 'dart:async';

import 'package:flutter/foundation.dart';

/// One immutable item in the in-memory prototype gallery.
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

  SceneResult copyWith({bool? favorite}) => SceneResult(
    id: id,
    title: title,
    prompt: prompt,
    negative: negative,
    width: width,
    height: height,
    seed: seed,
    variant: variant,
    favorite: favorite ?? this.favorite,
    isDemo: isDemo,
    model: model,
    provider: provider,
    steps: steps,
    cfg: cfg,
  );
}

/// UI state for the PC workbench prototype.
///
/// Generation is deliberately simulated: results are demo records held only
/// in memory, and no image service or database is contacted.
class WorkbenchController extends ChangeNotifier {
  WorkbenchController({Duration generationDelay = const Duration(seconds: 3)})
    : _generationDelay = generationDelay.isNegative
          ? Duration.zero
          : generationDelay {
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
    orElse: () => _results.first,
  );

  bool get generating => _generating;
  String get status => _status;

  void updatePrompt(String value) => _update(() => _prompt = value);

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
    if (!value.isFinite) {
      throw ArgumentError.value(value, 'value', 'Must be finite.');
    }
    _update(() => _steps = value.round());
  }

  void updateCfg(double value) {
    if (!value.isFinite) {
      throw ArgumentError.value(value, 'value', 'Must be finite.');
    }
    _update(() => _cfg = value);
  }

  void updateSeed(String value) => _update(() => _seedText = value);

  void selectResult(String id) {
    if (_disposed || !_results.any((result) => result.id == id)) return;
    if (_selectedId == id) return;
    _selectedId = id;
    notifyListeners();
  }

  /// Applies the selected result's parameters to the editable workbench.
  /// With [promptOnly], only its positive prompt is copied.
  void applyResult(SceneResult result, {bool promptOnly = false}) {
    if (_disposed) return;
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
    }
    if (_results.any((item) => item.id == result.id)) {
      _selectedId = result.id;
    }
    notifyListeners();
  }

  void toggleFavorite(String id) {
    if (_disposed) return;
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
  Future<void> generate() {
    if (_disposed || _generating) {
      return _activeGeneration ?? Future<void>.value();
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
    final cancellation = _cancellation;
    _cancellation = null;
    _activeGeneration = null;
    _generating = false;
    _status = '演示任务已取消';
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

  bool _isCurrent(int token) => !_disposed && token == _generationToken;

  void _update(void Function() change) {
    if (_disposed) return;
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

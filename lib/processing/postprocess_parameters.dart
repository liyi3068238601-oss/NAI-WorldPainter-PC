/// The kind of post-processing operation represented by a task snapshot.
enum PostprocessOperation { enhance, upscale, director, localSr }

/// Director tool names accepted by the NovelAI adapters.
enum PostprocessDirectorTool {
  declutter,
  bgRemoval,
  lineart,
  sketch,
  colorize,
  emotion,
}

/// Immutable, serializable parameters for a derived-image operation.
///
/// [sourceAssetRef] is a stable asset ID understood by the caller's image
/// resolver. [parentId] links the result to its source asset or task; neither
/// field is a filesystem path. Image bytes and credentials are never stored
/// in this object.
class PostprocessParameters {
  static const Set<String> localSrModels = {
    'realesrganAnime4x',
    'realcuganConservative2x',
    'realcuganConservative4x',
  };
  static const Set<String> officialEnhanceModels = {
    'nai-diffusion-4-5-full',
    'nai-diffusion-4-5-curated',
    'nai-diffusion-5-full',
    'nai-diffusion-5-curated',
  };

  final PostprocessOperation operation;
  final String sourceAssetRef;
  final String? parentId;

  /// Dimensions of the original source asset before operation-specific
  /// preparation or upscaling.
  final int width;
  final int height;

  /// Enhance model ID or the fixed local-SR model key listed above.
  /// Director model IDs are only used by gateway protocols.
  final String? model;
  final String? prompt;
  final String? negativePrompt;
  final PostprocessDirectorTool? directorTool;
  final int? defry;
  final double? strength;
  final double? noise;

  /// Enhance resolution multiplier (1, 1.5, or 2), official Upscale (2 or 4),
  /// or the fixed local-SR multiplier selected by [model].
  final double? scale;

  /// NovelAI prompt guidance, named `scale` in its image request payload.
  final double? guidance;
  final int? steps;
  final int? seed;
  final bool upscaledEnhance;

  const PostprocessParameters({
    required this.operation,
    required this.sourceAssetRef,
    this.parentId,
    required this.width,
    required this.height,
    this.model,
    this.prompt,
    this.negativePrompt,
    this.directorTool,
    this.defry,
    this.strength,
    this.noise,
    this.scale,
    this.guidance,
    this.steps,
    this.seed,
    this.upscaledEnhance = false,
  });

  /// Returns these parameters with the concrete Enhance seed selected by the
  /// service. Keeping this on the serializable model makes retries and task
  /// history reflect the request that was actually sent.
  PostprocessParameters withSeed(int value) => PostprocessParameters(
    operation: operation,
    sourceAssetRef: sourceAssetRef,
    parentId: parentId,
    width: width,
    height: height,
    model: model,
    prompt: prompt,
    negativePrompt: negativePrompt,
    directorTool: directorTool,
    defry: defry,
    strength: strength,
    noise: noise,
    scale: scale,
    guidance: guidance,
    steps: steps,
    seed: value,
    upscaledEnhance: upscaledEnhance,
  );

  Map<String, dynamic> toJson() => {
    'operation': _operationName(operation),
    'source_asset_ref': sourceAssetRef,
    'parent_id': parentId,
    'width': width,
    'height': height,
    'model': model,
    'prompt': prompt,
    'negative_prompt': negativePrompt,
    'director_tool': directorTool == null
        ? null
        : _directorToolName(directorTool!),
    'defry': defry,
    'strength': strength,
    'noise': noise,
    'scale': scale,
    'guidance': guidance,
    'steps': steps,
    'seed': seed,
    'upscaled_enhance': upscaledEnhance,
  };

  factory PostprocessParameters.fromJson(Map<String, dynamic> json) =>
      PostprocessParameters(
        operation: _operationFromName(json['operation']),
        sourceAssetRef: _string(json['source_asset_ref']) ?? '',
        parentId: _string(json['parent_id']),
        width: _int(json['width']) ?? 0,
        height: _int(json['height']) ?? 0,
        model: _string(json['model']),
        prompt: _string(json['prompt']),
        negativePrompt: _string(json['negative_prompt']),
        directorTool: _directorToolFromName(json['director_tool']),
        defry: _int(json['defry']),
        strength: _double(json['strength']),
        noise: _double(json['noise']),
        scale: _double(json['scale']),
        guidance: _double(json['guidance']),
        steps: _int(json['steps']),
        seed: _int(json['seed']),
        upscaledEnhance: _bool(json['upscaled_enhance']) ?? false,
      );

  /// Reject incomplete or cross-operation parameter combinations before any
  /// request is sent. Provider-specific model requirements are checked by the
  /// service because official Director Tools do not take a model.
  void validate() {
    if (sourceAssetRef.trim().isEmpty ||
        (parentId != null && parentId!.trim().isEmpty) ||
        width < 1 ||
        height < 1 ||
        width > 32768 ||
        height > 32768) {
      throw const PostprocessValidationException(
        'Post-process source identity or dimensions are invalid.',
      );
    }

    switch (operation) {
      case PostprocessOperation.enhance:
        _validateEnhance();
      case PostprocessOperation.upscale:
        _validateUpscale();
      case PostprocessOperation.director:
        _validateDirector();
      case PostprocessOperation.localSr:
        _validateLocalSr();
    }
  }

  void _validateEnhance() {
    if (model == null ||
        !officialEnhanceModels.contains(model!.trim()) ||
        strength == null ||
        !_isFiniteInRange(strength!, 0.01, 0.99) ||
        noise == null ||
        !_isFiniteInRange(noise!, 0, 0.99) ||
        scale == null ||
        !const [1.0, 1.5, 2.0].contains(scale) ||
        guidance == null ||
        !_isFiniteInRange(guidance!, 1, 10) ||
        steps == null ||
        steps! < 1 ||
        steps! > (_isV5Model(model!) ? 28 : 50) ||
        (seed != null && (seed! < 0 || seed! > 0xffffffff)) ||
        (upscaledEnhance && (!_isV5Model(model!) || scale != 1.0)) ||
        directorTool != null ||
        defry != null) {
      throw const PostprocessValidationException(
        'Enhance parameters are invalid.',
      );
    }
  }

  void _validateUpscale() {
    if ((scale != 2 && scale != 4) ||
        model != null ||
        prompt != null ||
        negativePrompt != null ||
        directorTool != null ||
        defry != null ||
        strength != null ||
        noise != null ||
        guidance != null ||
        steps != null ||
        seed != null ||
        upscaledEnhance) {
      throw const PostprocessValidationException(
        'Upscale parameters are invalid.',
      );
    }
  }

  void _validateDirector() {
    final tool = directorTool;
    if (tool == null ||
        strength != null ||
        noise != null ||
        scale != null ||
        guidance != null ||
        steps != null ||
        seed != null ||
        upscaledEnhance) {
      throw const PostprocessValidationException(
        'Director parameters are invalid.',
      );
    }
    if (defry != null &&
        (defry! < 0 || defry! > 5 || !_directorUsesDefry(tool))) {
      throw const PostprocessValidationException(
        'Director denoise value is invalid.',
      );
    }
    if (prompt != null && !_directorUsesPrompt(tool)) {
      throw const PostprocessValidationException(
        'This Director tool does not accept a prompt.',
      );
    }
    if (negativePrompt != null) {
      throw const PostprocessValidationException(
        'Director tools do not accept a negative prompt.',
      );
    }
  }

  void _validateLocalSr() {
    final expectedScale = switch (model) {
      'realesrganAnime4x' || 'realcuganConservative4x' => 4,
      'realcuganConservative2x' => 2,
      _ => null,
    };
    if (expectedScale == null ||
        !localSrModels.contains(model) ||
        scale != expectedScale ||
        prompt != null ||
        negativePrompt != null ||
        directorTool != null ||
        defry != null ||
        strength != null ||
        noise != null ||
        guidance != null ||
        steps != null ||
        seed != null ||
        upscaledEnhance) {
      throw const PostprocessValidationException(
        'Local super-resolution parameters are invalid.',
      );
    }
  }

  static bool _directorUsesPrompt(PostprocessDirectorTool tool) =>
      tool == PostprocessDirectorTool.colorize ||
      tool == PostprocessDirectorTool.emotion;

  static bool _directorUsesDefry(PostprocessDirectorTool tool) =>
      _directorUsesPrompt(tool);

  static bool _isV5Model(String model) =>
      model.toLowerCase().contains('diffusion-5');

  static bool _isFiniteInRange(double value, double minimum, double maximum) =>
      value.isFinite && value >= minimum && value <= maximum;
}

class PostprocessValidationException implements Exception {
  final String message;

  const PostprocessValidationException(this.message);

  @override
  String toString() => message;
}

String _operationName(PostprocessOperation value) => switch (value) {
  PostprocessOperation.enhance => 'enhance',
  PostprocessOperation.upscale => 'upscale',
  PostprocessOperation.director => 'director',
  PostprocessOperation.localSr => 'local_sr',
};

PostprocessOperation _operationFromName(Object? value) => switch (value) {
  'enhance' => PostprocessOperation.enhance,
  'upscale' => PostprocessOperation.upscale,
  'director' => PostprocessOperation.director,
  'local_sr' => PostprocessOperation.localSr,
  _ => throw const FormatException('Unknown post-process operation.'),
};

String _directorToolName(PostprocessDirectorTool value) => switch (value) {
  PostprocessDirectorTool.declutter => 'declutter',
  PostprocessDirectorTool.bgRemoval => 'bg_removal',
  PostprocessDirectorTool.lineart => 'lineart',
  PostprocessDirectorTool.sketch => 'sketch',
  PostprocessDirectorTool.colorize => 'colorize',
  PostprocessDirectorTool.emotion => 'emotion',
};

PostprocessDirectorTool? _directorToolFromName(Object? value) =>
    switch (value) {
      null => null,
      'declutter' => PostprocessDirectorTool.declutter,
      'bg_removal' => PostprocessDirectorTool.bgRemoval,
      'lineart' => PostprocessDirectorTool.lineart,
      'sketch' => PostprocessDirectorTool.sketch,
      'colorize' => PostprocessDirectorTool.colorize,
      'emotion' => PostprocessDirectorTool.emotion,
      _ => throw const FormatException('Unknown Director tool.'),
    };

String? _string(Object? value) => value is String ? value : null;

int? _int(Object? value) => value is int ? value : null;

double? _double(Object? value) => value is num ? value.toDouble() : null;

bool? _bool(Object? value) => value is bool ? value : null;

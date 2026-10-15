import '../references/vibe_encoding_scope.dart';

/// The operation represented by a single image-generation request.
enum GenerationOperation { textToImage, imageToImage, inpaint }

/// Immutable, provider-neutral snapshot of one NovelAI image request.
///
/// Asset fields contain IDs understood by the caller's asset store. They are
/// deliberately not filesystem paths; protocol adapters obtain the bytes via
/// an injected resolver.
class GenerationParameters {
  /// Shared by the workbench, approval preview and every request adapter.
  static const defaultInpaintStrength = 0.7;
  final GenerationOperation operation;
  final String model;
  final String prompt;
  final String? negativePrompt;
  final int width;
  final int height;
  final int steps;
  final double scale;
  final double cfgRescale;
  final String sampler;
  final String noiseSchedule;
  final int? seed;
  final bool useCoords;
  final List<GenerationCharacter> characters;
  final List<VibeReference> vibeReferences;
  final List<PreciseReference> preciseReferences;
  final String? sourceImageId;
  final String? maskImageId;
  final String? img2imgSourceImageId;
  final double? img2imgStrength;
  final double? inpaintStrength;
  double get effectiveInpaintStrength =>
      inpaintStrength ?? defaultInpaintStrength;
  final bool disabledOriginalImage;
  final bool colorCorrect;

  GenerationParameters({
    this.operation = GenerationOperation.textToImage,
    required this.model,
    required this.prompt,
    this.negativePrompt,
    required this.width,
    required this.height,
    this.steps = 28,
    this.scale = 5.0,
    this.cfgRescale = 0.0,
    this.sampler = 'k_euler_ancestral',
    this.noiseSchedule = 'karras',
    this.seed,
    this.useCoords = true,
    List<GenerationCharacter> characters = const [],
    List<VibeReference> vibeReferences = const [],
    List<PreciseReference> preciseReferences = const [],
    this.sourceImageId,
    this.maskImageId,
    this.img2imgSourceImageId,
    this.img2imgStrength,
    this.inpaintStrength,
    this.disabledOriginalImage = false,
    this.colorCorrect = true,
  }) : characters = List.unmodifiable(characters),
       vibeReferences = List.unmodifiable(vibeReferences),
       preciseReferences = List.unmodifiable(preciseReferences);

  GenerationParameters copyWith({
    GenerationOperation? operation,
    String? model,
    String? prompt,
    String? negativePrompt,
    bool clearNegativePrompt = false,
    int? width,
    int? height,
    int? steps,
    double? scale,
    double? cfgRescale,
    String? sampler,
    String? noiseSchedule,
    int? seed,
    bool clearSeed = false,
    bool? useCoords,
    List<GenerationCharacter>? characters,
    List<VibeReference>? vibeReferences,
    List<PreciseReference>? preciseReferences,
    String? sourceImageId,
    bool clearSourceImageId = false,
    String? maskImageId,
    bool clearMaskImageId = false,
    String? img2imgSourceImageId,
    bool clearImg2imgSourceImageId = false,
    double? img2imgStrength,
    bool clearImg2imgStrength = false,
    double? inpaintStrength,
    bool clearInpaintStrength = false,
    bool? disabledOriginalImage,
    bool? colorCorrect,
  }) => GenerationParameters(
    operation: operation ?? this.operation,
    model: model ?? this.model,
    prompt: prompt ?? this.prompt,
    negativePrompt: clearNegativePrompt
        ? null
        : (negativePrompt ?? this.negativePrompt),
    width: width ?? this.width,
    height: height ?? this.height,
    steps: steps ?? this.steps,
    scale: scale ?? this.scale,
    cfgRescale: cfgRescale ?? this.cfgRescale,
    sampler: sampler ?? this.sampler,
    noiseSchedule: noiseSchedule ?? this.noiseSchedule,
    seed: clearSeed ? null : (seed ?? this.seed),
    useCoords: useCoords ?? this.useCoords,
    characters: characters ?? this.characters,
    vibeReferences: vibeReferences ?? this.vibeReferences,
    preciseReferences: preciseReferences ?? this.preciseReferences,
    sourceImageId: clearSourceImageId
        ? null
        : (sourceImageId ?? this.sourceImageId),
    maskImageId: clearMaskImageId ? null : (maskImageId ?? this.maskImageId),
    img2imgSourceImageId: clearImg2imgSourceImageId
        ? null
        : (img2imgSourceImageId ?? this.img2imgSourceImageId),
    img2imgStrength: clearImg2imgStrength
        ? null
        : (img2imgStrength ?? this.img2imgStrength),
    inpaintStrength: clearInpaintStrength
        ? null
        : (inpaintStrength ?? this.inpaintStrength),
    disabledOriginalImage: disabledOriginalImage ?? this.disabledOriginalImage,
    colorCorrect: colorCorrect ?? this.colorCorrect,
  );

  /// JSON-safe user parameters. Image bytes and credentials are never stored
  /// here; references use stable asset IDs.
  Map<String, dynamic> toJson() => {
    'operation': _operationToJson(operation),
    'model': model,
    'prompt': prompt,
    'negative_prompt': negativePrompt,
    'width': width,
    'height': height,
    'steps': steps,
    'scale': scale,
    'cfg_rescale': cfgRescale,
    'sampler': sampler,
    'noise_schedule': noiseSchedule,
    'seed': seed,
    'use_coords': useCoords,
    'characters': characters.map((item) => item.toJson()).toList(),
    'vibe_references': vibeReferences.map((item) => item.toJson()).toList(),
    'precise_references': preciseReferences
        .map((item) => item.toJson())
        .toList(),
    'source_image_id': sourceImageId,
    'mask_image_id': maskImageId,
    'img2img_source_image_id': img2imgSourceImageId,
    'img2img_strength': img2imgStrength,
    'inpaint_strength': inpaintStrength,
    'disabled_original_image': disabledOriginalImage,
    'color_correct': colorCorrect,
  };

  factory GenerationParameters.fromJson(Map<String, dynamic> json) {
    return GenerationParameters(
      operation: _operationFromJson(json['operation']),
      model: _string(json['model']) ?? '',
      prompt: _string(json['prompt']) ?? '',
      negativePrompt: _string(json['negative_prompt']),
      width: _int(json['width']) ?? 832,
      height: _int(json['height']) ?? 1216,
      steps: _int(json['steps']) ?? 28,
      scale: _double(json['scale']) ?? 5.0,
      cfgRescale: _double(json['cfg_rescale']) ?? 0.0,
      sampler: _string(json['sampler']) ?? 'k_euler_ancestral',
      noiseSchedule: _string(json['noise_schedule']) ?? 'karras',
      seed: _int(json['seed']),
      useCoords: _bool(json['use_coords']) ?? true,
      characters: _objects(json['characters'])
          .map(GenerationCharacter.fromJson)
          .toList(),
      vibeReferences: _objects(json['vibe_references'])
          .map(VibeReference.fromJson)
          .toList(),
      preciseReferences: _objects(json['precise_references'])
          .map(PreciseReference.fromJson)
          .toList(),
      sourceImageId: _string(json['source_image_id']),
      maskImageId: _string(json['mask_image_id']),
      img2imgSourceImageId: _string(json['img2img_source_image_id']),
      img2imgStrength: _double(json['img2img_strength']),
      inpaintStrength: _double(json['inpaint_strength']),
      disabledOriginalImage: _bool(json['disabled_original_image']) ?? false,
      colorCorrect: _bool(json['color_correct']) ?? true,
    );
  }
}

/// A role prompt used by NovelAI's multi-character controls.
class GenerationCharacter {
  final String prompt;
  final String? negativePrompt;
  final double? centerX;
  final double? centerY;
  final bool enabled;
  final List<GenerationCharacterReference> referenceImages;

  GenerationCharacter({
    required this.prompt,
    this.negativePrompt,
    this.centerX,
    this.centerY,
    this.enabled = true,
    List<GenerationCharacterReference> referenceImages = const [],
  }) : referenceImages = List.unmodifiable(referenceImages);

  GenerationCharacter copyWith({
    String? prompt,
    String? negativePrompt,
    bool clearNegativePrompt = false,
    double? centerX,
    double? centerY,
    bool clearCenter = false,
    bool? enabled,
    List<GenerationCharacterReference>? referenceImages,
  }) => GenerationCharacter(
    prompt: prompt ?? this.prompt,
    negativePrompt: clearNegativePrompt
        ? null
        : (negativePrompt ?? this.negativePrompt),
    centerX: clearCenter ? null : (centerX ?? this.centerX),
    centerY: clearCenter ? null : (centerY ?? this.centerY),
    enabled: enabled ?? this.enabled,
    referenceImages: referenceImages ?? this.referenceImages,
  );

  Map<String, dynamic> toJson() => {
    'prompt': prompt,
    'negative_prompt': negativePrompt,
    'center_x': centerX,
    'center_y': centerY,
    'enabled': enabled,
    'reference_images': referenceImages
        .map((reference) => reference.toJson())
        .toList(),
  };

  factory GenerationCharacter.fromJson(Map<String, dynamic> json) =>
      GenerationCharacter(
        prompt: _string(json['prompt']) ?? '',
        negativePrompt: _string(json['negative_prompt']),
        centerX: _double(json['center_x']),
        centerY: _double(json['center_y']),
        enabled: _bool(json['enabled']) ?? true,
        referenceImages: _objects(json['reference_images'])
            .map(GenerationCharacterReference.fromJson)
            .toList(),
      );
}

/// A character-specific precise reference, resolved from the local asset store.
class GenerationCharacterReference {
  final String assetId;
  final double strength;

  const GenerationCharacterReference({
    required this.assetId,
    this.strength = 1.0,
  });

  Map<String, dynamic> toJson() => {'asset_id': assetId, 'strength': strength};

  factory GenerationCharacterReference.fromJson(Map<String, dynamic> json) =>
      GenerationCharacterReference(
        assetId: _string(json['asset_id']) ?? '',
        strength: _double(json['strength']) ?? 1.0,
      );
}

/// A Vibe reference. A pre-encoded value may be supplied from an encoding
/// cache; otherwise the provider adapter encodes the resolved image as needed.
class VibeReference {
  final String assetId;
  final double strength;
  final double informationExtracted;
  final String? encodedVibe;

  /// Scope metadata is absent for legacy opaque values until the user confirms
  /// which model and provider produced them.
  final VibeEncodingScope? encodedVibeScope;

  const VibeReference({
    required this.assetId,
    this.strength = 0.3,
    this.informationExtracted = 1.0,
    this.encodedVibe,
    this.encodedVibeScope,
  });

  bool get hasUnverifiedEncodedVibe =>
      encodedVibe?.isNotEmpty == true && encodedVibeScope == null;

  bool get hasScopedEncodedVibe =>
      encodedVibe?.isNotEmpty == true && encodedVibeScope != null;

  bool hasCompatibleEncoding({
    required String sourceAssetRef,
    required String? sourceSha256,
    required String model,
    required String providerProtocol,
    required Uri endpoint,
  }) =>
      encodedVibe?.isNotEmpty == true &&
      encodedVibeScope?.matches(
            sourceAssetRef: sourceAssetRef,
            sourceSha256: sourceSha256,
            model: model,
            providerProtocol: providerProtocol,
            endpoint: endpoint,
            informationExtracted: informationExtracted,
          ) ==
          true;

  bool hasCompatibleImportedEncoding({
    required String model,
    required String providerProtocol,
    required Uri endpoint,
  }) {
    final scope = encodedVibeScope;
    return encodedVibe?.isNotEmpty == true &&
        scope != null &&
        scope.sourceAssetRef.isEmpty &&
        scope.sourceSha256 == null &&
        scope.matchesProvider(
          model: model,
          providerProtocol: providerProtocol,
          endpoint: endpoint,
          informationExtracted: informationExtracted,
        );
  }

  VibeReference copyWith({
    String? assetId,
    double? strength,
    double? informationExtracted,
    String? encodedVibe,
    VibeEncodingScope? encodedVibeScope,
    bool clearEncodedVibe = false,
  }) => VibeReference(
    assetId: assetId ?? this.assetId,
    strength: strength ?? this.strength,
    informationExtracted: informationExtracted ?? this.informationExtracted,
    encodedVibe: clearEncodedVibe ? null : (encodedVibe ?? this.encodedVibe),
    encodedVibeScope: clearEncodedVibe
        ? null
        : (encodedVibeScope ??
              (encodedVibe != null ? null : this.encodedVibeScope)),
  );

  Map<String, dynamic> toJson() => {
    'asset_id': assetId,
    'strength': strength,
    'information_extracted': informationExtracted,
    if (encodedVibe != null) 'encoded_vibe': encodedVibe,
    if (encodedVibeScope != null)
      'encoded_vibe_scope': encodedVibeScope!.toJson(),
  };

  factory VibeReference.fromJson(Map<String, dynamic> json) {
    final scopeValue = json['encoded_vibe_scope'];
    return VibeReference(
      assetId: _string(json['asset_id']) ?? '',
      strength: _double(json['strength']) ?? 0.3,
      informationExtracted: _double(json['information_extracted']) ?? 1.0,
      encodedVibe: _string(json['encoded_vibe']),
      encodedVibeScope: scopeValue is Map
          ? VibeEncodingScope.fromJson(Map<String, dynamic>.from(scopeValue))
          : null,
    );
  }
}

/// A global precise reference image.
class PreciseReference {
  static const referenceTypes = {'character', 'style', 'character&style'};

  final String assetId;
  final String referenceType;
  final double strength;

  const PreciseReference({
    required this.assetId,
    this.referenceType = 'character&style',
    this.strength = 1.0,
  });

  PreciseReference copyWith({
    String? assetId,
    String? referenceType,
    double? strength,
  }) => PreciseReference(
    assetId: assetId ?? this.assetId,
    referenceType: referenceType ?? this.referenceType,
    strength: strength ?? this.strength,
  );

  Map<String, dynamic> toJson() => {
    'asset_id': assetId,
    'reference_type': referenceType,
    'strength': strength,
  };

  factory PreciseReference.fromJson(Map<String, dynamic> json) {
    final type = _string(json['reference_type']);
    return PreciseReference(
      assetId: _string(json['asset_id']) ?? '',
      referenceType: type ?? 'character&style',
      strength: _double(json['strength']) ?? 1.0,
    );
  }
}

String _operationToJson(GenerationOperation operation) => switch (operation) {
  GenerationOperation.textToImage => 'text_to_image',
  GenerationOperation.imageToImage => 'image_to_image',
  GenerationOperation.inpaint => 'inpaint',
};

GenerationOperation _operationFromJson(Object? value) => switch (value) {
  'image_to_image' || 'imageToImage' => GenerationOperation.imageToImage,
  'inpaint' || 'inpainting' => GenerationOperation.inpaint,
  null || 'text_to_image' || 'textToImage' => GenerationOperation.textToImage,
  _ => throw const FormatException('Unknown generation operation.'),
};

String? _string(Object? value) => value is String ? value : null;
int? _int(Object? value) => value is num ? value.toInt() : null;
double? _double(Object? value) => value is num ? value.toDouble() : null;
bool? _bool(Object? value) => value is bool ? value : null;

List<Map<String, dynamic>> _objects(Object? value) => value is List
    ? value.whereType<Map>().map(Map<String, dynamic>.from).toList()
    : const [];

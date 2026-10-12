import 'dart:async';
import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:archive/archive.dart';
import 'package:crypto/crypto.dart';
import 'package:http/http.dart' as http;

import 'generation_parameters.dart';
import 'network_address_lookup_stub.dart'
    if (dart.library.io) 'network_address_lookup_io.dart'
    as network_lookup;

enum NovelAiProtocol { official, gateway7877, ikun }

/// Connection settings for a single NovelAI route.
///
/// Official requests always use NovelAI's fixed image host. [baseUri] is used
/// only by gateways. Insecure loopback URLs are available solely for explicit
/// local mock tests.
class GenerationProviderConfig {
  final NovelAiProtocol protocol;
  final Uri? baseUri;
  final bool allowInsecureLoopbackForTesting;

  const GenerationProviderConfig({
    required this.protocol,
    this.baseUri,
    this.allowInsecureLoopbackForTesting = false,
  });
}

/// A credential is scoped by the caller to the selected provider endpoint.
/// Its value is never included in errors or string representations.
class GenerationCredential {
  final String value;

  const GenerationCredential(this.value);

  @override
  String toString() => 'GenerationCredential([redacted])';
}

typedef InputImageResolver = Future<Uint8List> Function(String assetId);
typedef HostSafetyLookup = Future<bool> Function(String host);

class GenerationResult {
  final Uint8List imageBytes;
  final GenerationParameters effectiveParameters;

  const GenerationResult({
    required this.imageBytes,
    required this.effectiveParameters,
  });
}

enum GenerationFailureReason {
  invalidConfiguration,
  invalidParameters,
  unsupportedCombination,
  missingImage,
  unauthorized,
  insufficientCredits,
  rateLimited,
  httpFailure,
  redirectBlocked,
  timeout,
  networkFailure,
  invalidResponse,
}

/// A deliberately sanitized failure. Server response text and request secrets
/// are never exposed through this exception.
class GenerationServiceException implements Exception {
  final GenerationFailureReason reason;
  final int? statusCode;

  const GenerationServiceException(this.reason, {this.statusCode});

  String get message => switch (reason) {
    GenerationFailureReason.invalidConfiguration => 'API 地址配置无效',
    GenerationFailureReason.invalidParameters => '生成参数无效',
    GenerationFailureReason.unsupportedCombination => '当前渠道不支持此参数组合',
    GenerationFailureReason.missingImage => '输入图像不可用，请重新选择',
    GenerationFailureReason.unauthorized => 'API 凭据无效或已失效',
    GenerationFailureReason.insufficientCredits => '账户额度不足或当前套餐不可用',
    GenerationFailureReason.rateLimited => '请求过于频繁，请稍后重试',
    GenerationFailureReason.httpFailure =>
      statusCode == null ? '图像生成请求失败' : '图像生成请求失败（HTTP $statusCode）',
    GenerationFailureReason.redirectBlocked => '服务器要求重定向，请检查 API 地址',
    GenerationFailureReason.timeout => '请求超时，请检查网络后重试',
    GenerationFailureReason.networkFailure => '无法连接到图像生成服务',
    GenerationFailureReason.invalidResponse => '服务未返回有效图像',
  };

  @override
  String toString() => message;
}

/// NovelAI-compatible image generation adapter.
///
/// The injected HTTP client is used for requests and URL-based image retrieval.
/// Image retrieval requests carry no authorization header. The caller owns the
/// client lifecycle.
class NovelAiGenerationService {
  static final Uri _officialBaseUri = Uri.https('image.novelai.net', '/');

  static const Duration _generationTimeout = Duration(minutes: 5);
  static const Duration _encodingTimeout = Duration(minutes: 3);
  static const int _maxHttpResponseBytes = 64 * 1024 * 1024;
  static const int _maxInputImageBytes = 32 * 1024 * 1024;
  static const int _maxZipEntries = 32;
  static const int _maxZipExpandedBytes = 64 * 1024 * 1024;
  static const int _maxZipImageBytes = 32 * 1024 * 1024;
  static const int _maxPreciseReferences = 32;

  final http.Client _client;
  final int Function()? _seedGenerator;
  final HostSafetyLookup _hostIsPublic;

  NovelAiGenerationService({
    required http.Client client,
    int Function()? seedGenerator,
    HostSafetyLookup? hostIsPublic,
    // ignore: prefer_initializing_formals
  }) : _client = client,
       // ignore: prefer_initializing_formals
       _seedGenerator = seedGenerator,
       _hostIsPublic = hostIsPublic ?? network_lookup.isPublicInternetHost;

  Future<GenerationResult> generate({
    required GenerationParameters parameters,
    required GenerationProviderConfig provider,
    required GenerationCredential credential,
    required InputImageResolver resolveImage,
  }) async {
    _validateCredential(credential);
    final baseUri = _resolveBaseUri(provider);
    final effective = _effectiveParameters(parameters, provider.protocol);
    final requestAssets = _ResolvedImages(
      resolveImage,
      _looksLikeImage,
      maxBytes: _maxInputImageBytes,
      maxTotalBytes: _maxZipExpandedBytes,
    );

    try {
      final bytes = switch (provider.protocol) {
        NovelAiProtocol.official => await _generateOfficial(
          effective,
          credential,
          baseUri,
          requestAssets,
        ),
        NovelAiProtocol.gateway7877 => await _generate7877(
          effective,
          credential,
          baseUri,
          requestAssets,
          allowInsecureLoopbackForTesting:
              provider.allowInsecureLoopbackForTesting,
        ),
        NovelAiProtocol.ikun => await _generateIkun(
          effective,
          credential,
          baseUri,
          requestAssets,
          allowInsecureLoopbackForTesting:
              provider.allowInsecureLoopbackForTesting,
        ),
      };
      return GenerationResult(
        imageBytes: bytes,
        effectiveParameters: effective,
      );
    } on GenerationServiceException {
      rethrow;
    } on TimeoutException {
      throw const GenerationServiceException(GenerationFailureReason.timeout);
    } on http.ClientException {
      throw const GenerationServiceException(
        GenerationFailureReason.networkFailure,
      );
    } catch (_) {
      // Do not propagate library, filesystem, server-body, or resolver details.
      throw const GenerationServiceException(
        GenerationFailureReason.invalidResponse,
      );
    }
  }

  void _validateCredential(GenerationCredential credential) {
    if (credential.value.trim().isEmpty) {
      throw const GenerationServiceException(
        GenerationFailureReason.invalidConfiguration,
      );
    }
  }

  Uri _resolveBaseUri(GenerationProviderConfig provider) {
    if (provider.protocol == NovelAiProtocol.official) {
      return _officialBaseUri;
    }
    final uri = provider.baseUri;
    if (uri == null ||
        !uri.isAbsolute ||
        uri.host.isEmpty ||
        uri.userInfo.isNotEmpty ||
        uri.hasQuery ||
        uri.hasFragment) {
      throw const GenerationServiceException(
        GenerationFailureReason.invalidConfiguration,
      );
    }
    if (uri.scheme != 'https' &&
        !(provider.allowInsecureLoopbackForTesting &&
            uri.scheme == 'http' &&
            _isLoopbackHost(uri.host))) {
      throw const GenerationServiceException(
        GenerationFailureReason.invalidConfiguration,
      );
    }
    return uri;
  }

  bool _isLoopbackHost(String host) {
    final normalized = host.toLowerCase();
    return normalized == 'localhost' ||
        normalized == '::1' ||
        normalized == '[::1]' ||
        RegExp(r'^127(?:\.\d{1,3}){3}$').hasMatch(normalized);
  }

  GenerationParameters _effectiveParameters(
    GenerationParameters input,
    NovelAiProtocol protocol,
  ) {
    final model = protocol == NovelAiProtocol.gateway7877
        ? _normalize7877Model(input.model)
        : input.model.trim();
    final isV5 = _isV5(model);
    final pixels = input.width * input.height;
    if (model.isEmpty ||
        input.width < 64 ||
        input.height < 64 ||
        input.width > 4096 ||
        input.height > 4096 ||
        input.width % 64 != 0 ||
        input.height % 64 != 0 ||
        pixels > 4096 * 4096 ||
        input.steps < 1 ||
        input.steps > (isV5 ? 28 : 50) ||
        !_isFiniteInRange(input.scale, 1, 10) ||
        !_isFiniteInRange(input.cfgRescale, 0, 1)) {
      throw const GenerationServiceException(
        GenerationFailureReason.invalidParameters,
      );
    }
    if (protocol == NovelAiProtocol.ikun &&
        (input.width > 1600 || input.height > 1600)) {
      throw const GenerationServiceException(
        GenerationFailureReason.unsupportedCombination,
      );
    }
    if (protocol != NovelAiProtocol.official && isV5 && pixels > 1024 * 1024) {
      throw const GenerationServiceException(
        GenerationFailureReason.unsupportedCombination,
      );
    }

    final seed =
        input.seed ??
        (_seedGenerator?.call() ?? Random.secure().nextInt(0x100000000));
    if (seed < 0 || seed > 0xffffffff) {
      throw const GenerationServiceException(
        GenerationFailureReason.invalidParameters,
      );
    }
    final sampler = switch (protocol) {
      NovelAiProtocol.official => _normalizeSampler(
        input.sampler,
        _gatewaySamplers,
      ),
      NovelAiProtocol.gateway7877 => _normalizeSampler(
        input.sampler,
        _gatewaySamplers,
      ),
      NovelAiProtocol.ikun => _normalizeSampler(input.sampler, _ikunSamplers),
    };
    final knownNoiseSchedules = protocol == NovelAiProtocol.ikun
        ? _ikunNoiseSchedules
        : {..._gatewayNoiseSchedules, 'native'};
    final requestedNoiseSchedule = _normalizeNoiseSchedule(
      input.noiseSchedule,
      knownNoiseSchedules,
    );
    final noiseSchedule = protocol == NovelAiProtocol.ikun
        ? requestedNoiseSchedule
        : (protocol == NovelAiProtocol.official && isV5) ||
              requestedNoiseSchedule == 'native'
        ? 'karras'
        : requestedNoiseSchedule;

    final effective = input.copyWith(
      model: model,
      sampler: sampler,
      noiseSchedule: noiseSchedule,
      seed: seed,
      img2imgStrength: input.operation == GenerationOperation.imageToImage
          ? protocol == NovelAiProtocol.official
                ? (input.img2imgStrength ?? 0.7).clamp(0.01, 0.99).toDouble()
                : (input.img2imgStrength ?? 0.7)
          : null,
      inpaintStrength: input.operation == GenerationOperation.inpaint
          ? (input.inpaintStrength ?? 1.0)
          : null,
    );
    _validateParameterValues(effective);
    _validateCombinations(effective, protocol);
    return effective;
  }

  bool _isFiniteInRange(double value, double minimum, double maximum) =>
      value.isFinite && value >= minimum && value <= maximum;

  void _validateParameterValues(GenerationParameters parameters) {
    if (parameters.characters.length > 6 ||
        parameters.preciseReferences.length > _maxPreciseReferences ||
        parameters.vibeReferences.length > 4) {
      throw const GenerationServiceException(
        GenerationFailureReason.unsupportedCombination,
      );
    }

    for (final character in parameters.characters.where(
      (item) => item.enabled,
    )) {
      if ((character.centerX == null) != (character.centerY == null)) {
        throw const GenerationServiceException(
          GenerationFailureReason.invalidParameters,
        );
      }
      if (character.centerX != null &&
          (!_isFiniteInRange(character.centerX!, 0, 1) ||
              !_isFiniteInRange(character.centerY!, 0, 1))) {
        throw const GenerationServiceException(
          GenerationFailureReason.invalidParameters,
        );
      }
      for (final reference in character.referenceImages) {
        if (reference.assetId.trim().isEmpty ||
            !_isFiniteInRange(reference.strength, 0, 1)) {
          throw const GenerationServiceException(
            GenerationFailureReason.invalidParameters,
          );
        }
      }
    }

    for (final reference in parameters.vibeReferences) {
      if ((reference.assetId.trim().isEmpty &&
              (reference.encodedVibe?.isNotEmpty != true)) ||
          !_isFiniteInRange(reference.strength, 0, 1) ||
          !_isFiniteInRange(reference.informationExtracted, 0, 1)) {
        throw const GenerationServiceException(
          GenerationFailureReason.invalidParameters,
        );
      }
    }

    for (final reference in parameters.preciseReferences) {
      if (reference.assetId.trim().isEmpty ||
          !PreciseReference.referenceTypes.contains(reference.referenceType) ||
          !_isFiniteInRange(reference.strength, 0, 1)) {
        throw const GenerationServiceException(
          GenerationFailureReason.invalidParameters,
        );
      }
    }

    final precise = _allPreciseReferences(parameters);
    if (precise.length > _maxPreciseReferences) {
      throw const GenerationServiceException(
        GenerationFailureReason.unsupportedCombination,
      );
    }
    for (final reference in precise) {
      if (reference.assetId.trim().isEmpty ||
          !PreciseReference.referenceTypes.contains(reference.referenceType) ||
          !_isFiniteInRange(reference.strength, 0, 1)) {
        throw const GenerationServiceException(
          GenerationFailureReason.invalidParameters,
        );
      }
    }

    final operationStrength = switch (parameters.operation) {
      GenerationOperation.textToImage => null,
      GenerationOperation.imageToImage => parameters.img2imgStrength ?? 0.7,
      GenerationOperation.inpaint => parameters.inpaintStrength ?? 1.0,
    };
    if (operationStrength != null &&
        !_isFiniteInRange(operationStrength, 0.01, 1)) {
      throw const GenerationServiceException(
        GenerationFailureReason.invalidParameters,
      );
    }

    final hasEnabledCharacters = parameters.characters.any(
      (character) => character.enabled,
    );
    if (hasEnabledCharacters && !_isV4Plus(parameters.model)) {
      throw const GenerationServiceException(
        GenerationFailureReason.unsupportedCombination,
      );
    }
  }

  void _validateCombinations(
    GenerationParameters parameters,
    NovelAiProtocol protocol,
  ) {
    final hasVibe = parameters.vibeReferences.isNotEmpty;
    final preciseReferences = _allPreciseReferences(parameters);
    final hasPrecise = preciseReferences.isNotEmpty;
    final enabledCharacters = parameters.characters
        .where((character) => character.enabled)
        .toList();

    if (hasVibe && hasPrecise) {
      throw const GenerationServiceException(
        GenerationFailureReason.unsupportedCombination,
      );
    }
    if (parameters.operation == GenerationOperation.textToImage &&
        (parameters.sourceImageId != null ||
            parameters.maskImageId != null ||
            parameters.img2imgSourceImageId != null)) {
      throw const GenerationServiceException(
        GenerationFailureReason.invalidParameters,
      );
    }
    if (parameters.operation == GenerationOperation.imageToImage &&
        (parameters.img2imgSourceImageId == null ||
            parameters.img2imgSourceImageId!.trim().isEmpty ||
            parameters.sourceImageId != null ||
            parameters.maskImageId != null)) {
      throw const GenerationServiceException(
        GenerationFailureReason.invalidParameters,
      );
    }
    if (parameters.operation == GenerationOperation.inpaint &&
        (parameters.sourceImageId == null ||
            parameters.sourceImageId!.trim().isEmpty ||
            parameters.maskImageId == null ||
            parameters.maskImageId!.trim().isEmpty ||
            parameters.img2imgSourceImageId != null)) {
      throw const GenerationServiceException(
        GenerationFailureReason.invalidParameters,
      );
    }
    if (parameters.operation != GenerationOperation.textToImage && hasPrecise) {
      throw const GenerationServiceException(
        GenerationFailureReason.unsupportedCombination,
      );
    }
    if (parameters.operation == GenerationOperation.inpaint && hasVibe) {
      throw const GenerationServiceException(
        GenerationFailureReason.unsupportedCombination,
      );
    }
    if (protocol == NovelAiProtocol.gateway7877 && hasPrecise) {
      throw const GenerationServiceException(
        GenerationFailureReason.unsupportedCombination,
      );
    }
    if (protocol == NovelAiProtocol.official &&
        _isV5(parameters.model) &&
        (hasVibe || hasPrecise)) {
      throw const GenerationServiceException(
        GenerationFailureReason.unsupportedCombination,
      );
    }
    if (protocol == NovelAiProtocol.gateway7877 &&
        _isV5(parameters.model) &&
        hasVibe) {
      throw const GenerationServiceException(
        GenerationFailureReason.unsupportedCombination,
      );
    }
    if (protocol == NovelAiProtocol.ikun &&
        parameters.operation == GenerationOperation.imageToImage &&
        (hasVibe || hasPrecise || enabledCharacters.isNotEmpty)) {
      throw const GenerationServiceException(
        GenerationFailureReason.unsupportedCombination,
      );
    }
    if (protocol == NovelAiProtocol.ikun &&
        parameters.operation == GenerationOperation.inpaint &&
        enabledCharacters.isNotEmpty) {
      throw const GenerationServiceException(
        GenerationFailureReason.unsupportedCombination,
      );
    }
    if (hasVibe && parameters.vibeReferences.length > 4) {
      throw const GenerationServiceException(
        GenerationFailureReason.unsupportedCombination,
      );
    }
    if (protocol == NovelAiProtocol.official &&
        hasPrecise &&
        !_supportsOfficialPrecise(parameters.model)) {
      throw const GenerationServiceException(
        GenerationFailureReason.unsupportedCombination,
      );
    }
    if (protocol == NovelAiProtocol.ikun &&
        hasPrecise &&
        !_supportsIkunPrecise(parameters.model)) {
      throw const GenerationServiceException(
        GenerationFailureReason.unsupportedCombination,
      );
    }
  }

  bool _isV5(String model) =>
      model.trim().toLowerCase().contains('v5') ||
      model.trim().toLowerCase().contains('diffusion-5');

  bool _isV4Plus(String model) {
    final normalized = model.trim().toLowerCase();
    return normalized.contains('diffusion-4') ||
        normalized.startsWith('nai-v4') ||
        _isV5(normalized);
  }

  bool _supportsOfficialPrecise(String model) {
    final normalized = model.trim().toLowerCase();
    return !_isV5(normalized) &&
        !normalized.endsWith('-limit') &&
        (normalized.startsWith('nai-v4') ||
            normalized.contains('diffusion-4-') ||
            normalized.contains('diffusion-4.'));
  }

  bool _supportsIkunPrecise(String model) {
    final normalized = model.trim().toLowerCase();
    return !normalized.endsWith('-limit') &&
        (_isV5(normalized) ||
            normalized.startsWith('nai-v4') ||
            normalized.contains('diffusion-4-') ||
            normalized.contains('diffusion-4.'));
  }

  static const _gatewaySamplers = {
    'k_euler',
    'k_euler_ancestral',
    'k_dpm_2',
    'k_dpm_2_ancestral',
    'k_dpmpp_2m',
    'k_dpmpp_2m_sde',
    'k_dpmpp_2s_ancestral',
    'k_dpmpp_sde',
    'ddim',
  };
  static const _ikunSamplers = {
    'k_euler',
    'k_euler_ancestral',
    'k_dpmpp_2s_ancestral',
    'k_dpmpp_2m',
    'k_dpmpp_2m_sde',
    'k_dpmpp_sde',
    'ddim_v3',
  };
  static const _gatewayNoiseSchedules = {
    'karras',
    'exponential',
    'polyexponential',
  };
  static const _ikunNoiseSchedules = {
    'native',
    'karras',
    'exponential',
    'polyexponential',
  };

  String _normalizeSampler(String value, Set<String> choices) {
    final normalized = value.trim().toLowerCase();
    if (!choices.contains(normalized)) {
      throw const GenerationServiceException(
        GenerationFailureReason.unsupportedCombination,
      );
    }
    return normalized;
  }

  String _normalizeNoiseSchedule(String value, Set<String> choices) {
    final normalized = value.trim().toLowerCase();
    if (!choices.contains(normalized)) {
      throw const GenerationServiceException(
        GenerationFailureReason.unsupportedCombination,
      );
    }
    return normalized;
  }

  String _normalize7877Model(String value) {
    final trimmed = value.trim();
    final normalized = trimmed.toLowerCase();
    return switch (normalized) {
      'nai-v4.5-full' || 'nai-v4-5-full' => 'nai-diffusion-4-5-full',
      'nai-v4.5-curated' || 'nai-v4-5-curated' => 'nai-diffusion-4-5-curated',
      'nai-v4-full' => 'nai-diffusion-4-full',
      'nai-v4-curated' => 'nai-diffusion-4-curated',
      'nai-v3' => 'nai-diffusion-3',
      'nai-v3-furry' || 'nai-v3-furry-limit' => 'nai-diffusion-3-furry',
      _ => trimmed,
    };
  }

  Future<Uint8List> _generateOfficial(
    GenerationParameters parameters,
    GenerationCredential credential,
    Uri baseUri,
    _ResolvedImages images,
  ) async {
    final action = switch (parameters.operation) {
      GenerationOperation.textToImage => 'generate',
      GenerationOperation.imageToImage => 'img2img',
      GenerationOperation.inpaint => 'infill',
    };
    final requestParameters = <String, dynamic>{
      'params_version': 4,
      'width': parameters.width,
      'height': parameters.height,
      'steps': parameters.steps,
      'scale': parameters.scale,
      'cfg_rescale': parameters.cfgRescale,
      'sampler': parameters.sampler,
      'noise_schedule': parameters.noiseSchedule,
      'n_samples': 1,
      'seed': parameters.seed,
      'uc': parameters.negativePrompt ?? '',
      'negative_prompt': parameters.negativePrompt ?? '',
      'qualityToggle': true,
      'quality_toggle': true,
      'ucPreset': 1,
      'uc_preset': 1,
    };

    final characters = parameters.characters
        .where((character) => character.enabled)
        .toList();
    if (_isV4Plus(parameters.model)) {
      final hasCoordinates = characters.any(
        (character) => character.centerX != null && character.centerY != null,
      );
      final useCoordinates = parameters.useCoords && hasCoordinates;
      requestParameters.addAll({
        'use_coords': useCoordinates,
        'v4_prompt': {
          'caption': {
            'base_caption': parameters.prompt,
            'char_captions': characters
                .map(
                  (character) => {
                    'char_caption': character.prompt,
                    'centers': [
                      {
                        'x': character.centerX ?? 0.5,
                        'y': character.centerY ?? 0.5,
                      },
                    ],
                  },
                )
                .toList(),
          },
          'use_coords': useCoordinates,
          'use_order': true,
        },
        'v4_negative_prompt': {
          'caption': {
            'base_caption': parameters.negativePrompt ?? '',
            'char_captions': characters
                .map(
                  (character) => {
                    'char_caption': character.negativePrompt ?? '',
                    'centers': [
                      {
                        'x': character.centerX ?? 0.5,
                        'y': character.centerY ?? 0.5,
                      },
                    ],
                  },
                )
                .toList(),
          },
          'use_coords':
              useCoordinates &&
              characters.any(
                (character) => (character.negativePrompt ?? '').isNotEmpty,
              ),
          'use_order': false,
        },
      });
    } else {
      requestParameters.addAll({'sm': false, 'sm_dyn': false});
    }

    if (parameters.operation == GenerationOperation.imageToImage) {
      final source = await images.resolve(parameters.img2imgSourceImageId!);
      requestParameters.addAll({
        'image': base64Encode(source),
        'strength': parameters.img2imgStrength ?? 0.7,
        'noise': 0.2,
      });
    }
    if (parameters.operation == GenerationOperation.inpaint) {
      final source = await images.resolve(parameters.sourceImageId!);
      final mask = await images.resolve(parameters.maskImageId!);
      requestParameters.addAll({
        'image': base64Encode(source),
        'mask': base64Encode(mask),
        'strength': parameters.inpaintStrength ?? 1.0,
        'add_original_image': !parameters.disabledOriginalImage,
        'color_correct': parameters.colorCorrect,
      });
    }

    if (parameters.vibeReferences.isNotEmpty) {
      final encoded = <String>[];
      for (final reference in parameters.vibeReferences) {
        encoded.add(
          reference.encodedVibe?.isNotEmpty == true
              ? reference.encodedVibe!
              : await _encodeOfficialVibe(
                  parameters,
                  reference,
                  credential,
                  baseUri,
                  images,
                ),
        );
      }
      requestParameters.addAll({
        'reference_image_multiple': encoded,
        'reference_strength_multiple': parameters.vibeReferences
            .map((reference) => _clamp01(reference.strength))
            .toList(),
        'reference_information_extracted_multiple': parameters.vibeReferences
            .map((reference) => _clamp01(reference.informationExtracted))
            .toList(),
      });
    }

    final precise = _allPreciseReferences(parameters);
    final payload = <String, dynamic>{
      'input': parameters.prompt,
      'model':
          parameters.operation == GenerationOperation.inpaint &&
              !parameters.model.endsWith('-inpainting')
          ? '${parameters.model}-inpainting'
          : parameters.model,
      'action': action,
      'parameters': requestParameters,
    };

    if (precise.isNotEmpty) {
      final files = <String, Uint8List>{};
      final cached = <Map<String, String>>[];
      final descriptions = <Map<String, dynamic>>[];
      for (var index = 0; index < precise.length; index++) {
        final reference = precise[index];
        final bytes = await images.resolve(reference.assetId);
        final fieldName = 'director_ref_$index';
        files[fieldName] = bytes;
        cached.add({
          'cache_secret_key': sha256.convert(bytes).toString(),
          'data': fieldName,
        });
        descriptions.add({
          'caption': {
            'base_caption': reference.referenceType,
            'char_captions': <Map<String, dynamic>>[],
          },
          'legacy_uc': false,
        });
      }
      requestParameters.addAll({
        'director_reference_images_cached': cached,
        'director_reference_descriptions': descriptions,
        'director_reference_strength_values': precise
            .map((reference) => _clamp01(reference.strength))
            .toList(),
        'director_reference_secondary_strength_values': List<double>.filled(
          precise.length,
          0,
        ),
        'director_reference_information_extracted': List<double>.filled(
          precise.length,
          1,
        ),
        'normalize_reference_strength_multiple': true,
      });
      for (final key in const ['image', 'mask']) {
        final encoded = requestParameters[key];
        if (encoded is String && encoded.isNotEmpty) {
          files[key] = Uint8List.fromList(base64Decode(encoded));
          requestParameters[key] = key;
        }
      }
      return _extractOfficialImage(
        await _sendMultipart(
          _endpoint(baseUri, '/ai/generate-image'),
          credential,
          payload,
          files,
          timeout: _generationTimeout,
        ),
      );
    }

    return _extractOfficialImage(
      await _sendJson(
        _endpoint(baseUri, '/ai/generate-image'),
        credential,
        payload,
        accept: 'application/zip, application/json',
        timeout: _generationTimeout,
      ),
    );
  }

  Future<String> _encodeOfficialVibe(
    GenerationParameters parameters,
    VibeReference reference,
    GenerationCredential credential,
    Uri baseUri,
    _ResolvedImages images,
  ) async {
    final source = await images.resolve(reference.assetId);
    final response = await _sendJson(
      _endpoint(baseUri, '/ai/encode-vibe'),
      credential,
      {
        'image': base64Encode(source),
        'model': parameters.model,
        'information_extracted': _clamp01(reference.informationExtracted),
      },
      accept: 'application/binary',
      timeout: _encodingTimeout,
    );
    if (response.bodyBytes.isEmpty) {
      throw const GenerationServiceException(
        GenerationFailureReason.invalidResponse,
      );
    }
    return base64Encode(response.bodyBytes);
  }

  Future<Uint8List> _generate7877(
    GenerationParameters parameters,
    GenerationCredential credential,
    Uri baseUri,
    _ResolvedImages images, {
    required bool allowInsecureLoopbackForTesting,
  }) async {
    final path = '/v1/images/generations';
    final characters = _gatewayCharacters(parameters.characters);
    final vibe = await _prepareGatewayVibes(
      parameters,
      credential,
      baseUri,
      images,
    );
    final seed = parameters.seed;
    final commonParams = <String, dynamic>{
      'steps': parameters.steps,
      'scale': parameters.scale,
      'cfg_rescale': parameters.cfgRescale,
      'sampler': parameters.sampler,
      'noise_schedule': parameters.noiseSchedule,
      'seed': seed,
      if ((parameters.negativePrompt ?? '').isNotEmpty)
        'negative_prompt': parameters.negativePrompt,
      'quality': true,
      'uc_preset': 'light',
      'sm': false,
      'sm_dyn': false,
      if (characters.isNotEmpty) 'characters': characters,
      if (characters.isNotEmpty) 'use_coords': parameters.useCoords,
      if (vibe.images.isNotEmpty) 'reference_image_multiple': vibe.images,
      if (vibe.images.isNotEmpty) 'reference_strength_multiple': vibe.strengths,
      if (vibe.images.isNotEmpty)
        'reference_information_extracted_multiple': vibe.informationExtracted,
    };

    late final Map<String, dynamic> payload;
    switch (parameters.operation) {
      case GenerationOperation.textToImage:
        payload = {
          'model': parameters.model,
          'prompt': parameters.prompt,
          'n': 1,
          'size': '${parameters.width}x${parameters.height}',
          'width': parameters.width,
          'height': parameters.height,
          'response_format': 'b64_json',
          'params': commonParams,
        };
      case GenerationOperation.imageToImage:
        final source = await images.resolve(parameters.img2imgSourceImageId!);
        payload = {
          'model': parameters.model,
          'prompt': parameters.prompt,
          'image': base64Encode(source),
          'strength': parameters.img2imgStrength ?? 0.7,
          'noise': 0.0,
          'color_correct': true,
          'n': 1,
          'size': '${parameters.width}x${parameters.height}',
          'response_format': 'b64_json',
          'params': commonParams,
        };
      case GenerationOperation.inpaint:
        final source = await images.resolve(parameters.sourceImageId!);
        final mask = await images.resolve(parameters.maskImageId!);
        commonParams.remove('characters');
        commonParams.remove('use_coords');
        commonParams.remove('reference_image_multiple');
        commonParams.remove('reference_strength_multiple');
        commonParams.remove('reference_information_extracted_multiple');
        payload = {
          'model': parameters.model,
          'prompt': parameters.prompt,
          'image': base64Encode(source),
          'mask': base64Encode(mask),
          'strength': parameters.inpaintStrength ?? 1.0,
          'n': 1,
          'size': '${parameters.width}x${parameters.height}',
          'response_format': 'b64_json',
          'params': commonParams,
        };
    }
    return _extractGatewayImage(
      await _sendJson(
        _endpoint(baseUri, path),
        credential,
        payload,
        accept: 'application/json',
        timeout: _generationTimeout,
      ),
      baseUri,
      allowInsecureLoopbackForTesting: allowInsecureLoopbackForTesting,
    );
  }

  Future<Uint8List> _generateIkun(
    GenerationParameters parameters,
    GenerationCredential credential,
    Uri baseUri,
    _ResolvedImages images, {
    required bool allowInsecureLoopbackForTesting,
  }) async {
    final path = '/v1/images/generations';
    final seed = parameters.seed;
    final characters = parameters.characters
        .where((character) => character.enabled)
        .toList();
    final preciseReferences = _allPreciseReferences(parameters);
    if (parameters.operation == GenerationOperation.textToImage &&
        preciseReferences.isNotEmpty) {
      final references = <Map<String, dynamic>>[];
      for (final reference in preciseReferences) {
        references.add({
          'reference_image': base64Encode(
            await images.resolve(reference.assetId),
          ),
          'reference_type': reference.referenceType,
          'strength': _clamp01(reference.strength),
          'fidelity': 1.0,
        });
      }
      final payload = {
        'novelai_operation': 'precise-reference',
        'prompt': parameters.prompt,
        if ((parameters.negativePrompt ?? '').isNotEmpty)
          'negative_prompt': parameters.negativePrompt,
        'model': parameters.model,
        'size': '${parameters.width}x${parameters.height}',
        'width': parameters.width,
        'height': parameters.height,
        'steps': parameters.steps,
        'n_samples': 1,
        'scale': parameters.scale,
        'sampler': parameters.sampler,
        'noise_schedule': parameters.noiseSchedule,
        'cfg_rescale': parameters.cfgRescale,
        'seed': seed,
        'response_format': 'b64_json',
        'references': references,
      };
      return _extractGatewayImage(
        await _sendJson(
          _endpoint(baseUri, path),
          credential,
          payload,
          accept: 'application/json',
          timeout: _generationTimeout,
        ),
        baseUri,
        allowInsecureLoopbackForTesting: allowInsecureLoopbackForTesting,
      );
    }
    late final Map<String, dynamic> payload;

    switch (parameters.operation) {
      case GenerationOperation.textToImage:
        final referenceImages = <String>[];
        for (final reference in parameters.vibeReferences) {
          referenceImages.add(
            reference.encodedVibe?.isNotEmpty == true
                ? reference.encodedVibe!
                : base64Encode(await images.resolve(reference.assetId)),
          );
        }
        payload = {
          'prompt': parameters.prompt,
          'model': parameters.model,
          'n': 1,
          'size': '${parameters.width}x${parameters.height}',
          'width': parameters.width,
          'height': parameters.height,
          'steps': parameters.steps,
          'scale': parameters.scale,
          'cfg_rescale': parameters.cfgRescale,
          'sampler': parameters.sampler,
          'noise_schedule': parameters.noiseSchedule,
          'seed': seed,
          if ((parameters.negativePrompt ?? '').isNotEmpty)
            'negative_prompt': parameters.negativePrompt,
          if (characters.isNotEmpty)
            'characterPrompts': _ikunCharacters(characters),
          if (characters.isNotEmpty) 'use_coords': parameters.useCoords,
          if (characters.isNotEmpty)
            'v4_negative_prompt': _ikunCharacterNegativePrompt(parameters),
          if (referenceImages.length == 1)
            'reference_image': referenceImages[0],
          if (referenceImages.length > 1) 'reference_images': referenceImages,
          if (referenceImages.length == 1)
            'reference_strength': parameters.vibeReferences[0].strength,
          if (referenceImages.length == 1)
            'reference_information_extracted':
                parameters.vibeReferences[0].informationExtracted,
          if (referenceImages.length > 1)
            'reference_strength_multiple': parameters.vibeReferences
                .map((reference) => reference.strength)
                .toList(),
          if (referenceImages.length > 1)
            'reference_information_extracted_multiple': parameters
                .vibeReferences
                .map((reference) => reference.informationExtracted)
                .toList(),
          'response_format': 'b64_json',
        };
      case GenerationOperation.imageToImage:
        final source = await images.resolve(parameters.img2imgSourceImageId!);
        payload = {
          'novelai_operation': 'img2img',
          'model': parameters.model,
          'prompt': parameters.prompt,
          if ((parameters.negativePrompt ?? '').isNotEmpty)
            'negative_prompt': parameters.negativePrompt,
          'image': base64Encode(source),
          'width': parameters.width,
          'height': parameters.height,
          'strength': parameters.img2imgStrength ?? 0.7,
          'noise': 0.0,
          'steps': parameters.steps,
          'scale': parameters.scale,
          'cfg_rescale': parameters.cfgRescale,
          'sampler': parameters.sampler,
          'noise_schedule': parameters.noiseSchedule,
          'seed': seed,
          'response_format': 'b64_json',
        };
      case GenerationOperation.inpaint:
        final source = await images.resolve(parameters.sourceImageId!);
        final mask = await images.resolve(parameters.maskImageId!);
        payload = {
          'novelai_operation': 'inpainting',
          'model': parameters.model,
          'prompt': parameters.prompt,
          if ((parameters.negativePrompt ?? '').isNotEmpty)
            'negative_prompt': parameters.negativePrompt,
          'image': base64Encode(source),
          'mask': base64Encode(mask),
          'strength': parameters.inpaintStrength ?? 1.0,
          'noise': 0.0,
          'add_original_image': !parameters.disabledOriginalImage,
          'color_correct': parameters.colorCorrect,
          'n': 1,
          'size': '${parameters.width}x${parameters.height}',
          'width': parameters.width,
          'height': parameters.height,
          'steps': parameters.steps,
          'scale': parameters.scale,
          'cfg_rescale': parameters.cfgRescale,
          'sampler': parameters.sampler,
          'noise_schedule': parameters.noiseSchedule,
          'seed': seed,
          'response_format': 'b64_json',
        };
    }
    return _extractGatewayImage(
      await _sendJson(
        _endpoint(baseUri, path),
        credential,
        payload,
        accept: 'application/json',
        timeout: _generationTimeout,
      ),
      baseUri,
      allowInsecureLoopbackForTesting: allowInsecureLoopbackForTesting,
    );
  }

  Future<_PreparedVibes> _prepareGatewayVibes(
    GenerationParameters parameters,
    GenerationCredential credential,
    Uri baseUri,
    _ResolvedImages images,
  ) async {
    if (parameters.vibeReferences.isEmpty) return const _PreparedVibes.empty();
    final encodedImages = <String>[];
    final strengths = <double>[];
    final information = <double>[];
    for (final reference in parameters.vibeReferences) {
      final encoded = reference.encodedVibe?.isNotEmpty == true
          ? reference.encodedVibe!
          : await _encodeGatewayVibe(
              parameters,
              reference,
              credential,
              baseUri,
              images,
            );
      encodedImages.add(encoded);
      strengths.add(_clamp01(reference.strength));
      information.add(_clamp01(reference.informationExtracted));
    }
    return _PreparedVibes(encodedImages, strengths, information);
  }

  Future<String> _encodeGatewayVibe(
    GenerationParameters parameters,
    VibeReference reference,
    GenerationCredential credential,
    Uri baseUri,
    _ResolvedImages images,
  ) async {
    final image = await images.resolve(reference.assetId);
    final response = await _sendJson(
      _endpoint(baseUri, '/v1/images/generations'),
      credential,
      {
        'model': parameters.model,
        'extra': 'encode-vibe',
        'image': base64Encode(image),
        'information_extracted': _clamp01(reference.informationExtracted),
      },
      accept: 'application/json',
      timeout: _encodingTimeout,
    );
    final data = _jsonObject(response.bodyBytes);
    final entries = data['data'];
    final first = entries is List && entries.isNotEmpty ? entries.first : null;
    final value = first is Map
        ? first['b64_json'] ?? first['encoding'] ?? first['encoded_vibe']
        : null;
    if (value is! String || value.isEmpty) {
      throw const GenerationServiceException(
        GenerationFailureReason.invalidResponse,
      );
    }
    return value;
  }

  Future<http.Response> _sendJson(
    Uri uri,
    GenerationCredential credential,
    Map<String, dynamic> payload, {
    required String accept,
    required Duration timeout,
  }) async {
    final request = http.Request('POST', uri)
      ..followRedirects = false
      ..headers.addAll({
        'Authorization': 'Bearer ${credential.value}',
        'Content-Type': 'application/json',
        'Accept': accept,
      })
      ..body = jsonEncode(payload);
    return _send(request, timeout: timeout);
  }

  Future<http.Response> _sendMultipart(
    Uri uri,
    GenerationCredential credential,
    Map<String, dynamic> payload,
    Map<String, Uint8List> files, {
    required Duration timeout,
  }) async {
    final request = http.MultipartRequest('POST', uri)
      ..followRedirects = false
      ..headers.addAll({
        'Authorization': 'Bearer ${credential.value}',
        'Accept': 'application/zip, application/json',
      });
    request.files.add(
      http.MultipartFile.fromString(
        'request',
        jsonEncode(payload),
        filename: 'request.json',
        contentType: _jsonContentType,
      ),
    );
    for (final entry in files.entries) {
      request.files.add(
        http.MultipartFile.fromBytes(
          entry.key,
          entry.value,
          filename: '${entry.key}.png',
        ),
      );
    }
    for (final key in const ['image', 'mask']) {
      final value = (payload['parameters'] as Map<String, dynamic>)[key];
      if (value is String && value.isNotEmpty && !files.containsKey(key)) {
        final bytes = base64Decode(value);
        request.files.add(
          http.MultipartFile.fromBytes(key, bytes, filename: '$key.png'),
        );
      }
    }
    return _send(request, timeout: timeout);
  }

  http.MediaType get _jsonContentType =>
      http.MediaType('application', 'json', {'charset': 'utf-8'});

  Future<http.Response> _send(
    http.BaseRequest request, {
    required Duration timeout,
  }) async {
    http.StreamedResponse streamed;
    try {
      streamed = await _client.send(request).timeout(timeout);
      if (streamed.statusCode >= 300 && streamed.statusCode < 400) {
        throw const GenerationServiceException(
          GenerationFailureReason.redirectBlocked,
        );
      }
      if (streamed.statusCode < 200 || streamed.statusCode >= 300) {
        final reason = switch (streamed.statusCode) {
          401 => GenerationFailureReason.unauthorized,
          402 => GenerationFailureReason.insufficientCredits,
          429 => GenerationFailureReason.rateLimited,
          _ => GenerationFailureReason.httpFailure,
        };
        throw GenerationServiceException(
          reason,
          statusCode: streamed.statusCode,
        );
      }
      if ((streamed.contentLength ?? 0) > _maxHttpResponseBytes) {
        throw const GenerationServiceException(
          GenerationFailureReason.invalidResponse,
        );
      }
      final body = BytesBuilder(copy: false);
      var bodyLength = 0;
      await for (final chunk in streamed.stream.timeout(timeout)) {
        bodyLength += chunk.length;
        if (bodyLength > _maxHttpResponseBytes) {
          throw const GenerationServiceException(
            GenerationFailureReason.invalidResponse,
          );
        }
        body.add(chunk);
      }
      return http.Response.bytes(
        body.takeBytes(),
        streamed.statusCode,
        request: streamed.request,
        headers: streamed.headers,
        isRedirect: streamed.isRedirect,
        persistentConnection: streamed.persistentConnection,
        reasonPhrase: streamed.reasonPhrase,
      );
    } on GenerationServiceException {
      rethrow;
    } on TimeoutException {
      throw const GenerationServiceException(GenerationFailureReason.timeout);
    } on http.ClientException {
      throw const GenerationServiceException(
        GenerationFailureReason.networkFailure,
      );
    } catch (_) {
      throw const GenerationServiceException(
        GenerationFailureReason.networkFailure,
      );
    }
  }

  Future<Uint8List> _extractOfficialImage(http.Response response) async {
    if (_looksLikeZip(response.bodyBytes) ||
        response.headers['content-type']?.toLowerCase().contains('zip') ==
            true) {
      try {
        final expectedEntries = _validateZipEnvelope(response.bodyBytes);
        final archive = ZipDecoder().decodeBytes(response.bodyBytes);
        if (archive.files.length != expectedEntries) {
          throw const GenerationServiceException(
            GenerationFailureReason.invalidResponse,
          );
        }
        var expandedBytes = 0;
        for (final file in archive.files) {
          expandedBytes += file.size;
          if (expandedBytes > _maxZipExpandedBytes ||
              (_isImageFilename(file.name) && file.size > _maxZipImageBytes)) {
            throw const GenerationServiceException(
              GenerationFailureReason.invalidResponse,
            );
          }
          if (!file.isFile || !_isImageFilename(file.name)) continue;
          final bytes = file.readBytes();
          if (bytes != null) return _validatedImageBytes(bytes);
        }
      } catch (_) {
        throw const GenerationServiceException(
          GenerationFailureReason.invalidResponse,
        );
      }
      throw const GenerationServiceException(
        GenerationFailureReason.invalidResponse,
      );
    }
    if (_looksLikeImage(response.bodyBytes)) {
      return _validatedImageBytes(response.bodyBytes);
    }
    final body = _jsonObject(response.bodyBytes);
    final images = body['images'];
    if (images is List && images.isNotEmpty && images.first is Map) {
      final encoded = (images.first as Map)['image'];
      if (encoded is String) return _decodeBase64Image(encoded);
    }
    throw const GenerationServiceException(
      GenerationFailureReason.invalidResponse,
    );
  }

  Future<Uint8List> _extractGatewayImage(
    http.Response response,
    Uri baseUri, {
    required bool allowInsecureLoopbackForTesting,
  }) async {
    final data = _jsonObject(response.bodyBytes);
    final entries = data['data'];
    if (entries is List && entries.isNotEmpty && entries.first is Map) {
      final first = entries.first as Map;
      final encoded = first['b64_json'];
      if (encoded is String && encoded.isNotEmpty) {
        return _decodeBase64Image(encoded);
      }
      final url = first['url'];
      if (url is String && url.isNotEmpty) {
        return _downloadImageUrl(
          url,
          baseUri,
          allowInsecureLoopbackForTesting: allowInsecureLoopbackForTesting,
        );
      }
    }

    final choices = data['choices'];
    if (choices is List && choices.isNotEmpty && choices.first is Map) {
      final message = (choices.first as Map)['message'];
      final content = message is Map ? message['content'] : null;
      final candidate = _imageCandidateFromContent(content);
      if (candidate != null) {
        return _downloadImageUrl(
          candidate,
          baseUri,
          allowInsecureLoopbackForTesting: allowInsecureLoopbackForTesting,
        );
      }
    }
    throw const GenerationServiceException(
      GenerationFailureReason.invalidResponse,
    );
  }

  String? _imageCandidateFromContent(Object? content) {
    if (content is String) {
      final markdown = RegExp(r'!\[[^\]]*\]\(([^)]+)\)').firstMatch(content);
      if (markdown != null) return markdown.group(1)?.trim();
      final trimmed = content.trim();
      if (trimmed.startsWith('https://')) return trimmed;
    }
    if (content is List) {
      for (final part in content) {
        if (part is! Map) continue;
        final imageUrl = part['image_url'];
        if (imageUrl is Map && imageUrl['url'] is String) {
          return imageUrl['url'] as String;
        }
        final text = _imageCandidateFromContent(part['text']);
        if (text != null) return text;
      }
    }
    return null;
  }

  Future<Uint8List> _downloadImageUrl(
    String value,
    Uri baseUri, {
    required bool allowInsecureLoopbackForTesting,
  }) async {
    final uri = Uri.tryParse(value);
    if (uri == null || uri.userInfo.isNotEmpty || uri.hasFragment) {
      throw const GenerationServiceException(
        GenerationFailureReason.invalidResponse,
      );
    }
    final target = uri.isAbsolute ? uri : baseUri.resolveUri(uri);
    final isTestLoopbackHttp =
        allowInsecureLoopbackForTesting &&
        target.scheme == 'http' &&
        _isLoopbackHost(target.host);
    if (target.userInfo.isNotEmpty ||
        target.hasFragment ||
        (target.scheme != 'https' && !isTestLoopbackHttp)) {
      throw const GenerationServiceException(
        GenerationFailureReason.invalidResponse,
      );
    }
    await _validateImageUrlHost(
      target,
      allowInsecureLoopbackForTesting: allowInsecureLoopbackForTesting,
    );
    final request = http.Request('GET', target)
      ..followRedirects = false
      ..headers['Accept'] = 'image/*';
    final response = await _send(request, timeout: _generationTimeout);
    if (_looksLikeImage(response.bodyBytes)) {
      return Uint8List.fromList(response.bodyBytes);
    }
    // A URL endpoint returning JSON or another HTML page is not an image.
    throw const GenerationServiceException(
      GenerationFailureReason.invalidResponse,
    );
  }

  Future<void> _validateImageUrlHost(
    Uri target, {
    required bool allowInsecureLoopbackForTesting,
  }) async {
    if (allowInsecureLoopbackForTesting &&
        target.scheme == 'http' &&
        _isLoopbackHost(target.host)) {
      return;
    }
    if (target.scheme != 'https') {
      throw const GenerationServiceException(
        GenerationFailureReason.invalidResponse,
      );
    }

    final host = target.host.toLowerCase().replaceFirst(RegExp(r'\.$'), '');
    if (host.contains('%') ||
        !host.contains('.') ||
        host == 'localhost' ||
        host.endsWith('.localhost') ||
        host.endsWith('.local') ||
        host.endsWith('.internal') ||
        host.endsWith('.home') ||
        host.endsWith('.lan') ||
        host.endsWith('.test') ||
        host.endsWith('.example') ||
        host.endsWith('.invalid') ||
        host.endsWith('.onion') ||
        host.endsWith('.arpa')) {
      throw const GenerationServiceException(
        GenerationFailureReason.invalidResponse,
      );
    }

    bool isPublic;
    try {
      isPublic = await _hostIsPublic(host);
    } catch (_) {
      isPublic = false;
    }
    if (!isPublic) {
      throw const GenerationServiceException(
        GenerationFailureReason.invalidResponse,
      );
    }
  }

  Uint8List _decodeBase64Image(String value) {
    final trimmed = value.trim();
    final base64Value = trimmed.startsWith('data:image/')
        ? trimmed.substring(trimmed.indexOf(',') + 1)
        : trimmed;
    if (base64Value.length > ((_maxZipImageBytes + 2) ~/ 3) * 4) {
      throw const GenerationServiceException(
        GenerationFailureReason.invalidResponse,
      );
    }
    try {
      final bytes = base64Decode(base64Value);
      return _validatedImageBytes(bytes);
    } on GenerationServiceException {
      rethrow;
    } on FormatException {
      throw const GenerationServiceException(
        GenerationFailureReason.invalidResponse,
      );
    }
  }

  Map<String, dynamic> _jsonObject(List<int> bytes) {
    try {
      final decoded = jsonDecode(utf8.decode(bytes, allowMalformed: true));
      if (decoded is Map) return Map<String, dynamic>.from(decoded);
    } catch (_) {
      // The caller receives a sanitized protocol error below.
    }
    throw const GenerationServiceException(
      GenerationFailureReason.invalidResponse,
    );
  }

  bool _looksLikeZip(List<int> bytes) =>
      bytes.length >= 4 &&
      bytes[0] == 0x50 &&
      bytes[1] == 0x4b &&
      bytes[2] == 0x03 &&
      bytes[3] == 0x04;

  int _validateZipEnvelope(List<int> bytes) {
    if (bytes.length < 22 || bytes.length > _maxHttpResponseBytes) {
      throw const GenerationServiceException(
        GenerationFailureReason.invalidResponse,
      );
    }
    final earliest = max(0, bytes.length - 22 - 0xffff);
    var endRecord = -1;
    for (var offset = bytes.length - 22; offset >= earliest; offset--) {
      if (bytes[offset] == 0x50 &&
          bytes[offset + 1] == 0x4b &&
          bytes[offset + 2] == 0x05 &&
          bytes[offset + 3] == 0x06) {
        endRecord = offset;
        break;
      }
    }
    if (endRecord < 0) {
      throw const GenerationServiceException(
        GenerationFailureReason.invalidResponse,
      );
    }
    final entriesOnDisk = _readUint16(bytes, endRecord + 8);
    final entryCount = _readUint16(bytes, endRecord + 10);
    final directorySize = _readUint32(bytes, endRecord + 12);
    final directoryOffset = _readUint32(bytes, endRecord + 16);
    final commentLength = _readUint16(bytes, endRecord + 20);
    final directoryEnd = directoryOffset + directorySize;
    if (endRecord + 22 + commentLength != bytes.length ||
        entryCount == 0 ||
        entryCount > _maxZipEntries ||
        entriesOnDisk != entryCount ||
        entryCount == 0xffff ||
        directorySize == 0xffffffff ||
        directoryOffset == 0xffffffff ||
        directoryEnd != endRecord ||
        (endRecord >= 20 && _readUint32(bytes, endRecord - 20) == 0x07064b50)) {
      throw const GenerationServiceException(
        GenerationFailureReason.invalidResponse,
      );
    }

    var cursor = directoryOffset;
    var scannedEntries = 0;
    for (var index = 0; index < entryCount; index++) {
      if (cursor + 46 > directoryEnd ||
          _readUint32(bytes, cursor) != 0x02014b50) {
        throw const GenerationServiceException(
          GenerationFailureReason.invalidResponse,
        );
      }
      final filenameLength = _readUint16(bytes, cursor + 28);
      final extraLength = _readUint16(bytes, cursor + 30);
      final entryCommentLength = _readUint16(bytes, cursor + 32);
      final entryEnd =
          cursor + 46 + filenameLength + extraLength + entryCommentLength;
      if (entryEnd > directoryEnd) {
        throw const GenerationServiceException(
          GenerationFailureReason.invalidResponse,
        );
      }
      cursor = entryEnd;
      scannedEntries++;
    }
    if (cursor != directoryEnd || scannedEntries != entryCount) {
      throw const GenerationServiceException(
        GenerationFailureReason.invalidResponse,
      );
    }
    return entryCount;
  }

  int _readUint16(List<int> bytes, int offset) =>
      bytes[offset] | (bytes[offset + 1] << 8);

  int _readUint32(List<int> bytes, int offset) =>
      bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] * 0x1000000);

  bool _looksLikeImage(List<int> bytes) {
    if (bytes.length >= 8 &&
        bytes[0] == 0x89 &&
        bytes[1] == 0x50 &&
        bytes[2] == 0x4e &&
        bytes[3] == 0x47 &&
        bytes[4] == 0x0d &&
        bytes[5] == 0x0a &&
        bytes[6] == 0x1a &&
        bytes[7] == 0x0a) {
      return true;
    }
    if (bytes.length >= 3 &&
        bytes[0] == 0xff &&
        bytes[1] == 0xd8 &&
        bytes[2] == 0xff) {
      return true;
    }
    if (bytes.length >= 12 &&
        ascii.decode(bytes.sublist(0, 4), allowInvalid: true) == 'RIFF' &&
        ascii.decode(bytes.sublist(8, 12), allowInvalid: true) == 'WEBP') {
      return true;
    }
    return false;
  }

  Uint8List _validatedImageBytes(List<int> bytes) {
    if (bytes.isEmpty ||
        bytes.length > _maxZipImageBytes ||
        !_looksLikeImage(bytes)) {
      throw const GenerationServiceException(
        GenerationFailureReason.invalidResponse,
      );
    }
    return Uint8List.fromList(bytes);
  }

  bool _isImageFilename(String value) {
    final name = value.toLowerCase();
    return name.endsWith('.png') ||
        name.endsWith('.jpg') ||
        name.endsWith('.jpeg') ||
        name.endsWith('.webp');
  }

  Uri _endpoint(Uri base, String path) {
    return base.replace(path: path, query: null, fragment: null);
  }

  List<Map<String, dynamic>> _gatewayCharacters(
    List<GenerationCharacter> input,
  ) => input.where((character) => character.enabled).map((character) {
    return {
      'prompt': character.prompt,
      'uc': character.negativePrompt ?? '',
      if (character.centerX != null && character.centerY != null)
        'center': {'x': character.centerX, 'y': character.centerY},
    };
  }).toList();

  List<Map<String, dynamic>> _ikunCharacters(List<GenerationCharacter> input) =>
      input.map((character) {
        return {
          'prompt': character.prompt,
          if (character.centerX != null && character.centerY != null)
            'center': {'x': character.centerX, 'y': character.centerY},
        };
      }).toList();

  Map<String, dynamic>? _ikunCharacterNegativePrompt(
    GenerationParameters parameters,
  ) {
    final characters = parameters.characters
        .where((character) => character.enabled)
        .toList();
    if (characters.isEmpty ||
        !characters.any(
          (character) => (character.negativePrompt ?? '').isNotEmpty,
        )) {
      return null;
    }
    return {
      'caption': {
        'base_caption': parameters.negativePrompt ?? '',
        'char_captions': characters
            .map(
              (character) => {
                'char_caption': character.negativePrompt ?? '',
                'centers':
                    character.centerX != null && character.centerY != null
                    ? [
                        {'x': character.centerX, 'y': character.centerY},
                      ]
                    : <Map<String, dynamic>>[],
              },
            )
            .toList(),
      },
      'legacy_uc': false,
    };
  }

  List<PreciseReference> _allPreciseReferences(
    GenerationParameters parameters,
  ) {
    final result = <PreciseReference>[];
    final seenReferences = <String>{};
    void add(PreciseReference reference) {
      final key =
          '${reference.assetId}\u0000${reference.referenceType}\u0000${reference.strength}';
      if (reference.assetId.isNotEmpty && seenReferences.add(key)) {
        result.add(reference);
      }
    }

    for (final reference in parameters.preciseReferences) {
      add(reference);
    }
    for (final character in parameters.characters.where(
      (item) => item.enabled,
    )) {
      for (final reference in character.referenceImages) {
        add(
          PreciseReference(
            assetId: reference.assetId,
            referenceType: 'character',
            strength: reference.strength,
          ),
        );
      }
    }
    return result;
  }

  double _clamp01(double value) => value.clamp(0.0, 1.0).toDouble();
}

class _ResolvedImages {
  final InputImageResolver _resolver;
  final bool Function(List<int>) _isImage;
  final int _maxBytes;
  final int _maxTotalBytes;
  final Map<String, Uint8List> _cache = {};
  int _totalBytes = 0;

  _ResolvedImages(
    this._resolver,
    this._isImage, {
    required this._maxBytes,
    required this._maxTotalBytes,
  });

  Future<Uint8List> resolve(String assetId) async {
    if (assetId.trim().isEmpty) {
      throw const GenerationServiceException(
        GenerationFailureReason.missingImage,
      );
    }
    final cached = _cache[assetId];
    if (cached != null) return cached;
    try {
      final bytes = await _resolver(assetId);
      if (bytes.isEmpty ||
          bytes.length > _maxBytes ||
          _totalBytes + bytes.length > _maxTotalBytes ||
          !_isImage(bytes)) {
        throw const GenerationServiceException(
          GenerationFailureReason.missingImage,
        );
      }
      _totalBytes += bytes.length;
      _cache[assetId] = bytes;
      return bytes;
    } on GenerationServiceException {
      rethrow;
    } catch (_) {
      throw const GenerationServiceException(
        GenerationFailureReason.missingImage,
      );
    }
  }
}

class _PreparedVibes {
  final List<String> images;
  final List<double> strengths;
  final List<double> informationExtracted;

  const _PreparedVibes(this.images, this.strengths, this.informationExtracted);

  const _PreparedVibes.empty() : this(const [], const [], const []);
}

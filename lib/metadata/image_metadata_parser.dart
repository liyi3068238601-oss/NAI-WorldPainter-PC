import 'dart:convert';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:archive/archive.dart';

import '../generation/generation_parameters.dart';

const _knownModels = {
  'nai-diffusion-3',
  'nai-diffusion-3-furry',
  'nai-diffusion-4-full',
  'nai-diffusion-4-5-full',
  'nai-diffusion-4-5-curated',
  'nai-diffusion-5-full',
  'nai-diffusion-5-curated',
};

/// A safe, allow-listed projection of image metadata into generation fields.
///
/// Missing or invalid source values are omitted from [fields]. Callers can
/// offer these fields for review, then use [applyTo] to merge only explicitly
/// selected values into a draft.
class ImageMetadataResult {
  ImageMetadataResult({
    Map<String, dynamic> fields = const {},
    List<String> warnings = const [],
    this.format = 'unknown',
    this.source,
    bool? recognized,
  }) : fields = Map.unmodifiable(fields),
       warnings = List.unmodifiable(warnings),
       recognized = recognized ?? fields.isNotEmpty;

  /// Valid metadata fields using [GenerationParameters.toJson] keys.
  final Map<String, dynamic> fields;

  /// Non-sensitive diagnostics. Raw metadata values are never included.
  final List<String> warnings;

  /// Container format, currently `png` or `unknown`.
  final String format;

  /// Carrier used for the winning metadata, such as `png-text`,
  /// `stealth-alpha`, or `stealth-rgb`.
  final String? source;

  /// True when usable generation fields were found.
  final bool recognized;

  /// Returns a copy of [current] patched with selected, present, valid fields.
  ///
  /// This method deliberately does not infer missing values or resolve asset
  /// identifiers. Embedded Vibe encodings can be applied without an asset ID.
  GenerationParameters applyTo(
    GenerationParameters current, {
    required Set<String> selectedFields,
  }) {
    bool selected(String key) =>
        selectedFields.contains(key) && fields.containsKey(key);
    String? textField(
      String key, {
      int maxLength = _MetadataLimits.maxMetadataBytes,
    }) {
      if (!selected(key)) return null;
      final value = fields[key];
      if (value is! String || value.length > maxLength) return null;
      return value;
    }

    int? integerField(String key, {required int min, required int max}) {
      if (!selected(key)) return null;
      return _exactInt(fields[key], min: min, max: max);
    }

    double? decimalField(
      String key, {
      required double min,
      required double max,
    }) {
      if (!selected(key)) return null;
      final value = _finiteDouble(fields[key]);
      if (value == null || value < min || value > max) return null;
      return value;
    }

    String? shortTextField(String key) {
      final value = textField(key, maxLength: 128);
      if (value == null || value.trim().isEmpty) return null;
      return value.trim();
    }

    String? model;
    if (selected('model')) {
      final candidate = fields['model'];
      if (candidate is String && _knownModels.contains(candidate)) {
        model = candidate;
      }
    }
    final width = integerField('width', min: 64, max: 4096);
    final height = integerField('height', min: 64, max: 4096);
    final candidateWidth = width != null && width % 64 == 0
        ? width
        : current.width;
    final candidateHeight = height != null && height % 64 == 0
        ? height
        : current.height;
    final dimensionsFit = candidateWidth * candidateHeight <= 4096 * 4096;
    final characters = selected('characters')
        ? _charactersForApply(fields['characters'])
        : null;
    final vibes = selected('vibe_references')
        ? _vibesForApply(fields['vibe_references'])
        : null;

    return current.copyWith(
      model: model,
      prompt: textField('prompt'),
      negativePrompt: textField('negative_prompt'),
      width: dimensionsFit && width != null && width % 64 == 0 ? width : null,
      height: dimensionsFit && height != null && height % 64 == 0
          ? height
          : null,
      steps: integerField('steps', min: 1, max: 50),
      scale: decimalField('scale', min: 1, max: 10),
      cfgRescale: decimalField('cfg_rescale', min: 0, max: 1),
      sampler: shortTextField('sampler'),
      noiseSchedule: shortTextField('noise_schedule'),
      seed: integerField('seed', min: 0, max: _MetadataLimits.maxSeed),
      useCoords: selected('use_coords') && fields['use_coords'] is bool
          ? fields['use_coords'] as bool
          : null,
      characters: characters,
      vibeReferences: vibes,
    );
  }
}

int? _exactInt(Object? value, {required int min, required int max}) {
  if (value is int) return value >= min && value <= max ? value : null;
  if (value is num &&
      value.isFinite &&
      value >= min &&
      value <= max &&
      value == value.roundToDouble()) {
    return value.toInt();
  }
  return null;
}

double? _finiteDouble(Object? value) {
  if (value is! num || !value.isFinite) return null;
  return value.toDouble();
}

Map<String, dynamic>? _stringKeyedMap(Object? value) {
  if (value is! Map) return null;
  final result = <String, dynamic>{};
  for (final entry in value.entries) {
    if (entry.key is! String) return null;
    result[entry.key as String] = entry.value;
  }
  return result;
}

List<GenerationCharacter>? _charactersForApply(Object? value) {
  if (value is! List || value.length > _MetadataLimits.maxCharacters) {
    return null;
  }
  final result = <GenerationCharacter>[];
  for (final raw in value) {
    final item = _stringKeyedMap(raw);
    if (item == null) return null;
    final prompt = item['prompt'];
    final negative = item['negative_prompt'];
    if (prompt is! String ||
        prompt.length > _MetadataLimits.maxMetadataBytes ||
        (negative != null &&
            (negative is! String ||
                negative.length > _MetadataLimits.maxMetadataBytes))) {
      return null;
    }

    final x = item['center_x'];
    final y = item['center_y'];
    final centerX = _finiteDouble(x);
    final centerY = _finiteDouble(y);
    final bothAbsentOrNull = x == null && y == null;
    final bothValid =
        centerX != null &&
        centerY != null &&
        centerX >= 0 &&
        centerX <= 1 &&
        centerY >= 0 &&
        centerY <= 1;
    if (!bothAbsentOrNull && !bothValid) return null;

    final enabled = item['enabled'];
    if (item.containsKey('enabled') && enabled is! bool) return null;
    final references = item['reference_images'];
    if (item.containsKey('reference_images') &&
        (references is! List || references.isNotEmpty)) {
      return null;
    }
    result.add(
      GenerationCharacter(
        prompt: prompt,
        negativePrompt: negative as String?,
        centerX: bothValid ? centerX : null,
        centerY: bothValid ? centerY : null,
        enabled: enabled as bool? ?? true,
      ),
    );
  }
  return List.unmodifiable(result);
}

List<VibeReference>? _vibesForApply(Object? value) {
  if (value is! List || value.length > _MetadataLimits.maxVibeReferences) {
    return null;
  }
  final result = <VibeReference>[];
  for (final raw in value) {
    final item = _stringKeyedMap(raw);
    if (item == null || item['asset_id'] != '') return null;
    if (item['encoded_vibe_scope'] != null) return null;
    final encoded = item['encoded_vibe'];
    final strength = _finiteDouble(item['strength']);
    final information = _finiteDouble(item['information_extracted']);
    if (encoded is! String ||
        encoded.trim().isEmpty ||
        encoded.length > _MetadataLimits.maxMetadataBytes ||
        strength == null ||
        strength < 0 ||
        strength > 1 ||
        information == null ||
        information < 0 ||
        information > 1) {
      return null;
    }
    result.add(
      VibeReference(
        assetId: '',
        strength: strength,
        informationExtracted: information,
        encodedVibe: encoded,
      ),
    );
  }
  return List.unmodifiable(result);
}

/// Extracts generation parameters from PNG text chunks or NovelAI stealth LSB.
///
/// Parsing is bounded and never performs filesystem, URL, or asset resolution.
/// RGB stealth extraction is attempted only for fully opaque images because
/// Flutter's RGBA pixels may have lost RGB low bits during alpha premultiplying.
Future<ImageMetadataResult> parseImageMetadata(Uint8List bytes) async {
  final warnings = <String>[];
  if (bytes.length > _MetadataLimits.maxInputBytes) {
    return ImageMetadataResult(warnings: const ['图片元数据超出读取大小限制。']);
  }

  final png = _readPngText(bytes, warnings);
  if (!png.isPng) {
    return ImageMetadataResult(warnings: List.unmodifiable(warnings));
  }

  if (!png.integrityValid) {
    return ImageMetadataResult(
      warnings: List.unmodifiable(warnings),
      format: 'png',
    );
  }

  final textFields = _fieldsFromText(png.textChunks, warnings);
  if (textFields.isNotEmpty) {
    return ImageMetadataResult(
      fields: textFields,
      warnings: List.unmodifiable(warnings),
      format: 'png',
      source: 'png-text',
      recognized: true,
    );
  }

  if (png.width == null ||
      png.height == null ||
      png.width! <= 0 ||
      png.height! <= 0 ||
      _exceedsPixelLimit(png.width!, png.height!)) {
    if (png.width != null &&
        png.height != null &&
        _exceedsPixelLimit(png.width!, png.height!)) {
      warnings.add('PNG 图片尺寸超出隐写解析限制。');
    }
    return ImageMetadataResult(
      warnings: List.unmodifiable(warnings),
      format: 'png',
    );
  }

  try {
    final codec = await ui.instantiateImageCodec(bytes);
    try {
      final frame = await codec.getNextFrame();
      try {
        final image = frame.image;
        final pixelCount = image.width * image.height;
        if (image.width != png.width ||
            image.height != png.height ||
            pixelCount > _MetadataLimits.maxDecodePixels) {
          warnings.add('PNG 解码尺寸与文件头不一致。');
          return ImageMetadataResult(
            warnings: List.unmodifiable(warnings),
            format: 'png',
          );
        }
        final raw = await image.toByteData(format: ui.ImageByteFormat.rawRgba);
        if (raw == null || raw.lengthInBytes != pixelCount * 4) {
          warnings.add('无法读取 PNG 像素数据。');
          return ImageMetadataResult(
            warnings: List.unmodifiable(warnings),
            format: 'png',
          );
        }
        final rgba = Uint8List.view(
          raw.buffer,
          raw.offsetInBytes,
          raw.lengthInBytes,
        );
        final opaqueRgb = _hasOpaqueAlpha(rgba);
        for (final channel in _StealthChannel.values) {
          if (channel == _StealthChannel.rgb && !opaqueRgb) {
            warnings.add('PNG 含透明像素，已跳过无法可靠读取的 RGB 隐写回退。');
            continue;
          }
          try {
            final payload = _readStealthPayload(
              rgba,
              image.width,
              image.height,
              channel,
            );
            if (payload == null) continue;
            final decoded = _decodeStealthJson(payload);
            if (decoded == null) {
              warnings.add('NovelAI 隐写元数据不是有效的 JSON 对象。');
              continue;
            }
            final fields = _fieldsFromJson(decoded, warnings);
            if (fields.isNotEmpty) {
              return ImageMetadataResult(
                fields: fields,
                warnings: List.unmodifiable(warnings),
                format: 'png',
                source: channel == _StealthChannel.alpha
                    ? 'stealth-alpha'
                    : 'stealth-rgb',
                recognized: true,
              );
            }
          } on FormatException {
            warnings.add('NovelAI 隐写元数据长度或编码无效。');
          } catch (_) {
            warnings.add('无法解码 NovelAI 隐写元数据。');
          }
        }
      } finally {
        frame.image.dispose();
      }
    } finally {
      codec.dispose();
    }
  } catch (_) {
    warnings.add('无法解码 PNG 像素以读取隐写元数据。');
  }

  return ImageMetadataResult(
    warnings: List.unmodifiable(warnings),
    format: 'png',
  );
}

class _MetadataLimits {
  static const maxInputBytes = 64 * 1024 * 1024;
  static const maxChunkCount = 4096;
  static const maxMetadataBytes = 4 * 1024 * 1024;
  static const maxDecodePixels = 16 * 1024 * 1024;
  static const maxJsonDepth = 64;
  static const maxCharacters = 6;
  static const maxVibeReferences = 4;
  static const maxSeed = 0xffffffff;
}

class _PngTextRead {
  const _PngTextRead({
    required this.isPng,
    required this.integrityValid,
    required this.textChunks,
    this.width,
    this.height,
  });

  final bool isPng;
  final bool integrityValid;
  final int? width;
  final int? height;
  final Map<String, String> textChunks;
}

const _pngSignature = <int>[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

_PngTextRead _readPngText(Uint8List bytes, List<String> warnings) {
  if (bytes.length < _pngSignature.length ||
      !_matches(bytes, 0, _pngSignature)) {
    return const _PngTextRead(
      isPng: false,
      integrityValid: false,
      textChunks: {},
    );
  }

  final view = ByteData.sublistView(bytes);
  final chunks = <String, String>{};
  var offset = _pngSignature.length;
  var chunkCount = 0;
  var metadataBytes = 0;
  var integrityValid = true;
  var sawHeader = false;
  var sawEnd = false;
  int? width;
  int? height;

  while (offset < bytes.length) {
    if (++chunkCount > _MetadataLimits.maxChunkCount) {
      warnings.add('PNG 数据块数量过多。');
      integrityValid = false;
      break;
    }
    if (bytes.length - offset < 12) {
      warnings.add('PNG 数据块头不完整。');
      integrityValid = false;
      break;
    }
    final length = view.getUint32(offset, Endian.big);
    final typeOffset = offset + 4;
    final dataStart = offset + 8;
    if (length > bytes.length - dataStart - 4) {
      warnings.add('PNG 数据块长度超出文件范围。');
      integrityValid = false;
      break;
    }
    final dataEnd = dataStart + length;
    final next = dataEnd + 4;
    final type = latin1.decode(
      Uint8List.sublistView(bytes, typeOffset, typeOffset + 4),
    );
    final actualCrc = getCrc32(
      Uint8List.view(
        bytes.buffer,
        bytes.offsetInBytes + typeOffset,
        length + 4,
      ),
    );
    final expectedCrc = view.getUint32(dataEnd, Endian.big);
    final crcValid = actualCrc == expectedCrc;
    if (!crcValid) {
      warnings.add('PNG $type 数据块的 CRC 校验失败。');
      integrityValid = false;
    }

    final data = Uint8List.sublistView(bytes, dataStart, dataEnd);
    if (type == 'IHDR') {
      if (sawHeader || length != 13 || offset != _pngSignature.length) {
        warnings.add('PNG 文件头无效。');
        integrityValid = false;
      } else if (crcValid) {
        width = view.getUint32(dataStart, Endian.big);
        height = view.getUint32(dataStart + 4, Endian.big);
        sawHeader = true;
      }
    } else if (!sawHeader) {
      warnings.add('PNG 元数据出现在文件头之前。');
      integrityValid = false;
    } else if (crcValid &&
        (type == 'tEXt' || type == 'iTXt' || type == 'zTXt')) {
      if (length > _MetadataLimits.maxMetadataBytes ||
          metadataBytes + length > _MetadataLimits.maxMetadataBytes) {
        warnings.add('PNG 文本元数据超出大小限制。');
      } else {
        metadataBytes += length;
        try {
          final entry = switch (type) {
            'tEXt' => _parseTextChunk(data),
            'iTXt' => _parseInternationalTextChunk(data),
            'zTXt' => _parseCompressedTextChunk(data),
            _ => null,
          };
          if (entry != null) chunks[entry.key] = entry.value;
        } on FormatException {
          warnings.add('PNG $type 文本元数据格式无效或超出解压限制。');
        } catch (_) {
          warnings.add('无法解码 PNG $type 文本元数据。');
        }
      }
    }

    if (type == 'IEND') {
      if (length != 0) {
        warnings.add('PNG 结束数据块无效。');
        integrityValid = false;
      }
      sawEnd = true;
      break;
    }
    offset = next;
  }

  if (!sawHeader || !sawEnd) {
    warnings.add('PNG 结构不完整。');
    integrityValid = false;
  }
  return _PngTextRead(
    isPng: true,
    integrityValid: integrityValid,
    textChunks: Map.unmodifiable(chunks),
    width: width,
    height: height,
  );
}

bool _matches(List<int> bytes, int offset, List<int> expected) {
  for (var i = 0; i < expected.length; i++) {
    if (bytes[offset + i] != expected[i]) return false;
  }
  return true;
}

bool _exceedsPixelLimit(int width, int height) =>
    width <= 0 ||
    height <= 0 ||
    width > _MetadataLimits.maxDecodePixels ~/ height;

bool _hasOpaqueAlpha(Uint8List rgba) {
  for (var offset = 3; offset < rgba.length; offset += 4) {
    if (rgba[offset] != 0xff) return false;
  }
  return true;
}

MapEntry<String, String>? _parseTextChunk(Uint8List data) {
  final separator = data.indexOf(0);
  final keyword = _readKeyword(data, separator);
  if (keyword == null) throw const FormatException('invalid keyword');
  final value = latin1.decode(Uint8List.sublistView(data, separator + 1));
  return MapEntry(keyword, value);
}

MapEntry<String, String>? _parseCompressedTextChunk(Uint8List data) {
  final separator = data.indexOf(0);
  final keyword = _readKeyword(data, separator);
  if (keyword == null || separator + 2 > data.length) {
    throw const FormatException('invalid compressed text header');
  }
  if (data[separator + 1] != 0) {
    throw const FormatException('unsupported compression method');
  }
  final decoded = _decodeZlibBounded(
    Uint8List.sublistView(data, separator + 2),
  );
  return MapEntry(keyword, latin1.decode(decoded));
}

MapEntry<String, String>? _parseInternationalTextChunk(Uint8List data) {
  final keywordEnd = data.indexOf(0);
  final keyword = _readKeyword(data, keywordEnd);
  if (keyword == null || keywordEnd + 3 > data.length) {
    throw const FormatException('invalid international text header');
  }
  final compressed = data[keywordEnd + 1];
  final method = data[keywordEnd + 2];
  if ((compressed != 0 && compressed != 1) || method != 0) {
    throw const FormatException('unsupported international text compression');
  }
  final languageEnd = data.indexOf(0, keywordEnd + 3);
  if (languageEnd < 0) {
    throw const FormatException('missing language separator');
  }
  final translatedEnd = data.indexOf(0, languageEnd + 1);
  if (translatedEnd < 0) {
    throw const FormatException('missing translated keyword separator');
  }
  final textStart = translatedEnd + 1;
  final text = Uint8List.sublistView(data, textStart);
  final decoded = compressed == 1 ? _decodeZlibBounded(text) : text;
  return MapEntry(keyword, utf8.decode(decoded));
}

String? _readKeyword(Uint8List data, int separator) {
  if (separator < 1 || separator > 79) return null;
  final keywordBytes = Uint8List.sublistView(data, 0, separator);
  if (keywordBytes.first == 0x20 || keywordBytes.last == 0x20) return null;
  if (keywordBytes.any((byte) => byte < 0x20 || byte == 0x7f)) return null;
  return latin1.decode(keywordBytes);
}

Uint8List _decodeZlibBounded(List<int> compressed) {
  final input = InputMemoryStream(compressed);
  final output = OutputMemoryStream();
  final complete = ZLibDecoder().decodeStream(
    input,
    output,
    verify: true,
    maxOutputSize: _MetadataLimits.maxMetadataBytes,
  );
  if (!complete || !input.isEOS) {
    throw const FormatException('compressed text is truncated');
  }
  return output.getBytes();
}

Uint8List _decodeGzipBounded(List<int> compressed) {
  final input = InputMemoryStream(compressed);
  final output = OutputMemoryStream();
  final complete = GZipDecoder().decodeStream(
    input,
    output,
    verify: true,
    maxOutputSize: _MetadataLimits.maxMetadataBytes,
  );
  if (!complete || !input.isEOS) {
    throw const FormatException('gzip payload is truncated');
  }
  return output.getBytes();
}

Map<String, dynamic> _fieldsFromText(
  Map<String, String> chunks,
  List<String> warnings,
) {
  final raw = <String, dynamic>{...chunks};
  final scopes = _parameterScopes(raw, warnings);
  return _fieldsFromSources(raw, scopes, warnings);
}

Map<String, dynamic> _fieldsFromJson(
  Map<String, dynamic> json,
  List<String> warnings,
) {
  final scopes = _parameterScopes(json, warnings);
  return _fieldsFromSources(json, scopes, warnings);
}

List<Map<String, dynamic>> _parameterScopes(
  Map<String, dynamic> root,
  List<String> warnings,
) {
  final scopes = <Map<String, dynamic>>[];
  void addScope(Object? value, {bool descendComment = true}) {
    Map<String, dynamic>? current = _asMap(value, warnings);
    var depth = 0;
    while (current != null && depth++ < 5) {
      if (!scopes.any((scope) => identical(scope, current))) {
        scopes.add(current);
      }
      if (!descendComment || !current.containsKey('Comment')) break;
      final nested = current['Comment'];
      final nestedMap = _asMap(nested, warnings);
      if (nestedMap == null || identical(nestedMap, current)) break;
      current = nestedMap;
    }
  }

  // NovelAI's nested Comment is the most specific source. Other well-known
  // containers follow, then the top-level JSON fields.
  final commentEntry = _entryIgnoringCase(root, 'comment');
  if (commentEntry != null) addScope(commentEntry.value);
  for (final key in const ['parameters', 'metadata', 'json']) {
    final entry = _entryIgnoringCase(root, key);
    if (entry != null) addScope(entry.value);
  }
  // Some PNG writers put a complete JSON object in Description.
  final description = _entryIgnoringCase(root, 'description')?.value;
  if (description is String) {
    final parsed = _tryJsonMap(description, warnings);
    if (parsed != null) addScope(parsed);
  }
  scopes.add(root);
  return scopes;
}

MapEntry<String, dynamic>? _entryIgnoringCase(
  Map<String, dynamic> source,
  String key,
) {
  for (final entry in source.entries) {
    if (entry.key.toLowerCase() == key) return entry;
  }
  return null;
}

Map<String, dynamic>? _asMap(Object? value, List<String> warnings) {
  if (value is Map) return Map<String, dynamic>.from(value);
  if (value is String) return _tryJsonMap(value, warnings);
  return null;
}

Map<String, dynamic>? _tryJsonMap(String text, List<String> warnings) {
  if (text.length > _MetadataLimits.maxMetadataBytes ||
      !_hasBoundedJsonDepth(text)) {
    warnings.add('JSON 元数据超出大小或嵌套层数限制。');
    return null;
  }
  try {
    final decoded = jsonDecode(text);
    return decoded is Map ? Map<String, dynamic>.from(decoded) : null;
  } catch (_) {
    return null;
  }
}

bool _hasBoundedJsonDepth(String text) {
  var inString = false;
  var escaped = false;
  var depth = 0;
  for (final unit in text.codeUnits) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (unit == 0x5c) {
        escaped = true;
      } else if (unit == 0x22) {
        inString = false;
      }
      continue;
    }
    if (unit == 0x22) {
      inString = true;
    } else if (unit == 0x7b || unit == 0x5b) {
      if (++depth > _MetadataLimits.maxJsonDepth) return false;
    } else if (unit == 0x7d || unit == 0x5d) {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth == 0;
}

Object? _findValue(List<Map<String, dynamic>> scopes, List<String> keys) {
  for (final scope in scopes) {
    for (final key in keys) {
      if (scope.containsKey(key) && scope[key] != null) return scope[key];
    }
  }
  return null;
}

Map<String, dynamic> _fieldsFromSources(
  Map<String, dynamic> root,
  List<Map<String, dynamic>> scopes,
  List<String> warnings,
) {
  final fields = <String, dynamic>{};

  final prompt = _stringValue(
    _findValue(scopes, const ['prompt', 'positive_prompt', 'positivePrompt']),
  );
  if (prompt != null) {
    fields['prompt'] = prompt;
  } else {
    final v4Prompt = _v4Caption(scopes, 'v4_prompt');
    if (v4Prompt != null) {
      fields['prompt'] = v4Prompt;
    } else if (_entryIgnoringCase(root, 'description')?.value is String &&
        _tryJsonMap(
              _entryIgnoringCase(root, 'description')!.value as String,
              <String>[],
            ) ==
            null) {
      fields['prompt'] =
          _entryIgnoringCase(root, 'description')!.value as String;
    }
  }

  final negative = _stringValue(
    _findValue(scopes, const ['uc', 'negative_prompt', 'negativePrompt']),
  );
  if (negative != null) {
    fields['negative_prompt'] = negative;
  } else {
    final v4Negative = _v4Caption(scopes, 'v4_negative_prompt');
    if (v4Negative != null) fields['negative_prompt'] = v4Negative;
  }

  _addModel(scopes, fields, warnings);
  _addIntField(
    scopes,
    fields,
    warnings,
    'width',
    const ['width'],
    min: 64,
    max: 4096,
  );
  _addIntField(
    scopes,
    fields,
    warnings,
    'height',
    const ['height'],
    min: 64,
    max: 4096,
  );
  final width = fields['width'];
  final height = fields['height'];
  if ((width is int && width % 64 != 0) ||
      (height is int && height % 64 != 0) ||
      (width is int && height is int && width * height > 4096 * 4096)) {
    fields.remove('width');
    fields.remove('height');
    warnings.add('图片生成尺寸超出支持范围。');
  }
  _addIntField(
    scopes,
    fields,
    warnings,
    'steps',
    const ['steps'],
    min: 1,
    max: 50,
  );
  _addDoubleField(
    scopes,
    fields,
    warnings,
    'scale',
    const ['scale', 'guidanceScale'],
    min: 1,
    max: 10,
  );
  _addDoubleField(
    scopes,
    fields,
    warnings,
    'cfg_rescale',
    const ['cfg_rescale', 'cfgRescale', 'promptGuidanceRescale'],
    min: 0,
    max: 1,
  );
  _addStringField(scopes, fields, warnings, 'sampler', const ['sampler']);
  _addStringField(scopes, fields, warnings, 'noise_schedule', const [
    'noise_schedule',
    'noiseSchedule',
  ]);
  _addIntField(
    scopes,
    fields,
    warnings,
    'seed',
    const ['seed'],
    min: 0,
    max: _MetadataLimits.maxSeed,
  );
  _addBoolField(scopes, fields, warnings, 'use_coords', const [
    'use_coords',
    'useCoords',
  ]);

  final characterCollection = _readCharacters(scopes, warnings);
  if (characterCollection.present && characterCollection.valid) {
    fields['characters'] = characterCollection.value;
  }
  final vibeCollection = _readVibeReferences(scopes, warnings);
  if (vibeCollection.present && vibeCollection.valid) {
    fields['vibe_references'] = vibeCollection.value;
  }

  return fields;
}

String? _v4Caption(List<Map<String, dynamic>> scopes, String key) {
  final value = _findValue(scopes, [key]);
  if (value is! Map) return null;
  final caption = value['caption'];
  if (caption is! Map) return null;
  final base = caption['base_caption'];
  return base is String ? base : null;
}

void _addModel(
  List<Map<String, dynamic>> scopes,
  Map<String, dynamic> fields,
  List<String> warnings,
) {
  final value = _findValue(scopes, const ['model', 'model_name']);
  if (value == null) return;
  final model = _stringValue(value)?.trim();
  if (model == null || !_knownModels.contains(model)) {
    warnings.add('图片模型元数据不是受支持的 NovelAI 模型标识。');
    return;
  }
  fields['model'] = model;
}

String _fieldLabel(String key) => switch (key) {
  'width' => '宽度',
  'height' => '高度',
  'steps' => '步数',
  'scale' => '引导强度',
  'cfg_rescale' => 'CFG 重缩放',
  'sampler' => '采样器',
  'noise_schedule' => '噪声计划',
  'seed' => '随机种子',
  'use_coords' => '角色坐标开关',
  _ => key,
};

void _addStringField(
  List<Map<String, dynamic>> scopes,
  Map<String, dynamic> fields,
  List<String> warnings,
  String outputKey,
  List<String> aliases,
) {
  final raw = _findValue(scopes, aliases);
  if (raw == null) return;
  final value = _stringValue(raw);
  if (value == null || value.trim().isEmpty) {
    warnings.add('图片${_fieldLabel(outputKey)}元数据无效。');
    return;
  }
  fields[outputKey] = value.trim();
}

void _addIntField(
  List<Map<String, dynamic>> scopes,
  Map<String, dynamic> fields,
  List<String> warnings,
  String outputKey,
  List<String> aliases, {
  required int min,
  required int max,
}) {
  final raw = _findValue(scopes, aliases);
  if (raw == null) return;
  final value = _intValue(raw, min: min, max: max);
  if (value == null) {
    warnings.add('图片${_fieldLabel(outputKey)}元数据无效或超出支持范围。');
    return;
  }
  fields[outputKey] = value;
}

void _addDoubleField(
  List<Map<String, dynamic>> scopes,
  Map<String, dynamic> fields,
  List<String> warnings,
  String outputKey,
  List<String> aliases, {
  required double min,
  required double max,
}) {
  final raw = _findValue(scopes, aliases);
  if (raw == null) return;
  final value = _doubleValue(raw);
  if (value == null || value < min || value > max) {
    warnings.add('图片${_fieldLabel(outputKey)}元数据无效或超出支持范围。');
    return;
  }
  fields[outputKey] = value;
}

void _addBoolField(
  List<Map<String, dynamic>> scopes,
  Map<String, dynamic> fields,
  List<String> warnings,
  String outputKey,
  List<String> aliases,
) {
  final raw = _findValue(scopes, aliases);
  if (raw == null) return;
  if (raw is bool) {
    fields[outputKey] = raw;
  } else {
    warnings.add('图片${_fieldLabel(outputKey)}元数据无效。');
  }
}

class _CollectionResult<T> {
  const _CollectionResult(this.present, this.valid, this.value);
  final bool present;
  final bool valid;
  final T value;
}

_CollectionResult<List<Map<String, dynamic>>> _readCharacters(
  List<Map<String, dynamic>> scopes,
  List<String> warnings,
) {
  for (final scope in scopes) {
    final direct =
        scope['characters'] ??
        scope['characterTabs'] ??
        scope['characterPrompts'];
    if (direct is List) {
      return _parseCharacterArray(direct, warnings);
    }
    final v4 = scope['v4_prompt'];
    if (v4 is Map && v4['caption'] is Map) {
      final captions = (v4['caption'] as Map)['char_captions'];
      if (captions is List) {
        final v4Negative = scope['v4_negative_prompt'];
        final negatives = v4Negative is Map && v4Negative['caption'] is Map
            ? (v4Negative['caption'] as Map)['char_captions']
            : null;
        return _parseV4Characters(captions, negatives, warnings);
      }
    }
    final messages = scope['messages'];
    if (messages is List) {
      final parsed = _parseV3Messages(messages, warnings);
      if (parsed != null) return parsed;
    }
  }
  return const _CollectionResult(false, false, <Map<String, dynamic>>[]);
}

_CollectionResult<List<Map<String, dynamic>>> _parseCharacterArray(
  List items,
  List<String> warnings,
) {
  if (items.length > _MetadataLimits.maxCharacters) {
    warnings.add('角色提示词数量超出支持范围。');
    return const _CollectionResult(true, false, <Map<String, dynamic>>[]);
  }
  final result = <Map<String, dynamic>>[];
  for (final item in items) {
    if (item is! Map) {
      warnings.add('角色提示词中包含无效条目。');
      return const _CollectionResult(true, false, <Map<String, dynamic>>[]);
    }
    final prompt = item['prompt'] ?? item['char_caption'];
    if (prompt is! String) {
      warnings.add('角色正向提示词无效。');
      return const _CollectionResult(true, false, <Map<String, dynamic>>[]);
    }
    final center = item['center'];
    final centerXRaw = item['center_x'] ?? (center is Map ? center['x'] : null);
    final centerYRaw = item['center_y'] ?? (center is Map ? center['y'] : null);
    final centerX = _optionalUnit(centerXRaw);
    final centerY = _optionalUnit(centerYRaw);
    final hasCoordinates =
        item.containsKey('center_x') ||
        item.containsKey('center_y') ||
        center != null;
    if (hasCoordinates && (centerX == null || centerY == null)) {
      warnings.add('角色坐标必须是有效的一组数值。');
      return const _CollectionResult(true, false, <Map<String, dynamic>>[]);
    }
    final negative = item['negative_prompt'] ?? item['uc'];
    if (negative != null && negative is! String) {
      warnings.add('角色负向提示词无效。');
      return const _CollectionResult(true, false, <Map<String, dynamic>>[]);
    }
    if (item.containsKey('enabled') && item['enabled'] is! bool) {
      warnings.add('角色启用状态无效。');
      return const _CollectionResult(true, false, <Map<String, dynamic>>[]);
    }
    result.add({
      'prompt': prompt,
      if (negative is String) 'negative_prompt': negative,
      'center_x': centerX,
      'center_y': centerY,
      'enabled': item['enabled'] is bool ? item['enabled'] : true,
      'reference_images': const <Map<String, dynamic>>[],
    });
  }
  return _CollectionResult(true, true, result);
}

_CollectionResult<List<Map<String, dynamic>>> _parseV4Characters(
  List captions,
  Object? negativeCaptions,
  List<String> warnings,
) {
  if (captions.length > _MetadataLimits.maxCharacters ||
      (negativeCaptions != null && negativeCaptions is! List) ||
      (negativeCaptions is List && negativeCaptions.length > captions.length)) {
    warnings.add('V4 角色提示词结构或数量无效。');
    return const _CollectionResult(true, false, <Map<String, dynamic>>[]);
  }
  final result = <Map<String, dynamic>>[];
  for (var i = 0; i < captions.length; i++) {
    final entry = captions[i];
    if (entry is! Map || entry['char_caption'] is! String) {
      warnings.add('V4 角色正向提示词无效。');
      return const _CollectionResult(true, false, <Map<String, dynamic>>[]);
    }
    final negativeEntry =
        negativeCaptions is List && i < negativeCaptions.length
        ? negativeCaptions[i]
        : null;
    if (negativeEntry != null &&
        (negativeEntry is! Map || negativeEntry['char_caption'] is! String)) {
      warnings.add('V4 角色负向提示词无效。');
      return const _CollectionResult(true, false, <Map<String, dynamic>>[]);
    }
    final centers = entry['centers'];
    double? centerX;
    double? centerY;
    if (centers is List && centers.isNotEmpty) {
      if (centers.first is! Map) {
        warnings.add('V4 角色坐标无效。');
        return const _CollectionResult(true, false, <Map<String, dynamic>>[]);
      }
      centerX = _optionalUnit((centers.first as Map)['x']);
      centerY = _optionalUnit((centers.first as Map)['y']);
      if (centerX == null || centerY == null) {
        warnings.add('V4 角色坐标超出支持范围。');
        return const _CollectionResult(true, false, <Map<String, dynamic>>[]);
      }
    }
    result.add({
      'prompt': entry['char_caption'],
      if (negativeEntry is Map)
        'negative_prompt': negativeEntry['char_caption'],
      'center_x': centerX,
      'center_y': centerY,
      'enabled': true,
      'reference_images': const <Map<String, dynamic>>[],
    });
  }
  return _CollectionResult(true, true, result);
}

_CollectionResult<List<Map<String, dynamic>>>? _parseV3Messages(
  List messages,
  List<String> warnings,
) {
  for (final message in messages) {
    if (message is! Map || message['role'] != 'system') continue;
    final content = message['content'];
    if (content is! String || !content.startsWith('Characters:')) continue;
    final characters = _tryJsonArray(
      content.substring('Characters:'.length).trim(),
    );
    if (characters == null) {
      warnings.add('V3 角色提示词无效。');
      return const _CollectionResult(true, false, <Map<String, dynamic>>[]);
    }
    return _parseCharacterArray(characters, warnings);
  }
  return null;
}

List? _tryJsonArray(String text) {
  if (text.length > _MetadataLimits.maxMetadataBytes ||
      !_hasBoundedJsonDepth(text)) {
    return null;
  }
  try {
    final value = jsonDecode(text);
    return value is List ? value : null;
  } catch (_) {
    return null;
  }
}

double? _optionalUnit(Object? value) {
  if (value == null) return null;
  final parsed = _doubleValue(value);
  if (parsed == null || parsed < 0 || parsed > 1) return null;
  return parsed;
}

_CollectionResult<List<Map<String, dynamic>>> _readVibeReferences(
  List<Map<String, dynamic>> scopes,
  List<String> warnings,
) {
  for (final scope in scopes) {
    if (!scope.containsKey('reference_image_multiple')) continue;
    final encodings = scope['reference_image_multiple'];
    if (encodings is! List ||
        encodings.length > _MetadataLimits.maxVibeReferences) {
      warnings.add('Vibe 参考数量无效或超出支持范围。');
      return const _CollectionResult(true, false, <Map<String, dynamic>>[]);
    }
    final strengths = scope['reference_strength_multiple'];
    final information = scope['reference_information_extracted_multiple'];
    if (encodings.isNotEmpty && (strengths == null || information == null)) {
      warnings.add('Vibe 编码缺少强度或信息提取数据，已跳过这组参考。');
      return const _CollectionResult(true, false, <Map<String, dynamic>>[]);
    }
    if ((strengths != null &&
            (strengths is! List || strengths.length != encodings.length)) ||
        (information != null &&
            (information is! List || information.length != encodings.length))) {
      warnings.add('Vibe 强度信息与编码数量不一致。');
      return const _CollectionResult(true, false, <Map<String, dynamic>>[]);
    }
    final result = <Map<String, dynamic>>[];
    for (var i = 0; i < encodings.length; i++) {
      final encoding = encodings[i];
      final strength = strengths is List ? _doubleValue(strengths[i]) : null;
      final extracted = information is List
          ? _doubleValue(information[i])
          : null;
      if (encoding is! String ||
          encoding.trim().isEmpty ||
          encoding.length > _MetadataLimits.maxMetadataBytes ||
          strength == null ||
          strength < 0 ||
          strength > 1 ||
          extracted == null ||
          extracted < 0 ||
          extracted > 1) {
        warnings.add('Vibe 参考中包含无效条目。');
        return const _CollectionResult(true, false, <Map<String, dynamic>>[]);
      }
      result.add({
        'asset_id': '',
        'strength': strength,
        'information_extracted': extracted,
        'encoded_vibe': encoding,
      });
    }
    return _CollectionResult(true, true, result);
  }
  return const _CollectionResult(false, false, <Map<String, dynamic>>[]);
}

int? _intValue(Object? value, {required int min, required int max}) {
  if (value is int) return value >= min && value <= max ? value : null;
  if (value is num &&
      value.isFinite &&
      value >= min &&
      value <= max &&
      value == value.roundToDouble()) {
    return value.toInt();
  }
  if (value is String) {
    final parsed = int.tryParse(value);
    if (parsed != null && parsed >= min && parsed <= max) return parsed;
  }
  return null;
}

double? _doubleValue(Object? value) {
  final parsed = value is num
      ? value.toDouble()
      : double.tryParse(value is String ? value : '');
  return parsed != null && parsed.isFinite ? parsed : null;
}

String? _stringValue(Object? value) => value is String ? value : null;

Uint8List? _readStealthPayload(
  Uint8List rgba,
  int width,
  int height,
  _StealthChannel channel,
) {
  final channelCount = channel == _StealthChannel.alpha ? 1 : 3;
  final capacityBits = width * height * channelCount;
  if (capacityBits < 19 * 8) return null;

  var bitOffset = 0;
  int readByte() {
    var value = 0;
    for (var i = 0; i < 8; i++) {
      final pixelIndex = bitOffset ~/ channelCount;
      final component = bitOffset % channelCount;
      final x = pixelIndex ~/ height;
      final y = pixelIndex % height;
      final rgbaOffset = (y * width + x) * 4;
      final channelOffset = channel == _StealthChannel.alpha ? 3 : component;
      value = (value << 1) | (rgba[rgbaOffset + channelOffset] & 1);
      bitOffset++;
    }
    return value;
  }

  final magic = List<int>.generate(15, (_) => readByte(), growable: false);
  final alphaMagic = const <String>{'stealth_pngcomp', 'stealth_pnginfo'};
  final rgbMagic = const <String>{'stealth_rgbcomp', 'stealth_rgbinfo'};
  final magicText = latin1.decode(magic);
  if (!(channel == _StealthChannel.alpha
      ? alphaMagic.contains(magicText)
      : rgbMagic.contains(magicText))) {
    return null;
  }
  final bitLength =
      (readByte() << 24) | (readByte() << 16) | (readByte() << 8) | readByte();
  if (bitLength <= 0 ||
      bitLength % 8 != 0 ||
      bitLength ~/ 8 > _MetadataLimits.maxMetadataBytes ||
      bitOffset + bitLength > capacityBits) {
    throw const FormatException('NovelAI stealth metadata length is invalid.');
  }
  final bytes = Uint8List(bitLength ~/ 8);
  for (var i = 0; i < bytes.length; i++) {
    bytes[i] = readByte();
  }
  if (magicText.endsWith('comp')) return _decodeGzipBounded(bytes);
  if (bytes.length > _MetadataLimits.maxMetadataBytes) {
    throw const FormatException(
      'NovelAI stealth metadata exceeds the size limit.',
    );
  }
  return bytes;
}

Map<String, dynamic>? _decodeStealthJson(Uint8List bytes) {
  final text = utf8.decode(bytes);
  if (!_hasBoundedJsonDepth(text)) return null;
  try {
    final decoded = jsonDecode(text);
    if (decoded is! Map) return null;
    final result = Map<String, dynamic>.from(decoded);
    // Some NAI files encode Comment as a JSON string inside the outer object.
    if (result['Comment'] is String) {
      final nested = _tryJsonMap(result['Comment'] as String, <String>[]);
      if (nested != null) result['Comment'] = nested;
    }
    return result;
  } catch (_) {
    return null;
  }
}

enum _StealthChannel { alpha, rgb }

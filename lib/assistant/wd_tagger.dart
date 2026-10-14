import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import 'agent_contract.dart';

const String defaultWdTaggerBaseUrl = 'https://smilingwolf-wd-tagger.hf.space';
const String defaultWdTaggerModel = 'SmilingWolf/wd-swinv2-tagger-v3';

const int _maxUploadBytes = 10 * 1024 * 1024;
const int _maxResponseBytes = 1024 * 1024;
const int _maxCaptionBytes = 16 * 1024;
const int _maxTagCount = 1000;
const int _maxTagNameBytes = 256;
const int _maxUploadedPathBytes = 4096;
const int _maxEventIdLength = 256;

/// WD-Tagger models supported by the mobile client.
class WdTaggerSettings {
  const WdTaggerSettings({
    this.enabled = false,
    this.baseUrl = defaultWdTaggerBaseUrl,
    this.model = defaultWdTaggerModel,
    this.generalThreshold = 0.35,
    this.characterThreshold = 0.85,
    this.generalMcut = false,
    this.characterMcut = false,
  });

  static const Map<String, String> models = {
    'SmilingWolf/wd-swinv2-tagger-v3': 'SwinV2 v3',
    'SmilingWolf/wd-convnext-tagger-v3': 'ConvNext v3',
    'SmilingWolf/wd-vit-tagger-v3': 'ViT v3',
    'SmilingWolf/wd-v1-4-moat-tagger-v2': 'MOAT v2',
    'SmilingWolf/wd-v1-4-swinv2-tagger-v2': 'SwinV2 v2',
    'SmilingWolf/wd-v1-4-convnextv2-tagger-v2': 'ConvNextV2 v2',
  };

  final bool enabled;
  final String baseUrl;
  final String model;
  final double generalThreshold;
  final double characterThreshold;
  final bool generalMcut;
  final bool characterMcut;

  /// Validates the model, thresholds, and network root without making a request.
  void validate() {
    if (!models.containsKey(model)) {
      throw const AgentException('WD-Tagger 模型无效。');
    }
    normalizeWdTaggerBaseUrl(baseUrl);
    if (!_isThreshold(generalThreshold) || !_isThreshold(characterThreshold)) {
      throw const AgentException('WD-Tagger 阈值须为 0 到 1 之间的有限数值。');
    }
  }

  WdTaggerSettings copyWith({
    bool? enabled,
    String? baseUrl,
    String? model,
    double? generalThreshold,
    double? characterThreshold,
    bool? generalMcut,
    bool? characterMcut,
  }) => WdTaggerSettings(
    enabled: enabled ?? this.enabled,
    baseUrl: baseUrl ?? this.baseUrl,
    model: model ?? this.model,
    generalThreshold: generalThreshold ?? this.generalThreshold,
    characterThreshold: characterThreshold ?? this.characterThreshold,
    generalMcut: generalMcut ?? this.generalMcut,
    characterMcut: characterMcut ?? this.characterMcut,
  );

  Map<String, Object?> toJson() => {
    'schema': 1,
    'enabled': enabled,
    'baseUrl': baseUrl,
    'model': model,
    'generalThreshold': generalThreshold,
    'characterThreshold': characterThreshold,
    'generalMcut': generalMcut,
    'characterMcut': characterMcut,
  };

  factory WdTaggerSettings.fromJson(Map<String, Object?> json) {
    const fields = {
      'schema',
      'enabled',
      'baseUrl',
      'model',
      'generalThreshold',
      'characterThreshold',
      'generalMcut',
      'characterMcut',
    };
    if (json.keys.any((key) => !fields.contains(key))) {
      throw const FormatException('WD-Tagger 设置包含未知字段。');
    }
    if (json.length != fields.length ||
        json['schema'] is! int ||
        json['schema'] != 1) {
      throw const FormatException('WD-Tagger 设置版本无效或字段不完整。');
    }

    final settings = WdTaggerSettings(
      enabled: _readBool(json, 'enabled', false),
      baseUrl: _readString(json, 'baseUrl', defaultWdTaggerBaseUrl),
      model: _readString(json, 'model', defaultWdTaggerModel),
      generalThreshold: _readDouble(json, 'generalThreshold', 0.35),
      characterThreshold: _readDouble(json, 'characterThreshold', 0.85),
      generalMcut: _readBool(json, 'generalMcut', false),
      characterMcut: _readBool(json, 'characterMcut', false),
    );
    settings.validate();
    return settings;
  }
}

class WdTaggerResult {
  WdTaggerResult({
    required this.caption,
    required Map<String, double> generalTags,
    required Map<String, double> characterTags,
    required Map<String, double> ratingTags,
  }) : generalTags = Map.unmodifiable(generalTags),
       characterTags = Map.unmodifiable(characterTags),
       ratingTags = Map.unmodifiable(ratingTags);

  final String caption;
  final Map<String, double> generalTags;
  final Map<String, double> characterTags;
  final Map<String, double> ratingTags;

  Map<String, Object?> toJson() => {
    'caption': caption,
    'generalTags': generalTags,
    'characterTags': characterTags,
    'ratingTags': ratingTags,
  };
}

/// HTTP client for the public Gradio WD-Tagger Space.
///
/// Each analysis owns one client for the complete upload, submit, and SSE
/// sequence. It sends no credentials, follows no redirects, and never retries.
class WdTaggerClient {
  WdTaggerClient({
    http.Client Function()? clientFactory,
    this.timeout = const Duration(seconds: 120),
  }) : clientFactory = clientFactory ?? http.Client.new {
    if (timeout <= Duration.zero) {
      throw ArgumentError.value(timeout, 'timeout', 'Must be positive.');
    }
  }

  final http.Client Function() clientFactory;
  final Duration timeout;

  Future<WdTaggerResult> analyze({
    required Uint8List bytes,
    required WdTaggerSettings settings,
    required AgentCancellation cancellation,
  }) async {
    cancellation.check();
    settings.validate();
    if (!settings.enabled) {
      throw const AgentException('WD-Tagger 当前已禁用。');
    }
    _validatePngBytes(bytes);

    final baseUrl = normalizeWdTaggerBaseUrl(settings.baseUrl);
    return _withClient<WdTaggerResult>(cancellation, (client, lifeToken) async {
      lifeToken.check();
      final uploadedPath = await _upload(
        client: client,
        baseUrl: baseUrl,
        bytes: bytes,
        cancellation: lifeToken,
      );
      lifeToken.check();
      final eventId = await _submit(
        client: client,
        baseUrl: baseUrl,
        uploadedPath: uploadedPath,
        settings: settings,
        cancellation: lifeToken,
      );
      lifeToken.check();
      final sseBody = await _fetchResult(
        client: client,
        baseUrl: baseUrl,
        eventId: eventId,
        cancellation: lifeToken,
      );
      lifeToken.check();
      return _parseSseResult(sseBody);
    });
  }

  Future<String> _upload({
    required http.Client client,
    required String baseUrl,
    required Uint8List bytes,
    required AgentCancellation cancellation,
  }) async {
    cancellation.check();
    final request =
        http.MultipartRequest('POST', _endpoint(baseUrl, '/gradio_api/upload'))
          ..followRedirects = false
          ..maxRedirects = 0
          ..headers['accept'] = 'application/json'
          ..files.add(
            http.MultipartFile.fromBytes(
              'files',
              bytes,
              filename: 'image.png',
              contentType: http.MediaType('image', 'png'),
            ),
          );

    final response = await client.send(request);
    cancellation.check();
    _checkStatus(response.statusCode, '上传');
    final body = await _readBoundedResponse(response);
    cancellation.check();
    final decoded = _decodeJson(body, '上传');
    if (decoded is! List || decoded.length != 1) {
      throw const AgentException('WD-Tagger 上传响应格式无法识别。');
    }
    final path = decoded.single;
    if (path is! String ||
        path.isEmpty ||
        utf8.encode(path).length > _maxUploadedPathBytes ||
        path.contains(RegExp(r'[\x00-\x1f\x7f]')) ||
        path.contains('?') ||
        path.contains('#')) {
      throw const AgentException('WD-Tagger 上传路径无效。');
    }
    return path;
  }

  Future<String> _submit({
    required http.Client client,
    required String baseUrl,
    required String uploadedPath,
    required WdTaggerSettings settings,
    required AgentCancellation cancellation,
  }) async {
    cancellation.check();
    final fileUrl = _endpoint(baseUrl, '/gradio_api/file=$uploadedPath');
    final request =
        http.Request('POST', _endpoint(baseUrl, '/gradio_api/call/predict'))
          ..followRedirects = false
          ..maxRedirects = 0
          ..headers['accept'] = 'application/json'
          ..headers['content-type'] = 'application/json; charset=utf-8'
          ..body = jsonEncode({
            'data': [
              {
                'path': uploadedPath,
                'url': fileUrl.toString(),
                'orig_name': 'image.png',
                'mime_type': 'image/png',
                'meta': {'_type': 'gradio.FileData'},
              },
              settings.model,
              settings.generalThreshold,
              settings.generalMcut,
              settings.characterThreshold,
              settings.characterMcut,
            ],
          });

    final response = await client.send(request);
    cancellation.check();
    _checkStatus(response.statusCode, '提交');
    final body = await _readBoundedResponse(response);
    cancellation.check();
    final decoded = _decodeJson(body, '提交');
    if (decoded is! Map ||
        decoded.keys.toSet().difference({'event_id'}).isNotEmpty) {
      throw const AgentException('WD-Tagger 提交响应格式无法识别。');
    }
    final eventId = decoded['event_id'];
    if (eventId is! String ||
        eventId.isEmpty ||
        eventId.length > _maxEventIdLength ||
        !RegExp(r'^[A-Za-z0-9._-]+$').hasMatch(eventId)) {
      throw const AgentException('WD-Tagger 任务编号无效。');
    }
    return eventId;
  }

  Future<List<int>> _fetchResult({
    required http.Client client,
    required String baseUrl,
    required String eventId,
    required AgentCancellation cancellation,
  }) async {
    cancellation.check();
    final request =
        http.Request(
            'GET',
            _endpoint(baseUrl, '/gradio_api/call/predict/$eventId'),
          )
          ..followRedirects = false
          ..maxRedirects = 0
          ..headers['accept'] = 'text/event-stream';
    final response = await client.send(request);
    cancellation.check();
    _checkStatus(response.statusCode, '读取结果');
    final contentType = _headerValue(response.headers, 'content-type');
    if (contentType == null ||
        !contentType.toLowerCase().startsWith('text/event-stream')) {
      throw const AgentException('WD-Tagger 返回了无效的事件流。');
    }
    final body = await _readBoundedResponse(response);
    cancellation.check();
    return body;
  }

  Future<T> _withClient<T>(
    AgentCancellation cancellation,
    Future<T> Function(http.Client client, AgentCancellation lifeToken)
    operation,
  ) async {
    cancellation.check();
    final http.Client client;
    try {
      client = clientFactory();
    } catch (_) {
      throw const AgentException('WD-Tagger 连接失败。');
    }

    var closed = false;
    void closeClient() {
      if (closed) return;
      closed = true;
      try {
        client.close();
      } catch (_) {
        // Preserve the request, timeout, or cancellation outcome.
      }
    }

    final lifeToken = AgentCancellation();
    try {
      final operationFuture = Future<T>(
        () => _guardNetworkErrors(() {
          cancellation.check();
          lifeToken.check();
          return operation(client, lifeToken);
        }),
      );
      final lifeBoundOperation = lifeToken.bind(operationFuture);
      return await cancellation.bind(lifeBoundOperation).timeout(timeout);
    } on AgentCancelled {
      rethrow;
    } on TimeoutException {
      throw const AgentException('WD-Tagger 全流程请求超时。');
    } finally {
      lifeToken.cancel();
      closeClient();
    }
  }

  Future<T> _guardNetworkErrors<T>(Future<T> Function() operation) async {
    try {
      return await operation();
    } on AgentException {
      rethrow;
    } catch (_) {
      throw const AgentException('WD-Tagger 网络请求失败。');
    }
  }

  void _checkStatus(int statusCode, String stage) {
    if (statusCode >= 200 && statusCode < 300) return;
    if (statusCode >= 300 && statusCode < 400) {
      throw const AgentException('WD-Tagger 服务返回重定向，已停止请求。');
    }
    throw AgentException('WD-Tagger $stage失败（HTTP $statusCode）。');
  }

  Future<List<int>> _readBoundedResponse(http.StreamedResponse response) async {
    final builder = BytesBuilder(copy: false);
    final headerLength = _headerValue(response.headers, 'content-length');
    final parsedHeaderLength = headerLength == null
        ? null
        : int.tryParse(headerLength);
    if (headerLength != null && parsedHeaderLength == null) {
      throw const AgentException('WD-Tagger 响应长度无效。');
    }
    final contentLength = response.contentLength;
    final responseLength = contentLength != null && contentLength >= 0
        ? contentLength
        : parsedHeaderLength;
    if (responseLength != null && responseLength > _maxResponseBytes) {
      throw const AgentException('WD-Tagger 响应超过 1 MiB 限制。');
    }

    var total = 0;
    await for (final chunk in response.stream) {
      total += chunk.length;
      if (total > _maxResponseBytes) {
        throw const AgentException('WD-Tagger 响应超过 1 MiB 限制。');
      }
      builder.add(chunk);
    }
    if (responseLength != null && responseLength != total) {
      throw const AgentException('WD-Tagger 响应长度不完整。');
    }
    return builder.takeBytes();
  }

  Object? _decodeJson(List<int> bytes, String stage) {
    try {
      return jsonDecode(utf8.decode(bytes));
    } on FormatException {
      throw AgentException('WD-Tagger $stage响应不是有效 JSON。');
    }
  }

  WdTaggerResult _parseSseResult(List<int> bytes) {
    final String body;
    try {
      body = utf8.decode(bytes);
    } on FormatException {
      throw const AgentException('WD-Tagger 事件流不是有效 UTF-8。');
    }

    String? eventName;
    final dataLines = <String>[];
    Object? completePayload;
    var completeCount = 0;

    void dispatchEvent() {
      if (eventName == 'error') {
        throw const AgentException('WD-Tagger 分析失败。');
      }
      if (eventName == 'complete') {
        if (completeCount != 0 || dataLines.isEmpty) {
          throw const AgentException('WD-Tagger complete 事件格式无效。');
        }
        completeCount++;
        completePayload = _decodeJson(utf8.encode(dataLines.join('\n')), '结果');
      }
      eventName = null;
      dataLines.clear();
    }

    for (final line in const LineSplitter().convert(body)) {
      if (line.isEmpty) {
        dispatchEvent();
        continue;
      }
      if (line.startsWith(':')) continue;
      final separator = line.indexOf(':');
      final field = separator < 0 ? line : line.substring(0, separator);
      var value = separator < 0 ? '' : line.substring(separator + 1);
      if (value.startsWith(' ')) value = value.substring(1);
      switch (field) {
        case 'event':
          eventName = value;
          break;
        case 'data':
          dataLines.add(value);
          break;
      }
    }
    if (eventName != null || dataLines.isNotEmpty) dispatchEvent();

    if (completeCount != 1) {
      throw const AgentException('WD-Tagger 事件流未包含 complete 结果。');
    }
    return _parseResultPayload(completePayload);
  }

  WdTaggerResult _parseResultPayload(Object? payload) {
    if (payload is! List || payload.length != 4) {
      throw const AgentException('WD-Tagger 结果格式无法识别。');
    }
    final caption = payload[0];
    if (caption is! String || utf8.encode(caption).length > _maxCaptionBytes) {
      throw const AgentException('WD-Tagger caption 超过 16 KiB 限制或格式无效。');
    }
    return WdTaggerResult(
      caption: caption,
      ratingTags: _parseLabelData(payload[1]),
      characterTags: _parseLabelData(payload[2]),
      generalTags: _parseLabelData(payload[3]),
    );
  }

  Map<String, double> _parseLabelData(Object? value) {
    if (value is! Map) {
      throw const AgentException('WD-Tagger 标签结果格式无法识别。');
    }
    if (value.isEmpty) return const {};
    if (value.keys.toSet().difference({'label', 'confidences'}).isNotEmpty ||
        value.length != 2 ||
        value['label'] is! String ||
        value['confidences'] is! List) {
      throw const AgentException('WD-Tagger 标签结果格式无法识别。');
    }

    final confidenceRows = value['confidences'] as List;
    if (confidenceRows.isEmpty || confidenceRows.length > _maxTagCount) {
      throw const AgentException('WD-Tagger 标签数量超出限制。');
    }
    final tags = <String, double>{};
    for (final row in confidenceRows) {
      if (row is! Map ||
          row.length != 2 ||
          row.keys.toSet().difference({'label', 'confidence'}).isNotEmpty) {
        throw const AgentException('WD-Tagger 标签项格式无法识别。');
      }
      final label = row['label'];
      final rawConfidence = row['confidence'];
      if (label is! String ||
          label.isEmpty ||
          utf8.encode(label).length > _maxTagNameBytes ||
          rawConfidence is! num ||
          !_isConfidence(rawConfidence.toDouble()) ||
          tags.containsKey(label)) {
        throw const AgentException('WD-Tagger 标签项无效。');
      }
      tags[label] = rawConfidence.toDouble();
    }
    if (value['label'] != tags.keys.first) {
      throw const AgentException('WD-Tagger 标签标题与置信度列表不一致。');
    }
    return tags;
  }
}

/// Validates and canonicalizes a WD-Tagger service root.
///
/// Remote services must use HTTPS. Plain HTTP is accepted only for localhost,
/// IPv4 loopback, or IPv6 loopback addresses.
String normalizeWdTaggerBaseUrl(String value) {
  final cleaned = value.trim();
  if (cleaned.isEmpty || cleaned.length > 2048) {
    throw const AgentException('WD-Tagger 服务地址无效。');
  }
  final uri = Uri.tryParse(cleaned);
  if (uri == null ||
      !uri.hasAuthority ||
      uri.host.isEmpty ||
      uri.authority.contains('@') ||
      uri.hasQuery ||
      uri.hasFragment) {
    throw const AgentException('WD-Tagger 服务地址不能包含凭据、查询参数或片段。');
  }

  final scheme = uri.scheme.toLowerCase();
  final host = uri.host.toLowerCase();
  if (scheme != 'https' && !(scheme == 'http' && _isLoopbackHost(host))) {
    throw const AgentException('WD-Tagger 服务地址须使用 HTTPS 或回环 HTTP。');
  }
  if (uri.hasPort && (uri.port < 1 || uri.port > 65535)) {
    throw const AgentException('WD-Tagger 服务端口无效。');
  }
  if (uri.pathSegments.any((segment) => segment == '.' || segment == '..')) {
    throw const AgentException('WD-Tagger 服务地址路径无效。');
  }

  final path = uri.path.replaceAll(RegExp(r'/+$'), '');
  return uri.replace(scheme: scheme, path: path).toString();
}

Uri _endpoint(String baseUrl, String suffix) {
  final root = Uri.parse(baseUrl);
  final path = '${root.path.replaceAll(RegExp(r'/+$'), '')}$suffix';
  return root.replace(path: path);
}

String? _headerValue(Map<String, String> headers, String name) {
  for (final entry in headers.entries) {
    if (entry.key.toLowerCase() == name) return entry.value;
  }
  return null;
}

bool _isLoopbackHost(String host) {
  if (host == 'localhost' || host == '::1') return true;
  final octets = host.split('.');
  if (octets.length != 4 || octets.first != '127') return false;
  return octets.every((octet) {
    final value = int.tryParse(octet);
    return value != null && value >= 0 && value <= 255;
  });
}

void _validatePngBytes(Uint8List bytes) {
  if (bytes.length < 8 ||
      bytes.length > _maxUploadBytes ||
      !_pngSignature.every((pair) => bytes[pair.$1] == pair.$2)) {
    throw const AgentException('WD-Tagger 仅接受有效 PNG 签名且不超过 10 MiB 的已标准化图像。');
  }
}

const List<(int, int)> _pngSignature = [
  (0, 137),
  (1, 80),
  (2, 78),
  (3, 71),
  (4, 13),
  (5, 10),
  (6, 26),
  (7, 10),
];

bool _isThreshold(double value) => value.isFinite && value >= 0 && value <= 1;

bool _isConfidence(double value) => value.isFinite && value >= 0 && value <= 1;

bool _readBool(Map<String, Object?> json, String key, bool defaultValue) {
  if (!json.containsKey(key)) return defaultValue;
  final value = json[key];
  if (value is! bool) throw FormatException('WD-Tagger 设置字段 $key 类型无效。');
  return value;
}

String _readString(Map<String, Object?> json, String key, String defaultValue) {
  if (!json.containsKey(key)) return defaultValue;
  final value = json[key];
  if (value is! String) throw FormatException('WD-Tagger 设置字段 $key 类型无效。');
  return value;
}

double _readDouble(Map<String, Object?> json, String key, double defaultValue) {
  if (!json.containsKey(key)) return defaultValue;
  final value = json[key];
  if (value is! num || !value.toDouble().isFinite) {
    throw FormatException('WD-Tagger 设置字段 $key 类型无效。');
  }
  return value.toDouble();
}

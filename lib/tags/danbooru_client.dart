import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import '../assistant/agent_contract.dart';

const String defaultDanbooruBaseUrl =
    'https://sakizuki-danboorusearch.hf.space';

const int _maxSearchResults = 30;
const int _maxQueryLength = 1000;
const int _maxTagLength = 200;
const int _maxNameLength = 500;
const int _maxCategoryLength = 64;
const int _maxNsfwLength = 64;
const int _maxWikiLength = 4096;
const int _maxResponseBytes = 1024 * 1024;

/// A bounded Danbooru tag returned by the semantic search service.
class DanbooruTag {
  const DanbooruTag({
    required this.tag,
    this.cnName = '',
    this.category = '',
    this.nsfw = '',
    this.count,
    this.score,
    this.wiki = '',
  });

  final String tag;
  final String cnName;
  final String category;
  final String nsfw;
  final int? count;
  final double? score;
  final String wiki;

  String get promptText => tag.replaceAll('_', ' ');

  /// Serializes only bounded fields, using the service's JSON field names.
  Map<String, Object?> toJson() => {
    'tag': _bound(tag, _maxTagLength),
    'cn_name': _bound(cnName, _maxNameLength),
    'category': _bound(category, _maxCategoryLength),
    'nsfw': _bound(nsfw, _maxNsfwLength),
    'count': count != null && count! >= 0 ? count : null,
    'final_score': score != null && score!.isFinite ? score : null,
    'wiki': _bound(wiki, _maxWikiLength),
  };

  static String _bound(String value, int maxLength) =>
      value.length <= maxLength ? value : value.substring(0, maxLength);
}

class DanbooruSearchResult {
  DanbooruSearchResult({
    required List<DanbooruTag> tags,
    required this.source,
    required this.query,
  }) : tags = List<DanbooruTag>.unmodifiable(tags);

  final List<DanbooruTag> tags;
  final String source;
  final String query;
}

abstract interface class DanbooruSearchClient {
  Future<DanbooruSearchResult> search({
    required String query,
    required AgentCancellation cancellation,
    String baseUrl = defaultDanbooruBaseUrl,
    int limit = 30,
    bool showNsfw = true,
  });
}

/// HTTP client for the ComfyUI-DanbooruSearcher semantic search API.
///
/// Each search owns and closes a fresh HTTP client. Requests never include
/// authorization credentials, follow redirects, retry, or switch endpoints.
class HttpDanbooruSearchClient implements DanbooruSearchClient {
  HttpDanbooruSearchClient({
    http.Client Function()? clientFactory,
    this.timeout = const Duration(seconds: 15),
  }) : clientFactory = clientFactory ?? http.Client.new {
    if (timeout <= Duration.zero) {
      throw ArgumentError.value(timeout, 'timeout', 'Must be positive.');
    }
  }

  final http.Client Function() clientFactory;
  final Duration timeout;

  @override
  Future<DanbooruSearchResult> search({
    required String query,
    required AgentCancellation cancellation,
    String baseUrl = defaultDanbooruBaseUrl,
    int limit = 30,
    bool showNsfw = true,
  }) async {
    cancellation.check();
    final cleanedQuery = query.trim();
    if (cleanedQuery.isEmpty || cleanedQuery.length > _maxQueryLength) {
      throw const AgentException('Danbooru 搜索内容不能为空或超过 1000 字符。');
    }

    final source = normalizeDanbooruBaseUrl(baseUrl);
    final boundedLimit = limit.clamp(1, _maxSearchResults);
    final endpoint = _searchEndpoint(source);
    final body = jsonEncode({
      'query': cleanedQuery,
      'top_k': 5,
      'limit': boundedLimit,
      'show_nsfw': showNsfw,
    });

    return _withClient<DanbooruSearchResult>(cancellation, (client) async {
      final request = http.Request('POST', endpoint)
        ..followRedirects = false
        ..maxRedirects = 0
        ..headers['content-type'] = 'application/json; charset=utf-8'
        ..headers['accept'] = 'application/json'
        ..body = body;

      final response = await client.send(request);
      _checkStatus(response.statusCode);
      final bytes = await _readBoundedResponse(response);
      cancellation.check();

      final Object? decoded;
      try {
        decoded = jsonDecode(utf8.decode(bytes));
      } on FormatException {
        throw const AgentException('Danbooru 服务返回了无效 JSON。');
      }
      if (decoded is! Map || decoded['results'] is! List) {
        throw const AgentException('Danbooru 服务响应格式无法识别。');
      }

      final tags = <DanbooruTag>[];
      final rows = decoded['results'] as List;
      for (final row in rows.take(boundedLimit)) {
        cancellation.check();
        if (row is! Map) {
          throw const AgentException('Danbooru 服务结果格式无法识别。');
        }
        tags.add(_parseTag(row));
      }
      cancellation.check();
      return DanbooruSearchResult(
        tags: tags,
        source: source,
        query: cleanedQuery,
      );
    });
  }

  Future<T> _withClient<T>(
    AgentCancellation cancellation,
    Future<T> Function(http.Client client) operation,
  ) async {
    cancellation.check();
    final http.Client client;
    try {
      client = clientFactory();
    } catch (_) {
      throw const AgentException('无法连接 Danbooru 搜索服务。');
    }

    var closed = false;
    void closeClient() {
      if (closed) return;
      closed = true;
      try {
        client.close();
      } catch (_) {
        // Preserve the original request, timeout, or cancellation outcome.
      }
    }

    try {
      return await cancellation
          .bind(_guardNetworkErrors(() => operation(client)))
          .timeout(timeout);
    } on AgentCancelled {
      rethrow;
    } on TimeoutException {
      throw const AgentException('Danbooru 搜索请求超时。');
    } finally {
      closeClient();
    }
  }

  Future<T> _guardNetworkErrors<T>(Future<T> Function() operation) async {
    try {
      return await operation();
    } on AgentException {
      rethrow;
    } catch (_) {
      throw const AgentException('Danbooru 搜索连接失败。');
    }
  }

  void _checkStatus(int statusCode) {
    if (statusCode >= 200 && statusCode < 300) return;
    if (statusCode >= 300 && statusCode < 400) {
      throw const AgentException('Danbooru 服务返回重定向；已停止请求。');
    }
    throw AgentException('Danbooru 服务请求失败（HTTP $statusCode）。');
  }

  DanbooruTag _parseTag(Map row) {
    final tag = row['tag'];
    if (tag is! String || tag.trim().isEmpty || tag.length > _maxTagLength) {
      throw const AgentException('Danbooru 服务返回了无效 tag。');
    }
    final count = row['count'];
    if (count != null && (count is! int || count < 0)) {
      throw const AgentException('Danbooru 服务返回了无效 count。');
    }
    final rawScore = row['final_score'];
    if (rawScore != null &&
        (rawScore is! num || !rawScore.toDouble().isFinite)) {
      throw const AgentException('Danbooru 服务返回了无效 final_score。');
    }

    return DanbooruTag(
      tag: tag.trim(),
      cnName: _stringField(row, 'cn_name', _maxNameLength),
      category: _stringField(row, 'category', _maxCategoryLength),
      nsfw: _stringField(row, 'nsfw', _maxNsfwLength),
      count: count as int?,
      score: (rawScore as num?)?.toDouble(),
      wiki: _stringField(row, 'wiki', _maxWikiLength),
    );
  }

  String _stringField(Map row, String key, int maxLength) {
    final value = row[key];
    if (value == null) return '';
    if (value is! String) {
      throw const AgentException('Danbooru 服务返回了无效字段。');
    }
    return value.length <= maxLength ? value : value.substring(0, maxLength);
  }

  Future<List<int>> _readBoundedResponse(http.StreamedResponse response) async {
    final builder = BytesBuilder(copy: false);
    final headerLength = int.tryParse(
      _headerValue(response.headers, 'content-length') ?? '',
    );
    final expectedLength = response.contentLength ?? headerLength;
    if (expectedLength != null && expectedLength > _maxResponseBytes) {
      throw const AgentException('Danbooru 响应超过 1 MiB 限制。');
    }

    var total = 0;
    await for (final chunk in response.stream) {
      total += chunk.length;
      if (total > _maxResponseBytes) {
        throw const AgentException('Danbooru 响应超过 1 MiB 限制。');
      }
      builder.add(chunk);
    }
    if (expectedLength != null && expectedLength != total) {
      throw const AgentException('Danbooru 响应长度不完整。');
    }
    return builder.takeBytes();
  }

  String? _headerValue(Map<String, String> headers, String name) {
    for (final entry in headers.entries) {
      if (entry.key.toLowerCase() == name) return entry.value;
    }
    return null;
  }

  Uri _searchEndpoint(String source) {
    final root = Uri.parse(source);
    final path = '${root.path.replaceAll(RegExp(r'/+$'), '')}/api/search';
    return root.replace(path: path);
  }
}

/// Validates and canonicalizes an explicit service root URL.
///
/// Public endpoints must use HTTPS. HTTP is limited to localhost and IPv4 or
/// IPv6 loopback addresses for local development services.
String normalizeDanbooruBaseUrl(String value) {
  final cleaned = value.trim();
  if (cleaned.isEmpty || cleaned.length > 2048) {
    throw const AgentException('Danbooru 服务地址无效。');
  }
  final uri = Uri.tryParse(cleaned);
  if (uri == null ||
      !uri.hasAuthority ||
      uri.host.isEmpty ||
      uri.authority.contains('@') ||
      uri.hasQuery ||
      uri.hasFragment) {
    throw const AgentException('Danbooru 服务地址不能包含凭据、查询参数或片段。');
  }

  final scheme = uri.scheme.toLowerCase();
  final host = uri.host.toLowerCase();
  if (scheme != 'https' && !(scheme == 'http' && _isLoopbackHost(host))) {
    throw const AgentException('Danbooru 服务地址须使用 HTTPS 或回环 HTTP。');
  }
  if (uri.hasPort && (uri.port < 1 || uri.port > 65535)) {
    throw const AgentException('Danbooru 服务端口无效。');
  }

  final path = uri.path.replaceAll(RegExp(r'/+$'), '');
  return uri.replace(scheme: scheme, path: path).toString();
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

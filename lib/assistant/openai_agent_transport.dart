import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import '../generation/generation_http_client.dart';
import '../security/credential_vault.dart';
import 'agent_contract.dart';

/// OpenAI-compatible Chat Completions transport for the assistant domain.
///
/// This transport owns a fresh HTTP client per operation. It reads credentials
/// only through [AssistantProvider], whose vault scope is isolated to the
/// assistant provider and endpoint.
class OpenAiAgentTransport implements AgentTransport {
  OpenAiAgentTransport({
    required this.vault,
    http.Client Function()? clientFactory,
    this.timeout = const Duration(seconds: 120),
  }) : clientFactory = clientFactory ?? createGenerationHttpClient {
    if (timeout <= Duration.zero) {
      throw ArgumentError.value(timeout, 'timeout', 'Must be positive.');
    }
  }

  static const int _maxResponseBytes = 1024 * 1024;

  final CredentialVault vault;
  final http.Client Function() clientFactory;
  final Duration timeout;

  @override
  Future<AgentReply> complete({
    required AssistantProvider provider,
    required List<Map<String, dynamic>> messages,
    required List<Map<String, dynamic>> tools,
    required String toolChoice,
    required AgentCancellation cancellation,
    void Function(String accumulatedText)? onText,
  }) async {
    provider.validate();
    final credential = await _readCredential(provider, cancellation);
    cancellation.check();

    final body = <String, dynamic>{
      'model': provider.model,
      'messages': messages,
      'stream': provider.streaming,
      if (tools.isNotEmpty) 'tools': tools,
      if (tools.isNotEmpty) 'tool_choice': toolChoice,
    };

    return _withClient<AgentReply>(cancellation, (client, isActive) async {
      final request =
          http.Request('POST', provider.endpoint('chat/completions'))
            ..followRedirects = false
            ..maxRedirects = 0
            ..headers['content-type'] = 'application/json'
            ..headers['accept'] = provider.streaming
                ? 'text/event-stream'
                : 'application/json'
            ..body = jsonEncode(body);
      if (credential != null) {
        request.headers['authorization'] = 'Bearer $credential';
      }

      final response = await client.send(request);
      _checkStatus(response.statusCode);
      if (provider.streaming) {
        return _readSseReply(
          response,
          cancellation: cancellation,
          isActive: isActive,
          onText: onText,
        );
      }
      return _readJsonReply(response);
    });
  }

  /// Fetches the model IDs exposed by this compatible service.
  Future<List<String>> listModels(
    AssistantProvider provider,
    AgentCancellation cancellation,
  ) async {
    provider.validate();
    final credential = await _readCredential(provider, cancellation);
    cancellation.check();

    return _withClient<List<String>>(cancellation, (client, _) async {
      final request = http.Request('GET', provider.endpoint('models'))
        ..followRedirects = false
        ..maxRedirects = 0
        ..headers['accept'] = 'application/json';
      if (credential != null) {
        request.headers['authorization'] = 'Bearer $credential';
      }

      final response = await client.send(request);
      _checkStatus(response.statusCode);
      final bytes = await _readBoundedBytes(response);
      if (bytes.isEmpty) throw const AgentException('服务返回了空响应。');
      final Object? decoded;
      try {
        decoded = jsonDecode(utf8.decode(bytes));
      } on FormatException {
        throw const AgentException('服务返回了无效 JSON。');
      }
      if (decoded is! Map || decoded['data'] is! List) {
        throw const AgentException('服务的模型列表响应结构无法识别。');
      }
      final ids = <String>[];
      for (final item in decoded['data'] as List) {
        if (item is! Map ||
            item['id'] is! String ||
            (item['id'] as String).isEmpty) {
          throw const AgentException('服务的模型列表响应结构无法识别。');
        }
        ids.add(item['id'] as String);
      }
      return List<String>.unmodifiable(ids);
    });
  }

  Future<String?> _readCredential(
    AssistantProvider provider,
    AgentCancellation cancellation,
  ) async {
    cancellation.check();
    final String? secret;
    try {
      secret = await cancellation
          .bind(provider.readSecret(vault))
          .timeout(timeout);
    } on AgentCancelled {
      rethrow;
    } on TimeoutException {
      throw const AgentException('读取助手凭据超时。');
    } catch (_) {
      throw const AgentException('无法读取助手凭据。');
    }
    cancellation.check();
    final cleaned = secret?.trim();
    if (provider.requireKey && (cleaned == null || cleaned.isEmpty)) {
      throw const AgentException('请先保存当前助手服务的 API Key。');
    }
    if (cleaned != null && RegExp(r'[\r\n\x00]').hasMatch(cleaned)) {
      throw const AgentException('助手凭据格式无效。');
    }
    return cleaned == null || cleaned.isEmpty ? null : cleaned;
  }

  Future<T> _withClient<T>(
    AgentCancellation cancellation,
    Future<T> Function(http.Client client, bool Function() isActive) operation,
  ) async {
    cancellation.check();
    final http.Client client;
    try {
      client = clientFactory();
    } catch (_) {
      throw const AgentException('无法连接助手服务，请检查网络或服务地址。');
    }

    var active = true;
    var closed = false;
    bool isActive() => active && !cancellation.isCancelled;
    void closeClient() {
      if (closed) return;
      closed = true;
      client.close();
    }

    try {
      final work = _guardNetworkErrors(() => operation(client, isActive));
      return await cancellation.bind(work).timeout(timeout);
    } on AgentCancelled {
      active = false;
      closeClient();
      rethrow;
    } on TimeoutException {
      active = false;
      closeClient();
      throw const AgentException('助手请求超时；不会自动重发。');
    } finally {
      active = false;
      closeClient();
    }
  }

  Future<T> _guardNetworkErrors<T>(Future<T> Function() operation) async {
    try {
      return await operation();
    } on AgentException {
      rethrow;
    } catch (_) {
      throw const AgentException('无法连接助手服务，请检查网络或服务地址。');
    }
  }

  void _checkStatus(int statusCode) {
    if (statusCode >= 200 && statusCode < 300) return;
    if (statusCode == 401 || statusCode == 403) {
      throw AgentException('助手凭据无效或无权访问该服务（HTTP $statusCode）。');
    }
    if (statusCode == 429) {
      throw const AgentException('助手服务请求过于频繁，请稍后再试（HTTP 429）。');
    }
    if (statusCode >= 300 && statusCode < 400) {
      throw const AgentException('助手服务返回了重定向；为保护凭据，已停止请求。');
    }
    if (statusCode >= 400 && statusCode < 500) {
      throw AgentException('助手请求被服务拒绝（HTTP $statusCode）。请检查模型与请求格式。');
    }
    if (statusCode >= 500) {
      throw AgentException('助手服务暂时不可用（HTTP $statusCode）。');
    }
    throw AgentException('助手服务返回了未知状态（HTTP $statusCode）。');
  }

  Future<AgentReply> _readJsonReply(http.StreamedResponse response) async {
    final bytes = await _readBoundedBytes(response);
    if (bytes.isEmpty) throw const AgentException('助手返回了空响应。');
    final Object? decoded;
    try {
      decoded = jsonDecode(utf8.decode(bytes));
    } on FormatException {
      throw const AgentException('助手服务返回了无效 JSON。');
    }
    if (decoded is! Map || decoded['choices'] is! List) {
      throw const AgentException('助手服务响应结构无法识别。');
    }
    final choices = decoded['choices'] as List;
    if (choices.length != 1 || choices.single is! Map) {
      throw const AgentException('助手服务响应结构无法识别。');
    }
    final choice = choices.single as Map;
    final message = choice['message'];
    final finishReason = choice['finish_reason'];
    if (message is! Map || finishReason is! String || finishReason.isEmpty) {
      throw const AgentException('助手响应缺少完整的结束信息。');
    }
    if (!_isSupportedFinishReason(finishReason)) {
      throw const AgentException('助手响应未正常完成；不会执行工具调用。');
    }
    final contentValue = message['content'];
    if (contentValue != null && contentValue is! String) {
      throw const AgentException('助手服务响应结构无法识别。');
    }
    final reasoningContentValue = message['reasoning_content'];
    if (reasoningContentValue != null && reasoningContentValue is! String) {
      throw const AgentException('助手服务响应结构无法识别。');
    }
    final callsValue = message['tool_calls'];
    if (callsValue != null && callsValue is! List) {
      throw const AgentException('助手服务响应结构无法识别。');
    }
    final calls = <AgentCall>[];
    if (callsValue is List) {
      for (final value in callsValue) {
        if (value is! Map) {
          throw const AgentException('助手返回的工具调用结构无法识别。');
        }
        calls.add(_decodeCall(value));
      }
    }
    final content = contentValue as String? ?? '';
    if (content.isEmpty && calls.isEmpty) {
      throw const AgentException('助手返回了空响应。');
    }
    return AgentReply(
      content: content,
      calls: List<AgentCall>.unmodifiable(calls),
      finishReason: finishReason,
      reasoningContent: reasoningContentValue as String?,
    );
  }

  AgentCall _decodeCall(Map call) {
    final function = call['function'];
    if (call['type'] != 'function' ||
        call['id'] is! String ||
        (call['id'] as String).isEmpty ||
        function is! Map ||
        function['name'] is! String ||
        (function['name'] as String).isEmpty ||
        function['arguments'] is! String) {
      throw const AgentException('助手返回的工具调用结构无法识别。');
    }
    return AgentCall(
      id: call['id'] as String,
      name: function['name'] as String,
      arguments: function['arguments'] as String,
    );
  }

  Future<AgentReply> _readSseReply(
    http.StreamedResponse response, {
    required AgentCancellation cancellation,
    required bool Function() isActive,
    void Function(String accumulatedText)? onText,
  }) async {
    final contentType =
        _headerValue(response.headers, 'content-type')?.toLowerCase() ?? '';
    if (!contentType.split(';').first.trim().contains('text/event-stream')) {
      throw const AgentException('助手未返回预期的 SSE 流式响应。');
    }

    final text = StringBuffer();
    final reasoning = StringBuffer();
    final toolCalls = <int, _ToolCallAccumulator>{};
    final eventData = <String>[];
    var finishReason = '';
    var sawReasoningContent = false;
    var doneMarker = false;
    var sawBytes = false;
    var totalBytes = 0;

    void dispatchEvent() {
      if (eventData.isEmpty) return;
      final data = eventData.join('\n');
      eventData.clear();
      if (data == '[DONE]') {
        if (doneMarker) throw const AgentException('助手流式响应结构无法识别。');
        doneMarker = true;
        return;
      }
      if (doneMarker) {
        throw const AgentException('助手流式响应结构无法识别。');
      }

      final Object? decoded;
      try {
        decoded = jsonDecode(data);
      } on FormatException {
        throw const AgentException('助手流式响应包含无效 JSON。');
      }
      if (decoded is! Map || decoded['choices'] is! List) {
        throw const AgentException('助手流式响应结构无法识别。');
      }
      final choices = decoded['choices'] as List;
      if (choices.isEmpty && decoded['usage'] is Map) return;
      if (choices.length != 1 || choices.single is! Map) {
        throw const AgentException('助手流式响应结构无法识别。');
      }
      final choice = choices.single as Map;
      final choiceIndex = choice['index'];
      if (choiceIndex != null && choiceIndex != 0) {
        throw const AgentException('助手流式响应结构无法识别。');
      }
      final delta = choice['delta'];
      if (delta is! Map) {
        throw const AgentException('助手流式响应结构无法识别。');
      }

      final content = delta['content'];
      if (content != null && content is! String) {
        throw const AgentException('助手流式响应结构无法识别。');
      }
      if (content is String && content.isNotEmpty) {
        text.write(content);
        if (isActive()) onText?.call(text.toString());
      }

      final reasoningContent = delta['reasoning_content'];
      if (reasoningContent != null && reasoningContent is! String) {
        throw const AgentException('助手流式响应结构无法识别。');
      }
      if (reasoningContent is String) {
        sawReasoningContent = true;
        reasoning.write(reasoningContent);
      }

      final callsValue = delta['tool_calls'];
      if (callsValue != null && callsValue is! List) {
        throw const AgentException('助手流式响应结构无法识别。');
      }
      if (callsValue is List) {
        for (final value in callsValue) {
          if (value is! Map || value['index'] is! int || value['index'] < 0) {
            throw const AgentException('助手流式响应中的工具调用结构无法识别。');
          }
          final index = value['index'] as int;
          final accumulator = toolCalls.putIfAbsent(
            index,
            _ToolCallAccumulator.new,
          );
          accumulator.add(value);
        }
      }

      final reason = choice['finish_reason'];
      if (reason != null) {
        if (reason is! String ||
            reason.isEmpty ||
            !_isSupportedFinishReason(reason) ||
            finishReason.isNotEmpty) {
          throw const AgentException('助手流式响应的结束信息无法识别。');
        }
        finishReason = reason;
      }
    }

    try {
      final bounded = _boundedChunks(
        response.stream,
        response.headers,
        declaredLength: response.contentLength,
        onChunk: (chunkLength) {
          sawBytes = true;
          totalBytes += chunkLength;
        },
      );
      await for (final line
          in bounded.transform(utf8.decoder).transform(const LineSplitter())) {
        cancellation.check();
        if (line.isEmpty) {
          dispatchEvent();
        } else if (!line.startsWith(':') && line.startsWith('data:')) {
          var value = line.substring(5);
          if (value.startsWith(' ')) value = value.substring(1);
          eventData.add(value);
        }
      }
      dispatchEvent();
    } on AgentException {
      rethrow;
    } on FormatException {
      throw const AgentException('助手流式响应不是有效的 UTF-8。');
    }

    if (!sawBytes || totalBytes == 0) {
      throw const AgentException('助手返回了空响应。');
    }
    if (!doneMarker) {
      throw const AgentException('助手流式响应未完整结束；不会执行未完成的工具调用。');
    }
    if (finishReason.isEmpty) {
      throw const AgentException('助手流式响应缺少结束原因。');
    }
    if (toolCalls.isNotEmpty) {
      final indices = toolCalls.keys.toList()..sort();
      for (var expected = 0; expected < indices.length; expected++) {
        if (indices[expected] != expected) {
          throw const AgentException('助手流式响应中的工具调用索引不完整。');
        }
      }
    }
    final calls = toolCalls.keys.toList()..sort();
    final completedCalls = <AgentCall>[
      for (final index in calls) toolCalls[index]!.build(),
    ];
    final accumulatedText = text.toString();
    if (accumulatedText.isEmpty && completedCalls.isEmpty) {
      throw const AgentException('助手返回了空响应。');
    }
    return AgentReply(
      content: accumulatedText,
      calls: List<AgentCall>.unmodifiable(completedCalls),
      finishReason: finishReason,
      reasoningContent: sawReasoningContent ? reasoning.toString() : null,
    );
  }

  Future<List<int>> _readBoundedBytes(http.StreamedResponse response) async {
    final builder = BytesBuilder(copy: false);
    await for (final chunk in _boundedChunks(
      response.stream,
      response.headers,
      declaredLength: response.contentLength,
    )) {
      builder.add(chunk);
    }
    return builder.takeBytes();
  }

  Stream<List<int>> _boundedChunks(
    Stream<List<int>> source,
    Map<String, String> headers, {
    int? declaredLength,
    void Function(int chunkLength)? onChunk,
  }) async* {
    final headerLength = int.tryParse(
      _headerValue(headers, 'content-length') ?? '',
    );
    final expectedLength = declaredLength != null && declaredLength >= 0
        ? declaredLength
        : headerLength != null && headerLength >= 0
        ? headerLength
        : null;
    if (expectedLength != null && expectedLength > _maxResponseBytes) {
      throw const AgentException('助手响应超过 1 MB 限制。');
    }
    var total = 0;
    await for (final chunk in source) {
      total += chunk.length;
      if (total > _maxResponseBytes) {
        throw const AgentException('助手响应超过 1 MB 限制。');
      }
      onChunk?.call(chunk.length);
      yield chunk;
    }
    if (expectedLength != null && expectedLength != total) {
      throw const AgentException('助手响应长度不完整。');
    }
  }

  String? _headerValue(Map<String, String> headers, String name) {
    for (final entry in headers.entries) {
      if (entry.key.toLowerCase() == name) return entry.value;
    }
    return null;
  }

  bool _isSupportedFinishReason(String reason) =>
      reason == 'stop' || reason == 'tool_calls';
}

class _ToolCallAccumulator {
  String id = '';
  String type = '';
  String name = '';
  final StringBuffer arguments = StringBuffer();

  void add(Map value) {
    final incomingId = value['id'];
    final incomingType = value['type'];
    if (incomingId != null && incomingId is! String ||
        incomingType != null && incomingType is! String) {
      throw const AgentException('助手流式响应中的工具调用结构无法识别。');
    }
    id = _appendFragment(id, incomingId as String?);
    type = _appendFragment(type, incomingType as String?);

    final function = value['function'];
    if (function != null && function is! Map) {
      throw const AgentException('助手流式响应中的工具调用结构无法识别。');
    }
    if (function is Map) {
      final incomingName = function['name'];
      final incomingArguments = function['arguments'];
      if (incomingName != null && incomingName is! String ||
          incomingArguments != null && incomingArguments is! String) {
        throw const AgentException('助手流式响应中的工具调用结构无法识别。');
      }
      if (incomingName is String) name += incomingName;
      if (incomingArguments is String) arguments.write(incomingArguments);
    }
  }

  AgentCall build() {
    if (id.isEmpty || name.isEmpty || type != 'function') {
      throw const AgentException('助手返回的工具调用不完整。');
    }
    return AgentCall(id: id, name: name, arguments: arguments.toString());
  }

  String _appendFragment(String current, String? fragment) {
    if (fragment == null || fragment.isEmpty) return current;
    if (current.isEmpty) return fragment;
    if (current == fragment) return current;
    return '$current$fragment';
  }
}

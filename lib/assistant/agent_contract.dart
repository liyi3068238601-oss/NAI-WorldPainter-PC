import 'dart:async';
import 'dart:convert';

import 'package:crypto/crypto.dart';

import '../security/credential_vault.dart';

/// Public LLM settings only. No secret is serialized with chat history.
class AssistantProvider {
  const AssistantProvider({
    required this.id,
    required this.name,
    required this.baseUrl,
    required this.model,
    this.streaming = true,
    this.requireKey = true,
  });
  final String id, name, baseUrl, model;
  final bool streaming, requireKey;

  Uri get apiRoot {
    final uri = Uri.tryParse(baseUrl.trim());
    if (uri == null ||
        !uri.hasAuthority ||
        uri.host.isEmpty ||
        uri.userInfo.isNotEmpty ||
        uri.hasQuery ||
        uri.hasFragment ||
        !(uri.scheme == 'https' ||
            (uri.scheme == 'http' &&
                const ['localhost', '127.0.0.1', '::1'].contains(uri.host)))) {
      throw const AgentException('服务地址须为 HTTPS；本地服务可使用回环 HTTP。');
    }
    var path = uri.path.replaceAll(RegExp(r'/+$'), '');
    if (path.endsWith('/chat/completions')) {
      path = path.substring(0, path.length - '/chat/completions'.length);
    }
    if (path.isEmpty) path = '/v1';
    return uri.replace(path: path);
  }

  Uri endpoint(String suffix) =>
      apiRoot.replace(path: '${apiRoot.path}/$suffix');
  String get credentialKey =>
      sha256.convert(utf8.encode('$id|$apiRoot')).toString();
  String get contextKey =>
      sha256.convert(utf8.encode('$apiRoot|$model')).toString();
  Future<String?> readSecret(CredentialVault vault) =>
      vault.read(provider: 'assistant', key: credentialKey);
  Future<void> saveSecret(CredentialVault vault, String secret) => vault.save(
    provider: 'assistant',
    key: credentialKey,
    secret: secret.trim(),
  );
  Future<void> deleteSecret(CredentialVault vault) =>
      vault.delete(provider: 'assistant', key: credentialKey);

  void validate() {
    apiRoot;
    if (id.trim().isEmpty ||
        name.trim().isEmpty ||
        model.trim().isEmpty ||
        id.length > 100 ||
        name.length > 100 ||
        model.length > 200) {
      throw const AgentException('请填写连接名称和模型 ID。');
    }
  }

  Map<String, dynamic> toJson() => {
    'id': id,
    'name': name,
    'baseUrl': apiRoot.toString(),
    'model': model,
    'streaming': streaming,
    'requireKey': requireKey,
  };
  factory AssistantProvider.fromJson(Map<String, dynamic> json) {
    final provider = AssistantProvider(
      id: json['id'] as String,
      name: json['name'] as String,
      baseUrl: json['baseUrl'] as String,
      model: json['model'] as String,
      streaming: json['streaming'] as bool? ?? true,
      requireKey: json['requireKey'] as bool? ?? true,
    );
    provider.validate();
    return provider;
  }
}

class AgentException implements Exception {
  const AgentException(this.message);
  final String message;
  @override
  String toString() => message;
}

class AgentCancelled extends AgentException {
  const AgentCancelled() : super('已停止；不会自动重发请求。');
}

class AgentCancellation {
  final _done = Completer<void>();
  bool get isCancelled => _done.isCompleted;
  Future<void> get whenCancelled => _done.future;
  void cancel() {
    if (!isCancelled) _done.complete();
  }

  void check() {
    if (isCancelled) throw const AgentCancelled();
  }

  Future<T> bind<T>(Future<T> work) async {
    // Always attach to work, even if its synchronous prelude cancelled us.
    // Otherwise a subsequently failing work Future could become unhandled.
    final result = await Future.any<T>([
      work,
      whenCancelled.then<T>((_) => throw const AgentCancelled()),
    ]);
    check();
    return result;
  }
}

class AgentCall {
  const AgentCall({
    required this.id,
    required this.name,
    required this.arguments,
  });
  final String id, name, arguments;
  Map<String, dynamic> toJson() => {
    'id': id,
    'type': 'function',
    'function': {'name': name, 'arguments': arguments},
  };
  factory AgentCall.fromJson(Map<String, dynamic> json) => AgentCall(
    id: json['id'] as String,
    name: (json['function'] as Map)['name'] as String,
    arguments: (json['function'] as Map)['arguments'] as String,
  );
}

class AgentReply {
  const AgentReply({
    this.content = '',
    this.calls = const [],
    this.finishReason = 'stop',
    this.reasoningContent,
  });
  final String content, finishReason;
  // Some compatible providers require this opaque protocol field on replay.
  // It is not interpreted as user-visible prose or executable instructions.
  final String? reasoningContent;
  final List<AgentCall> calls;
  Map<String, dynamic> toMessage() => {
    'role': 'assistant',
    'content': content.isEmpty ? null : content,
    if (reasoningContent != null) 'reasoning_content': reasoningContent,
    if (calls.isNotEmpty) 'tool_calls': calls.map((c) => c.toJson()).toList(),
  };
}

abstract interface class AgentTransport {
  Future<AgentReply> complete({
    required AssistantProvider provider,
    required List<Map<String, dynamic>> messages,
    required List<Map<String, dynamic>> tools,
    required String toolChoice,
    required AgentCancellation cancellation,
    void Function(String accumulatedText)? onText,
  });
}

import 'dart:convert';

import 'agent_contract.dart';

class PreparedAgentTool {
  const PreparedAgentTool({
    required this.summary,
    required this.execute,
    this.confirm = false,
    this.preview = const {},
  });
  final String summary;
  final bool confirm;
  final Map<String, dynamic> preview;
  final Future<Map<String, dynamic>> Function() execute;
}

class AgentTool {
  const AgentTool({
    required this.name,
    required this.label,
    required this.description,
    required this.parameters,
    required this.prepare,
  });
  final String name, label, description;
  final Map<String, dynamic> parameters;
  final Future<PreparedAgentTool> Function(
    Map<String, dynamic>,
    AgentCancellation,
  )
  prepare;
  Map<String, dynamic> toSchema() => {
    'type': 'function',
    'function': {
      'name': name,
      'description': description,
      'parameters': parameters,
    },
  };
}

typedef AgentConfirm = Future<bool> Function(
  AgentCall call,
  PreparedAgentTool plan,
);

/// Only structured API calls enter this executor. Prose and code fences cannot
/// execute anything. The same registry advertises and dispatches each tool.
class AgentEngine {
  AgentEngine({
    required this.transport,
    required List<AgentTool> tools,
    this.maxRounds = 16,
    this.maxFailures = 3,
  }) : tools = {for (final t in tools) t.name: t} {
    if (this.tools.length != tools.length || maxRounds < 1 || maxRounds > 16) {
      throw ArgumentError('Invalid tool registry or round limit');
    }
  }
  final AgentTransport transport;
  final Map<String, AgentTool> tools;
  final int maxRounds, maxFailures;

  Future<void> run({
    required AssistantProvider provider,
    required List<Map<String, dynamic>> context,
    required AgentCancellation cancellation,
    required void Function(Map<String, dynamic> message) onMessage,
    required void Function(Map<String, dynamic> trace) onTrace,
    void Function(String text)? onText,
    void Function(int round)? onRound,
    AgentConfirm? confirm,
    bool requireFirstTool = false,
    bool enableTools = true,
  }) async {
    final messages = <Map<String, dynamic>>[...context];
    final schemas = enableTools
        ? tools.values.map((t) => t.toSchema()).toList()
        : <Map<String, dynamic>>[];
    if (requireFirstTool && schemas.isEmpty) {
      throw const AgentException('当前没有可调用的工具。');
    }
    final seenIds = <String>{};
    var failures = 0;
    var totalCalls = 0;
    var successfulCalls = 0;
    for (var round = 1; round <= maxRounds; round++) {
      cancellation.check();
      onRound?.call(round);
      final reply = await cancellation.bind(
        transport.complete(
          provider: provider,
          messages: List.unmodifiable(messages),
          tools: schemas,
          toolChoice: requireFirstTool && round == 1 ? 'required' : 'auto',
          cancellation: cancellation,
          onText: onText,
        ),
      );
      cancellation.check();
      if (reply.finishReason == 'length' ||
          reply.finishReason == 'content_filter') {
        throw const AgentException('模型输出未完整结束，本轮工具没有执行。请调整请求后重试。');
      }
      if (reply.calls.isEmpty) {
        if (requireFirstTool && round == 1) {
          throw const AgentException(
            '服务未返回工具调用。该轮要求工具执行，未按成功处理；请核对模型/网关的 tools 与 tool_choice 支持。',
          );
        }
        if (requireFirstTool && successfulCalls == 0) {
          throw const AgentException('本轮没有成功执行工具；未把文字回复记为工具执行成功。');
        }
        if (reply.content.trim().isEmpty) {
          throw const AgentException('模型返回空内容，未执行操作。');
        }
        onMessage(reply.toMessage());
        return;
      }
      if (!enableTools) throw const AgentException('普通聊天收到意外工具调用；未执行。');
      if (reply.calls.length > 1 &&
          reply.calls.any((call) => call.name == 'ask_user')) {
        throw const AgentException('询问用户必须单独调用，不能与依赖答案的操作并排执行。本批调用均未执行。');
      }
      if (reply.calls.length > 16 || totalCalls + reply.calls.length > 64) {
        throw const AgentException('工具调用数量超限，已停止。');
      }
      final ids = reply.calls.map((c) => c.id).toList();
      if (ids.any((id) => id.isEmpty) ||
          ids.toSet().length != ids.length ||
          ids.any(seenIds.contains)) {
        throw const AgentException('模型返回重复或缺失的工具调用 ID；为避免重复操作已停止。');
      }
      seenIds.addAll(ids);
      totalCalls += ids.length;
      final assistant = reply.toMessage();
      messages.add(assistant);
      onMessage(assistant);
      for (final call in reply.calls) {
        final timer = Stopwatch()..start();
        final trace = <String, dynamic>{
          'callId': call.id,
          'name': call.name,
          'arguments': call.arguments,
          'status': 'pending',
          'round': round,
          'durationMs': 0,
        };
        void emit(String state) {
          trace['status'] = state;
          trace['durationMs'] = timer.elapsedMilliseconds;
          onTrace(Map.of(trace));
        }

        emit('pending');
        Map<String, dynamic> result;
        try {
          cancellation.check();
          if (failures >= maxFailures) {
            throw const AgentException('连续工具失败，剩余操作已跳过。');
          }
          final tool = tools[call.name];
          if (tool == null) throw const AgentException('工具未注册；请仅使用提供的工具名称。');
          if (call.arguments.length > 64000) {
            throw const AgentException('工具参数过长。');
          }
          dynamic decoded;
          try {
            decoded = jsonDecode(call.arguments);
          } catch (_) {
            throw const AgentException('工具参数不是有效 JSON 对象，请修正后重试。');
          }
          if (decoded is! Map<String, dynamic>) {
            throw const AgentException('工具参数必须为 JSON 对象。');
          }
          validateToolArguments(decoded, tool.parameters);
          final plan = await cancellation.bind(
            tool.prepare(decoded, cancellation),
          );
          cancellation.check();
          trace['summary'] = plan.summary;
          if (plan.confirm) {
            emit('waiting');
            final accepted =
                confirm != null && await cancellation.bind(confirm(call, plan));
            cancellation.check();
            if (!accepted) {
              result = {
                'ok': false,
                'error': '用户拒绝或没有确认界面；没有执行。',
                'denied': true,
              };
              trace['result'] = jsonEncode(result);
              emit('denied');
              final message = {
                'role': 'tool',
                'tool_call_id': call.id,
                'content': jsonEncode(result),
              };
              messages.add(message);
              onMessage(message);
              // A refusal ends this run, instead of letting a model rephrase
              // or choose another tool to bypass the user's decision.
              throw const _AgentDenied();
            }
          }
          emit('running');
          result = await cancellation.bind(plan.execute());
          cancellation.check();
          result = {'ok': true, ...result};
          if (jsonEncode(result).length > 96000) {
            throw const AgentException('工具结果过长，未送入模型上下文。');
          }
          if (result['ok'] == false) {
            failures++;
          } else {
            failures = 0;
            successfulCalls++;
          }
          trace['result'] = jsonEncode(result);
          emit(result['ok'] == false ? 'failed' : 'completed');
        } on _AgentDenied {
          throw const AgentException('已按你的选择拒绝操作，并结束本轮。');
        } on AgentCancelled {
          trace['result'] = trace['status'] == 'running'
              ? '已停止等待。已开始的操作可能已经生效，请核对工作台或图库；不会自动重试。'
              : '已停止；尚未执行该操作。';
          emit('cancelled');
          rethrow;
        } on AgentException catch (error) {
          failures++;
          result = {'ok': false, 'error': error.message};
          trace['result'] = jsonEncode(result);
          emit('failed');
        } catch (_) {
          failures++;
          result = {'ok': false, 'error': '工具执行失败。未确认成功；请检查输入或本地状态。'};
          trace['result'] = jsonEncode(result);
          emit('failed');
        }
        final message = <String, dynamic>{
          'role': 'tool',
          'tool_call_id': call.id,
          'content': jsonEncode(result),
        };
        messages.add(message);
        onMessage(message);
      }
      if (failures >= maxFailures) {
        throw const AgentException('连续工具失败达到上限，本轮已停止。');
      }
    }
    throw const AgentException('已达到 16 轮 Agent 上限；已执行操作保留，未自动续跑。');
  }
}

class _AgentDenied implements Exception {
  const _AgentDenied();
}

/// The advertised schema is also checked locally before prepare/confirmation.
void validateToolArguments(
  dynamic value,
  Map<String, dynamic> schema, [
  String path = '参数',
]) {
  final type = schema['type'];
  final valid = switch (type) {
    'object' => value is Map<String, dynamic>,
    'array' => value is List,
    'string' => value is String,
    'integer' => value is int,
    'number' => value is num && value.isFinite,
    'boolean' => value is bool,
    _ => false,
  };
  if (!valid) throw AgentException('$path 类型不正确。');
  final options = schema['enum'] as List?;
  if (options != null && !options.contains(value)) {
    throw AgentException('$path 不在允许值中。');
  }
  if (value is String &&
      value.length > (schema['maxLength'] as int? ?? 32000)) {
    throw AgentException('$path 太长。');
  }
  if (value is num &&
      ((schema['minimum'] is num && value < schema['minimum']) ||
          (schema['maximum'] is num && value > schema['maximum']))) {
    throw AgentException('$path 超出允许范围。');
  }
  if (value is Map<String, dynamic>) {
    final properties = schema['properties'] as Map? ?? {};
    for (final key in schema['required'] as List? ?? []) {
      if (!value.containsKey(key)) throw AgentException('$path 缺少 $key。');
    }
    for (final key in value.keys) {
      if (!properties.containsKey(key)) {
        throw AgentException('$path 含未声明字段 $key。');
      }
      validateToolArguments(
        value[key],
        Map<String, dynamic>.from(properties[key] as Map),
        '$path.$key',
      );
    }
  }
  if (value is List) {
    if (value.length < (schema['minItems'] as int? ?? 0) ||
        value.length > (schema['maxItems'] as int? ?? 30)) {
      throw AgentException('$path 项目数量不正确。');
    }
    for (final item in value) {
      validateToolArguments(
        item,
        Map<String, dynamic>.from(schema['items'] as Map),
        path,
      );
    }
  }
}

import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';

import 'package:worldpainter_pc/assistant/agent_contract.dart';
import 'package:worldpainter_pc/assistant/agent_engine.dart';

const _provider = AssistantProvider(
  id: 'fixture',
  name: 'fixture',
  baseUrl: 'https://fixture.invalid/v1',
  model: 'fixture-model',
);

const _valueSchema = <String, dynamic>{
  'type': 'object',
  'properties': {
    'value': {'type': 'string'},
  },
  'required': ['value'],
  'additionalProperties': false,
};

class _Request {
  const _Request({
    required this.messages,
    required this.tools,
    required this.toolChoice,
  });

  final List<Map<String, dynamic>> messages;
  final List<Map<String, dynamic>> tools;
  final String toolChoice;
}

class _FakeTransport implements AgentTransport {
  _FakeTransport(this.replies);

  final List<AgentReply> replies;
  final List<_Request> requests = [];

  @override
  Future<AgentReply> complete({
    required AssistantProvider provider,
    required List<Map<String, dynamic>> messages,
    required List<Map<String, dynamic>> tools,
    required String toolChoice,
    required AgentCancellation cancellation,
    void Function(String accumulatedText)? onText,
  }) async {
    cancellation.check();
    requests.add(
      _Request(
        messages: messages
            .map(
              (message) =>
                  jsonDecode(jsonEncode(message)) as Map<String, dynamic>,
            )
            .toList(),
        tools: tools,
        toolChoice: toolChoice,
      ),
    );
    if (replies.isEmpty) throw StateError('No fake reply remains.');
    return replies.removeAt(0);
  }
}

AgentTool _tool({
  String name = 'fixture_tool',
  bool confirm = false,
  Future<Map<String, dynamic>> Function(
    Map<String, dynamic> arguments,
    AgentCancellation cancellation,
  )?
  execute,
}) => AgentTool(
  name: name,
  label: name,
  description: 'Deterministic test tool.',
  parameters: _valueSchema,
  prepare: (arguments, cancellation) async {
    cancellation.check();
    return PreparedAgentTool(
      summary: 'Run $name',
      confirm: confirm,
      preview: {'value': arguments['value']},
      execute: () =>
          execute?.call(arguments, cancellation) ??
          Future.value({'echo': arguments['value']}),
    );
  },
);

AgentCall _call(
  String id, {
  String name = 'fixture_tool',
  String arguments = '{"value":"sample"}',
}) => AgentCall(id: id, name: name, arguments: arguments);

Future<void> _run(
  _FakeTransport transport, {
  List<AgentTool>? tools,
  AgentCancellation? cancellation,
  AgentConfirm? confirm,
  bool requireFirstTool = false,
  bool enableTools = true,
  void Function(Map<String, dynamic>)? onMessage,
  void Function(Map<String, dynamic>)? onTrace,
}) => AgentEngine(transport: transport, tools: tools ?? [_tool()]).run(
  provider: _provider,
  context: const [
    {'role': 'user', 'content': 'fixture request'},
  ],
  cancellation: cancellation ?? AgentCancellation(),
  requireFirstTool: requireFirstTool,
  enableTools: enableTools,
  confirm: confirm,
  onMessage: onMessage ?? (_) {},
  onTrace: onTrace ?? (_) {},
);

void main() {
  group('AgentEngine provider/tool contract', () {
    test(
      'requires a first tool and then returns the exact result by call ID',
      () async {
        final transport = _FakeTransport([
          AgentReply(calls: [_call('call-1')], finishReason: 'tool_calls'),
          const AgentReply(content: 'Finished from the tool result.'),
        ]);
        final messages = <Map<String, dynamic>>[];
        final executions = <String>[];

        await _run(
          transport,
          requireFirstTool: true,
          tools: [
            _tool(
              execute: (arguments, _) async {
                executions.add(arguments['value'] as String);
                return {'echo': arguments['value'], 'source': 'fixture'};
              },
            ),
          ],
          onMessage: messages.add,
        );

        expect(transport.requests, hasLength(2));
        expect(transport.requests.first.toolChoice, 'required');
        expect(transport.requests[1].toolChoice, 'auto');
        expect(
          transport.requests.first.tools.single['function']['name'],
          'fixture_tool',
        );
        expect(executions, ['sample']);

        final roundTrip = transport.requests[1].messages;
        final assistantCall = roundTrip.firstWhere(
          (message) => message['role'] == 'assistant',
        );
        final toolResult = roundTrip.firstWhere(
          (message) => message['role'] == 'tool',
        );
        expect(assistantCall['tool_calls'][0]['id'], 'call-1');
        expect(toolResult['tool_call_id'], 'call-1');
        expect(jsonDecode(toolResult['content']), {
          'ok': true,
          'echo': 'sample',
          'source': 'fixture',
        });
        expect(messages.last['content'], 'Finished from the tool result.');
      },
    );

    test(
      'rejects a required first action when the provider returns prose',
      () async {
        final transport = _FakeTransport([
          const AgentReply(content: 'I can do that now.'),
        ]);
        var executed = false;
        final messages = <Map<String, dynamic>>[];

        await expectLater(
          _run(
            transport,
            requireFirstTool: true,
            tools: [
              _tool(
                execute: (_, _) async {
                  executed = true;
                  return {'ok': true};
                },
              ),
            ],
            onMessage: messages.add,
          ),
          throwsA(isA<AgentException>()),
        );

        expect(transport.requests.single.toolChoice, 'required');
        expect(executed, isFalse);
        expect(messages, isEmpty);
      },
    );

    test(
      'does not execute a tool from prose when the turn is ordinary chat',
      () async {
        final transport = _FakeTransport([
          const AgentReply(
            content: 'Please call fixture_tool with value sample.',
          ),
        ]);
        var executed = false;
        final messages = <Map<String, dynamic>>[];

        await _run(
          transport,
          onMessage: messages.add,
          tools: [
            _tool(
              execute: (_, _) async {
                executed = true;
                return {'ok': true};
              },
            ),
          ],
        );

        expect(executed, isFalse);
        expect(
          messages.single['content'],
          contains('Please call fixture_tool'),
        );
      },
    );

    test(
      'returns malformed JSON as a tool error so the model can correct it',
      () async {
        final transport = _FakeTransport([
          AgentReply(calls: [_call('bad-json', arguments: '{')]),
          AgentReply(
            calls: [_call('corrected', arguments: '{"value":"fixed"}')],
          ),
          const AgentReply(content: 'Corrected and completed.'),
        ]);
        final executed = <String>[];
        final traceEvents = <Map<String, dynamic>>[];

        await _run(
          transport,
          requireFirstTool: true,
          tools: [
            _tool(
              execute: (arguments, _) async {
                executed.add(arguments['value'] as String);
                return {'accepted': true};
              },
            ),
          ],
          onTrace: traceEvents.add,
        );

        expect(executed, ['fixed']);
        final correctionContext = transport.requests[1].messages;
        final badResult = correctionContext.firstWhere(
          (message) =>
              message['role'] == 'tool' &&
              message['tool_call_id'] == 'bad-json',
        );
        expect(jsonDecode(badResult['content'])['error'], contains('有效 JSON'));
        expect(
          traceEvents
              .where((event) => event['callId'] == 'bad-json')
              .last['status'],
          'failed',
        );
        expect(
          traceEvents
              .where((event) => event['callId'] == 'corrected')
              .last['status'],
          'completed',
        );
      },
    );

    test('rejects duplicate call IDs before executing any call', () async {
      final transport = _FakeTransport([
        AgentReply(
          calls: [
            _call('same-id', arguments: '{"value":"first"}'),
            _call('same-id', arguments: '{"value":"second"}'),
          ],
        ),
      ]);
      var executions = 0;

      await expectLater(
        _run(
          transport,
          requireFirstTool: true,
          tools: [
            _tool(
              execute: (_, _) async {
                executions++;
                return {'ok': true};
              },
            ),
          ],
        ),
        throwsA(isA<AgentException>()),
      );

      expect(executions, 0);
      expect(transport.requests, hasLength(1));
    });

    test(
      'does not mark a required action successful if every tool attempt fails',
      () async {
        final transport = _FakeTransport([
          AgentReply(calls: [_call('fail-1')]),
          AgentReply(calls: [_call('fail-2')]),
          const AgentReply(content: 'Here is a guess instead.'),
        ]);
        final messages = <Map<String, dynamic>>[];

        await expectLater(
          _run(
            transport,
            requireFirstTool: true,
            tools: [
              _tool(
                execute: (_, _) async =>
                    throw const AgentException('fixture failure'),
              ),
            ],
            onMessage: messages.add,
          ),
          throwsA(isA<AgentException>()),
        );

        expect(transport.requests, hasLength(3));
        expect(
          messages.where((message) => message['role'] == 'tool'),
          hasLength(2),
        );
        final assistantToolCalls = messages.where(
          (message) => message['role'] == 'assistant',
        );
        expect(assistantToolCalls, hasLength(2));
        expect(
          assistantToolCalls.every((message) => message['content'] == null),
          isTrue,
        );
      },
    );

    test('stops after three consecutive tool failures', () async {
      final transport = _FakeTransport([
        for (var i = 1; i <= 3; i++) AgentReply(calls: [_call('failure-$i')]),
      ]);
      var executions = 0;

      await expectLater(
        _run(
          transport,
          tools: [
            _tool(
              execute: (_, _) async {
                executions++;
                throw const AgentException('fixture failure');
              },
            ),
          ],
        ),
        throwsA(isA<AgentException>()),
      );

      expect(transport.requests, hasLength(3));
      expect(executions, 3);
    });

    test(
      'stops at sixteen provider rounds and preserves completed tool calls',
      () async {
        final transport = _FakeTransport([
          for (var i = 1; i <= 16; i++) AgentReply(calls: [_call('round-$i')]),
        ]);
        var executions = 0;
        final traceEvents = <Map<String, dynamic>>[];

        await expectLater(
          _run(
            transport,
            tools: [
              _tool(
                execute: (_, _) async {
                  executions++;
                  return {'done': true};
                },
              ),
            ],
            onTrace: traceEvents.add,
          ),
          throwsA(isA<AgentException>()),
        );

        expect(transport.requests, hasLength(16));
        expect(executions, 16);
        expect(
          traceEvents.where((event) => event['status'] == 'completed'),
          hasLength(16),
        );
      },
    );

    test(
      'denied or unavailable confirmation never executes a mutating tool',
      () async {
        for (final confirm in <AgentConfirm?>[null, (_, _) async => false]) {
          final transport = _FakeTransport([
            AgentReply(calls: [_call('write-call')]),
          ]);
          var executions = 0;
          final traceEvents = <Map<String, dynamic>>[];

          await expectLater(
            _run(
              transport,
              tools: [
                _tool(
                  confirm: true,
                  execute: (_, _) async {
                    executions++;
                    return {'saved': true};
                  },
                ),
              ],
              confirm: confirm,
              onTrace: traceEvents.add,
            ),
            throwsA(isA<AgentException>()),
          );

          expect(executions, 0);
          expect(traceEvents.last['status'], 'denied');
        }
      },
    );

    test(
      'cancelling a pending approval records that the operation did not run',
      () async {
        final transport = _FakeTransport([
          AgentReply(calls: [_call('waiting-call')]),
        ]);
        final cancellation = AgentCancellation();
        final reachedApproval = Completer<void>();
        final approval = Completer<bool>();
        final traces = <Map<String, dynamic>>[];
        var executions = 0;

        final run = _run(
          transport,
          cancellation: cancellation,
          tools: [
            _tool(
              confirm: true,
              execute: (_, _) async {
                executions++;
                return {'saved': true};
              },
            ),
          ],
          confirm: (_, _) {
            if (!reachedApproval.isCompleted) reachedApproval.complete();
            return approval.future;
          },
          onTrace: traces.add,
        );
        await reachedApproval.future;
        cancellation.cancel();

        await expectLater(run, throwsA(isA<AgentCancelled>()));
        expect(executions, 0);
        expect(traces.last['status'], 'cancelled');
        expect(traces.last['result'], contains('尚未执行'));
      },
    );

    test(
      'cancelling an active operation records that its effect may be uncertain',
      () async {
        final transport = _FakeTransport([
          AgentReply(calls: [_call('active-call')]),
        ]);
        final cancellation = AgentCancellation();
        final enteredTool = Completer<void>();
        final completion = Completer<Map<String, dynamic>>();
        final traces = <Map<String, dynamic>>[];
        final run = _run(
          transport,
          cancellation: cancellation,
          tools: [
            _tool(
              execute: (_, _) {
                enteredTool.complete();
                return completion.future;
              },
            ),
          ],
          onTrace: traces.add,
        );

        await enteredTool.future;
        cancellation.cancel();
        await expectLater(run, throwsA(isA<AgentCancelled>()));

        expect(traces.last['status'], 'cancelled');
        expect(traces.last['result'], contains('可能已经生效'));
        expect(transport.requests, hasLength(1));
        completion.complete({'saved': true});
        await Future<void>.delayed(Duration.zero);
      },
    );

    test(
      'ask_user must be a single call, not batched with a dependent action',
      () async {
        final transport = _FakeTransport([
          AgentReply(
            calls: [
              _call('question', name: 'ask_user'),
              _call('write'),
            ],
          ),
        ]);
        var executions = 0;
        final tools = [
          _tool(
            name: 'ask_user',
            execute: (_, _) async {
              executions++;
              return {'answer': 'yes'};
            },
          ),
          _tool(
            name: 'write',
            execute: (_, _) async {
              executions++;
              return {'saved': true};
            },
          ),
        ];

        await expectLater(
          _run(transport, tools: tools),
          throwsA(isA<AgentException>()),
        );

        expect(executions, 0);
        expect(transport.requests, hasLength(1));
      },
    );

    test(
      'an ask_user cancellation aborts instead of continuing to model prose',
      () async {
        final transport = _FakeTransport([
          AgentReply(calls: [_call('question', name: 'ask_user')]),
          const AgentReply(content: 'I will guess the answer.'),
        ]);
        final cancellation = AgentCancellation();
        final traces = <Map<String, dynamic>>[];
        final askUser = AgentTool(
          name: 'ask_user',
          label: 'Ask user',
          description: 'Ask the user.',
          parameters: _valueSchema,
          prepare: (_, token) async => PreparedAgentTool(
            summary: 'Question',
            execute: () async {
              token.cancel();
              throw const AgentCancelled();
            },
          ),
        );

        await expectLater(
          _run(
            transport,
            cancellation: cancellation,
            tools: [askUser],
            onTrace: traces.add,
          ),
          throwsA(isA<AgentCancelled>()),
        );

        expect(transport.requests, hasLength(1));
        expect(traces.last['status'], 'cancelled');
      },
    );
  });
}

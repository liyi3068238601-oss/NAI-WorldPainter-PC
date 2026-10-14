import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:worldpainter_pc/assistant/agent_contract.dart';
import 'package:worldpainter_pc/assistant/assistant_state.dart';
import 'package:worldpainter_pc/assistant/openai_agent_transport.dart';
import 'package:worldpainter_pc/security/credential_vault.dart';

void main() {
  group('OpenAiAgentTransport', () {
    test(
      'sends a non-streaming completion with required tools unchanged',
      () async {
        final vault = _MemoryVault();
        final provider = _provider(streaming: false);
        await provider.saveSecret(vault, 'assistant-test-secret');
        late http.Request captured;
        final client = MockClient((request) async {
          captured = request;
          return http.Response(
            jsonEncode({
              'choices': [
                {
                  'index': 0,
                  'message': {
                    'role': 'assistant',
                    'content': '完成',
                    'reasoning_content': ' opaque reasoning ',
                  },
                  'finish_reason': 'stop',
                },
              ],
            }),
            200,
            headers: {'content-type': 'application/json'},
          );
        });
        final tools = [
          {
            'type': 'function',
            'function': {
              'name': 'inspect',
              'parameters': {'type': 'object', 'properties': {}},
            },
          },
        ];
        final messages = [
          {'role': 'user', 'content': 'hello'},
        ];

        final reply =
            await OpenAiAgentTransport(
              vault: vault,
              clientFactory: () => client,
            ).complete(
              provider: provider,
              messages: messages,
              tools: tools,
              toolChoice: 'required',
              cancellation: AgentCancellation(),
            );

        final body = jsonDecode(captured.body) as Map<String, dynamic>;
        expect(captured.method, 'POST');
        expect(
          captured.url,
          Uri.https('assistant.example', '/v1/chat/completions'),
        );
        expect(captured.followRedirects, isFalse);
        expect(
          captured.headers['authorization'],
          'Bearer assistant-test-secret',
        );
        expect(body['model'], 'assistant-model');
        expect(body['stream'], isFalse);
        expect(body['messages'], messages);
        expect(body['tools'], tools);
        expect(body['tool_choice'], 'required');
        expect(reply.content, '完成');
        expect(reply.finishReason, 'stop');
        expect(reply.reasoningContent, ' opaque reasoning ');
      },
    );

    test('replays reasoning_content unchanged in the next request', () async {
      final vault = _MemoryVault();
      final provider = _provider(streaming: false, requireKey: false);
      var calls = 0;
      late Map<String, dynamic> secondBody;
      final transport = OpenAiAgentTransport(
        vault: vault,
        clientFactory: () => MockClient.streaming((request, _) async {
          calls++;
          final streamedRequest = request as http.Request;
          if (calls == 2) {
            secondBody =
                jsonDecode(streamedRequest.body) as Map<String, dynamic>;
          }
          final content = calls == 1 ? 'first answer' : 'second answer';
          return _jsonStreamedResponse({
            'choices': [
              {
                'index': 0,
                'message': {
                  'role': 'assistant',
                  'content': content,
                  if (calls == 1) 'reasoning_content': 'opaque / exact',
                },
                'finish_reason': 'stop',
              },
            ],
          });
        }),
      );
      final initialMessages = <Map<String, dynamic>>[
        {'role': 'user', 'content': 'start'},
      ];

      final firstReply = await transport.complete(
        provider: provider,
        messages: initialMessages,
        tools: const [],
        toolChoice: 'none',
        cancellation: AgentCancellation(),
      );
      final assistantMessage = firstReply.toMessage();
      await transport.complete(
        provider: provider,
        messages: [
          ...initialMessages,
          assistantMessage,
          {'role': 'user', 'content': 'continue'},
        ],
        tools: const [],
        toolChoice: 'none',
        cancellation: AgentCancellation(),
      );

      expect(firstReply.reasoningContent, 'opaque / exact');
      expect((secondBody['messages'] as List)[1], {
        'role': 'assistant',
        'content': 'first answer',
        'reasoning_content': 'opaque / exact',
      });
      expect(calls, 2);
    });

    test(
      'accumulates SSE text, reasoning, tools, and a usage-only trailer',
      () async {
        final vault = _MemoryVault();
        final provider = _provider(
          baseUrl: 'https://assistant.example/v1',
          streaming: true,
        );
        await provider.saveSecret(vault, 'stream-test-secret');
        late http.Request captured;
        final event1 = _sse({
          'choices': [
            {
              'index': 0,
              'delta': {
                'content': '你',
                'reasoning_content': 'opaque ',
                'tool_calls': [
                  {
                    'index': 0,
                    'id': 'call-weather',
                    'type': 'function',
                    'function': {'name': 'get_', 'arguments': '{"city":"'},
                  },
                  {
                    'index': 1,
                    'id': 'call-count',
                    'type': 'function',
                    'function': {'name': 'count', 'arguments': '{"n":'},
                  },
                ],
              },
              'finish_reason': null,
            },
          ],
        });
        final event2 = _sse({
          'choices': [
            {
              'index': 0,
              'delta': {
                'content': '好',
                'reasoning_content': 'reasoning',
                'tool_calls': [
                  {
                    'index': 0,
                    'function': {'name': 'weather', 'arguments': '东京"}'},
                  },
                  {
                    'index': 1,
                    'function': {'arguments': '2}'},
                  },
                ],
              },
              'finish_reason': 'stop',
            },
          ],
        });
        final usageTrailer = _sse({
          'choices': <Object?>[],
          'usage': {'prompt_tokens': 8, 'completion_tokens': 5},
        });
        final allBytes = utf8.encode(
          '$event1$event2$usageTrailer${_sseDone()}',
        );
        final chineseByte = allBytes.indexOf(0xe4);
        expect(chineseByte, greaterThanOrEqualTo(0));
        final client = MockClient.streaming((request, _) async {
          captured = request as http.Request;
          return http.StreamedResponse(
            Stream<List<int>>.fromIterable([
              allBytes.sublist(0, chineseByte + 1),
              allBytes.sublist(chineseByte + 1),
            ]),
            200,
            headers: {'content-type': 'text/event-stream; charset=utf-8'},
          );
        });
        final displayedText = <String>[];
        final tool = {
          'type': 'function',
          'function': {
            'name': 'get_weather',
            'parameters': <String, dynamic>{},
          },
        };

        final reply =
            await OpenAiAgentTransport(
              vault: vault,
              clientFactory: () => client,
            ).complete(
              provider: provider,
              messages: const [
                {'role': 'user', 'content': '请处理'},
              ],
              tools: [tool],
              toolChoice: 'auto',
              cancellation: AgentCancellation(),
              onText: displayedText.add,
            );

        final body = jsonDecode(captured.body) as Map<String, dynamic>;
        expect(
          captured.url,
          Uri.https('assistant.example', '/v1/chat/completions'),
        );
        expect(body['stream'], isTrue);
        expect(body['tools'], [tool]);
        expect(body['tool_choice'], 'auto');
        expect(reply.content, '你好');
        expect(displayedText.last, '你好');
        expect(displayedText, ['你', '你好']);
        expect(reply.reasoningContent, 'opaque reasoning');
        expect(reply.finishReason, 'stop');
        expect(reply.calls, hasLength(2));
        expect(reply.calls[0].id, 'call-weather');
        expect(reply.calls[0].name, 'get_weather');
        expect(reply.calls[0].arguments, '{"city":"东京"}');
        expect(reply.calls[1].id, 'call-count');
        expect(reply.calls[1].name, 'count');
        expect(reply.calls[1].arguments, '{"n":2}');
      },
    );

    test('omits tool_choice when no tools were supplied', () async {
      final vault = _MemoryVault();
      final provider = _provider(streaming: false, requireKey: false);
      late Map<String, dynamic> body;
      final client = MockClient.streaming((request, _) async {
        body =
            jsonDecode((request as http.Request).body) as Map<String, dynamic>;
        return _jsonReply('ok');
      });

      await OpenAiAgentTransport(
        vault: vault,
        clientFactory: () => client,
      ).complete(
        provider: provider,
        messages: const [
          {'role': 'user', 'content': 'hello'},
        ],
        tools: const [],
        toolChoice: 'none',
        cancellation: AgentCancellation(),
      );

      expect(body.containsKey('tools'), isFalse);
      expect(body.containsKey('tool_choice'), isFalse);
    });

    test(
      'rejects empty, malformed, and unknown JSON responses explicitly',
      () async {
        for (final entry in {
          '': '空响应',
          '{"choices":': '无效 JSON',
          '{"data":[]}': '响应结构无法识别',
        }.entries) {
          final client = MockClient((_) async => http.Response(entry.key, 200));
          final error = await _captureAgentException(
            OpenAiAgentTransport(
              vault: _MemoryVault(),
              clientFactory: () => client,
            ).complete(
              provider: _provider(streaming: false, requireKey: false),
              messages: const [
                {'role': 'user', 'content': 'hello'},
              ],
              tools: const [],
              toolChoice: 'none',
              cancellation: AgentCancellation(),
            ),
          );
          expect(error.message, contains(entry.value));
        }
      },
    );

    test('caps JSON response bodies at 1 MB', () async {
      final oversizedContent = 'x' * (1024 * 1024 + 1);
      final oversizedResponse = jsonEncode({
        'choices': [
          {
            'index': 0,
            'message': {'role': 'assistant', 'content': oversizedContent},
            'finish_reason': 'stop',
          },
        ],
      });
      final client = MockClient(
        (_) async => http.Response(oversizedResponse, 200),
      );
      final error = await _captureAgentException(
        OpenAiAgentTransport(
          vault: _MemoryVault(),
          clientFactory: () => client,
        ).complete(
          provider: _provider(streaming: false, requireKey: false),
          messages: const [
            {'role': 'user', 'content': 'hello'},
          ],
          tools: const [],
          toolChoice: 'none',
          cancellation: AgentCancellation(),
        ),
      );

      expect(error.message, contains('1 MB'));
    });

    test('caps SSE response bodies at 1 MB before returning a reply', () async {
      final oversizedContent = 'x' * (1024 * 1024 + 1);
      final event = _sse({
        'choices': [
          {
            'index': 0,
            'delta': {'content': oversizedContent},
            'finish_reason': 'stop',
          },
        ],
      });
      final client = MockClient.streaming(
        (_, _) async => http.StreamedResponse(
          Stream<List<int>>.value(utf8.encode('$event${_sseDone()}')),
          200,
          headers: {'content-type': 'text/event-stream'},
        ),
      );
      final error = await _captureAgentException(
        OpenAiAgentTransport(
          vault: _MemoryVault(),
          clientFactory: () => client,
        ).complete(
          provider: _provider(streaming: true, requireKey: false),
          messages: const [
            {'role': 'user', 'content': 'hello'},
          ],
          tools: const [],
          toolChoice: 'none',
          cancellation: AgentCancellation(),
        ),
      );

      expect(error.message, contains('1 MB'));
    });

    test(
      'does not retry without tools after an HTTP error and sanitizes details',
      () async {
        final vault = _MemoryVault();
        final provider = _provider(streaming: false);
        await provider.saveSecret(vault, 'never-echo-this-key');
        var calls = 0;
        late Map<String, dynamic> body;
        final client = MockClient((request) async {
          calls++;
          body = jsonDecode(request.body) as Map<String, dynamic>;
          return http.Response(
            'private error body with never-echo-this-key',
            400,
            headers: {'x-private-header': 'never-echo-this-key'},
          );
        });

        await expectLater(
          OpenAiAgentTransport(
            vault: vault,
            clientFactory: () => client,
          ).complete(
            provider: provider,
            messages: const [
              {'role': 'user', 'content': 'hello'},
            ],
            tools: const [
              {
                'type': 'function',
                'function': {'name': 'inspect', 'parameters': {}},
              },
            ],
            toolChoice: 'required',
            cancellation: AgentCancellation(),
          ),
          throwsA(
            isA<AgentException>()
                .having(
                  (error) => error.message,
                  'message',
                  contains('HTTP 400'),
                )
                .having(
                  (error) => error.message,
                  'message',
                  isNot(contains('never-echo-this-key')),
                )
                .having(
                  (error) => error.message,
                  'message',
                  isNot(contains('private error body')),
                ),
          ),
        );
        expect(calls, 1);
        expect(body['tools'], hasLength(1));
        expect(body['tool_choice'], 'required');
      },
    );

    test('maps unauthorized and rate limited statuses without exposing response bodies', () async {
      for (final status in [401, 429, 422]) {
        final client = MockClient(
          (_) async => http.Response('secret-status-$status-body', status),
        );
        final error = await _captureAgentException(
          OpenAiAgentTransport(
            vault: _MemoryVault(),
            clientFactory: () => client,
          ).complete(
            provider: _provider(streaming: false, requireKey: false),
            messages: const [
              {'role': 'user', 'content': 'hello'},
            ],
            tools: const [],
            toolChoice: 'auto',
            cancellation: AgentCancellation(),
          ),
        );
        expect(error.message, contains('HTTP $status'));
        expect(error.message, isNot(contains('secret-status')));
      }
    });

    test(
      'requires a complete finish marker before returning streamed tool calls',
      () async {
        final truncated = _sse({
          'choices': [
            {
              'index': 0,
              'delta': {
                'tool_calls': [
                  {
                    'index': 0,
                    'id': 'call-not-finished',
                    'type': 'function',
                    'function': {'name': 'inspect', 'arguments': '{}'},
                  },
                ],
              },
              'finish_reason': 'stop',
            },
          ],
        });
        final client = MockClient.streaming(
          (_, _) async => http.StreamedResponse(
            Stream<List<int>>.value(utf8.encode(truncated)),
            200,
            headers: {'content-type': 'text/event-stream'},
          ),
        );

        await expectLater(
          OpenAiAgentTransport(
            vault: _MemoryVault(),
            clientFactory: () => client,
          ).complete(
            provider: _provider(streaming: true, requireKey: false),
            messages: const [
              {'role': 'user', 'content': 'hello'},
            ],
            tools: const [
              {
                'type': 'function',
                'function': {'name': 'inspect', 'parameters': {}},
              },
            ],
            toolChoice: 'auto',
            cancellation: AgentCancellation(),
          ),
          throwsA(
            isA<AgentException>().having(
              (error) => error.message,
              'message',
              contains('未完整结束'),
            ),
          ),
        );
      },
    );

    test('unsupported finish reasons never return tool calls', () async {
      for (final reason in ['length', 'content_filter', 'future_reason']) {
        final choice = {
          'index': 0,
          'message': {
            'role': 'assistant',
            'content': null,
            'tool_calls': [
              {
                'id': 'call-$reason',
                'type': 'function',
                'function': {'name': 'inspect', 'arguments': '{}'},
              },
            ],
          },
          'finish_reason': reason,
        };
        final jsonClient = MockClient(
          (_) async => http.Response(
            jsonEncode({
              'choices': [choice],
            }),
            200,
          ),
        );
        final jsonError = await _captureAgentException(
          OpenAiAgentTransport(
            vault: _MemoryVault(),
            clientFactory: () => jsonClient,
          ).complete(
            provider: _provider(streaming: false, requireKey: false),
            messages: const [
              {'role': 'user', 'content': 'hello'},
            ],
            tools: const [
              {
                'type': 'function',
                'function': {'name': 'inspect', 'parameters': {}},
              },
            ],
            toolChoice: 'required',
            cancellation: AgentCancellation(),
          ),
        );
        expect(jsonError.message, contains('不会执行工具调用'));

        final sseEvent = _sse({
          'choices': [
            {
              'index': 0,
              'delta': {
                'tool_calls': [
                  {
                    'index': 0,
                    'id': 'call-$reason',
                    'type': 'function',
                    'function': {'name': 'inspect', 'arguments': '{}'},
                  },
                ],
              },
              'finish_reason': reason,
            },
          ],
        });
        final sseClient = MockClient.streaming(
          (_, _) async => http.StreamedResponse(
            Stream<List<int>>.value(utf8.encode('$sseEvent${_sseDone()}')),
            200,
            headers: {'content-type': 'text/event-stream'},
          ),
        );
        final sseError = await _captureAgentException(
          OpenAiAgentTransport(
            vault: _MemoryVault(),
            clientFactory: () => sseClient,
          ).complete(
            provider: _provider(streaming: true, requireKey: false),
            messages: const [
              {'role': 'user', 'content': 'hello'},
            ],
            tools: const [
              {
                'type': 'function',
                'function': {'name': 'inspect', 'parameters': {}},
              },
            ],
            toolChoice: 'required',
            cancellation: AgentCancellation(),
          ),
        );
        expect(sseError.message, contains('结束信息无法识别'));
      }
    });

    test('rejects a reasoning-only answer as empty', () async {
      final client = MockClient(
        (_) async => http.Response(
          jsonEncode({
            'choices': [
              {
                'index': 0,
                'message': {
                  'role': 'assistant',
                  'content': null,
                  'reasoning_content': 'opaque reasoning',
                },
                'finish_reason': 'stop',
              },
            ],
          }),
          200,
        ),
      );

      final error = await _captureAgentException(
        OpenAiAgentTransport(
          vault: _MemoryVault(),
          clientFactory: () => client,
        ).complete(
          provider: _provider(streaming: false, requireKey: false),
          messages: const [
            {'role': 'user', 'content': 'hello'},
          ],
          tools: const [],
          toolChoice: 'none',
          cancellation: AgentCancellation(),
        ),
      );

      expect(error.message, contains('空响应'));
    });

    test(
      'cancellation closes the active client and ignores its late response',
      () async {
        final response = Completer<http.Response>();
        final started = Completer<void>();
        final trackingClient = _TrackingClient(
          MockClient((_) {
            started.complete();
            return response.future;
          }),
        );
        final cancellation = AgentCancellation();
        final pending =
            OpenAiAgentTransport(
              vault: _MemoryVault(),
              clientFactory: () => trackingClient,
            ).complete(
              provider: _provider(streaming: false, requireKey: false),
              messages: const [
                {'role': 'user', 'content': 'hello'},
              ],
              tools: const [],
              toolChoice: 'auto',
              cancellation: cancellation,
            );
        await started.future;
        cancellation.cancel();
        await expectLater(pending, throwsA(isA<AgentCancelled>()));
        expect(trackingClient.closed, isTrue);
        response.complete(http.Response('late response', 200));
      },
    );

    test('timeout closes the client without retrying', () async {
      final response = Completer<http.Response>();
      final started = Completer<void>();
      final trackingClient = _TrackingClient(
        MockClient((_) {
          started.complete();
          return response.future;
        }),
      );
      var factoryCalls = 0;
      final pending =
          OpenAiAgentTransport(
            vault: _MemoryVault(),
            timeout: const Duration(milliseconds: 100),
            clientFactory: () {
              factoryCalls++;
              return trackingClient;
            },
          ).complete(
            provider: _provider(streaming: false, requireKey: false),
            messages: const [
              {'role': 'user', 'content': 'hello'},
            ],
            tools: const [],
            toolChoice: 'auto',
            cancellation: AgentCancellation(),
          );
      await started.future;

      await expectLater(
        pending,
        throwsA(
          isA<AgentException>().having(
            (error) => error.message,
            'message',
            contains('超时'),
          ),
        ),
      );
      expect(trackingClient.closed, isTrue);
      expect(factoryCalls, 1);
      response.complete(http.Response('late response', 200));
    });

    test('assistant credentials are isolated by provider endpoint', () async {
      final vault = _MemoryVault();
      final first = _provider(
        id: 'same-provider',
        baseUrl: 'https://one.example/v1',
        streaming: false,
      );
      final second = _provider(
        id: 'same-provider',
        baseUrl: 'https://two.example/v1/chat/completions',
        streaming: false,
      );
      await first.saveSecret(vault, 'one-endpoint-key');
      await second.saveSecret(vault, 'two-endpoint-key');
      final authorization = <String?>[];
      http.Client createClient() => MockClient.streaming((request, _) async {
        authorization.add(request.headers['authorization']);
        return _jsonReply('ok');
      });
      final transport = OpenAiAgentTransport(
        vault: vault,
        clientFactory: createClient,
      );

      for (final provider in [first, second]) {
        await transport.complete(
          provider: provider,
          messages: const [
            {'role': 'user', 'content': 'hello'},
          ],
          tools: const [],
          toolChoice: 'auto',
          cancellation: AgentCancellation(),
        );
      }

      expect(first.credentialKey, isNot(second.credentialKey));
      expect(authorization, [
        'Bearer one-endpoint-key',
        'Bearer two-endpoint-key',
      ]);
      expect(vault.readProviders, everyElement('assistant'));
      expect(vault.readKeys.toSet(), {
        first.credentialKey,
        second.credentialKey,
      });
    });

    test('lists models from the normalized models endpoint', () async {
      final provider = _provider(
        baseUrl: 'https://assistant.example/v1/chat/completions',
        streaming: false,
        requireKey: false,
      );
      late http.Request captured;
      final client = MockClient((request) async {
        captured = request;
        return http.Response(
          jsonEncode({
            'data': [
              {'id': 'model-a'},
              {'id': 'model-b'},
            ],
          }),
          200,
        );
      });

      final models = await OpenAiAgentTransport(
        vault: _MemoryVault(),
        clientFactory: () => client,
      ).listModels(provider, AgentCancellation());

      expect(captured.method, 'GET');
      expect(captured.url, Uri.https('assistant.example', '/v1/models'));
      expect(models, ['model-a', 'model-b']);
    });

    test(
      'persists a non-loopback HTTP provider and uses its models and chat URLs',
      () async {
        final vault = _MemoryVault();
        final provider = _provider(
          id: 'remote-http',
          baseUrl: 'http://models.example:8123/tenant/v1/chat/completions',
        );
        await provider.saveSecret(vault, 'remote-http-secret');
        final state = AssistantState(
          providers: [provider],
          mainProviderId: provider.id,
        );

        final serialized = jsonEncode(state.toJson());
        expect(serialized, isNot(contains('remote-http-secret')));
        final restored = AssistantState.fromJson(
          jsonDecode(serialized) as Map<String, dynamic>,
        );
        final restoredProvider = restored.mainProvider!;
        expect(
          restoredProvider.baseUrl,
          'http://models.example:8123/tenant/v1',
        );
        expect(
          restoredProvider.apiRoot,
          Uri.parse('http://models.example:8123/tenant/v1'),
        );
        expect(restoredProvider.credentialKey, provider.credentialKey);

        final requests = <http.Request>[];
        final transport = OpenAiAgentTransport(
          vault: vault,
          clientFactory: () => MockClient((request) async {
            requests.add(request);
            if (request.method == 'GET') {
              return http.Response(
                jsonEncode({
                  'data': [
                    {'id': 'remote-model'},
                  ],
                }),
                200,
              );
            }
            return http.Response(
              jsonEncode({
                'choices': [
                  {
                    'index': 0,
                    'message': {'role': 'assistant', 'content': 'done'},
                    'finish_reason': 'stop',
                  },
                ],
              }),
              200,
            );
          }),
        );

        expect(
          await transport.listModels(restoredProvider, AgentCancellation()),
          ['remote-model'],
        );
        final reply = await transport.complete(
          provider: restoredProvider,
          messages: const [
            {'role': 'user', 'content': 'hello'},
          ],
          tools: const [],
          toolChoice: 'auto',
          cancellation: AgentCancellation(),
        );

        expect(reply.content, 'done');
        expect(requests.map((request) => request.method), ['GET', 'POST']);
        expect(requests.map((request) => request.url), [
          Uri.parse('http://models.example:8123/tenant/v1/models'),
          Uri.parse('http://models.example:8123/tenant/v1/chat/completions'),
        ]);
        expect(
          requests.map((request) => request.headers['authorization']),
          everyElement('Bearer remote-http-secret'),
        );
      },
    );

    test(
      'scopes credentials independently by scheme, host, and port',
      () async {
        final vault = _MemoryVault();
        final providers = [
          _provider(id: 'same-id', baseUrl: 'http://shared.example:8123/v1'),
          _provider(id: 'same-id', baseUrl: 'https://shared.example:8123/v1'),
          _provider(id: 'same-id', baseUrl: 'http://shared.example:8124/v1'),
          _provider(id: 'same-id', baseUrl: 'http://other.example:8123/v1'),
        ];
        const secrets = [
          'http-key',
          'https-key',
          'other-port-key',
          'other-host-key',
        ];
        for (var index = 0; index < providers.length; index++) {
          await providers[index].saveSecret(vault, secrets[index]);
        }

        final requests = <http.Request>[];
        final transport = OpenAiAgentTransport(
          vault: vault,
          clientFactory: () => MockClient((request) async {
            requests.add(request);
            return http.Response(
              jsonEncode({
                'choices': [
                  {
                    'index': 0,
                    'message': {'role': 'assistant', 'content': 'ok'},
                    'finish_reason': 'stop',
                  },
                ],
              }),
              200,
            );
          }),
        );

        for (final provider in providers) {
          await transport.complete(
            provider: provider,
            messages: const [
              {'role': 'user', 'content': 'hello'},
            ],
            tools: const [],
            toolChoice: 'auto',
            cancellation: AgentCancellation(),
          );
        }

        expect(
          providers.map((provider) => provider.credentialKey).toSet(),
          hasLength(4),
        );
        expect(requests.map((request) => request.url), [
          Uri.parse('http://shared.example:8123/v1/chat/completions'),
          Uri.parse('https://shared.example:8123/v1/chat/completions'),
          Uri.parse('http://shared.example:8124/v1/chat/completions'),
          Uri.parse('http://other.example:8123/v1/chat/completions'),
        ]);
        expect(
          requests.map((request) => request.headers['authorization']),
          secrets.map((secret) => 'Bearer $secret'),
        );
        expect(
          vault.readKeys,
          providers.map((provider) => provider.credentialKey),
        );
      },
    );

    test('disables redirects for model and chat requests', () async {
      final requests = <http.Request>[];
      final transport = OpenAiAgentTransport(
        vault: _MemoryVault(),
        clientFactory: () => MockClient((request) async {
          requests.add(request);
          return http.Response(
            'redirect body',
            302,
            headers: {'location': 'https://redirect.example/steal-key'},
          );
        }),
      );
      final provider = _provider(
        baseUrl: 'http://remote.example:8123/v1',
        requireKey: false,
      );

      final modelsError = await _captureAgentException(
        transport.listModels(provider, AgentCancellation()),
      );
      final chatError = await _captureAgentException(
        transport.complete(
          provider: provider,
          messages: const [
            {'role': 'user', 'content': 'hello'},
          ],
          tools: const [],
          toolChoice: 'auto',
          cancellation: AgentCancellation(),
        ),
      );

      expect(modelsError.message, contains('重定向'));
      expect(chatError.message, contains('重定向'));
      expect(requests.map((request) => request.method), ['GET', 'POST']);
      expect(requests, everyElement(isA<http.Request>()));
      expect(
        requests.map((request) => request.followRedirects),
        everyElement(isFalse),
      );
      expect(requests.map((request) => request.maxRedirects), everyElement(0));
    });

    test('rejects non-HTTP schemes and unsafe URL components', () {
      for (final baseUrl in [
        'ftp://models.example/v1',
        'file:///models',
        'http:///v1',
        'https://user:password@models.example/v1',
        'http://models.example/v1?api_key=secret',
        'https://models.example/v1#fragment',
      ]) {
        expect(
          () => _provider(baseUrl: baseUrl).validate(),
          throwsA(isA<AgentException>()),
          reason: 'must reject $baseUrl',
        );
      }
    });
  });
}

AssistantProvider _provider({
  String id = 'test-provider',
  String baseUrl = 'https://assistant.example/v1',
  bool streaming = false,
  bool requireKey = true,
}) => AssistantProvider(
  id: id,
  name: 'Assistant test',
  baseUrl: baseUrl,
  model: 'assistant-model',
  streaming: streaming,
  requireKey: requireKey,
);

http.StreamedResponse _jsonReply(String content) => http.StreamedResponse(
  Stream<List<int>>.value(
    utf8.encode(
      jsonEncode({
        'choices': [
          {
            'index': 0,
            'message': {'role': 'assistant', 'content': content},
            'finish_reason': 'stop',
          },
        ],
      }),
    ),
  ),
  200,
  headers: {'content-type': 'application/json'},
);

http.StreamedResponse _jsonStreamedResponse(Map<String, dynamic> body) =>
    http.StreamedResponse(
      Stream<List<int>>.value(utf8.encode(jsonEncode(body))),
      200,
      headers: {'content-type': 'application/json'},
    );

String _sse(Map<String, dynamic> event) => 'data: ${jsonEncode(event)}\n\n';

String _sseDone() => 'data: [DONE]\n\n';

Future<AgentException> _captureAgentException(Future<Object?> future) async {
  try {
    await future;
  } on AgentException catch (error) {
    return error;
  }
  throw StateError('Expected AgentException.');
}

class _MemoryVault implements CredentialVault {
  final Map<String, String> values = {};
  final List<String> readProviders = [];
  final List<String> readKeys = [];

  String _key(String provider, String key) => '$provider|$key';

  @override
  Future<String?> read({required String provider, required String key}) async {
    readProviders.add(provider);
    readKeys.add(key);
    return values[_key(provider, key)];
  }

  @override
  Future<void> save({
    required String provider,
    required String key,
    required String secret,
  }) async {
    values[_key(provider, key)] = secret;
  }

  @override
  Future<void> delete({required String provider, required String key}) async {
    values.remove(_key(provider, key));
  }
}

class _TrackingClient extends http.BaseClient {
  _TrackingClient(this.inner);

  final http.Client inner;
  bool closed = false;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) =>
      inner.send(request);

  @override
  void close() {
    closed = true;
    inner.close();
  }
}

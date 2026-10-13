import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:worldpainter_pc/assistant/agent_contract.dart';
import 'package:worldpainter_pc/assistant/agent_engine.dart';
import 'package:worldpainter_pc/assistant/openai_agent_transport.dart';
import 'package:worldpainter_pc/assistant/workspace_tools.dart';
import 'package:worldpainter_pc/prompts/prompt_insertion.dart';
import 'package:worldpainter_pc/prototype/workbench_controller.dart';
import 'package:worldpainter_pc/security/credential_vault.dart';

void main() {
  test('real IO transport completes a confirmed workspace tool loopback', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final requestBodies = <Map<String, dynamic>>[];
    final requestMethods = <String>[];
    final requestPaths = <String>[];
    final authorizationHeaders = <String?>[];
    final remoteAddresses = <InternetAddress?>[];
    final serverErrors = <Object>[];

    Future<void> handleRequest(HttpRequest request) async {
      try {
        final body = jsonDecode(
          await utf8.decoder.bind(request).join(),
        ) as Map<String, dynamic>;
        requestBodies.add(body);
        requestMethods.add(request.method);
        requestPaths.add(request.uri.path);
        authorizationHeaders.add(
          request.headers.value(HttpHeaders.authorizationHeader),
        );
        remoteAddresses.add(request.connectionInfo?.remoteAddress);

        final List<Map<String, dynamic>> events = switch (requestBodies
            .length) {
          1 => [
            {
              'choices': [
                {
                  'index': 0,
                  'delta': {
                    'tool_calls': [
                      {
                        'index': 0,
                        'id': 'read-call-id',
                        'type': 'function',
                        'function': {
                          'name': 'read_current_prompts',
                          'arguments': '{}',
                        },
                      },
                    ],
                  },
                  'finish_reason': 'tool_calls',
                },
              ],
            },
          ],
          2 => [
            {
              'choices': [
                {
                  'index': 0,
                  'delta': {
                    'tool_calls': [
                      {
                        'index': 0,
                        'id': 'write-call-id',
                        'type': 'function',
                        'function': {
                          'name': 'write_prompt',
                          'arguments': '{"target":"positive","content":"loopback suffix",',
                        },
                      },
                    ],
                  },
                  'finish_reason': null,
                },
              ],
            },
            {
              'choices': [
                {
                  'index': 0,
                  'delta': {
                    'tool_calls': [
                      {
                        'index': 0,
                        'function': {'arguments': '"mode":"append"}'},
                      },
                    ],
                  },
                  'finish_reason': 'tool_calls',
                },
              ],
            },
          ],
          _ => [
            {
              'choices': [
                {
                  'index': 0,
                  'delta': {
                    'content': 'The prompt was appended in the local draft.',
                  },
                  'finish_reason': 'stop',
                },
              ],
            },
          ],
        };
        await _sendSseEvents(request.response, events);
      } catch (error) {
        serverErrors.add(error);
        try {
          request.response.statusCode = HttpStatus.internalServerError;
          await request.response.close();
        } catch (_) {
          // The client may already have closed the failed exchange.
        }
      }
    }

    final serverSubscription = server.listen(
      (request) => unawaited(handleRequest(request)),
      onError: (Object error, StackTrace _) => serverErrors.add(error),
    );
    WorkbenchController? workbench;
    try {
      final vault = _MemoryVault();
      final provider = AssistantProvider(
        id: 'loopback-fixture',
        name: 'Loopback fixture',
        baseUrl:
            'http://${server.address.address}:${server.port}/v1/chat/completions',
        model: 'synthetic-model',
        streaming: true,
      );
      expect(provider.apiRoot.host, '127.0.0.1');
      await provider.saveSecret(vault, 'loopback-only-test-key');
      final activeWorkbench = WorkbenchController(
        generationDelay: Duration.zero,
      )..updatePrompt('base prompt');
      workbench = activeWorkbench;

      final confirmedCallIds = <String>[];
      final confirmationPreviews = <Map<String, dynamic>>[];
      final emittedMessages = <Map<String, dynamic>>[];
      final traces = <Map<String, dynamic>>[];
      final appendedPrompt = appendPromptText('base prompt', 'loopback suffix');

      await HttpOverrides.runWithHttpOverrides(() async {
        await AgentEngine(
          transport: OpenAiAgentTransport(
            vault: vault,
            timeout: const Duration(seconds: 10),
          ),
          tools: WorkspaceAgentTools(activeWorkbench).build(),
        ).run(
          provider: provider,
          context: const [
            {'role': 'user', 'content': 'Read the prompt and append a suffix.'},
          ],
          cancellation: AgentCancellation(),
          requireFirstTool: true,
          confirm: (call, plan) async {
            confirmedCallIds.add(call.id);
            confirmationPreviews.add(plan.preview);
            return true;
          },
          onMessage: emittedMessages.add,
          onTrace: traces.add,
        );
      }, _RealHttpClientOverrides());

      expect(serverErrors, isEmpty);
      expect(requestBodies, hasLength(3));
      expect(requestMethods, everyElement('POST'));
      expect(requestPaths, everyElement('/v1/chat/completions'));
      expect(
        authorizationHeaders,
        everyElement('Bearer loopback-only-test-key'),
      );
      expect(remoteAddresses, everyElement(isNotNull));
      expect(remoteAddresses.every((address) => address!.isLoopback), isTrue);

      final firstBody = requestBodies[0];
      expect(firstBody['tool_choice'], 'required');
      final advertisedTools = (firstBody['tools'] as List)
          .map((tool) => (tool as Map)['function']['name'])
          .toSet();
      expect(
        advertisedTools,
        containsAll(['read_current_prompts', 'write_prompt']),
      );

      final secondMessages = requestBodies[1]['messages'] as List;
      final readToolResult = secondMessages.cast<Map>().firstWhere(
        (message) =>
            message['role'] == 'tool' &&
            message['tool_call_id'] == 'read-call-id',
      );
      expect(
        jsonDecode(readToolResult['content'] as String),
        containsPair('positive', 'base prompt'),
      );

      expect(confirmedCallIds, ['write-call-id']);
      expect(confirmationPreviews.single['修改前'], 'base prompt');
      expect(confirmationPreviews.single['修改后'], appendedPrompt);
      expect(activeWorkbench.parameters.prompt, appendedPrompt);

      final thirdMessages = requestBodies[2]['messages'] as List;
      final writeAssistantMessage = thirdMessages.cast<Map>().firstWhere(
        (message) =>
            message['role'] == 'assistant' &&
            (message['tool_calls'] as List?)?.any(
                  (call) => call['id'] == 'write-call-id',
                ) ==
                true,
      );
      expect(
        (writeAssistantMessage['tool_calls'] as List)
            .single['function']['arguments'],
        '{"target":"positive","content":"loopback suffix","mode":"append"}',
      );
      final writeToolResult = thirdMessages.cast<Map>().firstWhere(
        (message) =>
            message['role'] == 'tool' &&
            message['tool_call_id'] == 'write-call-id',
      );
      final writeResult = jsonDecode(writeToolResult['content'] as String);
      expect(writeResult, containsPair('ok', true));
      expect(writeResult, containsPair('saved', true));
      expect(writeResult, containsPair('content', appendedPrompt));

      expect(emittedMessages.last, {
        'role': 'assistant',
        'content': 'The prompt was appended in the local draft.',
      });
      expect(
        traces.lastWhere(
          (trace) => trace['callId'] == 'write-call-id',
        )['status'],
        'completed',
      );
    } finally {
      workbench?.dispose();
      await serverSubscription.cancel();
      await server.close(force: true);
    }
  });
}

Future<void> _sendSseEvents(
  HttpResponse response,
  List<Map<String, dynamic>> events,
) async {
  response.headers.contentType = ContentType(
    'text',
    'event-stream',
    charset: 'utf-8',
  );
  response.headers.set(HttpHeaders.cacheControlHeader, 'no-cache');
  for (final event in events) {
    response.add(utf8.encode('data: ${jsonEncode(event)}\n\n'));
    await response.flush();
  }
  response.add(utf8.encode('data: [DONE]\n\n'));
  await response.close();
}

class _RealHttpClientOverrides extends HttpOverrides {}

class _MemoryVault implements CredentialVault {
  final Map<String, String> _secrets = {};

  String _key(String provider, String key) => '$provider|$key';

  @override
  Future<String?> read({required String provider, required String key}) async =>
      _secrets[_key(provider, key)];

  @override
  Future<void> save({
    required String provider,
    required String key,
    required String secret,
  }) async {
    _secrets[_key(provider, key)] = secret;
  }

  @override
  Future<void> delete({required String provider, required String key}) async {
    _secrets.remove(_key(provider, key));
  }
}

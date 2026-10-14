import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:worldpainter_pc/assistant/agent_contract.dart';
import 'package:worldpainter_pc/assistant/agent_engine.dart';
import 'package:worldpainter_pc/assistant/openai_agent_transport.dart';
import 'package:worldpainter_pc/assistant/workspace_tools.dart';
import 'package:worldpainter_pc/prototype/workbench_controller.dart';
import 'package:worldpainter_pc/security/credential_vault.dart';

import '../support/tag_agent_fixture.dart';

void main() {
  test(
    'real loopback HTTP joins SSE tools, memory, tag index and approved write',
    () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      final root = 'http://127.0.0.1:${server.port}';
      final errors = <Object>[];
      final paths = <String>[];
      var round = 0;
      Future<void> handle(HttpRequest req) async {
        try {
          paths.add(req.uri.path);
          expect(req.connectionInfo!.remoteAddress.isLoopback, true);
          expect(req.headers.value('authorization'), isNull);
          final body = jsonDecode(await utf8.decoder.bind(req).join()) as Map;
          if (req.uri.path == '/api/search') {
            expect(body, {
              'query': '星璃 月光森林',
              'top_k': 5,
              'limit': 5,
              'show_nsfw': false,
            });
            req.response.headers.contentType = ContentType.json;
            req.response.add(
              utf8.encode(
                jsonEncode({
                  'results': tagFixtureTags.map((t) => t.toJson()).toList(),
                }),
              ),
            );
            await req.response.close();
            return;
          }
          expect(req.uri.path, '/v1/chat/completions');
          round++;
          final messages = (body['messages'] as List).cast<Map>();
          if (round > 1) {
            expect(messages.last['tool_call_id'], 'loop-${round - 1}');
            final result =
                jsonDecode(messages.last['content'] as String) as Map;
            expect(result['ok'], true);
            if (round == 3) expect(result['count'], 1);
            if (round == 4) {
              expect(result['source'], root);
              expect(result['query'], '星璃 月光森林');
              expect((result['tags'] as List).map((e) => e['tag']), [
                'silver_hair',
                'moonlight',
                'forest',
              ]);
            }
            if (round == 5) expect(result['saved'], true);
          }
          final schemaNames = (body['tools'] as List).map(
            (e) => e['function']['name'],
          );
          expect(schemaNames, containsAll(['get_memories', 'search_danbooru']));
          final (name, args) = switch (round) {
            1 => ('read_current_prompts', <String, Object?>{}),
            2 => ('get_memories', <String, Object?>{'query': '星璃'}),
            3 => (
              'search_danbooru',
              <String, Object?>{
                'query': '星璃 月光森林',
                'limit': 5,
                'show_nsfw': false,
              },
            ),
            _ => (
              'write_prompt',
              <String, Object?>{
                'target': 'positive',
                'content': tagFixtureSuffix,
                'mode': 'append',
              },
            ),
          };
          final arguments = jsonEncode(args);
          final split = arguments.length ~/ 2;
          req.response.headers.contentType = ContentType(
            'text',
            'event-stream',
            charset: 'utf-8',
          );
          void event(Map<String, Object?> delta, String? finish) {
            req.response.add(
              utf8.encode(
                'data: ${jsonEncode({
                  'choices': [
                    {'index': 0, 'delta': delta, 'finish_reason': finish},
                  ],
                })}\n\n',
              ),
            );
          }

          if (round <= 4) {
            event({
              'tool_calls': [
                {
                  'index': 0,
                  'id': 'loop-$round',
                  'type': 'function',
                  'function': {
                    'name': name,
                    'arguments': arguments.substring(0, split),
                  },
                },
              ],
            }, null);
            await req.response.flush();
            event({
              'tool_calls': [
                {
                  'index': 0,
                  'function': {'arguments': arguments.substring(split)},
                },
              ],
            }, 'tool_calls');
          } else {
            event({'content': '合成全链完成。'}, 'stop');
          }
          req.response.add(utf8.encode('data: [DONE]\n\n'));
          await req.response.close();
        } catch (e) {
          errors.add(e);
          req.response.statusCode = 500;
          await req.response.close();
        }
      }

      final subscription = server.listen(
        (request) => unawaited(handle(request)),
      );
      final c = WorkbenchController();
      configureTagFixture(c);
      c.configureTagSearch(baseUrl: root, showNsfw: false);
      final traces = <Map<String, dynamic>>[];
      var confirmations = 0;
      try {
        await HttpOverrides.runWithHttpOverrides(
          () =>
              AgentEngine(
                transport: OpenAiAgentTransport(vault: _NoCredentials()),
                tools: WorkspaceAgentTools(c).build(),
              ).run(
                provider: AssistantProvider(
                  id: 'loop',
                  name: 'loop',
                  baseUrl: '$root/v1',
                  model: 'synthetic',
                  requireKey: false,
                ),
                context: const [
                  {'role': 'user', 'content': tagFixtureInput},
                ],
                cancellation: AgentCancellation(),
                requireFirstTool: true,
                onMessage: (_) {},
                onTrace: traces.add,
                confirm: (call, plan) async {
                  confirmations++;
                  expect(call.name, 'write_prompt');
                  expect(c.prompt, 'synthetic base prompt');
                  expect(
                    plan.preview['修改后'],
                    'synthetic base prompt, $tagFixtureSuffix',
                  );
                  return true;
                },
              ),
          _RealHttp(),
        );
        expect(errors, isEmpty);
        expect(paths, [
          '/v1/chat/completions',
          '/v1/chat/completions',
          '/v1/chat/completions',
          '/api/search',
          '/v1/chat/completions',
          '/v1/chat/completions',
        ]);
        expect(confirmations, 1);
        expect(c.prompt, 'synthetic base prompt, $tagFixtureSuffix');
        expect(traces.where((t) => t['status'] == 'completed'), hasLength(4));
      } finally {
        c.dispose();
        await subscription.cancel();
        await server.close(force: true);
      }
    },
  );
}

class _RealHttp extends HttpOverrides {}

class _NoCredentials implements CredentialVault {
  @override
  Future<String?> read({required String provider, required String key}) async =>
      null;
  @override
  Future<void> save({
    required String provider,
    required String key,
    required String secret,
  }) async => throw StateError('No key expected');
  @override
  Future<void> delete({required String provider, required String key}) async =>
      throw StateError('No key expected');
}

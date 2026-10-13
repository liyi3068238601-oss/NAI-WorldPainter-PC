import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';

import 'package:worldpainter_pc/assistant/assistant_state.dart';
import 'package:worldpainter_pc/assistant/agent_contract.dart';

void main() {
  group('AssistantState persistence', () {
    test(
      'round-trips Chinese prompts, weighted text, and tool wire messages',
      () {
        final provider = _provider();
        final turn = AssistantTurn(
          id: 'turn-1',
          userText: '请看这张图，角色权重 {{char::星璃::1.2}}',
          attachments: [_imageRef()],
          status: 'complete',
          messages: [
            {
              'role': 'assistant',
              'content': null,
              'tool_calls': [
                {
                  'id': 'call-1',
                  'type': 'function',
                  'function': {
                    'name': 'read_current_prompts',
                    'arguments': '{}',
                  },
                },
              ],
            },
            {
              'role': 'tool',
              'tool_call_id': 'call-1',
              'content': '主提示词：{{tag::星璃}}',
            },
          ],
          traces: [
            {
              'callId': 'call-1',
              'name': 'read_current_prompts',
              'arguments': {'target': 'main'},
              'result': {'content': '主提示词：{{tag::星璃}}'},
              'status': 'completed',
              'durationMs': 17,
            },
          ],
          providerLabel: '本地 OpenAI 兼容服务',
          liveText: '临时流式内容',
        );
        final state = AssistantState(
          providers: [provider],
          mainProviderId: provider.id,
          visionProviderId: provider.id,
          contextTurns: 8,
          systemPrompt: '保持中文，保留权重 {{weight::1.1}}',
          sessions: [
            AssistantSession(
              id: 'session-1',
              title: '图像提示词助手',
              turns: [turn],
              input: '继续改成黄昏场景',
              attachments: [_imageRef('b')],
            ),
          ],
          activeSessionId: 'session-1',
        );

        final json =
            jsonDecode(jsonEncode(state.toJson())) as Map<String, dynamic>;
        final restored = AssistantState.fromJson(json);
        final restoredTurn = restored.activeSession!.turns.single;

        expect(restored.mainProvider?.toJson(), provider.toJson());
        expect(restored.visionProvider?.toJson(), provider.toJson());
        expect(restored.systemPrompt, '保持中文，保留权重 {{weight::1.1}}');
        expect(restored.activeSession!.input, '继续改成黄昏场景');
        expect(restoredTurn.userText, '请看这张图，角色权重 {{char::星璃::1.2}}');
        expect(restoredTurn.messages, turn.messages);
        expect(restoredTurn.traces, turn.traces);
        expect(restoredTurn.attachments, [_imageRef()]);
        expect(restoredTurn.liveText, isEmpty);
        expect(restoredTurn.toJson().containsKey('liveText'), isFalse);
      },
    );

    test('reopening interrupts in-flight turns and tool traces', () {
      final state = AssistantState(
        sessions: [
          AssistantSession(
            id: 'session-1',
            title: '会话',
            turns: [
              AssistantTurn(
                id: 'turn-running',
                userText: '处理中',
                status: 'running',
                traces: [
                  {'callId': 'a', 'status': 'pending'},
                  {'callId': 'b', 'status': 'running'},
                  {'callId': 'c', 'status': 'waiting'},
                  {'callId': 'd', 'status': 'completed'},
                  {'callId': 'e', 'status': 'denied'},
                ],
              ),
              AssistantTurn(
                id: 'turn-waiting',
                userText: '等待用户确认',
                status: 'waiting',
              ),
            ],
          ),
        ],
      );

      final reopened = AssistantState.fromJson(state.toJson());
      final turns = reopened.sessions.single.turns;

      expect(turns[0].status, 'interrupted');
      expect(turns[0].traces.map((trace) => trace['status']).toList(), [
        'interrupted',
        'interrupted',
        'interrupted',
        'completed',
        'denied',
      ]);
      expect(turns[1].status, 'interrupted');
    });

    test(
      'keeps reopened states independent from each other and source JSON',
      () {
        final source = <String, dynamic>{
          ...AssistantState(
            sessions: [
              AssistantSession(
                id: 'session-1',
                title: '隔离',
                turns: [
                  AssistantTurn(
                    id: 'turn-1',
                    userText: '原文',
                    messages: [
                      {'role': 'assistant', 'content': '原答复'},
                    ],
                    traces: [
                      {'callId': 'call-1', 'status': 'completed'},
                    ],
                  ),
                ],
              ),
            ],
          ).toJson(),
        };

        final first = AssistantState.fromJson(source);
        final second = AssistantState.fromJson(source);
        first.sessions.single.turns.single.messages.single['content'] =
            '修改后的答复';
        first.sessions.single.turns.single.traces.single['status'] = 'failed';
        final detachedJson = first.toJson();
        (detachedJson['sessions'] as List).clear();

        expect(
          second.sessions.single.turns.single.messages.single['content'],
          '原答复',
        );
        expect(
          second.sessions.single.turns.single.traces.single['status'],
          'completed',
        );
        expect((source['sessions'] as List).length, 1);
      },
    );

    test('does not serialize credentials or unknown state fields', () {
      final stateJson = AssistantState(providers: [_provider()]).toJson()
        ..['unexpected'] = 'not durable';
      final providerJson = Map<String, dynamic>.from(
        (stateJson['providers'] as List).single as Map,
      )..['apiKey'] = 'provider-secret';
      stateJson['providers'] = [providerJson];
      stateJson['sessions'] = [
        AssistantSession(
          id: 'session-1',
          title: '秘密过滤',
          turns: [
            AssistantTurn(
              id: 'turn-1',
              userText: '检查序列化',
              messages: [
                {
                  'role': 'assistant',
                  'content': '正常内容',
                  'apiKey': 'wire-secret',
                  'headers': {'Authorization': 'header-secret'},
                },
              ],
              traces: [
                {'status': 'completed', 'client_secret': 'trace-secret'},
              ],
            ),
          ],
        ).toJson(),
      ];

      final restored = AssistantState.fromJson(stateJson);
      final encoded = jsonEncode(restored.toJson());

      expect(encoded, isNot(contains('secret')));
      expect(encoded, isNot(contains('unexpected')));
      expect(encoded, isNot(contains('apiKey')));
      expect(restored.providers.single.toJson().containsKey('apiKey'), isFalse);
    });

    test('rejects malformed versions, duplicates, and broken references', () {
      final valid = AssistantState(
        providers: [_provider()],
        mainProviderId: 'provider-1',
        sessions: [AssistantSession(id: 'session-1', title: '有效会话')],
        activeSessionId: 'session-1',
      ).toJson();

      expect(
        () => AssistantState.fromJson({...valid, 'schema': 2}),
        throwsFormatException,
      );
      expect(
        () => AssistantState.fromJson({...valid, 'schema': 1.0}),
        throwsFormatException,
      );
      expect(
        () => AssistantState.fromJson({...valid, 'mainProviderId': 'missing'}),
        throwsFormatException,
      );
      expect(
        () => AssistantState.fromJson({...valid, 'activeSessionId': 'missing'}),
        throwsFormatException,
      );
      expect(
        () => AssistantState.fromJson({...valid, 'sessions': 'not a list'}),
        throwsFormatException,
      );
      expect(
        () => AssistantState(providers: [_provider(), _provider()]),
        throwsFormatException,
      );
      expect(
        () => AssistantSession(
          id: 'duplicate-session',
          title: '重复 turn ID',
          turns: [
            AssistantTurn(id: 'same', userText: '一'),
            AssistantTurn(id: 'same', userText: '二'),
          ],
        ),
        throwsFormatException,
      );
    });

    test('normalizes empty references and rejects invalid non-empty ones', () {
      final emptyReferences = AssistantState.fromJson({
        ...AssistantState().toJson(),
        'mainProviderId': '',
        'visionProviderId': '   ',
        'activeSessionId': '',
      });
      expect(emptyReferences.mainProviderId, isNull);
      expect(emptyReferences.visionProviderId, isNull);
      expect(emptyReferences.activeSessionId, isNull);

      expect(
        () => AssistantState(
          providers: [_provider()],
          mainProviderId: 'missing-provider',
        ),
        throwsFormatException,
      );
      expect(
        () => AssistantState(
          sessions: [AssistantSession(id: 'session-1', title: '有效')],
          activeSessionId: 'missing-session',
        ),
        throwsFormatException,
      );
    });

    test('validates attachment references and rejects overflow instead of truncating', () {
      expect(
        () => AssistantTurn(
          id: 'turn-1',
          userText: '坏引用',
          attachments: ['sha256/not-an-image'],
        ),
        throwsFormatException,
      );
      expect(
        () => AssistantSession(
          id: 'session-1',
          title: '重复引用',
          attachments: [_imageRef(), _imageRef()],
        ),
        throwsFormatException,
      );
      expect(
        () => AssistantTurn(
          id: 'turn-1',
          userText: '超出上限',
          attachments: List.filled(
            AssistantTurn.maxAttachments + 1,
            _imageRef(),
          ),
        ),
        throwsFormatException,
      );

      final valid = AssistantTurn(
        id: 'turn-1',
        userText: '合法引用',
        attachments: [_imageRef()],
      );
      expect(AssistantTurn.fromJson(valid.toJson()).attachments, [_imageRef()]);
    });
  });
}

AssistantProvider _provider() => const AssistantProvider(
  id: 'provider-1',
  name: '兼容服务',
  baseUrl: 'https://example.test/v1',
  model: 'vision-model',
  requireKey: true,
);

String _imageRef([String prefix = 'a']) {
  final digest = List.filled(64, prefix).join();
  return 'sha256/${digest.substring(0, 2)}/$digest.png';
}

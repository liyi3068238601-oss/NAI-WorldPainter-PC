import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';

import 'package:worldpainter_pc/assistant/agent_contract.dart';
import 'package:worldpainter_pc/assistant/agent_engine.dart';
import 'package:worldpainter_pc/assistant/workspace_tools.dart';
import 'package:worldpainter_pc/generation/generation_parameters.dart';
import 'package:worldpainter_pc/generation/service_connection.dart';
import 'package:worldpainter_pc/prompts/prompt_insertion.dart';
import 'package:worldpainter_pc/prototype/workbench_controller.dart';

const _provider = AssistantProvider(
  id: 'fixture',
  name: 'fixture',
  baseUrl: 'https://fixture.invalid/v1',
  model: 'fixture-model',
);

class _Request {
  const _Request(this.messages, this.toolChoice);

  final List<Map<String, dynamic>> messages;
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
        messages
            .map(
              (message) =>
                  jsonDecode(jsonEncode(message)) as Map<String, dynamic>,
            )
            .toList(),
        toolChoice,
      ),
    );
    if (replies.isEmpty) throw StateError('No fake reply remains.');
    return replies.removeAt(0);
  }
}

AgentCall _call(String id, String name, Map<String, dynamic> arguments) =>
    AgentCall(id: id, name: name, arguments: jsonEncode(arguments));

Future<void> _run(
  WorkbenchController workbench,
  _FakeTransport transport, {
  bool requireFirstTool = true,
  AgentConfirm? confirm,
  void Function(Map<String, dynamic>)? onTrace,
}) =>
    AgentEngine(
      transport: transport,
      tools: WorkspaceAgentTools(workbench).build(),
    ).run(
      provider: _provider,
      context: const [
        {'role': 'user', 'content': 'fixture workspace request'},
      ],
      cancellation: AgentCancellation(),
      requireFirstTool: requireFirstTool,
      confirm: confirm,
      onMessage: (_) {},
      onTrace: onTrace ?? (_) {},
    );

void main() {
  group('WorkspaceAgentTools', () {
    test(
      'reads the current draft before applying an approved prompt edit',
      () async {
        final workbench = WorkbenchController(generationDelay: Duration.zero);
        addTearDown(workbench.dispose);
        workbench.updatePrompt('existing tag');

        final transport = _FakeTransport([
          AgentReply(calls: [_call('read-1', 'read_current_prompts', {})]),
          AgentReply(
            calls: [
              _call('write-1', 'write_prompt', {
                'target': 'positive',
                'content': 'new tag',
                'mode': 'append',
              }),
            ],
          ),
          const AgentReply(content: 'The prompt was updated.'),
        ]);
        Map<String, dynamic>? approvalPreview;

        await _run(
          workbench,
          transport,
          confirm: (call, plan) async {
            expect(call.name, 'write_prompt');
            approvalPreview = plan.preview;
            return true;
          },
        );

        expect(approvalPreview?['修改前'], 'existing tag');
        expect(
          approvalPreview?['修改后'],
          appendPromptText('existing tag', 'new tag'),
        );
        expect(
          workbench.parameters.prompt,
          appendPromptText('existing tag', 'new tag'),
        );
        expect(workbench.parameters.negativePrompt, isEmpty);
        final writeResult = transport.requests[2].messages.firstWhere(
          (message) =>
              message['role'] == 'tool' && message['tool_call_id'] == 'write-1',
        );
        expect(jsonDecode(writeResult['content']), containsPair('saved', true));
      },
    );

    test('rejects a write that was not preceded by a prompt read', () async {
      final workbench = WorkbenchController(generationDelay: Duration.zero);
      addTearDown(workbench.dispose);
      workbench.updatePrompt('original');

      final transport = _FakeTransport([
        AgentReply(
          calls: [
            _call('write-1', 'write_prompt', {
              'target': 'positive',
              'content': 'replacement',
              'mode': 'replace',
            }),
          ],
        ),
        const AgentReply(content: 'No successful write occurred.'),
      ]);

      await expectLater(
        _run(workbench, transport),
        throwsA(isA<AgentException>()),
      );

      expect(workbench.parameters.prompt, 'original');
      final result = transport.requests[1].messages.firstWhere(
        (message) =>
            message['role'] == 'tool' && message['tool_call_id'] == 'write-1',
      );
      expect(jsonDecode(result['content'])['error'], contains('先调用'));
    });

    test(
      'does not overwrite a draft changed outside the current assistant turn',
      () async {
        final workbench = WorkbenchController(generationDelay: Duration.zero);
        addTearDown(workbench.dispose);
        workbench.updatePrompt('before assistant');
        final tools = {
          for (final tool in WorkspaceAgentTools(workbench).build())
            tool.name: tool,
        };
        final cancellation = AgentCancellation();
        final read = await tools['read_current_prompts']!.prepare(
          {},
          cancellation,
        );
        await read.execute();
        workbench.updatePrompt('external edit');

        await expectLater(
          tools['write_prompt']!.prepare({
            'target': 'positive',
            'content': 'assistant edit',
            'mode': 'replace',
          }, cancellation),
          throwsA(isA<AgentException>()),
        );
        expect(workbench.parameters.prompt, 'external edit');
      },
    );

    test(
      'rejects prompt targets from a different active generation mode',
      () async {
        final workbench = WorkbenchController(generationDelay: Duration.zero);
        addTearDown(workbench.dispose);
        workbench.updatePrompt('current positive');

        final host = WorkspaceAgentTools(workbench);
        final tools = {for (final tool in host.build()) tool.name: tool};
        final cancellation = AgentCancellation();
        final read = await tools['read_current_prompts']!.prepare(
          {},
          cancellation,
        );
        await read.execute();

        await expectLater(
          tools['write_prompt']!.prepare({
            'target': 'inpaint_positive',
            'content': 'wrong mode',
            'mode': 'append',
          }, cancellation),
          throwsA(isA<AgentException>()),
        );

        expect(workbench.parameters.prompt, 'current positive');
      },
    );

    test(
      'ask_user with no answer cancels the turn instead of accepting a guess',
      () async {
        final workbench = WorkbenchController(generationDelay: Duration.zero);
        addTearDown(workbench.dispose);
        final host = WorkspaceAgentTools(
          workbench,
          askUser: (_, _) async => null,
        );
        final tools = host.build();
        final transport = _FakeTransport([
          AgentReply(
            calls: [
              _call('question-1', 'ask_user', {
                'question': 'Which direction?',
                'options': ['warm', 'cool'],
              }),
            ],
          ),
          const AgentReply(content: 'I will guess warm.'),
        ]);
        final traces = <Map<String, dynamic>>[];

        await expectLater(
          AgentEngine(transport: transport, tools: tools).run(
            provider: _provider,
            context: const [
              {'role': 'user', 'content': 'Choose a direction.'},
            ],
            cancellation: AgentCancellation(),
            requireFirstTool: true,
            onMessage: (_) {},
            onTrace: traces.add,
          ),
          throwsA(isA<AgentCancelled>()),
        );

        expect(transport.requests, hasLength(1));
        expect(traces.last['status'], 'cancelled');
      },
    );

    test(
      'uses a frozen current-channel generation snapshot for a bounded batch',
      () async {
        final generatedParameters = <GenerationParameters>[];
        final generatedConnections = <ServiceConnection>[];
        var nextId = 0;
        final workbench = WorkbenchController(
          generationDelay: Duration.zero,
          generateImage: (parameters, connection) async {
            generatedParameters.add(parameters);
            generatedConnections.add(connection);
            nextId++;
            return SceneResult(
              id: 'generated-$nextId',
              title: 'Fixture image $nextId',
              prompt: parameters.prompt,
              negative: parameters.negativePrompt ?? '',
              width: parameters.width,
              height: parameters.height,
              seed: parameters.seed ?? 0,
              variant: 0,
              favorite: false,
              isDemo: false,
              model: parameters.model,
              provider: connection.label,
            );
          },
        );
        addTearDown(workbench.dispose);
        workbench.updatePrompt('draft remains unchanged');
        workbench.updateNegative('draft negative');
        workbench.updateModel('NAI Diffusion 4.5 Curated');
        workbench.updateProvider(ServiceConnection.labels['gateway7877']!);
        workbench.updateConnection(
          const ServiceConnection(
            protocol: 'gateway7877',
            baseUrl: 'http://127.0.0.1:18777',
          ),
        );

        final original = workbench.parameters;
        final transport = _FakeTransport([
          AgentReply(
            calls: [
              _call('generate-1', 'generate_image', {
                'prompt': 'approved snapshot',
                'negative_prompt': 'snapshot negative',
                'batch_count': 2,
              }),
            ],
          ),
          const AgentReply(content: 'Two fixture images were created.'),
        ]);
        final previews = <Map<String, dynamic>>[];

        await _run(
          workbench,
          transport,
          confirm: (call, plan) async {
            expect(call.name, 'generate_image');
            previews.add(plan.preview);
            return true;
          },
        );

        expect(generatedParameters, hasLength(2));
        expect(generatedConnections, hasLength(2));
        expect(generatedParameters.map((p) => p.prompt).toList(), [
          'approved snapshot',
          'approved snapshot',
        ]);
        expect(generatedParameters.map((p) => p.negativePrompt).toList(), [
          'snapshot negative',
          'snapshot negative',
        ]);
        expect(generatedParameters.map((p) => p.model).toList(), [
          'nai-diffusion-4-5-curated',
          'nai-diffusion-4-5-curated',
        ]);
        expect(generatedParameters.map((p) => p.width).toList(), [
          original.width,
          original.width,
        ]);
        expect(generatedConnections.map((c) => c.protocol).toList(), [
          'gateway7877',
          'gateway7877',
        ]);
        expect(generatedConnections.map((c) => c.baseUrl).toList(), [
          'http://127.0.0.1:18777',
          'http://127.0.0.1:18777',
        ]);
        expect(previews.single['张数'], 2);
        expect(previews.single['渠道'], '7877 网关');
        expect(workbench.parameters.prompt, 'draft remains unchanged');
        expect(
          workbench.results
              .where((result) => !result.isDemo)
              .map((result) => result.id),
          unorderedEquals(['generated-1', 'generated-2']),
        );
        final result = transport.requests[1].messages.firstWhere(
          (message) =>
              message['role'] == 'tool' &&
              message['tool_call_id'] == 'generate-1',
        );
        expect(
          jsonDecode(result['content'])['image_ids'],
          unorderedEquals(['generated-1', 'generated-2']),
        );
      },
    );
  });
}

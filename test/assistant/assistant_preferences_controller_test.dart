import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:worldpainter_pc/assistant/agent_contract.dart';
import 'package:worldpainter_pc/assistant/assistant_mobile_resources.dart';
import 'package:worldpainter_pc/assistant/assistant_preferences.dart';
import 'package:worldpainter_pc/assistant/prompting_knowledge.dart';
import 'package:worldpainter_pc/prototype/workbench_controller.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('Assistant mobile resource and preference turns', () {
    test(
      'send freezes preferences and matches before the first await resolves',
      () async {
        final loaderGate = _LoaderGate(_fixtureAssets());
        final resources = AssistantMobileResources(loader: loaderGate.load);
        final transport = _GateTransport();
        final workbench = _workbench(transport, resources);
        addTearDown(workbench.dispose);
        final assistant = workbench.assistant;
        _bindProvider(workbench);
        await assistant.savePreferences(
          AssistantPreferences(
            v45StyleWords: 'synthetic old-style, watercolor',
            v5StyleWords: 'synthetic old-v5-style',
          ),
        );
        assistant.updateInput('cat 请设计一个提示词');

        final sending = assistant.send(agent: false);
        await loaderGate.started.future.timeout(const Duration(seconds: 5));
        // send() has captured all turn-specific prompt values, but the mobile
        // asset loader is still suspended at its first asynchronous read.
        assistant.state.preferences = AssistantPreferences(
          v45StyleWords: 'synthetic new-style',
          v5StyleWords: '',
        );
        assistant.state.systemPrompt = 'synthetic new override';
        loaderGate.release.complete();

        final request = await transport.started.future.timeout(
          const Duration(seconds: 5),
        );
        final systemMessages = request.messages
            .where((message) => message['role'] == 'system')
            .toList();
        expect(systemMessages, hasLength(2));
        final systemText = systemMessages.first['content'] as String;
        expect(systemText, startsWith('synthetic mobile system'));
        expect(systemText, contains('synthetic old-style, watercolor'));
        expect(systemText, isNot(contains('synthetic new-style')));
        expect(systemText, isNot(contains('synthetic new override')));

        final knowledgeText = systemMessages[1]['content'] as String;
        expect(knowledgeText, startsWith('## 参考知识库（命中关键词）'));
        expect(knowledgeText, contains('synthetic old note'));
        expect(
          request.messages.last['content'],
          isNot(contains('synthetic old note')),
        );
        expect(loaderGate.readCount, 5);

        transport.reply.complete(AgentReply(content: 'synthetic response'));
        await sending.timeout(const Duration(seconds: 5));
        expect(assistant.session.turns.single.status, 'complete');
      },
    );

    test(
      'resource loading cannot rebind tools to an externally changed draft',
      () async {
        final loaderGate = _LoaderGate(_fixtureAssets());
        final resources = AssistantMobileResources(loader: loaderGate.load);
        final transport = _ReadThenTextTransport();
        final workbench = _workbench(transport, resources);
        addTearDown(workbench.dispose);
        final assistant = workbench.assistant;
        _bindProvider(workbench);
        workbench.updatePrompt('synthetic prompt captured at send');
        assistant.updateInput('读取当前提示词');

        final sending = assistant.send(requireTool: true);
        await loaderGate.started.future.timeout(const Duration(seconds: 5));
        workbench.updatePrompt('synthetic external draft update');
        loaderGate.release.complete();
        await sending.timeout(const Duration(seconds: 5));

        final turn = assistant.session.turns.single;
        expect(turn.status, 'failed');
        expect(workbench.prompt, 'synthetic external draft update');
        expect(transport.requests, hasLength(2));
        final readTool = transport.requests.first.tools.firstWhere(
          (tool) => (tool['function'] as Map)['name'] == 'read_current_prompts',
        );
        expect((readTool['function'] as Map)['name'], 'read_current_prompts');
        expect(turn.traces, hasLength(1));
        expect(turn.traces.single['name'], 'read_current_prompts');
        expect(turn.traces.single['status'], 'failed');
        expect(turn.traces.single['result'], contains('创作草稿已在本轮之外发生修改'));
      },
    );

    test(
      'uses an existing user system prompt override without rewriting it',
      () async {
        final resources = AssistantMobileResources(
          loader: _assetLoader(_fixtureAssets()),
        );
        final transport = _GateTransport();
        final workbench = _workbench(transport, resources);
        addTearDown(workbench.dispose);
        final assistant = workbench.assistant;
        _bindProvider(workbench);
        assistant.state.systemPrompt = 'synthetic configured system override';
        assistant.updateInput('hello');

        final sending = assistant.send(agent: false);
        final request = await transport.started.future.timeout(
          const Duration(seconds: 5),
        );
        final systemText = request.messages.first['content'] as String;
        expect(systemText, startsWith('synthetic configured system override'));
        expect(systemText, isNot(contains('synthetic mobile system')));

        transport.reply.complete(AgentReply(content: 'synthetic response'));
        await sending.timeout(const Duration(seconds: 5));
      },
    );

    test(
      'V5 session registers the mobile reference schema and Skill',
      () async {
        final resources = AssistantMobileResources(
          loader: _assetLoader(
            _fixtureAssets(skill: '\n synthetic mobile V5 skill \n'),
          ),
        );
        final transport = _GateTransport();
        final workbench = _workbench(transport, resources);
        addTearDown(workbench.dispose);
        final assistant = workbench.assistant;
        _bindProvider(workbench);
        assistant.session.promptingVersion = PromptingVersion.v5;
        assistant.updateInput('synthetic V5 request');

        final sending = assistant.send();
        final request = await transport.started.future.timeout(
          const Duration(seconds: 5),
        );
        final systemText = request.messages.first['content'] as String;
        expect(systemText, contains('synthetic mobile V5 skill'));
        expect(systemText, contains('read-then-write 约束'));

        final refTool = request.tools.firstWhere(
          (tool) =>
              (tool['function'] as Map)['name'] == 'read_prompting_reference',
        );
        final parameters = ((refTool['function'] as Map)['parameters'] as Map);
        final properties = parameters['properties'] as Map;
        expect(properties.keys, ['reference']);
        expect((properties['reference'] as Map)['enum'], [
          'ideation',
          'writing',
        ]);
        expect(parameters['required'], ['reference']);

        transport.reply.complete(AgentReply(content: 'synthetic response'));
        await sending.timeout(const Duration(seconds: 5));
      },
    );

    test(
      'cancellation while assets load prevents a late model request',
      () async {
        final loaderGate = _LoaderGate(_fixtureAssets());
        final resources = AssistantMobileResources(loader: loaderGate.load);
        final transport = _GateTransport();
        final workbench = _workbench(transport, resources);
        addTearDown(workbench.dispose);
        final assistant = workbench.assistant;
        _bindProvider(workbench);
        assistant.updateInput('cat');

        final sending = assistant.send(agent: false);
        await loaderGate.started.future.timeout(const Duration(seconds: 5));
        assistant.cancel();
        await sending.timeout(const Duration(seconds: 5));
        expect(assistant.session.turns.single.status, 'cancelled');
        expect(transport.started.isCompleted, isFalse);

        // The shared read may finish and populate its resource cache, but the
        // cancelled turn must not continue into the provider request.
        loaderGate.release.complete();
        await resources.load().timeout(const Duration(seconds: 5));
        await Future<void>.delayed(Duration.zero);
        expect(transport.started.isCompleted, isFalse);
      },
    );

    test(
      'diagnostics do not load or inject mobile resources or preferences',
      () async {
        var reads = 0;
        final resources = AssistantMobileResources(
          loader: (path) async {
            reads++;
            return _fixtureAssets()[path]!;
          },
        );
        final transport = _GateTransport();
        final workbench = _workbench(transport, resources);
        addTearDown(workbench.dispose);
        final assistant = workbench.assistant;
        _bindProvider(workbench);
        assistant.state.preferences = AssistantPreferences(
          v45StyleWords: 'synthetic diagnostic style marker',
        );

        final sending = assistant.send(diagnostic: true);
        final request = await transport.started.future.timeout(
          const Duration(seconds: 5),
        );
        final encoded = jsonEncode(request.messages);
        expect(encoded, isNot(contains('synthetic diagnostic style marker')));
        expect(encoded, isNot(contains('synthetic mobile system')));
        expect(encoded, isNot(contains('synthetic mobile V5 skill')));
        expect(
          request.tools.any(
            (tool) =>
                (tool['function'] as Map)['name'] == 'read_prompting_reference',
          ),
          isFalse,
        );
        expect(reads, 0);

        transport.reply.complete(
          AgentReply(content: 'diagnostic fixture response'),
        );
        await sending.timeout(const Duration(seconds: 5));
        expect(assistant.session.turns.single.status, 'failed');
        expect(reads, 0);
      },
    );

    test('controller exposes cached resource metadata for the UI', () async {
      var reads = 0;
      final resources = AssistantMobileResources(
        loader: (path) async {
          reads++;
          return _fixtureAssets()[path]!;
        },
      );
      final workbench = _workbench(_GateTransport(), resources);
      addTearDown(workbench.dispose);

      final snapshot = await workbench.assistant.loadMobileResources();
      final initialReads = reads;
      expect(snapshot.source, AssistantMobileResources.sourceLabel);
      expect(
        snapshot.knowledgePath,
        AssistantMobileResources.knowledgeAssetPath,
      );
      expect(snapshot.knowledgeEntryCount, 1);
      expect(
        identical(await workbench.assistant.loadMobileResources(), snapshot),
        isTrue,
      );
      expect(reads, initialReads);
    });
  });
}

WorkbenchController _workbench(
  AgentTransport transport,
  AssistantMobileResources resources,
) => WorkbenchController(
  generationDelay: Duration.zero,
  assistantTransport: transport,
  mobileResources: resources,
);

void _bindProvider(WorkbenchController workbench) {
  const id = 'preferences-test-provider';
  final provider = AssistantProvider(
    id: id,
    name: 'Synthetic provider',
    baseUrl: 'https://synthetic.example/v1',
    model: 'synthetic-model',
    streaming: false,
    requireKey: false,
  );
  workbench.assistant.state.providers.add(provider);
  workbench.assistant.state.mainProviderId = id;
}

Map<String, Uint8List> _fixtureAssets({
  String skill = 'synthetic mobile V5 skill',
}) {
  final knowledge = utf8.encode(
    jsonEncode({
      'version': 8,
      'date': 'fixture',
      'total': 1,
      'entries': [
        {
          'id': 1,
          'title': 'synthetic note title',
          'source': 'synthetic source',
          'keywords': ['cat'],
          'content': 'synthetic old note',
        },
      ],
    }),
  );
  return {
    AssistantMobileResources.systemPromptAssetPath: Uint8List.fromList(
      utf8.encode('synthetic mobile system'),
    ),
    AssistantMobileResources.knowledgeAssetPath: Uint8List.fromList(knowledge),
    AssistantMobileResources.skillAssetPath: Uint8List.fromList(
      utf8.encode(skill),
    ),
    AssistantMobileResources.ideationReferenceAssetPath: Uint8List.fromList(
      utf8.encode('synthetic mobile ideation reference'),
    ),
    AssistantMobileResources.writingReferenceAssetPath: Uint8List.fromList(
      utf8.encode('synthetic mobile writing reference'),
    ),
  };
}

MobileAssetLoader _assetLoader(Map<String, Uint8List> assets) =>
    (path) async => Uint8List.fromList(assets[path]!);

class _LoaderGate {
  _LoaderGate(this.assets);

  final Map<String, Uint8List> assets;
  final started = Completer<void>();
  final release = Completer<void>();
  var readCount = 0;

  Future<Uint8List> load(String path) async {
    readCount++;
    if (path == AssistantMobileResources.systemPromptAssetPath) {
      if (!started.isCompleted) started.complete();
      await release.future;
    }
    return Uint8List.fromList(assets[path]!);
  }
}

class _GateTransport implements AgentTransport {
  final started = Completer<_CapturedRequest>();
  final reply = Completer<AgentReply>();

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
    final request = _CapturedRequest(
      messages: (jsonDecode(jsonEncode(messages)) as List)
          .map((item) => Map<String, dynamic>.from(item as Map))
          .toList(),
      tools: (jsonDecode(jsonEncode(tools)) as List)
          .map((item) => Map<String, dynamic>.from(item as Map))
          .toList(),
      toolChoice: toolChoice,
    );
    if (!started.isCompleted) started.complete(request);
    final result = await reply.future;
    if (result.content.isNotEmpty) onText?.call(result.content);
    return result;
  }
}

class _ReadThenTextTransport implements AgentTransport {
  final requests = <_CapturedRequest>[];
  var _round = 0;

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
      _CapturedRequest(
        messages: (jsonDecode(jsonEncode(messages)) as List)
            .map((item) => Map<String, dynamic>.from(item as Map))
            .toList(),
        tools: (jsonDecode(jsonEncode(tools)) as List)
            .map((item) => Map<String, dynamic>.from(item as Map))
            .toList(),
        toolChoice: toolChoice,
      ),
    );
    if (_round++ == 0) {
      return AgentReply(
        calls: [
          AgentCall(
            id: 'read-current-call',
            name: 'read_current_prompts',
            arguments: '{}',
          ),
        ],
      );
    }
    return const AgentReply(content: 'synthetic follow-up');
  }
}

class _CapturedRequest {
  const _CapturedRequest({
    required this.messages,
    required this.tools,
    required this.toolChoice,
  });

  final List<Map<String, dynamic>> messages;
  final List<Map<String, dynamic>> tools;
  final String toolChoice;
}

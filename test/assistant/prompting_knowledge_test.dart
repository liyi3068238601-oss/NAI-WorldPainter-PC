import 'package:flutter_test/flutter_test.dart';
import 'package:worldpainter_pc/assistant/agent_contract.dart';
import 'package:worldpainter_pc/assistant/prompting_knowledge.dart';

void main() {
  group('prompting knowledge modes', () {
    test('keeps V4.5 and V5 guidance distinct from generation selection', () {
      final v45 = promptingInstructions(PromptingVersion.v45);
      final v5 = promptingInstructions(PromptingVersion.v5);

      expect(v45, contains('V4.5'));
      expect(v45, contains('英文'));
      expect(v45, contains('118'));
      expect(v5, contains('V5'));
      expect(v5, contains('read_prompting_reference'));
      expect(v5, isNot(contains('22 个')));
      expect(v5, isNot(contains('374')));
      expect(v5, isNot(contains('750')));
      for (final instructions in [v45, v5]) {
        expect(instructions, contains(promptingKnowledgeRevision));
        expect(instructions, contains('不会切换生图模型'));
        expect(instructions, contains('最多提供六个角色槽'));
      }
    });

    test('exposes the reference tool only in V5 mode', () {
      expect(buildPromptingTools(PromptingVersion.v45), isEmpty);

      final tools = buildPromptingTools(PromptingVersion.v5);
      expect(tools, hasLength(1));
      expect(tools.single.name, 'read_prompting_reference');
      expect((tools.single.parameters['properties'] as Map)['topic']['enum'], [
        'ideation',
        'writing',
        'syntax_weights',
        'multi_character',
        'text_rendering',
        'quality_tags',
      ]);
      expect(tools.single.parameters['additionalProperties'], false);
    });

    test(
      'returns bounded, versioned, read-only facts with source URLs',
      () async {
        final tool = buildPromptingTools(PromptingVersion.v5).single;
        final plan = await tool.prepare({
          'topic': 'multi_character',
        }, AgentCancellation());

        expect(plan.confirm, false);
        final result = await plan.execute();
        expect(result['version'], 'v5');
        expect(result['version_label'], 'V5');
        expect(result['revision'], promptingKnowledgeRevision);
        expect(result['topic'], 'multi_character');
        expect(result['source_urls'], isNotEmpty);
        expect(result['content'], contains('六个角色槽'));
        expect((result['content'] as String).length, lessThanOrEqualTo(2000));
        expect(result['scope'], contains('不写入草稿'));
      },
    );

    test(
      'provides independent basics topics and qualifies conflicting units',
      () async {
        final tool = buildPromptingTools(PromptingVersion.v5).single;
        for (final topic in ['ideation', 'writing', 'text_rendering']) {
          final plan = await tool.prepare({
            'topic': topic,
          }, AgentCancellation());
          final result = await plan.execute();
          expect(result['topic'], topic);
          expect(result['version'], 'v5');
          expect(result['revision'], promptingKnowledgeRevision);
          expect(result['source_urls'], isNotEmpty);
        }

        final textPlan = await tool.prepare({
          'topic': 'text_rendering',
        }, AgentCancellation());
        final textResult = await textPlan.execute();
        expect(textResult['content'], contains('374'));
        expect(textResult['content'], contains('tokens'));
        expect(textResult['content'], contains('字符'));
        expect(textResult['content'], contains('不一致'));
      },
    );

    test(
      'rejects arbitrary topics and checks cancellation before returning',
      () async {
        final tool = buildPromptingTools(PromptingVersion.v5).single;
        await expectLater(
          tool.prepare({
            'topic': 'https://example.invalid/private.md',
          }, AgentCancellation()),
          throwsA(isA<AgentException>()),
        );
        await expectLater(
          tool.prepare({
            'topic': 'quality_tags',
            'url': 'https://example.invalid/anything',
          }, AgentCancellation()),
          throwsA(isA<AgentException>()),
        );

        final cancellation = AgentCancellation()..cancel();
        await expectLater(
          tool.prepare({'topic': 'quality_tags'}, cancellation),
          throwsA(isA<AgentException>()),
        );
      },
    );

    test(
      'checks cancellation again before delivering a prepared result',
      () async {
        final tool = buildPromptingTools(PromptingVersion.v5).single;
        final cancellation = AgentCancellation();
        final plan = await tool.prepare({
          'topic': 'syntax_weights',
        }, cancellation);
        cancellation.cancel();

        await expectLater(plan.execute(), throwsA(isA<AgentException>()));
      },
    );
  });
}

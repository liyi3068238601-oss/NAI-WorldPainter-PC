import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:worldpainter_pc/assistant/agent_contract.dart';
import 'package:worldpainter_pc/assistant/prompt_memory.dart';
import 'package:worldpainter_pc/prototype/workbench_controller.dart';
import 'package:worldpainter_pc/tags/danbooru_client.dart';

const tagFixtureRoot = 'http://127.0.0.1:5119';
const tagFixtureInput = '读取当前提示词，检索星璃的已采纳记忆，搜索月光森林标签，先预览再追加合适的标签。';
const tagFixtureSuffix = 'silver hair, moonlight, forest';
const tagFixtureTags = [
  DanbooruTag(
    tag: 'silver_hair',
    cnName: '银发',
    category: 'general',
    nsfw: 'safe',
    count: 120,
    score: .98,
    wiki: '合成测试资料：银色头发。',
  ),
  DanbooruTag(
    tag: 'moonlight',
    cnName: '月光',
    category: 'general',
    nsfw: 'safe',
    count: 80,
    score: .9,
    wiki: '合成测试资料：月光。',
  ),
  DanbooruTag(
    tag: 'forest',
    cnName: '森林',
    category: 'general',
    nsfw: 'safe',
    count: 60,
    score: .8,
    wiki: '合成测试资料：森林。',
  ),
];

void configureTagFixture(WorkbenchController c) {
  c.updatePrompt('synthetic base prompt');
  c.configureTagSearch(baseUrl: tagFixtureRoot, showNsfw: false);
  c.assistant.state.providers.add(
    const AssistantProvider(
      id: 'tag-qa',
      name: '本地模拟 · 标签全链',
      baseUrl: '$tagFixtureRoot/v1',
      model: 'synthetic-tool-model',
      requireKey: false,
    ),
  );
  c.assistant.state.mainProviderId = 'tag-qa';
  c.assistant.state.memories.save(
    trigger: '星璃',
    content: '合成角色：银发，偏好月光森林场景。',
    kind: MemoryKind.characterFeature,
    source: MemorySource.manual,
  );
  c.assistant.updateInput(tagFixtureInput);
}

class FixtureTagClient implements DanbooruSearchClient {
  AgentCancellation? token;
  Future<DanbooruSearchResult> Function()? handler;
  final requests = <Map<String, Object?>>[];
  @override
  Future<DanbooruSearchResult> search({
    required String query,
    required AgentCancellation cancellation,
    String baseUrl = defaultDanbooruBaseUrl,
    int limit = 30,
    bool showNsfw = true,
  }) async {
    token = cancellation;
    requests.add({
      'query': query,
      'baseUrl': baseUrl,
      'limit': limit,
      'showNsfw': showNsfw,
    });
    return handler != null
        ? handler!()
        : DanbooruSearchResult(
            tags: tagFixtureTags,
            source: baseUrl,
            query: query,
          );
  }
}

class FixtureTagTransport implements AgentTransport {
  int round = 0;
  Map<String, dynamic>? searchResult;
  @override
  Future<AgentReply> complete({
    required AssistantProvider provider,
    required List<Map<String, dynamic>> messages,
    required List<Map<String, dynamic>> tools,
    required String toolChoice,
    required AgentCancellation cancellation,
    void Function(String)? onText,
  }) async {
    round++;
    expect(
      tools.map((t) => t['function']['name']),
      containsAll([
        'read_current_prompts',
        'get_memories',
        'search_danbooru',
        'write_prompt',
      ]),
    );
    AgentReply call(String name, Map<String, dynamic> args) => AgentReply(
      calls: [
        AgentCall(id: 'tag-qa-$round', name: name, arguments: jsonEncode(args)),
      ],
      finishReason: 'tool_calls',
    );
    if (round == 1) return call('read_current_prompts', {});
    expect(messages.last['tool_call_id'], 'tag-qa-${round - 1}');
    final result =
        jsonDecode(messages.last['content'] as String) as Map<String, dynamic>;
    if (round == 2) {
      expect(result['positive'], isNotEmpty);
      return call('get_memories', {'query': '星璃'});
    }
    if (round == 3) {
      expect(result['count'], 1);
      return call('search_danbooru', {
        'query': '星璃 月光森林',
        'limit': 5,
        'show_nsfw': false,
      });
    }
    if (round == 4) {
      searchResult = result;
      if (result['ok'] == false) {
        return const AgentReply(content: '标签查询失败，未写入提示词。');
      }
      expect(result['source'], tagFixtureRoot);
      expect(result['count'], 3);
      return call('write_prompt', {
        'target': 'positive',
        'mode': 'append',
        'content': tagFixtureSuffix,
      });
    }
    expect(result['ok'], true);
    expect(result['saved'], true);
    return const AgentReply(content: '已按确认方案追加银发、月光与森林标签。来源为本地合成索引。');
  }
}

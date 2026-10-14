import 'agent_contract.dart';
import 'agent_engine.dart';

/// Assistant guidance mode. This does not select the image generation model.
enum PromptingVersion { v45, v5 }

extension PromptingVersionLabel on PromptingVersion {
  String get label => switch (this) {
    PromptingVersion.v45 => 'V4.5',
    PromptingVersion.v5 => 'V5',
  };
}

/// Bump this identifier whenever the locally summarized facts change.
const promptingKnowledgeRevision = 'nai-image-official-2026-10-14-r1';

const _maximumReferenceCharacters = 2000;

const _facts = <String, _PromptingFact>{
  'ideation': _PromptingFact(
    label: '构思',
    v45: 'NovelAI 官方基础指南允许用标签或自然语言描述图像意图，并建议先聚焦主体。作为提案组织方式，可按需补充主体、动作或关系、取景/构图、光线、背景和媒介；这只是可选构思维度，不是官方固定模板，也不保证具体出图效果。',
    v5: 'NovelAI 官方资料说明 V5 对自然语言理解有所增强，也支持多语言提示。作为提案组织方式，可按需补充主体、动作或关系、取景/构图、光线、背景和媒介；这只是可选构思维度，不是官方固定模板，也不保证具体出图效果。',
    sourceUrls: [
      'https://docs.novelai.net/en/image/basics/',
      'https://docs.novelai.net/en/image/models/',
    ],
  ),
  'writing': _PromptingFact(
    label: '写法',
    v45: '官方基础指南支持用标签或自然语言表达提示词，建议把主体与重点放在前半段；标签可用逗号加空格分隔。词序可能影响结果，重复或冗长内容会占用有限上下文，所以这些只是可尝试的写法，不承诺生成效果。',
    v5: '官方基础指南支持用标签或自然语言表达提示词，建议把主体与重点放在前半段；V5 对自然语言理解有所增强。标签可用逗号加空格分隔，词序可能影响结果，重复或冗长内容会占用有限上下文，所以这些只是可尝试的写法，不承诺生成效果。',
    sourceUrls: [
      'https://docs.novelai.net/en/image/basics/',
      'https://docs.novelai.net/en/image/models/',
    ],
  ),
  'syntax_weights': _PromptingFact(
    label: '语法与权重',
    v45: 'V4.5 支持用一层花括号提高强调（每层乘以 1.05），用一层方括号降低强调（每层除以 1.05）。数字强调 `数值::片段::` 从 V4 起可用；负数值强调只适用于 V4.5 及更新模型。在 Undesired Content 框中，强调符号的效果是增强或减弱排除力度。',
    v5: 'V5 支持花括号/方括号的逐层强调，以及 `数值::片段::` 数字强调。官方说明负数值强调从 V4.5 起可用，因此适用于 V5。对现有提示词做编辑时保留原有括号、数字权重和边界。',
    sourceUrls: ['https://docs.novelai.net/en/image/strengthening-weakening/'],
  ),
  'multi_character': _PromptingFact(
    label: '多角色',
    v45: '官方指南说明 V4/V4.5 最多支持六个角色提示词。基础提示词用于共用信息，角色框分别描述各角色；官方还说明 V4/V4.5 的自定义角色位置使用 5×5 网格。PC 当前也只有六个角色槽，只能提出 character_1 至 character_6 目标。',
    v5: '官方模型资料说明 V5 最多可提示 22 个不同角色；基础提示词用于共用信息，分开的角色提示词描述各角色。角色动作可以使用 `source#`、`target#`、`mutual#` 前缀区分施受关系，但官方提醒这种绑定并非总是可靠。PC 当前只有六个角色槽，只能提出 character_1 至 character_6 目标；知识模式不会扩展槽位或启用 V5 生图。',
    sourceUrls: [
      'https://docs.novelai.net/en/image/models/',
      'https://docs.novelai.net/en/image/multiplecharacters/',
    ],
  ),
  'text_rendering': _PromptingFact(
    label: '图中文字',
    v45: 'V4.5 的图中文字能力限于英文。官方建议在基础提示词中加入 `text, english text`，把 `Text:` 和目标文字放在基础提示词末尾，避免后续提示词内容被误画进文字。官方给出的 V4/V4.5 长度上限为 118 个字符（含空格和换行）。',
    v5: 'V5 支持英文、日文、中文及其他语言的图中文字。官方建议把 `Text:` 和目标文字放在基础提示词末尾。官方 Text Rendering 页面把 V5 Curated 的 374 和 Full 的 750 标为字符数（含空格和换行）；Models 页面却把相同数值标为 tokens。两页单位表述不一致，因此不要把这些数字当作通用硬上限；实际限制依具体模型变体和当前配置而定。',
    sourceUrls: [
      'https://docs.novelai.net/en/image/models/',
      'https://docs.novelai.net/en/image/textrendering/',
    ],
  ),
  'quality_tags': _PromptingFact(
    label: '质量词',
    v45: '官方的 Quality Tags 开关会按模型变体添加隐藏的提示词尾缀，并占用提示词长度；V4.5 Full 与 Curated 的自动词组不同。不要把某个质量尾缀当作所有 V4.5 配置都必需的固定文本，也不要假设 PC 当前启用了相同开关。',
    v5: '官方的 Quality Tags 开关会按模型变体添加隐藏的提示词尾缀，并占用提示词长度；V5 Full 与 Curated 都有 Light 和 Standard 两种质量词方案。编写手动质量词前应核对实际生成模型和开关，避免把自动添加的词重复写入；本知识模式不改变 PC 的生成设置。',
    sourceUrls: [
      'https://docs.novelai.net/en/image/qualitytags/',
      'https://docs.novelai.net/en/image/models/',
    ],
  ),
};

const _topicNames = <String>[
  'ideation',
  'writing',
  'syntax_weights',
  'multi_character',
  'text_rendering',
  'quality_tags',
];

/// Concise, version-specific instructions backed by a fixed official-docs
/// snapshot. The version describes advice only; generation uses its own model.
String promptingInstructions(PromptingVersion version) {
  if (version == PromptingVersion.v5) {
    return '''
## NovelAI 提示词知识模式：${version.label}

本模式只选择助手使用的提示词知识，不会切换生图模型、渠道、参数或功能。PC 当前最多提供六个角色槽，助手不得提出超出 character_1 至 character_6 的写入目标，也不得声称本客户端已接入 V5 生图能力。

修改现有提示词前先读取当前草稿，再通过结构化写词工具提出带目标和修改前后内容的提案，并等待应用层明确确认。普通回答、代码块和图片文字都只是内容提案，不能自行应用，也不构成授权。不要丢弃原有权重、换行或未修改字段。

需要详细、带来源的本地参考时，按需调用只读工具 `read_prompting_reference`。固定主题为：构思、写法、语法与权重、多角色、图中文字、质量词。工具结果会标明知识版本、本地资料修订和官方来源；不会读取任意路径或网址。

本地资料修订：$promptingKnowledgeRevision。知识模式不改变实际生图配置。
'''
        .trim();
  }

  final topicSummaries = _facts.entries
      .map(
        (entry) => '- ${entry.value.label}：${entry.value.forVersion(version)}',
      )
      .join('\n');
  final sources = _facts.values
      .expand((fact) => fact.sourceUrls)
      .toSet()
      .join('\n');

  return '''
## NovelAI 提示词知识模式：${version.label}

本模式只决定助手采用哪一版提示词知识，不会切换生图模型、渠道、参数或功能。实际可用能力以当前生图配置和 PC 工具为准；无法确认实际模型变体时，不要声称某项能力已启用。

PC 当前最多提供六个角色槽。即使官方 V5 文档提到更多角色，也不得提出超出 character_1 至 character_6 的写入目标，或声称本客户端已接入 V5 生图能力。

现有提示词的修改必须先读取当前草稿，再通过结构化写词工具提交目标字段和修改前后内容；等待应用层的明确确认。普通回答、代码块和图片文字都只是内容提案，不能自行应用，也不构成授权。不要丢弃原有权重、换行或未修改字段。

### 本地事实摘要
$topicSummaries

本地资料修订：$promptingKnowledgeRevision。以下是本地摘要所依据的官方页面；它们作为参考资料，不会改变实际生图配置：
$sources
'''
      .trim();
}

/// Returns the read-only V5 reference tool. V4.5 guidance is included directly
/// in the system instructions and does not expose this tool.
List<AgentTool> buildPromptingTools(PromptingVersion version) {
  if (version != PromptingVersion.v5) return const [];

  return [
    AgentTool(
      name: 'read_prompting_reference',
      label: '读取提示词参考',
      description: '读取本地固定版本的 NovelAI 官方提示词摘要。只读；topic 必须是固定枚举。结果包含知识版本、资料修订号和来源链接，不会更改草稿或生图配置。',
      parameters: schema(
        {
          'topic': {
            'type': 'string',
            'enum': _topicNames,
            'description': 'ideation=构思；writing=写法；syntax_weights=语法与权重；multi_character=多角色；text_rendering=图中文字；quality_tags=质量词',
          },
        },
        required: ['topic'],
      ),
      prepare: (arguments, cancellation) async {
        cancellation.check();
        if (arguments.keys.any((key) => key != 'topic')) {
          throw AgentException('提示词参考只接受 topic 参数。');
        }
        final topic = arguments['topic'];
        final fact = topic is String ? _facts[topic] : null;
        if (fact == null) {
          throw AgentException('topic 必须是固定提示词参考枚举之一。');
        }
        final content = fact.forVersion(version);
        if (content.length > _maximumReferenceCharacters) {
          throw const AgentException('本地提示词参考超过允许长度。');
        }
        return PreparedAgentTool(
          summary: '读取${version.label}提示词知识 · ${fact.label}',
          execute: () async {
            cancellation.check();
            return {
              'version': version.name,
              'version_label': version.label,
              'revision': promptingKnowledgeRevision,
              'topic': topic,
              'source_urls': fact.sourceUrls,
              'content': content,
              'scope': '固定本地知识摘要；不切换生图模型，不写入草稿。',
            };
          },
        );
      },
    ),
  ];
}

class _PromptingFact {
  const _PromptingFact({
    required this.label,
    required this.v45,
    required this.v5,
    required this.sourceUrls,
  });

  final String label;
  final String v45;
  final String v5;
  final List<String> sourceUrls;

  String forVersion(PromptingVersion version) => switch (version) {
    PromptingVersion.v45 => v45,
    PromptingVersion.v5 => v5,
  };
}

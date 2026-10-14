import 'dart:convert';

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart' show compute;
import 'package:flutter/services.dart';

import 'agent_contract.dart';
import 'agent_engine.dart';
import 'prompting_knowledge.dart' show PromptingVersion;
import 'assistant_preferences.dart';

const int _maxMobileResourceBytes = 12 * 1024 * 1024;
const int _maxKnowledgeEntries = 20000;
const int _maxKnowledgeContentLength = 40000;
const int _maxJsonDepth = 32;

/// Immutable, non-content metadata shown by the preferences UI.
///
/// Hashes are calculated from the exact bundled bytes. The source strings and
/// paths identify the original mobile-app assets; this object never enters the
/// persisted assistant state.
class MobileAssistantResourcesSnapshot {
  const MobileAssistantResourcesSnapshot({
    required this.source,
    required this.systemPromptPath,
    required this.systemPromptSha256,
    required this.systemPromptByteLength,
    required this.skillPath,
    required this.skillSha256,
    required this.skillByteLength,
    required this.ideationReferencePath,
    required this.ideationReferenceSha256,
    required this.ideationReferenceByteLength,
    required this.writingReferencePath,
    required this.writingReferenceSha256,
    required this.writingReferenceByteLength,
    required this.knowledgePath,
    required this.knowledgeSha256,
    required this.knowledgeByteLength,
    required this.knowledgeEntryCount,
  });

  final String source;
  final String systemPromptPath;
  final String systemPromptSha256;
  final int systemPromptByteLength;
  final String skillPath;
  final String skillSha256;
  final int skillByteLength;
  final String ideationReferencePath;
  final String ideationReferenceSha256;
  final int ideationReferenceByteLength;
  final String writingReferencePath;
  final String writingReferenceSha256;
  final int writingReferenceByteLength;
  final String knowledgePath;
  final String knowledgeSha256;
  final int knowledgeByteLength;
  final int knowledgeEntryCount;
}

/// One original entry from the mobile knowledge JSON.
///
/// The fields retain their source values. Only a returned match may contain a
/// clipped [content], matching the mobile app's bounded matching behavior.
class MobileAssistantKnowledgeEntry {
  const MobileAssistantKnowledgeEntry({
    required this.id,
    required this.title,
    required this.source,
    required this.keywords,
    required this.content,
  });

  final int id;
  final String title;
  final String source;
  final List<String> keywords;
  final String content;

  MobileAssistantKnowledgeEntry _withContent(String value) =>
      MobileAssistantKnowledgeEntry(
        id: id,
        title: title,
        source: source,
        keywords: keywords,
        content: value,
      );
}

/// Loads the fixed, bundled mobile assistant resources and keeps them in memory.
///
/// A successful load is cached for the lifetime of this loader. Failed loads
/// clear only the in-flight future, so a later attempt can recover without
/// replacing any previously cached snapshot. Production uses [shared]; tests
/// may inject an [AssetBundle] or byte loader.
class AssistantMobileResources {
  AssistantMobileResources({AssetBundle? bundle, MobileAssetLoader? loader})
    : assert(bundle == null || loader == null),
      _bundle = bundle,
      _loader = loader;

  static final AssistantMobileResources shared = AssistantMobileResources();

  static const String sourceLabel = '手机端原始内置资源';
  static const String systemPromptAssetPath =
      'assets/assistant/mobile/system_prompt.txt';
  static const String knowledgeAssetPath =
      'assets/assistant/mobile/nsfw_knowledge.json';
  static const String skillAssetPath =
      'assets/assistant/mobile/nai5-prompting/SKILL.md';
  static const String ideationReferenceAssetPath =
      'assets/assistant/mobile/nai5-prompting/references/通用构思.md';
  static const String writingReferenceAssetPath =
      'assets/assistant/mobile/nai5-prompting/references/通用写法.md';

  final AssetBundle? _bundle;
  final MobileAssetLoader? _loader;
  MobileAssistantResourcesSnapshot? _snapshot;
  _LoadedMobileResources? _loaded;
  Future<MobileAssistantResourcesSnapshot>? _loading;

  /// Loads or returns the cached metadata for the original mobile resources.
  Future<MobileAssistantResourcesSnapshot> load() {
    final cached = _snapshot;
    if (cached != null) return Future.value(cached);
    return _loading ??= _loadAll()
        .then((loaded) {
          _loaded = loaded;
          _snapshot = loaded.snapshot;
          return loaded.snapshot;
        })
        .whenComplete(() {
          _loading = null;
        });
  }

  /// Exact mobile system-prompt text, available after [load] succeeds.
  String get systemPrompt => _requireLoaded.systemPrompt;

  /// Mobile skill text after the same trim operation used by the mobile app.
  String get v5Skill => _requireLoaded.skill;

  /// Returns one of the two fixed V5 reference documents after mobile trim.
  String reference(String name) {
    final resources = _requireLoaded;
    return switch (name) {
      'ideation' => resources.ideationReference,
      'writing' => resources.writingReference,
      _ => throw const FormatException('reference 只能是 ideation 或 writing。'),
    };
  }

  /// Matches the mobile knowledge book against only the current user text.
  ///
  /// Mobile uses a maximum of five results and 2,000 content characters. The
  /// optional limits may reduce these bounds for callers, but cannot raise
  /// them. Match ordering, keyword boundaries, and truncation follow the
  /// original mobile implementation.
  List<MobileAssistantKnowledgeEntry> matchKnowledge(
    String userInput, {
    int maxResults = 5,
    int maxTotalLength = 2000,
  }) {
    final entries = _requireLoaded.knowledgeEntries;
    if (userInput.trim().isEmpty || maxResults <= 0 || maxTotalLength <= 0) {
      return const [];
    }

    final resultLimit = maxResults.clamp(0, 5);
    final characterLimit = maxTotalLength.clamp(0, 2000);
    final input = userInput.toLowerCase();
    final hitIds = <int>{};

    for (final entry in entries) {
      for (final keyword in entry.keywords) {
        final lowered = keyword.toLowerCase();
        if (RegExp(r'^[a-z][a-z0-9_]+$').hasMatch(lowered)) {
          final pattern = RegExp('\\b${RegExp.escape(lowered)}\\b');
          if (pattern.hasMatch(input)) {
            hitIds.add(entry.id);
            break;
          }
        } else if (input.contains(lowered)) {
          hitIds.add(entry.id);
          break;
        }
      }
    }
    if (hitIds.isEmpty) return const [];

    final matched = entries.where((entry) => hitIds.contains(entry.id)).toList()
      ..sort((a, b) => a.id.compareTo(b.id));
    final result = <MobileAssistantKnowledgeEntry>[];
    var totalLength = 0;
    for (final entry in matched) {
      if (result.length >= resultLimit) break;
      final addedLength = entry.content.length;
      if (totalLength + addedLength > characterLimit) {
        final remaining = characterLimit - totalLength;
        if (remaining > 200) {
          result.add(entry._withContent(entry.content.substring(0, remaining)));
        }
        break;
      }
      result.add(entry);
      totalLength += addedLength;
    }
    return List.unmodifiable(result);
  }

  /// Builds the exact mobile version/style and V5 skill prompt additions.
  String buildSystemPrompt({
    required String systemPromptOverride,
    required AssistantPreferences preferences,
    required PromptingVersion version,
  }) {
    final baseSystemPrompt = systemPromptOverride.isNotEmpty
        ? systemPromptOverride
        : systemPrompt;
    final promptVersion = version == PromptingVersion.v45 ? 'v4.5' : 'v5';
    final defaultStyleWords = preferences.styleWordsFor(version).trim();
    var content = defaultStyleWords.isEmpty
        ? '$baseSystemPrompt\n\n## 当前 NovelAI 画风版本\n本会话使用 $promptVersion 画风。'
        : '$baseSystemPrompt\n\n## 当前 NovelAI 画风版本\n本会话使用 $promptVersion 画风。\n\n## 默认画风画师词（本会话版本）\n用户为 $promptVersion 设定的默认画风画师词：`$defaultStyleWords`\n\n约束：调用写入提示词工具时，必须把这段画风画师词拼到正向提示词的最前面（多个 tag 用逗号空格分隔）。除非用户明确要求更换画风，否则每次生成都要带上。';

    if (version == PromptingVersion.v5) {
      content =
          '$content\n\n## V5 提示词 Skill\n$v5Skill\n\n'
          '## App 集成边界\n'
          '以上 Skill 只负责 V5 提示词的构思与编排。App 的工具名称、确认机制、提示词框目标、'
          'read-then-write 约束和图片生成流程以本系统规则为准，不要自行发明工具。需要详细构思或写法时，'
          '调用 `read_prompting_reference` 读取对应参考文档；修改现有内容仍必须先调用 `read_current_prompts`。';
    }
    return content;
  }

  /// The original mobile system-message template for matched knowledge.
  String buildKnowledgeMessage(List<MobileAssistantKnowledgeEntry> entries) {
    if (entries.isEmpty) return '';
    final knowledgeText = entries
        .map(
          (entry) => '[来源: ${entry.source} - ${entry.title}]\n${entry.content}',
        )
        .join('\n\n---\n\n');
    return '## 参考知识库（命中关键词）\n以下内容是从知识库中匹配到的相关提示词参考：\n\n$knowledgeText';
  }

  /// The read-only reference tool used by V5 prompt sessions.
  List<AgentTool> buildPromptingTools(PromptingVersion version) {
    if (version != PromptingVersion.v5) return const [];
    return [
      AgentTool(
        name: 'read_prompting_reference',
        label: '读取提示词参考',
        description:
            '读取 NovelAI Diffusion V5 提示词 Skill 的参考规则。用户需求模糊、需要构思画面或多个方向时先读 ideation；'
            '准备编排、修改或写入 V5 提示词时必须读 writing，并在写完后按其中检查表自检。只供 V5 普通提示词会话使用。',
        parameters: schema(
          {
            'reference': {
              'type': 'string',
              'enum': ['ideation', 'writing'],
              'description': 'ideation=通用构思，writing=通用写法',
            },
          },
          required: ['reference'],
        ),
        prepare: (arguments, cancellation) async {
          cancellation.check();
          if (arguments.keys.any((key) => key != 'reference')) {
            throw const AgentException(
              'read_prompting_reference 只接受 reference 参数。',
            );
          }
          final referenceName = arguments['reference'];
          if (referenceName is! String ||
              !const {'ideation', 'writing'}.contains(referenceName)) {
            throw const AgentException('reference 只能是 ideation 或 writing。');
          }
          final content = reference(referenceName);
          return PreparedAgentTool(
            summary: referenceName == 'ideation'
                ? '已读取 V5 构思规则'
                : '已读取 V5 写法规则',
            execute: () async => {
              'reference': referenceName,
              'content': content,
            },
          );
        },
      ),
    ];
  }

  _LoadedMobileResources get _requireLoaded =>
      _loaded ?? (throw StateError('手机端助手资源尚未成功加载。'));

  Future<_LoadedMobileResources> _loadAll() async {
    final paths = <String>[
      systemPromptAssetPath,
      skillAssetPath,
      ideationReferenceAssetPath,
      writingReferenceAssetPath,
      knowledgeAssetPath,
    ];
    final byteSets = await Future.wait(paths.map(_readAsset));
    // Decode and hash the bundled book away from the Windows UI isolate.
    // compute uses the same function on web, where an isolate is unavailable.
    return compute(_decodeMobileResources, byteSets);
  }

  Future<Uint8List> _readAsset(String path) async {
    final loader = _loader;
    if (loader != null) return Uint8List.fromList(await loader(path));
    final bundle = _bundle ?? rootBundle;
    final data = await bundle.load(path);
    return Uint8List.fromList(
      data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes),
    );
  }
}

_LoadedMobileResources _decodeMobileResources(List<Uint8List> byteSets) {
  final totalBytes = byteSets.fold<int>(0, (sum, bytes) => sum + bytes.length);
  if (totalBytes > _maxMobileResourceBytes) {
    throw const FormatException('手机端助手资源总大小超过 12 MiB 限制。');
  }

  final systemPromptBytes = byteSets[0];
  final skillBytes = byteSets[1];
  final ideationBytes = byteSets[2];
  final writingBytes = byteSets[3];
  final knowledgeBytes = byteSets[4];
  final entries = _parseKnowledge(knowledgeBytes);
  final snapshot = MobileAssistantResourcesSnapshot(
    source: AssistantMobileResources.sourceLabel,
    systemPromptPath: AssistantMobileResources.systemPromptAssetPath,
    systemPromptSha256: _hash(systemPromptBytes),
    systemPromptByteLength: systemPromptBytes.length,
    skillPath: AssistantMobileResources.skillAssetPath,
    skillSha256: _hash(skillBytes),
    skillByteLength: skillBytes.length,
    ideationReferencePath: AssistantMobileResources.ideationReferenceAssetPath,
    ideationReferenceSha256: _hash(ideationBytes),
    ideationReferenceByteLength: ideationBytes.length,
    writingReferencePath: AssistantMobileResources.writingReferenceAssetPath,
    writingReferenceSha256: _hash(writingBytes),
    writingReferenceByteLength: writingBytes.length,
    knowledgePath: AssistantMobileResources.knowledgeAssetPath,
    knowledgeSha256: _hash(knowledgeBytes),
    knowledgeByteLength: knowledgeBytes.length,
    knowledgeEntryCount: entries.length,
  );
  return _LoadedMobileResources(
    snapshot: snapshot,
    systemPrompt: _decodeUtf8(systemPromptBytes),
    skill: _decodeUtf8(skillBytes).trim(),
    ideationReference: _decodeUtf8(ideationBytes).trim(),
    writingReference: _decodeUtf8(writingBytes).trim(),
    knowledgeEntries: List.unmodifiable(entries),
  );
}

typedef MobileAssetLoader = Future<Uint8List> Function(String path);

class _LoadedMobileResources {
  const _LoadedMobileResources({
    required this.snapshot,
    required this.systemPrompt,
    required this.skill,
    required this.ideationReference,
    required this.writingReference,
    required this.knowledgeEntries,
  });

  final MobileAssistantResourcesSnapshot snapshot;
  final String systemPrompt;
  final String skill;
  final String ideationReference;
  final String writingReference;
  final List<MobileAssistantKnowledgeEntry> knowledgeEntries;
}

List<MobileAssistantKnowledgeEntry> _parseKnowledge(Uint8List bytes) {
  final source = _decodeUtf8(bytes, stripBom: true);
  _DuplicateJsonKeyScanner(source).scan();
  final dynamic decoded;
  try {
    decoded = jsonDecode(source);
  } on FormatException {
    rethrow;
  } catch (error) {
    throw FormatException('手机端知识库 JSON 无效：$error');
  }
  if (decoded is! Map<String, dynamic> ||
      decoded.keys.toSet().difference(const {
        'entries',
        'version',
        'date',
        'total',
      }).isNotEmpty ||
      const {
        'entries',
        'version',
        'date',
        'total',
      }.difference(decoded.keys.toSet()).isNotEmpty ||
      decoded['entries'] is! List ||
      decoded['version'] is! int ||
      decoded['date'] is! String ||
      decoded['total'] is! int) {
    throw const FormatException('手机端知识库根对象结构无效。');
  }
  final rawEntries = decoded['entries'] as List<dynamic>;
  if (rawEntries.length > _maxKnowledgeEntries) {
    throw const FormatException('手机端知识库条目数超过 20000。');
  }
  if (decoded['total'] != rawEntries.length) {
    throw const FormatException('手机端知识库 total 与条目数不一致。');
  }
  final ids = <int>{};
  final entries = <MobileAssistantKnowledgeEntry>[];
  for (final rawEntry in rawEntries) {
    if (rawEntry is! Map<String, dynamic> ||
        rawEntry.keys.toSet().difference(const {
          'id',
          'title',
          'source',
          'keywords',
          'content',
        }).isNotEmpty ||
        const {
          'id',
          'title',
          'source',
          'keywords',
          'content',
        }.difference(rawEntry.keys.toSet()).isNotEmpty) {
      throw const FormatException('手机端知识库条目字段无效。');
    }
    final id = rawEntry['id'];
    final title = rawEntry['title'];
    final sourceName = rawEntry['source'];
    final keywords = rawEntry['keywords'];
    final content = rawEntry['content'];
    if (id is! int || id < 0 || !ids.add(id)) {
      throw const FormatException('手机端知识库条目 ID 无效或重复。');
    }
    if (title is! String || sourceName is! String || content is! String) {
      throw const FormatException('手机端知识库条目文本字段无效。');
    }
    if (title.trim().isEmpty || sourceName.trim().isEmpty) {
      throw const FormatException('手机端知识库条目 title/source 不能为空。');
    }
    if (content.length > _maxKnowledgeContentLength) {
      throw const FormatException('手机端知识库单条正文超过 40000 字符。');
    }
    if (keywords is! List<dynamic> ||
        keywords.length > 1024 ||
        keywords.any(
          (keyword) => keyword is! String || keyword.trim().isEmpty,
        )) {
      throw const FormatException('手机端知识库 keywords 字段无效。');
    }
    entries.add(
      MobileAssistantKnowledgeEntry(
        id: id,
        title: title,
        source: sourceName,
        keywords: List.unmodifiable(keywords.cast<String>()),
        content: content,
      ),
    );
  }
  return entries;
}

String _hash(Uint8List bytes) => sha256.convert(bytes).toString();

String _decodeUtf8(Uint8List bytes, {bool stripBom = false}) {
  final input =
      stripBom &&
          bytes.length >= 3 &&
          bytes[0] == 0xef &&
          bytes[1] == 0xbb &&
          bytes[2] == 0xbf
      ? bytes.sublist(3)
      : bytes;
  try {
    return utf8.decode(input, allowMalformed: false);
  } on FormatException {
    throw const FormatException('手机端助手资源不是有效 UTF-8。');
  }
}

/// Rejects duplicate object keys and excessive nesting before `jsonDecode`
/// materializes maps and silently overwrites duplicate values.
class _DuplicateJsonKeyScanner {
  _DuplicateJsonKeyScanner(this.source);

  final String source;
  var _index = 0;

  void scan() {
    _skipWhitespace();
    _scanValue(0);
    _skipWhitespace();
    if (_index != source.length) {
      throw const FormatException('手机端知识库 JSON 含多余内容。');
    }
  }

  void _scanValue(int parentDepth) {
    _skipWhitespace();
    if (_index >= source.length) return;
    switch (source[_index]) {
      case '{':
        _scanObject(_nextDepth(parentDepth));
      case '[':
        _scanArray(_nextDepth(parentDepth));
      case '"':
        _scanString();
      default:
        while (_index < source.length &&
            !const {
              ' ',
              '\t',
              '\r',
              '\n',
              ',',
              '}',
              ']',
            }.contains(source[_index])) {
          _index++;
        }
    }
  }

  int _nextDepth(int parentDepth) {
    final depth = parentDepth + 1;
    if (depth > _maxJsonDepth) {
      throw const FormatException('手机端知识库 JSON 嵌套层级超过 32 层。');
    }
    return depth;
  }

  void _scanObject(int depth) {
    _index++;
    _skipWhitespace();
    final keys = <String>{};
    while (_index < source.length && source[_index] != '}') {
      final key = jsonDecode(_scanString()) as String;
      if (!keys.add(key)) {
        throw const FormatException('手机端知识库 JSON 含重复字段。');
      }
      _skipWhitespace();
      if (_index < source.length && source[_index] == ':') _index++;
      _scanValue(depth);
      _skipWhitespace();
      if (_index < source.length && source[_index] == ',') {
        _index++;
        _skipWhitespace();
      } else {
        break;
      }
    }
    if (_index < source.length && source[_index] == '}') _index++;
  }

  void _scanArray(int depth) {
    _index++;
    _skipWhitespace();
    while (_index < source.length && source[_index] != ']') {
      _scanValue(depth);
      _skipWhitespace();
      if (_index < source.length && source[_index] == ',') {
        _index++;
        _skipWhitespace();
      } else {
        break;
      }
    }
    if (_index < source.length && source[_index] == ']') _index++;
  }

  String _scanString() {
    final start = _index;
    if (_index >= source.length || source[_index] != '"') {
      throw const FormatException('手机端知识库 JSON 字符串格式错误。');
    }
    _index++;
    while (_index < source.length) {
      final character = source[_index++];
      if (character == r'\') {
        if (_index < source.length) _index++;
      } else if (character == '"') {
        return source.substring(start, _index);
      }
    }
    throw const FormatException('手机端知识库 JSON 字符串未闭合。');
  }

  void _skipWhitespace() {
    while (_index < source.length &&
        const {' ', '\t', '\r', '\n'}.contains(source[_index])) {
      _index++;
    }
  }
}

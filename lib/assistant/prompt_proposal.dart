import 'dart:convert';

const int _maxInputLength = 200000;
const int _maxFieldLength = 24000;
const int _maxTotalFieldLength = 96000;
const int _maxReasonLength = 1000;
const int _maxJsonDepth = 32;

final RegExp _fencePattern = RegExp(r'```([^\r\n`]*)\r?\n([\s\S]*?)```');
final Set<String> _proposalJsonKeys = {
  'positive',
  'negative',
  'characters',
  'reason',
};

/// A prompt change proposed by an assistant response.
///
/// [fields] uses the same target names accepted by `assistantPromptValue`.
/// Values are retained verbatim, including whitespace, weighting syntax, and
/// line breaks. Parsing a proposal never applies it to a workbench.
class PromptProposal {
  final Map<String, String> fields;
  final String reason;

  PromptProposal({required Map<String, String> fields, this.reason = ''})
    : fields = Map<String, String>.unmodifiable(fields);
}

/// Parses an explicit prompt proposal from JSON or labelled prompt code blocks.
///
/// Returns null when [content] does not contain a clear prompt proposal. A
/// malformed, ambiguous, conflicting, or over-limit proposal throws a Chinese
/// [FormatException].
PromptProposal? parsePromptProposal(String content) {
  if (content.length > _maxInputLength) {
    throw const FormatException('提案内容超过 200000 个字符。');
  }

  final builder = _ProposalBuilder();
  final fences = _fencePattern.allMatches(content).toList(growable: false);
  final jsonCandidates = <Map<String, dynamic>>[];

  for (final fence in fences) {
    if ((fence.group(1) ?? '').trim().toLowerCase() != 'json') continue;
    final candidate = _decodeProposalJson(fence.group(2) ?? '');
    if (candidate != null) jsonCandidates.add(candidate);
  }

  // A response may be pure JSON, optionally alongside fenced blocks. Only the
  // complete text outside fences is considered, so examples embedded in prose
  // are never selected by searching for an arbitrary brace.
  final outsideFences = _removeFences(content, fences).trim();
  if (outsideFences.startsWith('{')) {
    final candidate = _decodeProposalJson(outsideFences);
    if (candidate != null) jsonCandidates.add(candidate);
  }

  if (jsonCandidates.length > 1) {
    throw const FormatException('发现多个 JSON 提案，无法确定应使用哪一个。');
  }

  var reason = '';
  if (jsonCandidates.isNotEmpty) {
    reason = _readJsonProposal(jsonCandidates.single, builder);
  }

  for (final fence in fences) {
    final info = (fence.group(1) ?? '').trim();
    if (info.toLowerCase() == 'json') continue;

    final directLabel = _targetForLabel(info);
    final hasPlainInfo =
        info.isEmpty ||
        const {
          'text',
          'txt',
          'plaintext',
          'prompt',
        }.contains(info.toLowerCase());
    final target =
        directLabel ??
        (hasPlainInfo
            ? _targetForLabel(_precedingLabel(content, fence.start))
            : null);
    if (target == null) continue;

    builder.add(target, _fenceValue(fence.group(2) ?? ''));
  }

  if (builder.fields.isEmpty) return null;
  return PromptProposal(fields: builder.fields, reason: reason);
}

Map<String, dynamic>? _decodeProposalJson(String raw) {
  final source = raw.trim();
  final rootKeys = _rootObjectKeys(source);
  final isToolObject = _rootLooksLikeTool(rootKeys);
  if (_maximumJsonNesting(source) > _maxJsonDepth) {
    if (!isToolObject && rootKeys?.any(_proposalJsonKeys.contains) == true) {
      throw const FormatException('提案 JSON 嵌套层级超过 32 层。');
    }
    return null;
  }

  dynamic decoded;
  try {
    decoded = jsonDecode(source);
  } on FormatException {
    if (_looksLikeMalformedProposalJson(source) &&
        !_looksLikeToolJson(source)) {
      throw const FormatException('提案 JSON 格式错误。');
    }
    return null;
  }

  if (decoded is! Map<String, dynamic>) return null;
  if (_isToolObject(decoded)) return null;
  if (!decoded.keys.any(_proposalJsonKeys.contains)) return null;

  _DuplicateKeyScanner(source).scan();
  return decoded;
}

String _readJsonProposal(
  Map<String, dynamic> object,
  _ProposalBuilder builder,
) {
  for (final key in object.keys) {
    if (!_proposalJsonKeys.contains(key)) {
      throw FormatException('提案 JSON 含不支持的字段“$key”。');
    }
  }

  _readStringField(object, 'positive', 'positive', builder);
  _readStringField(object, 'negative', 'negative', builder);

  final characters = object['characters'];
  if (object.containsKey('characters')) {
    if (characters is! List) {
      throw const FormatException('提案 JSON 的 characters 必须是数组。');
    }
    if (characters.length > 6) {
      throw const FormatException('提案 JSON 最多支持 6 个角色。');
    }
    for (var i = 0; i < characters.length; i++) {
      final item = characters[i];
      if (item is! Map<String, dynamic>) {
        throw FormatException('提案 JSON 的第 ${i + 1} 个角色必须是对象。');
      }
      for (final key in item.keys) {
        if (key != 'positive' && key != 'negative') {
          throw FormatException('第 ${i + 1} 个角色含不支持的字段“$key”。');
        }
      }
      _readStringField(item, 'positive', 'character_${i + 1}', builder);
      _readStringField(item, 'negative', 'character_${i + 1}_uc', builder);
    }
  }

  if (!object.containsKey('reason')) return '';
  final reason = object['reason'];
  if (reason is! String) {
    throw const FormatException('提案 JSON 的 reason 必须是字符串。');
  }
  if (reason.length > _maxReasonLength) {
    throw const FormatException('提案 JSON 的 reason 不能超过 1000 个字符。');
  }
  return reason;
}

void _readStringField(
  Map<String, dynamic> object,
  String sourceKey,
  String target,
  _ProposalBuilder builder,
) {
  if (!object.containsKey(sourceKey)) return;
  final value = object[sourceKey];
  if (value is! String) {
    throw FormatException('提案 JSON 的 $sourceKey 必须是字符串。');
  }
  builder.add(target, value);
}

String _removeFences(String content, List<RegExpMatch> fences) {
  if (fences.isEmpty) return content;
  final result = StringBuffer();
  var cursor = 0;
  for (final fence in fences) {
    result.write(content.substring(cursor, fence.start));
    cursor = fence.end;
  }
  result.write(content.substring(cursor));
  return result.toString();
}

String _fenceValue(String raw) {
  // The line break after the opening fence and before the closing fence are
  // Markdown framing. Remove exactly those framing breaks and preserve every
  // character inside the prompt itself, including CRLF and intentional blanks.
  var value = raw;
  if (value.endsWith('\r\n')) {
    value = value.substring(0, value.length - 2);
  } else if (value.endsWith('\n') || value.endsWith('\r')) {
    value = value.substring(0, value.length - 1);
  }
  return value;
}

String _precedingLabel(String content, int fenceStart) {
  final before = content.substring(0, fenceStart);
  final lines = before.split(RegExp(r'\r\n|\n|\r'));
  for (var i = lines.length - 1; i >= 0; i--) {
    var line = lines[i].trim();
    if (line.isEmpty) continue;
    line = line
        .replaceFirst(RegExp(r'^[#>\-\s]+'), '')
        .replaceAll('*', '')
        .replaceAll('`', '')
        .replaceFirst(RegExp(r'^_+'), '')
        .replaceFirst(RegExp(r'_+$'), '')
        .trim();
    if (line.endsWith('：') || line.endsWith(':')) {
      line = line.substring(0, line.length - 1).trim();
    }
    return line;
  }
  return '';
}

String? _targetForLabel(String label) {
  final normalized = label.replaceAll(RegExp(r'\s+'), '');
  final lower = normalized.toLowerCase();
  switch (lower) {
    case 'positive':
      return 'positive';
    case 'negative':
      return 'negative';
    case 'inpaint_positive':
      return 'inpaint_positive';
    case 'inpaint_negative':
      return 'inpaint_negative';
  }

  switch (normalized) {
    case '正向':
    case '正面':
    case '正向词':
    case '正面词':
    case '正向提示词':
    case '正面提示词':
    case '通用底模词':
    case '通用底模提示词':
      return 'positive';
    case '负向':
    case '负面':
    case '负向词':
    case '负面词':
    case '负向提示词':
    case '负面提示词':
      return 'negative';
  }

  if (normalized == '角色' ||
      RegExp(r'^角色(?:负向|负面|正向|正面)$').hasMatch(normalized)) {
    throw const FormatException('角色提案标签必须指定 1 到 6、 一到六或 A 到 F。');
  }
  final role = RegExp(r'^角色([0-9]+|[一二三四五六七八九十]|[A-Za-z])(.*)$')
      .firstMatch(normalized);
  if (role != null) {
    final index = _roleIndex(role.group(1)!);
    if (index == null) {
      throw const FormatException('角色提案标签无效；只支持角色 1 到 6、 一到六或 A 到 F。');
    }
    final suffix = role.group(2)!;
    final isNegative = const {
      '负向',
      '负面',
      '负向词',
      '负面词',
      '负向提示词',
      '负面提示词',
    }.contains(suffix);
    if (suffix.isNotEmpty &&
        !isNegative &&
        !const {
          '正向',
          '正面',
          '正向词',
          '正面词',
          '正向提示词',
          '正面提示词',
          '提示词',
          '词',
        }.contains(suffix)) {
      throw const FormatException('角色提案标签格式无效。');
    }
    return isNegative ? 'character_${index}_uc' : 'character_$index';
  }

  return null;
}

int? _roleIndex(String role) {
  final numeric = int.tryParse(role);
  if (numeric != null) return numeric >= 1 && numeric <= 6 ? numeric : null;
  const chinese = ['一', '二', '三', '四', '五', '六'];
  final chineseIndex = chinese.indexOf(role);
  if (chineseIndex >= 0) return chineseIndex + 1;
  final upper = role.toUpperCase();
  if (upper.length == 1 &&
      upper.codeUnitAt(0) >= 65 &&
      upper.codeUnitAt(0) <= 70) {
    return upper.codeUnitAt(0) - 64;
  }
  return null;
}

bool _looksLikeMalformedProposalJson(String source) {
  return RegExp(r'"(?:positive|negative|characters|reason)"\s*:')
      .hasMatch(source);
}

bool _looksLikeToolJson(String source) {
  return RegExp(r'"(?:function|tool_calls|arguments)"\s*:').hasMatch(source);
}

bool _isToolObject(Map<String, dynamic> object) {
  if (object.containsKey('function') || object.containsKey('tool_calls')) {
    return true;
  }
  return object.containsKey('arguments') &&
      (object.containsKey('name') ||
          object.containsKey('target') ||
          object.containsKey('type'));
}

Set<String>? _rootObjectKeys(String source) {
  var index = 0;
  void skipWhitespace() {
    while (index < source.length &&
        const {' ', '\t', '\r', '\n'}.contains(source[index])) {
      index++;
    }
  }

  skipWhitespace();
  if (index >= source.length || source[index] != '{') return null;
  index++;
  final keys = <String>{};

  while (index < source.length) {
    skipWhitespace();
    if (index >= source.length || source[index] == '}') return keys;
    if (source[index] != '"') return keys;

    final start = index++;
    var closed = false;
    while (index < source.length) {
      final character = source[index++];
      if (character == r'\') {
        if (index < source.length) index++;
      } else if (character == '"') {
        closed = true;
        break;
      }
    }
    if (!closed) return keys;

    String key;
    try {
      key = jsonDecode(source.substring(start, index)) as String;
    } on FormatException {
      return keys;
    }
    keys.add(key);

    skipWhitespace();
    if (index >= source.length || source[index] != ':') return keys;
    index++;
    index = _skipJsonValue(source, index);
    skipWhitespace();
    if (index < source.length && source[index] == ',') {
      index++;
      continue;
    }
    return keys;
  }
  return keys;
}

int _skipJsonValue(String source, int index) {
  while (index < source.length &&
      const {' ', '\t', '\r', '\n'}.contains(source[index])) {
    index++;
  }
  if (index >= source.length) return index;
  if (source[index] == '"') {
    index++;
    while (index < source.length) {
      final character = source[index++];
      if (character == r'\') {
        if (index < source.length) index++;
      } else if (character == '"') {
        break;
      }
    }
    return index;
  }
  if (source[index] != '{' && source[index] != '[') {
    while (index < source.length &&
        !const {',', '}', ']', ' ', '\t', '\r', '\n'}.contains(source[index])) {
      index++;
    }
    return index;
  }

  var nesting = 0;
  var inString = false;
  var escaping = false;
  while (index < source.length) {
    final character = source[index++];
    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (character == r'\') {
        escaping = true;
      } else if (character == '"') {
        inString = false;
      }
      continue;
    }
    if (character == '"') {
      inString = true;
    } else if (character == '{' || character == '[') {
      nesting++;
    } else if (character == '}' || character == ']') {
      nesting--;
      if (nesting == 0) return index;
    }
  }
  return index;
}

bool _rootLooksLikeTool(Set<String>? rootKeys) {
  if (rootKeys == null) return false;
  if (rootKeys.contains('function') || rootKeys.contains('tool_calls')) {
    return true;
  }
  return rootKeys.contains('arguments') &&
      (rootKeys.contains('name') ||
          rootKeys.contains('target') ||
          rootKeys.contains('type'));
}

int _maximumJsonNesting(String source) {
  var nesting = 0;
  var maximum = 0;
  var inString = false;
  var escaping = false;
  for (var index = 0; index < source.length; index++) {
    final character = source[index];
    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (character == r'\') {
        escaping = true;
      } else if (character == '"') {
        inString = false;
      }
      continue;
    }
    if (character == '"') {
      inString = true;
    } else if (character == '{' || character == '[') {
      nesting++;
      if (nesting > maximum) maximum = nesting;
    } else if ((character == '}' || character == ']') && nesting > 0) {
      nesting--;
    }
  }
  return maximum;
}

class _ProposalBuilder {
  final fields = <String, String>{};
  final _seenTargets = <String>{};
  var _totalLength = 0;

  void add(String target, String value) {
    if (!_isWorkbenchTarget(target)) {
      throw FormatException('提案目标“$target”无效。');
    }
    if (!_seenTargets.add(target)) {
      throw FormatException('提案目标“$target”重复，无法确定应使用哪一段内容。');
    }
    if (value.length > _maxFieldLength) {
      throw FormatException('目标“$target”的内容超过 24000 个字符。');
    }
    if (value.isNotEmpty) {
      _totalLength += value.length;
      if (_totalLength > _maxTotalFieldLength) {
        throw const FormatException('提案字段总长度超过 96000 个字符。');
      }
      fields[target] = value;
    }
  }
}

bool _isWorkbenchTarget(String target) {
  if (const {
    'positive',
    'negative',
    'inpaint_positive',
    'inpaint_negative',
  }.contains(target)) {
    return true;
  }
  return RegExp(r'^character_[1-6](_uc)?$').hasMatch(target);
}

/// Scans a valid JSON document for repeated object keys before jsonDecode's
/// normal Map conversion can silently overwrite one of them.
class _DuplicateKeyScanner {
  _DuplicateKeyScanner(this.source);

  final String source;
  var _index = 0;

  void scan() {
    _skipWhitespace();
    _scanValue(0);
    _skipWhitespace();
    if (_index != source.length) {
      throw const FormatException('提案 JSON 含多余内容。');
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
      throw const FormatException('提案 JSON 嵌套层级超过 32 层。');
    }
    return depth;
  }

  void _scanObject(int depth) {
    _index++;
    _skipWhitespace();
    final keys = <String>{};
    while (_index < source.length && source[_index] != '}') {
      final keyToken = _scanString();
      final key = jsonDecode(keyToken) as String;
      if (!keys.add(key)) {
        throw FormatException('提案 JSON 含重复字段“$key”。');
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
      throw const FormatException('提案 JSON 字符串格式错误。');
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
    throw const FormatException('提案 JSON 字符串未闭合。');
  }

  void _skipWhitespace() {
    while (_index < source.length &&
        const {' ', '\t', '\r', '\n'}.contains(source[_index])) {
      _index++;
    }
  }
}

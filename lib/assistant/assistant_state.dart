import '../media/image_asset_validation.dart' show parseImageAssetRef;
import 'agent_contract.dart';
import 'prompt_memory.dart';
import 'prompt_application.dart';
import 'prompting_knowledge.dart';

const int _assistantStateSchema = 1;

/// A single user turn and its assistant/tool wire history.
///
/// The user message is stored separately in [userText] and [attachments].
/// [messages] contains only assistant and tool messages. [liveText] is
/// transient streaming output and is deliberately omitted from the durable format.
class AssistantTurn {
  AssistantTurn({
    required this.id,
    required this.userText,
    List<String> attachments = const [],
    this.status = 'running',
    List<Map<String, dynamic>> messages = const [],
    List<Map<String, dynamic>> traces = const [],
    this.error = '',
    this.providerLabel = '',
    this.providerContext = '',
    this.liveText = '',
    this.promptingVersion,
    this.proposalDraftFingerprint = '',
    this.proposalInpaint = false,
    this.promptApplication,
  }) : attachments = List<String>.of(attachments),
       messages = _copyAssistantMessages(messages),
       traces = _copyTraceMaps(traces) {
    _validate();
  }

  String id;
  String userText;
  List<String> attachments;
  String status;
  List<Map<String, dynamic>> messages;
  List<Map<String, dynamic>> traces;
  String error;
  String providerLabel;
  String providerContext;
  PromptingVersion? promptingVersion;
  String proposalDraftFingerprint;
  bool proposalInpaint;
  PromptApplication? promptApplication;

  /// Streaming text that should not survive app restart.
  String liveText;

  static const int maxAttachments = 32;
  static const int maxMessages = 512;
  static const int maxTraces = 512;

  Map<String, dynamic> toJson() {
    _validate();
    return {
      'id': id,
      'userText': userText,
      'attachments': List<String>.of(attachments),
      'status': status,
      'messages': _copyAssistantMessages(messages),
      'traces': _copyTraceMaps(traces),
      'error': error,
      'providerLabel': providerLabel,
      'providerContext': providerContext,
      'promptingVersion': promptingVersion?.name,
      'proposalDraftFingerprint': proposalDraftFingerprint,
      'proposalInpaint': proposalInpaint,
      'promptApplication': promptApplication?.toJson(),
    };
  }

  factory AssistantTurn.fromJson(Map<String, dynamic> json) {
    try {
      final status = _readString(json, 'status', maxLength: 32);
      final traces = _readMapList(
        json,
        'traces',
        maxLength: maxTraces,
        copy: _copyTraceMap,
      );
      for (final trace in traces) {
        final traceStatus = trace['status'];
        if (traceStatus is String &&
            const {'pending', 'running', 'waiting'}.contains(traceStatus)) {
          trace['status'] = 'interrupted';
        }
      }

      return AssistantTurn(
        promptingVersion: _promptingVersion(json['promptingVersion']),
        proposalDraftFingerprint: json.containsKey('proposalDraftFingerprint')
            ? _readString(json, 'proposalDraftFingerprint', maxLength: 64)
            : '',
        proposalInpaint: json.containsKey('proposalInpaint')
            ? json['proposalInpaint'] as bool
            : false,
        promptApplication: json['promptApplication'] == null
            ? null
            : PromptApplication.fromJson(
                _asStringMap(json['promptApplication'], 'promptApplication'),
              ),
        id: _readString(json, 'id', maxLength: _maxIdLength),
        userText: _readString(json, 'userText', maxLength: _maxTurnTextLength),
        attachments: _readStringList(
          json,
          'attachments',
          maxLength: maxAttachments,
        ),
        status: const {'running', 'waiting'}.contains(status)
            ? 'interrupted'
            : status,
        messages: _readMapList(
          json,
          'messages',
          maxLength: maxMessages,
          copy: _copyAssistantMessage,
        ),
        traces: traces,
        error: _readString(json, 'error', maxLength: _maxErrorLength),
        providerLabel: _readString(
          json,
          'providerLabel',
          maxLength: _maxLabelLength,
        ),
        providerContext: json.containsKey('providerContext')
            ? _readString(json, 'providerContext', maxLength: 64)
            : '',
      );
    } on FormatException {
      rethrow;
    } catch (error) {
      throw FormatException('Invalid assistant turn: $error');
    }
  }

  void _validate() {
    _validateId(id, 'turn id');
    _validateText(userText, 'userText', _maxTurnTextLength);
    _validateText(error, 'error', _maxErrorLength);
    _validateText(providerLabel, 'providerLabel', _maxLabelLength);
    _validateText(providerContext, 'providerContext', 64);
    if (proposalDraftFingerprint.isNotEmpty &&
        (promptingVersion == null ||
            !RegExp(r'^[a-f0-9]{64}$').hasMatch(proposalDraftFingerprint))) {
      throw const FormatException('Invalid proposal draft fingerprint.');
    }
    if (promptApplication != null &&
        (promptApplication!.version != promptingVersion ||
            proposalDraftFingerprint.isEmpty)) {
      throw const FormatException('Invalid proposal application provenance.');
    }
    if (!const {
      'running',
      'waiting',
      'interrupted',
      'complete',
      'failed',
      'cancelled',
    }.contains(status)) {
      throw FormatException('Invalid assistant turn status: $status');
    }
    _validateImageRefs(attachments, 'turn attachments', maxAttachments);
    if (messages.length > maxMessages) {
      throw FormatException('Too many assistant messages (max $maxMessages).');
    }
    if (traces.length > maxTraces) {
      throw FormatException('Too many assistant traces (max $maxTraces).');
    }
    _copyAssistantMessages(messages);
    _copyTraceMaps(traces);
  }
}

/// A durable assistant conversation with its own editable draft and turns.
class AssistantSession {
  AssistantSession({
    required this.id,
    required this.title,
    List<AssistantTurn> turns = const [],
    this.input = '',
    this.promptingVersion,
    List<String> attachments = const [],
  }) : turns = List<AssistantTurn>.of(turns),
       attachments = List<String>.of(attachments) {
    _validate();
  }

  String id;
  String title;
  List<AssistantTurn> turns;
  String input;
  PromptingVersion? promptingVersion;
  List<String> attachments;

  static const int maxTurns = 2000;
  static const int maxAttachments = 32;

  Map<String, dynamic> toJson() {
    _validate();
    return {
      'id': id,
      'title': title,
      'turns': turns.map((turn) => turn.toJson()).toList(),
      'input': input,
      'promptingVersion': promptingVersion?.name,
      'attachments': List<String>.of(attachments),
    };
  }

  factory AssistantSession.fromJson(Map<String, dynamic> json) {
    try {
      final turns = _readMapList(
        json,
        'turns',
        maxLength: maxTurns,
        copy: _copyPlainMap,
      ).map(AssistantTurn.fromJson).toList();
      return AssistantSession(
        promptingVersion: _promptingVersion(json['promptingVersion']),
        id: _readString(json, 'id', maxLength: _maxIdLength),
        title: _readString(json, 'title', maxLength: _maxTitleLength),
        turns: turns,
        input: _readString(json, 'input', maxLength: _maxDraftLength),
        attachments: _readStringList(
          json,
          'attachments',
          maxLength: maxAttachments,
        ),
      );
    } on FormatException {
      rethrow;
    } catch (error) {
      throw FormatException('Invalid assistant session: $error');
    }
  }

  void _validate() {
    _validateId(id, 'session id');
    _validateText(title, 'title', _maxTitleLength);
    _validateText(input, 'input', _maxDraftLength);
    _validateImageRefs(attachments, 'session attachments', maxAttachments);
    if (turns.length > maxTurns) {
      throw FormatException(
        'Too many turns in assistant session (max $maxTurns).',
      );
    }
    final ids = <String>{};
    for (final turn in turns) {
      turn._validate();
      if (!ids.add(turn.id)) {
        throw FormatException('Duplicate turn id in session: ${turn.id}');
      }
    }
  }
}

/// Persistent assistant configuration and session index.
///
/// Only public provider settings are stored. Provider credentials belong in the
/// credential vault and are never part of this state model.
class AssistantState {
  AssistantState({
    List<AssistantProvider> providers = const [],
    String? mainProviderId,
    String? visionProviderId,
    this.contextTurns = 8,
    this.systemPrompt = '',
    this.promptingVersion = PromptingVersion.v45,
    PromptMemoryLibrary? memories,
    List<AssistantSession> sessions = const [],
    String? activeSessionId,
  }) : memories = memories ?? PromptMemoryLibrary(),
       providers = List<AssistantProvider>.of(providers),
       mainProviderId = _emptyToNull(mainProviderId),
       visionProviderId = _emptyToNull(visionProviderId),
       sessions = List<AssistantSession>.of(sessions),
       activeSessionId = _emptyToNull(activeSessionId) {
    _validate();
  }

  List<AssistantProvider> providers;
  String? mainProviderId;
  String? visionProviderId;
  int contextTurns;
  String systemPrompt;
  PromptingVersion promptingVersion;
  final PromptMemoryLibrary memories;
  List<AssistantSession> sessions;
  String? activeSessionId;

  static const int schemaVersion = _assistantStateSchema;
  static const int maxProviders = 128;
  static const int maxSessions = 500;
  static const int maxContextTurns = 200;

  AssistantSession? get activeSession {
    final id = activeSessionId;
    if (id == null) return null;
    for (final session in sessions) {
      if (session.id == id) return session;
    }
    throw FormatException('activeSessionId does not reference a session: $id');
  }

  AssistantProvider? get mainProvider => _providerFor(mainProviderId);
  AssistantProvider? get visionProvider => _providerFor(visionProviderId);

  AssistantProvider? _providerFor(String? id) {
    if (id == null) return null;
    for (final provider in providers) {
      if (provider.id == id) return provider;
    }
    throw FormatException('Provider reference does not exist: $id');
  }

  Map<String, dynamic> toJson() {
    _validate();
    return {
      'schema': schemaVersion,
      'providers': providers.map((provider) => provider.toJson()).toList(),
      'mainProviderId': mainProviderId,
      'visionProviderId': visionProviderId,
      'contextTurns': contextTurns,
      'systemPrompt': systemPrompt,
      'promptingVersion': promptingVersion.name,
      'memories': memories.toJson(),
      'sessions': sessions.map((session) => session.toJson()).toList(),
      'activeSessionId': activeSessionId,
    };
  }

  factory AssistantState.fromJson(Map<String, dynamic> json) {
    try {
      if (json['schema'] is! int || json['schema'] != schemaVersion) {
        throw FormatException(
          'Unsupported assistant state schema: ${json['schema']}',
        );
      }

      final providers = _readMapList(
        json,
        'providers',
        maxLength: maxProviders,
        copy: _copyPlainMap,
      ).map(_providerFromJson).toList();
      final sessions = _readMapList(
        json,
        'sessions',
        maxLength: maxSessions,
        copy: _copyPlainMap,
      ).map(AssistantSession.fromJson).toList();

      return AssistantState(
        promptingVersion: json.containsKey('promptingVersion')
            ? _promptingVersion(json['promptingVersion']) ??
                  (throw const FormatException('Missing prompting version.'))
            : PromptingVersion.v45,
        providers: providers,
        mainProviderId: _readNullableId(json, 'mainProviderId'),
        visionProviderId: _readNullableId(json, 'visionProviderId'),
        contextTurns: _readInt(json, 'contextTurns'),
        systemPrompt: _readString(
          json,
          'systemPrompt',
          maxLength: _maxSystemPromptLength,
        ),
        memories: json.containsKey('memories')
            ? PromptMemoryLibrary.fromJson(
                _asStringMap(json['memories'], 'memories'),
              )
            : PromptMemoryLibrary(),
        sessions: sessions,
        activeSessionId: _readNullableId(json, 'activeSessionId'),
      );
    } on FormatException {
      rethrow;
    } catch (error) {
      throw FormatException('Invalid assistant state: $error');
    }
  }

  void _validate() {
    if (providers.length > maxProviders) {
      throw FormatException(
        'Too many assistant providers (max $maxProviders).',
      );
    }
    if (sessions.length > maxSessions) {
      throw FormatException('Too many assistant sessions (max $maxSessions).');
    }
    if (contextTurns < 0 || contextTurns > maxContextTurns) {
      throw FormatException(
        'contextTurns must be between 0 and $maxContextTurns.',
      );
    }
    _validateText(systemPrompt, 'systemPrompt', _maxSystemPromptLength);

    final providerIds = <String>{};
    for (final provider in providers) {
      try {
        provider.validate();
      } on AgentException catch (error) {
        throw FormatException('Invalid assistant provider: ${error.message}');
      }
      _validateId(provider.id, 'provider id');
      if (!providerIds.add(provider.id)) {
        throw FormatException(
          'Duplicate assistant provider id: ${provider.id}',
        );
      }
    }

    final sessionIds = <String>{};
    final turnIds = <String>{};
    for (final session in sessions) {
      session._validate();
      if (!sessionIds.add(session.id)) {
        throw FormatException('Duplicate assistant session id: ${session.id}');
      }
      for (final turn in session.turns) {
        if (!turnIds.add(turn.id)) {
          throw FormatException('Duplicate assistant turn id: ${turn.id}');
        }
      }
    }

    _validateReference(mainProviderId, providerIds, 'mainProviderId');
    _validateReference(visionProviderId, providerIds, 'visionProviderId');
    _validateReference(activeSessionId, sessionIds, 'activeSessionId');
  }
}

const int _maxIdLength = 128;
const int _maxLabelLength = 200;
const int _maxTitleLength = 256;
const int _maxErrorLength = 16384;
const int _maxTurnTextLength = 1000000;
const int _maxDraftLength = 1000000;
const int _maxSystemPromptLength = 500000;
const int _maxJsonDepth = 64;
const int _maxJsonNodes = 100000;
const int _maxJsonStringLength = 2000000;

PromptingVersion? _promptingVersion(Object? value) {
  if (value == null) return null;
  for (final version in PromptingVersion.values) {
    if (value == version.name) return version;
  }
  throw const FormatException('Unsupported prompting version.');
}

AssistantProvider _providerFromJson(Map<String, dynamic> json) {
  try {
    return AssistantProvider.fromJson(json);
  } on FormatException {
    rethrow;
  } catch (error) {
    throw FormatException('Invalid assistant provider: $error');
  }
}

String _readString(
  Map<String, dynamic> json,
  String key, {
  required int maxLength,
}) {
  final value = json[key];
  if (value is! String) throw FormatException('$key must be a string.');
  _validateText(value, key, maxLength);
  return value;
}

String? _readNullableId(Map<String, dynamic> json, String key) {
  if (!json.containsKey(key)) throw FormatException('$key is required.');
  final value = json[key];
  if (value == null) return null;
  if (value is! String) throw FormatException('$key must be a string or null.');
  return _emptyToNull(value);
}

int _readInt(Map<String, dynamic> json, String key) {
  final value = json[key];
  if (value is! int) throw FormatException('$key must be an integer.');
  return value;
}

List<String> _readStringList(
  Map<String, dynamic> json,
  String key, {
  required int maxLength,
}) {
  final value = json[key];
  if (value is! List) throw FormatException('$key must be a list.');
  if (value.length > maxLength) {
    throw FormatException('$key exceeds the limit of $maxLength items.');
  }
  final result = <String>[];
  for (final item in value) {
    if (item is! String) throw FormatException('$key items must be strings.');
    if (item.length > 256) {
      throw FormatException('$key contains an item that is too long.');
    }
    result.add(item);
  }
  return result;
}

List<Map<String, dynamic>> _readMapList(
  Map<String, dynamic> json,
  String key, {
  required int maxLength,
  required Map<String, dynamic> Function(Map<String, dynamic>) copy,
}) {
  final value = json[key];
  if (value is! List) throw FormatException('$key must be a list.');
  if (value.length > maxLength) {
    throw FormatException('$key exceeds the limit of $maxLength items.');
  }
  return value.map((item) => copy(_asStringMap(item, key))).toList();
}

Map<String, dynamic> _asStringMap(Object? value, String label) {
  if (value is! Map) throw FormatException('$label items must be objects.');
  try {
    return Map<String, dynamic>.from(value);
  } catch (_) {
    throw FormatException('$label object keys must be strings.');
  }
}

Map<String, dynamic> _copyPlainMap(Map<String, dynamic> source) =>
    _copyJsonMap(source, stripCredentialKeys: false);

Map<String, dynamic> _copyAssistantMessage(Map<String, dynamic> source) {
  final role = source['role'];
  if (role is! String || (role != 'assistant' && role != 'tool')) {
    throw FormatException(
      'Assistant wire messages must have role assistant or tool.',
    );
  }
  return _copyJsonMap(source, stripCredentialKeys: true);
}

Map<String, dynamic> _copyTraceMap(Map<String, dynamic> source) {
  final status = source['status'];
  if (source.containsKey('status')) {
    if (status is! String ||
        !const {
          'pending',
          'waiting',
          'running',
          'completed',
          'denied',
          'failed',
          'cancelled',
          'interrupted',
        }.contains(status)) {
      throw const FormatException('Invalid assistant trace status.');
    }
  }
  return _copyJsonMap(source, stripCredentialKeys: true);
}

Map<String, dynamic> _copyJsonMap(
  Map<String, dynamic> source, {
  required bool stripCredentialKeys,
}) {
  final budget = _JsonBudget();
  final result = <String, dynamic>{};
  for (final entry in source.entries) {
    if (stripCredentialKeys && _isCredentialKey(entry.key)) continue;
    result[entry.key] = _copyJsonValue(entry.value, budget: budget, depth: 0);
  }
  return result;
}

List<Map<String, dynamic>> _copyAssistantMessages(
  List<Map<String, dynamic>> messages,
) => messages.map(_copyAssistantMessage).toList();

List<Map<String, dynamic>> _copyTraceMaps(List<Map<String, dynamic>> traces) =>
    traces.map(_copyTraceMap).toList();

dynamic _copyJsonValue(
  Object? value, {
  required _JsonBudget budget,
  required int depth,
}) {
  budget.consume(depth);
  if (value == null || value is bool || value is String) {
    if (value is String && value.length > _maxJsonStringLength) {
      throw const FormatException(
        'Assistant JSON string exceeds its size limit.',
      );
    }
    return value;
  }
  if (value is int) return value;
  if (value is double) {
    if (!value.isFinite) {
      throw const FormatException('Assistant JSON numbers must be finite.');
    }
    return value;
  }
  if (value is List) {
    return value
        .map((item) => _copyJsonValue(item, budget: budget, depth: depth + 1))
        .toList();
  }
  if (value is Map) {
    final result = <String, dynamic>{};
    for (final entry in value.entries) {
      if (entry.key is! String) {
        throw const FormatException(
          'Assistant JSON object keys must be strings.',
        );
      }
      final key = entry.key as String;
      if (_isCredentialKey(key)) continue;
      result[key] = _copyJsonValue(
        entry.value,
        budget: budget,
        depth: depth + 1,
      );
    }
    return result;
  }
  throw FormatException(
    'Unsupported assistant JSON value: ${value.runtimeType}.',
  );
}

class _JsonBudget {
  int nodes = 0;

  void consume(int depth) {
    nodes++;
    if (depth > _maxJsonDepth || nodes > _maxJsonNodes) {
      throw const FormatException(
        'Assistant JSON structure exceeds its size limit.',
      );
    }
  }
}

bool _isCredentialKey(String key) {
  final normalized = key.toLowerCase().replaceAll(RegExp(r'[^a-z0-9]'), '');
  return normalized == 'token' ||
      normalized.contains('apikey') ||
      normalized.contains('secret') ||
      normalized.contains('authorization') ||
      normalized.contains('password') ||
      normalized.contains('credential') ||
      normalized.contains('cookie') ||
      normalized.contains('privatekey') ||
      normalized.contains('bearer') ||
      normalized.contains('accesstoken') ||
      normalized.contains('refreshtoken');
}

void _validateImageRefs(List<String> refs, String label, int maxLength) {
  if (refs.length > maxLength) {
    throw FormatException('$label exceeds the limit of $maxLength items.');
  }
  final uniqueRefs = <String>{};
  for (final ref in refs) {
    if (!uniqueRefs.add(ref)) {
      throw FormatException('$label contains a duplicate reference.');
    }
    try {
      parseImageAssetRef(ref);
    } catch (error) {
      throw FormatException(
        '$label contains an invalid image reference: $error',
      );
    }
  }
}

void _validateReference(String? id, Set<String> validIds, String label) {
  if (id == null) return;
  if (!validIds.contains(id)) {
    throw FormatException('$label does not reference an existing item: $id');
  }
}

String? _emptyToNull(String? value) =>
    value == null || value.trim().isEmpty ? null : value;

void _validateId(String value, String label) {
  if (value.trim().isEmpty || value.length > _maxIdLength) {
    throw FormatException(
      '$label must be non-empty and at most $_maxIdLength characters.',
    );
  }
}

void _validateText(String value, String label, int maxLength) {
  if (value.length > maxLength) {
    throw FormatException('$label exceeds the limit of $maxLength characters.');
  }
}

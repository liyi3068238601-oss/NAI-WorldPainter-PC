import 'dart:math' as math;

enum MemoryKind {
  characterName('人名', 'character_name'),
  characterFeature('人物特征', 'character_feature'),
  style('画风', 'style'),
  other('其他', 'other'),
  fact('事实', 'fact'),
  preference('偏好', 'preference'),
  observation('观察', 'observation'),
  decision('决策', 'decision');

  const MemoryKind(this.label, this.wireName);

  final String label;
  final String wireName;
}

enum MemorySource {
  manual('手动'),
  userInstruction('用户指令'),
  llmCandidate('AI 候选'),
  pendingLlmCandidate('待审核候选');

  const MemorySource(this.label);

  final String label;
}

enum MemoryResolution { replace, merge, coexist }

/// A single immutable prompt-memory record.
///
/// Memory text is untrusted user data. Callers must keep it separate from
/// system and task instructions when building an assistant prompt.
class MemoryEntry {
  const MemoryEntry({
    required this.id,
    required this.trigger,
    required this.content,
    required this.kind,
    required this.source,
    required this.hitCount,
    required this.lastHitAt,
    required this.createdAt,
    required this.updatedAt,
    required this.supersededBy,
  });

  final String id;
  final String trigger;
  final String content;
  final MemoryKind kind;
  final MemorySource source;
  final int hitCount;
  final DateTime? lastHitAt;
  final DateTime createdAt;
  final DateTime updatedAt;
  final String? supersededBy;

  bool get isRetrievable =>
      source != MemorySource.pendingLlmCandidate && supersededBy == null;

  MemoryEntry _copyWith({
    String? trigger,
    String? content,
    MemoryKind? kind,
    MemorySource? source,
    int? hitCount,
    DateTime? lastHitAt,
    DateTime? createdAt,
    DateTime? updatedAt,
    String? supersededBy,
  }) {
    return MemoryEntry(
      id: id,
      trigger: trigger ?? this.trigger,
      content: content ?? this.content,
      kind: kind ?? this.kind,
      source: source ?? this.source,
      hitCount: hitCount ?? this.hitCount,
      lastHitAt: lastHitAt ?? this.lastHitAt,
      createdAt: createdAt ?? this.createdAt,
      updatedAt: updatedAt ?? this.updatedAt,
      supersededBy: supersededBy ?? this.supersededBy,
    );
  }
}

class MemoryConflictException implements Exception {
  MemoryConflictException({
    required this.trigger,
    required Iterable<MemoryEntry> entries,
  }) : entries = List<MemoryEntry>.unmodifiable(entries);

  final String trigger;
  final List<MemoryEntry> entries;

  @override
  String toString() => 'MemoryConflictException: "$trigger" 已有活动记忆';
}

class MemoryRevisionConflictException implements Exception {
  const MemoryRevisionConflictException({
    required this.expectedRevision,
    required this.actualRevision,
  });

  final int expectedRevision;
  final int actualRevision;

  @override
  String toString() =>
      'MemoryRevisionConflictException: expected revision '
      '$expectedRevision, actual $actualRevision';
}

/// In-memory, revisioned model for a local prompt-memory library.
///
/// The library is synchronous so each mutation validates and prepares its
/// complete next state before swapping it in. Serialized data is untrusted and
/// is validated strictly by [PromptMemoryLibrary.fromJson].
class PromptMemoryLibrary {
  static const int schemaVersion = 1;
  static const int maxEntries = 5000;
  static const int maxTriggerLength = 200;
  static const int maxContentLength = 8000;

  static final math.Random _idRandom = math.Random.secure();

  List<MemoryEntry> _entries = const [];
  int _revision = 0;

  PromptMemoryLibrary();

  PromptMemoryLibrary._loaded(List<MemoryEntry> entries, int revision)
    : _entries = List<MemoryEntry>.unmodifiable(entries),
      _revision = revision;

  List<MemoryEntry> get entries => _entries;

  int get revision => _revision;

  /// Adds a new entry or updates the entry with [id].
  ///
  /// Trigger comparison trims and collapses whitespace. replace and merge
  /// create a new revision of the active record(s), retaining the old records
  /// as superseded history. A pending candidate can coexist with an active
  /// record, but cannot supersede it. Updating an entry preserves its source;
  /// [approve] is the only path that promotes a pending candidate.
  MemoryEntry save({
    String? id,
    required String trigger,
    required String content,
    required MemoryKind kind,
    MemorySource source = MemorySource.manual,
    MemoryResolution? resolution,
    int? expectedRevision,
    DateTime? now,
  }) {
    _checkRevision(expectedRevision);

    final normalizedTrigger = _normalizeTrigger(trigger);
    final normalizedContent = _normalizeContent(content);
    _validateText(normalizedTrigger, normalizedContent);

    final existingIndex = id == null ? -1 : _indexOfId(id);
    if (id != null && existingIndex < 0) {
      throw StateError('记忆 "$id" 不存在，无法更新');
    }
    final current = existingIndex < 0 ? null : _entries[existingIndex];
    if (current?.supersededBy != null) {
      throw StateError('已被替代的历史记忆不能编辑');
    }
    final effectiveSource = current?.source ?? source;
    var conflicts = const <MemoryEntry>[];
    var finalContent = normalizedContent;
    if (effectiveSource == MemorySource.pendingLlmCandidate) {
      if (current == null) {
        final duplicate = _pendingDuplicate(
          normalizedTrigger,
          normalizedContent,
          kind,
        );
        if (duplicate != null) return duplicate;
      }
    } else {
      conflicts = _conflictsFor(normalizedTrigger, excludeId: id);
      _requireResolution(normalizedTrigger, conflicts, resolution);
      if (conflicts.isNotEmpty && resolution == MemoryResolution.merge) {
        finalContent = _mergeContent(normalizedContent, conflicts);
        _validateText(normalizedTrigger, finalContent);
      }
    }

    if (current == null && _entries.length >= maxEntries) {
      throw ArgumentError('记忆数量不能超过 $maxEntries');
    }

    final timestamp = now ?? DateTime.now();
    final entryId = id ?? _newId();
    final newEntry = MemoryEntry(
      id: entryId,
      trigger: normalizedTrigger,
      content: finalContent,
      kind: kind,
      source: effectiveSource,
      hitCount: current?.hitCount ?? 0,
      lastHitAt: current?.lastHitAt,
      createdAt: current?.createdAt ?? timestamp,
      updatedAt: timestamp,
      supersededBy: current?.supersededBy,
    );

    final next = List<MemoryEntry>.of(_entries);
    if (current == null) {
      next.add(newEntry);
    } else {
      next[existingIndex] = newEntry;
    }
    if (effectiveSource != MemorySource.pendingLlmCandidate &&
        (resolution == MemoryResolution.replace ||
            resolution == MemoryResolution.merge)) {
      _markSuperseded(next, conflicts, entryId, timestamp);
    }
    _commit(next);
    return newEntry;
  }

  /// Returns active entries with the same whitespace-normalized trigger.
  List<MemoryEntry> conflicts(String trigger, {String? excludeId}) {
    final normalized = _normalizeTrigger(trigger);
    if (normalized.isEmpty) return const [];
    return List<MemoryEntry>.unmodifiable(
      _conflictsFor(normalized, excludeId: excludeId),
    );
  }

  /// Promotes a pending candidate in place, preserving its id and hit history.
  MemoryEntry approve(
    String id, {
    String? trigger,
    String? content,
    MemoryKind? kind,
    MemoryResolution? resolution,
    int? expectedRevision,
    DateTime? now,
  }) {
    _checkRevision(expectedRevision);
    final index = _indexOfId(id);
    if (index < 0) throw StateError('候选记忆 "$id" 不存在');
    final pending = _entries[index];
    if (pending.source != MemorySource.pendingLlmCandidate) {
      throw StateError('记忆 "$id" 已不在待确认列表中');
    }

    final normalizedTrigger = _normalizeTrigger(trigger ?? pending.trigger);
    final normalizedContent = _normalizeContent(content ?? pending.content);
    _validateText(normalizedTrigger, normalizedContent);
    final conflicts = _conflictsFor(normalizedTrigger, excludeId: id);
    _requireResolution(normalizedTrigger, conflicts, resolution);

    var finalContent = normalizedContent;
    if (conflicts.isNotEmpty && resolution == MemoryResolution.merge) {
      finalContent = _mergeContent(normalizedContent, conflicts);
      _validateText(normalizedTrigger, finalContent);
    }

    final timestamp = now ?? DateTime.now();
    final approved = MemoryEntry(
      id: pending.id,
      trigger: normalizedTrigger,
      content: finalContent,
      kind: kind ?? pending.kind,
      source: MemorySource.llmCandidate,
      hitCount: pending.hitCount,
      lastHitAt: pending.lastHitAt,
      createdAt: pending.createdAt,
      updatedAt: timestamp,
      supersededBy: pending.supersededBy,
    );

    final next = List<MemoryEntry>.of(_entries)..[index] = approved;
    if (resolution == MemoryResolution.replace ||
        resolution == MemoryResolution.merge) {
      _markSuperseded(next, conflicts, approved.id, timestamp);
    }
    _commit(next);
    return approved;
  }

  /// Deletes requested entries and their superseded ancestors.
  ///
  /// If a replacement target is deleted, older records that point to it are
  /// deleted transitively too. This keeps history from being reactivated and
  /// avoids dangling supersededBy references. Deleting an old record alone
  /// leaves its newer replacement intact.
  void delete(Set<String> ids, {int? expectedRevision}) {
    _checkRevision(expectedRevision);
    final removeIds = deletionClosure(ids);
    if (removeIds.isEmpty) return;

    final next = _entries
        .where((entry) => !removeIds.contains(entry.id))
        .toList(growable: false);
    if (next.length != _entries.length) _commit(next);
  }

  /// Returns every existing entry that [delete] will remove, including
  /// superseded ancestors of requested replacement targets. Unknown ids are
  /// ignored. The immutable result lets callers show the full deletion set
  /// before asking the user to confirm.
  Set<String> deletionClosure(Set<String> ids) {
    if (ids.isEmpty) return const {};

    final knownIds = _entries.map((entry) => entry.id).toSet();
    final removeIds = ids.where(knownIds.contains).toSet();
    var changed = true;
    while (changed) {
      changed = false;
      for (final entry in _entries) {
        final target = entry.supersededBy;
        if (target != null &&
            removeIds.contains(target) &&
            removeIds.add(entry.id)) {
          changed = true;
        }
      }
    }
    return Set<String>.unmodifiable(removeIds);
  }

  /// Lists unused active memories old enough for the user's cleanup review.
  ///
  /// New entries use createdAt when lastHitAt is absent, so a new, never-hit
  /// memory does not become stale immediately.
  List<MemoryEntry> stale({
    DateTime? now,
    Duration olderThan = const Duration(days: 90),
  }) {
    if (olderThan.isNegative) {
      throw ArgumentError.value(olderThan, 'olderThan', '不能为负数');
    }
    final timestamp = now ?? DateTime.now();
    final cutoff = timestamp.subtract(olderThan);
    final matches =
        _entries.where((entry) {
          if (!entry.isRetrievable || entry.hitCount != 0) return false;
          final activity = entry.lastHitAt ?? entry.createdAt;
          return activity.isBefore(cutoff);
        }).toList()..sort((left, right) {
          final leftActivity = left.lastHitAt ?? left.createdAt;
          final rightActivity = right.lastHitAt ?? right.createdAt;
          final byActivity = leftActivity.compareTo(rightActivity);
          return byActivity != 0 ? byActivity : left.id.compareTo(right.id);
        });
    return List<MemoryEntry>.unmodifiable(matches);
  }

  /// Management search includes pending and superseded history and never
  /// changes hit counters.
  List<MemoryEntry> search(
    String query, {
    MemoryKind? kind,
    MemorySource? source,
  }) {
    final filtered = _entries.where((entry) {
      return (kind == null || entry.kind == kind) &&
          (source == null || entry.source == source);
    }).toList();

    final tokens = _searchTokens(query);
    final queryText = _searchText(query);
    if (tokens.isEmpty) {
      filtered.sort(_compareUpdatedDescending);
      return query.trim().isEmpty
          ? List<MemoryEntry>.unmodifiable(filtered)
          : const [];
    }

    final matches = <_ScoredMemory>[];
    for (final entry in filtered) {
      final triggerText = _searchText(entry.trigger);
      final contentText = _searchText(entry.content);
      final triggerMatches = tokens
          .where((token) => triggerText.contains(token))
          .length;
      final phraseMatch = _matchesEmbeddedCjkTrigger(queryText, triggerText);
      final contentMatches = tokens
          .where((token) => contentText.contains(token))
          .length;
      if (triggerMatches + contentMatches == 0 && !phraseMatch) continue;
      matches.add(
        _ScoredMemory(
          entry,
          triggerMatches + (phraseMatch ? 1 : 0),
          contentMatches,
        ),
      );
    }
    matches.sort(_compareScored);
    return List<MemoryEntry>.unmodifiable(matches.map((match) => match.entry));
  }

  /// Retrieves whole active entries that fit the query and character budget.
  ///
  /// Matching is OR-based across distinct query tokens. The budget counts
  /// trigger and content characters together; oversized entries are skipped
  /// intact, and only returned entries receive a hit.
  List<MemoryEntry> retrieve(
    String query, {
    int limit = 8,
    int maxCharacters = 12000,
    DateTime? now,
  }) {
    if (limit < 0) throw ArgumentError.value(limit, 'limit', '不能为负数');
    if (maxCharacters < 0) {
      throw ArgumentError.value(maxCharacters, 'maxCharacters', '不能为负数');
    }
    final tokens = _searchTokens(query);
    if (tokens.isEmpty || limit == 0 || maxCharacters == 0) return const [];
    final queryText = _searchText(query);

    final scored = <_ScoredMemory>[];
    for (final entry in _entries) {
      if (!entry.isRetrievable) continue;
      final triggerText = _searchText(entry.trigger);
      final contentText = _searchText(entry.content);
      final triggerMatches = tokens
          .where((token) => triggerText.contains(token))
          .length;
      final phraseMatch = _matchesEmbeddedCjkTrigger(queryText, triggerText);
      final contentMatches = tokens
          .where((token) => contentText.contains(token))
          .length;
      if (triggerMatches + contentMatches == 0 && !phraseMatch) continue;
      scored.add(
        _ScoredMemory(
          entry,
          triggerMatches + (phraseMatch ? 1 : 0),
          contentMatches,
        ),
      );
    }
    scored.sort(_compareScored);

    final selected = <MemoryEntry>[];
    var remainingCharacters = maxCharacters;
    for (final match in scored) {
      if (selected.length >= limit) break;
      final entry = match.entry;
      final characterCost = entry.trigger.length + entry.content.length;
      if (characterCost > remainingCharacters) continue;
      selected.add(entry);
      remainingCharacters -= characterCost;
    }
    if (selected.isEmpty) return const [];

    final timestamp = now ?? DateTime.now();
    final selectedIds = selected.map((entry) => entry.id).toSet();
    final updatedById = <String, MemoryEntry>{};
    final next = <MemoryEntry>[];
    for (final entry in _entries) {
      if (!selectedIds.contains(entry.id)) {
        next.add(entry);
        continue;
      }
      final updated = entry._copyWith(
        hitCount: entry.hitCount + 1,
        lastHitAt: timestamp,
        updatedAt: timestamp,
      );
      updatedById[entry.id] = updated;
      next.add(updated);
    }
    _commit(next);
    return List<MemoryEntry>.unmodifiable(
      selected.map((entry) => updatedById[entry.id]!),
    );
  }

  Map<String, Object?> toJson() => {
    'schema': schemaVersion,
    'revision': _revision,
    'entries': _entries.map(_entryToJson).toList(growable: false),
  };

  factory PromptMemoryLibrary.fromJson(Map<String, Object?> json) {
    _requireKeys(json, const {'schema', 'revision', 'entries'}, 'library');
    final schema = json['schema'];
    if (schema is! int || schema != schemaVersion) {
      throw FormatException('不支持的记忆库 schema: $schema');
    }
    final revision = json['revision'];
    if (revision is! int || revision < 0) {
      throw const FormatException('记忆库 revision 必须是非负整数');
    }
    final rawEntries = json['entries'];
    if (rawEntries is! List) {
      throw const FormatException('记忆库 entries 必须是数组');
    }
    if (rawEntries.length > maxEntries) {
      throw FormatException('记忆数量不能超过 $maxEntries');
    }

    final entries = <MemoryEntry>[];
    final ids = <String>{};
    for (var index = 0; index < rawEntries.length; index++) {
      final map = _objectMap(rawEntries[index], 'entries[$index]');
      final entry = _entryFromJson(map, index);
      if (!ids.add(entry.id)) {
        throw FormatException('entries[$index].id 重复: ${entry.id}');
      }
      entries.add(entry);
    }
    _validateSupersessionGraph(entries);
    return PromptMemoryLibrary._loaded(entries, revision);
  }

  void _checkRevision(int? expectedRevision) {
    if (expectedRevision != null && expectedRevision != _revision) {
      throw MemoryRevisionConflictException(
        expectedRevision: expectedRevision,
        actualRevision: _revision,
      );
    }
  }

  void _commit(List<MemoryEntry> next) {
    final immutableEntries = List<MemoryEntry>.unmodifiable(next);
    final nextRevision = _revision + 1;
    _entries = immutableEntries;
    _revision = nextRevision;
  }

  int _indexOfId(String id) => _entries.indexWhere((entry) => entry.id == id);

  List<MemoryEntry> _conflictsFor(
    String normalizedTrigger, {
    String? excludeId,
  }) {
    final key = _normalizeTrigger(normalizedTrigger);
    final result =
        _entries
            .where(
              (entry) =>
                  entry.id != excludeId &&
                  entry.isRetrievable &&
                  _normalizeTrigger(entry.trigger) == key,
            )
            .toList()
          ..sort(_compareUpdatedDescending);
    return result;
  }

  MemoryEntry? _pendingDuplicate(
    String normalizedTrigger,
    String normalizedContent,
    MemoryKind kind,
  ) {
    final duplicates =
        _entries
            .where(
              (entry) =>
                  entry.source == MemorySource.pendingLlmCandidate &&
                  entry.kind == kind &&
                  _normalizeTrigger(entry.trigger) == normalizedTrigger &&
                  entry.content == normalizedContent,
            )
            .toList()
          ..sort(_compareUpdatedDescending);
    return duplicates.isEmpty ? null : duplicates.first;
  }

  void _requireResolution(
    String trigger,
    List<MemoryEntry> conflicts,
    MemoryResolution? resolution,
  ) {
    if (conflicts.isNotEmpty && resolution == null) {
      throw MemoryConflictException(trigger: trigger, entries: conflicts);
    }
  }

  String _mergeContent(String newContent, List<MemoryEntry> conflicts) {
    final buffer = StringBuffer(newContent);
    for (final conflict in conflicts) {
      buffer.write('\n---\n');
      buffer.write(conflict.content.trim());
    }
    return buffer.toString();
  }

  void _markSuperseded(
    List<MemoryEntry> next,
    List<MemoryEntry> conflicts,
    String newId,
    DateTime timestamp,
  ) {
    final conflictIds = conflicts.map((entry) => entry.id).toSet();
    for (var index = 0; index < next.length; index++) {
      final entry = next[index];
      if (conflictIds.contains(entry.id)) {
        next[index] = entry._copyWith(
          supersededBy: newId,
          updatedAt: timestamp,
        );
      }
    }
  }

  String _newId() {
    final existingIds = _entries.map((entry) => entry.id).toSet();
    while (true) {
      final suffix = List<String>.generate(
        4,
        (_) => _idRandom.nextInt(0x100000000).toRadixString(16).padLeft(8, '0'),
      ).join();
      final id = 'memory_$suffix';
      if (!existingIds.contains(id)) return id;
    }
  }

  static String _normalizeTrigger(String value) =>
      value.replaceAll(RegExp(r'\s+'), ' ').trim();

  static String _normalizeContent(String value) => value.trim();

  static void _validateText(String trigger, String content) {
    if (trigger.isEmpty) throw ArgumentError('触发词不能为空');
    if (trigger.length > maxTriggerLength) {
      throw ArgumentError('触发词不能超过 $maxTriggerLength 个字符');
    }
    if (content.isEmpty) throw ArgumentError('记忆内容不能为空');
    if (content.length > maxContentLength) {
      throw ArgumentError('记忆内容不能超过 $maxContentLength 个字符');
    }
  }

  static List<String> _searchTokens(String query) {
    final normalized = _searchText(query);
    return normalized
        .split(RegExp(r'\s+'))
        .map((token) => token.trim())
        .where((token) => token.isNotEmpty)
        .toSet()
        .toList(growable: false);
  }

  static String _searchText(String value) => value
      .toLowerCase()
      .replaceAll('_', ' ')
      .replaceAll(RegExp(r'[,，;；|/\\]+'), ' ')
      .replaceAll(
        RegExp(r'[^a-z0-9\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af\s]+'),
        ' ',
      )
      .replaceAll(RegExp(r'\s+'), ' ')
      .trim();

  /// Chinese, Japanese, and Korean triggers are often embedded in a natural
  /// language query without whitespace boundaries (for example 星璃 in
  /// 请画星璃). Preserve token matching while accepting that phrase form.
  static bool _matchesEmbeddedCjkTrigger(String query, String trigger) =>
      trigger.isNotEmpty &&
      RegExp(r'[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]').hasMatch(trigger) &&
      query.contains(trigger);

  static int _compareUpdatedDescending(MemoryEntry left, MemoryEntry right) {
    final byUpdated = right.updatedAt.compareTo(left.updatedAt);
    return byUpdated != 0 ? byUpdated : left.id.compareTo(right.id);
  }

  static int _compareScored(_ScoredMemory left, _ScoredMemory right) {
    final byMatches = right.matchCount.compareTo(left.matchCount);
    if (byMatches != 0) return byMatches;
    final byTriggerMatches = right.triggerMatches.compareTo(
      left.triggerMatches,
    );
    if (byTriggerMatches != 0) return byTriggerMatches;
    return _compareUpdatedDescending(left.entry, right.entry);
  }

  static Map<String, Object?> _entryToJson(MemoryEntry entry) => {
    'id': entry.id,
    'trigger': entry.trigger,
    'content': entry.content,
    'kind': entry.kind.name,
    'source': entry.source.name,
    'hitCount': entry.hitCount,
    'lastHitAt': entry.lastHitAt?.toUtc().toIso8601String(),
    'createdAt': entry.createdAt.toUtc().toIso8601String(),
    'updatedAt': entry.updatedAt.toUtc().toIso8601String(),
    'supersededBy': entry.supersededBy,
  };

  static MemoryEntry _entryFromJson(Map<String, Object?> json, int index) {
    final location = 'entries[$index]';
    _requireKeys(json, const {
      'id',
      'trigger',
      'content',
      'kind',
      'source',
      'hitCount',
      'lastHitAt',
      'createdAt',
      'updatedAt',
      'supersededBy',
    }, location);

    final id = json['id'];
    if (id is! String || id.isEmpty || id != id.trim()) {
      throw FormatException('$location.id 必须是非空且无首尾空格的字符串');
    }
    final trigger = json['trigger'];
    final content = json['content'];
    if (trigger is! String || content is! String) {
      throw FormatException('$location.trigger/content 必须是字符串');
    }
    if (_normalizeTrigger(trigger) != trigger ||
        _normalizeContent(content) != content) {
      throw FormatException('$location.trigger/content 必须已标准化');
    }
    try {
      _validateText(trigger, content);
    } on ArgumentError catch (error) {
      throw FormatException('$location 无效: ${error.message}');
    }

    final kindValue = json['kind'];
    final kind = kindValue is String
        ? MemoryKind.values.where((value) => value.name == kindValue)
        : const <MemoryKind>[];
    if (kind.length != 1) {
      throw FormatException('$location.kind 未知: $kindValue');
    }

    final sourceValue = json['source'];
    final source = sourceValue is String
        ? MemorySource.values.where((value) => value.name == sourceValue)
        : const <MemorySource>[];
    if (source.length != 1) {
      throw FormatException('$location.source 未知: $sourceValue');
    }

    final hitCount = json['hitCount'];
    if (hitCount is! int || hitCount < 0) {
      throw FormatException('$location.hitCount 必须是非负整数');
    }
    final lastHitAt = _parseNullableUtcDate(
      json['lastHitAt'],
      '$location.lastHitAt',
    );
    final createdAt = _parseUtcDate(json['createdAt'], '$location.createdAt');
    final updatedAt = _parseUtcDate(json['updatedAt'], '$location.updatedAt');
    final supersededBy = json['supersededBy'];
    if (supersededBy != null &&
        (supersededBy is! String || supersededBy.isEmpty)) {
      throw FormatException('$location.supersededBy 必须是非空字符串或 null');
    }

    return MemoryEntry(
      id: id,
      trigger: trigger,
      content: content,
      kind: kind.single,
      source: source.single,
      hitCount: hitCount,
      lastHitAt: lastHitAt,
      createdAt: createdAt,
      updatedAt: updatedAt,
      supersededBy: supersededBy as String?,
    );
  }

  static void _validateSupersessionGraph(List<MemoryEntry> entries) {
    final byId = {for (final entry in entries) entry.id: entry};
    for (final entry in entries) {
      final targetId = entry.supersededBy;
      if (targetId == null) continue;
      if (entry.source == MemorySource.pendingLlmCandidate) {
        throw FormatException('pending 记忆不能被标记为已覆盖: ${entry.id}');
      }
      final target = byId[targetId];
      if (target == null) {
        throw FormatException('${entry.id}.supersededBy 指向不存在的记忆 $targetId');
      }
      // Supersession links record edit lineage. An active entry may have its
      // trigger changed after older entries were superseded, so the lineage
      // edge does not require the two trigger strings to remain equal.
      if (target.id == entry.id) {
        throw FormatException('${entry.id}.supersededBy 目标无效: $targetId');
      }
      if (target.source == MemorySource.pendingLlmCandidate) {
        throw FormatException('已覆盖目标不能是 pending 记忆: $targetId');
      }

      final visited = <String>{entry.id};
      MemoryEntry? current = target;
      while (current != null) {
        if (!visited.add(current.id)) {
          throw FormatException('记忆 supersededBy 存在循环: ${entry.id}');
        }
        final nextId = current.supersededBy;
        current = nextId == null ? null : byId[nextId];
      }
    }
  }

  static Map<String, Object?> _objectMap(Object? value, String location) {
    if (value is! Map) throw FormatException('$location 必须是对象');
    final result = <String, Object?>{};
    for (final entry in value.entries) {
      if (entry.key is! String) throw FormatException('$location 含非字符串键');
      result[entry.key as String] = entry.value;
    }
    return result;
  }

  static void _requireKeys(
    Map<String, Object?> json,
    Set<String> expected,
    String location,
  ) {
    final actual = json.keys.toSet();
    if (actual.length != expected.length || !actual.containsAll(expected)) {
      final missing = expected.difference(actual);
      final extra = actual.difference(expected);
      throw FormatException(
        '$location 字段不匹配 (missing: $missing, extra: $extra)',
      );
    }
  }

  static DateTime _parseUtcDate(Object? value, String location) {
    if (value is! String) throw FormatException('$location 必须是 UTC ISO 日期');
    try {
      final parsed = DateTime.parse(value);
      if (!parsed.isUtc || parsed.toIso8601String() != value) {
        throw FormatException('$location 必须是规范 UTC ISO 日期');
      }
      return parsed;
    } on FormatException {
      rethrow;
    } on Object catch (error) {
      throw FormatException('$location 日期无效: $error');
    }
  }

  static DateTime? _parseNullableUtcDate(Object? value, String location) {
    if (value == null) return null;
    return _parseUtcDate(value, location);
  }
}

class _ScoredMemory {
  const _ScoredMemory(this.entry, this.triggerMatches, this.contentMatches);

  final MemoryEntry entry;
  final int triggerMatches;
  final int contentMatches;

  int get matchCount => triggerMatches + contentMatches;
}

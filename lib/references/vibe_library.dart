import 'dart:collection';
import 'dart:convert';
import 'dart:typed_data';

import '../generation/generation_parameters.dart';
import '../generation/service_connection.dart';
import 'vibe_encoding_scope.dart';

/// A durable, user-named Vibe encoding.
///
/// [encodedBytes] stores the UTF-8 bytes of the exact string sent in the
/// provider's Vibe request field. The source image itself remains in the
/// content-addressed image store.
class VibeLibraryEntry {
  VibeLibraryEntry({
    required this.id,
    required this.title,
    required this.scope,
    required Uint8List encodedBytes,
    required this.strength,
    required this.createdAt,
  }) : encodedBytes = Uint8List.fromList(encodedBytes) {
    _validate();
  }

  final String id;
  final String title;
  final VibeEncodingScope scope;
  final Uint8List encodedBytes;
  final double strength;
  final DateTime createdAt;

  String get sourceAssetRef => scope.sourceAssetRef;
  String? get sourceSha256 => scope.sourceSha256;
  String get model => scope.model;
  String get providerProtocol => scope.providerProtocol;
  String get endpoint => scope.endpoint;
  double get informationExtracted => scope.informationExtracted;
  String get encodedValue => utf8.decode(encodedBytes);

  /// Checks the request's provider/model/information settings. Source identity
  /// is checked too when the caller supplies [sourceAssetRef].
  bool isCompatible(
    String model,
    ServiceConnection connection, {
    double? informationExtracted,
    String? sourceAssetRef,
    String? sourceSha256,
  }) {
    try {
      if (!scope.matchesProvider(
        model: model,
        providerProtocol: connection.protocol,
        endpoint: connection.uri,
        informationExtracted: informationExtracted ?? this.informationExtracted,
      )) {
        return false;
      }
      if (sourceAssetRef == null && sourceSha256 == null) return true;
      return scope.sourceAssetRef == (sourceAssetRef ?? '') &&
          scope.sourceSha256 == sourceSha256;
    } on FormatException {
      return false;
    }
  }

  /// Converts the durable entry to a generation reference carrying its scope.
  VibeReference toReference() => VibeReference(
    assetId: sourceAssetRef,
    strength: strength,
    informationExtracted: informationExtracted,
    encodedVibe: encodedValue,
    encodedVibeScope: scope,
  );

  Map<String, Object?> toJson() => <String, Object?>{
    'id': id,
    'title': title,
    'scope': scope.toJson(),
    'encoded_bytes': base64Encode(encodedBytes),
    'strength': strength,
    'created_at': createdAt.toIso8601String(),
  };

  factory VibeLibraryEntry.fromJson(Map<String, dynamic> json) {
    final id = json['id'];
    final title = json['title'];
    final scopeValue = json['scope'];
    final encoded = json['encoded_bytes'];
    final strength = json['strength'];
    final created = json['created_at'];
    if (id is! String ||
        title is! String ||
        scopeValue is! Map ||
        encoded is! String ||
        strength is! num ||
        created is! String) {
      throw const FormatException('Vibe 编码库条目字段不完整。');
    }
    final parsedDate = DateTime.tryParse(created);
    if (parsedDate == null) {
      throw const FormatException('Vibe 编码库条目日期无效。');
    }
    try {
      return VibeLibraryEntry(
        id: id,
        title: title,
        scope: VibeEncodingScope.fromJson(
          Map<String, dynamic>.from(scopeValue),
        ),
        encodedBytes: base64Decode(encoded),
        strength: strength.toDouble(),
        createdAt: parsedDate,
      );
    } on FormatException {
      rethrow;
    } on Object {
      throw const FormatException('Vibe 编码库条目数据无效。');
    }
  }

  VibeLibraryEntry copyWith({String? title}) => VibeLibraryEntry(
    id: id,
    title: title ?? this.title,
    scope: scope,
    encodedBytes: encodedBytes,
    strength: strength,
    createdAt: createdAt,
  );

  void _validate() {
    if (id.isEmpty ||
        title.trim().isEmpty ||
        encodedBytes.isEmpty ||
        !strength.isFinite ||
        strength < 0 ||
        strength > 1) {
      throw const FormatException('Vibe 编码库条目无效。');
    }
    try {
      utf8.decode(encodedBytes);
    } on FormatException {
      throw const FormatException('Vibe 编码库条目不是有效文本。');
    }
  }
}

/// One bounded cache value. Cache keys exclude Vibe strength.
class VibeEncodingCacheEntry {
  VibeEncodingCacheEntry({
    required this.scope,
    required Uint8List encodedBytes,
    required this.createdAt,
  }) : encodedBytes = Uint8List.fromList(encodedBytes) {
    if (encodedBytes.isEmpty) {
      throw const FormatException('Vibe 编码结果不能为空。');
    }
    try {
      utf8.decode(encodedBytes);
    } on FormatException {
      throw const FormatException('Vibe 缓存编码不是有效文本。');
    }
  }

  final VibeEncodingScope scope;
  final Uint8List encodedBytes;
  final DateTime createdAt;

  String get encodedValue => utf8.decode(encodedBytes);

  Map<String, Object?> toJson() => <String, Object?>{
    'scope': scope.toJson(),
    'encoded_bytes': base64Encode(encodedBytes),
    'created_at': createdAt.toIso8601String(),
  };

  factory VibeEncodingCacheEntry.fromJson(Map<String, dynamic> json) {
    final scopeValue = json['scope'];
    final encoded = json['encoded_bytes'];
    final created = json['created_at'];
    if (scopeValue is! Map || encoded is! String || created is! String) {
      throw const FormatException('Vibe 缓存条目字段不完整。');
    }
    final parsedDate = DateTime.tryParse(created);
    if (parsedDate == null) {
      throw const FormatException('Vibe 缓存日期无效。');
    }
    try {
      return VibeEncodingCacheEntry(
        scope: VibeEncodingScope.fromJson(
          Map<String, dynamic>.from(scopeValue),
        ),
        encodedBytes: base64Decode(encoded),
        createdAt: parsedDate,
      );
    } on FormatException {
      rethrow;
    } on Object {
      throw const FormatException('Vibe 缓存条目数据无效。');
    }
  }
}

/// Persistent named Vibes plus a bounded, persistent encoding cache.
///
/// The cache is separate from named entries: ordinary generation can reuse an
/// encoding without adding a new user-visible library card. In-flight requests
/// are shared per exact scope and failed requests are never cached.
class VibeLibrary {
  VibeLibrary({
    Iterable<VibeLibraryEntry> entries = const [],
    Iterable<VibeEncodingCacheEntry> cacheEntries = const [],
    int cacheCapacity = 16,
    int cacheByteCapacity = VibeLibrary.defaultCacheByteCapacity,
    this.onChanged,
  }) : cacheCapacity = cacheCapacity.clamp(0, 256).toInt(),
       cacheByteCapacity = cacheByteCapacity
           .clamp(0, 256 * 1024 * 1024)
           .toInt() {
    for (final entry in entries) {
      _entries[entry.id] = entry;
    }
    for (final entry in cacheEntries) {
      _cache[entry.scope.cacheKey] = entry;
    }
    _trimCache();
  }

  static const int currentVersion = 1;
  static const int defaultCacheCapacity = 16;
  static const int defaultCacheByteCapacity = 64 * 1024 * 1024;
  static int _nextId = 0;

  final int cacheCapacity;
  final int cacheByteCapacity;
  final LinkedHashMap<String, VibeLibraryEntry> _entries =
      LinkedHashMap<String, VibeLibraryEntry>();
  final LinkedHashMap<String, VibeEncodingCacheEntry> _cache =
      LinkedHashMap<String, VibeEncodingCacheEntry>();
  final Map<String, Future<VibeEncodingCacheEntry>> _inFlight = {};

  /// The owner can persist [toJson] whenever a library or cache item changes.
  void Function(VibeLibrary library)? onChanged;

  List<VibeLibraryEntry> get entries => List.unmodifiable(_entries.values);
  List<VibeEncodingCacheEntry> get cacheEntries =>
      List.unmodifiable(_cache.values);

  List<VibeLibraryEntry> search(String query) {
    final normalized = query.trim().toLowerCase();
    if (normalized.isEmpty) return entries;
    return entries
        .where((entry) {
          final searchable = <String>[
            entry.title,
            entry.sourceAssetRef,
            entry.model,
            entry.providerProtocol,
            entry.endpoint,
          ].join('\n').toLowerCase();
          return searchable.contains(normalized);
        })
        .toList(growable: false);
  }

  VibeLibraryEntry addEntry({
    required String title,
    required String sourceAssetRef,
    required String? sourceSha256,
    required Uint8List encodedBytes,
    required String model,
    required String providerProtocol,
    required Uri endpoint,
    required double informationExtracted,
    required double strength,
    DateTime? createdAt,
    String? id,
  }) {
    final trimmedTitle = title.trim();
    final normalizedProtocol = providerProtocol.trim();
    final scope = VibeEncodingScope(
      sourceAssetRef: sourceAssetRef,
      sourceSha256: sourceSha256,
      model: model,
      providerProtocol: normalizedProtocol,
      endpoint: endpoint,
      informationExtracted: informationExtracted,
    );
    final entry = VibeLibraryEntry(
      id: id ?? _newId(),
      title: trimmedTitle.isEmpty ? '未命名氛围' : trimmedTitle,
      scope: scope,
      encodedBytes: encodedBytes,
      strength: strength,
      createdAt: createdAt ?? DateTime.now().toUtc(),
    );
    addEntryRecord(entry);
    return entry;
  }

  /// Adds an imported opaque encoding after the UI has shown and confirmed its
  /// model/provider assignment. Empty [sourceAssetRef] marks it as non-reusable
  /// for image-based cache lookups, while the named entry remains usable in a
  /// matching request.
  VibeLibraryEntry addPreEncodedEntry({
    required String title,
    required Uint8List encodedBytes,
    required String model,
    required String providerProtocol,
    required Uri endpoint,
    required double informationExtracted,
    double strength = 0.3,
    String sourceAssetRef = '',
    String? sourceSha256,
    DateTime? createdAt,
    String? id,
  }) => addEntry(
    title: title,
    sourceAssetRef: sourceAssetRef,
    sourceSha256: sourceSha256,
    encodedBytes: encodedBytes,
    model: model,
    providerProtocol: providerProtocol,
    endpoint: endpoint,
    informationExtracted: informationExtracted,
    strength: strength,
    createdAt: createdAt,
    id: id,
  );

  VibeLibraryEntry addPreEncodedValue({
    required String title,
    required String encodedValue,
    required String model,
    required String providerProtocol,
    required Uri endpoint,
    required double informationExtracted,
    double strength = 0.3,
    String sourceAssetRef = '',
    String? sourceSha256,
    DateTime? createdAt,
    String? id,
  }) => addPreEncodedEntry(
    title: title,
    encodedBytes: Uint8List.fromList(utf8.encode(encodedValue)),
    model: model,
    providerProtocol: providerProtocol,
    endpoint: endpoint,
    informationExtracted: informationExtracted,
    strength: strength,
    sourceAssetRef: sourceAssetRef,
    sourceSha256: sourceSha256,
    createdAt: createdAt,
    id: id,
  );

  void addEntryRecord(VibeLibraryEntry entry) {
    _entries[entry.id] = entry;
    if (entry.scope.hasSource) {
      _writeCache(
        VibeEncodingCacheEntry(
          scope: entry.scope,
          encodedBytes: entry.encodedBytes,
          createdAt: entry.createdAt,
        ),
        notify: false,
      );
    }
    _changed();
  }

  VibeLibraryEntry? findEntry(String id) => _entries[id];

  VibeLibraryEntry? findCompatibleEntry(VibeEncodingScope scope) {
    for (final entry in _entries.values.toList().reversed) {
      if (entry.scope.cacheKey == scope.cacheKey) return entry;
    }
    return null;
  }

  VibeLibraryEntry? rename(String id, String title) {
    final current = _entries[id];
    final trimmed = title.trim();
    if (current == null || trimmed.isEmpty || trimmed == current.title) {
      return current;
    }
    final updated = current.copyWith(title: trimmed);
    _entries[id] = updated;
    _changed();
    return updated;
  }

  bool delete(String id) {
    final removed = _entries.remove(id);
    if (removed == null) return false;
    final key = removed.scope.cacheKey;
    if (!_entries.values.any((entry) => entry.scope.cacheKey == key)) {
      _cache.remove(key);
    }
    _changed();
    return true;
  }

  void clearCache() {
    if (_cache.isEmpty) return;
    _cache.clear();
    _changed();
  }

  VibeEncodingCacheEntry? findCached(VibeEncodingScope scope) {
    final key = scope.cacheKey;
    final cached = _cache.remove(key);
    if (cached == null) return null;
    _cache[key] = cached;
    return cached;
  }

  Future<VibeEncodingCacheEntry> getOrEncode({
    required VibeEncodingScope scope,
    required Future<Uint8List> Function() encode,
  }) async {
    final named = findCompatibleEntry(scope);
    if (named != null) {
      final cached = VibeEncodingCacheEntry(
        scope: named.scope,
        encodedBytes: named.encodedBytes,
        createdAt: named.createdAt,
      );
      _writeCache(cached);
      return cached;
    }
    final existing = findCached(scope);
    if (existing != null) return existing;

    final key = scope.cacheKey;
    final ongoing = _inFlight[key];
    if (ongoing != null) return ongoing;

    final future = Future<Uint8List>.sync(encode).then((bytes) {
      if (bytes.isEmpty) {
        throw const FormatException('Vibe 编码结果为空，未写入缓存。');
      }
      final value = VibeEncodingCacheEntry(
        scope: scope,
        encodedBytes: bytes,
        createdAt: DateTime.now().toUtc(),
      );
      _writeCache(value);
      return value;
    });
    _inFlight[key] = future;
    try {
      return await future;
    } finally {
      if (identical(_inFlight[key], future)) _inFlight.remove(key);
    }
  }

  Map<String, Object?> toJson() => <String, Object?>{
    'version': currentVersion,
    'cache_capacity': cacheCapacity,
    'cache_byte_capacity': cacheByteCapacity,
    'entries': _entries.values.map((entry) => entry.toJson()).toList(),
    'cache': _cache.values.map((entry) => entry.toJson()).toList(),
  };

  factory VibeLibrary.fromJson(
    Map<String, dynamic> json, {
    void Function(VibeLibrary library)? onChanged,
  }) {
    final version = json['version'];
    if (version != currentVersion) {
      throw const FormatException('不支持的 Vibe 编码库版本。');
    }
    final rawEntries = json['entries'];
    final rawCache = json['cache'];
    final capacity = json['cache_capacity'];
    final byteCapacity = json['cache_byte_capacity'];
    if ((rawEntries != null && rawEntries is! List) ||
        (rawCache != null && rawCache is! List) ||
        (capacity != null && capacity is! num) ||
        (byteCapacity != null && byteCapacity is! num)) {
      throw const FormatException('Vibe 编码库格式无效。');
    }
    return VibeLibrary(
      entries: _objectList(rawEntries).map(VibeLibraryEntry.fromJson),
      cacheEntries: _objectList(rawCache).map(VibeEncodingCacheEntry.fromJson),
      cacheCapacity: (capacity as num?)?.toInt() ?? defaultCacheCapacity,
      cacheByteCapacity:
          (byteCapacity as num?)?.toInt() ?? defaultCacheByteCapacity,
      onChanged: onChanged,
    );
  }

  void _writeCache(VibeEncodingCacheEntry entry, {bool notify = true}) {
    if (cacheCapacity == 0 ||
        cacheByteCapacity == 0 ||
        entry.encodedBytes.length > cacheByteCapacity ||
        !entry.scope.hasSource) {
      return;
    }
    final key = entry.scope.cacheKey;
    _cache.remove(key);
    _cache[key] = entry;
    _trimCache();
    if (notify) _changed();
  }

  void _trimCache() {
    while (_cache.length > cacheCapacity ||
        _cache.values.fold<int>(
              0,
              (total, entry) => total + entry.encodedBytes.length,
            ) >
            cacheByteCapacity) {
      _cache.remove(_cache.keys.first);
    }
  }

  void _changed() => onChanged?.call(this);

  static String _newId() {
    _nextId++;
    return 'vibe-${DateTime.now().microsecondsSinceEpoch}-$_nextId';
  }

  static List<Map<String, dynamic>> _objectList(Object? value) {
    if (value == null) return const [];
    if (value is! List) {
      throw const FormatException('Vibe 编码库列表格式无效。');
    }
    return value
        .map((item) {
          if (item is! Map) {
            throw const FormatException('Vibe 编码库条目格式无效。');
          }
          return Map<String, dynamic>.from(item);
        })
        .toList(growable: false);
  }
}

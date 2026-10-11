import 'dart:async';
import 'dart:collection';
import 'dart:convert';

import 'package:path/path.dart' as p;
import 'package:sqflite_common/sqlite_api.dart';

import 'workspace_store.dart';

export 'workspace_store.dart';

/// SQLite-backed, revisioned workspace snapshots.
///
/// The database factory is injected so this store stays independent of FFI,
/// Flutter plugins, and the platform used to open the SQLite connection.
class SQLiteWorkspaceStore implements WorkspaceStore {
  SQLiteWorkspaceStore._({required this._database, required this.label});

  static const int _schemaVersion = 1;
  static const int _workspaceId = 1;
  static const int _busyTimeoutMilliseconds = 5000;
  static final Map<String, Future<void>> _operationTails = {};
  static const List<String> _requiredTables = [
    'meta',
    'draft',
    'gallery',
    'workspace',
  ];
  // Keep revisions exactly representable in both native Dart and JS previews.
  static const int _maximumSqliteInteger = 0x1fffffffffffff;

  final Database _database;
  @override
  final String label;

  /// Opens or initializes the schema-1 workspace database.
  ///
  /// By default each store owns its connection, which permits independent
  /// windows to coordinate through SQLite transactions. Set [singleInstance]
  /// to true for factories such as browser-backed SQLite implementations that
  /// support only one persistent connection per path.
  static Future<SQLiteWorkspaceStore> open({
    required DatabaseFactory factory,
    required String path,
    String label = 'SQLite',
    bool singleInstance = false,
  }) async {
    late final Database database;
    try {
      database = await factory.openDatabase(
        path,
        options: OpenDatabaseOptions(singleInstance: singleInstance),
      );
    } on DatabaseException catch (error) {
      throw WorkspaceFormatException(
        'The SQLite workspace database could not be opened.',
        cause: error,
      );
    }

    try {
      await database.execute('PRAGMA busy_timeout = $_busyTimeoutMilliseconds');
      await _initializeSchema(database);
      return SQLiteWorkspaceStore._(database: database, label: label);
    } catch (error, stackTrace) {
      try {
        await database.close();
      } catch (_) {
        // Preserve the initialization error; the database may already be
        // closed by its factory when initialization failed.
      }
      Error.throwWithStackTrace(error, stackTrace);
    }
  }

  @override
  Future<StoredWorkspace?> load() async {
    return _runForPath(() async {
      _checkOpen();
      return _database.transaction((transaction) async {
        final revision = await _readRevision(transaction);
        if (revision == null) {
          await _ensureNoOrphanSnapshot(transaction);
          return null;
        }

        final draftRows = await transaction.query(
          'draft',
          where: 'id = ?',
          whereArgs: const [_workspaceId],
          limit: 1,
        );
        final workspaceRows = await transaction.query(
          'workspace',
          where: 'id = ?',
          whereArgs: const [_workspaceId],
          limit: 1,
        );
        if (draftRows.length != 1 || workspaceRows.length != 1) {
          throw const WorkspaceFormatException(
            'The workspace snapshot is missing its draft or root fields.',
          );
        }

        final draftPayload = draftRows.single['payload'];
        final extraPayload = workspaceRows.single['extra_json'];
        if (draftPayload is! String || extraPayload is! String) {
          throw const WorkspaceFormatException(
            'The workspace snapshot contains a non-text JSON payload.',
          );
        }

        final draft = _decodeJsonObject(draftPayload, 'draft');
        final extra = _decodeJsonObject(extraPayload, 'workspace root');
        if (extra.containsKey('draft') || extra.containsKey('gallery')) {
          throw const WorkspaceFormatException(
            'The workspace root JSON contains fields stored in dedicated tables.',
          );
        }

        final gallery = await _readGallery(transaction);
        final data = <String, Object?>{
          ...extra,
          'draft': draft,
          'gallery': gallery.map((item) => item.data).toList(growable: false),
        };
        _validateWorkspaceRoot(data);
        return StoredWorkspace(data: data, revision: revision);
      });
    });
  }

  @override
  Future<int> save(
    Map<String, Object?> data, {
    required int expectedRevision,
  }) async {
    final snapshot = _prepareSnapshot(data);

    return _runForPath(() async {
      _checkOpen();
      return _database.transaction((transaction) async {
        final currentRevision = await _readRevision(transaction);
        final actualRevision = currentRevision ?? 0;
        if (actualRevision != expectedRevision) {
          throw WorkspaceConflictException(
            expectedRevision: expectedRevision,
            actualRevision: actualRevision,
          );
        }
        if (currentRevision == null) {
          await _ensureNoOrphanSnapshot(transaction);
        }
        if (actualRevision >= _maximumSqliteInteger) {
          throw const WorkspaceFormatException(
            'The workspace revision has reached the SQLite integer limit.',
          );
        }

        final nextRevision = actualRevision + 1;
        if (currentRevision == null) {
          await transaction.insert('meta', {
            'id': _workspaceId,
            'revision': nextRevision,
          });
        } else {
          final changed = await transaction.update(
            'meta',
            {'revision': nextRevision},
            where: 'id = ? AND revision = ?',
            whereArgs: [_workspaceId, actualRevision],
          );
          if (changed != 1) {
            final latestRevision = await _readRevision(transaction) ?? 0;
            throw WorkspaceConflictException(
              expectedRevision: expectedRevision,
              actualRevision: latestRevision,
            );
          }
        }

        await transaction.insert('draft', {
          'id': _workspaceId,
          'payload': snapshot.draftPayload,
        }, conflictAlgorithm: ConflictAlgorithm.replace);
        await transaction.insert('workspace', {
          'id': _workspaceId,
          'extra_json': snapshot.extraJson,
        }, conflictAlgorithm: ConflictAlgorithm.replace);
        await _syncGallery(transaction, snapshot.gallery);
        return nextRevision;
      });
    });
  }

  @override
  Future<void> close() async {
    await _runForPath(() async {
      if (_database.isOpen) await _database.close();
    });
  }

  Future<T> _runForPath<T>(Future<T> Function() action) async {
    final key = p.normalize(p.absolute(_database.path));
    final previous = _operationTails[key] ?? Future<void>.value();
    final released = Completer<void>();
    final tail = released.future;
    _operationTails[key] = tail;
    await previous;
    try {
      return await action();
    } finally {
      released.complete();
      if (identical(_operationTails[key], tail)) {
        _operationTails.remove(key);
      }
    }
  }

  void _checkOpen() {
    if (!_database.isOpen) {
      throw StateError('The $label workspace store is closed.');
    }
  }

  static Future<void> _initializeSchema(Database database) async {
    final version = await _readUserVersion(database);
    if (version > _schemaVersion) {
      throw WorkspaceFormatException(
        'Database schema $version is newer than supported schema $_schemaVersion.',
      );
    }
    if (version == _schemaVersion) {
      await _verifySchema(database);
      return;
    }

    await database.transaction((transaction) async {
      final transactionalVersion = await _readUserVersion(transaction);
      if (transactionalVersion > _schemaVersion) {
        throw WorkspaceFormatException(
          'Database schema $transactionalVersion is newer than supported schema $_schemaVersion.',
        );
      }
      if (transactionalVersion == _schemaVersion) {
        await _verifySchema(transaction);
        return;
      }
      if (transactionalVersion != 0) {
        throw WorkspaceFormatException(
          'Database schema $transactionalVersion is not supported.',
        );
      }

      final existingObjects = await transaction.rawQuery(
        "SELECT name FROM sqlite_master "
        "WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      );
      if (existingObjects.isNotEmpty) {
        throw const WorkspaceFormatException(
          'An unversioned database already contains application tables.',
        );
      }

      await transaction.execute('''
        CREATE TABLE meta (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          revision INTEGER NOT NULL CHECK (revision > 0)
        )
      ''');
      await transaction.execute('''
        CREATE TABLE draft (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          payload TEXT NOT NULL
        )
      ''');
      await transaction.execute('''
        CREATE TABLE gallery (
          id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
          ordinal INTEGER NOT NULL UNIQUE,
          payload TEXT NOT NULL
        )
      ''');
      await transaction.execute('''
        CREATE TABLE workspace (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          extra_json TEXT NOT NULL
        )
      ''');
      await transaction.execute('PRAGMA user_version = $_schemaVersion');
    });
    await _verifySchema(database);
  }

  static Future<int> _readUserVersion(DatabaseExecutor executor) async {
    final rows = await executor.rawQuery('PRAGMA user_version');
    if (rows.length != 1 || rows.single['user_version'] is! int) {
      throw const WorkspaceFormatException(
        'SQLite did not return a valid schema version.',
      );
    }
    return rows.single['user_version']! as int;
  }

  static Future<void> _verifySchema(DatabaseExecutor executor) async {
    final tables = await executor.rawQuery(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    );
    final names = tables.map((row) => row['name']).whereType<String>().toSet();
    for (final table in _requiredTables) {
      if (!names.contains(table)) {
        throw WorkspaceFormatException(
          'Schema $_schemaVersion is missing the $table table.',
        );
      }
    }

    const requiredColumns = <String, Set<String>>{
      'meta': {'id', 'revision'},
      'draft': {'id', 'payload'},
      'gallery': {'id', 'ordinal', 'payload'},
      'workspace': {'id', 'extra_json'},
    };
    for (final entry in requiredColumns.entries) {
      final columns = await executor.rawQuery(
        'PRAGMA table_info(${entry.key})',
      );
      final columnNames = columns
          .map((row) => row['name'])
          .whereType<String>()
          .toSet();
      if (!columnNames.containsAll(entry.value)) {
        throw WorkspaceFormatException(
          'Schema $_schemaVersion has an invalid ${entry.key} table.',
        );
      }
    }
  }

  static Future<int?> _readRevision(DatabaseExecutor executor) async {
    final rows = await executor.query('meta', limit: 2);
    if (rows.isEmpty) return null;
    if (rows.length != 1 || rows.single['id'] != _workspaceId) {
      throw const WorkspaceFormatException(
        'The workspace metadata row is malformed.',
      );
    }
    final revision = rows.single['revision'];
    if (revision is! int || revision < 1) {
      throw const WorkspaceFormatException(
        'The workspace revision is malformed.',
      );
    }
    return revision;
  }

  static Future<void> _ensureNoOrphanSnapshot(DatabaseExecutor executor) async {
    for (final table in const ['draft', 'gallery', 'workspace']) {
      final rows = await executor.query(table, limit: 1);
      if (rows.isNotEmpty) {
        throw WorkspaceFormatException(
          'The $table table contains data without workspace metadata.',
        );
      }
    }
  }

  static Future<List<_StoredGalleryItem>> _readGallery(
    DatabaseExecutor executor,
  ) async {
    final rows = await executor.query('gallery', orderBy: 'ordinal ASC');
    final result = <_StoredGalleryItem>[];
    final seenIds = <String>{};
    for (var index = 0; index < rows.length; index++) {
      final row = rows[index];
      final id = row['id'];
      final ordinal = row['ordinal'];
      final payload = row['payload'];
      if (id is! String ||
          id.isEmpty ||
          ordinal is! int ||
          ordinal != index ||
          payload is! String ||
          !seenIds.add(id)) {
        throw const WorkspaceFormatException('The gallery index is malformed.');
      }
      final data = _decodeJsonObject(payload, 'gallery item $id');
      if (data['id'] != id) {
        throw WorkspaceFormatException(
          'Gallery item $id does not match its stored payload id.',
        );
      }
      result.add(
        _StoredGalleryItem(
          id: id,
          ordinal: ordinal,
          payload: payload,
          data: data,
        ),
      );
    }
    return result;
  }

  static Future<void> _syncGallery(
    Transaction transaction,
    List<_PreparedGalleryItem> next,
  ) async {
    final current = await _readGallery(transaction);
    final currentById = {for (final item in current) item.id: item};
    final nextById = {for (final item in next) item.id: item};

    for (final oldItem in current) {
      if (!nextById.containsKey(oldItem.id)) {
        // Delete only ids that were actually removed from the new snapshot.
        await transaction.delete(
          'gallery',
          where: 'id = ?',
          whereArgs: [oldItem.id],
        );
      }
    }

    final movedExisting = <_PreparedGalleryItem>[];
    for (final item in next) {
      final oldItem = currentById[item.id];
      if (oldItem != null && oldItem.ordinal != item.ordinal) {
        movedExisting.add(item);
      }
    }
    // Free changed ordinals first so reordering rows does not collide with the
    // table's UNIQUE ordinal constraint. Negative values exist only inside this
    // transaction and are rolled back if any later write fails.
    for (var index = 0; index < movedExisting.length; index++) {
      await transaction.update(
        'gallery',
        {'ordinal': -(index + 1)},
        where: 'id = ?',
        whereArgs: [movedExisting[index].id],
      );
    }

    for (final item in next) {
      final oldItem = currentById[item.id];
      if (oldItem != null &&
          oldItem.ordinal == item.ordinal &&
          oldItem.payload == item.payload) {
        continue;
      }
      await transaction.insert('gallery', {
        'id': item.id,
        'ordinal': item.ordinal,
        'payload': item.payload,
      }, conflictAlgorithm: ConflictAlgorithm.replace);
    }
  }

  static _PreparedSnapshot _prepareSnapshot(Map<String, Object?> data) {
    final normalized = _normalizeJsonValue(data, HashSet<Object>.identity());
    if (normalized is! Map<String, Object?>) {
      throw const WorkspaceFormatException(
        'The workspace root must be a JSON object.',
      );
    }
    _validateWorkspaceRoot(normalized);

    final draft = normalized['draft']! as Map<String, Object?>;
    final gallery = normalized['gallery']! as List<Object?>;
    final galleryItems = <_PreparedGalleryItem>[];
    final seenIds = <String>{};
    for (var ordinal = 0; ordinal < gallery.length; ordinal++) {
      final item = gallery[ordinal];
      if (item is! Map<String, Object?>) {
        throw WorkspaceFormatException(
          'Gallery item at position $ordinal must be a JSON object.',
        );
      }
      final id = item['id'];
      if (id is! String || id.trim().isEmpty) {
        throw WorkspaceFormatException(
          'Gallery item at position $ordinal must have a non-empty string id.',
        );
      }
      if (!seenIds.add(id)) {
        throw WorkspaceFormatException('Gallery id $id is duplicated.');
      }
      galleryItems.add(
        _PreparedGalleryItem(
          id: id,
          ordinal: ordinal,
          payload: jsonEncode(item),
          data: item,
        ),
      );
    }

    final extra = <String, Object?>{
      for (final entry in normalized.entries)
        if (entry.key != 'draft' && entry.key != 'gallery')
          entry.key: entry.value,
    };
    return _PreparedSnapshot(
      draftPayload: jsonEncode(draft),
      gallery: galleryItems,
      extraJson: jsonEncode(extra),
    );
  }

  static void _validateWorkspaceRoot(Map<String, Object?> data) {
    const mapFields = ['draft', 'preferences', 'editor'];
    for (final field in mapFields) {
      if (data[field] is! Map<String, Object?>) {
        throw WorkspaceFormatException(
          'Workspace field $field must be a JSON object.',
        );
      }
    }
    if (data['gallery'] is! List<Object?>) {
      throw const WorkspaceFormatException(
        'Workspace field gallery must be a JSON array.',
      );
    }
    if (data['selectedId'] is! String) {
      throw const WorkspaceFormatException(
        'Workspace field selectedId must be a string.',
      );
    }
    if (data['demoSequence'] is! int) {
      throw const WorkspaceFormatException(
        'Workspace field demoSequence must be an integer.',
      );
    }
  }

  static Object? _normalizeJsonValue(Object? value, Set<Object> visiting) {
    if (value == null || value is String || value is bool || value is int) {
      return value;
    }
    if (value is double) {
      if (!value.isFinite) {
        throw const WorkspaceFormatException('JSON numbers must be finite.');
      }
      return value;
    }
    if (value is List) {
      if (!visiting.add(value)) {
        throw const WorkspaceFormatException('JSON values cannot be cyclic.');
      }
      try {
        return value
            .map((item) => _normalizeJsonValue(item, visiting))
            .toList(growable: false);
      } finally {
        visiting.remove(value);
      }
    }
    if (value is Map) {
      if (!visiting.add(value)) {
        throw const WorkspaceFormatException('JSON values cannot be cyclic.');
      }
      try {
        final keys = <String>[];
        for (final key in value.keys) {
          if (key is! String) {
            throw const WorkspaceFormatException(
              'JSON object keys must be strings.',
            );
          }
          keys.add(key);
        }
        keys.sort();
        return <String, Object?>{
          for (final key in keys)
            key: _normalizeJsonValue(value[key], visiting),
        };
      } finally {
        visiting.remove(value);
      }
    }
    throw WorkspaceFormatException(
      'Workspace values of type ${value.runtimeType} are not JSON encodable.',
    );
  }

  static Map<String, Object?> _decodeJsonObject(String payload, String field) {
    late final Object? decoded;
    try {
      decoded = jsonDecode(payload);
    } on FormatException catch (error) {
      throw WorkspaceFormatException(
        'The $field payload is not valid JSON.',
        cause: error,
      );
    }
    final normalized = _normalizeJsonValue(decoded, HashSet<Object>.identity());
    if (normalized is! Map<String, Object?>) {
      throw WorkspaceFormatException(
        'The $field payload must be a JSON object.',
      );
    }
    return normalized;
  }
}

class _PreparedSnapshot {
  const _PreparedSnapshot({
    required this.draftPayload,
    required this.gallery,
    required this.extraJson,
  });

  final String draftPayload;
  final List<_PreparedGalleryItem> gallery;
  final String extraJson;
}

class _PreparedGalleryItem {
  const _PreparedGalleryItem({
    required this.id,
    required this.ordinal,
    required this.payload,
    required this.data,
  });

  final String id;
  final int ordinal;
  final String payload;
  final Map<String, Object?> data;
}

class _StoredGalleryItem {
  const _StoredGalleryItem({
    required this.id,
    required this.ordinal,
    required this.payload,
    required this.data,
  });

  final String id;
  final int ordinal;
  final String payload;
  final Map<String, Object?> data;
}

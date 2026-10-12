import 'dart:typed_data';

import 'package:sqflite_common/sqlite_api.dart';
import 'package:sqflite_common_ffi_web/sqflite_ffi_web.dart';

import 'image_asset.dart';
import 'image_asset_store_contract.dart';
import 'image_asset_store_serial.dart';
import 'image_asset_validation.dart';

const int _schemaVersion = 1;
const String _tableName = 'image_asset';
const List<String> _requiredColumns = <String>[
  'id',
  'asset_ref',
  'width',
  'height',
  'mime',
  'sha256',
  'byte_length',
  'image_data',
];

/// Opens the browser-backed image store in its own IndexedDB SQLite database.
///
/// [directory] is accepted to keep the platform factory signature aligned with
/// `openWorkspaceStore`; browser storage is scoped to the current site instead.
Future<ImageAssetStore> openImageAssetStore({
  String? directory,
  int maximumImageBytes = defaultMaximumImageBytes,
}) async {
  if (directory != null && directory.trim().isEmpty) {
    throw ArgumentError.value(
      directory,
      'directory',
      'Must not be empty when provided.',
    );
  }
  validateMaximumImageBytes(maximumImageBytes);

  late final Database database;
  try {
    database = await databaseFactoryFfiWeb.openDatabase(
      'assets.sqlite',
      options: OpenDatabaseOptions(singleInstance: true),
    );
  } on DatabaseException catch (error) {
    throw ImageAssetStoreException(
      'The browser image asset database could not be opened.',
      cause: error,
    );
  }

  try {
    await _initializeSchema(database);
    return _SQLiteWebImageAssetStore(
      database: database,
      maximumImageBytes: maximumImageBytes,
    );
  } catch (error, stackTrace) {
    try {
      await database.close();
    } catch (_) {
      // Preserve the initialization error.
    }
    Error.throwWithStackTrace(error, stackTrace);
  }
}

class _SQLiteWebImageAssetStore extends SerializedImageAssetStore {
  _SQLiteWebImageAssetStore({
    required this._database,
    required this.maximumImageBytes,
  });

  final Database _database;
  final int maximumImageBytes;

  @override
  String get label => '浏览器 IndexedDB（assets.sqlite）';

  @override
  Future<ImageAsset> save(Uint8List bytes) async {
    final validated = await validateImageAssetBytes(
      bytes,
      maximumBytes: maximumImageBytes,
    );
    return runSerialized(() async {
      return _database.transaction((transaction) async {
        final asset = validated.asset;
        await transaction.insert(_tableName, <String, Object?>{
          'id': asset.id,
          'asset_ref': asset.assetRef,
          'width': asset.width,
          'height': asset.height,
          'mime': asset.mime,
          'sha256': asset.sha256,
          'byte_length': asset.byteLength,
          'image_data': validated.bytes,
        }, conflictAlgorithm: ConflictAlgorithm.ignore);
        final rows = await transaction.query(
          _tableName,
          where: 'id = ?',
          whereArgs: <Object?>[asset.id],
          limit: 1,
        );
        if (rows.isEmpty) {
          throw const ImageAssetIntegrityException(
            'The image asset could not be indexed after insertion.',
          );
        }
        final stored = _readStoredBytes(rows.single);
        _verifyRow(rows.single, asset.assetRef, stored, expected: asset);
        if (!imageBytesEqual(stored, validated.bytes)) {
          throw const ImageAssetIntegrityException(
            'A different image already occupies this SHA-256 identity.',
          );
        }
        return asset;
      });
    });
  }

  @override
  Future<Uint8List> read(String assetRef) async {
    final ref = parseImageAssetRef(assetRef);
    return runSerialized(() async {
      final rows = await _database.query(
        _tableName,
        where: 'asset_ref = ?',
        whereArgs: <Object?>[assetRef],
        limit: 1,
      );
      if (rows.isEmpty) throw ImageAssetNotFoundException(assetRef);

      final bytes = _readStoredBytes(rows.single);
      _verifyRow(rows.single, assetRef, bytes);
      verifyStoredAsset(bytes, ref, maximumBytes: maximumImageBytes);
      return Uint8List.fromList(bytes);
    });
  }

  @override
  Future<void> closeResources() async {
    if (_database.isOpen) await _database.close();
  }

  Uint8List _readStoredBytes(Map<String, Object?> row) {
    final value = row['image_data'];
    if (value is Uint8List) return Uint8List.fromList(value);
    if (value is List<int>) return Uint8List.fromList(value);
    throw const ImageAssetIntegrityException(
      'The browser image asset database contains invalid image bytes.',
    );
  }

  void _verifyRow(
    Map<String, Object?> row,
    String assetRef,
    List<int> bytes, {
    ImageAsset? expected,
  }) {
    final ref = parseImageAssetRef(assetRef);
    final width = row['width'];
    final height = row['height'];
    if (row['id'] != ref.sha256 ||
        row['asset_ref'] != assetRef ||
        row['sha256'] != ref.sha256 ||
        row['mime'] != ref.mime ||
        row['byte_length'] != bytes.length ||
        width is! int ||
        height is! int ||
        width <= 0 ||
        height <= 0 ||
        width > maximumImageDimension ||
        height > maximumImageDimension ||
        width * height > maximumImagePixels ||
        (expected != null &&
            (width != expected.width || height != expected.height))) {
      throw const ImageAssetIntegrityException(
        'Browser image asset metadata does not match its reference.',
      );
    }
    verifyStoredAsset(bytes, ref, maximumBytes: maximumImageBytes);
  }
}

Future<void> _initializeSchema(Database database) async {
  final versionRows = await database.rawQuery('PRAGMA user_version');
  final rawVersion = versionRows.isEmpty
      ? null
      : versionRows.first.values.first;
  final version = rawVersion is int ? rawVersion : int.tryParse('$rawVersion');
  if (version == null) {
    throw const ImageAssetStoreException(
      'The browser image asset database has an invalid schema version.',
    );
  }
  if (version > _schemaVersion) {
    throw ImageAssetStoreException(
      'Image asset database schema $version is newer than supported schema $_schemaVersion.',
    );
  }
  if (version == 0) {
    final existingTables = await database.rawQuery(
      "SELECT name FROM sqlite_master "
      "WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    );
    if (existingTables.isNotEmpty) {
      throw const ImageAssetStoreException(
        'An unversioned image asset database already contains application tables.',
      );
    }
    await database.transaction((transaction) async {
      await transaction.execute('''
        CREATE TABLE $_tableName (
          id TEXT PRIMARY KEY,
          asset_ref TEXT NOT NULL UNIQUE,
          width INTEGER NOT NULL CHECK(width > 0),
          height INTEGER NOT NULL CHECK(height > 0),
          mime TEXT NOT NULL,
          sha256 TEXT NOT NULL UNIQUE,
          byte_length INTEGER NOT NULL CHECK(byte_length > 0),
          image_data BLOB NOT NULL
        )
      ''');
      await transaction.execute('PRAGMA user_version = $_schemaVersion');
    });
  } else if (version != _schemaVersion) {
    throw ImageAssetStoreException(
      'Image asset database schema $version is not supported.',
    );
  }
  await _verifySchema(database);
}

Future<void> _verifySchema(DatabaseExecutor executor) async {
  final rows = await executor.rawQuery('PRAGMA table_info($_tableName)');
  final columns = rows.map((row) => row['name']).whereType<String>().toSet();
  if (!_requiredColumns.every(columns.contains)) {
    throw const ImageAssetStoreException(
      'The browser image asset database has an incomplete image_asset table.',
    );
  }
}

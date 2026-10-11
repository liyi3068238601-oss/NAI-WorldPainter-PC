import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import 'sqlite_workspace_store.dart';

/// Opens the Windows/desktop SQLite store using the FFI background isolate.
///
/// The directory precedence is explicit argument, environment variable,
/// compile-time environment value, then the per-user Windows application data
/// directory. Tests and probes should pass an explicit directory.
Future<WorkspaceStore> openWorkspaceStore({String? directory}) async {
  final resolvedDirectory = await _resolveDirectory(directory);
  await Directory(resolvedDirectory).create(recursive: true);

  sqfliteFfiInit();
  return SQLiteWorkspaceStore.open(
    factory: databaseFactoryFfi,
    path: p.join(resolvedDirectory, 'workspace.sqlite'),
    label: 'SQLite',
  );
}

Future<String> _resolveDirectory(String? explicitDirectory) async {
  if (explicitDirectory != null) {
    if (explicitDirectory.trim().isEmpty) {
      throw ArgumentError.value(
        explicitDirectory,
        'directory',
        'Must not be empty.',
      );
    }
    return p.absolute(explicitDirectory);
  }

  final environmentDirectory = Platform.environment['WORLDPAINTER_DATA_DIR'];
  if (environmentDirectory != null && environmentDirectory.trim().isNotEmpty) {
    return p.absolute(environmentDirectory);
  }

  const compileTimeDirectoryBase64 = String.fromEnvironment(
    'WORLDPAINTER_DATA_DIR_BASE64',
  );
  if (compileTimeDirectoryBase64.trim().isNotEmpty) {
    try {
      final decodedDirectory = utf8.decode(
        base64.decode(compileTimeDirectoryBase64),
      );
      if (decodedDirectory.trim().isEmpty) {
        throw StateError(
          'WORLDPAINTER_DATA_DIR_BASE64 decoded to an empty path.',
        );
      }
      return p.absolute(decodedDirectory);
    } on FormatException catch (error) {
      throw StateError(
        'WORLDPAINTER_DATA_DIR_BASE64 is not valid UTF-8 base64: $error',
      );
    }
  }

  const compileTimeDirectory = String.fromEnvironment('WORLDPAINTER_DATA_DIR');
  if (compileTimeDirectory.trim().isNotEmpty) {
    return p.absolute(compileTimeDirectory);
  }

  final localAppData = Platform.environment['LOCALAPPDATA'];
  if (localAppData == null || localAppData.trim().isEmpty) {
    throw StateError('Windows LOCALAPPDATA is unavailable.');
  }
  return p.absolute(p.join(localAppData, 'WorldPainter', 'PC'));
}

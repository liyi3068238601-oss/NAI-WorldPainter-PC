import 'package:sqflite_common_ffi_web/sqflite_ffi_web.dart';

import 'sqlite_workspace_store.dart';

Future<WorkspaceStore> openWorkspaceStore({String? directory}) =>
    SQLiteWorkspaceStore.open(
      factory: databaseFactoryFfiWeb,
      path: 'workspace.sqlite',
      label: '浏览器预览存储（与 Windows 独立）',
      singleInstance: true,
    );

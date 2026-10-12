import 'dart:typed_data';

import 'image_export_stub.dart'
    if (dart.library.io) 'image_export_io.dart'
    if (dart.library.js_interop) 'image_export_web.dart'
    as platform;

const int _maximumExportBytes = 64 * 1024 * 1024;
const List<int> _pngSignature = <int>[
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
];

/// Saves a PNG after the user chooses a destination, or returns false if the
/// platform does not support export or the user cancels the save dialog.
Future<bool> exportImage(
  Uint8List bytes, {
  String suggestedName = '绘世-结果.png',
}) async {
  if (bytes.length < _pngSignature.length ||
      bytes.length > _maximumExportBytes ||
      !_hasPngSignature(bytes)) {
    throw const FormatException('只能导出不超过 64 MiB 的 PNG 图片。');
  }

  return platform.exportImageImpl(
    Uint8List.fromList(bytes),
    _sanitizeSuggestedName(suggestedName),
  );
}

bool _hasPngSignature(List<int> bytes) {
  for (var index = 0; index < _pngSignature.length; index++) {
    if (bytes[index] != _pngSignature[index]) return false;
  }
  return true;
}

String _sanitizeSuggestedName(String suggestedName) {
  var name = suggestedName
      .replaceAll(RegExp(r'[\x00-\x1f<>:"/\\|?*]'), '_')
      .trim()
      .replaceAll(RegExp(r'[ .]+$'), '');
  name = name.replaceFirst(RegExp(r'\.[^.]*$'), '');
  name = name.replaceAll(RegExp(r'[ .]+$'), '').trim();
  if (name.isEmpty) name = '绘世-结果';
  if (name.length > 140) name = name.substring(0, 140).trimRight();
  if (RegExp(
    r'^(con|prn|aux|nul|com[1-9]|lpt[1-9])$',
    caseSensitive: false,
  ).hasMatch(name)) {
    name = '_$name';
  }
  return '$name.png';
}

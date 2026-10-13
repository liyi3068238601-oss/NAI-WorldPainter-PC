import 'dart:typed_data';
import 'dart:ui' as ui;

import '../media/image_asset_store_contract.dart';
import '../media/image_asset_validation.dart';
import 'image_export_stub.dart'
    if (dart.library.io) 'image_export_io.dart'
    if (dart.library.js_interop) 'image_export_web.dart'
    as platform;

const int _maximumExportBytes = defaultMaximumImageBytes;
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

/// Validates an image and prepares bytes for the PNG-only export boundary.
///
/// Valid PNG bytes are preserved exactly. JPEG and WebP images are decoded and
/// encoded as PNG without changing the source bytes. This helper does not open
/// a platform save dialog, so callers can inspect or store the prepared result
/// independently of the platform export capability.
Future<Uint8List> preparePngExportBytes(Uint8List bytes) async {
  if (bytes.length > _maximumExportBytes) {
    throw const FormatException('只能导出不超过 64 MiB 的图片。');
  }

  final validated = await validateImageAssetBytes(
    bytes,
    maximumBytes: _maximumExportBytes,
  );
  if (validated.asset.mime == 'image/png') return validated.bytes;

  ui.Codec? codec;
  ui.Image? image;
  try {
    codec = await ui.instantiateImageCodec(validated.bytes);
    final frame = await codec.getNextFrame();
    image = frame.image;
    if (image.width != validated.asset.width ||
        image.height != validated.asset.height) {
      throw const ImageAssetValidationException(
        'Decoded image dimensions changed during PNG export.',
      );
    }

    final encoded = await image.toByteData(format: ui.ImageByteFormat.png);
    if (encoded == null) {
      throw const FormatException('图片无法编码为 PNG。');
    }
    final png = Uint8List.fromList(
      encoded.buffer.asUint8List(encoded.offsetInBytes, encoded.lengthInBytes),
    );
    if (png.length > _maximumExportBytes) {
      throw const FormatException('PNG 导出结果超过 64 MiB 限制。');
    }
    if (!_hasPngHeader(png, validated.asset.width, validated.asset.height)) {
      throw const FormatException('图片无法编码为有效 PNG。');
    }
    return png;
  } finally {
    image?.dispose();
    codec?.dispose();
  }
}

/// Saves a PNG after the user chooses a destination, or returns false if the
/// platform does not support export or the user cancels the save dialog.
Future<bool> exportImage(
  Uint8List bytes, {
  String suggestedName = '绘世-结果.png',
}) async {
  final png = await preparePngExportBytes(bytes);
  return platform.exportImageImpl(
    png,
    sanitizePngExportFileName(suggestedName),
  );
}

bool _hasPngSignature(List<int> bytes) {
  for (var index = 0; index < _pngSignature.length; index++) {
    if (bytes[index] != _pngSignature[index]) return false;
  }
  return true;
}

bool _hasPngHeader(Uint8List bytes, int width, int height) {
  if (bytes.length < 24 || !_hasPngSignature(bytes)) return false;
  final header = ByteData.sublistView(bytes);
  return header.getUint32(8, Endian.big) == 13 &&
      bytes[12] == 0x49 &&
      bytes[13] == 0x48 &&
      bytes[14] == 0x44 &&
      bytes[15] == 0x52 &&
      header.getUint32(16, Endian.big) == width &&
      header.getUint32(20, Endian.big) == height;
}

/// Returns a safe PNG filename for a platform save dialog.
///
/// Invalid path characters are replaced, any existing extension is replaced
/// with `.png`, Windows device names are prefixed, and the result is bounded.
String sanitizePngExportFileName(String suggestedName) {
  var name = suggestedName
      .replaceAll(RegExp(r'[\x00-\x1f<>:"/\\|?*]'), '_')
      .trim()
      .replaceAll(RegExp(r'[ .]+$'), '');
  name = name.replaceFirst(RegExp(r'\.[^.]*$'), '');
  name = name.replaceAll(RegExp(r'[ .]+$'), '').trim();
  if (name.isEmpty) name = '绘世-结果';
  if (name.length > 140) name = name.substring(0, 140).trimRight();
  final deviceStem = name.split('.').first;
  if (RegExp(
    r'^(con|prn|aux|nul|com[1-9]|lpt[1-9])$',
    caseSensitive: false,
  ).hasMatch(deviceStem)) {
    name = '_$name';
  }
  return '$name.png';
}

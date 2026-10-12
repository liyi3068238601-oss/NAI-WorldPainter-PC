import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:crypto/crypto.dart';

import 'image_asset.dart';
import 'image_asset_store_contract.dart';

const int defaultMaximumImageBytes = 64 * 1024 * 1024;
const int maximumImageDimension = 32768;
const int maximumImagePixels = 100 * 1000 * 1000;

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

class ValidatedImageAsset {
  const ValidatedImageAsset({required this.bytes, required this.asset});

  final Uint8List bytes;
  final ImageAsset asset;
}

class ImageAssetRef {
  const ImageAssetRef({
    required this.sha256,
    required this.mime,
    required this.extension,
    required this.value,
  });

  final String sha256;
  final String mime;
  final String extension;
  final String value;
}

Future<ValidatedImageAsset> validateImageAssetBytes(
  Uint8List input, {
  int maximumBytes = defaultMaximumImageBytes,
}) async {
  validateMaximumImageBytes(maximumBytes);
  if (input.isEmpty) {
    throw const ImageAssetValidationException('Image data is empty.');
  }
  if (input.length > maximumBytes) {
    throw ImageAssetValidationException(
      'Image data exceeds the $maximumBytes byte limit.',
    );
  }

  final bytes = Uint8List.fromList(input);
  final format = detectImageFormat(bytes);
  if (format == null) {
    throw const ImageAssetValidationException(
      'Only PNG, JPEG, and WebP images are supported.',
    );
  }

  final headerDimensions = _readHeaderDimensions(bytes, format);
  _validateDimensions(headerDimensions.$1, headerDimensions.$2);

  late final int width;
  late final int height;
  try {
    final codec = await ui.instantiateImageCodec(bytes);
    try {
      final frame = await codec.getNextFrame();
      try {
        width = frame.image.width;
        height = frame.image.height;
      } finally {
        frame.image.dispose();
      }
    } finally {
      codec.dispose();
    }
  } catch (error) {
    throw ImageAssetValidationException(
      'The $format image could not be decoded.',
      cause: error,
    );
  }

  if (width <= 0 || height <= 0) {
    throw const ImageAssetValidationException(
      'Image dimensions must be positive.',
    );
  }
  if (width != headerDimensions.$1 || height != headerDimensions.$2) {
    throw ImageAssetValidationException(
      'Decoded image dimensions do not match the image header.',
    );
  }

  final digest = sha256.convert(bytes).toString();
  final mime = mimeForImageFormat(format);
  final extension = extensionForMime(mime);
  final assetRef = 'sha256/${digest.substring(0, 2)}/$digest.$extension';
  return ValidatedImageAsset(
    bytes: bytes,
    asset: ImageAsset(
      id: digest,
      assetRef: assetRef,
      width: width,
      height: height,
      mime: mime,
      sha256: digest,
      byteLength: bytes.length,
    ),
  );
}

void validateMaximumImageBytes(int maximumBytes) {
  if (maximumBytes <= 0 || maximumBytes > defaultMaximumImageBytes) {
    throw ArgumentError.value(
      maximumBytes,
      'maximumBytes',
      'Must be greater than zero and at most $defaultMaximumImageBytes.',
    );
  }
}

String? detectImageFormat(List<int> bytes) {
  if (bytes.length >= _pngSignature.length &&
      _startsWith(bytes, _pngSignature)) {
    return 'PNG';
  }
  if (bytes.length >= 3 &&
      bytes[0] == 0xff &&
      bytes[1] == 0xd8 &&
      bytes[2] == 0xff) {
    return 'JPEG';
  }
  if (bytes.length >= 12 &&
      _matchesAscii(bytes, 0, 'RIFF') &&
      _matchesAscii(bytes, 8, 'WEBP')) {
    return 'WebP';
  }
  return null;
}

String mimeForImageFormat(String format) => switch (format) {
  'PNG' => 'image/png',
  'JPEG' => 'image/jpeg',
  'WebP' => 'image/webp',
  _ => throw ArgumentError.value(format, 'format'),
};

String extensionForMime(String mime) => switch (mime) {
  'image/png' => 'png',
  'image/jpeg' => 'jpg',
  'image/webp' => 'webp',
  _ => throw ArgumentError.value(mime, 'mime'),
};

ImageAssetRef parseImageAssetRef(String value) {
  final match = RegExp(r'^sha256/([0-9a-f]{2})/([0-9a-f]{64})\.(png|jpg|webp)$')
      .firstMatch(value);
  if (match == null || match[1] != match[2]!.substring(0, 2)) {
    throw const ImageAssetValidationException('Invalid image asset reference.');
  }
  final extension = match[3]!;
  final mime = switch (extension) {
    'png' => 'image/png',
    'jpg' => 'image/jpeg',
    'webp' => 'image/webp',
    _ => throw const ImageAssetValidationException(
      'Invalid image asset reference.',
    ),
  };
  return ImageAssetRef(
    sha256: match[2]!,
    mime: mime,
    extension: extension,
    value: value,
  );
}

void verifyStoredAsset(
  List<int> bytes,
  ImageAssetRef ref, {
  required int maximumBytes,
}) {
  if (bytes.length > maximumBytes) {
    throw ImageAssetIntegrityException(
      'Stored image exceeds the $maximumBytes byte limit.',
    );
  }
  final actualFormat = detectImageFormat(bytes);
  if (actualFormat == null || mimeForImageFormat(actualFormat) != ref.mime) {
    throw const ImageAssetIntegrityException(
      'Stored image format does not match its reference.',
    );
  }
  final actualHash = sha256.convert(bytes).toString();
  if (actualHash != ref.sha256) {
    throw const ImageAssetIntegrityException(
      'Stored image SHA-256 does not match its reference.',
    );
  }
}

bool imageBytesEqual(List<int> left, List<int> right) {
  if (left.length != right.length) return false;
  for (var index = 0; index < left.length; index++) {
    if (left[index] != right[index]) return false;
  }
  return true;
}

(int, int) _readHeaderDimensions(Uint8List bytes, String format) {
  final data = ByteData.sublistView(bytes);
  switch (format) {
    case 'PNG':
      if (bytes.length < 24 ||
          data.getUint32(8, Endian.big) != 13 ||
          !_matchesAscii(bytes, 12, 'IHDR')) {
        throw const ImageAssetValidationException(
          'The PNG image has an incomplete IHDR header.',
        );
      }
      return (data.getUint32(16, Endian.big), data.getUint32(20, Endian.big));
    case 'JPEG':
      return _readJpegDimensions(bytes);
    case 'WebP':
      return _readWebpDimensions(bytes, data);
    default:
      throw ImageAssetValidationException('Unsupported image format: $format.');
  }
}

(int, int) _readJpegDimensions(Uint8List bytes) {
  var offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] != 0xff) {
      throw const ImageAssetValidationException(
        'The JPEG image has an invalid marker sequence.',
      );
    }
    while (offset < bytes.length && bytes[offset] == 0xff) {
      offset++;
    }
    if (offset >= bytes.length) break;
    final marker = bytes[offset++];
    if (marker == 0xd9 || marker == 0xda) break;
    if (marker == 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 2 > bytes.length) break;

    final segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
    if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
    if (_isJpegStartOfFrame(marker)) {
      if (segmentLength < 7) break;
      final height = (bytes[offset + 3] << 8) | bytes[offset + 4];
      final width = (bytes[offset + 5] << 8) | bytes[offset + 6];
      return (width, height);
    }
    offset += segmentLength;
  }
  throw const ImageAssetValidationException(
    'The JPEG image does not contain a valid frame header.',
  );
}

bool _isJpegStartOfFrame(int marker) => switch (marker) {
  0xc0 ||
  0xc1 ||
  0xc2 ||
  0xc3 ||
  0xc5 ||
  0xc6 ||
  0xc7 ||
  0xc9 ||
  0xca ||
  0xcb ||
  0xcd ||
  0xce ||
  0xcf => true,
  _ => false,
};

(int, int) _readWebpDimensions(Uint8List bytes, ByteData data) {
  var offset = 12;
  while (offset + 8 <= bytes.length) {
    final chunkName = String.fromCharCodes(bytes.sublist(offset, offset + 4));
    final chunkLength = data.getUint32(offset + 4, Endian.little);
    final payload = offset + 8;
    if (chunkLength > bytes.length - payload) break;

    if (chunkName == 'VP8X' && chunkLength >= 10) {
      return (
        1 + _uint24LittleEndian(bytes, payload + 4),
        1 + _uint24LittleEndian(bytes, payload + 7),
      );
    }
    if (chunkName == 'VP8L' && chunkLength >= 5 && bytes[payload] == 0x2f) {
      final bits = data.getUint32(payload + 1, Endian.little);
      return ((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
    }
    if (chunkName == 'VP8 ' && chunkLength >= 10) {
      final frame = payload;
      if (bytes[frame + 3] == 0x9d &&
          bytes[frame + 4] == 0x01 &&
          bytes[frame + 5] == 0x2a) {
        final width = ((bytes[frame + 6] | (bytes[frame + 7] << 8)) & 0x3fff);
        final height = ((bytes[frame + 8] | (bytes[frame + 9] << 8)) & 0x3fff);
        return (width, height);
      }
    }
    offset = payload + chunkLength + (chunkLength.isOdd ? 1 : 0);
  }
  throw const ImageAssetValidationException(
    'The WebP image does not contain a valid frame header.',
  );
}

int _uint24LittleEndian(List<int> bytes, int offset) =>
    bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);

void _validateDimensions(int width, int height) {
  if (width <= 0 || height <= 0) {
    throw const ImageAssetValidationException(
      'Image dimensions must be positive.',
    );
  }
  if (width > maximumImageDimension || height > maximumImageDimension) {
    throw ImageAssetValidationException(
      'Image dimensions exceed $maximumImageDimension pixels per side.',
    );
  }
  if (width * height > maximumImagePixels) {
    throw ImageAssetValidationException(
      'Image dimensions exceed $maximumImagePixels pixels.',
    );
  }
}

bool _startsWith(List<int> bytes, List<int> signature) {
  for (var index = 0; index < signature.length; index++) {
    if (bytes[index] != signature[index]) return false;
  }
  return true;
}

bool _matchesAscii(List<int> bytes, int offset, String value) {
  for (var index = 0; index < value.length; index++) {
    if (bytes[offset + index] != value.codeUnitAt(index)) return false;
  }
  return true;
}

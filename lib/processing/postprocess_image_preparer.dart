import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' as ui;

import '../media/image_asset_validation.dart'
    show maximumImageDimension, maximumImagePixels, validateImageAssetBytes;

const int _maxUpscaleInputPixels = 3 * 1024 * 1024;

class PreparedPostprocessImage {
  final Uint8List bytes;
  final int width;
  final int height;

  const PreparedPostprocessImage({
    required this.bytes,
    required this.width,
    required this.height,
  });
}

class PostprocessImagePreparationException implements Exception {
  final String message;

  const PostprocessImagePreparationException(this.message);

  @override
  String toString() => message;
}

/// Prepares the first official Upscale input using the phone client's 3 MP
/// input cap. Later 2x passes are deliberately left untouched.
Future<PreparedPostprocessImage> prepareUpscaleInput({
  required Uint8List bytes,
  required int sourceWidth,
  required int sourceHeight,
}) async {
  _validateSourceDimensions(sourceWidth, sourceHeight);
  final decoded = await _decodeImageDimensions(bytes);
  _requireMatchingDimensions(decoded, sourceWidth, sourceHeight);
  final sourcePixels = sourceWidth * sourceHeight;
  if (sourcePixels <= _maxUpscaleInputPixels) {
    return PreparedPostprocessImage(
      bytes: bytes,
      width: sourceWidth,
      height: sourceHeight,
    );
  }

  final shrink = math.sqrt(_maxUpscaleInputPixels / sourcePixels);
  final width = (sourceWidth * shrink).floor().clamp(1, sourceWidth).toInt();
  final height = (sourceHeight * shrink).floor().clamp(1, sourceHeight).toInt();
  return _resizeImage(bytes: bytes, width: width, height: height);
}

/// Verifies the exact output dimensions implied by the prepared first input.
/// This must run before the first paid Upscale request; it intentionally does
/// not resize again because that would silently change the requested scale.
void validateUpscaleOutputDimensions({
  required int inputWidth,
  required int inputHeight,
  required double scale,
}) {
  if (inputWidth < 1 || inputHeight < 1 || (scale != 2 && scale != 4)) {
    throw const PostprocessImagePreparationException(
      'Upscale dimensions or scale are invalid.',
    );
  }
  final scaleFactor = scale.toInt();
  final outputWidth = inputWidth * scaleFactor;
  final outputHeight = inputHeight * scaleFactor;
  if (outputWidth > maximumImageDimension ||
      outputHeight > maximumImageDimension ||
      outputWidth * outputHeight > maximumImagePixels) {
    throw const PostprocessImagePreparationException(
      'Upscale output exceeds supported image dimensions.',
    );
  }
}

/// Prepares the image sent to the Enhance img2img endpoint, following the
/// phone client's 64-pixel alignment and 3 MP area cap.
Future<PreparedPostprocessImage> prepareEnhanceInput({
  required Uint8List bytes,
  required int sourceWidth,
  required int sourceHeight,
  required double scale,
  required bool upscaledEnhance,
}) async {
  _validateSourceDimensions(sourceWidth, sourceHeight);
  final decoded = await _decodeImageDimensions(bytes);
  _requireMatchingDimensions(decoded, sourceWidth, sourceHeight);
  var width = sourceWidth;
  var height = sourceHeight;
  if (upscaledEnhance) {
    width = (sourceWidth ~/ 64) * 64;
    height = (sourceHeight ~/ 64) * 64;
    if (width * height > _maxUpscaleInputPixels) {
      final shrink = math.sqrt(_maxUpscaleInputPixels / (width * height));
      width = ((width * shrink ~/ 64) * 64);
      height = ((height * shrink ~/ 64) * 64);
    }
  } else {
    width = (sourceWidth * scale).round();
    height = (sourceHeight * scale).round();
    if (width * height > _maxUpscaleInputPixels) {
      final shrink = math.sqrt(_maxUpscaleInputPixels / (width * height));
      width = (width * shrink).floor();
      height = (height * shrink).floor();
    }
  }
  width = ((width ~/ 64) * 64).clamp(64, 4096).toInt();
  height = ((height ~/ 64) * 64).clamp(64, 4096).toInt();

  if (width == sourceWidth && height == sourceHeight) {
    return PreparedPostprocessImage(bytes: bytes, width: width, height: height);
  }
  return _resizeImage(bytes: bytes, width: width, height: height);
}

Future<(int, int)> decodePostprocessImageDimensions(Uint8List bytes) async {
  final decoded = await _decodeImageDimensions(bytes);
  return (decoded.width, decoded.height);
}

class _DecodedDimensions {
  final int width;
  final int height;

  const _DecodedDimensions(this.width, this.height);
}

Future<_DecodedDimensions> _decodeImageDimensions(Uint8List bytes) async {
  if (bytes.isEmpty) {
    throw const PostprocessImagePreparationException('Image bytes are empty.');
  }
  try {
    // validateImageAssetBytes checks the file header dimensions before decoding,
    // then obtains the actual dimensions from the decoded frame. On Flutter Web,
    // ImageDescriptor.encoded's width/height getters are unsupported.
    final validated = await validateImageAssetBytes(bytes);
    return _DecodedDimensions(validated.asset.width, validated.asset.height);
  } catch (_) {
    throw const PostprocessImagePreparationException(
      'Image data could not be decoded.',
    );
  }
}

Future<PreparedPostprocessImage> _resizeImage({
  required Uint8List bytes,
  required int width,
  required int height,
}) async {
  _validateSourceDimensions(width, height);
  ui.Codec? codec;
  ui.Image? image;
  try {
    codec = await ui.instantiateImageCodec(
      bytes,
      targetWidth: width,
      targetHeight: height,
      allowUpscaling: true,
    );
    final frame = await codec.getNextFrame();
    image = frame.image;
    if (image.width != width || image.height != height) {
      throw const PostprocessImagePreparationException(
        'Resized image dimensions do not match the requested size.',
      );
    }
    final data = await image.toByteData(format: ui.ImageByteFormat.png);
    if (data == null || data.lengthInBytes == 0) {
      throw const PostprocessImagePreparationException(
        'Resized image could not be encoded.',
      );
    }
    return PreparedPostprocessImage(
      bytes: Uint8List.fromList(
        data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes),
      ),
      width: image.width,
      height: image.height,
    );
  } on PostprocessImagePreparationException {
    rethrow;
  } catch (_) {
    throw const PostprocessImagePreparationException(
      'Image could not be resized for post-processing.',
    );
  } finally {
    image?.dispose();
    codec?.dispose();
  }
}

void _validateSourceDimensions(int width, int height) {
  if (width < 1 ||
      height < 1 ||
      width > maximumImageDimension ||
      height > maximumImageDimension ||
      width * height > maximumImagePixels) {
    throw const PostprocessImagePreparationException(
      'Image dimensions are outside supported bounds.',
    );
  }
}

void _requireMatchingDimensions(
  _DecodedDimensions decoded,
  int width,
  int height,
) {
  if (decoded.width != width || decoded.height != height) {
    throw const PostprocessImagePreparationException(
      'Image dimensions do not match the source asset metadata.',
    );
  }
}

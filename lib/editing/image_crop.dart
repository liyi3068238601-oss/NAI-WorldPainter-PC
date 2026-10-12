import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' as ui;

const int _maxCropTargetDimension = 8192;
const int _maxCropTargetPixels = 64 * 1024 * 1024;
const int _maxSourceDimension = 32768;
const int _maxSourcePixels = 268435456;

class ImageCropResult {
  final Uint8List pngBytes;
  final ui.Rect cropRect;
  final int targetWidth;
  final int targetHeight;

  const ImageCropResult({
    required this.pngBytes,
    required this.cropRect,
    required this.targetWidth,
    required this.targetHeight,
  });
}

ui.Rect largestImageCropRectForRatio(
  ui.Rect bounds,
  double aspectRatio, {
  ui.Offset? center,
}) {
  _validateRect(bounds, 'bounds');
  if (bounds.width <= 0 || bounds.height <= 0) {
    throw ArgumentError.value(bounds, 'bounds', '裁切范围必须大于零');
  }
  if (!aspectRatio.isFinite || aspectRatio <= 0) {
    throw ArgumentError.value(aspectRatio, 'aspectRatio', '宽高比必须是有限正数');
  }

  var width = bounds.width;
  var height = width / aspectRatio;
  if (height > bounds.height) {
    height = bounds.height;
    width = height * aspectRatio;
  }

  final wantedCenter = center ?? bounds.center;
  final halfWidth = width / 2;
  final halfHeight = height / 2;
  final centerX = wantedCenter.dx
      .clamp(bounds.left + halfWidth, bounds.right - halfWidth)
      .toDouble();
  final centerY = wantedCenter.dy
      .clamp(bounds.top + halfHeight, bounds.bottom - halfHeight)
      .toDouble();
  return ui.Rect.fromCenter(
    center: ui.Offset(centerX, centerY),
    width: width,
    height: height,
  );
}

ui.Rect fitImageCropRectToBounds(
  ui.Rect cropRect,
  ui.Rect bounds, {
  required double aspectRatio,
  ui.Offset? center,
  double minWidth = 1,
}) {
  _validateRect(cropRect, 'cropRect');
  _validateRect(bounds, 'bounds');
  if (bounds.width <= 0 || bounds.height <= 0) {
    throw ArgumentError.value(bounds, 'bounds', '裁切范围必须大于零');
  }
  if (!aspectRatio.isFinite || aspectRatio <= 0) {
    throw ArgumentError.value(aspectRatio, 'aspectRatio', '宽高比必须是有限正数');
  }
  if (!minWidth.isFinite || minWidth <= 0) {
    throw ArgumentError.value(minWidth, 'minWidth', '最小宽度必须大于零');
  }

  final maxWidth = math.min(bounds.width, bounds.height * aspectRatio);
  final requestedWidth = math.min(
    cropRect.width,
    cropRect.height * aspectRatio,
  );
  final effectiveMinWidth = math.min(minWidth, maxWidth);
  final width = requestedWidth.clamp(effectiveMinWidth, maxWidth).toDouble();
  final height = width / aspectRatio;
  final wantedCenter = center ?? cropRect.center;
  final centerX = wantedCenter.dx
      .clamp(bounds.left + width / 2, bounds.right - width / 2)
      .toDouble();
  final centerY = wantedCenter.dy
      .clamp(bounds.top + height / 2, bounds.bottom - height / 2)
      .toDouble();

  return ui.Rect.fromCenter(
    center: ui.Offset(centerX, centerY),
    width: width,
    height: height,
  );
}

ui.Rect imageCropRectToSourcePixels({
  required ui.Rect cropRect,
  required ui.Rect imageRect,
  required int imageWidth,
  required int imageHeight,
  required int targetWidth,
  required int targetHeight,
}) {
  validateImageCropDimensions(
    imageWidth: imageWidth,
    imageHeight: imageHeight,
    targetWidth: targetWidth,
    targetHeight: targetHeight,
  );
  _validateRect(cropRect, 'cropRect');
  _validateRect(imageRect, 'imageRect');
  if (imageRect.width <= 0 || imageRect.height <= 0 || cropRect.isEmpty) {
    throw ArgumentError('图像或裁切区域必须大于零');
  }
  const epsilon = 0.001;
  if (cropRect.left < imageRect.left - epsilon ||
      cropRect.top < imageRect.top - epsilon ||
      cropRect.right > imageRect.right + epsilon ||
      cropRect.bottom > imageRect.bottom + epsilon) {
    throw ArgumentError.value(cropRect, 'cropRect', '裁切区域超出图像边界');
  }

  final scaleX = imageRect.width / imageWidth;
  final scaleY = imageRect.height / imageHeight;
  final availableWidth = cropRect.width / scaleX;
  final availableHeight = cropRect.height / scaleY;
  final divisor = _greatestCommonDivisor(targetWidth, targetHeight);
  final ratioWidth = targetWidth ~/ divisor;
  final ratioHeight = targetHeight ~/ divisor;
  final units = math
      .min(availableWidth / ratioWidth, availableHeight / ratioHeight)
      .floor();

  int width;
  int height;
  if (units >= 1) {
    width = units * ratioWidth;
    height = units * ratioHeight;
  } else {
    // Very small sources may be smaller than one reduced target-ratio unit.
    // Keep their pixels intact and let the final resampling set the exact ratio.
    width = imageWidth;
    height = imageHeight;
  }

  final centerX = (cropRect.center.dx - imageRect.left) / scaleX;
  final centerY = (cropRect.center.dy - imageRect.top) / scaleY;
  final x = (centerX - width / 2).round().clamp(0, imageWidth - width);
  final y = (centerY - height / 2).round().clamp(0, imageHeight - height);
  return ui.Rect.fromLTWH(
    x.toDouble(),
    y.toDouble(),
    width.toDouble(),
    height.toDouble(),
  );
}

Future<Uint8List> cropImageToPng({
  required Uint8List sourceBytes,
  required int imageWidth,
  required int imageHeight,
  required ui.Rect cropRect,
  required int targetWidth,
  required int targetHeight,
}) async {
  validateImageCropDimensions(
    imageWidth: imageWidth,
    imageHeight: imageHeight,
    targetWidth: targetWidth,
    targetHeight: targetHeight,
  );
  if (sourceBytes.isEmpty) {
    throw ArgumentError.value(sourceBytes, 'sourceBytes', '图像数据为空');
  }
  _validateRect(cropRect, 'cropRect');
  if (cropRect.isEmpty ||
      cropRect.left < 0 ||
      cropRect.top < 0 ||
      cropRect.right > imageWidth ||
      cropRect.bottom > imageHeight) {
    throw ArgumentError.value(cropRect, 'cropRect', '裁切区域超出图像边界');
  }

  ui.Codec? codec;
  ui.Image? decodedImage;
  ui.Picture? picture;
  ui.Image? outputImage;
  try {
    codec = await ui.instantiateImageCodec(sourceBytes);
    final frame = await codec.getNextFrame();
    decodedImage = frame.image;
    if (decodedImage.width != imageWidth ||
        decodedImage.height != imageHeight) {
      throw ArgumentError(
        '图像实际尺寸为 ${decodedImage.width}×${decodedImage.height}，与传入尺寸不符',
      );
    }

    final recorder = ui.PictureRecorder();
    final canvas = ui.Canvas(recorder);
    final destination = ui.Rect.fromLTWH(
      0,
      0,
      targetWidth.toDouble(),
      targetHeight.toDouble(),
    );
    canvas.drawImageRect(
      decodedImage,
      cropRect,
      destination,
      ui.Paint()..filterQuality = ui.FilterQuality.none,
    );
    picture = recorder.endRecording();
    outputImage = await picture.toImage(targetWidth, targetHeight);
    final encoded = await outputImage.toByteData(
      format: ui.ImageByteFormat.png,
    );
    if (encoded == null) {
      throw StateError('PNG 编码失败');
    }
    return Uint8List.fromList(
      encoded.buffer.asUint8List(encoded.offsetInBytes, encoded.lengthInBytes),
    );
  } finally {
    outputImage?.dispose();
    picture?.dispose();
    decodedImage?.dispose();
    codec?.dispose();
  }
}

void validateImageCropDimensions({
  required int imageWidth,
  required int imageHeight,
  required int targetWidth,
  required int targetHeight,
}) {
  _validateSourceSize(imageWidth, imageHeight);
  _validateTargetSize(targetWidth, targetHeight);
}

void _validateSourceSize(int width, int height) {
  if (width <= 0 ||
      height <= 0 ||
      width > _maxSourceDimension ||
      height > _maxSourceDimension ||
      width * height > _maxSourcePixels) {
    throw ArgumentError('源图尺寸无效或过大');
  }
}

void _validateTargetSize(int width, int height) {
  if (width <= 0 ||
      height <= 0 ||
      width > _maxCropTargetDimension ||
      height > _maxCropTargetDimension ||
      width * height > _maxCropTargetPixels) {
    throw ArgumentError('目标尺寸无效或过大');
  }
}

void _validateRect(ui.Rect rect, String name) {
  if (!rect.left.isFinite ||
      !rect.top.isFinite ||
      !rect.right.isFinite ||
      !rect.bottom.isFinite) {
    throw ArgumentError.value(rect, name, '矩形坐标必须是有限数值');
  }
}

int _greatestCommonDivisor(int a, int b) {
  while (b != 0) {
    final remainder = a % b;
    a = b;
    b = remainder;
  }
  return a.abs();
}

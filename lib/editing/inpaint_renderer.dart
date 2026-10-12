import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui';
import 'dart:ui' as ui;

import 'package:archive/archive.dart' as archive;

import 'inpaint_document.dart';

/// A prepared request patch. Both PNGs share exactly [sourceRect] and output
/// dimensions, so they can be sent as one image/mask pair.
class InpaintPrepared {
  const InpaintPrepared({
    required this.imagePng,
    required this.maskPng,
    required this.sourceRect,
    required this.targetWidth,
    required this.targetHeight,
    this.hasMaskedPixels = true,
  });

  final Uint8List imagePng;
  final Uint8List maskPng;
  final Rect sourceRect;
  final int targetWidth;
  final int targetHeight;
  final bool hasMaskedPixels;
}

/// A generated patch placed in source-image pixel coordinates.
class InpaintLayer {
  InpaintLayer({
    required Uint8List bytes,
    required this.worldRect,
    this.visible = true,
  }) : bytes = Uint8List.fromList(bytes);

  final Uint8List bytes;
  final Rect worldRect;
  final bool visible;

  InpaintLayer copyWith({bool? visible}) => InpaintLayer(
    bytes: bytes,
    worldRect: worldRect,
    visible: visible ?? this.visible,
  );
}

/// An exported composite. Its source-space origin can be negative when a
/// selected region or generated layer extends beyond the original image.
class InpaintComposite {
  const InpaintComposite({
    required this.bytes,
    required this.width,
    required this.height,
    required this.originX,
    required this.originY,
  });

  final Uint8List bytes;
  final int width;
  final int height;
  final int originX;
  final int originY;
}

/// Paints a stroke into a transparent overlay. Erasing uses destination-out,
/// so the source image below the overlay is revealed again.
void paintInpaintStroke(
  ui.Canvas canvas,
  InpaintStroke stroke, {
  bool mask = true,
}) {
  final path = _strokePath(stroke);
  if (path == null) return;
  final alpha =
      (stroke.opacity *
              (mask || stroke.operation == InpaintOperation.erase
                  ? 255
                  : (stroke.color >> 24) & 0xff))
          .round();
  final color = mask
      ? ui.Color.fromARGB(alpha, 255, 255, 255)
      : ui.Color.fromARGB(
          alpha,
          (stroke.color >> 16) & 0xff,
          (stroke.color >> 8) & 0xff,
          stroke.color & 0xff,
        );
  final paint = ui.Paint()
    ..isAntiAlias = true
    ..color = color
    ..style = ui.PaintingStyle.fill
    ..blendMode = stroke.operation == InpaintOperation.erase
        ? ui.BlendMode.dstOut
        : ui.BlendMode.srcOver;
  canvas.drawPath(path, paint);
}

/// Raster operations for the local inpaint workspace. Image bytes are decoded
/// and encoded in memory through `dart:ui`; this class never reads a path.
class InpaintRenderer {
  const InpaintRenderer();

  static const int maxRasterPixels = 32 * 1024 * 1024;

  /// Draws the current white mask as a translucent red overlay on the source.
  Future<Uint8List> renderMaskPreview(
    Uint8List sourceBytes,
    InpaintDocument document, {
    Uint8List? importedMaskBytes,
    int overlayColor = 0xffff4d4f,
  }) async {
    final source = await _decodeImage(sourceBytes);
    try {
      _checkSourceSize(source, document);
      final sourceRaw = await _rawPixels(source);
      final mask = await _buildMaskPixels(
        document,
        sourcePixels: sourceRaw,
        importedMaskBytes: importedMaskBytes,
      );
      final count = document.sourceWidth * document.sourceHeight;
      final overlay = Uint8List(count * 4);
      final colorAlpha = (overlayColor >> 24) & 0xff;
      final red = (overlayColor >> 16) & 0xff;
      final green = (overlayColor >> 8) & 0xff;
      final blue = overlayColor & 0xff;
      for (var i = 0; i < count; i++) {
        final offset = i * 4;
        overlay[offset] = red;
        overlay[offset + 1] = green;
        overlay[offset + 2] = blue;
        overlay[offset + 3] =
            (mask[offset] * document.previewOpacity * colorAlpha / 255).round();
      }
      final overlayImage = await _imageFromRgba(
        overlay,
        document.sourceWidth,
        document.sourceHeight,
      );
      try {
        return await _drawPng(document.sourceWidth, document.sourceHeight, (
          canvas,
        ) {
          canvas.drawImage(source, ui.Offset.zero, ui.Paint());
          canvas.drawImage(overlayImage, ui.Offset.zero, ui.Paint());
        });
      } finally {
        overlayImage.dispose();
      }
    } finally {
      source.dispose();
    }
  }

  /// Encodes the editable mask as an opaque black-background, white-selected
  /// PNG at source dimensions. Imported grayscale masks and stroke opacity are
  /// preserved as grayscale coverage.
  Future<Uint8List> renderOutputMask(
    InpaintDocument document, {
    Uint8List? importedMaskBytes,
    Uint8List? sourceBytes,
  }) async {
    Uint8List? sourceRaw;
    ui.Image? source;
    if (sourceBytes != null) {
      source = await _decodeImage(sourceBytes);
    }
    try {
      if (source != null) {
        _checkSourceSize(source, document);
        sourceRaw = await _rawPixels(source);
      }
      final mask = await _buildMaskPixels(
        document,
        sourcePixels: sourceRaw,
        importedMaskBytes: importedMaskBytes,
      );
      return await _encodeRgbaPng(
        mask,
        document.sourceWidth,
        document.sourceHeight,
      );
    } finally {
      source?.dispose();
    }
  }

  /// Returns the source with image-target paint strokes applied. Erasers blend
  /// back toward the immutable source pixels, including transparent pixels.
  Future<Uint8List> renderImageLayer(
    Uint8List sourceBytes,
    InpaintDocument document,
  ) async {
    final source = await _decodeImage(sourceBytes);
    try {
      _checkSourceSize(source, document);
      final original = await _rawPixels(source);
      final width = document.sourceWidth;
      final height = document.sourceHeight;
      final output = await _imagePixelsAfterStrokes(original, document);
      return await _encodeRgbaPng(output, width, height);
    } finally {
      source.dispose();
    }
  }

  /// Crops a source-pixel rectangle and resamples it to request dimensions.
  /// Areas beyond the source image remain transparent.
  Future<Uint8List> prepareRegionInput(
    Uint8List sourceBytes,
    Rect sourceRect, {
    required int targetWidth,
    required int targetHeight,
  }) async {
    _validateRect(sourceRect, 'sourceRect');
    _validateDimensions(targetWidth, targetHeight);
    final source = await _decodeImage(sourceBytes);
    try {
      return await _renderRegionPng(
        source,
        sourceRect,
        targetWidth,
        targetHeight,
      );
    } finally {
      source.dispose();
    }
  }

  /// Builds a same-frame image/mask request. The image target strokes are
  /// included in the input image, the mask is nearest-neighbor resampled, and
  /// [InpaintDocument.expandPixels] is dilated in output-pixel coordinates.
  Future<InpaintPrepared> prepareRequest({
    required Uint8List sourceBytes,
    required InpaintDocument document,
    required int targetWidth,
    required int targetHeight,
    Uint8List? importedMaskBytes,
  }) async {
    _validateDimensions(targetWidth, targetHeight);
    final rect = document.effectiveSourceRect;
    final source = await _decodeImage(sourceBytes);
    try {
      _checkSourceSize(source, document);
      final sourceRaw = await _rawPixels(source);
      final imageRaw = await _imagePixelsAfterStrokes(sourceRaw, document);
      final image = await _imageFromRgba(
        imageRaw,
        document.sourceWidth,
        document.sourceHeight,
      );
      try {
        final imagePng = await _renderRegionPng(
          image,
          rect,
          targetWidth,
          targetHeight,
        );
        final maskPixels = await _buildMaskPixels(
          document,
          sourcePixels: sourceRaw,
          importedMaskBytes: importedMaskBytes,
        );
        final regionMask = _sampleMaskRegion(
          maskPixels,
          document.sourceWidth,
          document.sourceHeight,
          rect,
          targetWidth,
          targetHeight,
        );
        _dilateMask(
          regionMask,
          targetWidth,
          targetHeight,
          document.expandPixels,
        );
        _alignMaskToLatentGrid(regionMask, targetWidth, targetHeight);
        final hasMaskedPixels = regionMask.any((value) => value > 0);
        final maskPng = await _encodeGrayMaskPng(
          regionMask,
          targetWidth,
          targetHeight,
        );
        return InpaintPrepared(
          imagePng: imagePng,
          maskPng: maskPng,
          sourceRect: rect,
          targetWidth: targetWidth,
          targetHeight: targetHeight,
          hasMaskedPixels: hasMaskedPixels,
        );
      } finally {
        image.dispose();
      }
    } finally {
      source.dispose();
    }
  }

  /// Applies a generated patch to the original source through its editable
  /// mask and returns bounds/origin metadata if the patch extends the canvas.
  Future<InpaintComposite> reinsertCandidate({
    required Uint8List sourceBytes,
    required Uint8List candidateBytes,
    required InpaintDocument document,
    Uint8List? importedMaskBytes,
  }) async {
    final source = await _decodeImage(sourceBytes);
    try {
      _checkSourceSize(source, document);
      final sourceRaw = await _rawPixels(source);
      final maskPixels = await _buildMaskPixels(
        document,
        sourcePixels: sourceRaw,
        importedMaskBytes: importedMaskBytes,
      );
      final rect = document.effectiveSourceRect;
      final candidate = await _decodeImage(candidateBytes);
      try {
        final mask = _sampleMaskRegion(
          maskPixels,
          document.sourceWidth,
          document.sourceHeight,
          rect,
          candidate.width,
          candidate.height,
        );
        _dilateMask(
          mask,
          candidate.width,
          candidate.height,
          document.expandPixels,
        );
        _alignMaskToLatentGrid(mask, candidate.width, candidate.height);
        final maskPng = await _encodeGrayMaskPng(
          mask,
          candidate.width,
          candidate.height,
        );
        final layerBytes = await maskGeneratedLayer(
          generatedBytes: candidateBytes,
          maskBytes: maskPng,
          outwardFeatherPixels: document.featherPixels,
        );
        return await composeLayers(
          sourceBytes: sourceBytes,
          document: document,
          layers: [InpaintLayer(bytes: layerBytes, worldRect: rect)],
        );
      } finally {
        candidate.dispose();
      }
    } finally {
      source.dispose();
    }
  }

  /// Composites visible, already-transparent generated layers over the source.
  /// Image-target paint strokes are first applied to the source base.
  Future<InpaintComposite> composeLayers({
    required Uint8List sourceBytes,
    required InpaintDocument document,
    required List<InpaintLayer> layers,
  }) async {
    final source = await _decodeImage(sourceBytes);
    try {
      _checkSourceSize(source, document);
      final visibleLayers = layers.where((layer) => layer.visible).toList();
      var left = 0;
      var top = 0;
      var right = document.sourceWidth;
      var bottom = document.sourceHeight;
      final decodedLayers = <ui.Image>[];
      try {
        for (final layer in visibleLayers) {
          _validateRect(layer.worldRect, 'layer.worldRect');
          final image = await _decodeImage(layer.bytes);
          decodedLayers.add(image);
          left = math.min(left, layer.worldRect.left.floor());
          top = math.min(top, layer.worldRect.top.floor());
          right = math.max(right, layer.worldRect.right.ceil());
          bottom = math.max(bottom, layer.worldRect.bottom.ceil());
        }
        final outputWidth = right - left;
        final outputHeight = bottom - top;
        _validateDimensions(outputWidth, outputHeight);
        final output = Uint8List(outputWidth * outputHeight * 4);
        final imageBase = await _imagePixelsAfterStrokes(
          await _rawPixels(source),
          document,
        );
        for (var y = 0; y < document.sourceHeight; y++) {
          final sourceOffset = y * document.sourceWidth * 4;
          final outputOffset = ((y - top) * outputWidth - left) * 4;
          output.setRange(
            outputOffset,
            outputOffset + document.sourceWidth * 4,
            imageBase,
            sourceOffset,
          );
        }

        if (visibleLayers.isNotEmpty) {
          for (
            var layerIndex = 0;
            layerIndex < visibleLayers.length;
            layerIndex++
          ) {
            final layer = visibleLayers[layerIndex];
            final image = decodedLayers[layerIndex];
            final layerRaw = await _rawPixels(image);
            _compositeLayer(
              output: output,
              outputWidth: outputWidth,
              outputHeight: outputHeight,
              originX: left,
              originY: top,
              sourcePixels: layerRaw,
              sourceWidth: image.width,
              sourceHeight: image.height,
              worldRect: layer.worldRect,
            );
          }
        }
        final png = await _encodeRgbaPng(output, outputWidth, outputHeight);
        return InpaintComposite(
          bytes: png,
          width: outputWidth,
          height: outputHeight,
          originX: left,
          originY: top,
        );
      } finally {
        for (final image in decodedLayers) {
          image.dispose();
        }
      }
    } finally {
      source.dispose();
    }
  }

  /// Resamples a generated image to its mask dimensions, applies the mask's
  /// grayscale coverage and outward feather, and returns a transparent PNG.
  Future<Uint8List> maskGeneratedLayer({
    required Uint8List generatedBytes,
    required Uint8List maskBytes,
    int outwardFeatherPixels = 8,
  }) async {
    if (outwardFeatherPixels < 0 || outwardFeatherPixels > 32) {
      throw ArgumentError.value(
        outwardFeatherPixels,
        'outwardFeatherPixels',
        'must be between 0 and 32',
      );
    }
    final generated = await _decodeImage(generatedBytes);
    ui.Image? maskImage;
    try {
      maskImage = await _decodeImage(maskBytes);
      final width = maskImage.width;
      final height = maskImage.height;
      final generatedRegion = await _renderRegionPng(
        generated,
        Rect.fromLTWH(
          0,
          0,
          generated.width.toDouble(),
          generated.height.toDouble(),
        ),
        width,
        height,
      );
      final resized = await _decodeImage(generatedRegion);
      try {
        final generatedPixels = await _rawPixels(resized);
        final maskPixels = await _rawPixels(maskImage);
        final count = width * height;
        final coverage = Uint8List(count);
        for (var i = 0; i < count; i++) {
          final offset = i * 4;
          final luma =
              (maskPixels[offset] * 2126 +
                  maskPixels[offset + 1] * 7152 +
                  maskPixels[offset + 2] * 722 +
                  5000) ~/
              10000;
          coverage[i] = (luma * maskPixels[offset + 3] + 127) ~/ 255;
        }
        final alpha = _featherMask(
          coverage,
          width,
          height,
          outwardFeatherPixels,
        );
        for (var i = 0; i < count; i++) {
          final offset = i * 4;
          generatedPixels[offset + 3] =
              (generatedPixels[offset + 3] * alpha[i] + 127) ~/ 255;
        }
        return await _encodeRgbaPng(generatedPixels, width, height);
      } finally {
        resized.dispose();
      }
    } finally {
      generated.dispose();
      maskImage?.dispose();
    }
  }

  /// Scales 2x or 3x by nearest neighbor, preserving each source pixel as a
  /// solid block for pixel art and mask-like images.
  Future<Uint8List> scalePixelArt(
    Uint8List sourceBytes, {
    required int factor,
  }) async {
    if (factor != 2 && factor != 3) {
      throw ArgumentError.value(factor, 'factor', 'must be 2 or 3');
    }
    final source = await _decodeImage(sourceBytes);
    try {
      final width = source.width * factor;
      final height = source.height * factor;
      _validateDimensions(width, height);
      final input = await _rawPixels(source);
      final output = Uint8List(width * height * 4);
      for (var y = 0; y < height; y++) {
        final inputY = y ~/ factor;
        for (var x = 0; x < width; x++) {
          final sourceOffset = (inputY * source.width + x ~/ factor) * 4;
          final targetOffset = (y * width + x) * 4;
          output.setRange(targetOffset, targetOffset + 4, input, sourceOffset);
        }
      }
      return await _encodeRgbaPng(output, width, height);
    } finally {
      source.dispose();
    }
  }

  Future<Uint8List> _imagePixelsAfterStrokes(
    Uint8List sourcePixels,
    InpaintDocument document,
  ) async {
    final output = Uint8List.fromList(sourcePixels);
    final original = sourcePixels;
    final width = document.sourceWidth;
    final height = document.sourceHeight;
    for (final stroke in document.strokes) {
      if (stroke.target != InpaintTarget.image) continue;
      final coverage = await _strokeCoverage(stroke, width, height);
      for (var i = 0; i < width * height; i++) {
        final coverageAlpha = coverage[i * 4 + 3];
        if (coverageAlpha == 0 || stroke.opacity == 0) continue;
        final weight = coverageAlpha / 255 * stroke.opacity;
        final offset = i * 4;
        if (stroke.operation == InpaintOperation.erase) {
          _blendToward(output, original, offset, weight);
        } else {
          final color = [
            (stroke.color >> 16) & 0xff,
            (stroke.color >> 8) & 0xff,
            stroke.color & 0xff,
            ((stroke.color >> 24) & 0xff) / 255,
          ];
          _blendSourceOver(output, offset, color, weight);
        }
      }
    }
    return output;
  }

  Future<Uint8List> _buildMaskPixels(
    InpaintDocument document, {
    Uint8List? sourcePixels,
    Uint8List? importedMaskBytes,
  }) async {
    final width = document.sourceWidth;
    final height = document.sourceHeight;
    final count = width * height;
    final mask = Uint8List(count * 4);
    for (var i = 0; i < count; i++) {
      mask[i * 4 + 3] = 255;
    }
    if (importedMaskBytes != null) {
      final imported = await _decodeImage(importedMaskBytes);
      try {
        if (imported.width != width || imported.height != height) {
          throw ArgumentError(
            'Imported mask must be aligned to source pixels '
            '($width x $height), got ${imported.width} x ${imported.height}',
          );
        }
        final pixels = await _rawPixels(imported);
        for (var i = 0; i < count; i++) {
          final offset = i * 4;
          final luma =
              (pixels[offset] * 2126 +
                  pixels[offset + 1] * 7152 +
                  pixels[offset + 2] * 722 +
                  5000) ~/
              10000;
          mask[offset] = (luma * pixels[offset + 3] + 127) ~/ 255;
        }
      } finally {
        imported.dispose();
      }
    }
    if (sourcePixels != null) {
      if (sourcePixels.length != count * 4) {
        throw ArgumentError('Source pixel buffer does not match the document');
      }
      for (var i = 0; i < count; i++) {
        final offset = i * 4;
        final transparency = 255 - sourcePixels[offset + 3];
        if (transparency > mask[offset]) mask[offset] = transparency;
      }
    }
    for (final stroke in document.strokes) {
      if (stroke.target != InpaintTarget.mask) continue;
      final coverage = await _strokeCoverage(stroke, width, height);
      final target = stroke.operation == InpaintOperation.paint ? 255 : 0;
      for (var i = 0; i < count; i++) {
        final offset = i * 4;
        final weight = coverage[offset + 3] / 255 * stroke.opacity;
        if (weight == 0) continue;
        mask[offset] = (mask[offset] + (target - mask[offset]) * weight)
            .round()
            .clamp(0, 255);
      }
    }
    for (var i = 0; i < count; i++) {
      final offset = i * 4;
      final value = mask[offset];
      mask[offset + 1] = value;
      mask[offset + 2] = value;
    }
    return mask;
  }

  Future<Uint8List> _strokeCoverage(
    InpaintStroke stroke,
    int width,
    int height,
  ) async {
    final path = _strokePath(stroke);
    if (path == null) return Uint8List(width * height * 4);
    final image = await _rasterize(width, height, (canvas) {
      canvas.drawPath(
        path,
        ui.Paint()
          ..isAntiAlias = true
          ..color = const ui.Color(0xffffffff),
      );
    });
    try {
      return await _rawPixels(image);
    } finally {
      image.dispose();
    }
  }

  Future<Uint8List> _renderRegionPng(
    ui.Image source,
    Rect sourceRect,
    int targetWidth,
    int targetHeight,
  ) async {
    _validateRect(sourceRect, 'sourceRect');
    _validateDimensions(targetWidth, targetHeight);
    final sourceBounds = Rect.fromLTWH(
      0,
      0,
      source.width.toDouble(),
      source.height.toDouble(),
    );
    final overlap = sourceRect.intersect(sourceBounds);
    final output = await _rasterize(targetWidth, targetHeight, (canvas) {
      canvas.drawColor(const ui.Color(0x00000000), ui.BlendMode.src);
      if (overlap.isEmpty) return;
      final destination = Rect.fromLTRB(
        (overlap.left - sourceRect.left) / sourceRect.width * targetWidth,
        (overlap.top - sourceRect.top) / sourceRect.height * targetHeight,
        (overlap.right - sourceRect.left) / sourceRect.width * targetWidth,
        (overlap.bottom - sourceRect.top) / sourceRect.height * targetHeight,
      );
      canvas.drawImageRect(
        source,
        overlap,
        destination,
        ui.Paint()
          ..filterQuality = ui.FilterQuality.medium
          ..isAntiAlias = true,
      );
    });
    try {
      return await _encodeImagePng(output);
    } finally {
      output.dispose();
    }
  }

  Uint8List _sampleMaskRegion(
    Uint8List sourceMask,
    int sourceWidth,
    int sourceHeight,
    Rect rect,
    int targetWidth,
    int targetHeight,
  ) {
    final output = Uint8List(targetWidth * targetHeight);
    for (var y = 0; y < targetHeight; y++) {
      final sourceY = rect.top + (y + 0.5) * rect.height / targetHeight;
      final sy = sourceY.floor();
      for (var x = 0; x < targetWidth; x++) {
        final sourceX = rect.left + (x + 0.5) * rect.width / targetWidth;
        final sx = sourceX.floor();
        final index = y * targetWidth + x;
        if (sx < 0 || sy < 0 || sx >= sourceWidth || sy >= sourceHeight) {
          output[index] = 255;
        } else {
          output[index] = sourceMask[(sy * sourceWidth + sx) * 4];
        }
      }
    }
    return output;
  }

  void _dilateMask(List<int> mask, int width, int height, int radius) {
    if (radius == 0 || mask.isEmpty) return;
    final distances = _squaredDistances(mask, width, height);
    final limit = radius * radius;
    for (var i = 0; i < mask.length; i++) {
      if (distances[i] <= limit) mask[i] = 255;
    }
  }

  void _alignMaskToLatentGrid(List<int> mask, int width, int height) {
    const cellSize = 8;
    for (var top = 0; top < height; top += cellSize) {
      for (var left = 0; left < width; left += cellSize) {
        final bottom = math.min(height, top + cellSize);
        final right = math.min(width, left + cellSize);
        var selected = false;
        for (var y = top; y < bottom && !selected; y++) {
          for (var x = left; x < right; x++) {
            if (mask[y * width + x] >= 128) {
              selected = true;
              break;
            }
          }
        }
        final value = selected ? 255 : 0;
        for (var y = top; y < bottom; y++) {
          for (var x = left; x < right; x++) {
            mask[y * width + x] = value;
          }
        }
      }
    }
  }

  Uint8List _featherMask(List<int> mask, int width, int height, int radius) {
    final result = Uint8List(mask.length);
    if (radius == 0) {
      for (var i = 0; i < mask.length; i++) {
        result[i] = mask[i];
      }
      return result;
    }
    if (!mask.any((value) => value > 0)) return result;
    final distances = _squaredDistances(mask, width, height);
    for (var i = 0; i < mask.length; i++) {
      if (mask[i] > 0) {
        result[i] = mask[i];
        continue;
      }
      final distance = math.sqrt(distances[i]).round();
      if (distance <= radius) {
        result[i] = ((1 - distance / radius) * 255).round();
      }
    }
    return result;
  }

  Float64List _squaredDistances(List<int> mask, int width, int height) {
    final distances = Float64List(width * height);
    final unreachable = (width * width + height * height + 1).toDouble();
    var hasSelectedPixel = false;
    for (var y = 0; y < height; y++) {
      var nearest = -width;
      final row = y * width;
      for (var x = 0; x < width; x++) {
        if (mask[row + x] > 0) {
          nearest = x;
          hasSelectedPixel = true;
        }
        distances[row + x] = nearest < 0
            ? unreachable
            : ((x - nearest) * (x - nearest)).toDouble();
      }
      nearest = width * 2;
      for (var x = width - 1; x >= 0; x--) {
        if (mask[row + x] > 0) nearest = x;
        if (nearest < width) {
          distances[row + x] = math.min(
            distances[row + x],
            ((nearest - x) * (nearest - x)).toDouble(),
          );
        }
      }
    }
    if (!hasSelectedPixel) {
      distances.fillRange(0, distances.length, double.infinity);
      return distances;
    }
    final values = Float64List(height);
    final sites = Int32List(height);
    final boundaries = Float64List(height + 1);
    for (var x = 0; x < width; x++) {
      for (var y = 0; y < height; y++) {
        values[y] = distances[y * width + x];
      }
      var last = 0;
      sites[0] = 0;
      boundaries[0] = double.negativeInfinity;
      boundaries[1] = double.infinity;
      for (var y = 1; y < height; y++) {
        double crossing;
        while (true) {
          final previous = sites[last];
          crossing =
              ((values[y] + y * y) - (values[previous] + previous * previous)) /
              (2 * (y - previous));
          if (crossing > boundaries[last]) break;
          last--;
        }
        sites[++last] = y;
        boundaries[last] = crossing;
        boundaries[last + 1] = double.infinity;
      }
      var active = 0;
      for (var y = 0; y < height; y++) {
        while (boundaries[active + 1] < y) {
          active++;
        }
        final delta = y - sites[active];
        distances[y * width + x] = delta * delta + values[sites[active]];
      }
    }
    return distances;
  }

  void _compositeLayer({
    required Uint8List output,
    required int outputWidth,
    required int outputHeight,
    required int originX,
    required int originY,
    required Uint8List sourcePixels,
    required int sourceWidth,
    required int sourceHeight,
    required Rect worldRect,
  }) {
    for (var y = 0; y < outputHeight; y++) {
      final worldY = originY + y + 0.5;
      if (worldY < worldRect.top || worldY >= worldRect.bottom) continue;
      final sourceY =
          (worldY - worldRect.top) / worldRect.height * sourceHeight - 0.5;
      for (var x = 0; x < outputWidth; x++) {
        final worldX = originX + x + 0.5;
        if (worldX < worldRect.left || worldX >= worldRect.right) continue;
        final sourceX =
            (worldX - worldRect.left) / worldRect.width * sourceWidth - 0.5;
        final color = _sampleBilinear(
          sourcePixels,
          sourceWidth,
          sourceHeight,
          sourceX,
          sourceY,
        );
        if (color[3] == 0) continue;
        final targetOffset = ((y * outputWidth + x) * 4);
        _blendSourceOver(output, targetOffset, color, 1);
      }
    }
  }

  List<double> _sampleBilinear(
    Uint8List pixels,
    int width,
    int height,
    double x,
    double y,
  ) {
    final rawX0 = x.floor();
    final rawY0 = y.floor();
    final x0 = rawX0.clamp(0, width - 1);
    final y0 = rawY0.clamp(0, height - 1);
    final x1 = (rawX0 + 1).clamp(0, width - 1);
    final y1 = (rawY0 + 1).clamp(0, height - 1);
    final tx = (x - rawX0).clamp(0, 1);
    final ty = (y - rawY0).clamp(0, 1);
    final weights = [
      (1 - tx) * (1 - ty),
      tx * (1 - ty),
      (1 - tx) * ty,
      tx * ty,
    ];
    final offsets = [
      y0 * width + x0,
      y0 * width + x1,
      y1 * width + x0,
      y1 * width + x1,
    ];
    var alpha = 0.0;
    final premultiplied = [0.0, 0.0, 0.0];
    for (var i = 0; i < 4; i++) {
      final offset = offsets[i] * 4;
      final pixelAlpha = pixels[offset + 3] / 255;
      final weight = weights[i];
      alpha += pixelAlpha * weight;
      for (var channel = 0; channel < 3; channel++) {
        premultiplied[channel] +=
            pixels[offset + channel] / 255 * pixelAlpha * weight;
      }
    }
    if (alpha == 0) return [0, 0, 0, 0];
    return [
      premultiplied[0] / alpha * 255,
      premultiplied[1] / alpha * 255,
      premultiplied[2] / alpha * 255,
      alpha,
    ];
  }

  void _blendToward(
    Uint8List destination,
    Uint8List target,
    int offset,
    double weight,
  ) {
    weight = weight.clamp(0, 1);
    if (weight == 0) return;
    final destinationAlpha = destination[offset + 3] / 255;
    final targetAlpha = target[offset + 3] / 255;
    final alpha = destinationAlpha * (1 - weight) + targetAlpha * weight;
    for (var channel = 0; channel < 3; channel++) {
      final premultiplied =
          destination[offset + channel] /
              255 *
              destinationAlpha *
              (1 - weight) +
          target[offset + channel] / 255 * targetAlpha * weight;
      destination[offset + channel] = alpha == 0
          ? 0
          : (premultiplied / alpha * 255).round().clamp(0, 255);
    }
    destination[offset + 3] = (alpha * 255).round().clamp(0, 255);
  }

  void _blendSourceOver(
    Uint8List destination,
    int offset,
    List<num> source,
    double weight,
  ) {
    final sourceAlpha = (source[3].toDouble() * weight).clamp(0, 1);
    if (sourceAlpha == 0) return;
    final destinationAlpha = destination[offset + 3] / 255;
    final outputAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
    for (var channel = 0; channel < 3; channel++) {
      final sourceValue = source[channel].toDouble() / 255;
      final destinationValue = destination[offset + channel] / 255;
      final premultiplied =
          sourceValue * sourceAlpha +
          destinationValue * destinationAlpha * (1 - sourceAlpha);
      destination[offset + channel] = outputAlpha == 0
          ? 0
          : (premultiplied / outputAlpha * 255).round().clamp(0, 255);
    }
    destination[offset + 3] = (outputAlpha * 255).round().clamp(0, 255);
  }

  Future<ui.Image> _decodeImage(Uint8List bytes) async {
    final codec = await ui.instantiateImageCodec(bytes);
    try {
      final frame = await codec.getNextFrame();
      try {
        _validateDimensions(frame.image.width, frame.image.height);
        return frame.image;
      } catch (_) {
        frame.image.dispose();
        rethrow;
      }
    } finally {
      codec.dispose();
    }
  }

  Future<Uint8List> _rawPixels(ui.Image image) async {
    _validateDimensions(image.width, image.height);
    final data = await image.toByteData(
      format: ui.ImageByteFormat.rawStraightRgba,
    );
    if (data == null) throw StateError('Could not read decoded image pixels');
    return Uint8List.view(data.buffer, data.offsetInBytes, data.lengthInBytes);
  }

  Future<ui.Image> _imageFromRgba(
    Uint8List pixels,
    int width,
    int height,
  ) async {
    _validateDimensions(width, height);
    if (pixels.length != width * height * 4) {
      throw ArgumentError('RGBA buffer length does not match dimensions');
    }
    // PixelFormat.rgba8888 requires premultiplied channels, while all renderer
    // calculations and rawStraightRgba reads use straight alpha.
    final premultiplied = Uint8List.fromList(pixels);
    for (var offset = 0; offset < premultiplied.length; offset += 4) {
      final alpha = premultiplied[offset + 3];
      premultiplied[offset] = (premultiplied[offset] * alpha + 127) ~/ 255;
      premultiplied[offset + 1] =
          (premultiplied[offset + 1] * alpha + 127) ~/ 255;
      premultiplied[offset + 2] =
          (premultiplied[offset + 2] * alpha + 127) ~/ 255;
    }
    final buffer = await ui.ImmutableBuffer.fromUint8List(premultiplied);
    try {
      final descriptor = ui.ImageDescriptor.raw(
        buffer,
        width: width,
        height: height,
        pixelFormat: ui.PixelFormat.rgba8888,
      );
      try {
        final codec = await descriptor.instantiateCodec();
        try {
          final frame = await codec.getNextFrame();
          return frame.image;
        } finally {
          codec.dispose();
        }
      } finally {
        descriptor.dispose();
      }
    } finally {
      buffer.dispose();
    }
  }

  Future<ui.Image> _rasterize(
    int width,
    int height,
    void Function(ui.Canvas canvas) paint,
  ) async {
    _validateDimensions(width, height);
    final recorder = ui.PictureRecorder();
    final canvas = ui.Canvas(
      recorder,
      Rect.fromLTWH(0, 0, width.toDouble(), height.toDouble()),
    );
    paint(canvas);
    final picture = recorder.endRecording();
    try {
      return await picture.toImage(width, height);
    } finally {
      picture.dispose();
    }
  }

  Future<Uint8List> _drawPng(
    int width,
    int height,
    void Function(ui.Canvas canvas) paint,
  ) async {
    final image = await _rasterize(width, height, paint);
    try {
      return await _encodeImagePng(image);
    } finally {
      image.dispose();
    }
  }

  Future<Uint8List> _encodeImagePng(ui.Image image) async {
    final data = await image.toByteData(format: ui.ImageByteFormat.png);
    if (data == null) throw StateError('Could not encode PNG');
    return Uint8List.view(data.buffer, data.offsetInBytes, data.lengthInBytes);
  }

  Future<Uint8List> _encodeRgbaPng(
    Uint8List pixels,
    int width,
    int height,
  ) async {
    final image = await _imageFromRgba(pixels, width, height);
    try {
      return await _encodeImagePng(image);
    } finally {
      image.dispose();
    }
  }

  Future<Uint8List> _encodeGrayMaskPng(
    Uint8List mask,
    int width,
    int height,
  ) async {
    _validateDimensions(width, height);
    if (mask.length != width * height) {
      throw ArgumentError('Mask buffer length does not match dimensions');
    }
    // PNG filter type 0 keeps the grayscale row data byte-exact. A genuine
    // color-type-0 PNG matches NovelAI's single-channel mask contract.
    final scanlines = Uint8List(height * (width + 1));
    for (var y = 0; y < height; y++) {
      final row = y * (width + 1);
      scanlines[row] = 0;
      scanlines.setRange(row + 1, row + width + 1, mask, y * width);
    }
    final compressed = archive.ZLibEncoder().encodeBytes(scanlines);
    final header = Uint8List(13);
    final headerData = ByteData.sublistView(header);
    headerData.setUint32(0, width, Endian.big);
    headerData.setUint32(4, height, Endian.big);
    header[8] = 8; // bit depth
    header[9] = 0; // grayscale, one channel
    header[10] = 0; // compression method
    header[11] = 0; // filter method
    header[12] = 0; // no interlace
    final output = BytesBuilder(copy: false)
      ..add(const [137, 80, 78, 71, 13, 10, 26, 10])
      ..add(_pngChunk('IHDR', header))
      ..add(_pngChunk('IDAT', compressed))
      ..add(_pngChunk('IEND', Uint8List(0)));
    return output.takeBytes();
  }

  void _checkSourceSize(ui.Image image, InpaintDocument document) {
    if (image.width != document.sourceWidth ||
        image.height != document.sourceHeight) {
      throw ArgumentError(
        'Source image is ${image.width} x ${image.height}; document expects '
        '${document.sourceWidth} x ${document.sourceHeight}',
      );
    }
  }

  void _validateDimensions(int width, int height) {
    if (width <= 0 || height <= 0) {
      throw ArgumentError('Image dimensions must be positive');
    }
    if (width > maxRasterPixels ~/ height) {
      throw ArgumentError(
        'Raster request exceeds the $maxRasterPixels pixel processing limit',
      );
    }
  }

  void _validateRect(Rect rect, String name) {
    if (!rect.left.isFinite ||
        !rect.top.isFinite ||
        !rect.right.isFinite ||
        !rect.bottom.isFinite ||
        rect.width <= 0 ||
        rect.height <= 0) {
      throw ArgumentError.value(
        rect,
        name,
        'must have finite positive dimensions',
      );
    }
  }
}

Path? _strokePath(InpaintStroke stroke) {
  if (stroke.geometry == InpaintGeometry.rectangle) {
    final rect =
        stroke.rectangle ??
        (stroke.points.length >= 2
            ? Rect.fromPoints(stroke.points.first, stroke.points.last)
            : null);
    if (rect == null || rect.isEmpty) return null;
    return Path()..addRect(rect);
  }
  if (stroke.points.isEmpty) return null;
  final half = stroke.size / 2;
  final shape = Path()..fillType = PathFillType.nonZero;
  for (final point in stroke.points) {
    if (stroke.brushShape == InpaintBrushShape.round) {
      shape.addOval(Rect.fromCircle(center: point, radius: half));
    } else {
      shape.addRect(
        Rect.fromCenter(center: point, width: stroke.size, height: stroke.size),
      );
    }
  }
  for (var i = 1; i < stroke.points.length; i++) {
    final from = stroke.points[i - 1];
    final to = stroke.points[i];
    final dx = to.dx - from.dx;
    final dy = to.dy - from.dy;
    final length = math.sqrt(dx * dx + dy * dy);
    if (length == 0) continue;
    final nx = -dy / length * half;
    final ny = dx / length * half;
    shape
      // Match the clockwise winding of the round/square brush stamps. With
      // non-zero fill, opposite winding would cancel at their overlaps.
      ..moveTo(from.dx - nx, from.dy - ny)
      ..lineTo(to.dx - nx, to.dy - ny)
      ..lineTo(to.dx + nx, to.dy + ny)
      ..lineTo(from.dx + nx, from.dy + ny)
      ..close();
  }
  return shape;
}

Uint8List _pngChunk(String type, Uint8List payload) {
  final typeBytes = Uint8List.fromList(type.codeUnits);
  final crcInput = Uint8List(typeBytes.length + payload.length)
    ..setRange(0, typeBytes.length, typeBytes)
    ..setRange(typeBytes.length, typeBytes.length + payload.length, payload);
  final output = Uint8List(12 + payload.length);
  final data = ByteData.sublistView(output);
  data.setUint32(0, payload.length, Endian.big);
  output.setRange(4, 8, typeBytes);
  output.setRange(8, 8 + payload.length, payload);
  data.setUint32(8 + payload.length, archive.getCrc32(crcInput), Endian.big);
  return output;
}

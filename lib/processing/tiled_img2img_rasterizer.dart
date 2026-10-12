import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'tiled_img2img_layout.dart';

const int _maximumDecodedDimension = 8192;
const int _maximumDecodedPixels = 32 * 1000 * 1000;
const int _maximumEncodedBytes = 64 * 1024 * 1024;

/// Decodes one immutable source and accumulates returned tiles into its output.
class TiledImg2ImgRasterizer {
  const TiledImg2ImgRasterizer();

  Future<TiledImg2ImgRasterSession> openSession(
    Uint8List sourceBytes,
    TiledImg2ImgPlan plan,
  ) async {
    final source = await _decodeRgba(sourceBytes);
    if (source.width != plan.sourceWidth ||
        source.height != plan.sourceHeight) {
      throw ArgumentError(
        'Source image dimensions do not match the tiled img2img plan.',
      );
    }
    return TiledImg2ImgRasterSession._(source, plan);
  }
}

class TiledImg2ImgRasterSession {
  TiledImg2ImgRasterSession._(this._source, this.plan)
    : _red = Float32List(plan.outputWidth * plan.outputHeight),
      _green = Float32List(plan.outputWidth * plan.outputHeight),
      _blue = Float32List(plan.outputWidth * plan.outputHeight),
      _weights = Float32List(plan.outputWidth * plan.outputHeight),
      _addedTiles = List<bool>.filled(plan.tiles.length, false);

  final TiledImg2ImgPlan plan;
  final _RgbaImage _source;
  final Float32List _red;
  final Float32List _green;
  final Float32List _blue;
  final Float32List _weights;
  final List<bool> _addedTiles;
  bool _finished = false;

  /// Crops a 640 by 640 source patch and replicates the nearest edge pixel.
  Future<Uint8List> encodeTile(Img2ImgTile tile) async {
    _checkTile(tile);
    _ensureOpen();
    final pixels = Uint8List(
      TiledImg2ImgConfig.tileSize * TiledImg2ImgConfig.tileSize * 4,
    );
    for (var y = 0; y < TiledImg2ImgConfig.tileSize; y++) {
      final sourceY = (tile.cropY + y).clamp(0, _source.height - 1).toInt();
      final sourceRow = sourceY * _source.width;
      final targetRow = y * TiledImg2ImgConfig.tileSize;
      for (var x = 0; x < TiledImg2ImgConfig.tileSize; x++) {
        final sourceX = (tile.cropX + x).clamp(0, _source.width - 1).toInt();
        final sourceOffset = (sourceRow + sourceX) * 4;
        final targetOffset = (targetRow + x) * 4;
        pixels[targetOffset] = _source.pixels[sourceOffset];
        pixels[targetOffset + 1] = _source.pixels[sourceOffset + 1];
        pixels[targetOffset + 2] = _source.pixels[sourceOffset + 2];
        // The mobile encoder wrote RGB pixels, so request tiles are opaque.
        pixels[targetOffset + 3] = 255;
      }
    }
    return _encodePng(
      pixels,
      TiledImg2ImgConfig.tileSize,
      TiledImg2ImgConfig.tileSize,
    );
  }

  /// Adds one generated tile, blended only across its valid source crop.
  Future<({int width, int height})> addGeneratedTile(
    Img2ImgTile tile,
    Uint8List imageBytes,
  ) async {
    _checkTile(tile);
    _ensureOpen();
    if (_addedTiles[tile.index]) {
      throw StateError('A generated tile was added more than once.');
    }

    final generated = await _decodeRgba(imageBytes);
    final scaleX = generated.width / tile.requestWidth;
    final scaleY = generated.height / tile.requestHeight;
    final outputCropWidth = (tile.cropWidth * TiledImg2ImgConfig.outputScale)
        .round();
    final outputCropHeight = (tile.cropHeight * TiledImg2ImgConfig.outputScale)
        .round();
    final outputCropX = (tile.cropX * TiledImg2ImgConfig.outputScale).round();
    final outputCropY = (tile.cropY * TiledImg2ImgConfig.outputScale).round();

    for (var y = 0; y < outputCropHeight; y++) {
      final canvasY = outputCropY + y;
      if (canvasY >= plan.outputHeight) continue;
      final localY = math.min(generated.height - 1, (y / scaleY).round());
      final edgeY = math.min(y, outputCropHeight - 1 - y);
      for (var x = 0; x < outputCropWidth; x++) {
        final canvasX = outputCropX + x;
        if (canvasX >= plan.outputWidth) continue;
        final localX = math.min(generated.width - 1, (x / scaleX).round());
        final edgeX = math.min(x, outputCropWidth - 1 - x);
        final feather = math.min(
          1.0,
          math.min(edgeX, edgeY) / TiledImg2ImgConfig.featherPixels,
        );
        final weight = math.max(0.05, feather);
        final generatedOffset = (localY * generated.width + localX) * 4;
        final outputIndex = canvasY * plan.outputWidth + canvasX;
        _red[outputIndex] += generated.pixels[generatedOffset] * weight;
        _green[outputIndex] += generated.pixels[generatedOffset + 1] * weight;
        _blue[outputIndex] += generated.pixels[generatedOffset + 2] * weight;
        _weights[outputIndex] += weight;
      }
    }
    _addedTiles[tile.index] = true;
    return (width: generated.width, height: generated.height);
  }

  /// Encodes the completed composite as an opaque PNG.
  Future<Uint8List> finish() async {
    _ensureOpen();
    if (_addedTiles.any((added) => !added)) {
      throw StateError('Cannot stitch before every tile has completed.');
    }
    _finished = true;

    final pixels = Uint8List(plan.outputWidth * plan.outputHeight * 4);
    for (var y = 0; y < plan.outputHeight; y++) {
      final sourceY = (y / TiledImg2ImgConfig.outputScale)
          .floor()
          .clamp(0, _source.height - 1)
          .toInt();
      for (var x = 0; x < plan.outputWidth; x++) {
        final outputIndex = y * plan.outputWidth + x;
        final targetOffset = outputIndex * 4;
        final weight = _weights[outputIndex];
        if (weight <= 0) {
          final sourceX = (x / TiledImg2ImgConfig.outputScale)
              .floor()
              .clamp(0, _source.width - 1)
              .toInt();
          final sourceOffset = (sourceY * _source.width + sourceX) * 4;
          pixels[targetOffset] = _source.pixels[sourceOffset];
          pixels[targetOffset + 1] = _source.pixels[sourceOffset + 1];
          pixels[targetOffset + 2] = _source.pixels[sourceOffset + 2];
        } else {
          pixels[targetOffset] = (_red[outputIndex] / weight)
              .round()
              .clamp(0, 255)
              .toInt();
          pixels[targetOffset + 1] = (_green[outputIndex] / weight)
              .round()
              .clamp(0, 255)
              .toInt();
          pixels[targetOffset + 2] = (_blue[outputIndex] / weight)
              .round()
              .clamp(0, 255)
              .toInt();
        }
        pixels[targetOffset + 3] = 255;
      }
    }
    return _encodePng(pixels, plan.outputWidth, plan.outputHeight);
  }

  void _checkTile(Img2ImgTile tile) {
    if (tile.index < 0 || tile.index >= plan.tiles.length) {
      throw ArgumentError.value(
        tile.index,
        'tile.index',
        'is outside the plan',
      );
    }
    final expected = plan.tiles[tile.index];
    if (tile.row != expected.row ||
        tile.column != expected.column ||
        tile.cropX != expected.cropX ||
        tile.cropY != expected.cropY ||
        tile.cropWidth != expected.cropWidth ||
        tile.cropHeight != expected.cropHeight ||
        tile.requestWidth != expected.requestWidth ||
        tile.requestHeight != expected.requestHeight) {
      throw ArgumentError('Tile does not belong to this tiled img2img plan.');
    }
  }

  void _ensureOpen() {
    if (_finished) throw StateError('Tiled img2img raster session is closed.');
  }
}

class _RgbaImage {
  const _RgbaImage({
    required this.width,
    required this.height,
    required this.pixels,
  });

  final int width;
  final int height;
  final Uint8List pixels;
}

Future<_RgbaImage> _decodeRgba(Uint8List bytes) async {
  if (bytes.isEmpty || bytes.length > _maximumEncodedBytes) {
    throw const FormatException('Image data is empty or too large.');
  }
  ui.Codec? codec;
  ui.Image? image;
  try {
    codec = await ui.instantiateImageCodec(bytes);
    final frame = await codec.getNextFrame();
    image = frame.image;
    _validateDecodedSize(image.width, image.height);
    final data = await image.toByteData(
      format: ui.ImageByteFormat.rawStraightRgba,
    );
    if (data == null) throw StateError('Could not read decoded image pixels.');
    return _RgbaImage(
      width: image.width,
      height: image.height,
      pixels: Uint8List.fromList(
        data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes),
      ),
    );
  } on FormatException {
    rethrow;
  } catch (_) {
    throw const FormatException('Image data could not be decoded.');
  } finally {
    image?.dispose();
    codec?.dispose();
  }
}

void _validateDecodedSize(int width, int height) {
  if (width <= 0 ||
      height <= 0 ||
      width > _maximumDecodedDimension ||
      height > _maximumDecodedDimension ||
      width * height > _maximumDecodedPixels) {
    throw const FormatException('Decoded image dimensions exceed the limit.');
  }
}

Future<Uint8List> _encodePng(Uint8List pixels, int width, int height) async {
  _validateDecodedSize(width, height);
  if (pixels.length != width * height * 4) {
    throw ArgumentError('RGBA buffer length does not match dimensions.');
  }

  // PixelFormat.rgba8888 expects premultiplied color channels.
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
        try {
          final data = await frame.image.toByteData(
            format: ui.ImageByteFormat.png,
          );
          if (data == null) throw StateError('PNG encoding failed.');
          return Uint8List.fromList(
            data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes),
          );
        } finally {
          frame.image.dispose();
        }
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

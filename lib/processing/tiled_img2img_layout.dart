import 'dart:math' as math;

/// Geometry and service limits for the mobile-compatible tiled img2img mode.
class TiledImg2ImgConfig {
  static const int tileSize = 640;
  static const int stride = 320;
  static const int requestSize = 1024;
  static const int maxTiles = 16;
  static const int maxCanvasDimension = 4096;
  static const int maxCanvasPixels = 16 * 1024 * 1024;
  static const double outputScale = 1.6;
  static const double defaultStrength = 0.3;
  static const double minimumStrength = 0.01;
  static const double maximumStrength = 1.0;
  static const double featherPixels = 64;

  const TiledImg2ImgConfig._();
}

/// One top-left anchored source crop and its fixed 1024 by 1024 request size.
class Img2ImgTile {
  const Img2ImgTile({
    required this.index,
    required this.row,
    required this.column,
    required this.cropX,
    required this.cropY,
    required this.cropWidth,
    required this.cropHeight,
    this.requestWidth = TiledImg2ImgConfig.requestSize,
    this.requestHeight = TiledImg2ImgConfig.requestSize,
  });

  final int index;
  final int row;
  final int column;
  final int cropX;
  final int cropY;
  final int cropWidth;
  final int cropHeight;
  final int requestWidth;
  final int requestHeight;

  Map<String, Object?> toJson() => <String, Object?>{
    'index': index,
    'row': row,
    'column': column,
    'cropX': cropX,
    'cropY': cropY,
    'cropWidth': cropWidth,
    'cropHeight': cropHeight,
    'requestWidth': requestWidth,
    'requestHeight': requestHeight,
  };

  factory Img2ImgTile.fromJson(Map<String, Object?> json) => Img2ImgTile(
    index: _readInt(json, 'index'),
    row: _readInt(json, 'row'),
    column: _readInt(json, 'column'),
    cropX: _readInt(json, 'cropX'),
    cropY: _readInt(json, 'cropY'),
    cropWidth: _readInt(json, 'cropWidth'),
    cropHeight: _readInt(json, 'cropHeight'),
    requestWidth: _readInt(json, 'requestWidth'),
    requestHeight: _readInt(json, 'requestHeight'),
  );
}

/// Immutable geometry for one tiled img2img run.
class TiledImg2ImgPlan {
  TiledImg2ImgPlan._({
    required this.sourceWidth,
    required this.sourceHeight,
    required this.outputWidth,
    required this.outputHeight,
    required List<Img2ImgTile> tiles,
  }) : tiles = List<Img2ImgTile>.unmodifiable(tiles);

  final int sourceWidth;
  final int sourceHeight;
  final int outputWidth;
  final int outputHeight;
  final List<Img2ImgTile> tiles;

  Map<String, Object?> toJson() => <String, Object?>{
    'sourceWidth': sourceWidth,
    'sourceHeight': sourceHeight,
    'outputWidth': outputWidth,
    'outputHeight': outputHeight,
    'tiles': tiles.map((tile) => tile.toJson()).toList(growable: false),
  };

  factory TiledImg2ImgPlan.fromJson(Map<String, Object?> json) {
    final plan = buildTiledImg2ImgPlan(
      _readInt(json, 'sourceWidth'),
      _readInt(json, 'sourceHeight'),
    );
    if (plan.outputWidth != _readInt(json, 'outputWidth') ||
        plan.outputHeight != _readInt(json, 'outputHeight')) {
      throw const FormatException('Invalid tiled img2img output dimensions.');
    }
    final savedTiles = json['tiles'];
    if (savedTiles is! List || savedTiles.length != plan.tiles.length) {
      throw const FormatException('Invalid tiled img2img tile plan.');
    }
    for (var index = 0; index < savedTiles.length; index++) {
      if (savedTiles[index] is! Map) {
        throw const FormatException('Invalid tiled img2img tile entry.');
      }
      final restored = Img2ImgTile.fromJson(
        Map<String, Object?>.from(savedTiles[index] as Map),
      );
      if (!_sameTile(restored, plan.tiles[index])) {
        throw const FormatException(
          'Tiled img2img plan does not match its source.',
        );
      }
    }
    return plan;
  }
}

class TiledImg2ImgProgress {
  const TiledImg2ImgProgress(this.completed, this.total);

  final int completed;
  final int total;

  double get fraction => total == 0 ? 0 : completed / total;
}

/// Builds the same 640px crops at a 320px stride used by the phone client.
TiledImg2ImgPlan buildTiledImg2ImgPlan(int width, int height) {
  if (width <= 0 ||
      height <= 0 ||
      width > TiledImg2ImgConfig.maxCanvasDimension ||
      height > TiledImg2ImgConfig.maxCanvasDimension ||
      width * height > TiledImg2ImgConfig.maxCanvasPixels) {
    throw ArgumentError('Source dimensions exceed the tiled img2img limits.');
  }

  final tiles = <Img2ImgTile>[];
  var index = 0;
  var row = 0;
  for (var y = 0; y < height; y += TiledImg2ImgConfig.stride) {
    var column = 0;
    for (var x = 0; x < width; x += TiledImg2ImgConfig.stride) {
      tiles.add(
        Img2ImgTile(
          index: index++,
          row: row,
          column: column++,
          cropX: x,
          cropY: y,
          cropWidth: math.min(TiledImg2ImgConfig.tileSize, width - x),
          cropHeight: math.min(TiledImg2ImgConfig.tileSize, height - y),
        ),
      );
      if (tiles.length > TiledImg2ImgConfig.maxTiles) {
        throw ArgumentError(
          'Tiled img2img supports at most ${TiledImg2ImgConfig.maxTiles} tiles.',
        );
      }
    }
    row++;
  }

  return TiledImg2ImgPlan._(
    sourceWidth: width,
    sourceHeight: height,
    outputWidth: (width * TiledImg2ImgConfig.outputScale).round(),
    outputHeight: (height * TiledImg2ImgConfig.outputScale).round(),
    tiles: tiles,
  );
}

bool _sameTile(Img2ImgTile left, Img2ImgTile right) =>
    left.index == right.index &&
    left.row == right.row &&
    left.column == right.column &&
    left.cropX == right.cropX &&
    left.cropY == right.cropY &&
    left.cropWidth == right.cropWidth &&
    left.cropHeight == right.cropHeight &&
    left.requestWidth == right.requestWidth &&
    left.requestHeight == right.requestHeight;

int _readInt(Map<String, Object?> json, String key) {
  final value = json[key];
  if (value is! num || !value.isFinite || value.toInt() != value) {
    throw FormatException('Invalid tiled img2img field: $key.');
  }
  return value.toInt();
}

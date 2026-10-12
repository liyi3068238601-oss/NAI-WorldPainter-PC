import 'dart:ui';

/// The part of an inpaint document that a stroke edits.
enum InpaintTarget { mask, image }

enum InpaintOperation { paint, erase }

/// [brush] and [path] share the same connected centerline. [rectangle] is a
/// filled source-pixel rectangle.
enum InpaintGeometry { brush, path, rectangle }

enum InpaintBrushShape { round, square }

/// Immutable, JSON-persistable local inpaint state. Coordinates and sizes are
/// always expressed in source-image pixels; [sourceRect] may extend beyond
/// the source bounds to represent transparent generated margins.
class InpaintDocument {
  InpaintDocument({
    required this.sourceAssetRef,
    required this.sourceWidth,
    required this.sourceHeight,
    List<InpaintStroke> strokes = const [],
    this.sourceRect,
    this.fullImageMode = false,
    double previewOpacity = 0.35,
    this.importedMaskAssetRef,
    int expandPixels = 0,
    int featherPixels = 8,
  }) : strokes = List<InpaintStroke>.unmodifiable(strokes),
       expandPixels = _boundedPixels(expandPixels, 'expandPixels'),
       featherPixels = _boundedPixels(featherPixels, 'featherPixels'),
       previewOpacity = _boundedOpacity(previewOpacity, 'previewOpacity') {
    if (sourceAssetRef.isEmpty) {
      throw ArgumentError.value(
        sourceAssetRef,
        'sourceAssetRef',
        'must not be empty',
      );
    }
    if (sourceWidth <= 0 || sourceHeight <= 0) {
      throw ArgumentError('sourceWidth and sourceHeight must be positive');
    }
    if (sourceRect != null &&
        (!sourceRect!.left.isFinite ||
            !sourceRect!.top.isFinite ||
            !sourceRect!.right.isFinite ||
            !sourceRect!.bottom.isFinite ||
            sourceRect!.width <= 0 ||
            sourceRect!.height <= 0)) {
      throw ArgumentError.value(
        sourceRect,
        'sourceRect',
        'must have finite positive dimensions',
      );
    }
  }

  final String sourceAssetRef;
  final int sourceWidth;
  final int sourceHeight;
  final List<InpaintStroke> strokes;
  final Rect? sourceRect;
  final bool fullImageMode;
  final double previewOpacity;
  final String? importedMaskAssetRef;
  final int expandPixels;
  final int featherPixels;

  Rect get effectiveSourceRect => fullImageMode || sourceRect == null
      ? Rect.fromLTWH(0, 0, sourceWidth.toDouble(), sourceHeight.toDouble())
      : sourceRect!;

  InpaintDocument copyWith({
    String? sourceAssetRef,
    int? sourceWidth,
    int? sourceHeight,
    List<InpaintStroke>? strokes,
    Rect? sourceRect,
    bool clearSourceRect = false,
    bool? fullImageMode,
    double? previewOpacity,
    String? importedMaskAssetRef,
    bool clearImportedMask = false,
    int? expandPixels,
    int? featherPixels,
  }) => InpaintDocument(
    sourceAssetRef: sourceAssetRef ?? this.sourceAssetRef,
    sourceWidth: sourceWidth ?? this.sourceWidth,
    sourceHeight: sourceHeight ?? this.sourceHeight,
    strokes: strokes ?? this.strokes,
    sourceRect: clearSourceRect ? null : sourceRect ?? this.sourceRect,
    fullImageMode: fullImageMode ?? this.fullImageMode,
    previewOpacity: previewOpacity ?? this.previewOpacity,
    importedMaskAssetRef: clearImportedMask
        ? null
        : importedMaskAssetRef ?? this.importedMaskAssetRef,
    expandPixels: expandPixels ?? this.expandPixels,
    featherPixels: featherPixels ?? this.featherPixels,
  );

  Map<String, Object?> toJson() => {
    'sourceAssetRef': sourceAssetRef,
    'sourceWidth': sourceWidth,
    'sourceHeight': sourceHeight,
    'strokes': strokes.map((stroke) => stroke.toJson()).toList(),
    'sourceRect': sourceRect == null
        ? null
        : {
            'left': sourceRect!.left,
            'top': sourceRect!.top,
            'right': sourceRect!.right,
            'bottom': sourceRect!.bottom,
          },
    'fullImageMode': fullImageMode,
    'previewOpacity': previewOpacity,
    'importedMaskAssetRef': importedMaskAssetRef,
    'expandPixels': expandPixels,
    'featherPixels': featherPixels,
  };

  factory InpaintDocument.fromJson(Map<String, Object?> json) {
    final rectJson = json['sourceRect'];
    Rect? rect;
    if (rectJson != null) {
      final values = Map<String, Object?>.from(rectJson as Map);
      rect = Rect.fromLTRB(
        _number(values['left'], 'sourceRect.left'),
        _number(values['top'], 'sourceRect.top'),
        _number(values['right'], 'sourceRect.right'),
        _number(values['bottom'], 'sourceRect.bottom'),
      );
    }
    final rawStrokes = json['strokes'] as List<Object?>? ?? const [];
    return InpaintDocument(
      sourceAssetRef: json['sourceAssetRef'] as String,
      sourceWidth: (json['sourceWidth'] as num).toInt(),
      sourceHeight: (json['sourceHeight'] as num).toInt(),
      strokes: rawStrokes
          .map(
            (value) => InpaintStroke.fromJson(
              Map<String, Object?>.from(value! as Map),
            ),
          )
          .toList(growable: false),
      sourceRect: rect,
      fullImageMode: json['fullImageMode'] as bool? ?? false,
      previewOpacity: (json['previewOpacity'] as num?)?.toDouble() ?? 0.35,
      importedMaskAssetRef: json['importedMaskAssetRef'] as String?,
      expandPixels: (json['expandPixels'] as num?)?.toInt() ?? 0,
      featherPixels: (json['featherPixels'] as num?)?.toInt() ?? 8,
    );
  }
}

/// A source-pixel stroke. [color] is ARGB; mask strokes use white coverage in
/// the generated mask regardless of this display color.
class InpaintStroke {
  InpaintStroke({
    required this.target,
    required this.operation,
    required this.geometry,
    List<Offset> points = const [],
    required this.size,
    this.color = 0xffff4d4f,
    double opacity = 1,
    this.brushShape = InpaintBrushShape.round,
    this.rectangle,
  }) : points = List<Offset>.unmodifiable(points),
       opacity = _boundedOpacity(opacity, 'opacity') {
    if (!size.isFinite || size <= 0) {
      throw ArgumentError.value(size, 'size', 'must be finite and positive');
    }
    if (this.points.any((point) => !point.dx.isFinite || !point.dy.isFinite)) {
      throw ArgumentError.value(points, 'points', 'coordinates must be finite');
    }
    if (rectangle != null &&
        (!rectangle!.left.isFinite ||
            !rectangle!.top.isFinite ||
            !rectangle!.right.isFinite ||
            !rectangle!.bottom.isFinite)) {
      throw ArgumentError.value(
        rectangle,
        'rectangle',
        'coordinates must be finite',
      );
    }
  }

  final InpaintTarget target;
  final InpaintOperation operation;
  final InpaintGeometry geometry;
  final List<Offset> points;
  final double size;
  final int color;
  final double opacity;
  final InpaintBrushShape brushShape;
  final Rect? rectangle;

  Map<String, Object?> toJson() => {
    'target': target.name,
    'operation': operation.name,
    'geometry': geometry.name,
    'points': points.map((point) => [point.dx, point.dy]).toList(),
    'size': size,
    'color': color,
    'opacity': opacity,
    'brushShape': brushShape.name,
    'rectangle': rectangle == null
        ? null
        : {
            'left': rectangle!.left,
            'top': rectangle!.top,
            'right': rectangle!.right,
            'bottom': rectangle!.bottom,
          },
  };

  factory InpaintStroke.fromJson(Map<String, Object?> json) {
    final rawPoints = json['points'] as List<Object?>? ?? const [];
    final rectJson = json['rectangle'];
    Rect? rect;
    if (rectJson != null) {
      final values = Map<String, Object?>.from(rectJson as Map);
      rect = Rect.fromLTRB(
        _number(values['left'], 'rectangle.left'),
        _number(values['top'], 'rectangle.top'),
        _number(values['right'], 'rectangle.right'),
        _number(values['bottom'], 'rectangle.bottom'),
      );
    }
    return InpaintStroke(
      target: InpaintTarget.values.byName(json['target'] as String),
      operation: InpaintOperation.values.byName(json['operation'] as String),
      geometry: InpaintGeometry.values.byName(json['geometry'] as String),
      points: rawPoints
          .map((value) {
            final pair = value as List<Object?>;
            if (pair.length != 2) {
              throw const FormatException('point must contain x and y');
            }
            return Offset(
              _number(pair[0], 'point.x'),
              _number(pair[1], 'point.y'),
            );
          })
          .toList(growable: false),
      size: (json['size'] as num).toDouble(),
      color: (json['color'] as num?)?.toInt() ?? 0xffff4d4f,
      opacity: (json['opacity'] as num?)?.toDouble() ?? 1,
      brushShape: InpaintBrushShape.values.byName(
        json['brushShape'] as String? ?? 'round',
      ),
      rectangle: rect,
    );
  }
}

int _boundedPixels(int value, String name) {
  if (value < 0 || value > 32) {
    throw ArgumentError.value(value, name, 'must be between 0 and 32');
  }
  return value;
}

double _boundedOpacity(double value, String name) {
  if (!value.isFinite || value < 0 || value > 1) {
    throw ArgumentError.value(value, name, 'must be between 0 and 1');
  }
  return value;
}

double _number(Object? value, String name) {
  if (value is! num) throw FormatException('$name must be numeric');
  final result = value.toDouble();
  if (!result.isFinite) throw FormatException('$name must be finite');
  return result;
}

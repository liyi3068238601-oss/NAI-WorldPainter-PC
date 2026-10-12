import 'dart:async';
import 'dart:typed_data';

import '../generation/generation_parameters.dart';
import '../generation/novelai_generation_service.dart';
import '../media/image_asset_store.dart';
import 'tiled_img2img_layout.dart';
import 'tiled_img2img_rasterizer.dart';

/// Generates one image-to-image tile from its frozen request and source bytes.
typedef GenerateImg2ImgTile = Future<GenerationResult> Function(
  GenerationParameters parameters,
  Uint8List sourceImageBytes,
);

class TiledImg2ImgEngine {
  factory TiledImg2ImgEngine({
    required ImageAssetStore assets,
    TiledImg2ImgRasterizer rasterizer = const TiledImg2ImgRasterizer(),
  }) => TiledImg2ImgEngine._(assets, rasterizer);

  const TiledImg2ImgEngine._(this._assets, this._rasterizer);

  final ImageAssetStore _assets;
  final TiledImg2ImgRasterizer _rasterizer;

  Future<TiledImg2ImgResult> execute({
    required ImageAsset sourceAsset,
    required GenerationParameters parameters,
    required GenerateImg2ImgTile generateTile,
    required bool Function() isCancelled,
    FutureOr<void> Function(TiledImg2ImgProgress progress)? onProgress,
    double? strength,
  }) async {
    if (sourceAsset.id.isEmpty || sourceAsset.assetRef.isEmpty) {
      throw ArgumentError('A managed source image is required.');
    }
    final suppliedSourceRef = parameters.img2imgSourceImageId;
    if (suppliedSourceRef != null &&
        suppliedSourceRef != sourceAsset.assetRef) {
      throw const FormatException(
        'The source image does not match the frozen generation parameters.',
      );
    }

    final effectiveStrength =
        strength ??
        parameters.img2imgStrength ??
        TiledImg2ImgConfig.defaultStrength;
    if (!effectiveStrength.isFinite ||
        effectiveStrength < TiledImg2ImgConfig.minimumStrength ||
        effectiveStrength > TiledImg2ImgConfig.maximumStrength) {
      throw ArgumentError.value(effectiveStrength, 'strength');
    }

    final submittedParameters = parameters.copyWith(
      operation: GenerationOperation.imageToImage,
      img2imgSourceImageId: sourceAsset.assetRef,
      img2imgStrength: effectiveStrength,
    );
    final requestBaseParameters = submittedParameters.copyWith(
      clearMaskImageId: true,
      clearInpaintStrength: true,
    );

    if (isCancelled()) throw const TiledImg2ImgCancelled();
    final sourceBytes = await _assets.read(sourceAsset.assetRef);
    if (isCancelled()) throw const TiledImg2ImgCancelled();

    final plan = buildTiledImg2ImgPlan(sourceAsset.width, sourceAsset.height);
    final raster = await _rasterizer.openSession(sourceBytes, plan);
    final executions = <TiledImg2ImgTileExecution>[];
    await onProgress?.call(TiledImg2ImgProgress(0, plan.tiles.length));

    for (final tile in plan.tiles) {
      if (isCancelled()) throw const TiledImg2ImgCancelled();
      final tileSourceBytes = await raster.encodeTile(tile);
      if (isCancelled()) throw const TiledImg2ImgCancelled();

      final requested = _parametersForTile(
        requestBaseParameters,
        tile,
        effectiveStrength,
      );
      late final GenerationResult generated;
      late final ({int width, int height}) generatedSize;
      try {
        generated = await generateTile(requested, tileSourceBytes);
        if (isCancelled()) throw const TiledImg2ImgCancelled();
        generatedSize = await raster.addGeneratedTile(
          tile,
          generated.imageBytes,
        );
      } on TiledImg2ImgCancelled {
        rethrow;
      } catch (error) {
        if (isCancelled()) throw const TiledImg2ImgCancelled();
        throw TiledImg2ImgTileFailure(
          tileNumber: tile.index + 1,
          tileCount: plan.tiles.length,
          cause: error,
        );
      }
      if (isCancelled()) throw const TiledImg2ImgCancelled();

      executions.add(
        TiledImg2ImgTileExecution(
          tile: tile,
          requestedParameters: requested,
          effectiveParameters: generated.effectiveParameters.copyWith(
            img2imgSourceImageId: sourceAsset.assetRef,
          ),
          generatedWidth: generatedSize.width,
          generatedHeight: generatedSize.height,
        ),
      );
      await onProgress?.call(
        TiledImg2ImgProgress(executions.length, plan.tiles.length),
      );
    }

    if (isCancelled()) throw const TiledImg2ImgCancelled();
    final imageBytes = await raster.finish();
    if (isCancelled()) throw const TiledImg2ImgCancelled();
    final outputAsset = await _assets.save(imageBytes);
    // A cancel during an asynchronous save prevents the caller from accepting
    // or indexing the finished result. The immutable asset store may retain an
    // unreferenced content-addressed file for later cleanup.
    if (isCancelled()) throw const TiledImg2ImgCancelled();

    return TiledImg2ImgResult(
      imageBytes: imageBytes,
      asset: outputAsset,
      record: TiledImg2ImgRecord(
        sourceAssetId: sourceAsset.id,
        sourceAssetRef: sourceAsset.assetRef,
        submittedParameters: submittedParameters,
        plan: plan,
        executions: executions,
        outputAsset: outputAsset,
      ),
    );
  }
}

GenerationParameters _parametersForTile(
  GenerationParameters base,
  Img2ImgTile tile,
  double strength,
) => base.copyWith(
  operation: GenerationOperation.imageToImage,
  width: tile.requestWidth,
  height: tile.requestHeight,
  seed: base.seed == null ? null : _tileSeed(base.seed!, tile),
  clearSeed: base.seed == null,
  img2imgStrength: strength,
);

int _tileSeed(int seed, Img2ImgTile tile) {
  var value = seed & 0x7fffffff;
  value = (value * 31 + tile.row) & 0x7fffffff;
  value = (value * 31 + tile.column) & 0x7fffffff;
  return value;
}

class TiledImg2ImgResult {
  TiledImg2ImgResult({
    required Uint8List imageBytes,
    required this.asset,
    required this.record,
  }) : imageBytes = Uint8List.fromList(imageBytes);

  final Uint8List imageBytes;
  final ImageAsset asset;
  final TiledImg2ImgRecord record;
}

/// JSON-safe result provenance suitable for a gallery or workspace snapshot.
class TiledImg2ImgRecord {
  TiledImg2ImgRecord({
    required this.sourceAssetId,
    required this.sourceAssetRef,
    required this.submittedParameters,
    required this.plan,
    required List<TiledImg2ImgTileExecution> executions,
    required this.outputAsset,
  }) : executions = List<TiledImg2ImgTileExecution>.unmodifiable(executions) {
    if (!_isSha256(sourceAssetId) || sourceAssetRef.isEmpty) {
      throw ArgumentError('Source asset identity is required.');
    }
    if (submittedParameters.img2imgSourceImageId != sourceAssetRef) {
      throw ArgumentError(
        'Source asset identity does not match the run record.',
      );
    }
    if (outputAsset.width != plan.outputWidth ||
        outputAsset.height != plan.outputHeight) {
      throw ArgumentError(
        'Output asset dimensions do not match the tile plan.',
      );
    }
    if (this.executions.length != plan.tiles.length ||
        this.executions.indexed.any(
          (entry) =>
              entry.$1 != entry.$2.tile.index ||
              !_samePlanTile(plan.tiles[entry.$1], entry.$2.tile),
        )) {
      throw ArgumentError('Tile execution records must match the plan order.');
    }
  }

  final String sourceAssetId;
  final String sourceAssetRef;
  final GenerationParameters submittedParameters;
  final TiledImg2ImgPlan plan;
  final List<TiledImg2ImgTileExecution> executions;
  final ImageAsset outputAsset;

  Map<String, Object?> toJson() => <String, Object?>{
    'version': 1,
    'sourceAssetId': sourceAssetId,
    'sourceAssetRef': sourceAssetRef,
    'submittedParameters': submittedParameters.toJson(),
    'plan': plan.toJson(),
    'executions': executions.map((item) => item.toJson()).toList(),
    'outputAsset': outputAsset.toJson(),
  };

  factory TiledImg2ImgRecord.fromJson(Map<String, Object?> json) {
    if (json['version'] != 1) {
      throw const FormatException('Unknown tiled img2img record version.');
    }
    final rawPlan = _readMap(json['plan'], 'plan');
    final rawParameters = _readMap(
      json['submittedParameters'],
      'submittedParameters',
    );
    final rawAsset = _readMap(json['outputAsset'], 'outputAsset');
    final rawExecutions = json['executions'];
    if (rawExecutions is! List) {
      throw const FormatException('Invalid tiled img2img executions.');
    }
    final plan = TiledImg2ImgPlan.fromJson(rawPlan);
    final sourceAssetId = _readString(json, 'sourceAssetId');
    final sourceAssetRef = _readString(json, 'sourceAssetRef');
    final submittedParameters = GenerationParameters.fromJson(
      Map<String, dynamic>.from(rawParameters),
    );
    final executions = rawExecutions
        .map(
          (value) =>
              TiledImg2ImgTileExecution.fromJson(_readMap(value, 'execution')),
        )
        .toList(growable: false);
    return TiledImg2ImgRecord(
      sourceAssetId: sourceAssetId,
      sourceAssetRef: sourceAssetRef,
      submittedParameters: submittedParameters,
      plan: plan,
      executions: executions,
      outputAsset: _imageAssetFromJson(rawAsset),
    );
  }
}

class TiledImg2ImgTileExecution {
  const TiledImg2ImgTileExecution({
    required this.tile,
    required this.requestedParameters,
    required this.effectiveParameters,
    required this.generatedWidth,
    required this.generatedHeight,
  });

  final Img2ImgTile tile;
  final GenerationParameters requestedParameters;
  final GenerationParameters effectiveParameters;
  final int generatedWidth;
  final int generatedHeight;

  Map<String, Object?> toJson() => <String, Object?>{
    'tile': tile.toJson(),
    'requestedParameters': requestedParameters.toJson(),
    'effectiveParameters': effectiveParameters.toJson(),
    'generatedWidth': generatedWidth,
    'generatedHeight': generatedHeight,
  };

  factory TiledImg2ImgTileExecution.fromJson(Map<String, Object?> json) {
    final rawTile = _readMap(json['tile'], 'tile');
    final rawRequested = _readMap(
      json['requestedParameters'],
      'requestedParameters',
    );
    final rawEffective = _readMap(
      json['effectiveParameters'],
      'effectiveParameters',
    );
    final width = _readInt(json, 'generatedWidth');
    final height = _readInt(json, 'generatedHeight');
    if (width <= 0 || height <= 0) {
      throw const FormatException('Invalid generated tile dimensions.');
    }
    return TiledImg2ImgTileExecution(
      tile: Img2ImgTile.fromJson(rawTile),
      requestedParameters: GenerationParameters.fromJson(
        Map<String, dynamic>.from(rawRequested),
      ),
      effectiveParameters: GenerationParameters.fromJson(
        Map<String, dynamic>.from(rawEffective),
      ),
      generatedWidth: width,
      generatedHeight: height,
    );
  }
}

class TiledImg2ImgCancelled implements Exception {
  const TiledImg2ImgCancelled();

  @override
  String toString() => 'Tiled img2img was cancelled.';
}

/// Identifies which sequential tile failed without exposing provider payloads.
class TiledImg2ImgTileFailure implements Exception {
  const TiledImg2ImgTileFailure({
    required this.tileNumber,
    required this.tileCount,
    required this.cause,
  });

  final int tileNumber;
  final int tileCount;
  final Object cause;

  @override
  String toString() => 'Tile $tileNumber of $tileCount failed.';
}

Map<String, Object?> _readMap(Object? value, String name) {
  if (value is! Map) throw FormatException('Invalid tiled img2img $name.');
  return Map<String, Object?>.from(value);
}

String _readString(Map<String, Object?> json, String key) {
  final value = json[key];
  if (value is! String || value.isEmpty) {
    throw FormatException('Invalid tiled img2img field: $key.');
  }
  return value;
}

int _readInt(Map<String, Object?> json, String key) {
  final value = json[key];
  if (value is! num || !value.isFinite || value.toInt() != value) {
    throw FormatException('Invalid tiled img2img field: $key.');
  }
  return value.toInt();
}

ImageAsset _imageAssetFromJson(Map<String, Object?> json) {
  final id = _readString(json, 'id');
  final assetRef = _readString(json, 'assetRef');
  final mime = _readString(json, 'mime');
  final sha256 = _readString(json, 'sha256');
  final width = _readInt(json, 'width');
  final height = _readInt(json, 'height');
  final byteLength = _readInt(json, 'byteLength');
  if (id != sha256 ||
      !_isSha256(id) ||
      !_isSha256(sha256) ||
      !const <String>{'image/png', 'image/jpeg', 'image/webp'}.contains(mime) ||
      width <= 0 ||
      height <= 0 ||
      byteLength <= 0) {
    throw const FormatException('Invalid tiled img2img output asset.');
  }
  return ImageAsset(
    id: id,
    assetRef: assetRef,
    width: width,
    height: height,
    mime: mime,
    sha256: sha256,
    byteLength: byteLength,
  );
}

bool _isSha256(String value) => RegExp(r'^[0-9a-f]{64}$').hasMatch(value);

bool _samePlanTile(Img2ImgTile left, Img2ImgTile right) =>
    left.index == right.index &&
    left.row == right.row &&
    left.column == right.column &&
    left.cropX == right.cropX &&
    left.cropY == right.cropY &&
    left.cropWidth == right.cropWidth &&
    left.cropHeight == right.cropHeight &&
    left.requestWidth == right.requestWidth &&
    left.requestHeight == right.requestHeight;

import 'dart:convert';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:worldpainter_pc/generation/generation_parameters.dart';
import 'package:worldpainter_pc/generation/novelai_generation_service.dart';
import 'package:worldpainter_pc/media/image_asset.dart';
import 'package:worldpainter_pc/media/image_asset_store_contract.dart';
import 'package:worldpainter_pc/processing/tiled_img2img.dart';
import 'package:worldpainter_pc/processing/tiled_img2img_layout.dart';
import 'package:worldpainter_pc/processing/tiled_img2img_rasterizer.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('tiled img2img plan', () {
    test('uses 640px crops at 320px stride and fixed 1024px requests', () {
      final plan = buildTiledImg2ImgPlan(1024, 1024);

      expect(plan.tiles, hasLength(16));
      expect(plan.tiles.first.cropX, 0);
      expect(plan.tiles.first.cropY, 0);
      expect(plan.tiles.first.cropWidth, 640);
      expect(plan.tiles.first.cropHeight, 640);
      expect(plan.tiles.first.requestWidth, 1024);
      expect(plan.tiles.first.requestHeight, 1024);
      expect(plan.tiles[1].cropX, 320);
      expect(plan.tiles[4].cropY, 320);
    });

    test('sets final dimensions from the 1.6x output scale', () {
      final plan = buildTiledImg2ImgPlan(954, 640);

      expect(plan.outputWidth, 1526);
      expect(plan.outputHeight, 1024);
      expect(plan.tiles, hasLength(6));
    });

    test('matches the mobile 960 by 640 six-tile output geometry', () {
      final plan = buildTiledImg2ImgPlan(960, 640);

      expect(plan.tiles, hasLength(6));
      expect(plan.outputWidth, 1536);
      expect(plan.outputHeight, 1024);
    });

    test('rejects oversized sources and more than sixteen tiles', () {
      expect(() => buildTiledImg2ImgPlan(4097, 1), throwsArgumentError);
      expect(() => buildTiledImg2ImgPlan(4096, 4096), throwsArgumentError);
    });

    test('round trips a validated plan and rejects tampered geometry', () {
      final plan = buildTiledImg2ImgPlan(641, 321);
      final restored = TiledImg2ImgPlan.fromJson(plan.toJson());

      expect(restored.tiles.length, plan.tiles.length);
      expect(restored.outputWidth, plan.outputWidth);
      final tampered = Map<String, Object?>.from(plan.toJson());
      final tiles = (tampered['tiles'] as List).cast<Map<String, Object?>>();
      tiles[0] = <String, Object?>{...tiles[0], 'cropX': 1};
      expect(() => TiledImg2ImgPlan.fromJson(tampered), throwsFormatException);
    });
  });

  test('pads source edges by repeating the nearest pixel', () async {
    final sourceBytes = await _rgbaPng(
      2,
      2,
      Uint8List.fromList(<int>[
        255,
        0,
        0,
        255,
        0,
        255,
        0,
        255,
        0,
        0,
        255,
        255,
        255,
        255,
        0,
        255,
      ]),
    );
    final plan = buildTiledImg2ImgPlan(2, 2);
    final raster = await const TiledImg2ImgRasterizer().openSession(
      sourceBytes,
      plan,
    );

    final tileBytes = await raster.encodeTile(plan.tiles.single);
    final pixels = await _readPixels(tileBytes);
    expect(pixels.at(0, 0), <int>[255, 0, 0, 255]);
    expect(pixels.at(1, 0), <int>[0, 255, 0, 255]);
    expect(pixels.at(2, 0), <int>[0, 255, 0, 255]);
    expect(pixels.at(639, 639), <int>[255, 255, 0, 255]);
  });

  test(
    'feathers overlapping generated tiles and keeps the source canvas size',
    () async {
      final sourceBytes = await _solidPng(640, 64, const ui.Color(0xff808080));
      final plan = buildTiledImg2ImgPlan(640, 64);
      final raster = await const TiledImg2ImgRasterizer().openSession(
        sourceBytes,
        plan,
      );
      final red = await _solidPng(1024, 1024, const ui.Color(0xffff0000));
      final blue = await _solidPng(1024, 1024, const ui.Color(0xff0000ff));

      await raster.addGeneratedTile(plan.tiles[0], red);
      await raster.addGeneratedTile(plan.tiles[1], blue);
      final output = await raster.finish();
      final pixels = await _readPixels(output);

      expect(pixels.width, plan.outputWidth);
      expect(pixels.height, plan.outputHeight);
      final blended = pixels.at(768, 50);
      expect(blended[0], inInclusiveRange(120, 136));
      expect(blended[2], inInclusiveRange(120, 136));
      final firstTileEdge = pixels.at(520, 50);
      expect(firstTileEdge[0], greaterThan(firstTileEdge[2]));
    },
  );

  group('TiledImg2ImgEngine', () {
    test(
      'runs tiles in order, reports progress and saves only the composite',
      () async {
        final store = _MemoryImageAssetStore();
        final sourceBytes = await _solidPng(2, 2, const ui.Color(0xff123456));
        final sourceAsset = await store.add(sourceBytes);
        store.saveCalls = 0;
        final response = await _solidPng(
          1024,
          1024,
          const ui.Color(0xffd57a00),
        );
        final base = _parameters(sourceAsset.assetRef, seed: 123);
        final progress = <TiledImg2ImgProgress>[];
        final seenRequests = <GenerationParameters>[];

        final result = await TiledImg2ImgEngine(assets: store).execute(
          sourceAsset: sourceAsset,
          parameters: base,
          strength: 0.3,
          generateTile: (parameters, tileBytes) async {
            seenRequests.add(parameters);
            final tilePixels = await _readPixels(tileBytes);
            expect(tilePixels.width, 640);
            expect(tilePixels.height, 640);
            return GenerationResult(
              imageBytes: response,
              effectiveParameters: parameters.copyWith(seed: 777),
            );
          },
          isCancelled: () => false,
          onProgress: progress.add,
        );

        expect(seenRequests, hasLength(1));
        expect(seenRequests.single.operation, GenerationOperation.imageToImage);
        expect(seenRequests.single.width, 1024);
        expect(seenRequests.single.height, 1024);
        expect(seenRequests.single.img2imgStrength, 0.3);
        expect(seenRequests.single.img2imgSourceImageId, sourceAsset.assetRef);
        expect(seenRequests.single.seed, _derivedSeed(123, 0, 0));
        expect(result.record.submittedParameters.width, base.width);
        expect(result.record.submittedParameters.height, base.height);
        expect(result.record.submittedParameters.img2imgStrength, 0.3);
        expect(
          result.record.submittedParameters.img2imgSourceImageId,
          sourceAsset.assetRef,
        );
        expect(result.record.sourceAssetId, sourceAsset.id);
        expect(result.record.sourceAssetRef, sourceAsset.assetRef);
        expect(
          result
              .record
              .executions
              .single
              .requestedParameters
              .img2imgSourceImageId,
          sourceAsset.assetRef,
        );
        expect(
          result
              .record
              .executions
              .single
              .effectiveParameters
              .img2imgSourceImageId,
          sourceAsset.assetRef,
        );
        expect(result.asset.width, 3);
        expect(result.asset.height, 3);
        expect(store.saveCalls, 1);
        expect(progress.map((item) => (item.completed, item.total)), [
          (0, 1),
          (1, 1),
        ]);
        expect(result.record.executions.single.effectiveParameters.seed, 777);

        final encoded = jsonEncode(result.record.toJson());
        final restored = TiledImg2ImgRecord.fromJson(
          Map<String, Object?>.from(jsonDecode(encoded) as Map),
        );
        expect(restored.sourceAssetRef, sourceAsset.assetRef);
        expect(restored.outputAsset.assetRef, result.asset.assetRef);
        expect(restored.executions.single.effectiveParameters.seed, 777);
      },
    );

    test(
      'cancellation after a tile response discards it before saving',
      () async {
        final store = _MemoryImageAssetStore();
        final sourceAsset = await store.add(
          await _solidPng(2, 2, const ui.Color(0xff123456)),
        );
        store.saveCalls = 0;
        final response = await _solidPng(
          1024,
          1024,
          const ui.Color(0xffd57a00),
        );
        var cancelled = false;
        final progress = <TiledImg2ImgProgress>[];

        await expectLater(
          TiledImg2ImgEngine(assets: store).execute(
            sourceAsset: sourceAsset,
            parameters: _parameters(sourceAsset.assetRef),
            generateTile: (parameters, _) async {
              cancelled = true;
              return GenerationResult(
                imageBytes: response,
                effectiveParameters: parameters,
              );
            },
            isCancelled: () => cancelled,
            onProgress: progress.add,
          ),
          throwsA(isA<TiledImg2ImgCancelled>()),
        );

        expect(store.saveCalls, 0);
        expect(progress.map((item) => item.completed), [0]);
      },
    );

    test('does not retry a failed tile or save a partial result', () async {
      final store = _MemoryImageAssetStore();
      final sourceAsset = await store.add(
        await _solidPng(2, 2, const ui.Color(0xff123456)),
      );
      store.saveCalls = 0;
      var requests = 0;

      await expectLater(
        TiledImg2ImgEngine(assets: store).execute(
          sourceAsset: sourceAsset,
          parameters: _parameters(sourceAsset.assetRef),
          generateTile: (_, _) async {
            requests++;
            throw StateError('mock provider failure');
          },
          isCancelled: () => false,
        ),
        throwsA(isA<TiledImg2ImgTileFailure>()),
      );

      expect(requests, 1);
      expect(store.saveCalls, 0);
    });

    test(
      'rejects a frozen source identity that differs from the selected asset',
      () async {
        final store = _MemoryImageAssetStore();
        final sourceAsset = await store.add(
          await _solidPng(2, 2, const ui.Color(0xff123456)),
        );

        await expectLater(
          TiledImg2ImgEngine(assets: store).execute(
            sourceAsset: sourceAsset,
            parameters: _parameters('some-other-image-id'),
            generateTile: (_, _) async => throw StateError('unreachable'),
            isCancelled: () => false,
          ),
          throwsFormatException,
        );
      },
    );
  });
}

GenerationParameters _parameters(String sourceRef, {int? seed}) =>
    GenerationParameters(
      operation: GenerationOperation.imageToImage,
      model: 'nai-diffusion-4-5-full',
      prompt: 'fixture prompt',
      negativePrompt: 'fixture negative',
      width: 832,
      height: 1216,
      seed: seed,
      img2imgSourceImageId: sourceRef,
      img2imgStrength: 0.72,
    );

int _derivedSeed(int seed, int row, int column) {
  var value = seed & 0x7fffffff;
  value = (value * 31 + row) & 0x7fffffff;
  value = (value * 31 + column) & 0x7fffffff;
  return value;
}

Future<Uint8List> _solidPng(int width, int height, ui.Color color) {
  final pixels = Uint8List(width * height * 4);
  for (var offset = 0; offset < pixels.length; offset += 4) {
    pixels[offset] = (color.r * 255).round().clamp(0, 255).toInt();
    pixels[offset + 1] = (color.g * 255).round().clamp(0, 255).toInt();
    pixels[offset + 2] = (color.b * 255).round().clamp(0, 255).toInt();
    pixels[offset + 3] = (color.a * 255).round().clamp(0, 255).toInt();
  }
  return _rgbaPng(width, height, pixels);
}

Future<Uint8List> _rgbaPng(int width, int height, Uint8List pixels) async {
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
          final encoded = await frame.image.toByteData(
            format: ui.ImageByteFormat.png,
          );
          if (encoded == null) {
            throw StateError('Unable to create PNG fixture.');
          }
          return Uint8List.fromList(
            encoded.buffer.asUint8List(
              encoded.offsetInBytes,
              encoded.lengthInBytes,
            ),
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

Future<_Pixels> _readPixels(Uint8List bytes) async {
  final codec = await ui.instantiateImageCodec(bytes);
  try {
    final frame = await codec.getNextFrame();
    try {
      final data = await frame.image.toByteData(
        format: ui.ImageByteFormat.rawStraightRgba,
      );
      if (data == null) throw StateError('Unable to read PNG fixture pixels.');
      return _Pixels(
        frame.image.width,
        frame.image.height,
        Uint8List.fromList(
          data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes),
        ),
      );
    } finally {
      frame.image.dispose();
    }
  } finally {
    codec.dispose();
  }
}

class _Pixels {
  const _Pixels(this.width, this.height, this.data);

  final int width;
  final int height;
  final Uint8List data;

  List<int> at(int x, int y) {
    final offset = (y * width + x) * 4;
    return data.sublist(offset, offset + 4);
  }
}

class _MemoryImageAssetStore implements ImageAssetStore {
  final Map<String, Uint8List> _assets = <String, Uint8List>{};
  int saveCalls = 0;

  @override
  String get label => 'test memory assets';

  Future<ImageAsset> add(Uint8List bytes) async {
    final asset = await _assetFor(bytes);
    _assets[asset.assetRef] = Uint8List.fromList(bytes);
    return asset;
  }

  @override
  Future<ImageAsset> save(Uint8List bytes) async {
    saveCalls++;
    final asset = await _assetFor(bytes);
    _assets[asset.assetRef] = Uint8List.fromList(bytes);
    return asset;
  }

  @override
  Future<Uint8List> read(String assetRef) async {
    final bytes = _assets[assetRef];
    if (bytes == null) throw ImageAssetNotFoundException(assetRef);
    return Uint8List.fromList(bytes);
  }

  @override
  Future<void> close() async {}

  Future<ImageAsset> _assetFor(Uint8List bytes) async {
    final pixels = await _readPixels(bytes);
    final digest = sha256.convert(bytes).toString();
    return ImageAsset(
      id: digest,
      assetRef: 'managed/images/$digest.png',
      width: pixels.width,
      height: pixels.height,
      mime: 'image/png',
      sha256: digest,
      byteLength: bytes.length,
    );
  }
}

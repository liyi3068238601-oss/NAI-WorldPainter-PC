import 'dart:async';

import 'package:http/http.dart' as http;

import '../generation/generation_parameters.dart';
import '../generation/generation_http_client.dart';
import '../generation/generation_runtime.dart';
import '../generation/novelai_generation_service.dart';
import '../generation/service_connection.dart';
import '../media/image_asset_store.dart';
import '../media/image_asset_validation.dart';
import '../prototype/workbench_controller.dart';
import '../security/credential_vault.dart';
import 'local_sr.dart';
import 'postprocess_parameters.dart';
import 'tiled_img2img.dart';
import 'tiled_img2img_layout.dart';

/// Executes frozen image-tool tasks; only the final derived image is indexed.
class ImageToolsRuntime {
  ImageToolsRuntime({
    required this.assets,
    required this.vault,
    required this.generation,
    LocalSuperResolution? localSr,
    http.Client Function()? clientFactory,
  }) : localSr = localSr ?? createLocalSuperResolution(),
       clientFactory = clientFactory ?? createGenerationHttpClient;

  final ImageAssetStore assets;
  final CredentialVault vault;
  final GenerationRuntime generation;
  final LocalSuperResolution localSr;
  final http.Client Function() clientFactory;
  http.Client? _active;
  int _epoch = 0;

  void cancel() {
    _epoch++;
    _active?.close();
    _active = null;
    generation.cancel();
    unawaited(localSr.cancel());
  }

  Future<SceneResult> process(
    Map<String, Object?> draft,
    GenerationParameters generationParameters,
    ServiceConnection connection,
    ImageToolProgress onProgress,
    bool Function() isCurrent,
  ) async {
    final epoch = _epoch;
    bool cancelled() => epoch != _epoch || !isCurrent();
    void checkCurrent() {
      if (cancelled()) throw const FormatException('任务已取消');
    }

    final sourceRef = draft['sourceAssetRef'] as String;
    final mode = draft['mode'] as String;
    if (mode != 'tiled') {
      final parameters = draft['postprocess'];
      final expected = mode == 'localSr' ? 'local_sr' : mode;
      if (parameters is! Map || parameters['operation'] != expected) {
        throw const FormatException('处理方式与参数不一致，未发起请求。');
      }
      if (const ['enhance', 'upscale'].contains(mode) &&
          connection.protocol != 'official') {
        throw const FormatException('此操作只支持 NovelAI 官方接入。');
      }
    }
    if (mode == 'tiled') {
      try {
        buildTiledImg2ImgPlan(
          draft['sourceWidth'] as int,
          draft['sourceHeight'] as int,
        );
      } on ArgumentError {
        throw const FormatException('分块高清原图须在 4096 像素、16MP 和最多 16 块限制内。');
      }
    }
    final source = await validateImageAssetBytes(await assets.read(sourceRef));
    if (source.asset.width != draft['sourceWidth'] ||
        source.asset.height != draft['sourceHeight']) {
      throw const FormatException('原图与草稿尺寸不一致，请重新选择图片。');
    }
    checkCurrent();
    late final ImageAsset output;
    GenerationParameters? resultGeneration = generationParameters;
    final provenance = <String, Object?>{'sourceAssetRef': sourceRef};
    var provider = connection.label;
    var title = '图片后处理';
    var prompt = generationParameters.prompt;
    var negative = generationParameters.negativePrompt ?? '';
    var seed = generationParameters.seed ?? 0;
    var resultModel = generationParameters.model;
    var resultSteps = generationParameters.steps;
    var resultCfg = generationParameters.scale;
    try {
      if (mode == 'tiled') {
        final result = await TiledImg2ImgEngine(assets: assets).execute(
          sourceAsset: source.asset,
          parameters: generationParameters.copyWith(
            img2imgSourceImageId: source.asset.assetRef,
          ),
          strength: (draft['strength'] as num? ?? 0.3).toDouble(),
          generateTile: (parameters, bytes) => generation.generateBytes(
            parameters,
            connection,
            sourceImageBytes: bytes,
          ),
          isCancelled: cancelled,
          onProgress: (progress) => onProgress(
            '分块高清 ${progress.completed}/${progress.total}',
            progress.completed,
            progress.total,
          ),
        );
        output = result.asset;
        resultGeneration = result.record.submittedParameters;
        provenance['tiledImg2Img'] = result.record.toJson();
        // The top-level seed describes the whole task's submitted base seed.
        // Per-tile actual seeds live in executions, never in this refill field.
        seed = resultGeneration.seed ?? 0;
        title = '分块高清图生图';
      } else {
        final parameters = PostprocessParameters.fromJson(
          Map<String, dynamic>.from(draft['postprocess'] as Map),
        );
        parameters.validate();
        if (parameters.sourceAssetRef != sourceRef ||
            parameters.width != source.asset.width ||
            parameters.height != source.asset.height) {
          throw const FormatException('处理参数与所选原图不一致。');
        }
        if (parameters.operation == PostprocessOperation.localSr) {
          final bytes = await localSr.upscale(
            parameters,
            sourceBytes: source.bytes,
            onProgress: onProgress,
            isCancelled: cancelled,
          );
          checkCurrent();
          output = await assets.save(bytes);
          provenance['postprocess'] = parameters.toJson();
          provider = 'Windows 本地超分';
          title = '本地超分';
        } else {
          final secret = await connection.readSecret(vault);
          if (secret == null || secret.isEmpty) {
            throw const FormatException('请先保存此渠道和地址的凭据。');
          }
          checkCurrent();
          final client = clientFactory();
          _active = client;
          try {
            await onProgress(
              '正在执行图片后处理',
              0,
              parameters.operation == PostprocessOperation.upscale &&
                      parameters.scale == 4
                  ? 2
                  : 1,
            );
            final result = await NovelAiGenerationService(client: client)
                .processPostprocess(
                  parameters: parameters,
                  provider: GenerationProviderConfig(
                    protocol: NovelAiProtocol.values.byName(
                      connection.protocol,
                    ),
                    baseUri: connection.uri,
                    allowInsecureLoopbackForTesting:
                        connection.uri.scheme == 'http',
                  ),
                  credential: GenerationCredential(secret),
                  resolveImage: assets.read,
                );
            checkCurrent();
            output = await assets.save(result.imageBytes);
            provenance.addAll({
              'postprocess': result.effectiveParameters.toJson(),
              'preparedInputWidth': result.inputWidth,
              'preparedInputHeight': result.inputHeight,
              'actualOutputWidth': output.width,
              'actualOutputHeight': output.height,
            });
            prompt = result.effectiveParameters.prompt ?? prompt;
            negative = result.effectiveParameters.negativePrompt ?? negative;
            seed = result.effectiveParameters.seed ?? seed;
            resultModel =
                result.effectiveParameters.model ??
                (mode == 'upscale' ? 'nai-diffusion-5-curated' : resultModel);
            resultSteps = result.effectiveParameters.steps ?? resultSteps;
            resultCfg = result.effectiveParameters.guidance ?? resultCfg;
            title = switch (parameters.operation) {
              PostprocessOperation.enhance => 'Enhance 重绘增强',
              PostprocessOperation.upscale => '官方超分',
              _ => '导演工具',
            };
          } finally {
            client.close();
            if (identical(_active, client)) _active = null;
          }
        }
      }
    } on GenerationServiceException catch (error) {
      throw FormatException(error.message);
    } on TiledImg2ImgTileFailure catch (error) {
      final cause = error.cause;
      final detail = cause is FormatException ? cause.message : '处理失败';
      throw FormatException(
        '第 ${error.tileNumber}/${error.tileCount} 块$detail；原图保留，未自动重试。',
      );
    } on TiledImg2ImgCancelled {
      throw const FormatException('任务已取消');
    } on PostprocessValidationException {
      throw const FormatException('图片处理参数无效，请检查模型、倍率和数值范围。');
    } on LocalSuperResolutionException catch (error) {
      throw FormatException(error.message);
    }
    checkCurrent();
    final id =
        'derived-${DateTime.now().microsecondsSinceEpoch}-${output.id.substring(0, 12)}';
    final savedDraft = {
      ...draft,
      'active': true,
      'resultAssetRef': output.assetRef,
      'resultId': id,
      'resultWidth': output.width,
      'resultHeight': output.height,
      if (mode != 'tiled') 'postprocess': provenance['postprocess'],
      if (mode != 'tiled')
        'settings': {
          ...?draft['settings'] as Map?,
          mode: provenance['postprocess'],
        },
    };
    return SceneResult(
      id: id,
      title: title,
      prompt: prompt,
      negative: negative,
      width: output.width,
      height: output.height,
      seed: seed,
      variant: 0,
      favorite: false,
      isDemo: false,
      model: mode == 'localSr'
          ? ((draft['postprocess'] as Map)['model'] as String)
          : resultModel,
      provider: provider,
      steps: resultSteps,
      cfg: resultCfg,
      assetRef: output.assetRef,
      parameters: resultGeneration,
      editMetadata: {
        'operation': mode,
        'parentAssetRef': sourceRef,
        'parentResultId': draft['parentId'],
        'imageTools': savedDraft,
        ...provenance,
      },
    );
  }
}

import 'package:http/http.dart' as http;

import '../media/image_asset_store.dart';
import '../security/credential_vault.dart';
import '../prototype/workbench_controller.dart';
import 'generation_parameters.dart';
import 'novelai_generation_service.dart';
import 'service_connection.dart';

class GenerationRuntime {
  GenerationRuntime({
    required this.assets,
    required this.vault,
    http.Client Function()? clientFactory,
  }) : clientFactory = clientFactory ?? http.Client.new;
  final ImageAssetStore assets;
  final CredentialVault vault;
  final http.Client Function() clientFactory;
  http.Client? _active;
  int _epoch = 0;
  void cancel() {
    _epoch++;
    _active?.close();
    _active = null;
  }

  Future<SceneResult> generate(
    GenerationParameters parameters,
    ServiceConnection connection,
  ) async {
    final epoch = _epoch;
    final token = await connection.readSecret(vault);
    if (token == null || token.isEmpty) {
      throw const FormatException('请先在接入设置中保存当前渠道和地址的凭据。');
    }
    if (epoch != _epoch) throw const FormatException('任务已取消');
    final client = clientFactory();
    _active = client;
    try {
      final result = await NovelAiGenerationService(client: client).generate(
        parameters: parameters.copyWith(
          clearSourceImageId:
              parameters.operation != GenerationOperation.inpaint,
          clearMaskImageId: parameters.operation != GenerationOperation.inpaint,
          clearImg2imgSourceImageId:
              parameters.operation != GenerationOperation.imageToImage,
        ),
        provider: GenerationProviderConfig(
          protocol: NovelAiProtocol.values.byName(connection.protocol),
          baseUri: connection.uri,
          allowInsecureLoopbackForTesting: connection.uri.scheme == 'http',
        ),
        credential: GenerationCredential(token),
        resolveImage: assets.read,
      );
      if (epoch != _epoch) throw const FormatException('任务已取消');
      final asset = await assets.save(result.imageBytes);
      if (epoch != _epoch) throw const FormatException('任务已取消');
      final effective = result.effectiveParameters;
      return SceneResult(
        id: 'image-${DateTime.now().microsecondsSinceEpoch}-${asset.id.substring(0, 12)}',
        title: parameters.prompt.trim().isEmpty
            ? '生成图片'
            : parameters.prompt.trim().split('\n').first,
        prompt: effective.prompt,
        negative: effective.negativePrompt ?? '',
        width: asset.width,
        height: asset.height,
        seed: effective.seed!,
        variant: 0,
        favorite: false,
        isDemo: false,
        model:
            WorkbenchController.modelIds.entries
                .where((entry) => entry.value == effective.model)
                .firstOrNull
                ?.key ??
            effective.model,
        provider: connection.label,
        steps: effective.steps,
        cfg: effective.scale,
        assetRef: asset.assetRef,
        parameters: effective,
      );
    } on GenerationServiceException catch (error) {
      throw FormatException(error.message);
    } finally {
      client.close();
      if (identical(_active, client)) _active = null;
    }
  }
}

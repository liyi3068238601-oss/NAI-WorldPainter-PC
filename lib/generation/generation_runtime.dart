import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:http/http.dart' as http;

import '../media/image_asset_store.dart';
import '../references/vibe_encoding_scope.dart';
import '../references/vibe_library.dart';
import '../security/credential_vault.dart';
import '../prototype/workbench_controller.dart';
import 'generation_parameters.dart';
import 'generation_http_client.dart';
import 'novelai_generation_service.dart';
import 'service_connection.dart';

class GenerationRuntime {
  GenerationRuntime({
    required this.assets,
    required this.vault,
    VibeLibrary? vibeLibrary,
    void Function(VibeLibrary library)? onVibeLibraryChanged,
    int vibeCacheCapacity = VibeLibrary.defaultCacheCapacity,
    http.Client Function()? clientFactory,
  }) : clientFactory = clientFactory ?? createGenerationHttpClient,
       vibeLibrary =
           vibeLibrary ?? VibeLibrary(cacheCapacity: vibeCacheCapacity) {
    if (onVibeLibraryChanged != null) {
      this.vibeLibrary.onChanged = onVibeLibraryChanged;
    }
  }

  final ImageAssetStore assets;
  final CredentialVault vault;
  final http.Client Function() clientFactory;
  final VibeLibrary vibeLibrary;
  final Set<http.Client> _activeClients = <http.Client>{};
  int _epoch = 0;

  void cancel() {
    _epoch++;
    final clients = _activeClients.toList(growable: false);
    _activeClients.clear();
    for (final client in clients) {
      client.close();
    }
  }

  Future<SceneResult> generate(
    GenerationParameters parameters,
    ServiceConnection connection,
  ) async {
    final epoch = _epoch;
    final result = await generateBytes(parameters, connection);
    _checkEpoch(epoch);
    final asset = await assets.save(result.imageBytes);
    _checkEpoch(epoch);
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
  }

  /// Encodes a selected image and adds a named entry without starting image
  /// generation. Existing compatible cache values are reused.
  Future<VibeLibraryEntry> encodeVibe({
    required String sourceAssetRef,
    required String title,
    required String model,
    required ServiceConnection connection,
    double informationExtracted = 1.0,
    double strength = 0.3,
  }) async {
    if (!strength.isFinite || strength < 0 || strength > 1) {
      throw const FormatException('Vibe 强度必须在 0 到 1 之间。');
    }
    if (!informationExtracted.isFinite ||
        informationExtracted < 0 ||
        informationExtracted > 1 ||
        sourceAssetRef.trim().isEmpty) {
      throw const FormatException('Vibe 原图或信息提取强度无效。');
    }
    final epoch = _epoch;
    final token = await connection.readSecret(vault);
    _checkEpoch(epoch);
    if (token == null || token.isEmpty) {
      throw const FormatException('请先在接入设置中保存当前渠道和地址的凭据。');
    }

    final client = _createClient();
    try {
      final service = NovelAiGenerationService(client: client);
      final provider = _provider(connection);
      final endpoint = service.endpointForProtocol(provider);
      final wireModel = service.modelForProtocol(model, provider.protocol);
      service.validateVibeModel(wireModel, provider.protocol);
      final sourceBytes = await assets.read(sourceAssetRef);
      _checkEpoch(epoch);
      final sourceSha256 = sha256.convert(sourceBytes).toString();
      final scope = VibeEncodingScope(
        sourceAssetRef: sourceAssetRef,
        sourceSha256: sourceSha256,
        model: wireModel,
        providerProtocol: provider.protocol.name,
        endpoint: endpoint,
        informationExtracted: informationExtracted,
      );
      final cached = await vibeLibrary.getOrEncode(
        scope: scope,
        encode: () async {
          final encoded = await service.encodeVibe(
            sourceAssetId: sourceAssetRef,
            model: wireModel,
            provider: provider,
            credential: GenerationCredential(token),
            resolveImage: (assetId) => assetId == sourceAssetRef
                ? Future<Uint8List>.value(sourceBytes)
                : assets.read(assetId),
            informationExtracted: informationExtracted,
          );
          _checkEpoch(epoch);
          return encoded;
        },
      );
      _checkEpoch(epoch);
      return vibeLibrary.addEntry(
        title: title,
        sourceAssetRef: sourceAssetRef,
        sourceSha256: sourceSha256,
        encodedBytes: cached.encodedBytes,
        model: wireModel,
        providerProtocol: provider.protocol.name,
        endpoint: endpoint,
        informationExtracted: informationExtracted,
        strength: strength,
      );
    } on GenerationServiceException catch (error) {
      _throwRuntimeServiceError(error, epoch);
    } finally {
      _releaseClient(client);
    }
  }

  /// Returns bytes without adding intermediate tiles to the managed gallery.
  Future<GenerationResult> generateBytes(
    GenerationParameters parameters,
    ServiceConnection connection, {
    Uint8List? sourceImageBytes,
  }) async {
    final epoch = _epoch;
    final token = await connection.readSecret(vault);
    _checkEpoch(epoch);
    if (token == null || token.isEmpty) {
      throw const FormatException('请先在接入设置中保存当前渠道和地址的凭据。');
    }
    final client = _createClient();
    try {
      final service = NovelAiGenerationService(client: client);
      final provider = _provider(connection);
      final generationParameters = parameters.copyWith(
        clearSourceImageId: parameters.operation != GenerationOperation.inpaint,
        clearMaskImageId: parameters.operation != GenerationOperation.inpaint,
        clearImg2imgSourceImageId:
            parameters.operation != GenerationOperation.imageToImage,
      );
      final normalizedParameters = service.validateAndNormalizeParameters(
        generationParameters,
        provider,
      );
      final prepared = await _prepareVibeReferences(
        normalizedParameters,
        provider: provider,
        service: service,
        credential: GenerationCredential(token),
        epoch: epoch,
      );
      _checkEpoch(epoch);
      final result = await service.generate(
        parameters: prepared,
        provider: provider,
        credential: GenerationCredential(token),
        resolveImage: (id) =>
            sourceImageBytes != null && id == parameters.img2imgSourceImageId
            ? Future.value(sourceImageBytes)
            : assets.read(id),
      );
      _checkEpoch(epoch);
      return result;
    } on GenerationServiceException catch (error) {
      _throwRuntimeServiceError(error, epoch);
    } finally {
      _releaseClient(client);
    }
  }

  Future<GenerationParameters> _prepareVibeReferences(
    GenerationParameters parameters, {
    required GenerationProviderConfig provider,
    required NovelAiGenerationService service,
    required GenerationCredential credential,
    required int epoch,
  }) async {
    if (parameters.vibeReferences.isEmpty) return parameters;
    final endpoint = service.endpointForProtocol(provider);
    final wireModel = service.modelForProtocol(
      parameters.model,
      provider.protocol,
    );
    service.validateVibeModel(wireModel, provider.protocol);
    final references = <VibeReference>[];
    for (final reference in parameters.vibeReferences) {
      _checkEpoch(epoch);
      if (reference.assetId.trim().isEmpty) {
        if (reference.hasCompatibleImportedEncoding(
          model: wireModel,
          providerProtocol: provider.protocol.name,
          endpoint: endpoint,
        )) {
          references.add(reference);
          continue;
        }
        throw const FormatException(
          '导入的 Vibe 编码尚未确认模型和渠道。请在 Vibe 编码库中确认其兼容信息，或重新选择原图编码。',
        );
      }

      final sourceBytes = await assets.read(reference.assetId);
      _checkEpoch(epoch);
      final sourceSha256 = sha256.convert(sourceBytes).toString();
      if (reference.hasCompatibleEncoding(
        sourceAssetRef: reference.assetId,
        sourceSha256: sourceSha256,
        model: wireModel,
        providerProtocol: provider.protocol.name,
        endpoint: endpoint,
      )) {
        references.add(reference);
        continue;
      }

      final scope = VibeEncodingScope(
        sourceAssetRef: reference.assetId,
        sourceSha256: sourceSha256,
        model: wireModel,
        providerProtocol: provider.protocol.name,
        endpoint: endpoint,
        informationExtracted: reference.informationExtracted,
      );
      final cached = await vibeLibrary.getOrEncode(
        scope: scope,
        encode: () async {
          final encoded = await service.encodeVibe(
            sourceAssetId: reference.assetId,
            model: wireModel,
            provider: provider,
            credential: credential,
            resolveImage: (assetId) => assetId == reference.assetId
                ? Future<Uint8List>.value(sourceBytes)
                : assets.read(assetId),
            informationExtracted: reference.informationExtracted,
          );
          _checkEpoch(epoch);
          return encoded;
        },
      );
      _checkEpoch(epoch);
      references.add(
        reference.copyWith(
          encodedVibe: cached.encodedValue,
          encodedVibeScope: cached.scope,
        ),
      );
    }
    return parameters.copyWith(vibeReferences: references);
  }

  GenerationProviderConfig _provider(ServiceConnection connection) {
    final protocol = NovelAiProtocol.values.byName(connection.protocol);
    final uri = connection.uri;
    return GenerationProviderConfig(
      protocol: protocol,
      baseUri: uri,
      allowInsecureLoopbackForTesting: uri.scheme == 'http',
    );
  }

  http.Client _createClient() {
    final client = clientFactory();
    _activeClients.add(client);
    return client;
  }

  void _releaseClient(http.Client client) {
    if (_activeClients.remove(client)) client.close();
  }

  void _checkEpoch(int epoch) {
    if (epoch != _epoch) throw const FormatException('任务已取消');
  }

  Never _throwRuntimeServiceError(GenerationServiceException error, int epoch) {
    _checkEpoch(epoch);
    throw FormatException(error.message);
  }
}

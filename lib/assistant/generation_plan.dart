import 'dart:convert';

import '../editing/image_editing_session.dart';
import '../generation/generation_parameters.dart';
import '../generation/service_connection.dart';
import '../prototype/workbench_controller.dart';
import 'agent_contract.dart';

/// Reuses the editor's preparation and composition pipeline. All inputs are
/// frozen before confirmation; preparing a preview never sends a paid request.
class AssistantGenerationPlan {
  AssistantGenerationPlan._({
    required this.parameters,
    required this.connection,
    required this.preview,
    this.processResult,
    this.session,
  });

  final GenerationParameters parameters;
  final ServiceConnection connection;
  final Map<String, dynamic> preview;
  final ProcessGenerationResult? processResult;
  final ImageEditingSession? session;
  bool postProcessingFailed = false;
  String? error;
  bool _disposed = false;

  void dispose() {
    if (_disposed) return;
    _disposed = true;
    session?.dispose();
  }

  static Future<AssistantGenerationPlan> prepare({
    required WorkbenchController workbench,
    required GenerationParameters parameters,
    required ServiceConnection connection,
    required AgentCancellation cancellation,
    required void Function() checkDraft,
  }) async {
    void check() {
      cancellation.check();
      checkDraft();
    }

    check();
    connection.uri;
    final seed = workbench.seedText;
    if (seed.isNotEmpty &&
        (int.tryParse(seed) == null ||
            int.parse(seed) < 0 ||
            int.parse(seed) > 0xffffffff)) {
      throw const AgentException('Seed 必须为 0–4294967295 的整数，或留空随机。');
    }
    final state = workbench.imageEditing;
    var inputBinding = jsonEncode(workbench.assistantEditingInputs);
    final seenCandidateIds = {
      for (final candidate in state['candidates'] as List? ?? [])
        (candidate as Map)['raw']['id'],
    };
    var expectedPrimary = state['primaryId'];
    final preview = <String, dynamic>{
      '步数': parameters.steps,
      'CFG': parameters.scale,
      '采样器': parameters.sampler,
      '噪声计划': parameters.noiseSchedule,
    };
    if (parameters.operation == GenerationOperation.textToImage) {
      return AssistantGenerationPlan._(
        parameters: parameters,
        connection: connection,
        preview: preview,
      );
    }
    final assets = workbench.assets;
    if (assets == null) throw const AgentException('当前工作区没有图片存储。');
    return workbench.prepareEditing(() async {
      ImageEditingSession? session;
      try {
        if (parameters.operation == GenerationOperation.imageToImage) {
          final ref = parameters.img2imgSourceImageId;
          if (ref == null || ref.isEmpty) {
            throw const AgentException('请先在图生图工作台选择并裁切原图。');
          }
          final crop = state['img2img'] as Map?;
          if (crop != null &&
              (crop['preparedAssetRef'] != ref ||
                  crop['targetWidth'] != parameters.width ||
                  crop['targetHeight'] != parameters.height)) {
            throw const AgentException('当前裁切图与输出尺寸不一致，请重新裁切后发起。');
          }
          // Store validation verifies the opaque reference, digest, and codec.
          final input = await assets.save(await assets.read(ref));
          if (input.width != parameters.width ||
              input.height != parameters.height) {
            throw const AgentException('参考图尺寸与输出尺寸不一致，请重新裁切后发起。');
          }
          final original = crop?['originalAssetRef'] as String? ?? ref;
          if (original != ref) await assets.read(original);
          final strength = parameters.img2imgStrength ?? 0.7;
          if (!strength.isFinite || strength < 0.01 || strength > 1) {
            throw const AgentException('图生图强度必须在 0.01–1 之间。');
          }
          final effective = connection.protocol == 'official'
              ? strength.clamp(0.01, 0.99).toDouble()
              : strength;
          check();
          return AssistantGenerationPlan._(
            parameters: parameters.copyWith(img2imgStrength: effective),
            connection: connection,
            preview: {
              ...preview,
              'assetRef': ref,
              'originalAssetRef': original,
              'sourceCaption': '本次提交的裁切图',
              '强度': effective,
              if (crop != null) '裁切区域': crop['crop'],
            },
            processResult: (raw, current) async => raw.copyWith(
              editMetadata: {
                'operation': 'imageToImage',
                'parentAssetRef': original,
                'sourceCrop': crop,
                'session': state,
              },
            ),
          );
        }
        final strength = parameters.inpaintStrength ?? 1.0;
        if (!strength.isFinite || strength < 0.01 || strength > 1) {
          throw const AgentException('重绘强度必须在 0.01–1 之间。');
        }
        var restoring = true;
        session = ImageEditingSession(
          assets: assets,
          restored: state,
          onPersist: (next) {
            if (restoring ||
                cancellation.isCancelled ||
                workbench.closing ||
                jsonEncode(workbench.assistantEditingInputs) != inputBinding) {
              return;
            }
            // Preserve independently changed visibility/selection of existing
            // candidates. Only append the new response owned by this task.
            final live = workbench.imageEditing;
            final existing = live['candidates'] as List? ?? [];
            final additions = [
              for (final v in next['candidates'] as List? ?? [])
                if (!seenCandidateIds.contains((v as Map)['raw']['id'])) v,
            ];
            final primary = live['primaryId'] == expectedPrimary
                ? next['primaryId']
                : live['primaryId'];
            workbench.applyAssistantEditing({
              ...next,
              ...live,
              if (live.isEmpty) ...next,
              'candidates': [...existing, ...additions],
              'primaryId': primary,
            });
            seenCandidateIds.addAll(additions.map((v) => v['raw']['id']));
            expectedPrimary = primary;
            inputBinding = jsonEncode(workbench.assistantEditingInputs);
          },
        );
        if (session.document == null) {
          final ref = parameters.sourceImageId;
          if (ref == null || ref.isEmpty) {
            throw const AgentException('请先在重绘工作台导入原图并绘制蒙版。');
          }
          session.setSource(await assets.save(await assets.read(ref)));
          if (parameters.maskImageId != null) {
            await assets.read(parameters.maskImageId!);
            session.changeDocument(
              session.document!.copyWith(
                importedMaskAssetRef: parameters.maskImageId,
              ),
            );
          }
        }
        final frozen = await session.prepare(
          parameters.width,
          parameters.height,
        );
        check();
        restoring = false;
        final editor = session;
        final rect = frozen.prepared.sourceRect;
        return AssistantGenerationPlan._(
          parameters: parameters.copyWith(
            sourceImageId: frozen.sourceRef,
            maskImageId: frozen.maskRef,
            inpaintStrength: strength,
            clearImg2imgSourceImageId: true,
          ),
          connection: connection,
          preview: {
            ...preview,
            'assetRef': frozen.sourceRef,
            'maskAssetRef': frozen.maskRef,
            'originalAssetRef': frozen.document.sourceAssetRef,
            'sourceCaption': '本次提交的重绘区域',
            '强度': strength,
            '输出区域': '${rect.left}, ${rect.top}, ${rect.width} × ${rect.height}',
            '忽略原图': parameters.disabledOriginalImage,
            '色彩校正': parameters.colorCorrect,
          },
          session: editor,
          processResult: (raw, current) =>
              editor.acceptResult(raw, frozen, current),
        );
      } on AgentCancelled {
        session?.dispose();
        rethrow;
      } on AgentException {
        session?.dispose();
        rethrow;
      } on FormatException catch (e) {
        session?.dispose();
        throw AgentException(e.message);
      } catch (_) {
        session?.dispose();
        throw const AgentException('原图或蒙版准备失败，请检查当前图片和编辑区域。');
      }
    });
  }
}

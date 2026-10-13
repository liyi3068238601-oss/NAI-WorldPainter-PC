part of 'workbench.dart';

extension _EditingPanels on _WorkbenchState {
  bool get _editingBusy => preparingImage || c.generating || c.closing;

  Future<void> _restoreLegacyEditingReferences() async {
    final p = c.parameters;
    final ref = p.operation == GenerationOperation.inpaint
        ? p.sourceImageId
        : p.operation == GenerationOperation.imageToImage
        ? p.img2imgSourceImageId
        : null;
    if (ref == null ||
        !mounted ||
        editing == null ||
        c.imageEditing.isNotEmpty) {
      return;
    }
    try {
      final asset = await c.prepareEditing(
        () async => c.assets!.save(await c.assets!.read(ref)),
      );
      if (!mounted || c.closing || c.imageEditing.isNotEmpty) return;
      if (p.operation == GenerationOperation.inpaint) {
        editing!.setSource(asset);
        if (p.maskImageId != null) {
          editing!.changeDocument(
            editing!.document!.copyWith(importedMaskAssetRef: p.maskImageId),
          );
        }
      } else {
        editing!.setImg2img({
          'originalAssetRef': ref,
          'preparedAssetRef': ref,
          'originalWidth': asset.width,
          'originalHeight': asset.height,
          'targetWidth': p.width,
          'targetHeight': p.height,
          'crop': [0, 0, asset.width, asset.height],
        });
      }
    } catch (_) {
      if (mounted) _message('旧编辑素材暂时无法读取；原有参数仍保留，请重新选择素材。');
    }
  }

  Future<void> _importEditingSource() async {
    if (_editingBusy) return;
    try {
      final bytes = await pickImage();
      if (bytes == null || !mounted || c.closing) return;
      final asset = await c.prepareEditing(() => c.assets!.save(bytes));
      if (!mounted || c.closing) return;
      if (c.parameters.operation == GenerationOperation.imageToImage) {
        await _cropEditingSource(asset.assetRef, asset.width, asset.height);
      } else {
        editing!.setSource(asset);
        c.updateAdvanced(
          c.parameters.copyWith(
            sourceImageId: asset.assetRef,
            clearMaskImageId: true,
          ),
        );
      }
    } catch (_) {
      if (mounted) _message('原图读取失败，请选择有效的 PNG、JPEG 或 WebP。');
    }
  }

  Future<void> _useEditingSource({SceneResult? result}) async {
    if (_editingBusy) return;
    final source = result ?? c.selected;
    if (source.assetRef == null) {
      _message('请选择图库原图，或导入图片。');
      return;
    }
    try {
      final asset = await c.prepareEditing(
        () async => c.assets!.save(await c.assets!.read(source.assetRef!)),
      );
      if (!mounted || c.closing) return;
      if (c.parameters.operation == GenerationOperation.imageToImage) {
        await _cropEditingSource(
          asset.assetRef,
          asset.width,
          asset.height,
          parentId: source.id,
        );
      } else {
        editing!.setSource(asset, parentId: source.id);
        c.updateAdvanced(
          c.parameters.copyWith(
            sourceImageId: asset.assetRef,
            clearMaskImageId: true,
          ),
        );
      }
    } catch (_) {
      if (mounted) _message('无法读取原图；请检查图片文件后重试。');
    }
  }

  Future<void> _cropEditingSource(
    String ref,
    int width,
    int height, {
    String? parentId,
    Rect? initial,
  }) async {
    if (!mounted) return;
    final bytes = await c.assets!.read(ref);
    if (!mounted || c.closing) return;
    final result = await showImageCropDialog(
      context,
      bytes: bytes,
      imageWidth: width,
      imageHeight: height,
      targetWidth: c.width,
      targetHeight: c.height,
      initialCropRect: initial,
    );
    if (result == null || !mounted || c.closing) return;
    final prepared = await c.prepareEditing(
      () => c.assets!.save(result.pngBytes),
    );
    if (!mounted || c.closing) return;
    editing!.setImg2img({
      'originalAssetRef': ref,
      'preparedAssetRef': prepared.assetRef,
      'originalWidth': width,
      'originalHeight': height,
      'targetWidth': result.targetWidth,
      'targetHeight': result.targetHeight,
      'parentResultId': parentId,
      'crop': [
        result.cropRect.left,
        result.cropRect.top,
        result.cropRect.width,
        result.cropRect.height,
      ],
    });
    c.setSize(result.targetWidth, result.targetHeight);
    c.updateAdvanced(
      c.parameters.copyWith(img2imgSourceImageId: prepared.assetRef),
    );
    _message('参考图已裁切；原图保留，可随时重新裁切。');
  }

  Future<void> _recropEditingSource() async {
    if (_editingBusy) return;
    final crop = editing?.img2img;
    if (crop == null) return;
    final rect = (crop['crop'] as List).cast<num>();
    await _cropEditingSource(
      crop['originalAssetRef'] as String,
      crop['originalWidth'] as int,
      crop['originalHeight'] as int,
      parentId: crop['parentResultId'] as String?,
      initial: Rect.fromLTWH(
        rect[0].toDouble(),
        rect[1].toDouble(),
        rect[2].toDouble(),
        rect[3].toDouble(),
      ),
    );
  }

  Widget _editingSourceControls() {
    final p = c.parameters;
    final ref = p.operation == GenerationOperation.inpaint
        ? editing?.document?.sourceAssetRef
        : p.img2imgSourceImageId;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (ref != null)
          _assetRow(ref, '生成原图', () {
            if (_editingBusy) return;
            if (p.operation == GenerationOperation.inpaint) {
              editing?.clearSource();
              c.updateAdvanced(
                c.parameters.copyWith(
                  clearSourceImageId: true,
                  clearMaskImageId: true,
                ),
              );
            } else {
              editing?.setImg2img(null);
              c.updateAdvanced(
                c.parameters.copyWith(clearImg2imgSourceImageId: true),
              );
            }
          }),
        Wrap(
          spacing: 8,
          runSpacing: 6,
          children: [
            OutlinedButton(
              onPressed: _editingBusy ? null : _importEditingSource,
              child: Text(ref == null ? '导入原图' : '替换原图'),
            ),
            TextButton(
              onPressed: _editingBusy || c.selected.assetRef == null
                  ? null
                  : _useEditingSource,
              child: const Text('使用当前图片'),
            ),
            if (p.operation == GenerationOperation.imageToImage &&
                editing?.img2img != null)
              TextButton(
                onPressed: _editingBusy ? null : _recropEditingSource,
                child: const Text('重新裁切'),
              ),
          ],
        ),
        if (p.operation == GenerationOperation.imageToImage &&
            editing?.img2img != null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: _muted(
              '已裁切 ${editing!.img2img!['targetWidth']} × ${editing!.img2img!['targetHeight']} · 原图保持完整',
            ),
          ),
        if (p.operation == GenerationOperation.inpaint)
          _muted('在中央重绘工作区绘制蒙版与调整输出区域。'),
      ],
    );
  }

  Widget _editingMaskControls() => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      if (editing?.document?.importedMaskAssetRef != null)
        _assetRow(editing!.document!.importedMaskAssetRef!, '导入蒙版', () {
          if (_editingBusy) return;
          editing!.changeDocument(
            editing!.document!.copyWith(clearImportedMask: true),
          );
        }),
      OutlinedButton(
        onPressed: _editingBusy || editing?.document == null
            ? null
            : () async {
                final ref = await _importImage();
                if (ref == null || !mounted || c.closing) return;
                final d = editing?.document;
                if (d != null) {
                  editing!.changeDocument(
                    d.copyWith(importedMaskAssetRef: ref),
                  );
                }
              },
        child: const Text('导入黑白蒙版'),
      ),
      _muted('白色区域重绘，黑色区域保留；擦除和撤销同时作用于预览与提交蒙版。'),
    ],
  );

  Widget _inpaintWorkspace() => Padding(
    padding: const EdgeInsets.all(20),
    child: InpaintWorkspace(
      session: editing!,
      outputWidth: c.width,
      outputHeight: c.height,
      busy: _editingBusy,
      onImport: _importEditingSource,
      onUseCurrent: _useEditingSource,
      onSaveComposite: _saveEditingComposite,
      onApplyResult: _applyEditingResult,
      onScalePixels: _scaleEditingPixels,
    ),
  );

  Future<void> _submitEditedGeneration() async {
    if (_editingBusy) return;
    if (c.seedText.isNotEmpty &&
        (int.tryParse(c.seedText) == null ||
            int.parse(c.seedText) < 0 ||
            int.parse(c.seedText) > 4294967295)) {
      _message('Seed 必须为 0–4294967295 的整数，或留空随机。');
      return;
    }
    var params = c.parameters;
    if (params.operation == GenerationOperation.imageToImage &&
        editing!.img2img != null &&
        (editing!.img2img!['targetWidth'] != params.width ||
            editing!.img2img!['targetHeight'] != params.height)) {
      await _recropEditingSource();
      if (!mounted || c.closing) return;
      params = c.parameters;
      if (editing!.img2img!['targetWidth'] != params.width ||
          editing!.img2img!['targetHeight'] != params.height) {
        return;
      }
    }
    final connection = c.connection, count = c.batchCount;
    final state = editing!.snapshot(includeCandidates: false);
    FrozenInpaint? frozen;
    try {
      _setPreparing(true);
      if (params.operation == GenerationOperation.inpaint) {
        frozen = await c.prepareEditing(
          () => editing!.prepare(params.width, params.height),
        );
        params = params.copyWith(
          sourceImageId: frozen!.sourceRef,
          maskImageId: frozen.maskRef,
        );
      }
      if (!mounted || c.closing) return;
      _setPreparing(false);
      final submitted = params, frame = frozen;
      await c.generate(
        submitted: submitted,
        submittedConnection: connection,
        count: count,
        processResult: frame != null
            ? (raw, current) => editing!.acceptResult(raw, frame, current)
            : submitted.operation == GenerationOperation.imageToImage
            ? (raw, current) async => raw.copyWith(
                editMetadata: {
                  'operation': 'imageToImage',
                  'parentAssetRef': state['img2img'] is Map
                      ? (state['img2img'] as Map)['originalAssetRef']
                      : submitted.img2imgSourceImageId,
                  'sourceCrop': state['img2img'],
                  'session': state,
                },
              )
            : null,
      );
      if (mounted) _message(c.status);
    } on FormatException catch (e) {
      if (mounted) _message(e.message);
    } catch (_) {
      if (mounted) _message('编辑图片准备失败，请检查原图、蒙版和尺寸后重试。');
    } finally {
      if (mounted) _setPreparing(false);
    }
  }

  Future<void> _saveEditingComposite() async {
    if (_editingBusy) return;
    try {
      _setPreparing(true);
      final parameters = c.parameters, model = c.model, provider = c.provider;
      final result = await c.prepareEditing(
        () => editing!.saveComposite(
          parameters,
          model: model,
          provider: provider,
        ),
      );
      if (!mounted || c.closing) return;
      c.addDerived(result);
      await c.flush();
      _message('可见图层已合成并保存到图库。');
    } catch (_) {
      if (mounted) _message('合成保存失败，当前工作区仍保留。');
    } finally {
      if (mounted) _setPreparing(false);
    }
  }

  Future<void> _applyEditingResult() async {
    if (_editingBusy) return;
    try {
      _setPreparing(true);
      final asset = await c.prepareEditing(() => editing!.applyPrimary());
      if (!mounted || c.closing) return;
      c.updateAdvanced(
        c.parameters.copyWith(
          sourceImageId: asset.assetRef,
          clearMaskImageId: true,
        ),
      );
      await c.flush();
      _message('结果已作为新原图回填，可继续重绘。');
    } catch (_) {
      if (mounted) _message('请先选择有效的重绘结果。');
    } finally {
      if (mounted) _setPreparing(false);
    }
  }

  Future<void> _scaleEditingPixels(int factor) async {
    if (_editingBusy || editing?.document == null) return;
    try {
      _setPreparing(true);
      final d = editing!.document!;
      final bytes = await c.prepareEditing(
        () async => const InpaintRenderer().scalePixelArt(
          await c.assets!.read(d.sourceAssetRef),
          factor: factor,
        ),
      );
      final asset = await c.prepareEditing(() => c.assets!.save(bytes));
      if (!mounted || c.closing) return;
      editing!.setSource(asset, parentId: editing!.parentResultId);
      c.updateAdvanced(
        c.parameters.copyWith(
          sourceImageId: asset.assetRef,
          clearMaskImageId: true,
        ),
      );
      _message('图片已按像素放大 ${factor}x，原图保留。');
    } catch (_) {
      if (mounted) _message('图片放大失败，请检查尺寸限制。');
    } finally {
      if (mounted) _setPreparing(false);
    }
  }
}

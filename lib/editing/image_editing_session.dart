import 'dart:ui';

import 'package:flutter/foundation.dart';

import '../media/image_asset_store.dart';
import '../prototype/workbench_controller.dart';
import 'inpaint_document.dart';
import 'inpaint_renderer.dart';

class EditCandidate {
  const EditCandidate({
    required this.raw,
    required this.compositeRef,
    required this.layerRef,
    required this.worldRect,
    this.visible = true,
    this.kept = false,
  });
  final SceneResult raw;
  final String compositeRef, layerRef;
  final Rect worldRect;
  final bool visible, kept;
  EditCandidate copyWith({bool? visible, bool? kept}) => EditCandidate(
    raw: raw,
    compositeRef: compositeRef,
    layerRef: layerRef,
    worldRect: worldRect,
    visible: visible ?? this.visible,
    kept: kept ?? this.kept,
  );
  Map<String, Object?> toJson() => {
    'raw': raw.toJson(),
    'compositeRef': compositeRef,
    'layerRef': layerRef,
    'rect': [worldRect.left, worldRect.top, worldRect.width, worldRect.height],
    'visible': visible,
    'kept': kept,
  };
  factory EditCandidate.fromJson(Map data) {
    final r = (data['rect'] as List).cast<num>();
    return EditCandidate(
      raw: SceneResult.fromJson(Map<String, dynamic>.from(data['raw'] as Map)),
      compositeRef: data['compositeRef'] as String,
      layerRef: data['layerRef'] as String,
      worldRect: Rect.fromLTWH(
        r[0].toDouble(),
        r[1].toDouble(),
        r[2].toDouble(),
        r[3].toDouble(),
      ),
      visible: data['visible'] as bool? ?? true,
      kept: data['kept'] as bool? ?? false,
    );
  }
}

class FrozenInpaint {
  const FrozenInpaint({
    required this.document,
    required this.sourceBytes,
    required this.prepared,
    required this.sourceRef,
    required this.maskRef,
    required this.session,
    required this.sourceSessionId,
  });
  final InpaintDocument document;
  final Uint8List sourceBytes;
  final InpaintPrepared prepared;
  final String sourceRef, maskRef;
  final Map<String, Object?> session;
  final String sourceSessionId;
}

/// The editor's source stays independent of the gallery selection. Generating
/// adds candidates; applying a candidate explicitly starts a new source revision.
class ImageEditingSession extends ChangeNotifier {
  ImageEditingSession({
    required this.assets,
    required this.onPersist,
    Map<String, Object?> restored = const {},
  }) {
    restore(restored, notify: false);
  }
  final ImageAssetStore assets;
  final ValueChanged<Map<String, Object?>> onPersist;
  InpaintDocument? document;
  String? parentResultId;
  Map<String, Object?>? img2img;
  final List<InpaintDocument> _undo = [], _redo = [];
  final List<EditCandidate> _candidates = [];
  List<EditCandidate> get candidates => List.unmodifiable(_candidates);
  bool get canUndo => _undo.isNotEmpty;
  bool get canRedo => _redo.isNotEmpty;
  String? primaryId;
  int revision = 0;
  bool _disposed = false;
  static int _sessionSequence = 0;
  String _sourceSessionId = _newSourceSessionId();
  static String _newSourceSessionId() =>
      '${DateTime.now().microsecondsSinceEpoch}-${++_sessionSequence}';
  Map<String, Object?> snapshot({bool includeCandidates = true}) => {
    'version': 1,
    'sourceSessionId': _sourceSessionId,
    if (document != null) 'document': document!.toJson(),
    if (parentResultId != null) 'parentResultId': parentResultId,
    if (img2img != null) 'img2img': img2img,
    if (includeCandidates)
      'candidates': _candidates.map((c) => c.toJson()).toList(),
    if (includeCandidates) 'primaryId': primaryId,
    if (includeCandidates) 'undo': _undo.map((d) => d.toJson()).toList(),
    if (includeCandidates) 'redo': _redo.map((d) => d.toJson()).toList(),
  };
  void restore(Map<String, Object?> value, {bool notify = true}) {
    if (value.isNotEmpty && value['version'] != 1) {
      throw const FormatException('未知编辑工作区版本');
    }
    _sourceSessionId =
        value['sourceSessionId'] as String? ?? _newSourceSessionId();
    document = value['document'] is Map
        ? InpaintDocument.fromJson(
            Map<String, Object?>.from(value['document'] as Map),
          )
        : null;
    parentResultId = value['parentResultId'] as String?;
    img2img = value['img2img'] is Map
        ? Map<String, Object?>.from(value['img2img'] as Map)
        : null;
    _candidates
      ..clear()
      ..addAll(
        (value['candidates'] as List? ?? []).map(
          (v) => EditCandidate.fromJson(v as Map),
        ),
      );
    primaryId = value['primaryId'] as String?;
    for (final pair in [(_undo, value['undo']), (_redo, value['redo'])]) {
      pair.$1
        ..clear()
        ..addAll(
          (pair.$2 as List? ?? []).map(
            (v) =>
                InpaintDocument.fromJson(Map<String, Object?>.from(v as Map)),
          ),
        );
    }
    revision++;
    if (notify) notifyListeners();
  }

  void _changed() {
    if (_disposed) return;
    revision++;
    onPersist(snapshot());
    notifyListeners();
  }

  void setSource(ImageAsset asset, {String? parentId, Rect? region}) {
    _sourceSessionId = _newSourceSessionId();
    document = InpaintDocument(
      sourceAssetRef: asset.assetRef,
      sourceWidth: asset.width,
      sourceHeight: asset.height,
      sourceRect: region,
      fullImageMode: region == null,
    );
    parentResultId = parentId;
    _undo.clear();
    _redo.clear();
    _candidates.clear();
    primaryId = null;
    _changed();
  }

  void clearSource() {
    _sourceSessionId = _newSourceSessionId();
    document = null;
    parentResultId = null;
    _undo.clear();
    _redo.clear();
    _candidates.clear();
    primaryId = null;
    _changed();
  }

  void setImg2img(Map<String, Object?>? value) {
    img2img = value;
    _changed();
  }

  void changeDocument(InpaintDocument next, {bool undoable = true}) {
    if (document == null || next.sourceAssetRef != document!.sourceAssetRef) {
      return;
    }
    if (undoable) {
      _undo.add(document!);
      if (_undo.length > 100) _undo.removeAt(0);
      _redo.clear();
    }
    document = next;
    _changed();
  }

  void undo() {
    if (!canUndo) return;
    _redo.add(document!);
    document = _undo.removeLast();
    _changed();
  }

  void redo() {
    if (!canRedo) return;
    _undo.add(document!);
    document = _redo.removeLast();
    _changed();
  }

  void addStroke(InpaintStroke stroke) {
    final d = document;
    if (d == null) return;
    changeDocument(d.copyWith(strokes: [...d.strokes, stroke]));
  }

  void clearMask() {
    final d = document;
    if (d == null) return;
    changeDocument(
      d.copyWith(
        strokes: d.strokes
            .where((s) => s.target != InpaintTarget.mask)
            .toList(),
        clearImportedMask: true,
      ),
    );
  }

  Future<Uint8List?> importedMask(InpaintDocument d) async =>
      d.importedMaskAssetRef == null
      ? null
      : assets.read(d.importedMaskAssetRef!);

  Future<FrozenInpaint> prepare(int width, int height) async {
    final d = document;
    if (d == null) throw const FormatException('请先导入重绘原图');
    final state = snapshot(includeCandidates: false);
    final sourceSessionId = _sourceSessionId;
    final source = await assets.read(d.sourceAssetRef);
    final prepared = await const InpaintRenderer().prepareRequest(
      sourceBytes: source,
      document: d,
      targetWidth: width,
      targetHeight: height,
      importedMaskBytes: await importedMask(d),
    );
    if (!prepared.hasMaskedPixels) {
      throw const FormatException('请先绘制蒙版，或将输出区域移到原图外。');
    }
    final image = await assets.save(prepared.imagePng),
        mask = await assets.save(prepared.maskPng);
    return FrozenInpaint(
      document: d,
      sourceBytes: source,
      prepared: prepared,
      sourceRef: image.assetRef,
      maskRef: mask.assetRef,
      session: state,
      sourceSessionId: sourceSessionId,
    );
  }

  Future<SceneResult> acceptResult(
    SceneResult raw,
    FrozenInpaint frozen,
    bool Function() isCurrent,
  ) async {
    if (raw.assetRef == null) throw const FormatException('生成结果没有原图');
    final generated = await assets.read(raw.assetRef!);
    final layer = await const InpaintRenderer().maskGeneratedLayer(
      generatedBytes: generated,
      maskBytes: frozen.prepared.maskPng,
      outwardFeatherPixels: frozen.document.featherPixels,
    );
    final layerAsset = await assets.save(layer);
    final composite = await const InpaintRenderer().composeLayers(
      sourceBytes: frozen.sourceBytes,
      document: frozen.document,
      layers: [
        InpaintLayer(bytes: layer, worldRect: frozen.prepared.sourceRect),
      ],
    );
    final asset = await assets.save(composite.bytes);
    if (!isCurrent() || _disposed) throw const FormatException('任务已取消');
    final candidate = EditCandidate(
      raw: raw,
      compositeRef: asset.assetRef,
      layerRef: layerAsset.assetRef,
      worldRect: frozen.prepared.sourceRect,
    );
    if (_sourceSessionId == frozen.sourceSessionId &&
        document?.sourceAssetRef == frozen.document.sourceAssetRef) {
      _candidates.add(candidate);
      primaryId = raw.id;
      _changed();
    }
    return raw.copyWith(
      assetRef: asset.assetRef,
      width: asset.width,
      height: asset.height,
      title: '重绘 · ${raw.title}',
      editMetadata: {
        'operation': 'inpaint',
        'parentAssetRef': frozen.document.sourceAssetRef,
        'parentResultId': frozen.session['parentResultId'],
        'responseAssetRef': raw.assetRef,
        'layerAssetRef': layerAsset.assetRef,
        'originX': composite.originX,
        'originY': composite.originY,
        'session': frozen.session,
      },
    );
  }

  void choosePrimary(String id) {
    if (_candidates.any((c) => c.raw.id == id)) {
      primaryId = id;
      _changed();
    }
  }

  void toggleVisible(String id) {
    final i = _candidates.indexWhere((c) => c.raw.id == id);
    if (i < 0) return;
    _candidates[i] = _candidates[i].copyWith(visible: !_candidates[i].visible);
    _changed();
  }

  void toggleKept(String id) {
    final i = _candidates.indexWhere((c) => c.raw.id == id);
    if (i < 0) return;
    _candidates[i] = _candidates[i].copyWith(kept: !_candidates[i].kept);
    _changed();
  }

  void removeCandidate(String id) {
    _candidates.removeWhere((c) => c.raw.id == id);
    if (primaryId == id) primaryId = _candidates.lastOrNull?.raw.id;
    _changed();
  }

  Future<InpaintComposite> compose() async {
    final d = document;
    if (d == null) throw const FormatException('请先导入原图');
    final source = await assets.read(d.sourceAssetRef);
    final layers = <InpaintLayer>[];
    for (final c in _candidates.where((c) => c.visible)) {
      layers.add(
        InpaintLayer(
          bytes: await assets.read(c.layerRef),
          worldRect: c.worldRect,
        ),
      );
    }
    return const InpaintRenderer().composeLayers(
      sourceBytes: source,
      document: d,
      layers: layers,
    );
  }

  Future<ImageAsset> applyPrimary() async {
    final candidate = _candidates
        .where((c) => c.raw.id == primaryId)
        .firstOrNull;
    if (candidate == null) throw const FormatException('请先选择主结果');
    final asset = await assets.save(await assets.read(candidate.compositeRef));
    if (_disposed) return asset;
    setSource(asset, parentId: candidate.raw.id);
    return asset;
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}

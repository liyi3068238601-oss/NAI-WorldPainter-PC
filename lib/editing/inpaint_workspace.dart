import 'dart:async';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'image_editing_session.dart';
import 'inpaint_document.dart';
import 'inpaint_renderer.dart';

/// Desktop workspace for preparing and reviewing local image edits.
///
/// All drawing and selection geometry is stored in source-image pixels. The
/// preview is rendered from the editing session and never replaces its source.
class InpaintWorkspace extends StatefulWidget {
  const InpaintWorkspace({
    super.key,
    required this.session,
    required this.outputWidth,
    required this.outputHeight,
    required this.busy,
    required this.onImport,
    required this.onUseCurrent,
    required this.onSaveComposite,
    required this.onApplyResult,
    required this.onScalePixels,
  });

  final ImageEditingSession session;
  final int outputWidth;
  final int outputHeight;
  final bool busy;
  final VoidCallback onImport;
  final VoidCallback onUseCurrent;
  final Future<void> Function() onSaveComposite;
  final Future<void> Function() onApplyResult;
  final Future<void> Function(int factor) onScalePixels;

  @override
  State<InpaintWorkspace> createState() => _InpaintWorkspaceState();
}

enum _WorkspaceTool { paint, erase, pan, moveSource, select }

enum _FrameDrag { move, resize }

class _FrameHandle {
  const _FrameHandle(this.id, this.center);

  final String id;
  final ui.Offset center;
}

class _InpaintWorkspaceState extends State<InpaintWorkspace> {
  final InpaintRenderer _renderer = const InpaintRenderer();
  final GlobalKey _canvasKey = GlobalKey();
  late final FocusNode _canvasFocus;

  ui.Image? _compositeImage;
  ui.Image? _requestMaskImage;
  ui.Rect? _requestMaskRect;
  int _previewEpoch = 0;
  int _maskPreviewEpoch = 0;
  Timer? _previewDebounce;
  bool _previewLoading = false;
  String? _previewError;

  _WorkspaceTool _tool = _WorkspaceTool.paint;
  InpaintTarget _target = InpaintTarget.mask;
  InpaintBrushShape _brushShape = InpaintBrushShape.round;
  double _brushSize = 48;
  double _brushOpacity = 1;
  int _brushColor = 0xffff4d4f;
  bool _maskVisible = true;

  double _zoom = 1;
  bool _pixelZoom = false;
  bool _scrollLocked = false;
  final Set<int> _activeCanvasPointers = <int>{};
  ui.Offset _panOffset = ui.Offset.zero;
  ui.Size _canvasSize = ui.Size.zero;

  ui.Rect? _selectionDraft;
  ui.Rect _gestureStartRect = ui.Rect.zero;
  ui.Offset _gestureStartSource = ui.Offset.zero;
  _FrameDrag? _frameDrag;
  String? _resizeHandle;
  ui.Offset _panStart = ui.Offset.zero;
  ui.Offset _panStartOffset = ui.Offset.zero;
  List<ui.Offset> _draftPoints = <ui.Offset>[];
  InpaintStroke? _draftStroke;

  @override
  void initState() {
    super.initState();
    _canvasFocus = FocusNode(debugLabel: '重绘画布快捷键');
    widget.session.addListener(_handleSessionChanged);
    _refreshComposite();
    _refreshRequestMask();
  }

  @override
  void didUpdateWidget(covariant InpaintWorkspace oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!oldWidget.busy && widget.busy) {
      _draftStroke = null;
      _draftPoints = <ui.Offset>[];
      _selectionDraft = null;
      _frameDrag = null;
      _activeCanvasPointers.clear();
      _scrollLocked = false;
    }
    if (oldWidget.session != widget.session) {
      oldWidget.session.removeListener(_handleSessionChanged);
      widget.session.addListener(_handleSessionChanged);
      _selectionDraft = null;
      _previewDebounce?.cancel();
      _refreshComposite();
      _refreshRequestMask();
    } else if (oldWidget.outputWidth != widget.outputWidth ||
        oldWidget.outputHeight != widget.outputHeight) {
      setState(() => _selectionDraft = null);
      _previewDebounce?.cancel();
      _refreshRequestMask();
    }
  }

  @override
  void dispose() {
    widget.session.removeListener(_handleSessionChanged);
    _canvasFocus.dispose();
    _previewDebounce?.cancel();
    _previewEpoch++;
    _maskPreviewEpoch++;
    _compositeImage?.dispose();
    _requestMaskImage?.dispose();
    super.dispose();
  }

  void _handleSessionChanged() {
    _selectionDraft = null;
    if (mounted) setState(() {});
    _previewDebounce?.cancel();
    _previewDebounce = Timer(const Duration(milliseconds: 120), () {
      _refreshComposite();
      _refreshRequestMask();
    });
  }

  Future<void> _refreshComposite() async {
    final epoch = ++_previewEpoch;
    final revision = widget.session.revision;
    if (widget.session.document == null) {
      final old = _compositeImage;
      if (mounted) {
        setState(() {
          _compositeImage = null;
          _previewLoading = false;
          _previewError = null;
        });
      }
      old?.dispose();
      return;
    }

    if (mounted) {
      setState(() {
        _previewLoading = true;
        _previewError = null;
      });
    }
    ui.Image? nextImage;
    try {
      final composite = await widget.session.compose();
      nextImage = await _decodeImage(composite.bytes);
      if (!mounted ||
          epoch != _previewEpoch ||
          revision != widget.session.revision) {
        nextImage.dispose();
        return;
      }
      final oldImage = _compositeImage;
      setState(() {
        _compositeImage = nextImage;
        _lastCompositeOriginX = composite.originX;
        _lastCompositeOriginY = composite.originY;
        _previewLoading = false;
        _previewError = null;
      });
      nextImage = null;
      if (oldImage != null) {
        WidgetsBinding.instance.addPostFrameCallback((_) => oldImage.dispose());
      }
    } catch (_) {
      nextImage?.dispose();
      if (!mounted || epoch != _previewEpoch) return;
      setState(() {
        _previewLoading = false;
        _previewError = '工作区预览暂不可用';
      });
    }
  }

  Future<void> _refreshRequestMask() async {
    final epoch = ++_maskPreviewEpoch;
    final document = widget.session.document;
    if (document == null) {
      final old = _requestMaskImage;
      if (mounted) {
        setState(() {
          _requestMaskImage = null;
          _requestMaskRect = null;
        });
      }
      old?.dispose();
      return;
    }
    final revision = widget.session.revision;
    final outputWidth = widget.outputWidth;
    final outputHeight = widget.outputHeight;
    ui.Image? maskImage;
    try {
      final sourceBytes = await widget.session.assets.read(
        document.sourceAssetRef,
      );
      final prepared = await _renderer.prepareRequest(
        sourceBytes: sourceBytes,
        document: document,
        targetWidth: outputWidth,
        targetHeight: outputHeight,
        importedMaskBytes: await widget.session.importedMask(document),
      );
      maskImage = await _decodeMaskOverlay(prepared.maskPng);
      if (!mounted ||
          epoch != _maskPreviewEpoch ||
          revision != widget.session.revision ||
          outputWidth != widget.outputWidth ||
          outputHeight != widget.outputHeight) {
        maskImage.dispose();
        return;
      }
      final oldImage = _requestMaskImage;
      setState(() {
        _requestMaskImage = maskImage;
        _requestMaskRect = prepared.sourceRect;
      });
      maskImage = null;
      if (oldImage != null) {
        WidgetsBinding.instance.addPostFrameCallback((_) => oldImage.dispose());
      }
    } catch (_) {
      maskImage?.dispose();
      if (!mounted || epoch != _maskPreviewEpoch) return;
      final oldImage = _requestMaskImage;
      setState(() {
        _requestMaskImage = null;
        _requestMaskRect = null;
      });
      oldImage?.dispose();
    }
  }

  Future<ui.Image> _decodeMaskOverlay(List<int> bytes) async {
    final mask = await _decodeImage(bytes);
    try {
      final data = await mask.toByteData(format: ui.ImageByteFormat.rawRgba);
      if (data == null) throw StateError('蒙版预览像素读取失败');
      final rgba = data.buffer.asUint8List(
        data.offsetInBytes,
        data.lengthInBytes,
      );
      final pixelCount = mask.width * mask.height;
      if (rgba.length != pixelCount * 4) {
        throw StateError('蒙版预览像素长度与图像尺寸不匹配');
      }
      final overlay = Uint8List(pixelCount * 4);
      for (var i = 0; i < pixelCount; i++) {
        final offset = i * 4;
        final luminance =
            (rgba[offset] * 2126 +
                rgba[offset + 1] * 7152 +
                rgba[offset + 2] * 722 +
                5000) ~/
            10000;
        final coverage = (luminance * rgba[offset + 3] + 127) ~/ 255;
        overlay[offset] = (255 * coverage + 127) ~/ 255;
        overlay[offset + 1] = (77 * coverage + 127) ~/ 255;
        overlay[offset + 2] = (79 * coverage + 127) ~/ 255;
        overlay[offset + 3] = coverage;
      }
      final buffer = await ui.ImmutableBuffer.fromUint8List(overlay);
      try {
        final descriptor = ui.ImageDescriptor.raw(
          buffer,
          width: mask.width,
          height: mask.height,
          pixelFormat: ui.PixelFormat.rgba8888,
          // Keep the packed default stride. This Flutter Web SDK version
          // interprets explicit rowBytes as pixels when creating raw images.
        );
        try {
          final codec = await descriptor.instantiateCodec();
          try {
            final frame = await codec.getNextFrame();
            return frame.image;
          } finally {
            codec.dispose();
          }
        } finally {
          descriptor.dispose();
        }
      } finally {
        buffer.dispose();
      }
    } finally {
      mask.dispose();
    }
  }

  Future<ui.Image> _decodeImage(List<int> bytes) async {
    final codec = await ui.instantiateImageCodec(
      bytes is Uint8List ? bytes : Uint8List.fromList(bytes),
    );
    try {
      final frame = await codec.getNextFrame();
      return frame.image;
    } finally {
      codec.dispose();
    }
  }

  InpaintDocument? get _document => widget.session.document;

  ui.Rect? get _selection {
    final document = _document;
    if (document == null) return null;
    return _selectionDraft ?? document.effectiveSourceRect;
  }

  double get _sourceScale {
    final document = _document;
    if (document == null || _canvasSize.isEmpty) return 1;
    final fit = math.min(
      _canvasSize.width / document.sourceWidth,
      _canvasSize.height / document.sourceHeight,
    );
    return fit * _zoom;
  }

  ui.Offset get _sourceOrigin {
    final document = _document;
    if (document == null || _canvasSize.isEmpty) return ui.Offset.zero;
    final scale = _sourceScale;
    return ui.Offset(
      (_canvasSize.width - document.sourceWidth * scale) / 2 + _panOffset.dx,
      (_canvasSize.height - document.sourceHeight * scale) / 2 + _panOffset.dy,
    );
  }

  ui.Offset _stageToSource(ui.Offset stagePoint) {
    final scale = _sourceScale;
    final origin = _sourceOrigin;
    return ui.Offset(
      (stagePoint.dx - origin.dx) / scale,
      (stagePoint.dy - origin.dy) / scale,
    );
  }

  ui.Offset _sourceToStage(ui.Offset sourcePoint) {
    final origin = _sourceOrigin;
    final scale = _sourceScale;
    return ui.Offset(
      origin.dx + sourcePoint.dx * scale,
      origin.dy + sourcePoint.dy * scale,
    );
  }

  ui.Offset _globalToStage(ui.Offset globalPosition) {
    final renderObject = _canvasKey.currentContext?.findRenderObject();
    if (renderObject is! RenderBox || !renderObject.hasSize) {
      return ui.Offset.zero;
    }
    return renderObject.globalToLocal(globalPosition);
  }

  ui.Rect _sourceRectToStage(ui.Rect sourceRect) {
    final topLeft = _sourceToStage(sourceRect.topLeft);
    final bottomRight = _sourceToStage(sourceRect.bottomRight);
    return ui.Rect.fromPoints(topLeft, bottomRight);
  }

  void _selectTool(_WorkspaceTool tool) {
    if (_tool == tool) return;
    setState(() => _tool = tool);
  }

  KeyEventResult _handleCanvasKey(FocusNode node, KeyEvent event) {
    if (widget.busy ||
        event is! KeyDownEvent ||
        FocusManager.instance.primaryFocus != _canvasFocus) {
      return KeyEventResult.ignored;
    }
    final keyboard = HardwareKeyboard.instance;
    final control = keyboard.isControlPressed || keyboard.isMetaPressed;
    if (control && event.logicalKey == LogicalKeyboardKey.keyZ) {
      widget.session.undo();
      return KeyEventResult.handled;
    }
    if (control && event.logicalKey == LogicalKeyboardKey.keyY) {
      widget.session.redo();
      return KeyEventResult.handled;
    }
    if (control) return KeyEventResult.ignored;
    switch (event.logicalKey) {
      case LogicalKeyboardKey.keyB:
        _selectTool(_WorkspaceTool.paint);
        return KeyEventResult.handled;
      case LogicalKeyboardKey.keyE:
        _selectTool(_WorkspaceTool.erase);
        return KeyEventResult.handled;
      case LogicalKeyboardKey.keyV:
        _selectTool(_WorkspaceTool.pan);
        return KeyEventResult.handled;
      case LogicalKeyboardKey.keyR:
        _activateRegionTool();
        return KeyEventResult.handled;
      case LogicalKeyboardKey.keyH:
        setState(() => _maskVisible = !_maskVisible);
        return KeyEventResult.handled;
      default:
        return KeyEventResult.ignored;
    }
  }

  void _activateRegionTool() {
    final document = _document;
    if (document == null) return;
    if (document.fullImageMode) {
      final rect = _defaultSelection(document);
      widget.session.changeDocument(
        document.copyWith(sourceRect: rect, fullImageMode: false),
      );
    }
    _selectTool(_WorkspaceTool.select);
  }

  void _activateMoveSourceTool() {
    final document = _document;
    if (document == null) return;
    if (document.fullImageMode) {
      widget.session.changeDocument(
        document.copyWith(
          sourceRect: _defaultSelection(document),
          fullImageMode: false,
        ),
      );
    }
    _selectTool(_WorkspaceTool.moveSource);
  }

  ui.Rect _defaultSelection(InpaintDocument document) {
    final ratio = widget.outputWidth / widget.outputHeight;
    final width = math.min(
      document.sourceWidth * 0.75,
      document.sourceHeight * 0.75 * ratio,
    );
    final height = width / ratio;
    return ui.Rect.fromCenter(
      center: ui.Offset(document.sourceWidth / 2, document.sourceHeight / 2),
      width: math.max(8, width).toDouble(),
      height: math.max(8, height).toDouble(),
    );
  }

  void _setFullImage() {
    final document = _document;
    if (document == null) return;
    widget.session.changeDocument(
      document.copyWith(fullImageMode: true, clearSourceRect: true),
    );
    setState(() => _tool = _WorkspaceTool.paint);
  }

  void _setRegion() => _activateRegionTool();

  void _updateDocument(
    InpaintDocument Function(InpaintDocument) update, {
    bool undoable = false,
  }) {
    final document = _document;
    if (document == null) return;
    widget.session.changeDocument(update(document), undoable: undoable);
  }

  void _canvasPanStart(DragStartDetails details) {
    _canvasFocus.requestFocus();
    if (widget.busy) return;
    final document = _document;
    if (document == null) return;
    final screenPoint = details.localPosition;
    final sourcePoint = _stageToSource(screenPoint);
    _gestureStartSource = sourcePoint;
    _frameDrag = null;
    _resizeHandle = null;

    switch (_tool) {
      case _WorkspaceTool.paint:
      case _WorkspaceTool.erase:
        _draftPoints = <ui.Offset>[sourcePoint];
        _draftStroke = _createStroke(_draftPoints);
        setState(() {});
        break;
      case _WorkspaceTool.pan:
        _panStart = screenPoint;
        _panStartOffset = _panOffset;
        break;
      case _WorkspaceTool.moveSource:
        _frameDrag = _FrameDrag.move;
        _gestureStartRect = _selection ?? document.effectiveSourceRect;
        _panStart = screenPoint;
        _panStartOffset = _panOffset;
        break;
      case _WorkspaceTool.select:
        final currentSelection = _selection;
        _gestureStartRect = currentSelection ?? document.effectiveSourceRect;
        _selectionDraft = ui.Rect.fromLTWH(
          sourcePoint.dx,
          sourcePoint.dy,
          1,
          1,
        );
        setState(() {});
        break;
    }
  }

  void _canvasTapUp(TapUpDetails details) {
    if (widget.busy ||
        _document == null ||
        (_tool != _WorkspaceTool.paint && _tool != _WorkspaceTool.erase)) {
      return;
    }
    final point = _stageToSource(details.localPosition);
    widget.session.addStroke(_createStroke(<ui.Offset>[point]));
  }

  void _canvasPanUpdate(DragUpdateDetails details) {
    if (widget.busy) return;
    final document = _document;
    if (document == null) return;
    switch (_tool) {
      case _WorkspaceTool.paint:
      case _WorkspaceTool.erase:
        _draftPoints.add(_stageToSource(details.localPosition));
        _draftStroke = _createStroke(_draftPoints);
        setState(() {});
        break;
      case _WorkspaceTool.pan:
        setState(() {
          _panOffset = _panStartOffset + (details.localPosition - _panStart);
        });
        break;
      case _WorkspaceTool.moveSource:
        final screenDelta = details.localPosition - _panStart;
        final sourceDelta = screenDelta / _sourceScale;
        setState(() {
          _panOffset = _panStartOffset + screenDelta;
          _selectionDraft = _gestureStartRect.shift(
            ui.Offset(-sourceDelta.dx, -sourceDelta.dy),
          );
        });
        break;
      case _WorkspaceTool.select:
        final now = _stageToSource(details.localPosition);
        setState(
          () => _selectionDraft = _aspectRectFromDrag(
            _gestureStartSource,
            now,
            widget.outputWidth / widget.outputHeight,
          ),
        );
        break;
    }
  }

  void _canvasPanEnd(DragEndDetails details) {
    if (widget.busy) {
      _draftStroke = null;
      _draftPoints = <ui.Offset>[];
      _selectionDraft = null;
      _frameDrag = null;
      return;
    }
    switch (_tool) {
      case _WorkspaceTool.paint:
      case _WorkspaceTool.erase:
        final stroke = _draftStroke;
        _draftStroke = null;
        _draftPoints = <ui.Offset>[];
        if (stroke != null && stroke.points.isNotEmpty) {
          widget.session.addStroke(stroke);
        } else {
          setState(() {});
        }
        break;
      case _WorkspaceTool.pan:
        break;
      case _WorkspaceTool.moveSource:
      case _WorkspaceTool.select:
        _commitSelection();
        break;
    }
    _frameDrag = null;
    _resizeHandle = null;
  }

  InpaintStroke _createStroke(List<ui.Offset> points) => InpaintStroke(
    target: _target,
    operation: _tool == _WorkspaceTool.erase
        ? InpaintOperation.erase
        : InpaintOperation.paint,
    geometry: InpaintGeometry.brush,
    points: points,
    size: _brushSize,
    color: _brushColor,
    opacity: _brushOpacity,
    brushShape: _brushShape,
  );

  ui.Rect _aspectRectFromDrag(
    ui.Offset anchor,
    ui.Offset current,
    double aspect,
  ) {
    final delta = current - anchor;
    final width = math
        .max(8, math.max(delta.dx.abs(), delta.dy.abs() * aspect))
        .toDouble();
    final height = width / aspect;
    final left = delta.dx < 0 ? anchor.dx - width : anchor.dx;
    final top = delta.dy < 0 ? anchor.dy - height : anchor.dy;
    return ui.Rect.fromLTWH(left, top, width, height);
  }

  void _beginFrameDrag(
    _FrameDrag mode,
    ui.Offset globalPosition, {
    String? handle,
  }) {
    if (widget.busy) return;
    _canvasFocus.requestFocus();
    final selection = _selection;
    if (selection == null) return;
    _frameDrag = mode;
    _resizeHandle = handle;
    _gestureStartRect = selection;
    _gestureStartSource = _stageToSource(_globalToStage(globalPosition));
  }

  void _updateFrameDrag(ui.Offset globalPosition) {
    if (widget.busy) return;
    final mode = _frameDrag;
    if (mode == null) return;
    final currentSource = _stageToSource(_globalToStage(globalPosition));
    final delta = currentSource - _gestureStartSource;
    setState(() {
      if (mode == _FrameDrag.move) {
        _selectionDraft = _gestureStartRect.shift(delta);
      } else if (mode == _FrameDrag.resize) {
        _selectionDraft = _resizeRect(
          _gestureStartRect,
          _resizeHandle ?? 'bottomRight',
          delta,
          widget.outputWidth / widget.outputHeight,
        );
      }
    });
  }

  void _endFrameDrag() {
    if (widget.busy) return;
    _commitSelection();
    _frameDrag = null;
    _resizeHandle = null;
  }

  void _commitSelection() {
    final rect = _selectionDraft;
    final document = _document;
    if (rect != null && document != null && rect.width > 0 && rect.height > 0) {
      widget.session.changeDocument(
        document.copyWith(sourceRect: rect, fullImageMode: false),
      );
    }
    _selectionDraft = null;
    if (mounted) setState(() {});
  }

  ui.Rect _resizeRect(
    ui.Rect start,
    String handle,
    ui.Offset delta,
    double aspect,
  ) {
    double width;
    switch (handle) {
      case 'topLeft':
        width =
            ((start.width - delta.dx) + (start.height - delta.dy) * aspect) / 2;
        break;
      case 'top':
        width = (start.height - delta.dy) * aspect;
        break;
      case 'topRight':
        width =
            ((start.width + delta.dx) + (start.height - delta.dy) * aspect) / 2;
        break;
      case 'right':
        width = start.width + delta.dx;
        break;
      case 'bottomRight':
        width =
            ((start.width + delta.dx) + (start.height + delta.dy) * aspect) / 2;
        break;
      case 'bottom':
        width = (start.height + delta.dy) * aspect;
        break;
      case 'bottomLeft':
        width =
            ((start.width - delta.dx) + (start.height + delta.dy) * aspect) / 2;
        break;
      case 'left':
        width = start.width - delta.dx;
        break;
      default:
        width = start.width + delta.dx;
        break;
    }
    width = math.max(8, width);
    final height = width / aspect;
    switch (handle) {
      case 'topLeft':
        return ui.Rect.fromLTRB(
          start.right - width,
          start.bottom - height,
          start.right,
          start.bottom,
        );
      case 'top':
        return ui.Rect.fromLTRB(
          start.center.dx - width / 2,
          start.bottom - height,
          start.center.dx + width / 2,
          start.bottom,
        );
      case 'topRight':
        return ui.Rect.fromLTRB(
          start.left,
          start.bottom - height,
          start.left + width,
          start.bottom,
        );
      case 'right':
        return ui.Rect.fromLTRB(
          start.left,
          start.center.dy - height / 2,
          start.left + width,
          start.center.dy + height / 2,
        );
      case 'bottomRight':
        return ui.Rect.fromLTWH(start.left, start.top, width, height);
      case 'bottom':
        return ui.Rect.fromLTRB(
          start.center.dx - width / 2,
          start.top,
          start.center.dx + width / 2,
          start.top + height,
        );
      case 'bottomLeft':
        return ui.Rect.fromLTRB(
          start.right - width,
          start.top,
          start.right,
          start.top + height,
        );
      case 'left':
        return ui.Rect.fromLTRB(
          start.right - width,
          start.center.dy - height / 2,
          start.right,
          start.center.dy + height / 2,
        );
      default:
        return ui.Rect.fromLTWH(start.left, start.top, width, height);
    }
  }

  List<_FrameHandle> _handlesFor(ui.Rect rect) => <_FrameHandle>[
    _FrameHandle('topLeft', rect.topLeft),
    _FrameHandle('top', ui.Offset(rect.center.dx, rect.top)),
    _FrameHandle('topRight', rect.topRight),
    _FrameHandle('right', ui.Offset(rect.right, rect.center.dy)),
    _FrameHandle('bottomRight', rect.bottomRight),
    _FrameHandle('bottom', ui.Offset(rect.center.dx, rect.bottom)),
    _FrameHandle('bottomLeft', rect.bottomLeft),
    _FrameHandle('left', ui.Offset(rect.left, rect.center.dy)),
  ];

  Widget _buildSelectionOverlay(BuildContext context) {
    final document = _document;
    final selection = _selection;
    if (document == null || selection == null || document.fullImageMode) {
      return const SizedBox.shrink();
    }
    final frame = _sourceRectToStage(selection);
    final accent = Theme.of(context).colorScheme.primary;
    if (widget.busy || _tool != _WorkspaceTool.select) {
      return Positioned.fromRect(
        rect: frame,
        child: IgnorePointer(
          child: DecoratedBox(
            decoration: BoxDecoration(
              border: Border.all(color: accent, width: 2),
              color: accent.withValues(alpha: 0.035),
            ),
          ),
        ),
      );
    }
    return Stack(
      clipBehavior: Clip.none,
      children: [
        Positioned.fromRect(
          rect: frame,
          child: Semantics(
            label: '输出区域，可拖动移动',
            child: GestureDetector(
              key: const ValueKey('inpaint-selection-frame'),
              behavior: HitTestBehavior.translucent,
              dragStartBehavior: DragStartBehavior.down,
              onPanStart: (details) =>
                  _beginFrameDrag(_FrameDrag.move, details.globalPosition),
              onPanUpdate: (details) =>
                  _updateFrameDrag(details.globalPosition),
              onPanEnd: (_) => _endFrameDrag(),
              child: DecoratedBox(
                decoration: BoxDecoration(
                  border: Border.all(color: accent, width: 2),
                  color: accent.withValues(alpha: 0.035),
                ),
              ),
            ),
          ),
        ),
        ..._handlesFor(frame).map((handle) {
          final handleRect = ui.Rect.fromCenter(
            center: handle.center,
            width: 22,
            height: 22,
          );
          return Positioned.fromRect(
            rect: handleRect,
            child: Semantics(
              button: true,
              label: '调整输出区域 ${_handleName(handle.id)}',
              child: Tooltip(
                message: '拖动${_handleName(handle.id)}调整输出区域',
                child: GestureDetector(
                  key: ValueKey('inpaint-selection-handle-${handle.id}'),
                  behavior: HitTestBehavior.translucent,
                  dragStartBehavior: DragStartBehavior.down,
                  onPanStart: (details) => _beginFrameDrag(
                    _FrameDrag.resize,
                    details.globalPosition,
                    handle: handle.id,
                  ),
                  onPanUpdate: (details) =>
                      _updateFrameDrag(details.globalPosition),
                  onPanEnd: (_) => _endFrameDrag(),
                  child: Center(
                    child: Container(
                      width: 12,
                      height: 12,
                      decoration: BoxDecoration(
                        color: accent,
                        border: Border.all(
                          color: Theme.of(context).colorScheme.surface,
                          width: 2,
                        ),
                        borderRadius: BorderRadius.circular(4),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          );
        }),
      ],
    );
  }

  String _handleName(String id) => switch (id) {
    'topLeft' => '左上角',
    'top' => '上边',
    'topRight' => '右上角',
    'right' => '右边',
    'bottomRight' => '右下角',
    'bottom' => '下边',
    'bottomLeft' => '左下角',
    'left' => '左边',
    _ => id,
  };

  void _handlePointerSignal(PointerSignalEvent event) {
    if (event is! PointerScrollEvent || _document == null) return;
    GestureBinding.instance.pointerSignalResolver.register(event, (resolved) {
      if (resolved is! PointerScrollEvent) return;
      final box = _canvasKey.currentContext?.findRenderObject();
      if (box is! RenderBox) return;
      final local = box.globalToLocal(resolved.position);
      final factor = resolved.scrollDelta.dy < 0 ? 1.1 : 1 / 1.1;
      _zoomAt(local, factor);
    });
  }

  void _handleCanvasPointerDown(PointerDownEvent event) {
    if (widget.busy) return;
    _activeCanvasPointers.add(event.pointer);
    if (!_scrollLocked) setState(() => _scrollLocked = true);
  }

  void _handleCanvasPointerFinished(PointerEvent event) {
    if (!_activeCanvasPointers.remove(event.pointer) ||
        _activeCanvasPointers.isNotEmpty ||
        !_scrollLocked) {
      return;
    }
    setState(() => _scrollLocked = false);
  }

  void _zoomAt(ui.Offset local, double factor) {
    final document = _document;
    if (document == null) return;
    final oldScale = _sourceScale;
    if (oldScale <= 0) return;
    final originBefore = _sourceOrigin;
    final sourceAtCursor = ui.Offset(
      (local.dx - originBefore.dx) / oldScale,
      (local.dy - originBefore.dy) / oldScale,
    );
    final nextZoom = (_zoom * factor).clamp(0.15, 12.0).toDouble();
    final fitScale = math.min(
      _canvasSize.width / document.sourceWidth,
      _canvasSize.height / document.sourceHeight,
    );
    final nextScale = fitScale * nextZoom;
    final centeredOrigin = ui.Offset(
      (_canvasSize.width - document.sourceWidth * nextScale) / 2,
      (_canvasSize.height - document.sourceHeight * nextScale) / 2,
    );
    final nextOffset = local - centeredOrigin - sourceAtCursor * nextScale;
    setState(() {
      _zoom = nextZoom;
      _panOffset = nextOffset;
      _pixelZoom = false;
    });
  }

  void _setZoom(double value, {bool pixel = false}) {
    setState(() {
      _zoom = value.clamp(0.15, 12.0).toDouble();
      _panOffset = ui.Offset.zero;
      _pixelZoom = pixel;
    });
  }

  void _resetView() => _setZoom(1);

  void _setPreviewOpacity(double value) =>
      _updateDocument((document) => document.copyWith(previewOpacity: value));

  Future<void> _runAction(Future<void> Function() action) async {
    try {
      await action();
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text('操作失败：$error')));
    }
  }

  @override
  Widget build(BuildContext context) {
    final document = _document;
    final theme = Theme.of(context);
    return LayoutBuilder(
      builder: (context, constraints) {
        final screenWidth = constraints.maxWidth.isFinite
            ? constraints.maxWidth
            : MediaQuery.sizeOf(context).width;
        return SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          physics: _scrollLocked ? const NeverScrollableScrollPhysics() : null,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _buildHeader(context, document),
              const SizedBox(height: 12),
              _buildActionBar(context, document),
              const SizedBox(height: 12),
              _buildCanvas(context, math.max(0, screenWidth - 32).toDouble()),
              if (_previewError != null) ...[
                const SizedBox(height: 8),
                Text(
                  _previewError!,
                  style: TextStyle(color: theme.colorScheme.error),
                ),
              ],
              const SizedBox(height: 12),
              if (document != null) ...[
                _buildToolOptions(context, screenWidth, document),
                const SizedBox(height: 12),
                _buildOutputOptions(context, screenWidth, document),
                const SizedBox(height: 12),
              ],
              _buildCandidates(context),
              if (document != null) ...[
                const SizedBox(height: 12),
                _buildFooterActions(context),
              ],
            ],
          ),
        );
      },
    );
  }

  Widget _buildHeader(BuildContext context, InpaintDocument? document) {
    final theme = Theme.of(context);
    return Row(
      children: [
        Icon(Icons.auto_fix_high, color: theme.colorScheme.primary),
        const SizedBox(width: 10),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('图生图与局部重绘', style: theme.textTheme.titleMedium),
              Text(
                document == null
                    ? '导入图片后开始编辑'
                    : '${document.sourceWidth}×${document.sourceHeight} 源图 · 输出 ${widget.outputWidth}×${widget.outputHeight}',
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ],
          ),
        ),
        if (widget.busy)
          const Tooltip(
            message: '当前任务正在处理',
            child: Padding(
              padding: EdgeInsets.all(8),
              child: SizedBox(
                width: 16,
                height: 16,
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
            ),
          ),
      ],
    );
  }

  Widget _buildActionBar(BuildContext context, InpaintDocument? document) {
    final isFull = document?.fullImageMode ?? true;
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        Tooltip(
          message: '导入一张图片作为重绘原图',
          child: OutlinedButton.icon(
            onPressed: widget.busy ? null : widget.onImport,
            icon: const Icon(Icons.file_open_outlined),
            label: const Text('导入图片'),
          ),
        ),
        Tooltip(
          message: '使用工作台当前图片作为原图',
          child: OutlinedButton.icon(
            onPressed: widget.busy ? null : widget.onUseCurrent,
            icon: const Icon(Icons.photo_outlined),
            label: const Text('使用当前图片'),
          ),
        ),
        if (document != null) ...[
          _toolButton(
            keyName: 'inpaint-tool-pan',
            label: '平移画布',
            tooltip: '平移画布（V）',
            icon: Icons.pan_tool_alt_outlined,
            selected: _tool == _WorkspaceTool.pan,
            onPressed: () => _selectTool(_WorkspaceTool.pan),
          ),
          _toolButton(
            keyName: 'inpaint-tool-move-source',
            label: '移动原图',
            tooltip: '移动输出区域相对原图的位置',
            icon: Icons.open_with,
            selected: _tool == _WorkspaceTool.moveSource,
            onPressed: _activateMoveSourceTool,
          ),
          _toolButton(
            keyName: 'inpaint-tool-select',
            label: '区域选择',
            tooltip: '拖动选区或边框调整输出区域（R）',
            icon: Icons.crop_free,
            selected: _tool == _WorkspaceTool.select,
            onPressed: _setRegion,
          ),
          _toolButton(
            keyName: 'inpaint-tool-paint',
            label: '画笔',
            tooltip: '画笔（B）',
            icon: Icons.brush_outlined,
            selected: _tool == _WorkspaceTool.paint,
            onPressed: () => _selectTool(_WorkspaceTool.paint),
          ),
          _toolButton(
            keyName: 'inpaint-tool-erase',
            label: '橡皮擦',
            tooltip: '橡皮擦（E）',
            icon: Icons.auto_fix_off_outlined,
            selected: _tool == _WorkspaceTool.erase,
            onPressed: () => _selectTool(_WorkspaceTool.erase),
          ),
          SegmentedButton<InpaintTarget>(
            segments: const [
              ButtonSegment(
                value: InpaintTarget.mask,
                label: Text('蒙版'),
                icon: Icon(Icons.layers_outlined),
              ),
              ButtonSegment(
                value: InpaintTarget.image,
                label: Text('图像'),
                icon: Icon(Icons.image_outlined),
              ),
            ],
            selected: <InpaintTarget>{_target},
            showSelectedIcon: false,
            onSelectionChanged: widget.busy
                ? null
                : (selection) => setState(() => _target = selection.first),
          ),
          Tooltip(
            message: isFull ? '当前为全图输出' : '当前为区域输出',
            child: SegmentedButton<bool>(
              segments: const [
                ButtonSegment(value: true, label: Text('全图')),
                ButtonSegment(value: false, label: Text('区域')),
              ],
              selected: <bool>{isFull},
              showSelectedIcon: false,
              onSelectionChanged: widget.busy
                  ? null
                  : (selection) {
                      if (selection.first) {
                        _setFullImage();
                      } else {
                        _setRegion();
                      }
                    },
            ),
          ),
          IconButton(
            key: const ValueKey('inpaint-undo'),
            tooltip: '撤销（Ctrl+Z）',
            onPressed: !widget.busy && widget.session.canUndo
                ? widget.session.undo
                : null,
            icon: const Icon(Icons.undo),
          ),
          IconButton(
            key: const ValueKey('inpaint-redo'),
            tooltip: '重做（Ctrl+Y）',
            onPressed: !widget.busy && widget.session.canRedo
                ? widget.session.redo
                : null,
            icon: const Icon(Icons.redo),
          ),
          Tooltip(
            message: '清空蒙版笔迹和导入蒙版',
            child: TextButton.icon(
              onPressed:
                  document.strokes.any(
                        (stroke) => stroke.target == InpaintTarget.mask,
                      ) ||
                      document.importedMaskAssetRef != null
                  ? (widget.busy ? null : widget.session.clearMask)
                  : null,
              icon: const Icon(Icons.layers_clear_outlined),
              label: const Text('清空蒙版'),
            ),
          ),
        ],
      ],
    );
  }

  Widget _toolButton({
    required String keyName,
    required String label,
    required String tooltip,
    required IconData icon,
    required bool selected,
    required VoidCallback onPressed,
  }) => Tooltip(
    message: tooltip,
    child: Semantics(
      button: true,
      selected: selected,
      label: label,
      child: OutlinedButton.icon(
        key: ValueKey(keyName),
        onPressed: widget.busy ? null : onPressed,
        icon: Icon(icon),
        label: Text(label),
        style: selected
            ? OutlinedButton.styleFrom(
                foregroundColor: Theme.of(context).colorScheme.primary,
                side: BorderSide(color: Theme.of(context).colorScheme.primary),
              )
            : null,
      ),
    ),
  );

  Widget _buildCanvas(BuildContext context, double availableWidth) {
    final document = _document;
    final theme = Theme.of(context);
    final width = math.max(0, availableWidth).toDouble();
    final height = (width * 0.42).clamp(220.0, 480.0).toDouble();
    _canvasSize = ui.Size(width, height);
    final selection = _selection;
    final frame = selection == null ? null : _sourceRectToStage(selection);
    final maskStrokes =
        document?.strokes
            .where((stroke) => stroke.target == InpaintTarget.mask)
            .toList(growable: false) ??
        const <InpaintStroke>[];
    return Semantics(
      label: '重绘画布',
      hint: '在画布上绘制蒙版或图像笔迹；滚轮缩放，拖动平移或调整区域。',
      child: Focus(
        focusNode: _canvasFocus,
        onKeyEvent: _handleCanvasKey,
        onFocusChange: (_) {
          if (mounted) setState(() {});
        },
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: theme.colorScheme.surfaceContainerHighest,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: theme.colorScheme.outlineVariant),
          ),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(11),
            child: SizedBox(
              key: const ValueKey('inpaint-editor-canvas'),
              width: width,
              height: height,
              child: Listener(
                key: _canvasKey,
                onPointerDown: _handleCanvasPointerDown,
                onPointerUp: _handleCanvasPointerFinished,
                onPointerCancel: _handleCanvasPointerFinished,
                onPointerSignal: _handlePointerSignal,
                child: GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  dragStartBehavior: DragStartBehavior.down,
                  onTap: () => _canvasFocus.requestFocus(),
                  onTapUp: _canvasTapUp,
                  onPanStart: widget.busy ? null : _canvasPanStart,
                  onPanUpdate: widget.busy ? null : _canvasPanUpdate,
                  onPanEnd: widget.busy ? null : _canvasPanEnd,
                  child: Stack(
                    fit: StackFit.expand,
                    clipBehavior: Clip.none,
                    children: [
                      RepaintBoundary(
                        key: const ValueKey('inpaint-request-mask-preview'),
                        child: CustomPaint(
                          painter: _WorkspacePainter(
                            composite: _compositeImage,
                            compositeOriginX: _compositeOriginX,
                            compositeOriginY: _compositeOriginY,
                            sourceWidth: document?.sourceWidth ?? 0,
                            sourceHeight: document?.sourceHeight ?? 0,
                            canvasSize: _canvasSize,
                            zoom: _zoom,
                            panOffset: _panOffset,
                            maskVisible: _maskVisible,
                            maskOpacity: document?.previewOpacity ?? 0.35,
                            maskStrokes: maskStrokes,
                            requestMask: _requestMaskImage,
                            requestMaskRect: _requestMaskRect,
                            draftStroke: _draftStroke,
                            maskColor: theme.colorScheme.error,
                            pixelZoom: _pixelZoom,
                            label: document == null
                                ? '导入图片后在此绘制'
                                : _previewLoading
                                ? '正在生成工作区预览…'
                                : null,
                            labelColor: theme.colorScheme.onSurfaceVariant,
                          ),
                        ),
                      ),
                      if (frame != null &&
                          document != null &&
                          !document.fullImageMode)
                        _buildSelectionOverlay(context),
                      if (_previewError != null)
                        Positioned(
                          left: 12,
                          right: 12,
                          bottom: 12,
                          child: IgnorePointer(
                            child: DecoratedBox(
                              decoration: BoxDecoration(
                                color: theme.colorScheme.errorContainer,
                                borderRadius: BorderRadius.circular(8),
                              ),
                              child: Padding(
                                padding: const EdgeInsets.all(8),
                                child: Text(
                                  '预览失败',
                                  style: TextStyle(
                                    color: theme.colorScheme.onErrorContainer,
                                  ),
                                ),
                              ),
                            ),
                          ),
                        ),
                      if (_canvasFocus.hasFocus)
                        Positioned(
                          right: 8,
                          top: 8,
                          child: IgnorePointer(
                            child: DecoratedBox(
                              decoration: BoxDecoration(
                                color: theme.colorScheme.surface.withValues(
                                  alpha: 0.88,
                                ),
                                borderRadius: BorderRadius.circular(6),
                              ),
                              child: Padding(
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 8,
                                  vertical: 4,
                                ),
                                child: Text(
                                  '${(_zoom * 100).round()}% · Ctrl+Z 撤销 · H 蒙版',
                                  style: theme.textTheme.bodySmall,
                                ),
                              ),
                            ),
                          ),
                        ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  int get _compositeOriginX => _lastCompositeOriginX;
  int get _compositeOriginY => _lastCompositeOriginY;
  int _lastCompositeOriginX = 0;
  int _lastCompositeOriginY = 0;

  Widget _buildToolOptions(
    BuildContext context,
    double availableWidth,
    InpaintDocument document,
  ) {
    final theme = Theme.of(context);
    final controlWidth = math.max(170.0, math.min(280.0, availableWidth - 48));
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Wrap(
          spacing: 16,
          runSpacing: 12,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            SizedBox(
              width: controlWidth,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '画笔大小 ${_brushSize.round()} 源像素',
                    style: theme.textTheme.bodySmall,
                  ),
                  Slider(
                    key: const ValueKey('inpaint-brush-size'),
                    min: 4,
                    max: 256,
                    divisions: 63,
                    value: _brushSize,
                    label: '${_brushSize.round()} px',
                    onChanged: (value) => setState(() => _brushSize = value),
                  ),
                ],
              ),
            ),
            SizedBox(
              width: controlWidth,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '笔迹不透明度 ${(100 * _brushOpacity).round()}%',
                    style: theme.textTheme.bodySmall,
                  ),
                  Slider(
                    key: const ValueKey('inpaint-brush-opacity'),
                    min: 0,
                    max: 1,
                    divisions: 20,
                    value: _brushOpacity,
                    label: '${(100 * _brushOpacity).round()}%',
                    onChanged: (value) => setState(() => _brushOpacity = value),
                  ),
                ],
              ),
            ),
            SegmentedButton<InpaintBrushShape>(
              segments: const [
                ButtonSegment(
                  value: InpaintBrushShape.round,
                  label: Text('圆形'),
                ),
                ButtonSegment(
                  value: InpaintBrushShape.square,
                  label: Text('方形'),
                ),
              ],
              selected: <InpaintBrushShape>{_brushShape},
              showSelectedIcon: false,
              onSelectionChanged: (selection) =>
                  setState(() => _brushShape = selection.first),
            ),
            _brushColorPicker(context),
            if (_target == InpaintTarget.mask)
              FilterChip(
                key: const ValueKey('inpaint-mask-visible'),
                label: Text(_maskVisible ? '蒙版可见' : '蒙版隐藏'),
                avatar: Icon(
                  _maskVisible ? Icons.visibility : Icons.visibility_off,
                ),
                selected: _maskVisible,
                onSelected: (_) => setState(() => _maskVisible = !_maskVisible),
              ),
          ],
        ),
      ),
    );
  }

  Widget _brushColorPicker(BuildContext context) {
    const colors = <(int, String)>[
      (0xffff4d4f, '红色'),
      (0xfff5d57a, '暖金'),
      (0xff3b82f6, '蓝色'),
      (0xff2dd4bf, '青色'),
      (0xffffffff, '白色'),
      (0xff171923, '深色'),
    ];
    return Tooltip(
      message: '选择图像笔迹颜色',
      child: Semantics(
        label: '笔迹颜色',
        child: DropdownButton<int>(
          key: const ValueKey('inpaint-brush-color'),
          value: _brushColor,
          items: colors
              .map(
                (entry) => DropdownMenuItem<int>(
                  value: entry.$1,
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Container(
                        width: 16,
                        height: 16,
                        margin: const EdgeInsets.only(right: 8),
                        decoration: BoxDecoration(
                          color: Color(entry.$1),
                          shape: BoxShape.circle,
                          border: Border.all(
                            color: Theme.of(context).colorScheme.outlineVariant,
                          ),
                        ),
                      ),
                      Text(entry.$2),
                    ],
                  ),
                ),
              )
              .toList(growable: false),
          onChanged: (value) {
            if (value != null) setState(() => _brushColor = value);
          },
        ),
      ),
    );
  }

  Widget _buildOutputOptions(
    BuildContext context,
    double availableWidth,
    InpaintDocument document,
  ) {
    final controlWidth = math.max(170.0, math.min(280.0, availableWidth - 48));
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Wrap(
          spacing: 16,
          runSpacing: 12,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            Wrap(
              spacing: 4,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                IconButton(
                  tooltip: '缩小画布',
                  onPressed: _zoom <= 0.2 ? null : () => _setZoom(_zoom / 1.2),
                  icon: const Icon(Icons.remove),
                ),
                Text('${(_zoom * 100).round()}%'),
                IconButton(
                  tooltip: '放大画布',
                  onPressed: _zoom >= 12 ? null : () => _setZoom(_zoom * 1.2),
                  icon: const Icon(Icons.add),
                ),
                IconButton(
                  tooltip: '适应画布',
                  onPressed: _resetView,
                  icon: const Icon(Icons.fit_screen_outlined),
                ),
                TextButton(
                  key: const ValueKey('inpaint-pixel-zoom-2'),
                  onPressed: () => _setZoom(2, pixel: true),
                  child: const Text('像素 2×'),
                ),
                TextButton(
                  key: const ValueKey('inpaint-pixel-zoom-3'),
                  onPressed: () => _setZoom(3, pixel: true),
                  child: const Text('像素 3×'),
                ),
              ],
            ),
            _sliderControl(
              keyName: 'inpaint-preview-opacity',
              label: '蒙版预览 ${(document.previewOpacity * 100).round()}%',
              value: document.previewOpacity,
              width: controlWidth,
              onChanged: _setPreviewOpacity,
            ),
            _sliderControl(
              keyName: 'inpaint-expand',
              label: '蒙版扩展 ${document.expandPixels}px',
              value: document.expandPixels.toDouble(),
              min: 0,
              max: 32,
              divisions: 32,
              width: controlWidth,
              onChanged: (value) => _updateDocument(
                (doc) => doc.copyWith(expandPixels: value.round()),
              ),
              enabled: !widget.busy,
            ),
            _sliderControl(
              keyName: 'inpaint-feather',
              label: '边缘羽化 ${document.featherPixels}px',
              value: document.featherPixels.toDouble(),
              min: 0,
              max: 32,
              divisions: 32,
              width: controlWidth,
              onChanged: (value) => _updateDocument(
                (doc) => doc.copyWith(featherPixels: value.round()),
              ),
              enabled: !widget.busy,
            ),
          ],
        ),
      ),
    );
  }

  Widget _sliderControl({
    required String keyName,
    required String label,
    required double value,
    required double width,
    required ValueChanged<double> onChanged,
    double min = 0,
    double max = 1,
    int? divisions = 20,
    bool enabled = true,
  }) => SizedBox(
    width: width,
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: Theme.of(context).textTheme.bodySmall),
        Slider(
          key: ValueKey(keyName),
          min: min,
          max: max,
          divisions: divisions,
          value: value.clamp(min, max).toDouble(),
          onChanged: enabled && !widget.busy ? onChanged : null,
        ),
      ],
    ),
  );

  Widget _buildCandidates(BuildContext context) {
    final candidates = widget.session.candidates;
    if (candidates.isEmpty) return const SizedBox.shrink();
    final theme = Theme.of(context);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('结果图层', style: theme.textTheme.titleSmall),
            const SizedBox(height: 8),
            for (var index = 0; index < candidates.length; index++)
              _candidateRow(context, candidates[index], index),
          ],
        ),
      ),
    );
  }

  Widget _candidateRow(
    BuildContext context,
    EditCandidate candidate,
    int index,
  ) {
    final theme = Theme.of(context);
    final selected = widget.session.primaryId == candidate.raw.id;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Wrap(
        spacing: 8,
        runSpacing: 6,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          SizedBox(
            width: 180,
            child: Text(
              candidate.raw.title.isEmpty
                  ? '结果 ${index + 1}'
                  : candidate.raw.title,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: selected ? theme.colorScheme.primary : null,
              ),
            ),
          ),
          OutlinedButton.icon(
            key: ValueKey('inpaint-result-select-${candidate.raw.id}'),
            onPressed: () {
              if (!candidate.visible) {
                widget.session.toggleVisible(candidate.raw.id);
              }
              widget.session.choosePrimary(candidate.raw.id);
            },
            icon: Icon(
              selected ? Icons.check_circle : Icons.visibility_outlined,
            ),
            label: Text(selected ? '当前结果' : '查看结果'),
          ),
          Tooltip(
            message: candidate.visible ? '隐藏此结果图层' : '显示此结果图层',
            child: IconButton(
              key: ValueKey('inpaint-result-visible-${candidate.raw.id}'),
              onPressed: () => widget.session.toggleVisible(candidate.raw.id),
              icon: Icon(
                candidate.visible ? Icons.visibility : Icons.visibility_off,
              ),
            ),
          ),
          Tooltip(
            message: '移除此结果图层',
            child: IconButton(
              key: ValueKey('inpaint-result-remove-${candidate.raw.id}'),
              onPressed: () => widget.session.removeCandidate(candidate.raw.id),
              icon: const Icon(Icons.delete_outline),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildFooterActions(BuildContext context) {
    final canApply =
        widget.session.primaryId != null &&
        widget.session.candidates.any(
          (candidate) => candidate.raw.id == widget.session.primaryId,
        );
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      alignment: WrapAlignment.end,
      children: [
        Tooltip(
          message: '将当前蒙版与所有可见结果图层合成为 PNG 并保存',
          child: OutlinedButton.icon(
            key: const ValueKey('inpaint-save-composite'),
            onPressed: widget.busy
                ? null
                : () => _runAction(widget.onSaveComposite),
            icon: const Icon(Icons.save_alt),
            label: const Text('保存当前可见合成图'),
          ),
        ),
        Tooltip(
          message: '将选中的结果设为新的工作区原图',
          child: FilledButton.icon(
            key: const ValueKey('inpaint-apply-result'),
            onPressed: widget.busy || !canApply
                ? null
                : () => _runAction(widget.onApplyResult),
            icon: const Icon(Icons.check),
            label: const Text('应用当前结果'),
          ),
        ),
        TextButton(
          onPressed: widget.busy
              ? null
              : () => _runAction(() => widget.onScalePixels(2)),
          child: const Text('2×像素放大'),
        ),
        TextButton(
          onPressed: widget.busy
              ? null
              : () => _runAction(() => widget.onScalePixels(3)),
          child: const Text('3×像素放大'),
        ),
      ],
    );
  }
}

class _WorkspacePainter extends CustomPainter {
  const _WorkspacePainter({
    required this.composite,
    required this.compositeOriginX,
    required this.compositeOriginY,
    required this.sourceWidth,
    required this.sourceHeight,
    required this.canvasSize,
    required this.zoom,
    required this.panOffset,
    required this.maskVisible,
    required this.maskOpacity,
    required this.maskStrokes,
    required this.requestMask,
    required this.requestMaskRect,
    required this.draftStroke,
    required this.maskColor,
    required this.pixelZoom,
    required this.label,
    required this.labelColor,
  });

  final ui.Image? composite;
  final int compositeOriginX;
  final int compositeOriginY;
  final int sourceWidth;
  final int sourceHeight;
  final ui.Size canvasSize;
  final double zoom;
  final ui.Offset panOffset;
  final bool maskVisible;
  final double maskOpacity;
  final List<InpaintStroke> maskStrokes;
  final ui.Image? requestMask;
  final ui.Rect? requestMaskRect;
  final InpaintStroke? draftStroke;
  final Color maskColor;
  final bool pixelZoom;
  final String? label;
  final Color labelColor;

  @override
  void paint(ui.Canvas canvas, ui.Size size) {
    canvas.save();
    canvas.clipRect(ui.Offset.zero & size);
    _paintChecker(canvas, size);
    if (composite != null && sourceWidth > 0 && sourceHeight > 0) {
      final fit = math.min(
        canvasSize.width / sourceWidth,
        canvasSize.height / sourceHeight,
      );
      final scale = fit * zoom;
      final sourceOrigin = ui.Offset(
        (canvasSize.width - sourceWidth * scale) / 2 + panOffset.dx,
        (canvasSize.height - sourceHeight * scale) / 2 + panOffset.dy,
      );
      final destination = ui.Rect.fromLTWH(
        sourceOrigin.dx + compositeOriginX * scale,
        sourceOrigin.dy + compositeOriginY * scale,
        composite!.width * scale,
        composite!.height * scale,
      );
      canvas.drawImageRect(
        composite!,
        ui.Rect.fromLTWH(
          0,
          0,
          composite!.width.toDouble(),
          composite!.height.toDouble(),
        ),
        destination,
        ui.Paint()
          ..filterQuality = pixelZoom
              ? ui.FilterQuality.none
              : ui.FilterQuality.medium,
      );

      if (maskVisible &&
          maskOpacity > 0 &&
          requestMask != null &&
          requestMaskRect != null) {
        final rect = requestMaskRect!;
        final destination = ui.Rect.fromLTRB(
          sourceOrigin.dx + rect.left * scale,
          sourceOrigin.dy + rect.top * scale,
          sourceOrigin.dx + rect.right * scale,
          sourceOrigin.dy + rect.bottom * scale,
        );
        canvas.drawImageRect(
          requestMask!,
          ui.Rect.fromLTWH(
            0,
            0,
            requestMask!.width.toDouble(),
            requestMask!.height.toDouble(),
          ),
          destination,
          ui.Paint()
            ..color = Colors.white.withValues(alpha: maskOpacity)
            ..filterQuality = pixelZoom
                ? ui.FilterQuality.none
                : ui.FilterQuality.medium,
        );
      }

      if (maskVisible &&
          maskOpacity > 0 &&
          (requestMask == null || draftStroke?.target == InpaintTarget.mask)) {
        canvas.save();
        canvas.translate(sourceOrigin.dx, sourceOrigin.dy);
        canvas.scale(scale);
        final bounds = ui.Rect.fromLTWH(
          -sourceWidth.toDouble(),
          -sourceHeight.toDouble(),
          sourceWidth * 3.0,
          sourceHeight * 3.0,
        );
        canvas.saveLayer(
          bounds,
          ui.Paint()
            ..colorFilter = ui.ColorFilter.mode(maskColor, ui.BlendMode.srcIn)
            ..color = Colors.white.withValues(alpha: maskOpacity),
        );
        canvas.saveLayer(bounds, ui.Paint());
        if (requestMask == null) {
          for (final stroke in maskStrokes) {
            paintInpaintStroke(canvas, stroke, mask: true);
          }
        }
        if (draftStroke?.target == InpaintTarget.mask) {
          paintInpaintStroke(canvas, draftStroke!, mask: true);
        }
        canvas.restore();
        canvas.restore();
        canvas.restore();
      } else if (draftStroke?.target == InpaintTarget.image) {
        canvas.save();
        canvas.translate(sourceOrigin.dx, sourceOrigin.dy);
        canvas.scale(scale);
        canvas.saveLayer(
          ui.Rect.fromLTWH(
            -sourceWidth.toDouble(),
            -sourceHeight.toDouble(),
            sourceWidth * 3.0,
            sourceHeight * 3.0,
          ),
          ui.Paint(),
        );
        paintInpaintStroke(canvas, draftStroke!, mask: false);
        canvas.restore();
        canvas.restore();
      }
    }
    if (label != null) {
      final painter = TextPainter(
        text: TextSpan(
          text: label,
          style: TextStyle(color: labelColor, fontSize: 13),
        ),
        textDirection: TextDirection.ltr,
      )..layout(maxWidth: size.width - 32);
      painter.paint(
        canvas,
        ui.Offset(
          (size.width - painter.width) / 2,
          (size.height - painter.height) / 2,
        ),
      );
    }
    canvas.restore();
  }

  void _paintChecker(ui.Canvas canvas, ui.Size size) {
    canvas.drawRect(
      ui.Offset.zero & size,
      ui.Paint()..color = const Color(0xff151519),
    );
    const cell = 16.0;
    final light = ui.Paint()..color = const Color(0xff202025);
    for (var y = 0; y < size.height; y += cell.toInt()) {
      for (var x = 0; x < size.width; x += cell.toInt()) {
        if ((x ~/ cell.toInt() + y ~/ cell.toInt()).isOdd) {
          canvas.drawRect(
            ui.Rect.fromLTWH(x.toDouble(), y.toDouble(), cell, cell),
            light,
          );
        }
      }
    }
  }

  @override
  bool shouldRepaint(covariant _WorkspacePainter oldDelegate) =>
      oldDelegate.composite != composite ||
      oldDelegate.compositeOriginX != compositeOriginX ||
      oldDelegate.compositeOriginY != compositeOriginY ||
      oldDelegate.sourceWidth != sourceWidth ||
      oldDelegate.sourceHeight != sourceHeight ||
      oldDelegate.canvasSize != canvasSize ||
      oldDelegate.zoom != zoom ||
      oldDelegate.panOffset != panOffset ||
      oldDelegate.maskVisible != maskVisible ||
      oldDelegate.maskOpacity != maskOpacity ||
      oldDelegate.maskStrokes != maskStrokes ||
      oldDelegate.requestMask != requestMask ||
      oldDelegate.requestMaskRect != requestMaskRect ||
      oldDelegate.draftStroke != draftStroke ||
      oldDelegate.maskColor != maskColor ||
      oldDelegate.pixelZoom != pixelZoom ||
      oldDelegate.label != label ||
      oldDelegate.labelColor != labelColor;
}

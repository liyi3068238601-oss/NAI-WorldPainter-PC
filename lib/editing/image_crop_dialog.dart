import 'dart:math' as math;
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';

import 'image_crop.dart';

Future<ImageCropResult?> showImageCropDialog(
  BuildContext context, {
  required Uint8List bytes,
  required int imageWidth,
  required int imageHeight,
  required int targetWidth,
  required int targetHeight,
  ui.Rect? initialCropRect,
}) {
  if (bytes.isEmpty) {
    throw ArgumentError.value(bytes, 'bytes', '图像数据为空');
  }
  if (imageWidth <= 0 || imageHeight <= 0) {
    throw ArgumentError('图像尺寸必须大于零');
  }
  if (targetWidth <= 0 || targetHeight <= 0) {
    throw ArgumentError('目标尺寸必须大于零');
  }
  validateImageCropDimensions(
    imageWidth: imageWidth,
    imageHeight: imageHeight,
    targetWidth: targetWidth,
    targetHeight: targetHeight,
  );
  if (initialCropRect != null &&
      (!initialCropRect.left.isFinite ||
          !initialCropRect.top.isFinite ||
          !initialCropRect.right.isFinite ||
          !initialCropRect.bottom.isFinite ||
          initialCropRect.isEmpty)) {
    throw ArgumentError.value(
      initialCropRect,
      'initialCropRect',
      '初始裁切区域必须是有效矩形',
    );
  }

  return showDialog<ImageCropResult>(
    context: context,
    builder: (context) => _ImageCropDialog(
      bytes: bytes,
      imageWidth: imageWidth,
      imageHeight: imageHeight,
      targetWidth: targetWidth,
      targetHeight: targetHeight,
      initialCropRect: initialCropRect,
    ),
  );
}

class _CropPreset {
  final int width;
  final int height;
  final String label;

  const _CropPreset(this.width, this.height, this.label);
}

enum _CropHandle {
  topLeft,
  top,
  topRight,
  right,
  bottomRight,
  bottom,
  bottomLeft,
  left,
}

class _ImageCropDialog extends StatefulWidget {
  final Uint8List bytes;
  final int imageWidth;
  final int imageHeight;
  final int targetWidth;
  final int targetHeight;
  final ui.Rect? initialCropRect;

  const _ImageCropDialog({
    required this.bytes,
    required this.imageWidth,
    required this.imageHeight,
    required this.targetWidth,
    required this.targetHeight,
    required this.initialCropRect,
  });

  @override
  State<_ImageCropDialog> createState() => _ImageCropDialogState();
}

class _ImageCropDialogState extends State<_ImageCropDialog> {
  static const _presets = <_CropPreset>[
    _CropPreset(832, 1216, '纵向 832×1216'),
    _CropPreset(1024, 1024, '方形 1024×1024'),
    _CropPreset(1216, 832, '横向 1216×832'),
  ];
  static const _minHandleWidth = 72.0;
  static const _maxImageScale = 8.0;

  late int _targetWidth;
  late int _targetHeight;
  Size _stageSize = Size.zero;
  Rect _cropRect = Rect.zero;
  double _imageScale = 1;
  Offset _imageOffset = Offset.zero;
  double _startImageScale = 1;
  Offset _startImageOffset = Offset.zero;
  Offset _startFocalPoint = Offset.zero;
  Rect _startCropRect = Rect.zero;
  Offset _resizeDelta = Offset.zero;
  bool _moveCrop = false;
  bool _stageInitialized = false;
  bool _processing = false;
  String? _error;

  double get _targetRatio => _targetWidth / _targetHeight;

  Rect get _stageRect => Offset.zero & _stageSize;

  double get _baseScale {
    if (_stageSize.isEmpty) {
      return 1;
    }
    return math.min(
      _stageSize.width / widget.imageWidth,
      _stageSize.height / widget.imageHeight,
    );
  }

  double get _totalImageScale => _baseScale * _imageScale;

  Rect get _imageRect {
    final width = widget.imageWidth * _totalImageScale;
    final height = widget.imageHeight * _totalImageScale;
    return Rect.fromCenter(
      center: _stageSize.center(Offset.zero) + _imageOffset,
      width: width,
      height: height,
    );
  }

  Rect get _imageBounds => _imageRect.intersect(_stageRect);

  @override
  void initState() {
    super.initState();
    _targetWidth = widget.targetWidth;
    _targetHeight = widget.targetHeight;
  }

  void _initializeStage(Size size) {
    if (size.isEmpty || size == _stageSize && _stageInitialized) {
      return;
    }
    final previousSourceRect = _stageInitialized
        ? _currentSourceCropRect()
        : widget.initialCropRect;
    _stageSize = size;
    _imageScale = 1;
    _imageOffset = Offset.zero;
    final imageRect = _imageRect;
    final bounds = imageRect.intersect(_stageRect);
    if (bounds.isEmpty) {
      return;
    }

    Rect? candidate;
    if (previousSourceRect != null) {
      final sourceBounds = Rect.fromLTWH(
        0,
        0,
        widget.imageWidth.toDouble(),
        widget.imageHeight.toDouble(),
      );
      final safeSourceRect = previousSourceRect.intersect(sourceBounds);
      if (!safeSourceRect.isEmpty) {
        candidate = Rect.fromLTRB(
          imageRect.left + safeSourceRect.left * _baseScale,
          imageRect.top + safeSourceRect.top * _baseScale,
          imageRect.left + safeSourceRect.right * _baseScale,
          imageRect.top + safeSourceRect.bottom * _baseScale,
        );
      }
    }

    _cropRect = candidate == null
        ? largestImageCropRectForRatio(bounds, _targetRatio)
        : fitImageCropRectToBounds(
            candidate,
            bounds,
            aspectRatio: _targetRatio,
            minWidth: 1,
          );
    _stageInitialized = true;
  }

  Rect _currentSourceCropRect() {
    return imageCropRectToSourcePixels(
      cropRect: _cropRect,
      imageRect: _imageRect,
      imageWidth: widget.imageWidth,
      imageHeight: widget.imageHeight,
      targetWidth: _targetWidth,
      targetHeight: _targetHeight,
    );
  }

  Offset _clampImageOffset(Offset value, double imageScale) {
    final totalScale = _baseScale * imageScale;
    final width = widget.imageWidth * totalScale;
    final height = widget.imageHeight * totalScale;
    final center = _stageSize.center(Offset.zero);
    final minX = _cropRect.right - center.dx - width / 2;
    final maxX = _cropRect.left - center.dx + width / 2;
    final minY = _cropRect.bottom - center.dy - height / 2;
    final maxY = _cropRect.top - center.dy + height / 2;
    return Offset(
      value.dx.clamp(math.min(minX, maxX), math.max(minX, maxX)).toDouble(),
      value.dy.clamp(math.min(minY, maxY), math.max(minY, maxY)).toDouble(),
    );
  }

  Rect _translateCrop(Rect source, Offset delta) {
    final bounds = _imageBounds;
    var moved = source.shift(delta);
    if (moved.left < bounds.left) {
      moved = moved.shift(Offset(bounds.left - moved.left, 0));
    }
    if (moved.right > bounds.right) {
      moved = moved.shift(Offset(bounds.right - moved.right, 0));
    }
    if (moved.top < bounds.top) {
      moved = moved.shift(Offset(0, bounds.top - moved.top));
    }
    if (moved.bottom > bounds.bottom) {
      moved = moved.shift(Offset(0, bounds.bottom - moved.bottom));
    }
    return moved;
  }

  double _maximumWidthForHandle(_CropHandle handle, Rect start, Rect bounds) {
    switch (handle) {
      case _CropHandle.topLeft:
        return math.min(
          start.right - bounds.left,
          (start.bottom - bounds.top) * _targetRatio,
        );
      case _CropHandle.top:
        return math.min(
          2 *
              math.min(
                start.center.dx - bounds.left,
                bounds.right - start.center.dx,
              ),
          (start.bottom - bounds.top) * _targetRatio,
        );
      case _CropHandle.topRight:
        return math.min(
          bounds.right - start.left,
          (start.bottom - bounds.top) * _targetRatio,
        );
      case _CropHandle.right:
        return math.min(
          bounds.right - start.left,
          2 *
              math.min(
                start.center.dy - bounds.top,
                bounds.bottom - start.center.dy,
              ) *
              _targetRatio,
        );
      case _CropHandle.bottomRight:
        return math.min(
          bounds.right - start.left,
          (bounds.bottom - start.top) * _targetRatio,
        );
      case _CropHandle.bottom:
        return math.min(
          2 *
              math.min(
                start.center.dx - bounds.left,
                bounds.right - start.center.dx,
              ),
          (bounds.bottom - start.top) * _targetRatio,
        );
      case _CropHandle.bottomLeft:
        return math.min(
          start.right - bounds.left,
          (bounds.bottom - start.top) * _targetRatio,
        );
      case _CropHandle.left:
        return math.min(
          start.right - bounds.left,
          2 *
              math.min(
                start.center.dy - bounds.top,
                bounds.bottom - start.center.dy,
              ) *
              _targetRatio,
        );
    }
  }

  double _proposedWidth(_CropHandle handle, Rect start, Offset delta) {
    switch (handle) {
      case _CropHandle.topLeft:
        return (start.width -
                delta.dx +
                (start.height - delta.dy) * _targetRatio) /
            2;
      case _CropHandle.top:
        return (start.height - delta.dy) * _targetRatio;
      case _CropHandle.topRight:
        return (start.width +
                delta.dx +
                (start.height - delta.dy) * _targetRatio) /
            2;
      case _CropHandle.right:
        return start.width + delta.dx;
      case _CropHandle.bottomRight:
        return (start.width +
                delta.dx +
                (start.height + delta.dy) * _targetRatio) /
            2;
      case _CropHandle.bottom:
        return (start.height + delta.dy) * _targetRatio;
      case _CropHandle.bottomLeft:
        return (start.width -
                delta.dx +
                (start.height + delta.dy) * _targetRatio) /
            2;
      case _CropHandle.left:
        return start.width - delta.dx;
    }
  }

  Rect _rectFromHandle(_CropHandle handle, Rect start, double width) {
    final height = width / _targetRatio;
    switch (handle) {
      case _CropHandle.topLeft:
        return Rect.fromLTRB(
          start.right - width,
          start.bottom - height,
          start.right,
          start.bottom,
        );
      case _CropHandle.top:
        return Rect.fromLTRB(
          start.center.dx - width / 2,
          start.bottom - height,
          start.center.dx + width / 2,
          start.bottom,
        );
      case _CropHandle.topRight:
        return Rect.fromLTRB(
          start.left,
          start.bottom - height,
          start.left + width,
          start.bottom,
        );
      case _CropHandle.right:
        return Rect.fromLTRB(
          start.left,
          start.center.dy - height / 2,
          start.left + width,
          start.center.dy + height / 2,
        );
      case _CropHandle.bottomRight:
        return Rect.fromLTWH(start.left, start.top, width, height);
      case _CropHandle.bottom:
        return Rect.fromLTRB(
          start.center.dx - width / 2,
          start.top,
          start.center.dx + width / 2,
          start.top + height,
        );
      case _CropHandle.bottomLeft:
        return Rect.fromLTRB(
          start.right - width,
          start.top,
          start.right,
          start.top + height,
        );
      case _CropHandle.left:
        return Rect.fromLTRB(
          start.right - width,
          start.center.dy - height / 2,
          start.right,
          start.center.dy + height / 2,
        );
    }
  }

  void _resizeCrop(_CropHandle handle, Offset delta) {
    final bounds = _imageBounds;
    final start = _startCropRect;
    if (bounds.isEmpty || start.isEmpty) {
      return;
    }
    final maxWidth = _maximumWidthForHandle(handle, start, bounds);
    final minWidth = math.min(_minHandleWidth, maxWidth);
    final proposed = _proposedWidth(handle, start, delta);
    final width = proposed.clamp(minWidth, maxWidth).toDouble();
    setState(() {
      _cropRect = _rectFromHandle(handle, start, width);
    });
  }

  void _selectTarget(int width, int height) {
    if (_targetWidth == width && _targetHeight == height) {
      return;
    }
    setState(() {
      final center = _cropRect.center;
      _targetWidth = width;
      _targetHeight = height;
      if (!_stageSize.isEmpty) {
        _cropRect = largestImageCropRectForRatio(
          _imageBounds,
          _targetRatio,
          center: center,
        );
      }
      _error = null;
    });
  }

  void _setImageScale(double value) {
    final scale = value.clamp(1.0, _maxImageScale).toDouble();
    setState(() {
      _imageScale = scale;
      _imageOffset = _clampImageOffset(_imageOffset, scale);
    });
  }

  void _centerCrop() {
    if (_stageSize.isEmpty) {
      return;
    }
    setState(() {
      _cropRect = fitImageCropRectToBounds(
        _cropRect,
        _imageBounds,
        aspectRatio: _targetRatio,
        center: _imageBounds.center,
        minWidth: 1,
      );
    });
  }

  void _resetView() {
    if (_stageSize.isEmpty) {
      return;
    }
    setState(() {
      _imageScale = 1;
      _imageOffset = Offset.zero;
      _cropRect = largestImageCropRectForRatio(
        _imageRect.intersect(_stageRect),
        _targetRatio,
      );
      _error = null;
    });
  }

  Future<void> _confirm() async {
    if (_processing || _cropRect.isEmpty) {
      return;
    }
    setState(() {
      _processing = true;
      _error = null;
    });
    try {
      final cropRect = _currentSourceCropRect();
      final pngBytes = await cropImageToPng(
        sourceBytes: widget.bytes,
        imageWidth: widget.imageWidth,
        imageHeight: widget.imageHeight,
        cropRect: cropRect,
        targetWidth: _targetWidth,
        targetHeight: _targetHeight,
      );
      if (!mounted) {
        return;
      }
      Navigator.of(context).pop(
        ImageCropResult(
          pngBytes: pngBytes,
          cropRect: cropRect,
          targetWidth: _targetWidth,
          targetHeight: _targetHeight,
        ),
      );
    } catch (_) {
      if (mounted) {
        setState(() {
          _error = '裁切失败，请确认图像有效后重试。';
        });
      }
    } finally {
      if (mounted) {
        setState(() => _processing = false);
      }
    }
  }

  String get _selectedPresetLabel {
    for (final preset in _presets) {
      if (preset.width == _targetWidth && preset.height == _targetHeight) {
        return preset.label;
      }
    }
    return '当前尺寸 $_targetWidth×$_targetHeight';
  }

  @override
  Widget build(BuildContext context) {
    final mediaSize = MediaQuery.sizeOf(context);
    return Dialog(
      insetPadding: const EdgeInsets.all(24),
      constraints: const BoxConstraints(
        minWidth: 0,
        maxWidth: 1100,
        maxHeight: 920,
      ),
      child: LayoutBuilder(
        builder: (context, constraints) {
          final width = math.min(1100.0, constraints.maxWidth);
          final height = math.min(920.0, constraints.maxHeight);
          return SizedBox(
            width: width,
            height: height,
            child: Column(
              children: [
                _buildHeader(context),
                const Divider(height: 1),
                Expanded(child: _buildStage(context)),
                _buildControls(context, mediaSize.width),
              ],
            ),
          );
        },
      ),
    );
  }

  Widget _buildHeader(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 8, 16, 8),
      child: Wrap(
        alignment: WrapAlignment.spaceBetween,
        crossAxisAlignment: WrapCrossAlignment.center,
        runSpacing: 6,
        spacing: 12,
        children: [
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              IconButton(
                tooltip: '取消裁切',
                onPressed: _processing
                    ? null
                    : () => Navigator.of(context).pop(),
                icon: const Icon(Icons.close),
              ),
              const SizedBox(width: 4),
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    '选择图生图区域',
                    style: theme.textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w700,
                    ),
                  ),
                  Text(
                    '拖动裁切框或图片，双指缩放',
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                ],
              ),
            ],
          ),
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextButton(
                onPressed: _processing
                    ? null
                    : () => Navigator.of(context).pop(),
                child: const Text('取消'),
              ),
              const SizedBox(width: 8),
              FilledButton.icon(
                onPressed: _processing ? null : _confirm,
                icon: _processing
                    ? const SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.check),
                label: const Text('使用裁切图'),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildStage(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.all(12),
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: theme.colorScheme.surfaceContainerHighest,
          borderRadius: BorderRadius.circular(12),
        ),
        child: LayoutBuilder(
          builder: (context, constraints) {
            final size = Size(constraints.maxWidth, constraints.maxHeight);
            _initializeStage(size);
            final imageRect = _imageRect;
            return ClipRect(
              child: GestureDetector(
                behavior: HitTestBehavior.opaque,
                onScaleStart: (details) {
                  _startImageScale = _imageScale;
                  _startImageOffset = _imageOffset;
                  _startFocalPoint = details.localFocalPoint;
                  _startCropRect = _cropRect;
                  _moveCrop =
                      details.pointerCount == 1 &&
                      _cropRect.contains(details.localFocalPoint);
                },
                onScaleUpdate: (details) {
                  final movement = details.localFocalPoint - _startFocalPoint;
                  setState(() {
                    if (details.pointerCount >= 2) {
                      final scale = (_startImageScale * details.scale)
                          .clamp(1.0, _maxImageScale)
                          .toDouble();
                      _imageScale = scale;
                      _imageOffset = _clampImageOffset(
                        _startImageOffset + movement,
                        scale,
                      );
                    } else if (_moveCrop) {
                      _cropRect = _translateCrop(_startCropRect, movement);
                    } else {
                      _imageOffset = _clampImageOffset(
                        _startImageOffset + movement,
                        _imageScale,
                      );
                    }
                  });
                },
                child: Stack(
                  clipBehavior: Clip.none,
                  children: [
                    Positioned.fromRect(
                      rect: imageRect,
                      child: Image.memory(
                        widget.bytes,
                        fit: BoxFit.fill,
                        filterQuality: FilterQuality.medium,
                        gaplessPlayback: true,
                      ),
                    ),
                    IgnorePointer(
                      child: CustomPaint(
                        size: size,
                        painter: _CropShadePainter(_cropRect),
                      ),
                    ),
                    Positioned.fromRect(
                      rect: _cropRect,
                      child: IgnorePointer(
                        child: CustomPaint(
                          painter: _CropFramePainter(theme.colorScheme.primary),
                        ),
                      ),
                    ),
                    ..._buildHandles(theme.colorScheme.primary),
                    if (_error != null)
                      Positioned(
                        left: 12,
                        right: 12,
                        bottom: 12,
                        child: Material(
                          color: theme.colorScheme.errorContainer,
                          borderRadius: BorderRadius.circular(8),
                          child: Padding(
                            padding: const EdgeInsets.all(10),
                            child: Text(
                              _error!,
                              style: TextStyle(
                                color: theme.colorScheme.onErrorContainer,
                              ),
                            ),
                          ),
                        ),
                      ),
                  ],
                ),
              ),
            );
          },
        ),
      ),
    );
  }

  List<Widget> _buildHandles(Color accent) {
    final entries = <(_CropHandle, Offset, String)>[
      (_CropHandle.topLeft, _cropRect.topLeft, '左上'),
      (_CropHandle.top, Offset(_cropRect.center.dx, _cropRect.top), '上边'),
      (_CropHandle.topRight, _cropRect.topRight, '右上'),
      (_CropHandle.right, Offset(_cropRect.right, _cropRect.center.dy), '右边'),
      (_CropHandle.bottomRight, _cropRect.bottomRight, '右下'),
      (_CropHandle.bottom, Offset(_cropRect.center.dx, _cropRect.bottom), '下边'),
      (_CropHandle.bottomLeft, _cropRect.bottomLeft, '左下'),
      (_CropHandle.left, Offset(_cropRect.left, _cropRect.center.dy), '左边'),
    ];
    return entries.map((entry) {
      final handle = entry.$1;
      final point = entry.$2;
      return Positioned(
        left: point.dx - 20,
        top: point.dy - 20,
        width: 40,
        height: 40,
        child: Semantics(
          button: true,
          label: '调整裁切框${entry.$3}',
          onIncrease: () => _resizeCrop(handle, const Offset(12, 12)),
          onDecrease: () => _resizeCrop(handle, const Offset(-12, -12)),
          child: GestureDetector(
            behavior: HitTestBehavior.translucent,
            onPanStart: (_) {
              _startCropRect = _cropRect;
              _resizeDelta = Offset.zero;
            },
            onPanUpdate: (details) {
              _resizeDelta += details.delta;
              _resizeCrop(handle, _resizeDelta);
            },
            child: Center(
              child: DecoratedBox(
                decoration: BoxDecoration(
                  color: accent,
                  border: Border.all(
                    color: Theme.of(context).colorScheme.surface,
                    width: 2,
                  ),
                  borderRadius: BorderRadius.circular(5),
                ),
                child: const SizedBox(width: 12, height: 12),
              ),
            ),
          ),
        ),
      );
    }).toList();
  }

  Widget _buildControls(BuildContext context, double screenWidth) {
    final theme = Theme.of(context);
    final currentWidth = math.min(220.0, math.max(120.0, screenWidth * 0.22));
    final selected = _selectedPresetLabel;
    final presets = <_CropPreset>[
      ..._presets,
      if (!_presets.any(
        (preset) =>
            preset.width == _targetWidth && preset.height == _targetHeight,
      ))
        _CropPreset(_targetWidth, _targetHeight, selected),
    ];

    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 12),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Wrap(
            spacing: 8,
            runSpacing: 6,
            alignment: WrapAlignment.spaceBetween,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              Wrap(
                spacing: 8,
                runSpacing: 6,
                children: presets
                    .map(
                      (preset) => ChoiceChip(
                        label: Text(preset.label),
                        selected:
                            preset.width == _targetWidth &&
                            preset.height == _targetHeight,
                        onSelected: (_) =>
                            _selectTarget(preset.width, preset.height),
                      ),
                    )
                    .toList(),
              ),
              Wrap(
                crossAxisAlignment: WrapCrossAlignment.center,
                spacing: 4,
                children: [
                  IconButton(
                    tooltip: '缩小',
                    onPressed: _imageScale <= 1
                        ? null
                        : () => _setImageScale(_imageScale - 0.25),
                    icon: const Icon(Icons.remove),
                  ),
                  SizedBox(
                    width: currentWidth,
                    child: Slider(
                      min: 1,
                      max: _maxImageScale,
                      divisions: 28,
                      value: _imageScale.clamp(1.0, _maxImageScale),
                      label: '${_imageScale.toStringAsFixed(2)}×',
                      onChanged: _setImageScale,
                    ),
                  ),
                  IconButton(
                    tooltip: '放大',
                    onPressed: _imageScale >= _maxImageScale
                        ? null
                        : () => _setImageScale(_imageScale + 0.25),
                    icon: const Icon(Icons.add),
                  ),
                ],
              ),
            ],
          ),
          Wrap(
            alignment: WrapAlignment.spaceBetween,
            crossAxisAlignment: WrapCrossAlignment.center,
            spacing: 8,
            runSpacing: 4,
            children: [
              Text(
                '输出 $_targetWidth×$_targetHeight PNG',
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
              Tooltip(
                message: '将裁切框移到可见图像中央',
                child: TextButton.icon(
                  onPressed: _stageSize.isEmpty ? null : _centerCrop,
                  icon: const Icon(Icons.center_focus_strong),
                  label: const Text('居中裁切框'),
                ),
              ),
              Tooltip(
                message: '恢复图片缩放、位置和裁切框',
                child: TextButton.icon(
                  onPressed: _stageSize.isEmpty ? null : _resetView,
                  icon: const Icon(Icons.restart_alt),
                  label: const Text('重置视图'),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _CropShadePainter extends CustomPainter {
  final Rect cropRect;

  const _CropShadePainter(this.cropRect);

  @override
  void paint(Canvas canvas, Size size) {
    final path = Path()
      ..fillType = PathFillType.evenOdd
      ..addRect(Offset.zero & size)
      ..addRect(cropRect);
    canvas.drawPath(
      path,
      Paint()..color = Colors.black.withValues(alpha: 0.48),
    );
  }

  @override
  bool shouldRepaint(covariant _CropShadePainter oldDelegate) =>
      oldDelegate.cropRect != cropRect;
}

class _CropFramePainter extends CustomPainter {
  final Color color;

  const _CropFramePainter(this.color);

  @override
  void paint(Canvas canvas, Size size) {
    final border = Paint()
      ..color = color
      ..strokeWidth = 1.5
      ..style = PaintingStyle.stroke;
    canvas.drawRect(Offset.zero & size, border);

    final accent = Paint()
      ..color = color
      ..strokeWidth = 4
      ..strokeCap = StrokeCap.square;
    const length = 28.0;
    final width = size.width;
    final height = size.height;
    canvas.drawLine(Offset.zero, const Offset(length, 0), accent);
    canvas.drawLine(Offset.zero, const Offset(0, length), accent);
    canvas.drawLine(Offset(width, 0), Offset(width - length, 0), accent);
    canvas.drawLine(Offset(width, 0), Offset(width, length), accent);
    canvas.drawLine(Offset(0, height), Offset(length, height), accent);
    canvas.drawLine(Offset(0, height), Offset(0, height - length), accent);
    canvas.drawLine(
      Offset(width, height),
      Offset(width - length, height),
      accent,
    );
    canvas.drawLine(
      Offset(width, height),
      Offset(width, height - length),
      accent,
    );
    canvas.drawLine(
      Offset(width / 2 - 16, 0),
      Offset(width / 2 + 16, 0),
      accent,
    );
    canvas.drawLine(
      Offset(width / 2 - 16, height),
      Offset(width / 2 + 16, height),
      accent,
    );
    canvas.drawLine(
      Offset(0, height / 2 - 16),
      Offset(0, height / 2 + 16),
      accent,
    );
    canvas.drawLine(
      Offset(width, height / 2 - 16),
      Offset(width, height / 2 + 16),
      accent,
    );
  }

  @override
  bool shouldRepaint(covariant _CropFramePainter oldDelegate) =>
      oldDelegate.color != color;
}

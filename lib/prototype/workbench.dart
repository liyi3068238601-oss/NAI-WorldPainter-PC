import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'scene_art.dart';
import 'workbench_controller.dart';

class Workbench extends StatefulWidget {
  const Workbench({
    super.key,
    required this.dark,
    required this.reduceMotion,
    required this.onThemeChanged,
    required this.onMotionChanged,
  });
  final bool dark, reduceMotion;
  final VoidCallback onThemeChanged;
  final ValueChanged<bool> onMotionChanged;
  @override
  State<Workbench> createState() => _WorkbenchState();
}

class _WorkbenchState extends State<Workbench> {
  final c = WorkbenchController();
  final positive = TextEditingController();
  final negative = TextEditingController();
  final seed = TextEditingController();
  final transform = TransformationController();
  final scaffold = GlobalKey<ScaffoldState>();
  final Map<String, List<List<Offset>>> masks = {};
  final Map<String, List<List<Offset>>> redo = {};
  bool? expandedNav;
  bool negativeTab = false, inpaint = false, favoritesOnly = false;
  int page = 0;
  String group = '基础';
  String query = '';
  double brush = 22;
  String character = '';
  String position = 'C3';
  bool characterEnabled = true;
  double zoom = 1;
  ColorScheme get colors => Theme.of(context).colorScheme;
  Duration get motion => Duration(
    milliseconds: widget.reduceMotion || MediaQuery.disableAnimationsOf(context)
        ? 0
        : 200,
  );
  List<List<Offset>> get strokes => masks.putIfAbsent(c.selected.id, () => []);
  List<List<Offset>> get redos => redo.putIfAbsent(c.selected.id, () => []);

  @override
  void initState() {
    super.initState();
    c.applyResult(c.selected);
    _sync();
    c.addListener(_changed);
  }

  void _sync() {
    for (final entry in [
      (positive, c.prompt),
      (negative, c.negative),
      (seed, c.seedText),
    ]) {
      if (entry.$1.text != entry.$2) {
        entry.$1.value = TextEditingValue(
          text: entry.$2,
          selection: TextSelection.collapsed(offset: entry.$2.length),
        );
      }
    }
  }

  void _changed() {
    if (mounted) {
      _sync();
      setState(() {});
    }
  }

  @override
  void dispose() {
    c.removeListener(_changed);
    c.dispose();
    positive.dispose();
    negative.dispose();
    seed.dispose();
    transform.dispose();
    super.dispose();
  }

  void _message(String message) => ScaffoldMessenger.of(context).showSnackBar(
    SnackBar(content: Text(message), behavior: SnackBarBehavior.floating),
  );
  void _select(SceneResult result) {
    c.selectResult(result.id);
    _zoom(1);
  }

  void _zoom(double value) {
    setState(() {
      zoom = value.clamp(.5, 3);
      transform.value = Matrix4.diagonal3Values(zoom, zoom, 1);
    });
  }

  Widget _icon(IconData icon, String label, VoidCallback? action) =>
      IconButton(tooltip: label, onPressed: action, icon: Icon(icon));
  Widget _muted(String text, {double size = 11}) => Text(
    text,
    style: TextStyle(fontSize: size, color: colors.onSurfaceVariant),
  );
  Widget _badge(String text, {bool gold = false}) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
    decoration: BoxDecoration(
      color: (gold ? colors.primary : colors.onSurfaceVariant).withValues(
        alpha: .09,
      ),
      borderRadius: BorderRadius.circular(6),
    ),
    child: Text(
      text,
      style: TextStyle(
        fontSize: 10,
        color: gold ? colors.primary : colors.onSurfaceVariant,
      ),
    ),
  );

  @override
  Widget build(BuildContext context) => CallbackShortcuts(
    bindings: {
      const SingleActivator(LogicalKeyboardKey.enter, control: true): () {
        c.generate();
      },
    },
    child: LayoutBuilder(
      builder: (context, bounds) {
        final tiny = bounds.maxWidth < 700;
        final inlinePanel = bounds.maxWidth >= 1060;
        final navOpen = expandedNav ?? bounds.maxWidth >= 1360;
        final navWidth = tiny
            ? 0.0
            : navOpen
            ? 200.0
            : 72.0;
        return Scaffold(
          key: scaffold,
          drawer: tiny ? Drawer(child: _navigation(true)) : null,
          endDrawer: SizedBox(
            width: math.min(400, bounds.maxWidth),
            child: Drawer(child: _parameters()),
          ),
          body: SafeArea(
            child: Row(
              children: [
                if (!tiny)
                  AnimatedContainer(
                    duration: motion,
                    curve: Curves.easeOutCubic,
                    width: navWidth,
                    clipBehavior: Clip.hardEdge,
                    decoration: BoxDecoration(
                      color: colors.surface.withValues(alpha: .55),
                      border: Border(
                        right: BorderSide(color: colors.outlineVariant),
                      ),
                    ),
                    child: OverflowBox(
                      alignment: Alignment.topLeft,
                      minWidth: navWidth,
                      maxWidth: navWidth,
                      child: _navigation(navOpen),
                    ),
                  ),
                Expanded(
                  child: Column(
                    children: [
                      _topBar(tiny, inlinePanel),
                      Expanded(
                        child: page == 1
                            ? _gallery()
                            : page == 2
                            ? _settings()
                            : Row(
                                children: [
                                  Expanded(child: _canvasWorkspace()),
                                  if (inlinePanel)
                                    SizedBox(
                                      width: 380,
                                      child: Padding(
                                        padding: const EdgeInsets.fromLTRB(
                                          0,
                                          16,
                                          16,
                                          16,
                                        ),
                                        child: _parameters(),
                                      ),
                                    ),
                                ],
                              ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        );
      },
    ),
  );

  Widget _navigation(bool wide) => LayoutBuilder(
    builder: (context, bounds) => SingleChildScrollView(
      child: ConstrainedBox(
        constraints: BoxConstraints(minHeight: bounds.maxHeight),
        child: IntrinsicHeight(child: _navigationContent(wide)),
      ),
    ),
  );

  Widget _navigationContent(bool wide) => Column(
    children: [
      SizedBox(
        height: 84,
        child: Padding(
          padding: EdgeInsets.symmetric(horizontal: wide ? 22 : 16),
          child: Row(
            children: [
              Container(
                width: 36,
                height: 36,
                decoration: BoxDecoration(
                  color: colors.primary,
                  borderRadius: BorderRadius.circular(11),
                ),
                child: Icon(
                  Icons.brush_rounded,
                  color: colors.onPrimary,
                  size: 22,
                ),
              ),
              if (wide) ...[
                const SizedBox(width: 11),
                Expanded(
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text(
                        '绘世',
                        style: TextStyle(
                          fontSize: 21,
                          fontWeight: FontWeight.w700,
                          letterSpacing: 2,
                        ),
                      ),
                      Text(
                        'WORLDPAINTER',
                        style: TextStyle(
                          fontSize: 8,
                          letterSpacing: 1.7,
                          color: colors.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
      const SizedBox(height: 15),
      if (wide)
        Align(
          alignment: Alignment.centerLeft,
          child: Padding(
            padding: const EdgeInsets.only(left: 24, bottom: 12),
            child: _muted('创作空间', size: 10),
          ),
        ),
      _navItem(Icons.auto_awesome_outlined, '创作工作台', 0, wide),
      _navItem(Icons.grid_view_rounded, '图库与素材', 1, wide),
      const SizedBox(height: 12),
      Padding(
        padding: const EdgeInsets.symmetric(horizontal: 20),
        child: Divider(color: colors.outlineVariant),
      ),
      const SizedBox(height: 12),
      _navItem(Icons.tune_rounded, '图像工具', -1, wide),
      _navItem(Icons.chat_bubble_outline_rounded, 'AI 助手', -1, wide),
      _navItem(Icons.view_quilt_outlined, '漫画创作', -1, wide),
      _navItem(Icons.publish_outlined, 'Pixiv 发布', -1, wide),
      const Spacer(),
      if (wide)
        Container(
          margin: const EdgeInsets.all(16),
          padding: const EdgeInsets.all(13),
          decoration: BoxDecoration(
            border: Border.all(color: colors.outlineVariant),
            borderRadius: BorderRadius.circular(12),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Icon(Icons.science_outlined, size: 15, color: colors.primary),
                  const SizedBox(width: 8),
                  const Text('交互原型', style: TextStyle(fontSize: 12)),
                ],
              ),
              const SizedBox(height: 7),
              _muted('先让创作体验自然发生。\n演示内容仅在本次会话保留。', size: 10),
            ],
          ),
        ),
      _navItem(Icons.settings_outlined, '偏好设置', 2, wide),
      Padding(
        padding: EdgeInsets.symmetric(vertical: 12, horizontal: wide ? 16 : 8),
        child: Row(
          mainAxisAlignment: wide
              ? MainAxisAlignment.spaceBetween
              : MainAxisAlignment.center,
          children: [
            if (wide)
              Expanded(
                child: Text(
                  'v0.1 · Prototype',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(fontSize: 9, color: colors.onSurfaceVariant),
                ),
              ),
            _icon(
              widget.dark
                  ? Icons.light_mode_outlined
                  : Icons.dark_mode_outlined,
              widget.dark ? '切换浅色主题' : '切换深色主题',
              widget.onThemeChanged,
            ),
          ],
        ),
      ),
    ],
  );

  Widget _navItem(IconData icon, String label, int index, bool wide) {
    final active = page == index;
    final enabled = index >= 0;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      child: Tooltip(
        message: enabled ? label : '$label · 后续移植',
        child: Material(
          color: active
              ? colors.primary.withValues(alpha: .11)
              : Colors.transparent,
          borderRadius: BorderRadius.circular(10),
          child: InkWell(
            borderRadius: BorderRadius.circular(10),
            onTap: enabled
                ? () {
                    setState(() => page = index);
                    if (scaffold.currentState?.isDrawerOpen ?? false) {
                      Navigator.pop(context);
                    }
                  }
                : null,
            child: SizedBox(
              height: 45,
              child: Padding(
                padding: EdgeInsets.symmetric(horizontal: wide ? 12 : 0),
                child: Row(
                  mainAxisAlignment: wide
                      ? MainAxisAlignment.start
                      : MainAxisAlignment.center,
                  children: [
                    Icon(
                      icon,
                      size: 19,
                      color: active
                          ? colors.primary
                          : colors.onSurfaceVariant.withValues(
                              alpha: enabled ? 1 : .45,
                            ),
                    ),
                    if (wide) ...[
                      const SizedBox(width: 11),
                      Expanded(
                        child: Text(
                          label,
                          style: TextStyle(
                            fontSize: 12,
                            fontWeight: active
                                ? FontWeight.w600
                                : FontWeight.normal,
                            color: active
                                ? colors.primary
                                : colors.onSurface.withValues(
                                    alpha: enabled ? .85 : .38,
                                  ),
                          ),
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _topBar(bool tiny, bool inlinePanel) => Container(
    height: 62,
    decoration: BoxDecoration(
      border: Border(bottom: BorderSide(color: colors.outlineVariant)),
    ),
    padding: const EdgeInsets.symmetric(horizontal: 14),
    child: Row(
      children: [
        _icon(
          tiny ? Icons.menu_rounded : Icons.menu_open_rounded,
          tiny ? '打开导航' : '收展导航',
          () {
            if (tiny) {
              scaffold.currentState?.openDrawer();
            } else {
              setState(
                () => expandedNav =
                    !(expandedNav ?? MediaQuery.sizeOf(context).width >= 1360),
              );
            }
          },
        ),
        const SizedBox(width: 6),
        Icon(
          page == 1
              ? Icons.grid_view_rounded
              : page == 2
              ? Icons.settings_outlined
              : Icons.brush_outlined,
          size: 15,
          color: colors.primary,
        ),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            ['创作工作台', '图库与素材', '偏好设置'][page],
            style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600),
          ),
        ),
        if (!tiny) _badge('演示模式 · 未连接服务'),
        const SizedBox(width: 10),
        _icon(Icons.receipt_long_outlined, '查看任务', _taskDialog),
        if (!inlinePanel && page == 0)
          _icon(
            Icons.tune_rounded,
            '打开生成设置',
            () => scaffold.currentState?.openEndDrawer(),
          ),
        if (!tiny)
          Padding(
            padding: const EdgeInsets.only(left: 12),
            child: Container(
              width: 28,
              height: 28,
              decoration: BoxDecoration(
                color: colors.primary.withValues(alpha: .12),
                shape: BoxShape.circle,
              ),
              child: Center(
                child: Text(
                  '绘',
                  style: TextStyle(color: colors.primary, fontSize: 12),
                ),
              ),
            ),
          ),
      ],
    ),
  );

  Widget _canvasWorkspace() => Padding(
    padding: const EdgeInsets.all(20),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    '让想象，有迹可循。',
                    style: TextStyle(
                      fontSize: 20,
                      fontWeight: FontWeight.w600,
                      letterSpacing: .5,
                    ),
                  ),
                  const SizedBox(height: 5),
                  _muted('从一个灵感，开始下一幅作品。'),
                ],
              ),
            ),
            _icon(
              c.selected.favorite
                  ? Icons.favorite_rounded
                  : Icons.favorite_border_rounded,
              '收藏当前图片',
              () => c.toggleFavorite(c.selected.id),
            ),
          ],
        ),
        const SizedBox(height: 19),
        Expanded(
          child: Container(
            clipBehavior: Clip.antiAlias,
            decoration: BoxDecoration(
              color: colors.surface.withValues(alpha: .5),
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: colors.outlineVariant),
            ),
            child: Column(
              children: [
                Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 12,
                    vertical: 8,
                  ),
                  child: Row(
                    children: [
                      _modeButton('画布', Icons.crop_free, false),
                      const SizedBox(width: 4),
                      _modeButton('蒙版', Icons.gesture, true),
                      const Spacer(),
                      _icon(
                        Icons.remove_rounded,
                        '缩小画布',
                        () => _zoom(zoom - .2),
                      ),
                      Text(
                        '${(zoom * 100).round()}%',
                        style: TextStyle(
                          fontSize: 10,
                          color: colors.onSurfaceVariant,
                        ),
                      ),
                      _icon(Icons.add_rounded, '放大画布', () => _zoom(zoom + .2)),
                      _icon(Icons.fit_screen_rounded, '重置画布', () => _zoom(1)),
                    ],
                  ),
                ),
                Divider(color: colors.outlineVariant),
                Expanded(
                  child: LayoutBuilder(
                    builder: (context, area) {
                      final availableH = math.max(20.0, area.maxHeight - 34);
                      final availableW = math.max(20.0, area.maxWidth - 40);
                      final ratio = c.selected.width / c.selected.height;
                      final width = math.min(availableW, availableH * ratio);
                      final height = width / ratio;
                      return Stack(
                        children: [
                          Positioned.fill(
                            child: CustomPaint(
                              painter: _GridPainter(colors.outlineVariant),
                            ),
                          ),
                          InteractiveViewer(
                            transformationController: transform,
                            minScale: .5,
                            maxScale: 3,
                            panEnabled: !inpaint,
                            scaleEnabled: !inpaint,
                            onInteractionEnd: (_) => setState(
                              () => zoom = transform.value.getMaxScaleOnAxis(),
                            ),
                            child: Center(
                              child: Container(
                                width: width,
                                height: height,
                                clipBehavior: Clip.antiAlias,
                                decoration: BoxDecoration(
                                  borderRadius: BorderRadius.circular(4),
                                  boxShadow: [
                                    BoxShadow(
                                      color: Colors.black.withValues(alpha: .2),
                                      blurRadius: 22,
                                      offset: const Offset(0, 8),
                                    ),
                                  ],
                                ),
                                child: Semantics(
                                  label: '画布：${c.selected.title}，原创程序绘制示意图',
                                  image: true,
                                  child: GestureDetector(
                                    onPanStart: inpaint
                                        ? (details) => setState(() {
                                            strokes.add([
                                              Offset(
                                                details.localPosition.dx /
                                                    width,
                                                details.localPosition.dy /
                                                    height,
                                              ),
                                            ]);
                                            redos.clear();
                                          })
                                        : null,
                                    onPanUpdate: inpaint
                                        ? (details) => setState(
                                            () => strokes.last.add(
                                              Offset(
                                                (details.localPosition.dx /
                                                        width)
                                                    .clamp(0, 1),
                                                (details.localPosition.dy /
                                                        height)
                                                    .clamp(0, 1),
                                              ),
                                            ),
                                          )
                                        : null,
                                    child: Stack(
                                      fit: StackFit.expand,
                                      children: [
                                        RepaintBoundary(
                                          child: SceneArt(
                                            variant: c.selected.variant,
                                          ),
                                        ),
                                        if (inpaint)
                                          CustomPaint(
                                            painter: _MaskPainter(
                                              strokes,
                                              brush / width,
                                            ),
                                          ),
                                      ],
                                    ),
                                  ),
                                ),
                              ),
                            ),
                          ),
                          Positioned(
                            left: 12,
                            bottom: 10,
                            child: _badge('示意图 · 非 AI 生成'),
                          ),
                        ],
                      );
                    },
                  ),
                ),
                if (inpaint)
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 10),
                    child: Row(
                      children: [
                        _icon(
                          Icons.undo_rounded,
                          '撤销蒙版',
                          strokes.isEmpty
                              ? null
                              : () => setState(
                                  () => redos.add(strokes.removeLast()),
                                ),
                        ),
                        _icon(
                          Icons.redo_rounded,
                          '重做蒙版',
                          redos.isEmpty
                              ? null
                              : () => setState(
                                  () => strokes.add(redos.removeLast()),
                                ),
                        ),
                        _muted('画笔'),
                        Expanded(
                          child: Slider(
                            value: brush,
                            min: 8,
                            max: 60,
                            onChanged: (v) => setState(() => brush = v),
                          ),
                        ),
                        _muted('${brush.round()} px'),
                      ],
                    ),
                  ),
                Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 12,
                    vertical: 9,
                  ),
                  child: Row(
                    children: [
                      Icon(
                        Icons.photo_outlined,
                        size: 14,
                        color: colors.onSurfaceVariant,
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          c.selected.title,
                          style: const TextStyle(fontSize: 11),
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      _muted(
                        '${c.selected.width} × ${c.selected.height}',
                        size: 10,
                      ),
                      const SizedBox(width: 4),
                      _icon(
                        Icons.info_outline_rounded,
                        '查看图片参数',
                        () => _resultDialog(c.selected),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
        const SizedBox(height: 16),
        Row(
          children: [
            const Text(
              '本次作品',
              style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600),
            ),
            const SizedBox(width: 8),
            _badge('${c.results.length}'),
            const Spacer(),
            TextButton(
              onPressed: () => setState(() => page = 1),
              child: const Text('查看图库  →', style: TextStyle(fontSize: 11)),
            ),
          ],
        ),
        SizedBox(
          height: 78,
          child: ListView.separated(
            scrollDirection: Axis.horizontal,
            itemCount: c.results.length,
            separatorBuilder: (_, _) => const SizedBox(width: 10),
            itemBuilder: (context, index) {
              final r = c.results[index];
              final active = c.selected.id == r.id;
              return Semantics(
                selected: active,
                button: true,
                label: '选择作品 ${r.title}',
                child: Tooltip(
                  message: r.title,
                  child: InkWell(
                    onTap: () => _select(r),
                    borderRadius: BorderRadius.circular(8),
                    child: AnimatedContainer(
                      duration: motion,
                      width: 64,
                      padding: const EdgeInsets.all(3),
                      decoration: BoxDecoration(
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(
                          color: active
                              ? colors.primary
                              : colors.outlineVariant,
                          width: active ? 2 : 1,
                        ),
                      ),
                      child: ClipRRect(
                        borderRadius: BorderRadius.circular(4),
                        child: SceneArt(variant: r.variant),
                      ),
                    ),
                  ),
                ),
              );
            },
          ),
        ),
      ],
    ),
  );

  Widget _modeButton(String label, IconData icon, bool mask) => TextButton.icon(
    onPressed: () => setState(() => inpaint = mask),
    icon: Icon(icon, size: 14),
    label: Text(label, style: const TextStyle(fontSize: 11)),
    style: TextButton.styleFrom(
      foregroundColor: inpaint == mask
          ? colors.primary
          : colors.onSurfaceVariant,
      backgroundColor: inpaint == mask
          ? colors.primary.withValues(alpha: .08)
          : Colors.transparent,
      minimumSize: const Size(0, 32),
      padding: const EdgeInsets.symmetric(horizontal: 10),
    ),
  );

  Widget _parameters() => Material(
    color: colors.surface,
    borderRadius: BorderRadius.circular(16),
    clipBehavior: Clip.antiAlias,
    child: Container(
      decoration: BoxDecoration(
        border: Border.all(color: colors.outlineVariant),
        borderRadius: BorderRadius.circular(16),
      ),
      child: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(18, 16, 12, 14),
            child: Row(
              children: [
                Icon(Icons.tune_rounded, size: 17, color: colors.primary),
                const SizedBox(width: 9),
                const Expanded(
                  child: Text(
                    '生成设置',
                    style: TextStyle(fontWeight: FontWeight.w600, fontSize: 13),
                  ),
                ),
                _icon(Icons.restart_alt_rounded, '还原所选图片参数', () {
                  c.applyResult(c.selected);
                  _message('已还原所选图片的参数');
                }),
              ],
            ),
          ),
          const Divider(),
          Expanded(
            child: _ScrollArea(
              child: Padding(
                padding: const EdgeInsets.all(18),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        _promptTab('正向提示词', false),
                        const SizedBox(width: 12),
                        _promptTab('负向', true),
                        const Spacer(),
                        _icon(
                          Icons.open_in_full_rounded,
                          '展开提示词编辑器',
                          _promptDialog,
                        ),
                      ],
                    ),
                    const SizedBox(height: 10),
                    TextField(
                      key: ValueKey(negativeTab ? 'negative' : 'positive'),
                      controller: negativeTab ? negative : positive,
                      minLines: 5,
                      maxLines: 7,
                      style: const TextStyle(fontSize: 12, height: 1.8),
                      decoration: InputDecoration(
                        hintText: negativeTab ? '描述需要避免的内容…' : '描述你想看见的世界…',
                        labelText: negativeTab ? '负向内容' : '画面描述',
                        alignLabelWithHint: true,
                      ),
                      onChanged: negativeTab
                          ? c.updateNegative
                          : c.updatePrompt,
                    ),
                    const SizedBox(height: 8),
                    Row(
                      children: [
                        _muted(
                          '${(negativeTab ? c.negative : c.prompt).length} 字符',
                          size: 10,
                        ),
                        const Spacer(),
                        _icon(Icons.copy_outlined, '复制提示词', () {
                          Clipboard.setData(
                            ClipboardData(
                              text: negativeTab ? c.negative : c.prompt,
                            ),
                          );
                          _message('已复制提示词');
                        }),
                        _icon(Icons.backspace_outlined, '清空当前提示词', () {
                          negativeTab
                              ? c.updateNegative('')
                              : c.updatePrompt('');
                        }),
                      ],
                    ),
                    if (!negativeTab)
                      Wrap(
                        spacing: 6,
                        runSpacing: 6,
                        children: [
                          _phrase('柔和光线', 'soft lighting'),
                          _phrase('电影质感', 'cinematic composition'),
                          _phrase('细节丰富', 'intricate details'),
                        ],
                      ),
                    const SizedBox(height: 20),
                    const Divider(),
                    const SizedBox(height: 17),
                    Row(
                      children: [
                        for (final name in ['基础', '角色', '参考'])
                          Padding(
                            padding: const EdgeInsets.only(right: 7),
                            child: ChoiceChip(
                              label: Text(
                                name,
                                style: const TextStyle(fontSize: 11),
                              ),
                              selected: group == name,
                              showCheckmark: false,
                              onSelected: (_) => setState(() => group = name),
                              visualDensity: VisualDensity.compact,
                            ),
                          ),
                      ],
                    ),
                    const SizedBox(height: 18),
                    AnimatedSize(
                      duration: motion,
                      alignment: Alignment.topCenter,
                      child: group == '基础'
                          ? _basicParameters()
                          : group == '角色'
                          ? _characterParameters()
                          : _referenceParameters(),
                    ),
                  ],
                ),
              ),
            ),
          ),
          const Divider(),
          Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              children: [
                Row(
                  children: [
                    Icon(
                      Icons.circle,
                      size: 6,
                      color: c.generating
                          ? colors.primary
                          : const Color(0xFF67B89A),
                    ),
                    const SizedBox(width: 7),
                    Expanded(
                      child: Text(
                        c.generating ? c.status : '预览流程 · 不消耗额度',
                        style: TextStyle(
                          fontSize: 10,
                          color: colors.onSurfaceVariant,
                        ),
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                    _muted('Ctrl + Enter', size: 9),
                  ],
                ),
                const SizedBox(height: 11),
                SizedBox(
                  width: double.infinity,
                  child: FilledButton.icon(
                    key: const Key('generate'),
                    onPressed: c.generating
                        ? c.cancelGeneration
                        : () => c.generate(),
                    icon: Icon(
                      c.generating
                          ? Icons.stop_rounded
                          : Icons.auto_awesome_rounded,
                      size: 17,
                    ),
                    label: Text(c.generating ? '取消预览任务' : '生成预览'),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    ),
  );

  Widget _promptTab(String label, bool isNegative) => InkWell(
    onTap: () => setState(() => negativeTab = isNegative),
    child: Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Column(
        children: [
          Text(
            label,
            style: TextStyle(
              fontSize: 12,
              color: negativeTab == isNegative
                  ? colors.primary
                  : colors.onSurfaceVariant,
              fontWeight: negativeTab == isNegative
                  ? FontWeight.w600
                  : FontWeight.normal,
            ),
          ),
          const SizedBox(height: 6),
          Container(
            height: 2,
            width: isNegative ? 24 : 60,
            color: negativeTab == isNegative
                ? colors.primary
                : Colors.transparent,
          ),
        ],
      ),
    ),
  );
  Widget _phrase(String label, String value) => ActionChip(
    label: Text(
      '+ $label',
      style: TextStyle(fontSize: 10, color: colors.onSurfaceVariant),
    ),
    visualDensity: VisualDensity.compact,
    padding: EdgeInsets.zero,
    onPressed: () => c.updatePrompt(
      '${c.prompt}${c.prompt.trim().isEmpty ? '' : ', '}$value',
    ),
  );
  Widget _label(String text) => Padding(
    padding: const EdgeInsets.only(bottom: 9),
    child: Text(
      text,
      style: const TextStyle(fontSize: 11, fontWeight: FontWeight.w500),
    ),
  );
  Widget _dropdown(
    String label,
    String current,
    List<String> items,
    ValueChanged<String> change,
  ) => DropdownButtonFormField<String>(
    key: ValueKey('$label$current'),
    initialValue: current,
    isExpanded: true,
    decoration: InputDecoration(labelText: label),
    style: TextStyle(
      fontFamily: 'NotoSansSC',
      fontSize: 12,
      color: colors.onSurface,
    ),
    dropdownColor: colors.surface,
    items: items
        .map(
          (v) => DropdownMenuItem(
            value: v,
            child: Text(v, overflow: TextOverflow.ellipsis),
          ),
        )
        .toList(),
    onChanged: (v) {
      if (v != null) change(v);
    },
  );

  Widget _basicParameters() => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      _dropdown('接入方式', c.provider, [
        'NovelAI 官方',
        '7877 网关',
        'ikun 网关',
      ], c.updateProvider),
      const SizedBox(height: 16),
      _dropdown('图像模型', c.model, [
        'NAI Diffusion 4.5 Full',
        'NAI Diffusion 4',
        'NAI Diffusion 3',
      ], c.updateModel),
      const SizedBox(height: 21),
      _label('画面尺寸'),
      Row(
        children: [
          _size('竖幅', '832 × 1216', 832, 1216, Icons.crop_portrait_rounded),
          const SizedBox(width: 7),
          _size('方形', '1024 × 1024', 1024, 1024, Icons.crop_square_rounded),
          const SizedBox(width: 7),
          _size('横幅', '1216 × 832', 1216, 832, Icons.crop_landscape_rounded),
        ],
      ),
      const SizedBox(height: 21),
      Row(
        children: [
          const Text('采样步数', style: TextStyle(fontSize: 11)),
          const Spacer(),
          Text(
            '${c.steps}',
            style: TextStyle(color: colors.primary, fontSize: 11),
          ),
        ],
      ),
      Slider(
        value: c.steps.toDouble().clamp(1, 50),
        min: 1,
        max: 50,
        divisions: 49,
        label: '${c.steps}',
        semanticFormatterCallback: (v) => '采样步数 ${v.round()}',
        onChanged: c.updateSteps,
      ),
      Row(
        children: [
          const Text('提示词引导', style: TextStyle(fontSize: 11)),
          const SizedBox(width: 6),
          _muted('CFG', size: 9),
          const Spacer(),
          Text(
            c.cfg.toStringAsFixed(1),
            style: TextStyle(color: colors.primary, fontSize: 11),
          ),
        ],
      ),
      Slider(
        value: c.cfg.clamp(1, 10),
        min: 1,
        max: 10,
        divisions: 90,
        label: c.cfg.toStringAsFixed(1),
        semanticFormatterCallback: (v) => '提示词引导 ${v.toStringAsFixed(1)}',
        onChanged: c.updateCfg,
      ),
      const SizedBox(height: 3),
      TextField(
        controller: seed,
        onChanged: c.updateSeed,
        keyboardType: TextInputType.number,
        inputFormatters: [FilteringTextInputFormatter.digitsOnly],
        style: const TextStyle(fontSize: 12),
        decoration: InputDecoration(
          labelText: 'Seed · 演示参数',
          suffixIcon: _icon(
            Icons.shuffle_rounded,
            '使用自动种子',
            () => c.updateSeed(''),
          ),
        ),
      ),
      const SizedBox(height: 17),
      ExpansionTile(
        tilePadding: EdgeInsets.zero,
        childrenPadding: const EdgeInsets.only(top: 8, bottom: 12),
        shape: const Border(),
        collapsedShape: const Border(),
        title: const Text('高级参数', style: TextStyle(fontSize: 12)),
        children: [
          _dropdown('采样器预览', 'Euler', ['Euler'], (_) {}),
          const SizedBox(height: 8),
          _muted('更多参数将在功能移植阶段接入。'),
        ],
      ),
    ],
  );

  Widget _size(
    String label,
    String caption,
    int width,
    int height,
    IconData icon,
  ) {
    final selected = c.width == width && c.height == height;
    return Expanded(
      child: Semantics(
        button: true,
        selected: selected,
        label: '$label $caption',
        child: InkWell(
          onTap: () => c.setSize(width, height),
          borderRadius: BorderRadius.circular(9),
          child: AnimatedContainer(
            duration: motion,
            padding: const EdgeInsets.symmetric(vertical: 11),
            decoration: BoxDecoration(
              color: selected
                  ? colors.primary.withValues(alpha: .08)
                  : Colors.transparent,
              border: Border.all(
                color: selected
                    ? colors.primary.withValues(alpha: .6)
                    : colors.outlineVariant,
              ),
              borderRadius: BorderRadius.circular(9),
            ),
            child: Column(
              children: [
                Icon(
                  icon,
                  size: 20,
                  color: selected ? colors.primary : colors.onSurfaceVariant,
                ),
                const SizedBox(height: 7),
                Text(
                  label,
                  style: TextStyle(
                    fontSize: 10,
                    color: selected ? colors.primary : colors.onSurface,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  caption,
                  style: TextStyle(fontSize: 8, color: colors.onSurfaceVariant),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _characterParameters() => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Row(
        children: [
          const Expanded(
            child: Text(
              '角色 01',
              style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600),
            ),
          ),
          Switch(
            value: characterEnabled,
            onChanged: (v) => setState(() => characterEnabled = v),
          ),
        ],
      ),
      _muted('关闭时保留内容。此处仅预览编辑交互。'),
      const SizedBox(height: 14),
      TextFormField(
        initialValue: character,
        enabled: characterEnabled,
        onChanged: (v) => character = v,
        minLines: 3,
        maxLines: 5,
        style: const TextStyle(fontSize: 12),
        decoration: const InputDecoration(
          labelText: '角色描述',
          hintText: '外观、服装、动作…',
          alignLabelWithHint: true,
        ),
      ),
      const SizedBox(height: 18),
      _label('画面位置 · $position'),
      GridView.count(
        shrinkWrap: true,
        crossAxisCount: 5,
        physics: const NeverScrollableScrollPhysics(),
        mainAxisSpacing: 5,
        crossAxisSpacing: 5,
        childAspectRatio: 1.6,
        children: [
          for (int y = 1; y <= 5; y++)
            for (final x in ['A', 'B', 'C', 'D', 'E'])
              OutlinedButton(
                style: OutlinedButton.styleFrom(
                  padding: EdgeInsets.zero,
                  backgroundColor: position == '$x$y'
                      ? colors.primary.withValues(alpha: .15)
                      : Colors.transparent,
                  side: BorderSide(
                    color: position == '$x$y'
                        ? colors.primary
                        : colors.outlineVariant,
                  ),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(6),
                  ),
                ),
                onPressed: characterEnabled
                    ? () => setState(() => position = '$x$y')
                    : null,
                child: Text('$x$y', style: const TextStyle(fontSize: 10)),
              ),
        ],
      ),
    ],
  );
  Widget _referenceParameters() => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      _label('图像参考'),
      Container(
        height: 128,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: colors.primary.withValues(alpha: .035),
          border: Border.all(color: colors.outlineVariant),
          borderRadius: BorderRadius.circular(12),
        ),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(
              Icons.add_photo_alternate_outlined,
              color: colors.onSurfaceVariant,
            ),
            const SizedBox(height: 10),
            _muted('参考图接入将在后续移植'),
          ],
        ),
      ),
      const SizedBox(height: 16),
      _muted('Vibe、Precise Reference 与图生图\n保留在完整移植范围内。'),
    ],
  );

  Widget _gallery() {
    final results = c.results
        .where(
          (r) =>
              (!favoritesOnly || r.favorite) &&
              (r.title.contains(query) ||
                  r.prompt.toLowerCase().contains(query.toLowerCase())),
        )
        .toList();
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            '图库与素材',
            style: TextStyle(fontSize: 24, fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 7),
          _muted('把每一次灵感，留在触手可及的地方。'),
          const SizedBox(height: 22),
          Row(
            children: [
              Expanded(
                child: TextFormField(
                  initialValue: query,
                  onChanged: (v) => setState(() => query = v),
                  decoration: const InputDecoration(
                    prefixIcon: Icon(Icons.search_rounded, size: 18),
                    hintText: '搜索作品名称或提示词',
                    labelText: '搜索图库',
                  ),
                ),
              ),
              const SizedBox(width: 12),
              FilterChip(
                label: const Text('收藏', style: TextStyle(fontSize: 11)),
                selected: favoritesOnly,
                onSelected: (v) => setState(() => favoritesOnly = v),
              ),
            ],
          ),
          const SizedBox(height: 18),
          _muted('${results.length} 件演示作品 · 当前会话'),
          const SizedBox(height: 14),
          Expanded(
            child: results.isEmpty
                ? Center(child: _muted('没有匹配的作品，试试其他关键词。'))
                : GridView.builder(
                    gridDelegate:
                        const SliverGridDelegateWithMaxCrossAxisExtent(
                          maxCrossAxisExtent: 270,
                          childAspectRatio: .77,
                          crossAxisSpacing: 16,
                          mainAxisSpacing: 16,
                        ),
                    itemCount: results.length,
                    itemBuilder: (context, i) {
                      final r = results[i];
                      return Material(
                        color: colors.surface,
                        borderRadius: BorderRadius.circular(13),
                        clipBehavior: Clip.antiAlias,
                        child: InkWell(
                          onTap: () => _resultDialog(r),
                          child: Column(
                            children: [
                              Expanded(
                                child: Stack(
                                  fit: StackFit.expand,
                                  children: [
                                    SceneArt(variant: r.variant),
                                    Positioned(
                                      top: 8,
                                      left: 8,
                                      child: _badge('示意图'),
                                    ),
                                    Positioned(
                                      top: 4,
                                      right: 4,
                                      child: IconButton(
                                        tooltip: '收藏 ${r.title}',
                                        onPressed: () => c.toggleFavorite(r.id),
                                        icon: Icon(
                                          r.favorite
                                              ? Icons.favorite_rounded
                                              : Icons.favorite_border_rounded,
                                          color: Colors.white,
                                          size: 18,
                                        ),
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                              Padding(
                                padding: const EdgeInsets.all(13),
                                child: Row(
                                  children: [
                                    Expanded(
                                      child: Text(
                                        r.title,
                                        style: const TextStyle(fontSize: 12),
                                      ),
                                    ),
                                    _muted(
                                      '${r.width} × ${r.height}',
                                      size: 10,
                                    ),
                                  ],
                                ),
                              ),
                            ],
                          ),
                        ),
                      );
                    },
                  ),
          ),
        ],
      ),
    );
  }

  Widget _settings() => Align(
    alignment: Alignment.topCenter,
    child: ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 780),
      child: _ScrollArea(
        child: Padding(
          padding: const EdgeInsets.all(28),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                '让工作台更像你',
                style: TextStyle(fontSize: 24, fontWeight: FontWeight.w600),
              ),
              const SizedBox(height: 8),
              _muted('简洁的界面，专注的创作。'),
              const SizedBox(height: 28),
              _settingCard(
                '外观主题',
                '深色暖金 / 浅色蓝',
                Icons.palette_outlined,
                Switch(
                  value: widget.dark,
                  onChanged: (_) => widget.onThemeChanged(),
                ),
              ),
              const SizedBox(height: 14),
              _settingCard(
                '减少动画',
                '关闭界面位移与展开过渡',
                Icons.animation_rounded,
                Switch(
                  value: widget.reduceMotion,
                  onChanged: widget.onMotionChanged,
                ),
              ),
              const SizedBox(height: 28),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(20),
                decoration: BoxDecoration(
                  border: Border.all(color: colors.outlineVariant),
                  borderRadius: BorderRadius.circular(13),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      '关于这个原型',
                      style: TextStyle(fontWeight: FontWeight.w600),
                    ),
                    const SizedBox(height: 9),
                    _muted(
                      '当前验证工作台布局、主题与主要交互。生成是模拟流程，图片为程序绘制的示意作品。\n所有编辑仅在当前会话保留；数据库、真实渠道和其他功能尚未接入。',
                      size: 12,
                    ),
                    const SizedBox(height: 14),
                    _badge('WorldPainter 0.1 · Flutter'),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    ),
  );
  Widget _settingCard(
    String title,
    String subtitle,
    IconData icon,
    Widget trailing,
  ) => Container(
    padding: const EdgeInsets.all(20),
    decoration: BoxDecoration(
      color: colors.surface,
      border: Border.all(color: colors.outlineVariant),
      borderRadius: BorderRadius.circular(13),
    ),
    child: Row(
      children: [
        Icon(icon, color: colors.primary),
        const SizedBox(width: 17),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(title, style: const TextStyle(fontWeight: FontWeight.w600)),
              const SizedBox(height: 5),
              _muted(subtitle),
            ],
          ),
        ),
        trailing,
      ],
    ),
  );

  Future<void> _promptDialog() async {
    final edit = TextEditingController(
      text: negativeTab ? c.negative : c.prompt,
    );
    final editingNegative = negativeTab;
    final applied = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => Dialog(
        insetPadding: const EdgeInsets.all(24),
        child: SizedBox(
          width: 1000,
          height: math.min(660, MediaQuery.sizeOf(context).height - 80),
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        editingNegative ? '编辑负向提示词' : '编辑正向提示词',
                        style: const TextStyle(
                          fontSize: 19,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                    IconButton(
                      tooltip: '关闭编辑器',
                      onPressed: () => Navigator.pop(dialogContext, false),
                      icon: const Icon(Icons.close_rounded),
                    ),
                  ],
                ),
                const SizedBox(height: 6),
                _muted('放大一点空间，写下完整的想象。'),
                const SizedBox(height: 24),
                Expanded(
                  child: LayoutBuilder(
                    builder: (context, bounds) => Row(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Expanded(
                          child: TextField(
                            controller: edit,
                            expands: true,
                            maxLines: null,
                            minLines: null,
                            textAlignVertical: TextAlignVertical.top,
                            style: const TextStyle(fontSize: 14, height: 1.8),
                            decoration: const InputDecoration(
                              labelText: '提示词编辑区',
                              alignLabelWithHint: true,
                            ),
                          ),
                        ),
                        if (bounds.maxWidth > 650) ...[
                          const SizedBox(width: 20),
                          Expanded(
                            child: Container(
                              padding: const EdgeInsets.all(18),
                              decoration: BoxDecoration(
                                border: Border.all(
                                  color: colors.outlineVariant,
                                ),
                                borderRadius: BorderRadius.circular(10),
                              ),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  _muted('文字预览', size: 10),
                                  const SizedBox(height: 12),
                                  Expanded(
                                    child: SingleChildScrollView(
                                      child: ValueListenableBuilder(
                                        valueListenable: edit,
                                        builder: (context, value, _) =>
                                            SelectableText(
                                              value.text,
                                              style: const TextStyle(
                                                fontSize: 14,
                                                height: 1.9,
                                              ),
                                            ),
                                      ),
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ),
                        ],
                      ],
                    ),
                  ),
                ),
                const SizedBox(height: 18),
                Row(
                  mainAxisAlignment: MainAxisAlignment.end,
                  children: [
                    TextButton(
                      onPressed: () => Navigator.pop(dialogContext, false),
                      child: const Text('取消'),
                    ),
                    const SizedBox(width: 12),
                    FilledButton(
                      onPressed: () => Navigator.pop(dialogContext, true),
                      child: const Text('应用更改'),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
    if (applied == true && mounted) {
      editingNegative ? c.updateNegative(edit.text) : c.updatePrompt(edit.text);
    }
    // Dialog removal is animated; dispose its controller after the route settles.
    await Future<void>.delayed(const Duration(milliseconds: 300));
    edit.dispose();
  }

  Future<void> _resultDialog(SceneResult result) => showDialog<void>(
    context: context,
    builder: (dialogContext) => AlertDialog(
      title: Row(
        children: [
          Expanded(
            child: Text(
              result.title,
              style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w600),
            ),
          ),
          _badge('演示素材'),
        ],
      ),
      content: SizedBox(
        width: 640,
        child: SingleChildScrollView(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              SizedBox(
                height: 180,
                width: double.infinity,
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(10),
                  child: SceneArt(variant: result.variant),
                ),
              ),
              const SizedBox(height: 18),
              Text(
                '${result.width} × ${result.height}  ·  ${result.model}',
                style: TextStyle(fontSize: 11, color: colors.onSurfaceVariant),
              ),
              const SizedBox(height: 8),
              Text(
                '${result.provider}  ·  步数 ${result.steps}  ·  CFG ${result.cfg.toStringAsFixed(1)}',
                style: TextStyle(fontSize: 11, color: colors.onSurfaceVariant),
              ),
              const SizedBox(height: 16),
              _label('正向提示词'),
              SelectableText(
                result.prompt,
                style: const TextStyle(fontSize: 12, height: 1.8),
              ),
              const SizedBox(height: 14),
              _label('负向提示词'),
              SelectableText(
                result.negative,
                style: TextStyle(fontSize: 11, color: colors.onSurfaceVariant),
              ),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(dialogContext),
          child: const Text('关闭'),
        ),
        TextButton(
          onPressed: () {
            c.applyResult(result, promptOnly: true);
            Navigator.pop(dialogContext);
            setState(() => page = 0);
            _message('已应用正向提示词，其他参数保持不变');
          },
          child: const Text('仅应用提示词'),
        ),
        FilledButton(
          onPressed: () {
            c.applyResult(result);
            _select(result);
            Navigator.pop(dialogContext);
            setState(() => page = 0);
            _message('已应用图片参数');
          },
          child: const Text('应用全部参数'),
        ),
      ],
    ),
  );
  Future<void> _taskDialog() => showDialog<void>(
    context: context,
    builder: (dialogContext) => AlertDialog(
      title: const Text('预览任务', style: TextStyle(fontSize: 18)),
      content: SizedBox(
        width: 360,
        child: ListenableBuilder(
          listenable: c,
          builder: (context, _) => Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              if (c.generating) ...[
                const LinearProgressIndicator(),
                const SizedBox(height: 18),
              ],
              Text(c.status),
              const SizedBox(height: 12),
              _muted('模拟任务不调用图像服务。提交后继续编辑，不会改变已提交的参数。'),
              if (c.generating)
                Padding(
                  padding: const EdgeInsets.only(top: 12),
                  child: TextButton.icon(
                    onPressed: c.cancelGeneration,
                    icon: const Icon(Icons.stop_rounded),
                    label: const Text('取消任务'),
                  ),
                ),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(dialogContext),
          child: const Text('关闭'),
        ),
      ],
    ),
  );
}

class _ScrollArea extends StatefulWidget {
  const _ScrollArea({required this.child});
  final Widget child;
  @override
  State<_ScrollArea> createState() => _ScrollAreaState();
}

class _ScrollAreaState extends State<_ScrollArea> {
  final controller = ScrollController();
  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scrollbar(
    controller: controller,
    thumbVisibility: true,
    child: SingleChildScrollView(controller: controller, child: widget.child),
  );
}

class _GridPainter extends CustomPainter {
  _GridPainter(this.color);
  final Color color;
  @override
  void paint(Canvas canvas, Size size) {
    final p = Paint()..color = color.withValues(alpha: .55);
    for (double x = 14; x < size.width; x += 20) {
      for (double y = 14; y < size.height; y += 20) {
        canvas.drawCircle(Offset(x, y), .7, p);
      }
    }
  }

  @override
  bool shouldRepaint(_GridPainter old) => old.color != color;
}

class _MaskPainter extends CustomPainter {
  _MaskPainter(this.strokes, this.normalizedWidth);
  final List<List<Offset>> strokes;
  final double normalizedWidth;
  @override
  void paint(Canvas canvas, Size size) {
    final p = Paint()
      ..color = const Color(0x88F5D57A)
      ..strokeWidth = normalizedWidth * size.width
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round
      ..style = PaintingStyle.stroke;
    for (final stroke in strokes) {
      if (stroke.isEmpty) continue;
      final path = Path()
        ..moveTo(stroke.first.dx * size.width, stroke.first.dy * size.height);
      for (final point in stroke.skip(1)) {
        path.lineTo(point.dx * size.width, point.dy * size.height);
      }
      canvas.drawPath(path, p);
    }
  }

  @override
  bool shouldRepaint(_MaskPainter old) => true;
}

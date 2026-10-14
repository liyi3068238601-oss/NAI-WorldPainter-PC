import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../assistant/agent_contract.dart';
import '../assistant/wd_tagger.dart';
import '../generation/generation_parameters.dart';
import '../prototype/workbench_controller.dart';
import '../tags/image_tag_controller.dart';
import '../tags/image_tag_review.dart';
import 'assistant_image_settings.dart';
import 'stored_image.dart';

/// Independent image-to-tag review page for the current workbench.
class ImageTagPanel extends StatefulWidget {
  const ImageTagPanel({super.key, required this.controller});

  final WorkbenchController controller;

  @override
  State<ImageTagPanel> createState() => _ImageTagPanelState();
}

class _ImageTagPanelState extends State<ImageTagPanel> {
  late final ImageTagController review = ImageTagController(
    workbench: widget.controller,
  );
  bool replacePrompt = false;
  String target = 'positive';
  bool savePending = false;

  WorkbenchController get workbench => widget.controller;

  @override
  void dispose() {
    review.dispose();
    super.dispose();
  }

  List<(String, String)> get targets {
    final inpaint =
        workbench.parameters.operation == GenerationOperation.inpaint;
    final positive = inpaint ? 'inpaint_positive' : 'positive';
    final negative = inpaint ? 'inpaint_negative' : 'negative';
    return [
      (positive, inpaint ? '重绘正向词框' : '正向词框'),
      (negative, inpaint ? '重绘负向词框' : '负向词框'),
      for (var index = 1; index <= 6; index++)
        ('character_$index', '角色 $index 正向词框'),
      for (var index = 1; index <= 6; index++)
        ('character_${index}_uc', '角色 $index 负向词框'),
    ];
  }

  String get activeTarget =>
      targets.any((entry) => entry.$1 == target) ? target : targets.first.$1;

  Future<void> _importImage() async {
    try {
      await review.pickLocalImage();
    } catch (error) {
      if (mounted) _message(review.error ?? '图片导入失败：$error');
    }
  }

  Future<void> _chooseGalleryImage() async {
    final sources = workbench.results
        .where((item) => item.assetRef != null)
        .toList(growable: false);
    if (sources.isEmpty) {
      _message('当前图库没有可读取的原图。');
      return;
    }
    final selected = await showDialog<SceneResult>(
      context: context,
      builder: (context) => SimpleDialog(
        title: const Text('选择图库原图'),
        children: [
          for (final item in sources)
            SimpleDialogOption(
              key: ValueKey('image-tag-source-${item.id}'),
              onPressed: () => Navigator.of(context).pop(item),
              child: Row(
                children: [
                  const Icon(Icons.image_outlined, size: 20),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      item.title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  Text('${item.width} × ${item.height}'),
                ],
              ),
            ),
        ],
      ),
    );
    if (selected == null || !mounted) return;
    review.selectGalleryImage(selected);
  }

  Future<void> _analyze() async {
    try {
      await review.analyze();
    } catch (error) {
      if (mounted) _message(review.error ?? '图片分析失败：$error');
    }
  }

  Future<void> _translate() async {
    await review.translateSelectedTags();
    if (mounted && review.error != null) _message(review.error!);
  }

  Future<void> _copySelected() async {
    final text = review.selectedCopyText();
    if (text.isEmpty) {
      _message('没有选中的标签。');
      return;
    }
    await Clipboard.setData(ClipboardData(text: text));
    if (mounted) _message('已复制所选英文标签。');
  }

  Future<void> _reviewPromptChange() async {
    late final ImageTagPromptChange change;
    try {
      change = review.previewPromptChange(
        target: activeTarget,
        replace: replacePrompt,
      );
    } catch (error) {
      _message(error is AgentException ? error.message : '无法生成提示词预览。');
      return;
    }
    final approved = await showDialog<bool>(
      context: context,
      builder: (context) => _PromptChangeDialog(
        targetLabel: targets
            .firstWhere((entry) => entry.$1 == change.target)
            .$2,
        before: change.before,
        after: change.after,
        replace: replacePrompt,
      ),
    );
    if (approved != true || !mounted) return;
    try {
      await review.commitPromptChange(change);
      if (mounted) _message('已写入提示词并保存。');
    } on ImageTagPromptSaveException {
      if (!mounted) return;
      setState(() => savePending = true);
      _message('提示词已应用一次，但保存失败。请重试保存；不会重复追加。');
    } catch (error) {
      if (mounted) {
        _message(error is AgentException ? error.message : '提示词应用失败。');
      }
    }
  }

  Future<void> _retrySave() async {
    try {
      await review.retryPromptSave();
      if (mounted) {
        setState(() => savePending = false);
        _message('工作区已保存。');
      }
    } catch (_) {
      if (mounted) _message('仍未保存，请检查本地工作区存储状态。');
    }
  }

  Future<void> _openWdSettings() async {
    await showWdTaggerSettingsDialog(context, workbench.assistant);
  }

  void _message(String value) {
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(value)));
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: review,
    builder: (context, _) {
      final colors = Theme.of(context).colorScheme;
      final state = review.review;
      final hasSource = state.sourceAssetRef != null;
      final settings = workbench.assistant.state.wdTagger;
      final currentTarget = activeTarget;
      return Scaffold(
        appBar: AppBar(
          title: const Text('图片反推审阅'),
          actions: [
            if (savePending)
              TextButton.icon(
                key: const ValueKey('image-tag-retry-save'),
                onPressed: _retrySave,
                icon: const Icon(Icons.save_outlined),
                label: const Text('重试保存'),
              ),
            const SizedBox(width: 8),
          ],
        ),
        body: SafeArea(
          child: LayoutBuilder(
            builder: (context, constraints) {
              final compact = constraints.maxWidth < 920;
              final source = _sourceCard(context, colors, state, hasSource);
              final controls = _analysisCard(context, colors, settings);
              final results = _resultsCard(context, colors, state);
              final write = _writeCard(context, colors, currentTarget);
              if (compact) {
                return ListView(
                  padding: const EdgeInsets.all(18),
                  children: [
                    source,
                    const SizedBox(height: 14),
                    controls,
                    const SizedBox(height: 14),
                    results,
                    const SizedBox(height: 14),
                    write,
                  ],
                );
              }
              return Padding(
                padding: const EdgeInsets.all(18),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    SizedBox(width: 350, child: source),
                    const SizedBox(width: 16),
                    Expanded(
                      child: ListView(
                        children: [
                          controls,
                          const SizedBox(height: 14),
                          results,
                          const SizedBox(height: 14),
                          write,
                        ],
                      ),
                    ),
                  ],
                ),
              );
            },
          ),
        ),
      );
    },
  );

  Widget _sourceCard(
    BuildContext context,
    ColorScheme colors,
    ImageTagReviewState state,
    bool hasSource,
  ) {
    final store = workbench.assets;
    return _Card(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              const Expanded(
                child: Text(
                  '图片来源',
                  style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
                ),
              ),
              if (hasSource)
                IconButton(
                  key: const ValueKey('image-tag-clear-source'),
                  tooltip: '清除图片',
                  onPressed: review.isAnalyzing || review.isImporting
                      ? null
                      : review.clearSource,
                  icon: const Icon(Icons.close),
                ),
            ],
          ),
          const SizedBox(height: 8),
          AspectRatio(
            aspectRatio: 1,
            child: ClipRRect(
              borderRadius: BorderRadius.circular(14),
              child: ColoredBox(
                color: colors.surfaceContainerHighest.withValues(alpha: .35),
                child: hasSource && store != null
                    ? StoredImage(
                        key: ValueKey(
                          'image-tag-preview-${state.sourceAssetRef}',
                        ),
                        store: store,
                        assetRef: state.sourceAssetRef!,
                      )
                    : Center(
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Icon(
                              Icons.image_search_outlined,
                              size: 46,
                              color: colors.onSurfaceVariant,
                            ),
                            const SizedBox(height: 8),
                            Text(
                              store == null ? '图片存储不可用' : '导入图片或选择图库原图',
                              style: TextStyle(color: colors.onSurfaceVariant),
                            ),
                          ],
                        ),
                      ),
              ),
            ),
          ),
          const SizedBox(height: 10),
          Text(
            review.sourceTitle() ?? '尚未选择图片',
            style: const TextStyle(fontWeight: FontWeight.w600),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
          const SizedBox(height: 12),
          OutlinedButton.icon(
            key: const ValueKey('image-tag-import'),
            onPressed: review.isAnalyzing || review.isImporting || store == null
                ? null
                : _importImage,
            icon: review.isImporting
                ? const SizedBox.square(
                    dimension: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.file_open_outlined),
            label: const Text('从本地导入'),
          ),
          OutlinedButton.icon(
            key: const ValueKey('image-tag-gallery'),
            onPressed: review.isAnalyzing || review.isImporting
                ? null
                : _chooseGalleryImage,
            icon: const Icon(Icons.photo_library_outlined),
            label: const Text('选择图库原图'),
          ),
          const SizedBox(height: 6),
          Text(
            '原图保存在受管图库资产中。WD 上传前会重新编码去除文件元数据。',
            style: Theme.of(context).textTheme.bodySmall
                ?.copyWith(color: colors.onSurfaceVariant),
          ),
        ],
      ),
    );
  }

  Widget _analysisCard(
    BuildContext context,
    ColorScheme colors,
    WdTaggerSettings settings,
  ) => _Card(
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Text(
          '分析方式',
          style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
        ),
        const SizedBox(height: 12),
        SegmentedButton<ImageTagAnalysisMode>(
          key: const ValueKey('image-tag-mode'),
          segments: const [
            ButtonSegment(
              value: ImageTagAnalysisMode.naiMetadata,
              icon: Icon(Icons.settings_input_component_outlined),
              label: Text('NAI 元数据'),
            ),
            ButtonSegment(
              value: ImageTagAnalysisMode.wdTagger,
              icon: Icon(Icons.label_outline),
              label: Text('在线 WD-Tagger'),
            ),
          ],
          selected: {review.mode},
          onSelectionChanged: review.isAnalyzing || review.isImporting
              ? null
              : (values) => review.setMode(values.first),
        ),
        if (review.mode == ImageTagAnalysisMode.wdTagger) ...[
          const SizedBox(height: 12),
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: colors.surfaceContainerLow,
              borderRadius: BorderRadius.circular(10),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '${WdTaggerSettings.models[settings.model] ?? settings.model} · ${settings.model}',
                  style: const TextStyle(fontWeight: FontWeight.w600),
                ),
                const SizedBox(height: 4),
                Text(
                  '助手附图自动分析${settings.enabled ? '已启用' : '已关闭'}。本页仅在你点击分析时发送一次，不改变这个开关。',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
                const SizedBox(height: 8),
                Text(
                  '一般阈值 ${settings.generalThreshold.toStringAsFixed(2)} · 角色阈值 ${settings.characterThreshold.toStringAsFixed(2)}',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
                Align(
                  alignment: Alignment.centerRight,
                  child: TextButton.icon(
                    key: const ValueKey('image-tag-wd-settings'),
                    onPressed: review.isAnalyzing ? null : _openWdSettings,
                    icon: const Icon(Icons.tune, size: 18),
                    label: const Text('WD 设置'),
                  ),
                ),
              ],
            ),
          ),
        ],
        const SizedBox(height: 12),
        FilledButton.icon(
          key: const ValueKey('image-tag-analyze'),
          onPressed:
              !review.hasSource || review.isAnalyzing || review.isImporting
              ? null
              : _analyze,
          icon: review.isAnalyzing
              ? const SizedBox.square(
                  dimension: 18,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    color: Colors.white,
                  ),
                )
              : const Icon(Icons.auto_awesome_outlined),
          label: Text(review.isAnalyzing ? '分析中…' : '开始分析'),
        ),
        if (review.error != null) ...[
          const SizedBox(height: 8),
          Text(
            review.error!,
            key: const ValueKey('image-tag-error'),
            style: TextStyle(color: colors.error),
          ),
        ],
      ],
    ),
  );

  Widget _resultsCard(
    BuildContext context,
    ColorScheme colors,
    ImageTagReviewState state,
  ) => _Card(
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            const Expanded(
              child: Text(
                '候选标签',
                style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
              ),
            ),
            Text('${state.candidateCount} 项'),
          ],
        ),
        if (!state.analyzed) ...[
          const SizedBox(height: 10),
          Text(
            state.sourceAssetRef == null ? '选择图片后开始分析。' : '当前模式尚未分析。',
            style: TextStyle(color: colors.onSurfaceVariant),
          ),
        ] else ...[
          if (state.mode == ImageTagAnalysisMode.naiMetadata)
            _metadataSummary(context, state),
          if (state.metadataWarnings.isNotEmpty) ...[
            const SizedBox(height: 8),
            for (final warning in state.metadataWarnings)
              Padding(
                padding: const EdgeInsets.only(bottom: 4),
                child: Text(warning, style: TextStyle(color: colors.tertiary)),
              ),
          ],
          const SizedBox(height: 8),
          for (final category in ImageTagCategory.values)
            _categorySection(context, colors, category),
          const Divider(height: 24),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              OutlinedButton.icon(
                key: const ValueKey('image-tag-translate'),
                onPressed: !review.canTranslate || review.isTranslating
                    ? null
                    : _translate,
                icon: review.isTranslating
                    ? const SizedBox.square(
                        dimension: 16,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.translate, size: 18),
                label: Text(review.isTranslating ? '翻译中…' : '翻译已选标签'),
              ),
              OutlinedButton.icon(
                key: const ValueKey('image-tag-copy'),
                onPressed: state.hasSelectedCandidates ? _copySelected : null,
                icon: const Icon(Icons.copy_outlined, size: 18),
                label: const Text('复制所选'),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Text(
            '中文只作为阅读辅助；复制和写入始终使用英文原标签。',
            style: Theme.of(context).textTheme.bodySmall
                ?.copyWith(color: colors.onSurfaceVariant),
          ),
        ],
      ],
    ),
  );

  Widget _metadataSummary(BuildContext context, ImageTagReviewState state) {
    final labels = <String, String>{
      'model': '模型',
      'width': '宽度',
      'height': '高度',
      'steps': '步数',
      'scale': 'CFG',
      'cfg_rescale': 'CFG 重缩放',
      'sampler': '采样器',
      'noise_schedule': '噪声调度',
      'seed': 'Seed',
      'use_coords': '坐标',
    };
    if (state.metadataFields.isEmpty && state.metadataSource == null) {
      return const SizedBox.shrink();
    }
    return Padding(
      padding: const EdgeInsets.only(top: 10),
      child: Wrap(
        spacing: 6,
        runSpacing: 6,
        children: [
          if (state.metadataSource != null)
            Chip(label: Text('来源 ${state.metadataSource}')),
          for (final entry in state.metadataFields.entries)
            Chip(
              label: Text('${labels[entry.key] ?? entry.key} ${entry.value}'),
            ),
        ],
      ),
    );
  }

  Widget _categorySection(
    BuildContext context,
    ColorScheme colors,
    ImageTagCategory category,
  ) {
    final entries = review.tagsFor(category);
    final title = switch (category) {
      ImageTagCategory.general => '一般标签',
      ImageTagCategory.character => '角色标签',
      ImageTagCategory.rating => '评级标签',
      ImageTagCategory.negative => '负向标签',
    };
    final selected = entries.where((item) => item.selected).length;
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  '$title  $selected/${entries.length}',
                  style: const TextStyle(fontWeight: FontWeight.w600),
                ),
              ),
              TextButton(
                onPressed: entries.isEmpty
                    ? null
                    : () => review.selectAll(category),
                child: const Text('全选'),
              ),
              TextButton(
                onPressed: entries.isEmpty
                    ? null
                    : () => review.invertSelection(category),
                child: const Text('反选'),
              ),
            ],
          ),
          if (entries.isEmpty)
            Text(
              '无候选',
              style: Theme.of(context).textTheme.bodySmall
                  ?.copyWith(color: colors.onSurfaceVariant),
            )
          else
            Wrap(
              spacing: 7,
              runSpacing: 7,
              children: [
                for (final item in entries.indexed)
                  _TagChip(
                    key: ValueKey('image-tag-${category.name}-${item.$1}'),
                    candidate: item.$2,
                    translation: review.review.translations[item.$2.tag],
                    selected: item.$2.selected,
                    onSelected: (_) => review.toggleTag(category, item.$1),
                  ),
              ],
            ),
        ],
      ),
    );
  }

  Widget _writeCard(
    BuildContext context,
    ColorScheme colors,
    String currentTarget,
  ) => _Card(
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Text(
          '写入当前提示词',
          style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
        ),
        const SizedBox(height: 10),
        DropdownButtonFormField<String>(
          key: ValueKey('image-tag-target-$currentTarget'),
          initialValue: currentTarget,
          isExpanded: true,
          decoration: const InputDecoration(
            labelText: '目标词框',
            border: OutlineInputBorder(),
          ),
          items: [
            for (final entry in targets)
              DropdownMenuItem(value: entry.$1, child: Text(entry.$2)),
          ],
          onChanged: review.isAnalyzing || review.isImporting
              ? null
              : (value) {
                  if (value != null) setState(() => target = value);
                },
        ),
        const SizedBox(height: 10),
        SegmentedButton<bool>(
          key: const ValueKey('image-tag-write-mode'),
          segments: const [
            ButtonSegment(value: false, label: Text('追加')),
            ButtonSegment(value: true, label: Text('替换')),
          ],
          selected: {replacePrompt},
          onSelectionChanged: (values) =>
              setState(() => replacePrompt = values.first),
        ),
        const SizedBox(height: 10),
        FilledButton.icon(
          key: const ValueKey('image-tag-apply'),
          onPressed: !review.canApplyPrompt ? null : _reviewPromptChange,
          icon: const Icon(Icons.playlist_add_check_outlined),
          label: Text(
            '预览并确认写入${targets.firstWhere((item) => item.$1 == currentTarget).$2}',
          ),
        ),
        if (!review.canApplyPrompt) ...[
          const SizedBox(height: 6),
          Text(
            workbench.assistant.busy
                ? '小助手正在运行，完成后可写入提示词。'
                : '完成分析并勾选标签后可预览写入内容。',
            style: Theme.of(context).textTheme.bodySmall
                ?.copyWith(color: colors.onSurfaceVariant),
          ),
        ],
      ],
    ),
  );
}

class _TagChip extends StatelessWidget {
  const _TagChip({
    super.key,
    required this.candidate,
    required this.translation,
    required this.selected,
    required this.onSelected,
  });

  final ImageTagCandidate candidate;
  final String? translation;
  final bool selected;
  final ValueChanged<bool> onSelected;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Tooltip(
      message: translation == null
          ? candidate.tag
          : '${candidate.tag}\n$translation',
      child: FilterChip(
        selected: selected,
        onSelected: onSelected,
        label: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(candidate.tag, maxLines: 1, overflow: TextOverflow.ellipsis),
            Wrap(
              spacing: 5,
              runSpacing: 2,
              children: [
                if (candidate.group != null) ...[
                  Text(
                    candidate.group!,
                    style: theme.textTheme.labelSmall?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                ],
                Text(
                  '${(candidate.confidence * 100).round()}%',
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ),
                if (translation != null) ...[
                  Text(
                    translation!,
                    style: theme.textTheme.labelSmall?.copyWith(
                      color: theme.colorScheme.primary,
                    ),
                  ),
                ],
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _Card extends StatelessWidget {
  const _Card({required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) => Card(
    margin: EdgeInsets.zero,
    child: Padding(padding: const EdgeInsets.all(16), child: child),
  );
}

class _PromptChangeDialog extends StatelessWidget {
  const _PromptChangeDialog({
    required this.targetLabel,
    required this.before,
    required this.after,
    required this.replace,
  });

  final String targetLabel;
  final String before;
  final String after;
  final bool replace;

  @override
  Widget build(BuildContext context) => AlertDialog(
    key: const ValueKey('image-tag-prompt-confirmation'),
    title: Text(replace ? '确认替换 $targetLabel' : '确认追加到 $targetLabel'),
    content: SizedBox(
      width: 680,
      child: SingleChildScrollView(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Text('写入前'),
            const SizedBox(height: 5),
            _PromptPreview(text: before),
            const SizedBox(height: 14),
            const Text('写入后'),
            const SizedBox(height: 5),
            _PromptPreview(text: after),
          ],
        ),
      ),
    ),
    actions: [
      TextButton(
        key: const ValueKey('image-tag-prompt-cancel'),
        onPressed: () => Navigator.of(context).pop(false),
        child: const Text('取消'),
      ),
      FilledButton(
        key: const ValueKey('image-tag-prompt-approve'),
        onPressed: () => Navigator.of(context).pop(true),
        child: const Text('确认写入'),
      ),
    ],
  );
}

class _PromptPreview extends StatelessWidget {
  const _PromptPreview({required this.text});
  final String text;

  @override
  Widget build(BuildContext context) => Container(
    constraints: const BoxConstraints(maxHeight: 220),
    width: double.infinity,
    padding: const EdgeInsets.all(10),
    decoration: BoxDecoration(
      color: Theme.of(context).colorScheme.surfaceContainerHighest,
      borderRadius: BorderRadius.circular(8),
    ),
    child: SingleChildScrollView(
      child: SelectableText(text.isEmpty ? '（空）' : text),
    ),
  );
}

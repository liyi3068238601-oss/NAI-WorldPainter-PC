import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../prompts/prompt_library.dart';
import '../prompts/prompt_capsules.dart';
import '../platform/image_picker.dart';
import 'stored_image.dart';
import 'workbench_controller.dart';

class PromptLibraryPanel extends StatefulWidget {
  const PromptLibraryPanel({
    super.key,
    required this.controller,
    this.initialNegative = false,
  });
  final WorkbenchController controller;
  final bool initialNegative;
  @override
  State<PromptLibraryPanel> createState() => _PromptLibraryPanelState();
}

class _PromptLibraryPanelState extends State<PromptLibraryPanel> {
  int tab = 0;
  String query = '', category = '', subgroup = '';
  String? notice;
  PromptSortOrder order = PromptSortOrder.recent;
  late bool negative = widget.initialNegative;
  final search = TextEditingController();
  final weights = <String, double>{};
  final selectedCapsules = <String, PromptCapsule>{};
  late final Future<List<PromptCapsule>> capsules = loadPromptCapsules();
  WorkbenchController get c => widget.controller;
  PromptLibrary get library => c.promptLibrary;
  @override
  void dispose() {
    search.dispose();
    super.dispose();
  }

  void message(String text) {
    if (!mounted) return;
    setState(() => notice = text);
  }

  void act(VoidCallback action) {
    try {
      action();
    } on FormatException catch (error) {
      message(error.message);
    }
  }

  Future<void> copy(String text, String notice) async {
    try {
      await Clipboard.setData(ClipboardData(text: text));
      message(notice);
    } catch (_) {
      message('复制失败，请重试');
    }
  }

  void insert(String positive, String negativeText) {
    act(() {
      c.appendPrompts(positive, negativeText);
      message('已追加到当前创作草稿');
    });
  }

  void switchTab(int next) => setState(() {
    tab = next;
    category = '';
    subgroup = '';
    query = '';
    search.clear();
    notice = null;
  });

  Future<void> edit({
    PromptStyle? style,
    PromptArtist? artist,
    bool newArtist = false,
    bool fromDraft = false,
  }) async {
    await showDialog<void>(
      context: context,
      builder: (_) => _PromptEntryEditor(
        controller: c,
        style: style,
        artist: artist,
        artistMode: newArtist || artist != null,
        initialPrompt: fromDraft ? c.prompt : '',
        initialNegative: fromDraft ? c.negative : '',
      ),
    );
    if (mounted) setState(() {});
  }

  Future<bool> confirm(String title, String body) async =>
      await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: Text(title),
          content: Text(body),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('取消'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('确认删除'),
            ),
          ],
        ),
      ) ??
      false;

  Future<void> groups() async {
    await showDialog<void>(
      context: context,
      builder: (_) => _PromptGroupsDialog(library: library),
    );
    if (mounted) {
      setState(() {
        if (!library.groups.contains(category)) category = '';
      });
    }
  }

  Future<void> capsuleLicense() async {
    final license = await rootBundle.loadString('licenses/CAPSULES_MIT.txt');
    if (!mounted) return;
    await showDialog<void>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('胶囊词库来源与许可'),
        content: SizedBox(
          width: 580,
          child: SingleChildScrollView(
            child: SelectableText(
              'NovelAI Studio · Langbai\nhttps://github.com/2786886095/novelai-image-desktop\n版本：2d609393c3902874afae5200c26165d86b76055f\n\n$license',
            ),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('关闭'),
          ),
        ],
      ),
    );
  }

  Widget select(
    String label,
    String value,
    List<String> values,
    ValueChanged<String> changed,
  ) => SizedBox(
    width: 160,
    child: DropdownButtonFormField<String>(
      key: ValueKey('$label/$value/${values.join('|')}'),
      initialValue: values.contains(value) ? value : '',
      isExpanded: true,
      decoration: InputDecoration(labelText: label, isDense: true),
      items: values
          .map(
            (v) => DropdownMenuItem(
              value: v,
              child: Text(
                v.isEmpty ? '全部' : v,
                overflow: TextOverflow.ellipsis,
              ),
            ),
          )
          .toList(),
      onChanged: (v) => changed(v ?? ''),
    ),
  );

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: c,
    builder: (context, _) {
      weights.removeWhere((id, _) => !library.artists.any((a) => a.id == id));
      return Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          children: [
            Align(
              alignment: Alignment.centerLeft,
              child: Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  for (final entry in ['风格收藏', '画师串', '灵感胶囊'].asMap().entries)
                    ChoiceChip(
                      label: Text(entry.value),
                      selected: tab == entry.key,
                      onSelected: (_) => switchTab(entry.key),
                    ),
                  if (notice != null)
                    Semantics(
                      liveRegion: true,
                      child: Padding(
                        padding: const EdgeInsets.symmetric(vertical: 12),
                        child: Text(
                          notice!,
                          style: TextStyle(
                            fontSize: 12,
                            color: Theme.of(context).colorScheme.primary,
                          ),
                        ),
                      ),
                    ),
                ],
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              key: const ValueKey('prompt-library-search'),
              controller: search,
              decoration: InputDecoration(
                prefixIcon: const Icon(Icons.search),
                suffixIcon: tab == 2
                    ? IconButton(
                        tooltip: '词库来源与许可',
                        onPressed: capsuleLicense,
                        icon: const Icon(Icons.info_outline),
                      )
                    : null,
                hintText: '搜索名称、中文或提示词',
                isDense: true,
              ),
              onChanged: (value) => setState(() => query = value),
            ),
            const SizedBox(height: 12),
            Expanded(
              child: switch (tab) {
                0 => stylesView(),
                1 => artistsView(),
                _ => capsulesView(),
              },
            ),
          ],
        ),
      );
    },
  );

  Widget stylesView() {
    final categories =
        library.styles
            .map((v) => v.category)
            .where((v) => v.isNotEmpty)
            .toSet()
            .toList()
          ..sort();
    if (!categories.contains(category)) category = '';
    final entries = library.sortedStyles(
      order: order == PromptSortOrder.popularity
          ? PromptSortOrder.recent
          : order,
      query: query,
      category: category.isEmpty ? null : category,
    );
    return Column(
      children: [
        Align(
          alignment: Alignment.centerLeft,
          child: Wrap(
            spacing: 10,
            runSpacing: 10,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              select('风格分类', category, [
                '',
                ...categories,
              ], (v) => setState(() => category = v)),
              FilledButton.icon(
                key: const ValueKey('add-style'),
                onPressed: () => edit(),
                icon: const Icon(Icons.add),
                label: const Text('新增风格'),
              ),
              TextButton.icon(
                onPressed: () => edit(fromDraft: true),
                icon: const Icon(Icons.bookmark_add_outlined),
                label: const Text('收藏当前提示词'),
              ),
            ],
          ),
        ),
        const SizedBox(height: 12),
        Expanded(
          child: entries.isEmpty
              ? empty('还没有匹配的风格', '收藏常用提示词，并可为它添加自己的预览图。')
              : LayoutBuilder(
                  builder: (context, bounds) => GridView.builder(
                    gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
                      crossAxisCount: (bounds.maxWidth / 290).floor().clamp(
                        1,
                        5,
                      ),
                      mainAxisExtent: 280,
                      mainAxisSpacing: 12,
                      crossAxisSpacing: 12,
                    ),
                    itemCount: entries.length,
                    itemBuilder: (context, index) {
                      final style = entries[index];
                      return Card(
                        margin: EdgeInsets.zero,
                        clipBehavior: Clip.antiAlias,
                        child: Padding(
                          padding: const EdgeInsets.all(14),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Expanded(
                                child: Row(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Container(
                                      width: 74,
                                      height: 90,
                                      clipBehavior: Clip.antiAlias,
                                      decoration: BoxDecoration(
                                        color: Theme.of(context)
                                            .colorScheme
                                            .primary
                                            .withValues(alpha: .08),
                                        borderRadius: BorderRadius.circular(10),
                                      ),
                                      child:
                                          style.previewAssetRef != null &&
                                              c.assets != null
                                          ? StoredImage(
                                              store: c.assets!,
                                              assetRef: style.previewAssetRef!,
                                              fit: BoxFit.cover,
                                            )
                                          : const Icon(
                                              Icons.palette_outlined,
                                              size: 30,
                                            ),
                                    ),
                                    const SizedBox(width: 12),
                                    Expanded(
                                      child: Column(
                                        crossAxisAlignment:
                                            CrossAxisAlignment.start,
                                        children: [
                                          Text(
                                            style.name,
                                            maxLines: 2,
                                            overflow: TextOverflow.ellipsis,
                                            style: const TextStyle(
                                              fontWeight: FontWeight.w600,
                                            ),
                                          ),
                                          const SizedBox(height: 6),
                                          Text(
                                            style.category.isEmpty
                                                ? '未分类'
                                                : style.category,
                                            style: Theme.of(context)
                                                .textTheme
                                                .bodySmall,
                                          ),
                                        ],
                                      ),
                                    ),
                                  ],
                                ),
                              ),
                              Text(
                                style.prompt,
                                maxLines: 3,
                                overflow: TextOverflow.ellipsis,
                                style: const TextStyle(
                                  fontSize: 12,
                                  height: 1.5,
                                ),
                              ),
                              if (style.negative.isNotEmpty)
                                Padding(
                                  padding: const EdgeInsets.only(top: 6),
                                  child: Text(
                                    '负向：${style.negative}',
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: Theme.of(context)
                                        .textTheme
                                        .bodySmall,
                                  ),
                                ),
                              const SizedBox(height: 12),
                              Row(
                                children: [
                                  Expanded(
                                    child: FilledButton.tonal(
                                      onPressed: () =>
                                          insert(style.prompt, style.negative),
                                      child: const Text('追加风格'),
                                    ),
                                  ),
                                  IconButton(
                                    tooltip: '查看与编辑 ${style.name}',
                                    onPressed: () => edit(style: style),
                                    icon: const Icon(
                                      Icons.edit_outlined,
                                      size: 18,
                                    ),
                                  ),
                                  IconButton(
                                    tooltip: '删除风格 ${style.name}',
                                    onPressed: () async {
                                      if (await confirm(
                                            '删除风格“${style.name}”？',
                                            '只删除收藏条目，保留预览图片和当前创作草稿。',
                                          ) &&
                                          mounted) {
                                        act(
                                          () => library.deleteStyle(style.id),
                                        );
                                      }
                                    },
                                    icon: const Icon(
                                      Icons.delete_outline,
                                      size: 18,
                                    ),
                                  ),
                                ],
                              ),
                            ],
                          ),
                        ),
                      );
                    },
                  ),
                ),
        ),
      ],
    );
  }

  Widget artistsView() {
    final entries = library.sortedArtists(
      order: order,
      query: query,
      category: category.isEmpty ? null : category,
    );
    final composition = library.composeArtistPrompt(weights);
    return Column(
      children: [
        Align(
          alignment: Alignment.centerLeft,
          child: Wrap(
            spacing: 10,
            runSpacing: 10,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              select('画师分组', category, [
                '',
                '未分组',
                ...library.groups,
              ], (v) => setState(() => category = v)),
              SizedBox(
                width: 130,
                child: DropdownButtonFormField<PromptSortOrder>(
                  initialValue: order,
                  isExpanded: true,
                  decoration: const InputDecoration(
                    labelText: '排序',
                    isDense: true,
                  ),
                  items: const [
                    DropdownMenuItem(
                      value: PromptSortOrder.name,
                      child: Text('名称'),
                    ),
                    DropdownMenuItem(
                      value: PromptSortOrder.recent,
                      child: Text('最近更新'),
                    ),
                    DropdownMenuItem(
                      value: PromptSortOrder.popularity,
                      child: Text('热度'),
                    ),
                  ],
                  onChanged: (v) => setState(() => order = v!),
                ),
              ),
              FilledButton.icon(
                key: const ValueKey('add-artist'),
                onPressed: () => edit(newArtist: true),
                icon: const Icon(Icons.add),
                label: const Text('新增画师'),
              ),
              TextButton(onPressed: groups, child: const Text('管理分组')),
              TextButton(
                onPressed: () =>
                    copy(library.toMobileExportJson(), '已复制画师 JSON'),
                child: const Text('复制 JSON'),
              ),
            ],
          ),
        ),
        const SizedBox(height: 12),
        Expanded(
          child: entries.isEmpty
              ? empty('还没有匹配的画师', '新增画师标签，选中后组合并调整每一项权重。')
              : ListView.separated(
                  itemCount: entries.length,
                  separatorBuilder: (_, _) => const SizedBox(height: 8),
                  itemBuilder: (context, index) {
                    final artist = entries[index];
                    final chosen = weights.containsKey(artist.id);
                    return Card(
                      margin: EdgeInsets.zero,
                      child: Padding(
                        padding: const EdgeInsets.all(10),
                        child: Column(
                          children: [
                            Row(
                              children: [
                                Checkbox(
                                  key: ValueKey('choose-artist-${artist.id}'),
                                  value: chosen,
                                  onChanged: (v) => setState(() {
                                    if (v == true) {
                                      weights[artist.id] = artist.defaultWeight;
                                    } else {
                                      weights.remove(artist.id);
                                    }
                                  }),
                                ),
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    children: [
                                      Text(
                                        artist.name,
                                        style: const TextStyle(
                                          fontWeight: FontWeight.w600,
                                        ),
                                      ),
                                      Text(
                                        artist.prompt,
                                        maxLines: 2,
                                        overflow: TextOverflow.ellipsis,
                                        style: const TextStyle(fontSize: 12),
                                      ),
                                      Text(
                                        '${artist.categories.isEmpty ? '未分组' : artist.categories.join(' · ')} · 热度 ${artist.danbooruCount}',
                                        style: Theme.of(context)
                                            .textTheme
                                            .bodySmall,
                                      ),
                                    ],
                                  ),
                                ),
                                IconButton(
                                  tooltip: '编辑画师 ${artist.name}',
                                  onPressed: () => edit(artist: artist),
                                  icon: const Icon(
                                    Icons.edit_outlined,
                                    size: 18,
                                  ),
                                ),
                                IconButton(
                                  tooltip: '删除画师 ${artist.name}',
                                  onPressed: () async {
                                    if (await confirm(
                                          '删除画师“${artist.name}”？',
                                          '只删除收藏条目，当前草稿不受影响。',
                                        ) &&
                                        mounted) {
                                      act(() {
                                        weights.remove(artist.id);
                                        library.deleteArtist(artist.id);
                                      });
                                    }
                                  },
                                  icon: const Icon(
                                    Icons.delete_outline,
                                    size: 18,
                                  ),
                                ),
                              ],
                            ),
                            if (chosen)
                              Row(
                                children: [
                                  const Text('权重'),
                                  Expanded(
                                    child: Slider(
                                      value: weights[artist.id]!,
                                      min: .1,
                                      max: 8,
                                      divisions: 79,
                                      label: weights[artist.id]!.toString(),
                                      onChanged: (v) => setState(
                                        () => weights[artist.id] =
                                            (v * 10).round() / 10,
                                      ),
                                    ),
                                  ),
                                  SizedBox(
                                    width: 65,
                                    child: Text(
                                      weights[artist.id]!.toString(),
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                    ),
                                  ),
                                ],
                              ),
                          ],
                        ),
                      ),
                    );
                  },
                ),
        ),
        if (weights.isNotEmpty)
          composer(composition, [
            Text('${weights.length} 位画师'),
            TextButton(
              onPressed: () => setState(weights.clear),
              child: const Text('清空选择'),
            ),
            TextButton(
              onPressed: () => copy(composition, '已复制画师串'),
              child: const Text('复制组合'),
            ),
            FilledButton(
              onPressed: () {
                insert(composition, '');
                for (final id in weights.keys) {
                  library.recordArtistUse(id);
                }
              },
              child: const Text('追加到正向'),
            ),
          ]),
      ],
    );
  }

  Widget capsulesView() => FutureBuilder<List<PromptCapsule>>(
    future: capsules,
    builder: (context, snapshot) {
      if (snapshot.hasError) {
        return empty('词库暂时无法载入', '请重新打开提示词素材；如仍失败，请检查安装文件。');
      }
      if (!snapshot.hasData) {
        return const Center(child: CircularProgressIndicator());
      }
      final all = snapshot.data!;
      final pool = all.where((v) => v.negative == negative).toList();
      final categories = pool.map((v) => v.category).toSet().toList();
      final subgroups = pool
          .where((v) => category.isEmpty || v.category == category)
          .map((v) => v.subgroup)
          .toSet()
          .toList();
      final q = query.trim().toLowerCase();
      final entries = pool
          .where(
            (v) =>
                (category.isEmpty || v.category == category) &&
                (subgroup.isEmpty || v.subgroup == subgroup) &&
                (q.isEmpty || '${v.en} ${v.zh}'.toLowerCase().contains(q)),
          )
          .toList();
      return Column(
        children: [
          Align(
            alignment: Alignment.centerLeft,
            child: Wrap(
              spacing: 10,
              runSpacing: 10,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                ChoiceChip(
                  label: const Text('正向词'),
                  selected: !negative,
                  onSelected: (_) => setState(() {
                    negative = false;
                    category = '';
                    subgroup = '';
                    selectedCapsules.clear();
                  }),
                ),
                ChoiceChip(
                  label: const Text('负向词'),
                  selected: negative,
                  onSelected: (_) => setState(() {
                    negative = true;
                    category = '';
                    subgroup = '';
                    selectedCapsules.clear();
                  }),
                ),
                select(
                  '词库分类',
                  category,
                  ['', ...categories],
                  (v) => setState(() {
                    category = v;
                    subgroup = '';
                  }),
                ),
                select('子分类', subgroup, [
                  '',
                  ...subgroups,
                ], (v) => setState(() => subgroup = v)),
                Text('${entries.length} 个标签'),
              ],
            ),
          ),
          const SizedBox(height: 12),
          Expanded(
            child: entries.isEmpty
                ? empty('没有匹配的标签', '尝试其他中文、英文或分类。')
                : LayoutBuilder(
                    builder: (context, bounds) => GridView.builder(
                      gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
                        crossAxisCount: (bounds.maxWidth / 220).floor().clamp(
                          1,
                          6,
                        ),
                        mainAxisExtent: 72,
                        mainAxisSpacing: 8,
                        crossAxisSpacing: 8,
                      ),
                      itemCount: entries.length,
                      itemBuilder: (context, index) {
                        final item = entries[index];
                        final chosen = selectedCapsules.containsKey(item.id);
                        return Material(
                          color: chosen
                              ? Theme.of(context).colorScheme.primaryContainer
                              : Theme.of(context)
                                    .colorScheme
                                    .surfaceContainerLow,
                          borderRadius: BorderRadius.circular(10),
                          child: InkWell(
                            key: ValueKey('capsule-${item.id}'),
                            borderRadius: BorderRadius.circular(10),
                            onTap: () => setState(() {
                              if (chosen) {
                                selectedCapsules.remove(item.id);
                              } else {
                                selectedCapsules[item.id] = item;
                              }
                            }),
                            child: Padding(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 12,
                                vertical: 8,
                              ),
                              child: Row(
                                children: [
                                  Expanded(
                                    child: Column(
                                      crossAxisAlignment:
                                          CrossAxisAlignment.start,
                                      mainAxisAlignment:
                                          MainAxisAlignment.center,
                                      children: [
                                        Text(
                                          item.zh,
                                          maxLines: 1,
                                          overflow: TextOverflow.ellipsis,
                                        ),
                                        Text(
                                          item.en,
                                          maxLines: 1,
                                          overflow: TextOverflow.ellipsis,
                                          style: Theme.of(context)
                                              .textTheme
                                              .bodySmall,
                                        ),
                                      ],
                                    ),
                                  ),
                                  if (chosen)
                                    const Icon(
                                      Icons.check_circle_outline,
                                      size: 18,
                                    ),
                                ],
                              ),
                            ),
                          ),
                        );
                      },
                    ),
                  ),
          ),
          if (selectedCapsules.isNotEmpty)
            composer(
              selectedCapsules.values.map((v) => v.promptText).join(', '),
              [
                Text('已选 ${selectedCapsules.length} 项'),
                TextButton(
                  onPressed: () => setState(selectedCapsules.clear),
                  child: const Text('清空选择'),
                ),
                FilledButton(
                  onPressed: () {
                    final text = selectedCapsules.values
                        .map((v) => v.promptText)
                        .join(', ');
                    insert(negative ? '' : text, negative ? text : '');
                  },
                  child: Text(negative ? '追加到负向' : '追加到正向'),
                ),
              ],
            ),
        ],
      );
    },
  );

  Widget composer(String text, List<Widget> actions) => Container(
    margin: const EdgeInsets.only(top: 10),
    padding: const EdgeInsets.all(12),
    decoration: BoxDecoration(
      color: Theme.of(context).colorScheme.surfaceContainerLow,
      borderRadius: BorderRadius.circular(12),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        ConstrainedBox(
          constraints: const BoxConstraints(maxHeight: 65),
          child: SingleChildScrollView(
            child: SelectableText(text, style: const TextStyle(fontSize: 12)),
          ),
        ),
        const SizedBox(height: 8),
        Wrap(
          spacing: 10,
          runSpacing: 6,
          crossAxisAlignment: WrapCrossAlignment.center,
          alignment: WrapAlignment.end,
          children: actions,
        ),
      ],
    ),
  );
  Widget empty(String title, String subtitle) => Center(
    child: SingleChildScrollView(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              Icons.auto_awesome_outlined,
              size: 35,
              color: Theme.of(context).colorScheme.primary,
            ),
            const SizedBox(height: 14),
            Text(title),
            const SizedBox(height: 8),
            Text(
              subtitle,
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ],
        ),
      ),
    ),
  );
}

class _PromptEntryEditor extends StatefulWidget {
  const _PromptEntryEditor({
    required this.controller,
    this.style,
    this.artist,
    required this.artistMode,
    this.initialPrompt = '',
    this.initialNegative = '',
  });
  final WorkbenchController controller;
  final PromptStyle? style;
  final PromptArtist? artist;
  final bool artistMode;
  final String initialPrompt, initialNegative;
  @override
  State<_PromptEntryEditor> createState() => _PromptEntryEditorState();
}

class _PromptEntryEditorState extends State<_PromptEntryEditor> {
  late final name = TextEditingController(
    text: widget.style?.name ?? widget.artist?.name ?? '',
  );
  late final prompt = TextEditingController(
    text: widget.style?.prompt ?? widget.artist?.prompt ?? widget.initialPrompt,
  );
  late final negative = TextEditingController(
    text: widget.style?.negative ?? widget.initialNegative,
  );
  late final category = TextEditingController(
    text: widget.style?.category ?? '',
  );
  late final weight = TextEditingController(
    text: (widget.artist?.defaultWeight ?? 1).toString(),
  );
  late final heat = TextEditingController(
    text: (widget.artist?.danbooruCount ?? 0).toString(),
  );
  late final selectedGroups = {...?widget.artist?.categories}
    ..remove(PromptLibrary.ungroupedCategory);
  late String? preview = widget.style?.previewAssetRef;
  bool busy = false;
  String? error;
  @override
  void dispose() {
    for (final c in [name, prompt, negative, category, weight, heat]) {
      c.dispose();
    }
    super.dispose();
  }

  Widget field(
    String label,
    TextEditingController controller, {
    int lines = 1,
  }) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: TextField(
      controller: controller,
      minLines: lines,
      maxLines: lines == 1 ? 1 : 8,
      decoration: InputDecoration(labelText: label, alignLabelWithHint: true),
    ),
  );
  Future<void> pickPreview() async {
    setState(() {
      busy = true;
      error = null;
    });
    try {
      final bytes = await pickImage();
      if (bytes == null || !mounted) return;
      final asset = await widget.controller.assets!.save(bytes);
      if (mounted) setState(() => preview = asset.assetRef);
    } catch (_) {
      if (mounted) setState(() => error = '预览图无法导入，请选择有效的 PNG、JPEG 或 WebP 图片。');
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  void save() {
    try {
      final library = widget.controller.promptLibrary;
      if (widget.artistMode) {
        final w = double.tryParse(weight.text);
        final h = int.tryParse(heat.text);
        if (w == null || h == null || h < 0) {
          throw const FormatException('请输入有效的权重和非负整数热度');
        }
        if (widget.artist == null) {
          library.addArtist(
            name: name.text,
            prompt: prompt.text,
            categories: selectedGroups.toList(),
            defaultWeight: w,
            danbooruCount: h,
          );
        } else {
          library.updateArtist(
            widget.artist!.copyWith(
              name: name.text,
              prompt: prompt.text,
              categories: selectedGroups.isEmpty
                  ? [PromptLibrary.ungroupedCategory]
                  : selectedGroups.toList(),
              defaultWeight: w,
              danbooruCount: h,
            ),
          );
        }
      } else {
        if (widget.style == null || widget.style!.id.isEmpty) {
          library.addStyle(
            name: name.text,
            prompt: prompt.text,
            negative: negative.text,
            category: category.text,
            previewAssetRef: preview,
          );
        } else {
          library.updateStyle(
            widget.style!.copyWith(
              name: name.text,
              prompt: prompt.text,
              negative: negative.text,
              category: category.text,
              previewAssetRef: preview,
              clearPreviewAssetRef: preview == null,
            ),
          );
        }
      }
      Navigator.pop(context);
    } on FormatException catch (e) {
      setState(() => error = e.message);
    }
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: Text(
      widget.artistMode
          ? (widget.artist == null ? '新增画师' : '编辑画师')
          : (widget.style == null || widget.style!.id.isEmpty
                ? '新增风格'
                : '编辑风格'),
    ),
    content: SizedBox(
      width: 540,
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            field('名称', name),
            field(
              widget.artistMode ? '画师标签 / 提示词' : '风格正向提示词',
              prompt,
              lines: 3,
            ),
            if (!widget.artistMode) ...[
              field('风格负向提示词（可选）', negative, lines: 2),
              field('分类（可选）', category),
              if (preview != null && widget.controller.assets != null)
                SizedBox(
                  height: 110,
                  width: 160,
                  child: StoredImage(
                    store: widget.controller.assets!,
                    assetRef: preview!,
                  ),
                ),
              Wrap(
                spacing: 8,
                children: [
                  TextButton.icon(
                    onPressed: busy || widget.controller.assets == null
                        ? null
                        : pickPreview,
                    icon: const Icon(Icons.image_outlined),
                    label: Text(busy ? '正在导入…' : '选择预览图'),
                  ),
                  if (preview != null)
                    TextButton(
                      onPressed: busy
                          ? null
                          : () => setState(() => preview = null),
                      child: const Text('移除预览关联'),
                    ),
                ],
              ),
            ] else ...[
              field('默认权重 · 0.1–8.0', weight),
              field('Danbooru 热度 · 未知填 0', heat),
              const Text('分组（可多选）'),
              const SizedBox(height: 8),
              if (widget.controller.promptLibrary.groups.isEmpty)
                const Text('可在“管理分组”中创建分组。'),
              Wrap(
                spacing: 6,
                runSpacing: 6,
                children: [
                  for (final group in widget.controller.promptLibrary.groups)
                    FilterChip(
                      label: Text(group),
                      selected: selectedGroups.contains(group),
                      onSelected: (v) => setState(() {
                        if (v) {
                          selectedGroups.add(group);
                        } else {
                          selectedGroups.remove(group);
                        }
                      }),
                    ),
                ],
              ),
            ],
            if (error != null)
              Padding(
                padding: const EdgeInsets.only(top: 12),
                child: Text(
                  error!,
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ),
          ],
        ),
      ),
    ),
    actions: [
      TextButton(
        onPressed: busy ? null : () => Navigator.pop(context),
        child: const Text('取消'),
      ),
      FilledButton(onPressed: busy ? null : save, child: const Text('保存')),
    ],
  );
}

class _PromptGroupsDialog extends StatefulWidget {
  const _PromptGroupsDialog({required this.library});
  final PromptLibrary library;
  @override
  State<_PromptGroupsDialog> createState() => _PromptGroupsDialogState();
}

class _PromptGroupsDialogState extends State<_PromptGroupsDialog> {
  final name = TextEditingController();
  String? editing, error;
  @override
  void dispose() {
    name.dispose();
    super.dispose();
  }

  void change(VoidCallback action) {
    try {
      action();
      setState(() {
        error = null;
        editing = null;
        name.clear();
      });
    } on FormatException catch (e) {
      setState(() => error = e.message);
    }
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: const Text('管理画师分组'),
    content: SizedBox(
      width: 430,
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (final group in widget.library.groups)
              ListTile(
                contentPadding: EdgeInsets.zero,
                title: Text(group),
                trailing: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    IconButton(
                      tooltip: '重命名 $group',
                      onPressed: () => setState(() {
                        editing = group;
                        name.text = group;
                      }),
                      icon: const Icon(Icons.edit_outlined),
                    ),
                    IconButton(
                      tooltip: '删除分组 $group',
                      onPressed: () async {
                        final approved = await showDialog<bool>(
                          context: context,
                          builder: (context) => AlertDialog(
                            title: Text('删除分组“$group”？'),
                            content: const Text('保留所有画师，移除它们与该分组的关联。'),
                            actions: [
                              TextButton(
                                onPressed: () => Navigator.pop(context, false),
                                child: const Text('取消'),
                              ),
                              FilledButton(
                                onPressed: () => Navigator.pop(context, true),
                                child: const Text('确认删除'),
                              ),
                            ],
                          ),
                        );
                        if (approved == true && mounted) {
                          change(() => widget.library.deleteGroup(group));
                        }
                      },
                      icon: const Icon(Icons.delete_outline),
                    ),
                  ],
                ),
              ),
            const SizedBox(height: 8),
            TextField(
              controller: name,
              decoration: InputDecoration(
                labelText: editing == null ? '新分组名称' : '重命名分组',
              ),
            ),
            if (error != null)
              Text(
                error!,
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
          ],
        ),
      ),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('完成'),
      ),
      FilledButton(
        onPressed: () => change(() {
          if (editing == null) {
            widget.library.addGroup(name.text);
          } else {
            widget.library.renameGroup(editing!, name.text);
          }
        }),
        child: Text(editing == null ? '新增分组' : '保存名称'),
      ),
    ],
  );
}

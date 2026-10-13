part of 'workbench.dart';

extension _LibraryPanels on _WorkbenchState {
  Future<void> _importToGallery() async {
    if (libraryBusy || c.maintainingAssets || c.assets == null) return;
    _refresh(() => libraryBusy = true);
    ImageMetadataResult? metadata;
    try {
      await c.prepareEditing(() async {
        final bytes = await pickImage();
        if (bytes == null || !mounted || c.closing) return;
        final asset = await c.assets!.save(bytes);
        metadata = await parseImageMetadata(bytes);
        if (!mounted || c.closing) return;
        c.addImported(asset, metadata: metadata);
        await c.flush();
      });
      if (mounted && metadata != null) await _chooseMetadata(metadata!);
    } catch (error) {
      if (mounted) {
        _message(
          c.saveFailed
              ? c.saveErrorMessage
              : '图片导入失败：${error is FormatException ? error.message : '请检查格式、大小和存储空间'}',
        );
      }
    } finally {
      if (mounted) _refresh(() => libraryBusy = false);
    }
  }

  Future<void> _chooseMetadata(ImageMetadataResult metadata) async {
    final selected = await showDialog<Set<String>>(
      context: context,
      builder: (_) => MetadataSelectionDialog(metadata: metadata),
    );
    if (selected == null || !mounted || c.closing) return;
    c.applyMetadata(metadata, selectedFields: selected);
    try {
      await c.flush();
      if (mounted) {
        _setPage(0);
        _message('已回填 ${selected.length} 项参数；未选和缺失字段保持原值');
      }
    } catch (_) {
      if (mounted) _message(c.saveErrorMessage);
    }
  }

  Future<void> _inspectMetadata(SceneResult result) async {
    if (result.assetRef == null || c.assets == null || libraryBusy) return;
    _refresh(() => libraryBusy = true);
    try {
      final metadata = await c.prepareEditing(
        () async => parseImageMetadata(await c.assets!.read(result.assetRef!)),
      );
      if (mounted) await _chooseMetadata(metadata);
    } catch (_) {
      if (mounted) _message('原图无法读取或解析；图库记录仍保留。可在整理文件中检查缺失或损坏。');
    } finally {
      if (mounted) _refresh(() => libraryBusy = false);
    }
  }

  Future<void> _removeGallery(Set<String> ids) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(ids.length == 1 ? '移除这条记录？' : '清空 ${ids.length} 条图库记录？'),
        content: const Text(
          '将移除图库索引。原图文件、编辑草稿和参考素材仍保留；可在“整理文件”中恢复未登记图片或清理不再使用的文件。',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('确认移除记录'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    try {
      await c.removeGalleryRecords(ids);
      if (mounted) _message('已移除图库记录，原图文件保留');
    } catch (_) {
      if (mounted) {
        _message(c.saveFailed ? c.saveErrorMessage : '暂时无法移除记录，请稍后再试');
      }
    }
  }

  Future<void> _maintainGallery() async {
    if (c.assets == null || libraryBusy) return;
    _refresh(() => libraryBusy = true);
    try {
      final audit = await c.maintainAssets(
        () => auditImageAssets(snapshot: c.exportWorkspace(), store: c.assets!),
      );
      if (!mounted) return;
      final action = await showDialog<String>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Text('整理图库文件'),
          content: SizedBox(
            width: 520,
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '已检查 ${audit.storedRefs.length} 个文件\n仍被使用：${audit.referencedRefs.length}\n缺失：${audit.missingReferences.length} · 损坏：${audit.corruptAssets.length}\n未被引用：${audit.unusedAssets.length}',
                  ),
                  const SizedBox(height: 12),
                  const Text(
                    '草稿、重绘图层、派生关系和 Vibe 库中的图片会受到保护。恢复可找回保存后未登记或已移除记录的图片；提示词等缺失信息需从图片元数据重新解析。',
                  ),
                  if (audit.missingReferences.isNotEmpty ||
                      audit.corruptAssets.isNotEmpty) ...[
                    const SizedBox(height: 12),
                    const Text('以下文件缺失或损坏，原记录保留。缺失图片可重新导入相同原文件；损坏的受管文件需从备份恢复。'),
                    for (final ref in {
                      ...audit.missingReferences,
                      ...audit.corruptAssets,
                    }.take(12))
                      SelectableText(ref, style: const TextStyle(fontSize: 10)),
                  ],
                  const SizedBox(height: 12),
                  const Text('清理会永久删除当前未引用的受管文件，无法撤销。应用不会自动执行清理。'),
                ],
              ),
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(ctx),
              child: const Text('关闭'),
            ),
            TextButton(
              onPressed:
                  audit.unusedAssets.difference(audit.corruptAssets).isEmpty
                  ? null
                  : () => Navigator.pop(ctx, 'recover'),
              child: const Text('恢复未登记图片'),
            ),
            FilledButton(
              onPressed: audit.unusedAssets.isEmpty
                  ? null
                  : () => Navigator.pop(ctx, 'clean'),
              child: Text('永久清理 ${audit.unusedAssets.length} 个文件'),
            ),
          ],
        ),
      );
      if (!mounted || action == null) return;
      if (action == 'clean') {
        final count = await c.cleanUnusedAssets(audit.unusedAssets);
        if (mounted) _message('已清理 $count 个未使用文件；新出现的引用已再次检查');
      } else {
        var count = 0;
        await c.prepareEditing(() async {
          for (final ref in audit.unusedAssets.difference(
            audit.corruptAssets,
          )) {
            final bytes = await c.assets!.read(ref);
            final asset = await c.assets!.save(bytes);
            final metadata = await parseImageMetadata(bytes);
            if (c.closing) break;
            c.addImported(asset, metadata: metadata, title: '恢复图片');
            await c.flush();
            count++;
          }
        });
        if (mounted) _message('已恢复 $count 张图片到图库');
      }
    } catch (_) {
      if (mounted) {
        _message(
          c.saveFailed ? c.saveErrorMessage : '整理未完成。请等待任务结束，并检查文件权限；已保留现有记录。',
        );
      }
    } finally {
      if (mounted) _refresh(() => libraryBusy = false);
    }
  }

  Widget _libraryGallery() {
    final needle = query.toLowerCase();
    final results = c.results
        .where(
          (r) =>
              (!favoritesOnly || r.favorite) &&
              '${r.title}\n${r.prompt}\n${r.negative}\n${r.model}'
                  .toLowerCase()
                  .contains(needle),
        )
        .toList();
    final visible = results.take(galleryLimit).toList();
    final counts = c.dailySuccessCounts;
    final today = DateTime.now();
    final week = List.generate(
      7,
      (i) =>
          (counts[WorkbenchController.dayKey(
            DateTime(today.year, today.month, today.day - i),
          )] ??
          0),
    ).fold<int>(0, (a, b) => a + b);
    return CustomScrollView(
      key: const PageStorageKey('library-gallery'),
      slivers: [
        SliverPadding(
          padding: const EdgeInsets.fromLTRB(24, 22, 24, 8),
          sliver: SliverToBoxAdapter(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  '图库与素材',
                  style: TextStyle(fontSize: 24, fontWeight: FontWeight.w600),
                ),
                const SizedBox(height: 7),
                _muted('让每张图片的来源、参数和灵感，都有处可寻。'),
                const SizedBox(height: 16),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    FilledButton.icon(
                      onPressed: c.assets == null || libraryBusy
                          ? null
                          : _importToGallery,
                      icon: const Icon(
                        Icons.add_photo_alternate_outlined,
                        size: 17,
                      ),
                      label: const Text('导入图片与参数'),
                    ),
                    OutlinedButton.icon(
                      onPressed: _openVibeLibrary,
                      icon: const Icon(Icons.auto_awesome_outlined, size: 17),
                      label: const Text('Vibe 编码库'),
                    ),
                    TextButton.icon(
                      onPressed:
                          c.assets == null ||
                              libraryBusy ||
                              !c.canMaintainAssets
                          ? null
                          : _maintainGallery,
                      icon: const Icon(Icons.inventory_2_outlined, size: 17),
                      label: const Text('整理文件'),
                    ),
                    TextButton(
                      onPressed: c.results.isEmpty || libraryBusy
                          ? null
                          : () => _removeGallery(
                              c.results.map((r) => r.id).toSet(),
                            ),
                      child: const Text('清空历史'),
                    ),
                  ],
                ),
                if (libraryBusy)
                  const Padding(
                    padding: EdgeInsets.only(top: 10),
                    child: LinearProgressIndicator(),
                  ),
                const SizedBox(height: 16),
                Row(
                  children: [
                    Expanded(
                      child: TextFormField(
                        initialValue: query,
                        onChanged: (v) => _refresh(() {
                          query = v;
                          galleryLimit = 60;
                        }),
                        decoration: const InputDecoration(
                          prefixIcon: Icon(Icons.search_rounded, size: 18),
                          labelText: '搜索图库',
                          hintText: '名称、提示词或模型',
                        ),
                      ),
                    ),
                    const SizedBox(width: 10),
                    FilterChip(
                      label: const Text('收藏'),
                      selected: favoritesOnly,
                      onSelected: (v) => _refresh(() {
                        favoritesOnly = v;
                        galleryLimit = 60;
                      }),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                _muted(
                  '${results.length} 件作品 · 今日成功 ${counts[WorkbenchController.dayKey(today)] ?? 0} · 近 7 日 $week（从本版本开始记录）',
                ),
                const SizedBox(height: 8),
              ],
            ),
          ),
        ),
        if (results.isEmpty)
          SliverToBoxAdapter(
            child: Padding(
              padding: const EdgeInsets.all(36),
              child: Center(
                child: _muted(
                  c.results.isEmpty
                      ? '图库还没有作品。导入一张图片，或开始创作。'
                      : '没有匹配的作品，试试其他关键词。',
                ),
              ),
            ),
          ),
        SliverPadding(
          padding: const EdgeInsets.symmetric(horizontal: 24),
          sliver: SliverGrid.builder(
            gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
              maxCrossAxisExtent: 280,
              childAspectRatio: .75,
              crossAxisSpacing: 14,
              mainAxisSpacing: 14,
            ),
            itemCount: visible.length,
            itemBuilder: (ctx, index) {
              final r = visible[index];
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
                            _art(r),
                            Positioned(
                              top: 8,
                              left: 8,
                              child: _badge(
                                r.isDemo
                                    ? '示意图'
                                    : r.isImported
                                    ? '导入图片'
                                    : '本地原图',
                              ),
                            ),
                            Positioned(
                              top: 2,
                              right: 2,
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
                        padding: const EdgeInsets.fromLTRB(12, 10, 4, 6),
                        child: Row(
                          children: [
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    r.title,
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: const TextStyle(fontSize: 12),
                                  ),
                                  _muted(
                                    '${r.width} × ${r.height}${r.createdAt == null ? '' : ' · ${WorkbenchController.dayKey(r.createdAt!.toLocal())}'}',
                                    size: 10,
                                  ),
                                ],
                              ),
                            ),
                            PopupMenuButton<String>(
                              tooltip: '作品操作 ${r.title}',
                              onSelected: (action) {
                                if (action == 'metadata') {
                                  _inspectMetadata(r);
                                } else if (action == 'delete') {
                                  _removeGallery({r.id});
                                } else {
                                  _resultDialog(r);
                                }
                              },
                              itemBuilder: (_) => [
                                const PopupMenuItem(
                                  value: 'detail',
                                  child: Text('查看详情'),
                                ),
                                if (r.assetRef != null)
                                  const PopupMenuItem(
                                    value: 'metadata',
                                    child: Text('读取图片参数'),
                                  ),
                                const PopupMenuItem(
                                  value: 'delete',
                                  child: Text('移除记录'),
                                ),
                              ],
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
        SliverToBoxAdapter(
          child: Padding(
            padding: const EdgeInsets.all(20),
            child: Center(
              child: visible.length < results.length
                  ? OutlinedButton(
                      onPressed: () => _refresh(() => galleryLimit += 60),
                      child: Text(
                        '加载更多 · 已显示 ${visible.length}/${results.length}',
                      ),
                    )
                  : _muted('已显示全部 ${results.length} 件作品'),
            ),
          ),
        ),
      ],
    );
  }
}

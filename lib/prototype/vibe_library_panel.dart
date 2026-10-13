part of 'workbench.dart';

extension _VibeLibraryPanel on _WorkbenchState {
  Future<String?> _vibeTitle(String initial) async {
    var value = initial;
    return showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('为这份氛围命名'),
        content: TextFormField(
          initialValue: initial,
          autofocus: true,
          maxLength: 120,
          decoration: const InputDecoration(labelText: '编码名称'),
          onChanged: (v) => value = v,
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(
              ctx,
              value.trim().isEmpty ? '未命名氛围' : value.trim(),
            ),
            child: const Text('保存名称'),
          ),
        ],
      ),
    );
  }

  Future<void> _saveVibeToLibrary(
    VibeReference reference, {
    int? referenceIndex,
  }) async {
    final title = await _vibeTitle('未命名氛围');
    if (title == null || !mounted) return;
    try {
      VibeLibraryEntry entry;
      if (reference.assetId.isEmpty &&
          reference.encodedVibe?.isNotEmpty == true) {
        final target = c.connection;
        final model = c.parameters.model;
        final confirmed = await showDialog<bool>(
          context: context,
          builder: (ctx) => AlertDialog(
            title: const Text('确认导入编码的适用范围'),
            content: Text(
              '图片没有记录编码来源。仅当你确认它适用于以下模型与服务时继续：\n\n$model\n${target.label}\n${target.uri}\n\n本次保存不发送网络请求。信息提取值固定为 ${reference.informationExtracted}；没有源图时无法重新编码。',
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(ctx, false),
                child: const Text('取消'),
              ),
              FilledButton(
                onPressed: () => Navigator.pop(ctx, true),
                child: const Text('确认适用并保存'),
              ),
            ],
          ),
        );
        if (confirmed != true || !mounted || c.closing) return;
        entry = c.vibeLibrary.addPreEncodedEntry(
          title: title,
          encodedBytes: Uint8List.fromList(utf8.encode(reference.encodedVibe!)),
          model: model,
          providerProtocol: target.protocol,
          endpoint: target.uri,
          informationExtracted: reference.informationExtracted,
          strength: reference.strength,
        );
        await c.flush();
      } else {
        entry = await c.saveVibeReference(reference, title);
      }
      if (!mounted || c.closing) return;
      if (referenceIndex != null) {
        final refs = [...c.parameters.vibeReferences];
        if (referenceIndex < refs.length &&
            identical(refs[referenceIndex], reference)) {
          refs[referenceIndex] = entry.toReference();
          c.updateAdvanced(c.parameters.copyWith(vibeReferences: refs));
          await c.flush();
        }
      }
      _message('已保存到 Vibe 编码库，相同来源与编码设置可直接复用');
    } catch (error) {
      if (mounted) {
        _message(
          c.saveFailed
              ? c.saveErrorMessage
              : error is FormatException
              ? error.message
              : '编码未完成，请检查接入配置和参考图',
        );
      }
    }
  }

  Future<void> _openVibeLibrary() async {
    var search = '';
    var busy = false;
    await showDialog<void>(
      context: context,
      builder: (ctx) => ListenableBuilder(
        listenable: c,
        builder: (ctx, _) => StatefulBuilder(
          builder: (ctx, change) {
            final entries = c.vibeLibrary.search(search).reversed.toList();
            return AlertDialog(
              title: const Text('Vibe 编码库'),
              content: SizedBox(
                width: 760,
                height: math.min(560, MediaQuery.sizeOf(ctx).height * .62),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('把常用氛围留在本地。编码按模型、渠道和信息提取值匹配，生成强度可独立调整。'),
                    const SizedBox(height: 12),
                    TextFormField(
                      decoration: const InputDecoration(
                        labelText: '搜索编码库',
                        prefixIcon: Icon(Icons.search),
                      ),
                      onChanged: (value) => change(() => search = value),
                    ),
                    const SizedBox(height: 8),
                    Wrap(
                      spacing: 8,
                      runSpacing: 6,
                      children: [
                        OutlinedButton.icon(
                          onPressed:
                              busy ||
                                  c.generating ||
                                  c.encodingVibe ||
                                  c.assets == null
                              ? null
                              : () async {
                                  change(() => busy = true);
                                  try {
                                    final ref = await _importImage();
                                    if (ref != null && mounted) {
                                      await _saveVibeToLibrary(
                                        VibeReference(assetId: ref),
                                      );
                                    }
                                  } finally {
                                    if (ctx.mounted) change(() => busy = false);
                                  }
                                },
                          icon: const Icon(
                            Icons.add_photo_alternate_outlined,
                            size: 17,
                          ),
                          label: const Text('从图片编码入库'),
                        ),
                        TextButton(
                          onPressed:
                              busy ||
                                  c.generating ||
                                  c.encodingVibe ||
                                  c.vibeLibrary.cacheEntries.isEmpty
                              ? null
                              : () async {
                                  c.vibeLibrary.clearCache();
                                  try {
                                    await c.flush();
                                    if (ctx.mounted) change(() {});
                                  } catch (_) {
                                    if (mounted) _message(c.saveErrorMessage);
                                  }
                                },
                          child: Text(
                            '清除临时编码缓存（${c.vibeLibrary.cacheEntries.length}）',
                          ),
                        ),
                      ],
                    ),
                    if (busy) const LinearProgressIndicator(),
                    const SizedBox(height: 8),
                    Expanded(
                      child: entries.isEmpty
                          ? Center(
                              child: _muted(
                                search.isEmpty
                                    ? '还没有保存的氛围。从图片创建，或在参考面板保存当前 Vibe。'
                                    : '没有匹配的编码',
                              ),
                            )
                          : ListView.separated(
                              itemCount: entries.length,
                              separatorBuilder: (_, _) =>
                                  const Divider(height: 18),
                              itemBuilder: (_, i) {
                                final entry = entries[i];
                                final compatible = entry.isCompatible(
                                  c.parameters.model,
                                  c.connection,
                                );
                                return Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Row(
                                      crossAxisAlignment:
                                          CrossAxisAlignment.start,
                                      children: [
                                        SizedBox(
                                          width: 56,
                                          height: 56,
                                          child:
                                              entry.sourceAssetRef.isEmpty ||
                                                  c.assets == null
                                              ? Icon(
                                                  Icons.auto_awesome,
                                                  color: colors.primary,
                                                )
                                              : StoredImage(
                                                  store: c.assets!,
                                                  assetRef:
                                                      entry.sourceAssetRef,
                                                ),
                                        ),
                                        const SizedBox(width: 12),
                                        Expanded(
                                          child: Column(
                                            crossAxisAlignment:
                                                CrossAxisAlignment.start,
                                            children: [
                                              Text(
                                                entry.title,
                                                style: const TextStyle(
                                                  fontWeight: FontWeight.w600,
                                                ),
                                              ),
                                              _muted(
                                                '${entry.model}\n${ServiceConnection.labels[entry.providerProtocol] ?? entry.providerProtocol} · 提取 ${entry.informationExtracted} · 强度 ${entry.strength}',
                                              ),
                                              if (!compatible)
                                                _muted(
                                                  '当前模型或服务地址不同；请切换后使用，或从原图重新编码。',
                                                ),
                                            ],
                                          ),
                                        ),
                                      ],
                                    ),
                                    Wrap(
                                      spacing: 8,
                                      children: [
                                        FilledButton.tonal(
                                          onPressed:
                                              busy ||
                                                  !compatible ||
                                                  c
                                                          .parameters
                                                          .vibeReferences
                                                          .length >=
                                                      4
                                              ? null
                                              : () async {
                                                  c.updateAdvanced(
                                                    c.parameters.copyWith(
                                                      vibeReferences: [
                                                        ...c
                                                            .parameters
                                                            .vibeReferences,
                                                        entry.toReference(),
                                                      ],
                                                    ),
                                                  );
                                                  try {
                                                    await c.flush();
                                                    if (ctx.mounted) {
                                                      Navigator.pop(ctx);
                                                    }
                                                    if (mounted) {
                                                      _refresh(() {
                                                        page = 0;
                                                        group = '参考';
                                                      });
                                                      _message('已加入 Vibe 参考');
                                                    }
                                                  } catch (_) {
                                                    if (mounted) {
                                                      _message(
                                                        c.saveErrorMessage,
                                                      );
                                                    }
                                                  }
                                                },
                                          child: const Text('加入当前参考'),
                                        ),
                                        TextButton(
                                          onPressed: busy
                                              ? null
                                              : () async {
                                                  final name = await _vibeTitle(
                                                    entry.title,
                                                  );
                                                  if (name == null ||
                                                      !mounted) {
                                                    return;
                                                  }
                                                  c.vibeLibrary.rename(
                                                    entry.id,
                                                    name,
                                                  );
                                                  try {
                                                    await c.flush();
                                                    if (ctx.mounted) {
                                                      change(() {});
                                                    }
                                                  } catch (_) {
                                                    if (mounted) {
                                                      _message(
                                                        c.saveErrorMessage,
                                                      );
                                                    }
                                                  }
                                                },
                                          child: const Text('重命名'),
                                        ),
                                        TextButton(
                                          onPressed: busy
                                              ? null
                                              : () async {
                                                  final confirm = await showDialog<bool>(
                                                    context: context,
                                                    builder: (confirmCtx) =>
                                                        AlertDialog(
                                                          title: const Text(
                                                            '删除这份编码？',
                                                          ),
                                                          content: Text(
                                                            '从编码库移除“${entry.title}”。当前草稿和历史任务中的参考快照、原图仍保留。',
                                                          ),
                                                          actions: [
                                                            TextButton(
                                                              onPressed: () =>
                                                                  Navigator.pop(
                                                                    confirmCtx,
                                                                    false,
                                                                  ),
                                                              child: const Text(
                                                                '取消',
                                                              ),
                                                            ),
                                                            FilledButton(
                                                              onPressed: () =>
                                                                  Navigator.pop(
                                                                    confirmCtx,
                                                                    true,
                                                                  ),
                                                              child: const Text(
                                                                '删除编码',
                                                              ),
                                                            ),
                                                          ],
                                                        ),
                                                  );
                                                  if (confirm != true ||
                                                      !mounted) {
                                                    return;
                                                  }
                                                  c.vibeLibrary.delete(
                                                    entry.id,
                                                  );
                                                  try {
                                                    await c.flush();
                                                    if (ctx.mounted) {
                                                      change(() {});
                                                    }
                                                  } catch (_) {
                                                    if (mounted) {
                                                      _message(
                                                        c.saveErrorMessage,
                                                      );
                                                    }
                                                  }
                                                },
                                          child: const Text('删除'),
                                        ),
                                      ],
                                    ),
                                  ],
                                );
                              },
                            ),
                    ),
                  ],
                ),
              ),
              actions: [
                if (c.encodingVibe)
                  TextButton.icon(
                    onPressed: c.cancelVibeEncoding,
                    icon: const Icon(Icons.stop_circle_outlined, size: 16),
                    label: const Text('取消 Vibe 编码'),
                  ),
                TextButton(
                  onPressed: busy ? null : () => Navigator.pop(ctx),
                  child: const Text('关闭'),
                ),
              ],
            );
          },
        ),
      ),
    );
  }
}

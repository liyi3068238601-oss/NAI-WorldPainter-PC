import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../assistant/assistant_controller.dart';
import '../assistant/prompt_memory.dart';

/// Opens the assistant's local memory manager.
Future<void> showAssistantMemories(
  BuildContext context,
  AssistantController controller,
) => showDialog<void>(
  context: context,
  builder: (_) => _AssistantMemoryDialog(
    key: const ValueKey('assistant-memory-dialog'),
    controller: controller,
  ),
);

enum _MemoryTab { pending, all, stale }

class _MemoryDraft {
  const _MemoryDraft({
    required this.trigger,
    required this.content,
    required this.kind,
  });

  final String trigger;
  final String content;
  final MemoryKind kind;
}

double _dialogWidth(BuildContext context, double preferred) {
  final available = MediaQuery.sizeOf(context).width - 104;
  return math.max(280.0, math.min(preferred, available)).toDouble();
}

double _dialogBodyHeight(BuildContext context, double preferred) {
  final available = MediaQuery.sizeOf(context).height - 240;
  return math.max(180.0, math.min(preferred, available)).toDouble();
}

class _AssistantMemoryDialog extends StatefulWidget {
  const _AssistantMemoryDialog({super.key, required this.controller});

  final AssistantController controller;

  @override
  State<_AssistantMemoryDialog> createState() => _AssistantMemoryDialogState();
}

class _AssistantMemoryDialogState extends State<_AssistantMemoryDialog> {
  final _search = TextEditingController();
  final Set<String> _selectedIds = {};
  _MemoryTab _tab = _MemoryTab.all;
  MemoryKind? _kind;
  MemorySource? _source;
  String _query = '';
  String? _notice;
  bool _selecting = false;
  bool _mutating = false;

  AssistantController get _controller => widget.controller;
  PromptMemoryLibrary get _library => _controller.state.memories;
  bool get _mutationEnabled => !_mutating && !_controller.busy;

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  void _setNotice(String text) {
    if (!mounted) return;
    setState(() => _notice = text);
  }

  bool _checkRevision(int revision) {
    if (!mounted) return false;
    if (_library.revision != revision) {
      _setNotice('记忆列表在弹窗期间已更新，请重新打开操作。');
      return false;
    }
    if (_controller.busy) {
      _setNotice('小助手正在运行，当前不能修改记忆。');
      return false;
    }
    return true;
  }

  Future<void> _mutate(Future<void> Function() action) async {
    if (!_mutationEnabled) {
      _setNotice(_controller.busy ? '小助手正在运行，当前不能修改记忆。' : '请等待当前操作完成。');
      return;
    }
    setState(() {
      _mutating = true;
      _notice = null;
    });
    try {
      await action();
    } on MemoryRevisionConflictException {
      _setNotice('记忆列表在弹窗期间已更新，请重新打开操作。');
    } on MemoryConflictException {
      _setNotice('记忆已发生变化，请重新打开后再试。');
    } catch (error) {
      final detail = error is ArgumentError
          ? error.message.toString()
          : '请检查本地保存状态后重试。';
      _setNotice('操作未完成：$detail');
    } finally {
      if (mounted) setState(() => _mutating = false);
    }
  }

  void _switchTab(_MemoryTab tab) {
    setState(() {
      _tab = tab;
      _selectedIds.clear();
      _selecting = false;
      _notice = null;
    });
  }

  List<MemoryEntry> _visibleEntries() {
    final matches = _library.search(
      _query.trim(),
      kind: _kind,
      source: _source,
    );
    final matchingIds = matches.map((entry) => entry.id).toSet();
    return switch (_tab) {
      _MemoryTab.pending =>
        matches
            .where((entry) => entry.source == MemorySource.pendingLlmCandidate)
            .toList(),
      _MemoryTab.all => matches,
      _MemoryTab.stale =>
        _library
            .stale(olderThan: const Duration(days: 90))
            .where((entry) => matchingIds.contains(entry.id))
            .toList(),
    };
  }

  int get _pendingCount => _library.entries
      .where((entry) => entry.source == MemorySource.pendingLlmCandidate)
      .length;

  Widget _kindFilter(BuildContext context) => KeyedSubtree(
    key: const ValueKey('assistant-memory-kind-filter'),
    child: SizedBox(
      width: 170,
      child: DropdownButtonFormField<String>(
        key: ValueKey(
          'assistant-memory-kind-filter-value-${_kind?.wireName ?? 'all'}',
        ),
        initialValue: _kind?.wireName ?? '',
        isExpanded: true,
        decoration: const InputDecoration(labelText: '记忆类别'),
        items: [
          const DropdownMenuItem(value: '', child: Text('全部类别')),
          for (final kind in MemoryKind.values)
            DropdownMenuItem(value: kind.wireName, child: Text(kind.label)),
        ],
        onChanged: _mutating
            ? null
            : (value) => setState(() {
                _kind = value == null || value.isEmpty
                    ? null
                    : MemoryKind.values.firstWhere(
                        (kind) => kind.wireName == value,
                      );
                _selectedIds.clear();
              }),
      ),
    ),
  );

  Widget _sourceFilter(BuildContext context) => KeyedSubtree(
    key: const ValueKey('assistant-memory-source-filter'),
    child: SizedBox(
      width: 190,
      child: DropdownButtonFormField<String>(
        key: ValueKey(
          'assistant-memory-source-filter-value-${_source?.name ?? 'all'}',
        ),
        initialValue: _source?.name ?? '',
        isExpanded: true,
        decoration: const InputDecoration(labelText: '来源'),
        items: [
          const DropdownMenuItem(value: '', child: Text('全部来源')),
          for (final source in MemorySource.values)
            DropdownMenuItem<String>(
              value: source.name,
              child: Text(source.label, overflow: TextOverflow.ellipsis),
            ),
        ],
        onChanged: _mutating
            ? null
            : (value) => setState(() {
                _source = value == null || value.isEmpty
                    ? null
                    : MemorySource.values.firstWhere(
                        (source) => source.name == value,
                      );
                _selectedIds.clear();
              }),
      ),
    ),
  );

  List<MemoryEntry> _allEntries() => _library.entries;

  Future<void> _openEditor({MemoryEntry? entry}) async {
    if (!_mutationEnabled) {
      _setNotice(_controller.busy ? '小助手正在运行，当前不能修改记忆。' : '请等待当前操作完成。');
      return;
    }
    if (entry?.source == MemorySource.pendingLlmCandidate) {
      _setNotice('待审核候选请使用“编辑并采纳”，避免未经确认改变审核状态。');
      return;
    }
    final expectedRevision = _library.revision;
    final draft = await showDialog<_MemoryDraft>(
      context: context,
      builder: (_) => _MemoryEditorDialog(entry: entry),
    );
    if (draft == null || !mounted) return;
    if (!_checkRevision(expectedRevision)) return;
    await _saveDraft(draft, entry: entry, expectedRevision: expectedRevision);
  }

  Future<void> _saveDraft(
    _MemoryDraft draft, {
    MemoryEntry? entry,
    required int expectedRevision,
  }) async {
    await _mutate(() async {
      if (!_checkRevision(expectedRevision)) return;
      var choice = await _resolutionFor(
        trigger: draft.trigger,
        newContent: draft.content,
        conflicts: _library.conflicts(draft.trigger, excludeId: entry?.id),
      );
      if (choice.canceled) return;
      if (!_checkRevision(expectedRevision)) return;

      try {
        await _controller.saveMemory(
          id: entry?.id,
          trigger: draft.trigger,
          content: draft.content,
          kind: draft.kind,
          // The source comes from the existing entry. The editor never offers
          // a source selector, so a user cannot manufacture an LLM candidate.
          source: entry?.source ?? MemorySource.manual,
          resolution: choice.resolution,
          expectedRevision: expectedRevision,
        );
        _setNotice(entry == null ? '已保存记忆。' : '已更新记忆。');
      } on MemoryConflictException catch (error) {
        if (!_checkRevision(expectedRevision)) return;
        choice = await _resolutionFor(
          trigger: draft.trigger,
          newContent: draft.content,
          conflicts: error.entries,
        );
        if (choice.canceled || !_checkRevision(expectedRevision)) return;
        await _controller.saveMemory(
          id: entry?.id,
          trigger: draft.trigger,
          content: draft.content,
          kind: draft.kind,
          source: entry?.source ?? MemorySource.manual,
          resolution: choice.resolution,
          expectedRevision: expectedRevision,
        );
        _setNotice(entry == null ? '已保存记忆。' : '已更新记忆。');
      }
    });
  }

  Future<_ResolutionChoice> _resolutionFor({
    required String trigger,
    required String newContent,
    required List<MemoryEntry> conflicts,
  }) async {
    if (conflicts.isEmpty) return const _ResolutionChoice.none();
    final choice = await showDialog<MemoryResolution>(
      context: context,
      builder: (_) => _MemoryConflictDialog(
        trigger: trigger,
        newContent: newContent,
        entries: conflicts,
      ),
    );
    return choice == null
        ? const _ResolutionChoice.canceled()
        : _ResolutionChoice.selected(choice);
  }

  Future<void> _reviewPending(
    MemoryEntry entry, {
    bool editFirst = false,
  }) async {
    if (!_mutationEnabled) {
      _setNotice(_controller.busy ? '小助手正在运行，当前不能修改记忆。' : '请等待当前操作完成。');
      return;
    }
    if (entry.source != MemorySource.pendingLlmCandidate) return;
    final expectedRevision = _library.revision;
    _MemoryDraft? draft;
    if (editFirst) {
      draft = await showDialog<_MemoryDraft>(
        context: context,
        builder: (_) => _MemoryEditorDialog(entry: entry, pending: true),
      );
      if (draft == null || !mounted) return;
    }
    if (!_checkRevision(expectedRevision)) return;
    final trigger = draft?.trigger ?? entry.trigger;
    final content = draft?.content ?? entry.content;
    await _mutate(() async {
      if (!_checkRevision(expectedRevision)) return;
      var choice = await _resolutionFor(
        trigger: trigger,
        newContent: content,
        conflicts: _library.conflicts(trigger, excludeId: entry.id),
      );
      if (choice.canceled) return;
      if (!_checkRevision(expectedRevision)) return;

      try {
        await _controller.approveMemory(
          entry.id,
          trigger: draft?.trigger,
          content: draft?.content,
          kind: draft?.kind,
          resolution: choice.resolution,
          expectedRevision: expectedRevision,
        );
        _setNotice(editFirst ? '修改已保存并采纳。' : '候选已采纳。');
      } on MemoryConflictException catch (error) {
        if (!_checkRevision(expectedRevision)) return;
        choice = await _resolutionFor(
          trigger: trigger,
          newContent: content,
          conflicts: error.entries,
        );
        if (choice.canceled || !_checkRevision(expectedRevision)) return;
        await _controller.approveMemory(
          entry.id,
          trigger: draft?.trigger,
          content: draft?.content,
          kind: draft?.kind,
          resolution: choice.resolution,
          expectedRevision: expectedRevision,
        );
        _setNotice(editFirst ? '修改已保存并采纳。' : '候选已采纳。');
      }
    });
  }

  Future<void> _rejectPending(MemoryEntry entry) async {
    final expectedRevision = _library.revision;
    final affected = _entriesRemovedBy({entry.id});
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('拒绝待审核候选'),
        content: SizedBox(
          width: _dialogWidth(context, 540),
          height: _dialogBodyHeight(
            context,
            math.min(360.0, 100.0 + affected.length * 58.0).toDouble(),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                affected.length > 1
                    ? '拒绝该候选会同时移除关联替代历史，共 ${affected.length} 条。'
                    : '确定拒绝候选“${entry.trigger}”？它不会成为正式记忆。',
              ),
              const SizedBox(height: 8),
              Expanded(child: _deletionPreviewList(affected)),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('取消'),
          ),
          FilledButton.tonal(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('拒绝候选'),
          ),
        ],
      ),
    );
    if (confirmed != true || !_checkRevision(expectedRevision)) return;
    await _mutate(() async {
      await _controller.deleteMemories({
        entry.id,
      }, expectedRevision: expectedRevision);
      _setNotice('已拒绝候选。');
    });
  }

  Future<void> _deleteOne(MemoryEntry entry) async {
    final expectedRevision = _library.revision;
    final isPending = entry.source == MemorySource.pendingLlmCandidate;
    final affected = _entriesRemovedBy({entry.id});
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(isPending ? '拒绝待审核候选' : '删除记忆'),
        content: SizedBox(
          width: _dialogWidth(context, 540),
          height: _dialogBodyHeight(
            context,
            math.min(360.0, 100.0 + affected.length * 58.0).toDouble(),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                affected.length > 1
                    ? '删除该记忆会同时移除指向它的旧归档记录，共 ${affected.length} 条。'
                    : '确认处理以下记录：',
              ),
              const SizedBox(height: 8),
              Expanded(child: _deletionPreviewList(affected)),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('取消'),
          ),
          FilledButton.tonal(
            onPressed: () => Navigator.pop(context, true),
            child: Text(isPending ? '拒绝候选' : '确认删除'),
          ),
        ],
      ),
    );
    if (confirmed != true || !_checkRevision(expectedRevision)) return;
    await _mutate(() async {
      await _controller.deleteMemories({
        entry.id,
      }, expectedRevision: expectedRevision);
      _setNotice(isPending ? '已拒绝候选。' : '已删除记忆。');
    });
  }

  Future<void> _previewAndDeleteSelection() async {
    final expectedRevision = _library.revision;
    final requested = _allEntries()
        .where((entry) => _selectedIds.contains(entry.id))
        .toList();
    if (requested.isEmpty) {
      _setNotice('请先选择要处理的记录。');
      return;
    }
    final ids = requested.map((entry) => entry.id).toSet();
    final entries = _entriesRemovedBy(ids);
    final isPending = _tab == _MemoryTab.pending;
    final isStale = _tab == _MemoryTab.stale;
    final action = isPending ? '拒绝选中候选' : '确认删除选中记忆';
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(isStale ? '长期未命中清理预览' : '批量操作预览'),
        content: SizedBox(
          width: _dialogWidth(context, 620),
          height: _dialogBodyHeight(context, 360),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                isStale
                    ? '你选择了 ${requested.length} 条创建超过 90 天、从未命中的有效记忆。下方列出本次实际删除的全部记录。'
                    : '你选择了 ${requested.length} 条记录。下方列出本次实际${isPending ? '拒绝并删除' : '删除'}的全部记录。',
              ),
              if (entries.length > requested.length)
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Text(
                    '删除会连同关联替代历史一起移除，共 ${entries.length} 条。',
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ),
              const SizedBox(height: 12),
              Expanded(child: _deletionPreviewList(entries)),
              if (isStale)
                const Padding(
                  padding: EdgeInsets.only(top: 8),
                  child: Text('未选中的记忆会保留；只有点击确认才会删除。'),
                ),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('返回修改选择'),
          ),
          FilledButton.tonal(
            onPressed: () => Navigator.pop(context, true),
            child: Text(action),
          ),
        ],
      ),
    );
    if (confirmed != true || !_checkRevision(expectedRevision)) return;
    await _mutate(() async {
      await _controller.deleteMemories(ids, expectedRevision: expectedRevision);
      if (!mounted) return;
      setState(() {
        _selectedIds.clear();
        _selecting = false;
        _notice = isPending ? '已拒绝选中候选。' : '已删除选中记忆。';
      });
    });
  }

  List<MemoryEntry> _entriesRemovedBy(Set<String> ids) {
    final removed = _library.deletionClosure(ids);
    return _library.entries
        .where((entry) => removed.contains(entry.id))
        .toList();
  }

  Widget _deletionPreviewList(List<MemoryEntry> entries) => ListView.separated(
    itemCount: entries.length,
    separatorBuilder: (_, _) => const Divider(height: 1),
    itemBuilder: (context, index) {
      final entry = entries[index];
      return ListTile(
        dense: true,
        title: Text(entry.trigger),
        subtitle: Text(
          '${entry.kind.label} · ${entry.source.label}\n${entry.content}',
          maxLines: 3,
          overflow: TextOverflow.ellipsis,
        ),
      );
    },
  );

  void _toggleSelected(MemoryEntry entry, bool? checked) {
    setState(() {
      if (checked == true) {
        _selectedIds.add(entry.id);
      } else {
        _selectedIds.remove(entry.id);
      }
    });
  }

  String _date(DateTime? value) {
    if (value == null) return '尚未命中';
    final local = value.toLocal();
    String two(int n) => n.toString().padLeft(2, '0');
    return '${local.year}-${two(local.month)}-${two(local.day)} '
        '${two(local.hour)}:${two(local.minute)}';
  }

  Widget _tabButton(String label, _MemoryTab tab, {String? badge}) =>
      ChoiceChip(
        key: ValueKey('assistant-memory-tab-${tab.name}'),
        label: Text(badge == null ? label : '$label · $badge'),
        selected: _tab == tab,
        onSelected: _mutating ? null : (_) => _switchTab(tab),
      );

  Widget _toolbar(BuildContext context) {
    final isStale = _tab == _MemoryTab.stale;
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 8, 20, 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Wrap(
            spacing: 8,
            runSpacing: 6,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              _tabButton('待审核', _MemoryTab.pending, badge: '$_pendingCount'),
              _tabButton('全部', _MemoryTab.all),
              _tabButton('长期未命中', _MemoryTab.stale, badge: '90 天'),
              const SizedBox(width: 8),
              if (_selecting) ...[
                TextButton.icon(
                  onPressed: _mutationEnabled
                      ? () => setState(() {
                          _selectedIds.clear();
                          _selecting = false;
                        })
                      : null,
                  icon: const Icon(Icons.close),
                  label: const Text('退出选择'),
                ),
                FilledButton.tonalIcon(
                  onPressed: _mutationEnabled && _selectedIds.isNotEmpty
                      ? _previewAndDeleteSelection
                      : null,
                  icon: Icon(
                    isStale
                        ? Icons.cleaning_services_outlined
                        : Icons.delete_outline,
                  ),
                  label: Text(
                    isStale
                        ? '预览清理 (${_selectedIds.length})'
                        : _tab == _MemoryTab.pending
                        ? '预览拒绝 (${_selectedIds.length})'
                        : '预览删除 (${_selectedIds.length})',
                  ),
                ),
              ] else ...[
                OutlinedButton.icon(
                  onPressed: _mutationEnabled
                      ? () => setState(() => _selecting = true)
                      : null,
                  icon: const Icon(Icons.checklist),
                  label: Text(isStale ? '选择清理项' : '批量选择'),
                ),
                FilledButton.icon(
                  key: const ValueKey('assistant-memory-add'),
                  onPressed: _mutationEnabled ? () => _openEditor() : null,
                  icon: const Icon(Icons.add),
                  label: const Text('新增记忆'),
                ),
              ],
            ],
          ),
          const SizedBox(height: 10),
          TextField(
            key: const ValueKey('assistant-memory-search'),
            controller: _search,
            decoration: InputDecoration(
              prefixIcon: const Icon(Icons.search),
              hintText: '搜索触发词或记忆内容',
              suffixIcon: _query.isEmpty
                  ? null
                  : IconButton(
                      tooltip: '清除搜索',
                      onPressed: () {
                        _search.clear();
                        setState(() {
                          _query = '';
                          _selectedIds.clear();
                        });
                      },
                      icon: const Icon(Icons.close),
                    ),
            ),
            onChanged: (value) => setState(() {
              _query = value;
              _selectedIds.clear();
            }),
          ),
          const SizedBox(height: 8),
          Wrap(
            spacing: 10,
            runSpacing: 8,
            children: [_kindFilter(context), _sourceFilter(context)],
          ),
        ],
      ),
    );
  }

  Widget _entryCard(MemoryEntry entry) {
    final theme = Theme.of(context);
    final pending = entry.source == MemorySource.pendingLlmCandidate;
    final stale = _tab == _MemoryTab.stale;
    final selected = _selectedIds.contains(entry.id);
    final archived = entry.supersededBy != null;
    final hitLabel = entry.hitCount == 0 ? '未命中' : '命中 ${entry.hitCount} 次';
    final subtitle = <String>[
      entry.kind.label,
      entry.source.label,
      hitLabel,
      entry.lastHitAt == null
          ? '最近命中尚未发生 · 创建于 ${_date(entry.createdAt)}'
          : '最近命中 ${_date(entry.lastHitAt)}',
      if (archived) '已归档',
    ].join(' · ');

    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 8, 8, 8),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (_selecting)
              Checkbox(
                value: selected,
                onChanged: _mutating
                    ? null
                    : (checked) => _toggleSelected(entry, checked),
              ),
            Expanded(
              child: InkWell(
                onTap: _selecting
                    ? () => _toggleSelected(entry, !selected)
                    : pending || archived || _mutating
                    ? null
                    : () => _openEditor(entry: entry),
                borderRadius: BorderRadius.circular(8),
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 4),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Expanded(
                            child: Text(
                              entry.trigger,
                              style: theme.textTheme.titleSmall?.copyWith(
                                decoration: archived
                                    ? TextDecoration.lineThrough
                                    : null,
                                color: archived
                                    ? theme.colorScheme.onSurfaceVariant
                                    : null,
                              ),
                            ),
                          ),
                          if (pending)
                            _Tag(
                              label: '待审核',
                              color: theme.colorScheme.primary,
                            ),
                          if (archived) const _Tag(label: '已归档'),
                        ],
                      ),
                      const SizedBox(height: 3),
                      Text(
                        subtitle,
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: theme.colorScheme.onSurfaceVariant,
                        ),
                      ),
                      const SizedBox(height: 5),
                      Text(
                        entry.content,
                        maxLines: 3,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.bodyMedium,
                      ),
                    ],
                  ),
                ),
              ),
            ),
            if (!_selecting) ...[
              const SizedBox(width: 4),
              if (pending) ...[
                IconButton(
                  key: ValueKey('assistant-memory-approve-${entry.id}'),
                  tooltip: '采纳候选',
                  onPressed: _mutationEnabled
                      ? () => _reviewPending(entry)
                      : null,
                  icon: const Icon(Icons.check_circle_outline),
                ),
                IconButton(
                  key: ValueKey('assistant-memory-edit-approve-${entry.id}'),
                  tooltip: '编辑并采纳',
                  onPressed: _mutationEnabled
                      ? () => _reviewPending(entry, editFirst: true)
                      : null,
                  icon: const Icon(Icons.edit_outlined),
                ),
                IconButton(
                  key: ValueKey('assistant-memory-reject-${entry.id}'),
                  tooltip: '拒绝候选',
                  onPressed: _mutationEnabled
                      ? () => _rejectPending(entry)
                      : null,
                  icon: const Icon(Icons.block_outlined),
                ),
              ] else ...[
                if (!stale && !archived)
                  IconButton(
                    key: ValueKey('assistant-memory-edit-${entry.id}'),
                    tooltip: '编辑',
                    onPressed: _mutationEnabled
                        ? () => _openEditor(entry: entry)
                        : null,
                    icon: const Icon(Icons.edit_outlined),
                  ),
                IconButton(
                  key: ValueKey('assistant-memory-delete-${entry.id}'),
                  tooltip: '删除',
                  onPressed: _mutationEnabled ? () => _deleteOne(entry) : null,
                  icon: const Icon(Icons.delete_outline),
                ),
              ],
            ],
          ],
        ),
      ),
    );
  }

  Widget _entryList(List<MemoryEntry> entries) {
    if (entries.isEmpty) {
      final message = switch (_tab) {
        _MemoryTab.pending => '没有待审核候选。',
        _MemoryTab.all => '没有符合条件的记忆。',
        _MemoryTab.stale => '没有创建超过 90 天、从未命中的有效记忆。',
      };
      return Center(
        child: Text(
          message,
          style: TextStyle(
            color: Theme.of(context).colorScheme.onSurfaceVariant,
          ),
        ),
      );
    }
    return ListView.builder(
      key: PageStorageKey<_MemoryTab>(_tab),
      padding: const EdgeInsets.fromLTRB(20, 8, 20, 20),
      itemCount: entries.length,
      itemBuilder: (context, index) => _entryCard(entries[index]),
    );
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: _controller,
    builder: (context, _) {
      final entries = _visibleEntries();
      final screen = MediaQuery.sizeOf(context);
      final width = math
          .min(
            math.min(900.0, math.max(640.0, screen.width * .86)),
            screen.width - 40,
          )
          .toDouble();
      final height = math
          .min(
            math.min(780.0, math.max(480.0, screen.height * .82)),
            screen.height - 40,
          )
          .toDouble();
      return Dialog(
        insetPadding: const EdgeInsets.all(20),
        child: SizedBox(
          width: width,
          height: height,
          child: Column(
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 14, 12, 2),
                child: Row(
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            '小助手记忆',
                            style: Theme.of(context).textTheme.titleLarge,
                          ),
                          Text(
                            '管理已保存的记忆与待审核候选',
                            style: Theme.of(context).textTheme.bodySmall
                                ?.copyWith(
                                  color: Theme.of(context)
                                      .colorScheme
                                      .onSurfaceVariant,
                                ),
                          ),
                        ],
                      ),
                    ),
                    IconButton(
                      tooltip: '关闭',
                      onPressed: () => Navigator.of(context).pop(),
                      icon: const Icon(Icons.close),
                    ),
                  ],
                ),
              ),
              if (_controller.busy || _mutating)
                LinearProgressIndicator(
                  minHeight: 2,
                  color: Theme.of(context).colorScheme.primary,
                  backgroundColor: Theme.of(context).colorScheme.surface,
                )
              else
                const SizedBox(height: 2),
              Expanded(
                child: Column(
                  children: [
                    SingleChildScrollView(child: _toolbar(context)),
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 20),
                      child: Row(
                        children: [
                          Expanded(
                            child: Text(
                              '${entries.length} 条记录',
                              style: Theme.of(context).textTheme.bodySmall,
                            ),
                          ),
                          if (_notice != null)
                            Flexible(
                              child: Text(
                                _notice!,
                                textAlign: TextAlign.end,
                                style: Theme.of(context).textTheme.bodySmall
                                    ?.copyWith(
                                      color: Theme.of(context)
                                          .colorScheme
                                          .primary,
                                    ),
                              ),
                            ),
                        ],
                      ),
                    ),
                    const Divider(height: 14),
                    Expanded(child: _entryList(entries)),
                  ],
                ),
              ),
            ],
          ),
        ),
      );
    },
  );
}

class _ResolutionChoice {
  const _ResolutionChoice.none() : resolution = null, canceled = false;
  const _ResolutionChoice.canceled() : resolution = null, canceled = true;
  const _ResolutionChoice.selected(this.resolution) : canceled = false;

  final MemoryResolution? resolution;
  final bool canceled;
}

class _Tag extends StatelessWidget {
  const _Tag({required this.label, this.color});

  final String label;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final foreground = color ?? theme.colorScheme.onSurfaceVariant;
    return Container(
      margin: const EdgeInsets.only(left: 6),
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
      decoration: BoxDecoration(
        color: foreground.withValues(alpha: .10),
        borderRadius: BorderRadius.circular(20),
      ),
      child: Text(
        label,
        style: theme.textTheme.labelSmall?.copyWith(color: foreground),
      ),
    );
  }
}

class _MemoryEditorDialog extends StatefulWidget {
  const _MemoryEditorDialog({this.entry, this.pending = false});

  final MemoryEntry? entry;
  final bool pending;

  @override
  State<_MemoryEditorDialog> createState() => _MemoryEditorDialogState();
}

class _MemoryEditorDialogState extends State<_MemoryEditorDialog> {
  late final TextEditingController _trigger;
  late final TextEditingController _content;
  late MemoryKind _kind;

  @override
  void initState() {
    super.initState();
    _trigger = TextEditingController(text: widget.entry?.trigger ?? '');
    _content = TextEditingController(text: widget.entry?.content ?? '');
    _kind = widget.entry?.kind ?? MemoryKind.other;
  }

  @override
  void dispose() {
    _trigger.dispose();
    _content.dispose();
    super.dispose();
  }

  void _save() {
    final trigger = _trigger.text.trim();
    final content = _content.text.trim();
    if (trigger.isEmpty || content.isEmpty) return;
    Navigator.of(context)
        .pop(_MemoryDraft(trigger: trigger, content: content, kind: _kind));
  }

  @override
  Widget build(BuildContext context) {
    final pending = widget.pending;
    final edit = widget.entry != null;
    return AlertDialog(
      title: Text(
        pending
            ? '编辑候选并采纳'
            : edit
            ? '编辑记忆'
            : '新增记忆',
      ),
      content: SizedBox(
        width: _dialogWidth(context, 560),
        height: _dialogBodyHeight(context, 520),
        child: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (pending)
                Padding(
                  padding: const EdgeInsets.only(bottom: 12),
                  child: Text(
                    '候选内容不会在编辑时自动变为正式记忆。点击“保存修改并采纳”才会提交审核决定。',
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: Theme.of(context).colorScheme.onSurfaceVariant,
                    ),
                  ),
                ),
              TextField(
                key: const ValueKey('assistant-memory-trigger'),
                controller: _trigger,
                autofocus: true,
                maxLength: 200,
                decoration: const InputDecoration(labelText: '触发词'),
                onChanged: (_) => setState(() {}),
              ),
              const SizedBox(height: 10),
              TextField(
                key: const ValueKey('assistant-memory-content'),
                controller: _content,
                minLines: 3,
                maxLines: 8,
                maxLength: 8000,
                decoration: const InputDecoration(labelText: '记忆内容'),
                onChanged: (_) => setState(() {}),
              ),
              const SizedBox(height: 10),
              DropdownButtonFormField<MemoryKind>(
                key: const ValueKey('assistant-memory-kind'),
                initialValue: _kind,
                isExpanded: true,
                decoration: const InputDecoration(labelText: '类别'),
                items: [
                  for (final kind in MemoryKind.values)
                    DropdownMenuItem(value: kind, child: Text(kind.label)),
                ],
                onChanged: (value) {
                  if (value != null) setState(() => _kind = value);
                },
              ),
              if (widget.entry != null) ...[
                const SizedBox(height: 10),
                Align(
                  alignment: Alignment.centerLeft,
                  child: Text(
                    '来源：${widget.entry!.source.label}（此处保留原来源）',
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: Theme.of(context).colorScheme.onSurfaceVariant,
                    ),
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('取消'),
        ),
        FilledButton(
          key: ValueKey(
            pending ? 'assistant-memory-save-pending' : 'assistant-memory-save',
          ),
          onPressed:
              _trigger.text.trim().isNotEmpty && _content.text.trim().isNotEmpty
              ? _save
              : null,
          child: Text(pending ? '保存修改并采纳' : '保存'),
        ),
      ],
    );
  }
}

class _MemoryConflictDialog extends StatelessWidget {
  const _MemoryConflictDialog({
    required this.trigger,
    required this.newContent,
    required this.entries,
  });

  final String trigger;
  final String newContent;
  final List<MemoryEntry> entries;

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: const Text('发现相同触发词'),
    content: SizedBox(
      width: _dialogWidth(context, 640),
      height: _dialogBodyHeight(context, 440),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('“$trigger”已有以下记忆。请查看内容后选择处理方式。'),
          const SizedBox(height: 12),
          Expanded(
            child: ListView(
              children: [
                for (final entry in entries) ...[
                  _ConflictContent(
                    title: '现有内容 · ${entry.kind.label} · ${entry.source.label}',
                    content: entry.content,
                  ),
                  const SizedBox(height: 10),
                ],
                _ConflictContent(title: '本次内容', content: newContent),
              ],
            ),
          ),
          const SizedBox(height: 8),
          Text(
            '替换会归档旧记忆；合并会保留并组合内容；并存会分别保存。',
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
              color: Theme.of(context).colorScheme.onSurfaceVariant,
            ),
          ),
        ],
      ),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('取消'),
      ),
      OutlinedButton(
        key: const ValueKey('assistant-memory-conflict-coexist'),
        onPressed: () => Navigator.pop(context, MemoryResolution.coexist),
        child: const Text('并存'),
      ),
      OutlinedButton(
        key: const ValueKey('assistant-memory-conflict-merge'),
        onPressed: () => Navigator.pop(context, MemoryResolution.merge),
        child: const Text('合并'),
      ),
      FilledButton(
        key: const ValueKey('assistant-memory-conflict-replace'),
        onPressed: () => Navigator.pop(context, MemoryResolution.replace),
        child: const Text('替换并归档旧记忆'),
      ),
    ],
  );
}

class _ConflictContent extends StatelessWidget {
  const _ConflictContent({required this.title, required this.content});

  final String title;
  final String content;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: theme.colorScheme.onSurface.withValues(alpha: .045),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: theme.colorScheme.outlineVariant),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: theme.textTheme.titleSmall),
          const SizedBox(height: 5),
          SelectableText(content),
        ],
      ),
    );
  }
}

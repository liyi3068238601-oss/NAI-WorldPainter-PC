import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../assistant/agent_contract.dart';
import '../tags/danbooru_client.dart';
import 'workbench_controller.dart';

const _modelScopeDanbooruBaseUrl =
    'https://sakizuki-danboorusearchonline.ms.show';

/// Desktop lookup for the third-party Danbooru tag index.
///
/// Search is explicit: changing the query or endpoint never sends a request.
/// Results are kept separate from the prompt draft so browsing tags cannot
/// modify an in-progress creation.
final class TagSearchPanel extends StatefulWidget {
  const TagSearchPanel({super.key, required this.controller});

  final WorkbenchController controller;

  @override
  State<TagSearchPanel> createState() => _TagSearchPanelState();
}

enum _SearchPhase { initial, loading, results, empty, error, cancelled }

class _TagSearchPanelState extends State<TagSearchPanel> {
  late final TextEditingController _queryController;
  late final TextEditingController _baseUrlController;
  AgentCancellation? _cancellation;
  var _requestVersion = 0;
  var _phase = _SearchPhase.initial;
  var _settingsExpanded = false;
  var _savingSettings = false;
  var _showNsfw = true;
  List<DanbooruTag> _results = const [];
  String _requestedQuery = '';
  String _returnedQuery = '';
  String _requestedEndpoint = defaultDanbooruBaseUrl;
  var _requestedShowNsfw = true;
  String _resultSource = '';
  String? _error;
  String? _settingsError;
  String? _notice;

  WorkbenchController get _controller => widget.controller;

  bool get _settingsDirty =>
      _baseUrlController.text.trim() != _controller.tagSearchBaseUrl ||
      _showNsfw != _controller.tagSearchShowNsfw;

  @override
  void initState() {
    super.initState();
    _queryController = TextEditingController();
    _baseUrlController = TextEditingController(
      text: _controller.tagSearchBaseUrl.isEmpty
          ? defaultDanbooruBaseUrl
          : _controller.tagSearchBaseUrl,
    );
    _showNsfw = _controller.tagSearchShowNsfw;
  }

  @override
  void dispose() {
    _invalidateSearch();
    _queryController.dispose();
    _baseUrlController.dispose();
    super.dispose();
  }

  void _invalidateSearch() {
    _requestVersion++;
    _cancellation?.cancel();
    _cancellation = null;
  }

  void _onQueryChanged(String _) {
    setState(() {
      _invalidateSearch();
      _phase = _SearchPhase.initial;
      _results = const [];
      _error = null;
      _notice = null;
    });
  }

  void _onSettingsChanged() {
    setState(() {
      _invalidateSearch();
      _phase = _SearchPhase.initial;
      _results = const [];
      _error = null;
      _settingsError = null;
      _notice = _settingsDirty ? '设置已更改；保存后才能开始新查询。' : null;
    });
  }

  Future<void> _search() async {
    final query = _queryController.text.trim();
    if (query.isEmpty || _phase == _SearchPhase.loading || _savingSettings) {
      return;
    }
    if (_settingsDirty) {
      setState(() {
        _notice = '请先保存搜索设置。';
        _phase = _SearchPhase.initial;
      });
      return;
    }

    FocusManager.instance.primaryFocus?.unfocus();
    final cancellation = AgentCancellation();
    final endpoint = _controller.tagSearchBaseUrl;
    final showNsfw = _controller.tagSearchShowNsfw;
    final requestVersion = ++_requestVersion;
    _cancellation?.cancel();
    _cancellation = cancellation;
    setState(() {
      _phase = _SearchPhase.loading;
      _results = const [];
      _requestedQuery = query;
      _requestedEndpoint = endpoint;
      _requestedShowNsfw = showNsfw;
      _returnedQuery = '';
      _resultSource = '';
      _error = null;
      _notice = null;
    });

    try {
      final response = await _controller.tagSearchClient.search(
        query: query,
        cancellation: cancellation,
        baseUrl: endpoint,
        limit: 30,
        showNsfw: showNsfw,
      );
      if (!_isCurrent(requestVersion, cancellation)) return;
      final tags = response.tags.take(30).toList(growable: false);
      setState(() {
        _results = tags;
        _requestedQuery = query;
        _returnedQuery = response.query;
        _resultSource = response.source;
        _phase = tags.isEmpty ? _SearchPhase.empty : _SearchPhase.results;
        _cancellation = null;
      });
    } catch (error) {
      if (!_isCurrent(requestVersion, cancellation)) return;
      setState(() {
        _results = const [];
        _error = error is AgentException
            ? error.message
            : '查询标签失败，请检查地址、网络或服务状态后重试。';
        _phase = _SearchPhase.error;
        _cancellation = null;
      });
    }
  }

  bool _isCurrent(int requestVersion, AgentCancellation cancellation) =>
      mounted &&
      requestVersion == _requestVersion &&
      identical(_cancellation, cancellation) &&
      !cancellation.isCancelled;

  void _cancelSearch() {
    if (_phase != _SearchPhase.loading) return;
    setState(() {
      _invalidateSearch();
      _phase = _SearchPhase.cancelled;
      _results = const [];
      _error = null;
      _notice = '本次查询已取消。';
    });
  }

  Future<void> _saveSettings() async {
    if (_savingSettings) return;
    final shouldConfigure = _settingsDirty;
    final shouldRetryPersistence = !shouldConfigure && _settingsError != null;
    setState(() {
      _savingSettings = true;
      _settingsError = null;
      _notice = null;
    });
    try {
      if (shouldConfigure) {
        _controller.configureTagSearch(
          baseUrl: _baseUrlController.text,
          showNsfw: _showNsfw,
        );
      }
      await _controller.flush(retry: shouldRetryPersistence);
      if (!mounted) return;
      setState(() {
        _baseUrlController.text = _controller.tagSearchBaseUrl;
        _showNsfw = _controller.tagSearchShowNsfw;
        _savingSettings = false;
        _settingsError = null;
        _notice = _controller.hasStore ? '搜索设置已保存到本机工作区。' : '搜索设置已保存在本次会话。';
      });
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _savingSettings = false;
        _settingsError = error is AgentException
            ? error.message
            : '保存搜索设置失败，请检查工作区存储后重试。';
      });
    }
  }

  String _toPromptTag(String tag) => tag.replaceAll('_', ' ').trim();

  Future<void> _copyTag(DanbooruTag tag) async {
    try {
      await Clipboard.setData(ClipboardData(text: _toPromptTag(tag.tag)));
      if (!mounted) return;
      setState(() => _notice = '已复制：${_toPromptTag(tag.tag)}');
    } catch (_) {
      if (!mounted) return;
      setState(() => _notice = '复制失败，请重试。');
    }
  }

  Future<void> _showDetails(DanbooruTag tag) async {
    await showDialog<void>(
      context: context,
      builder: (dialogContext) {
        final size = MediaQuery.sizeOf(dialogContext);
        final scheme = Theme.of(dialogContext).colorScheme;
        final width = size.width < 652 ? size.width - 32 : 620.0;
        final height = size.height < 680 ? size.height - 32 : 648.0;
        return Dialog(
          key: const ValueKey('tag-search-details'),
          insetPadding: const EdgeInsets.all(16),
          clipBehavior: Clip.antiAlias,
          child: SizedBox(
            width: width,
            height: height,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(20, 16, 20, 14),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          _toPromptTag(tag.tag),
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: Theme.of(dialogContext).textTheme.titleLarge
                              ?.copyWith(fontWeight: FontWeight.w700),
                        ),
                      ),
                      IconButton(
                        key: const ValueKey('tag-search-details-close'),
                        tooltip: '关闭详情',
                        onPressed: () => Navigator.pop(dialogContext),
                        icon: const Icon(Icons.close),
                      ),
                    ],
                  ),
                  const Divider(height: 16),
                  Expanded(
                    child: SingleChildScrollView(
                      key: const ValueKey('tag-search-wiki-scroll'),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          SelectableText(
                            tag.tag,
                            style: TextStyle(color: scheme.onSurfaceVariant),
                          ),
                          if (tag.cnName.trim().isNotEmpty) ...[
                            const SizedBox(height: 10),
                            Text(
                              '中文名',
                              style: Theme.of(dialogContext)
                                  .textTheme
                                  .titleSmall,
                            ),
                            const SizedBox(height: 3),
                            SelectableText(
                              tag.cnName,
                              key: const ValueKey('tag-search-detail-cn-name'),
                            ),
                          ],
                          const SizedBox(height: 12),
                          Wrap(
                            spacing: 8,
                            runSpacing: 8,
                            children: [
                              _metadataChip(
                                dialogContext,
                                tag.category.trim().isEmpty
                                    ? '分类未知'
                                    : tag.category,
                              ),
                              _metadataChip(
                                dialogContext,
                                tag.nsfw.trim().isEmpty
                                    ? 'NSFW 状态未知'
                                    : tag.nsfw,
                              ),
                              _metadataChip(
                                dialogContext,
                                tag.count == null ? '热度未知' : '热度 ${tag.count}',
                              ),
                              if (tag.score != null)
                                _metadataChip(
                                  dialogContext,
                                  '得分 ${tag.score!.toStringAsFixed(3)}',
                                ),
                            ],
                          ),
                          const SizedBox(height: 14),
                          Text(
                            'Wiki',
                            style: Theme.of(dialogContext).textTheme.titleSmall,
                          ),
                          const SizedBox(height: 6),
                          SelectableText(
                            tag.wiki.trim().isEmpty ? '暂无 Wiki 释义。' : tag.wiki,
                            key: const ValueKey('tag-search-wiki'),
                            style: const TextStyle(height: 1.55),
                          ),
                        ],
                      ),
                    ),
                  ),
                  const SizedBox(height: 12),
                  Align(
                    alignment: Alignment.centerRight,
                    child: FilledButton.tonalIcon(
                      key: const ValueKey('tag-search-details-copy'),
                      onPressed: () => _copyTag(tag),
                      icon: const Icon(Icons.copy_outlined),
                      label: const Text('复制提示词标签'),
                    ),
                  ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }

  Widget _metadataChip(BuildContext context, String text) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
    decoration: BoxDecoration(
      color: Theme.of(context).colorScheme.primary.withValues(alpha: .11),
      borderRadius: BorderRadius.circular(999),
    ),
    child: ConstrainedBox(
      constraints: BoxConstraints(
        maxWidth: MediaQuery.sizeOf(context).width - 80,
      ),
      child: Text(
        text,
        maxLines: 2,
        overflow: TextOverflow.ellipsis,
        style: const TextStyle(fontSize: 11),
      ),
    ),
  );

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.all(16),
    child: CustomScrollView(
      key: const ValueKey('tag-search-scroll-view'),
      slivers: [
        SliverToBoxAdapter(child: _buildHeader(context)),
        SliverToBoxAdapter(child: const SizedBox(height: 14)),
        SliverToBoxAdapter(child: _buildSearchControls(context)),
        SliverToBoxAdapter(child: const SizedBox(height: 10)),
        SliverToBoxAdapter(child: _buildSettings(context)),
        if (_settingsError != null)
          SliverToBoxAdapter(
            child: _buildFeedback(context, _settingsError!, true),
          ),
        if (_notice != null)
          SliverToBoxAdapter(child: _buildFeedback(context, _notice!, false)),
        SliverToBoxAdapter(child: _buildDisclosure(context)),
        ..._buildStatusSlivers(context),
      ],
    ),
  );

  Widget _buildHeader(BuildContext context) => Row(
    children: [
      Container(
        width: 38,
        height: 38,
        decoration: BoxDecoration(
          color: Theme.of(context).colorScheme.primary.withValues(alpha: .12),
          borderRadius: BorderRadius.circular(11),
        ),
        child: Icon(
          Icons.label_outline_rounded,
          color: Theme.of(context).colorScheme.primary,
        ),
      ),
      const SizedBox(width: 11),
      Expanded(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Danbooru 标签搜索',
              style: Theme.of(context).textTheme.titleLarge
                  ?.copyWith(fontWeight: FontWeight.w700, letterSpacing: .2),
            ),
            const SizedBox(height: 2),
            Text(
              '查找中英文标签与释义；结果不会自动写入创作草稿。',
              style: TextStyle(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
                fontSize: 11,
              ),
            ),
          ],
        ),
      ),
    ],
  );

  Widget _buildSearchControls(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      TextField(
        key: const ValueKey('tag-search-input'),
        controller: _queryController,
        enabled: !_savingSettings,
        textInputAction: TextInputAction.search,
        onChanged: _onQueryChanged,
        onSubmitted: (_) => _search(),
        decoration: const InputDecoration(
          labelText: '搜索标签',
          hintText: '输入中文或英文关键词',
          prefixIcon: Icon(Icons.search_rounded),
        ),
      ),
      const SizedBox(height: 9),
      Wrap(
        spacing: 8,
        runSpacing: 8,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          FilledButton.icon(
            key: const ValueKey('tag-search-submit'),
            onPressed:
                _phase == _SearchPhase.loading ||
                    _savingSettings ||
                    _settingsDirty ||
                    _queryController.text.trim().isEmpty
                ? null
                : _search,
            icon: _phase == _SearchPhase.loading
                ? const SizedBox(
                    width: 15,
                    height: 15,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.search_rounded),
            label: Text(_phase == _SearchPhase.loading ? '正在搜索' : '搜索'),
          ),
          if (_phase == _SearchPhase.loading)
            OutlinedButton.icon(
              key: const ValueKey('tag-search-cancel'),
              onPressed: _cancelSearch,
              icon: const Icon(Icons.stop_circle_outlined),
              label: const Text('取消查询'),
            ),
          Text(
            '最多返回 30 条',
            style: TextStyle(
              color: Theme.of(context).colorScheme.onSurfaceVariant,
              fontSize: 11,
            ),
          ),
        ],
      ),
    ],
  );

  Widget _buildSettings(BuildContext context) => Card(
    margin: EdgeInsets.zero,
    clipBehavior: Clip.antiAlias,
    child: ExpansionTile(
      key: const ValueKey('tag-search-settings'),
      initiallyExpanded: _settingsExpanded,
      onExpansionChanged: (value) => setState(() => _settingsExpanded = value),
      leading: const Icon(Icons.tune_rounded),
      title: const Text('搜索设置'),
      subtitle: Text(
        _settingsDirty ? '有未保存的更改' : '查询地址：${_controller.tagSearchBaseUrl}',
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant),
      ),
      childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 14),
      children: [
        Align(
          alignment: Alignment.centerLeft,
          child: Wrap(
            spacing: 8,
            children: [
              OutlinedButton.icon(
                key: const ValueKey('tag-search-preset-hf'),
                onPressed: _savingSettings
                    ? null
                    : () {
                        _baseUrlController.text = defaultDanbooruBaseUrl;
                        _onSettingsChanged();
                      },
                icon: const Icon(Icons.cloud_outlined),
                label: const Text('HF 预设'),
              ),
              OutlinedButton.icon(
                key: const ValueKey('tag-search-preset-modelscope'),
                onPressed: _savingSettings
                    ? null
                    : () {
                        _baseUrlController.text = _modelScopeDanbooruBaseUrl;
                        _onSettingsChanged();
                      },
                icon: const Icon(Icons.cloud_outlined),
                label: const Text('ModelScope 预设'),
              ),
            ],
          ),
        ),
        const SizedBox(height: 8),
        TextField(
          key: const ValueKey('tag-search-base-url'),
          controller: _baseUrlController,
          enabled: !_savingSettings,
          keyboardType: TextInputType.url,
          textInputAction: TextInputAction.done,
          onChanged: (_) => _onSettingsChanged(),
          decoration: const InputDecoration(
            labelText: 'API 根地址',
            hintText: defaultDanbooruBaseUrl,
            prefixIcon: Icon(Icons.link_rounded),
          ),
        ),
        const SizedBox(height: 8),
        SwitchListTile.adaptive(
          key: const ValueKey('tag-search-show-nsfw'),
          contentPadding: EdgeInsets.zero,
          value: _showNsfw,
          onChanged: _savingSettings
              ? null
              : (value) {
                  _showNsfw = value;
                  _onSettingsChanged();
                },
          title: const Text('包含 NSFW 标签'),
          subtitle: const Text('默认开启，与手机端搜索设置一致。'),
        ),
        Align(
          alignment: Alignment.centerRight,
          child: FilledButton.tonalIcon(
            key: const ValueKey('tag-search-save-settings'),
            onPressed:
                _savingSettings || (!_settingsDirty && _settingsError == null)
                ? null
                : _saveSettings,
            icon: _savingSettings
                ? const SizedBox(
                    width: 15,
                    height: 15,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.save_outlined),
            label: Text(
              _savingSettings
                  ? '正在保存'
                  : !_settingsDirty && _settingsError != null
                  ? '重试保存'
                  : '保存设置',
            ),
          ),
        ),
      ],
    ),
  );

  Widget _buildDisclosure(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(2, 9, 2, 4),
    child: Text(
      '搜索会将关键词发送到上方指定的地址。结果来自第三方标签索引，仅作提示参考，不代表 Danbooru 官方实时认证；此页不请求图片，也不会自动修改提示词。',
      style: TextStyle(
        color: Theme.of(context).colorScheme.onSurfaceVariant,
        fontSize: 10,
        height: 1.45,
      ),
    ),
  );

  Widget _buildFeedback(BuildContext context, String text, bool isError) =>
      Padding(
        padding: const EdgeInsets.only(top: 8),
        child: Semantics(
          liveRegion: true,
          child: Text(
            text,
            key: ValueKey(
              isError ? 'tag-search-settings-error' : 'tag-search-notice',
            ),
            style: TextStyle(
              color: isError
                  ? Theme.of(context).colorScheme.error
                  : Theme.of(context).colorScheme.primary,
              fontSize: 11,
            ),
          ),
        ),
      );

  List<Widget> _buildStatusSlivers(BuildContext context) {
    switch (_phase) {
      case _SearchPhase.initial:
        return [
          SliverToBoxAdapter(
            child: _statusMessage(
              context,
              key: 'tag-search-initial',
              icon: Icons.manage_search_rounded,
              title: '输入关键词后手动搜索',
              detail: '支持中文与英文。修改关键词不会自动发送请求。',
            ),
          ),
        ];
      case _SearchPhase.loading:
        return [
          SliverToBoxAdapter(
            child: _statusMessage(
              context,
              key: 'tag-search-loading',
              icon: Icons.cloud_sync_outlined,
              title: '正在查询标签索引…',
              detail: '查询：$_requestedQuery',
              loading: true,
            ),
          ),
        ];
      case _SearchPhase.empty:
        return [
          SliverToBoxAdapter(child: _resultContext(context)),
          SliverToBoxAdapter(
            child: _statusMessage(
              context,
              key: 'tag-search-empty',
              icon: Icons.search_off_rounded,
              title: '没有找到相关标签',
              detail: '可以换一种中文或英文关键词再试。',
            ),
          ),
        ];
      case _SearchPhase.error:
        return [
          SliverToBoxAdapter(child: _resultContext(context)),
          SliverToBoxAdapter(
            child: _statusMessage(
              context,
              key: 'tag-search-error',
              icon: Icons.cloud_off_outlined,
              title: '查询失败',
              detail: _error ?? '请检查查询地址和网络后重试。',
              error: true,
              action: TextButton.icon(
                key: const ValueKey('tag-search-retry'),
                onPressed: _search,
                icon: const Icon(Icons.refresh_rounded),
                label: const Text('重试'),
              ),
            ),
          ),
        ];
      case _SearchPhase.cancelled:
        return [
          SliverToBoxAdapter(
            child: _statusMessage(
              context,
              key: 'tag-search-cancelled',
              icon: Icons.stop_circle_outlined,
              title: '查询已取消',
              detail: '迟到的响应不会显示为当前查询结果。',
            ),
          ),
        ];
      case _SearchPhase.results:
        return [
          SliverToBoxAdapter(child: _resultContext(context)),
          SliverList.separated(
            itemCount: _results.length,
            separatorBuilder: (_, _) => const SizedBox(height: 8),
            itemBuilder: (context, index) => _resultCard(context, index),
          ),
        ];
    }
  }

  Widget _statusMessage(
    BuildContext context, {
    required String key,
    required IconData icon,
    required String title,
    required String detail,
    bool loading = false,
    bool error = false,
    Widget? action,
  }) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 28, horizontal: 12),
    child: Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 560),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (loading)
              CircularProgressIndicator(key: ValueKey(key), strokeWidth: 2)
            else
              Icon(
                icon,
                key: ValueKey(key),
                size: 28,
                color: error
                    ? Theme.of(context).colorScheme.error
                    : Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            const SizedBox(height: 10),
            Text(title, textAlign: TextAlign.center),
            const SizedBox(height: 3),
            Text(
              detail,
              textAlign: TextAlign.center,
              style: TextStyle(
                color: error
                    ? Theme.of(context).colorScheme.error
                    : Theme.of(context).colorScheme.onSurfaceVariant,
                fontSize: 11,
              ),
            ),
            if (action != null) ...[const SizedBox(height: 8), action],
          ],
        ),
      ),
    ),
  );

  Widget _resultContext(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(2, 12, 2, 6),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          '本次查询：$_requestedQuery',
          key: const ValueKey('tag-search-result-query'),
          style: Theme.of(context).textTheme.titleSmall,
        ),
        if (_returnedQuery.isNotEmpty && _returnedQuery != _requestedQuery)
          Text(
            '服务返回的查询：$_returnedQuery',
            style: TextStyle(
              color: Theme.of(context).colorScheme.onSurfaceVariant,
              fontSize: 10,
            ),
          ),
        const SizedBox(height: 3),
        Text(
          '索引来源：${_resultSource.isEmpty ? '未提供' : _resultSource}',
          key: const ValueKey('tag-search-result-source'),
          style: TextStyle(
            color: Theme.of(context).colorScheme.onSurfaceVariant,
            fontSize: 10,
          ),
        ),
        Text(
          '查询发送到：$_requestedEndpoint',
          key: const ValueKey('tag-search-result-endpoint'),
          maxLines: 2,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(
            color: Theme.of(context).colorScheme.onSurfaceVariant,
            fontSize: 10,
          ),
        ),
        Text(
          '包含 NSFW 标签：${_requestedShowNsfw ? '是' : '否'}',
          style: TextStyle(
            color: Theme.of(context).colorScheme.onSurfaceVariant,
            fontSize: 10,
          ),
        ),
        Text(
          '返回 ${_results.length} 条（上限 30）',
          style: TextStyle(
            color: Theme.of(context).colorScheme.onSurfaceVariant,
            fontSize: 10,
          ),
        ),
      ],
    ),
  );

  Widget _resultCard(BuildContext context, int index) {
    final tag = _results[index];
    final theme = Theme.of(context);
    final meta = <String>[
      if (tag.cnName.trim().isNotEmpty) tag.cnName,
      tag.category.trim().isEmpty ? '分类未知' : tag.category,
      if (tag.nsfw.trim().isNotEmpty) 'NSFW：${tag.nsfw}',
      tag.count == null ? '热度未知' : '热度 ${tag.count}',
    ];
    return Card(
      key: ValueKey('tag-search-result-$index'),
      margin: EdgeInsets.zero,
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: () => _showDetails(tag),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 11, 8, 11),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      tag.promptText,
                      key: ValueKey('tag-search-prompt-text-$index'),
                      style: theme.textTheme.titleSmall?.copyWith(
                        color: theme.colorScheme.primary,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(height: 2),
                    SelectableText(
                      tag.tag,
                      style: TextStyle(
                        color: theme.colorScheme.onSurfaceVariant,
                        fontSize: 11,
                      ),
                    ),
                    const SizedBox(height: 6),
                    Wrap(
                      spacing: 6,
                      runSpacing: 3,
                      children: [
                        for (final item in meta)
                          Text(
                            item,
                            style: TextStyle(
                              color: theme.colorScheme.onSurfaceVariant,
                              fontSize: 10,
                            ),
                          ),
                      ],
                    ),
                    if (tag.wiki.trim().isNotEmpty) ...[
                      const SizedBox(height: 6),
                      Text(
                        tag.wiki.trim(),
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          color: theme.colorScheme.onSurfaceVariant,
                          fontSize: 11,
                        ),
                      ),
                    ],
                  ],
                ),
              ),
              IconButton(
                key: ValueKey('tag-search-copy-$index'),
                tooltip: '复制提示词标签',
                onPressed: () => _copyTag(tag),
                icon: const Icon(Icons.copy_outlined),
              ),
              Icon(
                Icons.chevron_right_rounded,
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

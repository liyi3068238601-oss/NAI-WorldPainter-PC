import 'dart:async';

import 'package:flutter/material.dart';

import '../assistant/agent_contract.dart';

/// Shows the models advertised by an assistant connection and returns the
/// exact selected model ID. Dismissing the dialog cancels the active request.
Future<String?> pickAssistantModel(
  BuildContext context, {
  required Future<List<String>> Function(AgentCancellation) loadModels,
}) => showDialog<String>(
  context: context,
  builder: (_) => _AssistantModelPicker(loadModels: loadModels),
);

class _AssistantModelPicker extends StatefulWidget {
  const _AssistantModelPicker({required this.loadModels});

  final Future<List<String>> Function(AgentCancellation) loadModels;

  @override
  State<_AssistantModelPicker> createState() => _AssistantModelPickerState();
}

class _AssistantModelPickerState extends State<_AssistantModelPicker> {
  final _search = TextEditingController();
  AgentCancellation? _cancellation;
  List<String>? _models;
  String? _error;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _startLoad(updateState: false);
  }

  void _startLoad({bool updateState = true}) {
    _cancellation?.cancel();
    final cancellation = AgentCancellation();
    _cancellation = cancellation;
    if (updateState) {
      setState(() {
        _loading = true;
        _error = null;
        _models = null;
      });
    }
    unawaited(_load(cancellation));
  }

  Future<void> _load(AgentCancellation cancellation) async {
    try {
      final models = await widget.loadModels(cancellation);
      if (!_isCurrent(cancellation)) return;
      setState(() {
        _models = List<String>.unmodifiable(models);
        _error = null;
        _loading = false;
      });
    } catch (error) {
      if (!_isCurrent(cancellation)) return;
      setState(() {
        _models = null;
        _error = _messageFor(error);
        _loading = false;
      });
    }
  }

  bool _isCurrent(AgentCancellation cancellation) =>
      mounted &&
      identical(_cancellation, cancellation) &&
      !cancellation.isCancelled;

  String _messageFor(Object error) =>
      error is AgentException ? error.message : '读取模型列表失败，请检查地址和凭据后重试。';

  @override
  void dispose() {
    _cancellation?.cancel();
    _search.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final query = _search.text.toLowerCase();
    final matchingModels = (_models ?? const <String>[])
        .where((model) => model.toLowerCase().contains(query))
        .toList(growable: false);

    return Dialog(
      key: const ValueKey('assistant-model-picker-dialog'),
      insetPadding: const EdgeInsets.all(16),
      constraints: const BoxConstraints(maxWidth: 820, maxHeight: 640),
      clipBehavior: Clip.antiAlias,
      child: SizedBox(
        width: 760,
        height: 560,
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          '选择助手模型',
                          style: Theme.of(context).textTheme.titleLarge,
                        ),
                        const SizedBox(height: 3),
                        Text(
                          '选择服务返回的完整模型 ID。',
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
                    key: const ValueKey('assistant-model-picker-close'),
                    tooltip: '关闭',
                    onPressed: () => Navigator.of(context).pop(),
                    icon: const Icon(Icons.close),
                  ),
                ],
              ),
              const SizedBox(height: 14),
              TextField(
                key: const ValueKey('assistant-model-picker-search'),
                controller: _search,
                onChanged: (_) => setState(() {}),
                textInputAction: TextInputAction.search,
                decoration: const InputDecoration(
                  labelText: '搜索模型 ID',
                  prefixIcon: Icon(Icons.search),
                  border: OutlineInputBorder(),
                  isDense: true,
                ),
              ),
              const SizedBox(height: 10),
              Expanded(child: _buildResults(matchingModels)),
              const SizedBox(height: 8),
              Align(
                alignment: Alignment.centerRight,
                child: TextButton(
                  key: const ValueKey('assistant-model-picker-cancel'),
                  onPressed: () => Navigator.of(context).pop(),
                  child: const Text('取消'),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildResults(List<String> matchingModels) {
    if (_loading) {
      return const Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            CircularProgressIndicator(
              key: ValueKey('assistant-model-picker-loading'),
            ),
            SizedBox(height: 12),
            Text('正在读取模型列表…'),
          ],
        ),
      );
    }

    final error = _error;
    if (error != null) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              Icons.cloud_off_outlined,
              color: Theme.of(context).colorScheme.error,
              size: 28,
            ),
            const SizedBox(height: 8),
            Text(error, textAlign: TextAlign.center),
            const SizedBox(height: 12),
            FilledButton.tonalIcon(
              key: const ValueKey('assistant-model-picker-retry'),
              onPressed: () => _startLoad(),
              icon: const Icon(Icons.refresh),
              label: const Text('重试'),
            ),
          ],
        ),
      );
    }

    final models = _models ?? const <String>[];
    if (models.isEmpty) {
      return const Center(
        child: Text(
          '服务没有返回任何模型。',
          key: ValueKey('assistant-model-picker-empty'),
          textAlign: TextAlign.center,
        ),
      );
    }
    if (matchingModels.isEmpty) {
      return const Center(
        child: Text(
          '没有匹配的模型 ID。',
          key: ValueKey('assistant-model-picker-no-matches'),
          textAlign: TextAlign.center,
        ),
      );
    }

    return Scrollbar(
      child: ListView.separated(
        key: const ValueKey('assistant-model-picker-list'),
        itemCount: matchingModels.length,
        separatorBuilder: (_, _) => const Divider(height: 1),
        itemBuilder: (context, index) {
          final model = matchingModels[index];
          return ListTile(
            key: ValueKey('assistant-model-picker-option-$index'),
            contentPadding: const EdgeInsets.symmetric(horizontal: 12),
            leading: const Icon(Icons.smart_toy_outlined),
            trailing: const Icon(Icons.chevron_right),
            title: Text(
              model,
              softWrap: true,
              style: const TextStyle(fontFamily: 'monospace'),
            ),
            onTap: () => Navigator.of(context).pop(model),
          );
        },
      ),
    );
  }
}

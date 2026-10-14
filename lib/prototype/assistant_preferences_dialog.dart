import 'dart:async';

import 'package:flutter/material.dart';

import '../assistant/agent_contract.dart';
import '../assistant/assistant_controller.dart';
import '../assistant/assistant_mobile_resources.dart';
import '../assistant/assistant_preferences.dart';

Future<void> showAssistantPreferencesDialog(
  BuildContext context,
  AssistantController controller,
) => showDialog<void>(
  context: context,
  builder: (_) => AssistantPreferencesDialog(controller: controller),
);

class AssistantPreferencesDialog extends StatefulWidget {
  const AssistantPreferencesDialog({
    super.key,
    required this.controller,
    this.loadResources,
  });

  final AssistantController controller;
  final Future<MobileAssistantResourcesSnapshot> Function()? loadResources;

  @override
  State<AssistantPreferencesDialog> createState() =>
      _AssistantPreferencesDialogState();
}

class _AssistantPreferencesDialogState
    extends State<AssistantPreferencesDialog> {
  late final v45StyleWords = TextEditingController(
    text: widget.controller.state.preferences.v45StyleWords,
  );
  late final v5StyleWords = TextEditingController(
    text: widget.controller.state.preferences.v5StyleWords,
  );
  bool _saving = false;
  bool _resourcesLoading = true;
  int _resourceRequest = 0;
  int _saveRequest = 0;
  String _message = '';
  bool _messageIsError = false;
  String _resourceError = '';
  MobileAssistantResourcesSnapshot? _snapshot;

  AssistantController get _controller => widget.controller;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) unawaited(_loadResources());
    });
  }

  @override
  void dispose() {
    _resourceRequest++;
    _saveRequest++;
    v45StyleWords.dispose();
    v5StyleWords.dispose();
    super.dispose();
  }

  Future<void> _savePreferences() async {
    final request = ++_saveRequest;
    setState(() {
      _saving = true;
      _message = '';
    });
    try {
      await _controller.savePreferences(
        AssistantPreferences(
          v45StyleWords: v45StyleWords.text,
          v5StyleWords: v5StyleWords.text,
        ),
      );
      if (!mounted || request != _saveRequest) return;
      setState(() {
        _message = _controller.workbench.hasStore
            ? '画风偏好已保存到本地工作区。'
            : '画风偏好已更新到当前会话预览；当前工作区没有持久化存储。';
        _messageIsError = false;
      });
    } on AgentException catch (error) {
      if (!mounted || request != _saveRequest) return;
      setState(() {
        _message = error.message;
        _messageIsError = true;
      });
    } on FormatException catch (error) {
      if (!mounted || request != _saveRequest) return;
      setState(() {
        _message = error.message;
        _messageIsError = true;
      });
    } catch (_) {
      if (!mounted || request != _saveRequest) return;
      setState(() {
        _message = '未能保存画风偏好，请检查本地工作区保存状态后重试。';
        _messageIsError = true;
      });
    } finally {
      if (mounted && request == _saveRequest) {
        setState(() => _saving = false);
      }
    }
  }

  Future<void> _loadResources() async {
    final request = ++_resourceRequest;
    setState(() {
      _resourcesLoading = true;
      _resourceError = '';
    });
    try {
      final loader = widget.loadResources ?? _controller.loadMobileResources;
      final snapshot = await loader();
      if (!mounted || request != _resourceRequest) return;
      setState(() => _snapshot = snapshot);
    } catch (_) {
      if (!mounted || request != _resourceRequest) return;
      setState(() {
        _snapshot = null;
        _resourceError = '手机端资料加载失败。请检查本地资料后重试加载。';
      });
    } finally {
      if (mounted && request == _resourceRequest) {
        setState(() => _resourcesLoading = false);
      }
    }
  }

  Widget _resourceCard({
    required String title,
    required String path,
    required String sha256,
    String? detail,
  }) => Card(
    margin: const EdgeInsets.only(bottom: 8),
    child: Padding(
      padding: const EdgeInsets.all(10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Icon(
                Icons.check_circle_outline,
                size: 18,
                color: Theme.of(context).colorScheme.primary,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  title,
                  style: const TextStyle(fontWeight: FontWeight.w600),
                ),
              ),
              const Text('已加载'),
            ],
          ),
          if (detail != null) ...[const SizedBox(height: 4), Text(detail)],
          const SizedBox(height: 4),
          SelectableText('来源：$path'),
          SelectableText('SHA-256：$sha256'),
        ],
      ),
    ),
  );

  Widget _mobileResources() {
    if (_resourcesLoading) {
      return const Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text('正在加载手机端内置资料…'),
          SizedBox(height: 8),
          LinearProgressIndicator(),
        ],
      );
    }
    final snapshot = _snapshot;
    if (snapshot == null) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            _resourceError,
            key: const ValueKey('assistant-mobile-resources-error'),
            style: TextStyle(color: Theme.of(context).colorScheme.error),
          ),
          const SizedBox(height: 4),
          OutlinedButton.icon(
            key: const ValueKey('assistant-mobile-resources-retry'),
            onPressed: _resourcesLoading ? null : _loadResources,
            icon: const Icon(Icons.refresh),
            label: const Text('重试加载'),
          ),
        ],
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text('来源：${snapshot.source}'),
        const SizedBox(height: 8),
        _resourceCard(
          title: '系统提示词',
          path: snapshot.systemPromptPath,
          sha256: snapshot.systemPromptSha256,
        ),
        _resourceCard(
          title: '内置技能',
          path: snapshot.skillPath,
          sha256: snapshot.skillSha256,
        ),
        _resourceCard(
          title: '构思参考',
          path: snapshot.ideationReferencePath,
          sha256: snapshot.ideationReferenceSha256,
        ),
        _resourceCard(
          title: '写作参考',
          path: snapshot.writingReferencePath,
          sha256: snapshot.writingReferenceSha256,
        ),
        _resourceCard(
          title: '内置知识库',
          path: snapshot.knowledgePath,
          sha256: snapshot.knowledgeSha256,
          detail: '${snapshot.knowledgeEntryCount} 条目',
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final disabled = _saving || _controller.busy;
    return PopScope(
      canPop: !_saving,
      child: AlertDialog(
        key: const ValueKey('assistant-preferences-dialog'),
        title: const Text('画风偏好与手机端资料'),
        content: SizedBox(
          width: 620,
          child: SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              mainAxisSize: MainAxisSize.min,
              children: [
                const Text('画风偏好按会话版本提供给助手，作为默认主正向提示词前缀。当前要求和你的审阅决定优先。'),
                const SizedBox(height: 14),
                TextField(
                  key: const ValueKey('assistant-style-words-v45'),
                  controller: v45StyleWords,
                  enabled: !disabled,
                  minLines: 3,
                  maxLines: 6,
                  maxLength: AssistantPreferences.maxStyleWordsLength,
                  decoration: const InputDecoration(
                    labelText: 'V4.5 默认画风/画师词',
                    hintText: '为 V4.5 会话设置默认的正向前缀。',
                    alignLabelWithHint: true,
                  ),
                ),
                const SizedBox(height: 10),
                TextField(
                  key: const ValueKey('assistant-style-words-v5'),
                  controller: v5StyleWords,
                  enabled: !disabled,
                  minLines: 3,
                  maxLines: 6,
                  maxLength: AssistantPreferences.maxStyleWordsLength,
                  decoration: const InputDecoration(
                    labelText: 'V5 默认画风/画师词',
                    hintText: '为 V5 会话独立设置默认的正向前缀。',
                    alignLabelWithHint: true,
                  ),
                ),
                if (_message.isNotEmpty) ...[
                  const SizedBox(height: 4),
                  Text(
                    _message,
                    key: const ValueKey('assistant-preferences-message'),
                    style: TextStyle(
                      color: _messageIsError ? colors.error : colors.primary,
                    ),
                  ),
                ],
                const SizedBox(height: 12),
                const Divider(height: 24),
                Text('手机端内置资料', style: Theme.of(context).textTheme.titleMedium),
                const SizedBox(height: 4),
                const Text('以下只显示来源和校验摘要，不展开资源正文。'),
                const SizedBox(height: 10),
                _mobileResources(),
                if (_saving) ...[
                  const SizedBox(height: 8),
                  const LinearProgressIndicator(),
                ],
              ],
            ),
          ),
        ),
        actions: [
          TextButton(
            key: const ValueKey('assistant-preferences-close'),
            onPressed: _saving ? null : () => Navigator.pop(context),
            child: const Text('关闭'),
          ),
          FilledButton(
            key: const ValueKey('assistant-preferences-save'),
            onPressed: disabled ? null : _savePreferences,
            child: Text(_saving ? '保存中…' : '保存偏好'),
          ),
        ],
      ),
    );
  }
}

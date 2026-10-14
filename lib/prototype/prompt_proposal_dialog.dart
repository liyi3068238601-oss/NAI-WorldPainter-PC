import 'package:flutter/material.dart';

import '../assistant/agent_contract.dart';
import '../assistant/assistant_controller.dart';
import '../assistant/assistant_state.dart';
import '../assistant/prompting_knowledge.dart';
import '../assistant/prompt_proposal.dart';

Future<bool?> showPromptProposalDialog({
  required BuildContext context,
  required AssistantController controller,
  required AssistantTurn turn,
  required PromptProposal proposal,
}) => showDialog<bool>(
  context: context,
  builder: (_) => _PromptProposalDialog(
    controller: controller,
    turn: turn,
    proposal: proposal,
  ),
);

class _PromptProposalDialog extends StatefulWidget {
  const _PromptProposalDialog({
    required this.controller,
    required this.turn,
    required this.proposal,
  });

  final AssistantController controller;
  final AssistantTurn turn;
  final PromptProposal proposal;

  @override
  State<_PromptProposalDialog> createState() => _PromptProposalDialogState();
}

class _PromptProposalDialogState extends State<_PromptProposalDialog> {
  late final TextEditingController _reason = TextEditingController(
    text: widget.proposal.reason.trim().isEmpty
        ? '采纳助手提案'
        : widget.proposal.reason.trim(),
  );
  late final Set<String> _selected = widget.proposal.fields.keys.toSet();
  PromptProposalReview? _review;
  String _reviewError = '';
  String _applyError = '';
  bool _saving = false;
  late final bool _legacyProposal =
      widget.turn.promptingVersion == null ||
      widget.turn.proposalDraftFingerprint.isEmpty;

  @override
  void initState() {
    super.initState();
    try {
      _review = widget.controller.preparePromptProposal(widget.turn);
    } on AgentException catch (error) {
      _reviewError = error.message;
    } catch (_) {
      _reviewError = '这条提案无法安全应用。';
    }
  }

  @override
  void dispose() {
    _reason.dispose();
    super.dispose();
  }

  Future<void> _apply() async {
    final review = _review;
    if (review == null || _saving || _selected.isEmpty) return;
    setState(() {
      _saving = true;
      _applyError = '';
    });
    try {
      await widget.controller.applyPromptProposal(
        review,
        targets: Set<String>.unmodifiable(_selected),
        reason: _reason.text.trim(),
      );
      if (mounted) Navigator.pop(context, true);
    } on AgentException catch (error) {
      if (mounted) setState(() => _applyError = error.message);
    } catch (_) {
      if (mounted) setState(() => _applyError = '应用失败，请检查当前提示词草稿后重试。');
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final size = MediaQuery.sizeOf(context);
    final colors = Theme.of(context).colorScheme;
    final review = _review;
    final reviewVersion = review?.version ?? widget.turn.promptingVersion;
    final proposalOnly = review == null;
    final canApply =
        review != null &&
        _selected.isNotEmpty &&
        _reason.text.trim().isNotEmpty &&
        _reason.text.length <= 1000 &&
        !_saving;
    final width = (size.width - 32).clamp(280.0, 760.0).toDouble();
    final height = (size.height - 32).clamp(320.0, 760.0).toDouble();

    return Dialog(
      key: const ValueKey('prompt-proposal-dialog'),
      insetPadding: const EdgeInsets.all(16),
      child: SizedBox(
        width: width,
        height: height,
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 16, 12, 12),
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          '审阅提示词提案',
                          style: Theme.of(context).textTheme.titleLarge,
                        ),
                        const SizedBox(height: 4),
                        Text(
                          '知识模式：${reviewVersion?.label ?? '旧记录未标记'}',
                          style: TextStyle(color: colors.onSurfaceVariant),
                        ),
                      ],
                    ),
                  ),
                  IconButton(
                    tooltip: '关闭',
                    onPressed: _saving ? null : () => Navigator.pop(context),
                    icon: const Icon(Icons.close),
                  ),
                ],
              ),
            ),
            const Divider(height: 1),
            Expanded(
              child: SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(20, 16, 20, 20),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text(
                      '助手说明：${widget.proposal.reason.trim().isEmpty ? '未提供' : widget.proposal.reason.trim()}',
                      style: TextStyle(color: colors.onSurfaceVariant),
                    ),
                    if (proposalOnly) ...[
                      const SizedBox(height: 12),
                      _Notice(
                        message: _legacyProposal
                            ? '这条旧提案没有可核对的草稿版本，当前仅供查看，不能应用。'
                            : _reviewError.isEmpty
                            ? '这条提案暂时无法应用。'
                            : _reviewError,
                        isError: true,
                      ),
                    ],
                    const SizedBox(height: 12),
                    for (final entry in widget.proposal.fields.entries)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 12),
                        child: _ProposalField(
                          target: entry.key,
                          label: promptProposalTargetLabel(entry.key),
                          selected: _selected.contains(entry.key),
                          selectable: !proposalOnly && !_saving,
                          before: review?.before[entry.key],
                          after: entry.value,
                          onSelected: (value) => setState(() {
                            if (value) {
                              _selected.add(entry.key);
                            } else {
                              _selected.remove(entry.key);
                            }
                          }),
                        ),
                      ),
                    if (!proposalOnly) ...[
                      const SizedBox(height: 4),
                      TextField(
                        key: const ValueKey('prompt-proposal-reason'),
                        controller: _reason,
                        enabled: !_saving,
                        maxLength: 1000,
                        minLines: 1,
                        maxLines: 3,
                        onChanged: (_) => setState(() {}),
                        decoration: InputDecoration(
                          labelText: '变更原因',
                          counterText: '',
                          errorText: _reason.text.length > 1000
                              ? '变更原因过长，请缩短。'
                              : null,
                        ),
                      ),
                    ],
                    if (_applyError.isNotEmpty) ...[
                      const SizedBox(height: 8),
                      _Notice(message: _applyError, isError: true),
                    ],
                  ],
                ),
              ),
            ),
            const Divider(height: 1),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 10, 16, 12),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      proposalOnly ? '审阅记录只读' : '${_selected.length} 项将写入当前草稿',
                      style: TextStyle(
                        fontSize: 12,
                        color: colors.onSurfaceVariant,
                      ),
                    ),
                  ),
                  TextButton(
                    key: const ValueKey('prompt-proposal-cancel'),
                    onPressed: _saving ? null : () => Navigator.pop(context),
                    child: const Text('取消'),
                  ),
                  const SizedBox(width: 8),
                  FilledButton.icon(
                    key: const ValueKey('prompt-proposal-apply'),
                    onPressed: canApply ? _apply : null,
                    icon: _saving
                        ? const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.check, size: 18),
                    label: Text(_saving ? '应用中…' : '确认应用'),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ProposalField extends StatelessWidget {
  const _ProposalField({
    required this.target,
    required this.label,
    required this.selected,
    required this.selectable,
    required this.before,
    required this.after,
    required this.onSelected,
  });

  final String target;
  final String label;
  final bool selected;
  final bool selectable;
  final String? before;
  final String after;
  final ValueChanged<bool> onSelected;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Material(
      key: ValueKey('prompt-proposal-field-$target'),
      color: colors.surfaceContainerLow,
      shape: RoundedRectangleBorder(
        side: BorderSide(color: colors.outlineVariant),
        borderRadius: BorderRadius.circular(10),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (selectable)
            CheckboxListTile(
              key: ValueKey('prompt-proposal-target-$target'),
              contentPadding: const EdgeInsets.symmetric(horizontal: 12),
              dense: true,
              controlAffinity: ListTileControlAffinity.leading,
              title: Text(
                label,
                style: const TextStyle(fontWeight: FontWeight.w600),
              ),
              value: selected,
              onChanged: (value) => onSelected(value ?? false),
            )
          else
            Padding(
              padding: const EdgeInsets.fromLTRB(14, 12, 14, 4),
              child: Text(
                label,
                style: const TextStyle(fontWeight: FontWeight.w600),
              ),
            ),
          LayoutBuilder(
            builder: (context, constraints) {
              final beforeCard = _ValueCard(
                title: '修改前',
                value: before ?? (selectable ? '' : '旧记录未保存修改前内容'),
              );
              final afterCard = _ValueCard(title: '修改后', value: after);
              if (constraints.maxWidth < 540) {
                return Padding(
                  padding: const EdgeInsets.fromLTRB(10, 0, 10, 10),
                  child: Column(
                    children: [
                      beforeCard,
                      const SizedBox(height: 8),
                      afterCard,
                    ],
                  ),
                );
              }
              return Padding(
                padding: const EdgeInsets.fromLTRB(10, 0, 10, 10),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(child: beforeCard),
                    const SizedBox(width: 8),
                    Expanded(child: afterCard),
                  ],
                ),
              );
            },
          ),
        ],
      ),
    );
  }
}

class _ValueCard extends StatelessWidget {
  const _ValueCard({required this.title, required this.value});
  final String title;
  final String value;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: colors.surface,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title,
            style: TextStyle(
              fontSize: 11,
              fontWeight: FontWeight.w600,
              color: colors.onSurfaceVariant,
            ),
          ),
          const SizedBox(height: 6),
          SelectableText(value.isEmpty ? '（空）' : value),
        ],
      ),
    );
  }
}

class _Notice extends StatelessWidget {
  const _Notice({required this.message, required this.isError});
  final String message;
  final bool isError;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.all(10),
    decoration: BoxDecoration(
      color:
          (isError
                  ? Theme.of(context).colorScheme.error
                  : Theme.of(context).colorScheme.primary)
              .withValues(alpha: .10),
      borderRadius: BorderRadius.circular(8),
    ),
    child: Text(
      message,
      style: TextStyle(
        color: isError
            ? Theme.of(context).colorScheme.error
            : Theme.of(context).colorScheme.primary,
      ),
    ),
  );
}

String promptProposalTargetLabel(String target) {
  const fixed = {
    'positive': '正向提示词',
    'negative': '负向提示词',
    'inpaint_positive': '局部重绘正向提示词',
    'inpaint_negative': '局部重绘负向提示词',
  };
  final known = fixed[target];
  if (known != null) return known;
  final match = RegExp(r'^character_(\d+)(_uc)?$').firstMatch(target);
  if (match != null) {
    final polarity = match.group(2) == null ? '正向' : '负向';
    return '角色${match.group(1)}$polarity提示词';
  }
  return '提示词目标（$target）';
}

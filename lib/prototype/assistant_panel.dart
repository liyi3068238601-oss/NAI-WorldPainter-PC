import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../assistant/agent_contract.dart';
import '../assistant/assistant_controller.dart';
import '../assistant/assistant_state.dart';
import '../assistant/model_discovery.dart';
import '../assistant/prompt_application.dart';
import '../assistant/prompting_knowledge.dart';
import '../assistant/prompt_proposal.dart';
import '../security/credential_vault.dart';
import '../platform/image_picker.dart';
import 'assistant_memory_dialog.dart';
import 'assistant_material_picker.dart';
import 'assistant_model_picker.dart';
import 'prompt_proposal_dialog.dart';
import 'stored_image.dart';
import 'workbench_controller.dart';

class AssistantPanel extends StatefulWidget {
  const AssistantPanel({super.key, required this.workbench});
  final WorkbenchController workbench;
  @override
  State<AssistantPanel> createState() => _AssistantPanelState();
}

class _AssistantPanelState extends State<AssistantPanel> {
  late final a = widget.workbench.assistant;
  final input = TextEditingController();
  final scroll = ScrollController();
  bool agent = true, requiredTool = false;
  String notice = '';
  String sessionId = '';
  @override
  void initState() {
    super.initState();
    _sync();
    a.addListener(_sync);
  }

  void _sync() {
    if (!mounted) return;
    final session = a.session;
    if (sessionId != session.id || input.text != session.input) {
      sessionId = session.id;
      input.text = session.input;
      input.selection = TextSelection.collapsed(offset: input.text.length);
    }
    final follow =
        !scroll.hasClients ||
        scroll.position.maxScrollExtent - scroll.offset < 100;
    if (follow) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && scroll.hasClients) {
          scroll.jumpTo(scroll.position.maxScrollExtent);
        }
      });
    }
    setState(() {});
  }

  @override
  void dispose() {
    a.removeListener(_sync);
    input.dispose();
    scroll.dispose();
    super.dispose();
  }

  Future<void> _act(FutureOr<void> Function() action) async {
    try {
      await action();
      if (mounted) setState(() => notice = '');
    } on AgentException catch (e) {
      if (mounted) setState(() => notice = e.message);
    } catch (_) {
      if (mounted) setState(() => notice = '操作未完成，请检查本地保存状态或连接设置。');
    }
  }

  Future<void> _send() =>
      _act(() => a.send(agent: agent, requireTool: agent && requiredTool));
  Future<void> _attach() => _act(() async {
    final bytes = await pickImage();
    if (bytes != null) await a.attachImage(bytes);
  });
  Future<void> _material() => _act(() async {
    final targetId = a.session.id;
    final text = await pickAssistantMaterial(
      context,
      widget.workbench.promptLibrary,
    );
    if (text == null || a.busy || a.session.id != targetId) return;
    final combined = [
      a.session.input,
      text,
    ].where((part) => part.trim().isNotEmpty).join('\n\n');
    if (combined.length > 24000) {
      throw const AgentException('插入后超过 24000 字符，请缩短聊天草稿。');
    }
    a.updateInput(combined);
  });
  Future<bool> _confirm(String text) async =>
      await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('确认操作'),
          content: Text(text),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('取消'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('确认'),
            ),
          ],
        ),
      ) ??
      false;
  Future<void> _rename() async {
    var text = a.session.title;
    final value = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('重命名会话'),
        content: TextFormField(
          initialValue: text,
          onChanged: (value) => text = value,
          maxLength: 100,
          decoration: const InputDecoration(labelText: '会话名称'),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, text),
            child: const Text('保存'),
          ),
        ],
      ),
    );
    if (value != null) await _act(() => a.renameSession(value));
  }

  Future<void> _reviewInteraction() async {
    final request = a.interaction;
    if (request == null) return;
    var text = '';
    String? selected;
    final response = await showDialog<String>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (context, setDialogState) => AlertDialog(
          title: Text(request.question ? '小助手需要你的选择' : '审核助手操作'),
          content: SizedBox(
            width: 600,
            child: SingleChildScrollView(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    request.title,
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                  const SizedBox(height: 16),
                  if (request.question) ...[
                    for (final option in request.options)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 8),
                        child: ChoiceChip(
                          label: Text(option),
                          selected: selected == option,
                          onSelected: (_) =>
                              setDialogState(() => selected = option),
                        ),
                      ),
                    TextFormField(
                      maxLength: 2000,
                      decoration: const InputDecoration(labelText: '或输入你的回答'),
                      onChanged: (value) => setDialogState(() => text = value),
                    ),
                  ] else ...[
                    if (request.preview['assetRef'] is String &&
                        widget.workbench.assets != null)
                      SizedBox(
                        height: 180,
                        child: StoredImage(
                          store: widget.workbench.assets!,
                          assetRef: request.preview['assetRef'] as String,
                        ),
                      ),
                    for (final entry in request.preview.entries.where(
                      (e) => e.key != 'assetRef',
                    ))
                      Padding(
                        padding: const EdgeInsets.only(bottom: 14),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              entry.key,
                              style: TextStyle(
                                color: Theme.of(context).colorScheme.primary,
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                            const SizedBox(height: 5),
                            SelectableText(
                              entry.value is String
                                  ? entry.value as String
                                  : const JsonEncoder.withIndent('  ')
                                        .convert(entry.value),
                            ),
                          ],
                        ),
                      ),
                  ],
                ],
              ),
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, 'reject'),
              child: Text(request.question ? '停止本轮' : '拒绝'),
            ),
            FilledButton(
              key: const ValueKey('assistant-approve'),
              onPressed:
                  request.question && text.trim().isEmpty && selected == null
                  ? null
                  : () => Navigator.pop(
                      context,
                      request.question
                          ? (text.trim().isNotEmpty ? text.trim() : selected)
                          : 'approve',
                    ),
              child: Text(request.question ? '回答并继续' : '确认执行'),
            ),
          ],
        ),
      ),
    );
    if (identical(a.interaction, request)) {
      a.answer(response == 'reject' ? null : response);
    }
  }

  Future<void> _settings() async {
    await showDialog<void>(
      context: context,
      builder: (_) => _AssistantSettings(controller: a),
    );
  }

  Future<void> _reviewPromptProposal(
    AssistantTurn turn,
    PromptProposal proposal,
  ) async {
    await showPromptProposalDialog(
      context: context,
      controller: a,
      turn: turn,
      proposal: proposal,
    );
  }

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, bounds) {
      final wide = bounds.maxWidth >= 1050;
      final colors = Theme.of(context).colorScheme;
      return Row(
        children: [
          if (wide)
            SizedBox(
              width: 220,
              child: Container(
                decoration: BoxDecoration(
                  border: Border(
                    right: BorderSide(color: colors.outlineVariant),
                  ),
                ),
                child: Column(
                  children: [
                    Padding(
                      padding: const EdgeInsets.all(14),
                      child: FilledButton.tonalIcon(
                        onPressed: a.busy ? null : () => _act(a.newSession),
                        icon: const Icon(Icons.add, size: 18),
                        label: const Text('新建会话'),
                      ),
                    ),
                    Expanded(
                      child: ListView(
                        children: [
                          for (final s in a.state.sessions.reversed)
                            ListTile(
                              dense: true,
                              selected: s.id == a.session.id,
                              leading: const Icon(
                                Icons.chat_bubble_outline,
                                size: 17,
                              ),
                              title: Text(
                                s.title,
                                maxLines: 2,
                                overflow: TextOverflow.ellipsis,
                              ),
                              subtitle: Text('${s.turns.length} 轮'),
                              onTap: a.busy
                                  ? null
                                  : () => _act(() => a.selectSession(s.id)),
                            ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
          Expanded(
            child: Padding(
              padding: EdgeInsets.all(bounds.maxWidth < 650 ? 12 : 20),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    children: [
                      if (!wide)
                        SizedBox(
                          width: bounds.maxWidth < 650 ? 175 : 220,
                          child: DropdownButtonFormField<String>(
                            key: ValueKey('assistant-session-${a.session.id}'),
                            initialValue: a.session.id,
                            isExpanded: true,
                            decoration: const InputDecoration(labelText: '会话'),
                            items: [
                              for (final s in a.state.sessions)
                                DropdownMenuItem(
                                  value: s.id,
                                  child: Text(
                                    s.title,
                                    overflow: TextOverflow.ellipsis,
                                  ),
                                ),
                            ],
                            onChanged: a.busy
                                ? null
                                : (id) {
                                    if (id != null) {
                                      _act(() => a.selectSession(id));
                                    }
                                  },
                          ),
                        ),
                      if (wide)
                        Text(
                          a.session.title,
                          style: Theme.of(context).textTheme.titleMedium,
                        ),
                      if (!wide)
                        IconButton(
                          tooltip: '新建会话',
                          onPressed: a.busy ? null : () => _act(a.newSession),
                          icon: const Icon(Icons.add),
                        ),
                      IconButton(
                        tooltip: '重命名会话',
                        onPressed: a.busy ? null : _rename,
                        icon: const Icon(Icons.edit_outlined),
                      ),
                      IconButton(
                        tooltip: '删除当前会话',
                        onPressed: a.busy
                            ? null
                            : () => _act(() async {
                                if (await _confirm('删除此会话及聊天记录？收藏和图片文件保留。')) {
                                  a.deleteSession();
                                }
                              }),
                        icon: const Icon(Icons.delete_outline),
                      ),
                      OutlinedButton.icon(
                        key: const ValueKey('assistant-settings'),
                        onPressed: a.busy ? null : _settings,
                        icon: const Icon(Icons.settings_outlined, size: 17),
                        label: const Text('模型与偏好'),
                      ),
                      OutlinedButton.icon(
                        key: const ValueKey('assistant-memories'),
                        onPressed: a.busy
                            ? null
                            : () => showAssistantMemories(context, a),
                        icon: const Icon(Icons.psychology_outlined, size: 17),
                        label: Text(
                          '记忆${a.state.memories.entries.where((entry) => !entry.isRetrievable && entry.supersededBy == null).isEmpty ? '' : ' · 待审核'}',
                        ),
                      ),
                      PopupMenuButton<String>(
                        tooltip: '会话操作',
                        enabled: !a.busy,
                        onSelected: (_) => _act(() async {
                          if (await _confirm('清空全部会话和聊天草稿？记忆、收藏及图片文件保留。')) {
                            a.clearSessions();
                          }
                        }),
                        itemBuilder: (_) => [
                          const PopupMenuItem(
                            value: 'clear',
                            child: Text('清空全部会话'),
                          ),
                        ],
                      ),
                      OutlinedButton.icon(
                        key: const ValueKey('assistant-diagnostic'),
                        onPressed: a.busy || a.state.mainProvider == null
                            ? null
                            : () => _act(() => a.send(diagnostic: true)),
                        icon: const Icon(Icons.rule_outlined, size: 17),
                        label: const Text('测试工具调用'),
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  Text(
                    a.state.mainProvider == null
                        ? '尚未配置对话模型 · 支持 OpenAI 兼容接口'
                        : '${a.state.mainProvider!.name} · ${a.state.mainProvider!.model}   /   识图：${a.state.visionProvider?.name ?? '未绑定'}',
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 11,
                      color: colors.onSurfaceVariant,
                    ),
                  ),
                  const SizedBox(height: 12),
                  Expanded(
                    child: a.session.turns.isEmpty
                        ? _empty()
                        : ListView(
                            controller: scroll,
                            children: [
                              for (final turn in a.session.turns) _turn(turn),
                            ],
                          ),
                  ),
                  if (a.interaction != null)
                    Container(
                      key: const ValueKey('assistant-pending'),
                      margin: const EdgeInsets.only(top: 8),
                      padding: const EdgeInsets.all(10),
                      decoration: BoxDecoration(
                        color: colors.primary.withValues(alpha: .12),
                        borderRadius: BorderRadius.circular(10),
                        border: Border.all(
                          color: colors.primary.withValues(alpha: .4),
                        ),
                      ),
                      child: Row(
                        children: [
                          const Icon(Icons.pending_actions, size: 20),
                          const SizedBox(width: 10),
                          Expanded(
                            child: Text(
                              a.interaction!.title,
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                          const SizedBox(width: 8),
                          FilledButton(
                            onPressed: _reviewInteraction,
                            child: Text(
                              a.interaction!.question ? '回答' : '查看并确认',
                            ),
                          ),
                        ],
                      ),
                    ),
                  if (notice.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 6),
                      child: Text(
                        notice,
                        style: TextStyle(color: colors.error),
                      ),
                    ),
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 8),
                    child: Row(
                      children: [
                        if (a.busy) ...[
                          const SizedBox(
                            width: 12,
                            height: 12,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          ),
                          const SizedBox(width: 8),
                        ],
                        Expanded(
                          child: Text(
                            a.status,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              color: colors.onSurfaceVariant,
                              fontSize: 11,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                  if (a.session.attachments.isNotEmpty)
                    SizedBox(
                      height: 72,
                      child: ListView(
                        scrollDirection: Axis.horizontal,
                        children: [
                          for (final ref in a.session.attachments)
                            SizedBox(
                              width: 80,
                              child: Stack(
                                children: [
                                  if (widget.workbench.assets != null)
                                    Positioned.fill(
                                      child: StoredImage(
                                        store: widget.workbench.assets!,
                                        assetRef: ref,
                                      ),
                                    ),
                                  Positioned(
                                    right: 0,
                                    top: 0,
                                    child: IconButton(
                                      tooltip: '移除附图',
                                      onPressed: a.busy
                                          ? null
                                          : () => a.removeAttachment(ref),
                                      icon: const Icon(Icons.close, size: 16),
                                    ),
                                  ),
                                ],
                              ),
                            ),
                        ],
                      ),
                    ),
                  Shortcuts(
                    shortcuts: const {
                      SingleActivator(LogicalKeyboardKey.enter, control: true):
                          _SendAssistantIntent(),
                    },
                    child: Actions(
                      actions: {
                        _SendAssistantIntent:
                            CallbackAction<_SendAssistantIntent>(
                              onInvoke: (_) {
                                if (!a.busy) _send();
                                return null;
                              },
                            ),
                      },
                      child: TextField(
                        key: const ValueKey('assistant-input'),
                        controller: input,
                        minLines: 2,
                        maxLines: bounds.maxHeight < 560 ? 3 : 5,
                        maxLength: 24000,
                        enabled: !a.busy,
                        onChanged: a.updateInput,
                        decoration: const InputDecoration(
                          hintText: '描述画面，或让小助手读取、整理并写入提示词…',
                          counterText: '',
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 8),
                  Wrap(
                    spacing: 8,
                    runSpacing: 4,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    children: [
                      FilterChip(
                        label: const Text('Agent 工具'),
                        selected: agent,
                        onSelected: a.busy
                            ? null
                            : (v) => setState(() => agent = v),
                      ),
                      if (agent)
                        FilterChip(
                          label: const Text('本轮必须调用工具'),
                          selected: requiredTool,
                          onSelected: a.busy
                              ? null
                              : (v) => setState(() => requiredTool = v),
                        ),
                      IconButton(
                        tooltip: '附加图片（发送至识图模型）',
                        onPressed: a.busy || widget.workbench.assets == null
                            ? null
                            : _attach,
                        icon: const Icon(Icons.add_photo_alternate_outlined),
                      ),
                      IconButton(
                        key: const ValueKey('assistant-material'),
                        tooltip: '插入本地提示词素材',
                        onPressed: a.busy ? null : _material,
                        icon: const Icon(Icons.bookmarks_outlined),
                      ),
                      if (a.busy)
                        FilledButton.tonalIcon(
                          key: const ValueKey('assistant-stop'),
                          onPressed: a.attaching ? null : a.cancel,
                          icon: const Icon(Icons.stop, size: 18),
                          label: const Text('停止'),
                        )
                      else
                        FilledButton.icon(
                          key: const ValueKey('assistant-send'),
                          onPressed: a.state.mainProvider == null
                              ? null
                              : _send,
                          icon: const Icon(Icons.arrow_upward, size: 18),
                          label: const Text('发送'),
                        ),
                      if (bounds.maxWidth > 650)
                        Text(
                          'Ctrl + Enter 发送',
                          style: TextStyle(
                            fontSize: 10,
                            color: colors.onSurfaceVariant,
                          ),
                        ),
                    ],
                  ),
                ],
              ),
            ),
          ),
        ],
      );
    },
  );
  Widget _empty() => Center(
    child: SingleChildScrollView(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
            Icons.auto_awesome_outlined,
            size: 38,
            color: Theme.of(context).colorScheme.primary,
          ),
          const SizedBox(height: 16),
          const Text(
            '把想法变成可用的提示词',
            style: TextStyle(fontSize: 20, fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 10),
          const Text(
            '小助手可以读取草稿、查找本地素材、整理角色词。\n实际修改先给你确认，执行过程始终可见。',
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 20),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            alignment: WrapAlignment.center,
            children: [
              for (final text in [
                '读取当前草稿，指出可以改进的地方',
                '先读取，再帮我优化并写入正向提示词',
                '查找与月光有关的本地提示词素材',
              ])
                ActionChip(
                  label: Text(text),
                  onPressed: () {
                    setState(() {
                      agent = true;
                      requiredTool = true;
                    });
                    a.updateInput(text);
                  },
                ),
            ],
          ),
        ],
      ),
    ),
  );
  Widget _turn(AssistantTurn turn) {
    final colors = Theme.of(context).colorScheme;
    PromptProposal? proposal;
    String? proposalParseIssue;
    if (turn.status == 'complete' && turn.promptApplication == null) {
      try {
        proposal = a.proposalForTurn(turn);
      } on FormatException {
        proposalParseIssue = '提示词提案格式无法解析，请查看助手回复。';
      }
    }
    final application = turn.promptApplication;
    return Padding(
      padding: const EdgeInsets.only(bottom: 18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: colors.primary.withValues(alpha: .10),
              borderRadius: BorderRadius.circular(12),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    const Text(
                      '你',
                      style: TextStyle(fontWeight: FontWeight.w600),
                    ),
                    const Spacer(),
                    IconButton(
                      tooltip: '编辑为新分支 / 重试',
                      onPressed: a.busy
                          ? null
                          : () => _act(() => a.forkFromTurn(turn)),
                      icon: const Icon(Icons.edit_note, size: 19),
                    ),
                  ],
                ),
                SelectableText(turn.userText),
                if (turn.attachments.isNotEmpty &&
                    widget.workbench.assets != null)
                  SizedBox(
                    height: 100,
                    child: ListView(
                      scrollDirection: Axis.horizontal,
                      children: [
                        for (final ref in turn.attachments)
                          Padding(
                            padding: const EdgeInsets.only(right: 8, top: 8),
                            child: SizedBox(
                              width: 120,
                              child: StoredImage(
                                store: widget.workbench.assets!,
                                assetRef: ref,
                              ),
                            ),
                          ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(height: 12),
          Text(
            '绘世小助手 · ${turn.providerLabel} · 提示词知识：${turn.promptingVersion?.label ?? '未记录'}',
            style: TextStyle(fontSize: 11, color: colors.onSurfaceVariant),
          ),
          const SizedBox(height: 6),
          for (final message in turn.messages.where(
            (m) =>
                m['role'] == 'assistant' &&
                m['content'] is String &&
                (m['content'] as String).isNotEmpty,
          ))
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(child: SelectableText(message['content'] as String)),
                  IconButton(
                    tooltip: '复制回复',
                    onPressed: () => Clipboard.setData(
                      ClipboardData(text: message['content'] as String),
                    ),
                    icon: const Icon(Icons.copy, size: 16),
                  ),
                ],
              ),
            ),
          if (proposalParseIssue != null)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                proposalParseIssue,
                key: ValueKey('assistant-proposal-parse-issue-${turn.id}'),
                style: TextStyle(color: colors.error, fontSize: 11),
              ),
            ),
          if (proposal != null)
            Align(
              alignment: Alignment.centerLeft,
              child: OutlinedButton.icon(
                key: ValueKey('assistant-proposal-${turn.id}'),
                onPressed: () => _reviewPromptProposal(turn, proposal!),
                icon: const Icon(Icons.difference_outlined, size: 18),
                label: const Text('查看提示词提案'),
              ),
            ),
          if (application != null) _promptApplication(turn, application),
          if (turn.liveText.isNotEmpty) SelectableText(turn.liveText),
          for (final trace in turn.traces) _trace(trace),
          if (turn.error.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(turn.error, style: TextStyle(color: colors.error)),
            ),
          if (turn.status == 'interrupted') const Text('上次进程退出时任务未完成；没有自动重发。'),
          if (turn.status == 'complete' && turn.traces.isEmpty)
            Text(
              '本轮未调用工具',
              style: TextStyle(fontSize: 11, color: colors.onSurfaceVariant),
            ),
        ],
      ),
    );
  }

  Widget _promptApplication(AssistantTurn turn, PromptApplication application) {
    final colors = Theme.of(context).colorScheme;
    final targets = <String>{
      ...application.before.keys,
      ...application.after.keys,
    };
    final appliedAt = DateTime.tryParse(application.appliedAt);
    final timestamp = appliedAt == null
        ? application.appliedAt
        : '${appliedAt.toLocal().year.toString().padLeft(4, '0')}-${appliedAt.toLocal().month.toString().padLeft(2, '0')}-${appliedAt.toLocal().day.toString().padLeft(2, '0')} ${appliedAt.toLocal().hour.toString().padLeft(2, '0')}:${appliedAt.toLocal().minute.toString().padLeft(2, '0')}';
    return Card(
      key: ValueKey('assistant-prompt-application-${turn.id}'),
      margin: const EdgeInsets.only(top: 8),
      child: ExpansionTile(
        leading: Icon(Icons.task_alt, color: colors.primary, size: 19),
        title: Text('已应用提案 · ${application.version.label}'),
        subtitle: Text('$timestamp · ${application.reason}'),
        children: [
          for (final target in targets)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 14),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Text(
                    promptProposalTargetLabel(target),
                    style: TextStyle(
                      color: colors.primary,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 6),
                  _applicationValue('修改前', application.before[target] ?? ''),
                  const SizedBox(height: 6),
                  _applicationValue('修改后', application.after[target] ?? ''),
                ],
              ),
            ),
        ],
      ),
    );
  }

  Widget _applicationValue(String title, String value) => Container(
    padding: const EdgeInsets.all(10),
    decoration: BoxDecoration(
      color: Theme.of(context).colorScheme.surfaceContainerLow,
      borderRadius: BorderRadius.circular(8),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(title, style: const TextStyle(fontSize: 11)),
        const SizedBox(height: 4),
        SelectableText(value.isEmpty ? '（空）' : value),
      ],
    ),
  );

  Widget _trace(Map<String, dynamic> trace) {
    const labels = {
      'pending': '待执行',
      'waiting': '待确认',
      'running': '执行中',
      'completed': '成功',
      'failed': '失败',
      'denied': '已拒绝',
      'cancelled': '已停止',
      'interrupted': '已中断',
    };
    final ok = trace['status'] == 'completed';
    return Card(
      margin: const EdgeInsets.symmetric(vertical: 4),
      child: ExpansionTile(
        dense: true,
        leading: Icon(
          ok ? Icons.check_circle_outline : Icons.build_outlined,
          size: 18,
          color: ok ? Theme.of(context).colorScheme.primary : null,
        ),
        title: Text(
          '${trace['name']} · ${labels[trace['status']] ?? trace['status']}',
          style: const TextStyle(fontSize: 12),
        ),
        subtitle: trace['summary'] is String
            ? Text(
                trace['summary'] as String,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
              )
            : null,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 14),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                SelectableText(
                  '参数：${trace['arguments'] ?? ''}',
                  style: const TextStyle(fontSize: 11),
                ),
                const SizedBox(height: 8),
                if (trace['result'] != null)
                  SelectableText(
                    '结果：${trace['result']}',
                    style: const TextStyle(fontSize: 11),
                  ),
                Text(
                  '${trace['durationMs'] ?? 0} ms',
                  style: const TextStyle(fontSize: 10),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _SendAssistantIntent extends Intent {
  const _SendAssistantIntent();
}

class _AssistantSettings extends StatefulWidget {
  const _AssistantSettings({required this.controller});
  final AssistantController controller;
  @override
  State<_AssistantSettings> createState() => _AssistantSettingsState();
}

class _AssistantSettingsState extends State<_AssistantSettings> {
  late final a = widget.controller;
  late final system = TextEditingController(text: a.state.systemPrompt);
  late int turns = a.state.contextTurns;
  late PromptingVersion promptingVersion = a.promptingVersion;
  String error = '';
  Future<void> _edit([AssistantProvider? old]) async {
    final provider = await showDialog<AssistantProvider>(
      context: context,
      builder: (_) => _ProviderEditor(controller: a, provider: old),
    );
    if (provider != null && mounted) setState(() {});
  }

  Future<void> _remove(AssistantProvider provider) async {
    final approved = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('删除模型连接'),
        content: Text('删除“${provider.name}”及此地址保存的 API Key？会话记录保留。'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('删除'),
          ),
        ],
      ),
    );
    if (approved != true) return;
    try {
      await a.removeProvider(provider.id);
      if (mounted) setState(() {});
    } catch (e) {
      if (mounted) {
        setState(() => error = e is AgentException ? e.message : '未能删除模型连接。');
      }
    }
  }

  @override
  void dispose() {
    system.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: const Text('小助手 · 模型与偏好'),
    content: SizedBox(
      width: 610,
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              kIsWeb
                  ? '浏览器凭据只在本次会话保存。聊天内容发送至所选模型服务。'
                  : 'API Key 由 Windows 凭据管理器保护，按助手连接和地址隔离。聊天发送至所选模型服务。',
            ),
            const SizedBox(height: 12),
            for (final p in a.state.providers)
              ListTile(
                contentPadding: EdgeInsets.zero,
                title: Text(p.name),
                subtitle: Text('${p.model}\n${p.apiRoot}', maxLines: 3),
                isThreeLine: true,
                trailing: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    IconButton(
                      tooltip: '编辑模型连接',
                      onPressed: () => _edit(p),
                      icon: const Icon(Icons.edit_outlined),
                    ),
                    IconButton(
                      tooltip: '删除模型连接',
                      onPressed: () => _remove(p),
                      icon: const Icon(Icons.delete_outline),
                    ),
                  ],
                ),
              ),
            OutlinedButton.icon(
              key: const ValueKey('assistant-add-provider'),
              onPressed: _edit,
              icon: const Icon(Icons.add),
              label: const Text('新增模型连接'),
            ),
            const SizedBox(height: 16),
            DropdownButtonFormField<String>(
              key: ValueKey(
                'main-${a.state.mainProviderId}-${a.state.providers.length}',
              ),
              initialValue: a.state.mainProviderId,
              isExpanded: true,
              decoration: const InputDecoration(labelText: '对话模型'),
              items: [
                for (final p in a.state.providers)
                  DropdownMenuItem(
                    value: p.id,
                    child: Text(
                      '${p.name} · ${p.model}',
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
              ],
              onChanged: (id) => setState(() => a.selectProvider(id)),
            ),
            const SizedBox(height: 14),
            DropdownButtonFormField<String>(
              key: ValueKey(
                'vision-${a.state.visionProviderId}-${a.state.providers.length}',
              ),
              initialValue: a.state.visionProviderId ?? '',
              isExpanded: true,
              decoration: const InputDecoration(labelText: '识图模型（只处理你发送的附图）'),
              items: [
                const DropdownMenuItem(value: '', child: Text('未绑定')),
                for (final p in a.state.providers)
                  DropdownMenuItem(
                    value: p.id,
                    child: Text(
                      '${p.name} · ${p.model}',
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
              ],
              onChanged: (id) => setState(
                () => a.selectProvider(id == '' ? null : id, vision: true),
              ),
            ),
            const SizedBox(height: 14),
            DropdownButtonFormField<PromptingVersion>(
              key: ValueKey(
                'assistant-prompting-version-${promptingVersion.name}',
              ),
              initialValue: promptingVersion,
              isExpanded: true,
              decoration: const InputDecoration(labelText: '提示词知识模式'),
              items: [
                for (final version in PromptingVersion.values)
                  DropdownMenuItem(value: version, child: Text(version.label)),
              ],
              onChanged: (value) {
                if (value != null) setState(() => promptingVersion = value);
              },
            ),
            const SizedBox(height: 4),
            const Text(
              '只切换助手使用的提示词知识，不会改变生图模型。',
              style: TextStyle(fontSize: 11),
            ),
            const SizedBox(height: 14),
            Text('上下文：最近 $turns 个完整轮次（含工具结果）'),
            Slider(
              value: turns.toDouble(),
              min: 1,
              max: 20,
              divisions: 19,
              onChanged: (v) => setState(() => turns = v.round()),
            ),
            TextField(
              controller: system,
              maxLines: 5,
              maxLength: 12000,
              decoration: const InputDecoration(
                labelText: '自定义助手偏好',
                hintText: '例如：保留原有画师词，先解释再给建议。',
              ),
            ),
            if (error.isNotEmpty)
              Text(
                error,
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
          ],
        ),
      ),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('关闭'),
      ),
      FilledButton(
        onPressed: () {
          try {
            a.updateSettings(
              systemPrompt: system.text,
              contextTurns: turns,
              promptingVersion: promptingVersion,
            );
            Navigator.pop(context);
          } on AgentException catch (e) {
            setState(() => error = e.message);
          }
        },
        child: const Text('保存偏好'),
      ),
    ],
  );
}

class _ProviderEditor extends StatefulWidget {
  const _ProviderEditor({required this.controller, this.provider});
  final AssistantController controller;
  final AssistantProvider? provider;
  @override
  State<_ProviderEditor> createState() => _ProviderEditorState();
}

class _ProviderEditorState extends State<_ProviderEditor> {
  late final name = TextEditingController(text: widget.provider?.name ?? '');
  late final url = TextEditingController(
    text: widget.provider?.baseUrl ?? 'https://api.openai.com/v1',
  );
  late final model = TextEditingController(text: widget.provider?.model ?? '');
  final secret = TextEditingController();
  late bool stream = widget.provider?.streaming ?? true;
  late bool keyRequired = widget.provider?.requireKey ?? true;
  bool saving = false;
  String error = '';
  Future<void> _pickModel() async {
    final provider = AssistantProvider(
      id: widget.provider?.id ?? 'unsaved-model-discovery',
      name: name.text.trim().isEmpty ? '未保存连接' : name.text.trim(),
      baseUrl: url.text.trim(),
      model: 'discovery',
      requireKey: keyRequired,
    );
    final keyDraft = secret.text;
    final useStoredKey = widget.provider != null;
    final selected = await pickAssistantModel(
      context,
      loadModels: (token) => discoverAssistantModels(
        provider: provider,
        vault: widget.controller.workbench.vault ?? createCredentialVault(),
        cancellation: token,
        draftSecret: keyDraft,
        useStoredKey: useStoredKey,
      ),
    );
    if (selected != null && mounted) model.text = selected;
  }

  @override
  void dispose() {
    name.dispose();
    url.dispose();
    model.dispose();
    secret.clear();
    secret.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    setState(() => saving = true);
    try {
      final p = AssistantProvider(
        id:
            widget.provider?.id ??
            'llm-${DateTime.now().microsecondsSinceEpoch}',
        name: name.text.trim(),
        baseUrl: url.text.trim(),
        model: model.text.trim(),
        streaming: stream,
        requireKey: keyRequired,
      );
      await widget.controller.saveProvider(p, secret: secret.text);
      secret.clear();
      if (mounted) Navigator.pop(context, p);
    } on AgentException catch (e) {
      if (mounted) setState(() => error = e.message);
    } catch (_) {
      if (mounted) setState(() => error = '保存失败，请检查地址或 Windows 凭据服务。');
    } finally {
      if (mounted) setState(() => saving = false);
    }
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: Text(widget.provider == null ? '新增模型连接' : '编辑模型连接'),
    content: SizedBox(
      width: 520,
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
              controller: name,
              maxLength: 100,
              decoration: const InputDecoration(labelText: '连接名称'),
            ),
            TextField(
              controller: url,
              decoration: const InputDecoration(
                labelText: 'OpenAI 兼容 API 地址',
                helperText: '可填根地址、/v1 或完整 /chat/completions 地址。',
              ),
            ),
            const SizedBox(height: 14),
            TextField(
              controller: model,
              maxLength: 200,
              decoration: const InputDecoration(
                labelText: '模型 ID',
                helperText: '使用服务提供的精确模型 ID；Agent 需要支持工具调用。',
              ),
            ),
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton.icon(
                key: const ValueKey('assistant-fetch-models'),
                onPressed: saving ? null : _pickModel,
                icon: const Icon(Icons.list_alt_outlined),
                label: const Text('读取此连接的模型列表'),
              ),
            ),
            TextField(
              controller: secret,
              obscureText: true,
              enableSuggestions: false,
              autocorrect: false,
              decoration: InputDecoration(
                labelText: 'API Key',
                helperText: widget.provider == null
                    ? '保存时写入系统凭据库；读取模型列表会使用当前地址与 Key。'
                    : '留空保留同一连接和地址的现有凭据；改地址须重新填写。',
              ),
            ),
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              title: const Text('流式回复'),
              subtitle: const Text('服务不支持 SSE 时可手动关闭，不会自动降级或重发。'),
              value: stream,
              onChanged: saving ? null : (v) => setState(() => stream = v),
            ),
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              title: const Text('要求 API Key'),
              subtitle: const Text('无鉴权的本地模型服务可关闭。'),
              value: keyRequired,
              onChanged: saving ? null : (v) => setState(() => keyRequired = v),
            ),
            if (error.isNotEmpty)
              Text(
                error,
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
          ],
        ),
      ),
    ),
    actions: [
      TextButton(
        onPressed: saving ? null : () => Navigator.pop(context),
        child: const Text('取消'),
      ),
      FilledButton(
        key: const ValueKey('assistant-save-provider'),
        onPressed: saving ? null : _save,
        child: Text(saving ? '保存中…' : '保存连接'),
      ),
    ],
  );
}

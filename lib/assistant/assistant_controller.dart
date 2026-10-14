import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../prototype/workbench_controller.dart';
import '../security/credential_vault.dart';
import 'agent_contract.dart';
import 'agent_engine.dart';
import 'assistant_state.dart';
import 'openai_agent_transport.dart';
import 'prompt_memory.dart';
import 'prompt_application.dart';
import 'prompt_proposal.dart';
import 'prompting_knowledge.dart';
import 'workspace_tools.dart';
import 'image_analysis.dart';
import 'wd_tagger.dart';

class AssistantInteraction {
  AssistantInteraction({
    required this.title,
    required this.preview,
    this.options = const [],
    this.question = false,
  });
  final String title;
  final Map<String, dynamic> preview;
  final List<String> options;
  final bool question;
  final response = Completer<String?>();
}

class PromptProposalReview {
  PromptProposalReview._({
    required this.turn,
    required this.proposal,
    required Map<String, String> before,
    required this.version,
    required this.draftFingerprint,
    required this.sessionId,
    required this.response,
  }) : before = Map.unmodifiable(before);
  final AssistantTurn turn;
  final PromptProposal proposal;
  final Map<String, String> before;
  final PromptingVersion version;
  final String draftFingerprint, sessionId, response;
}

class AssistantController extends ChangeNotifier {
  AssistantController({
    required this.workbench,
    AssistantState? state,
    AgentTransport? transport,
    WdTaggerClient? wdTaggerClient,
  }) : state = state ?? AssistantState(),
       wdTaggerClient = wdTaggerClient ?? WdTaggerClient(),
       transport =
           transport ??
           OpenAiAgentTransport(
             vault: workbench.vault ?? createCredentialVault(),
           ) {
    if (this.state.sessions.isEmpty) {
      final session = AssistantSession(id: _id('chat'), title: '新会话');
      this.state.sessions.add(session);
      this.state.activeSessionId = session.id;
    }
    this.state.activeSessionId ??= this.state.sessions.first.id;
  }
  final WorkbenchController workbench;
  final AssistantState state;
  final AgentTransport transport;
  final WdTaggerClient wdTaggerClient;
  AgentCancellation? _token;
  Future<void>? _active;
  bool _disposed = false;
  bool attaching = false;
  bool _applyingProposal = false;
  bool get busy => _token != null || attaching || _applyingProposal;
  String? runningSessionId;
  String status = '配置对话模型后开始；工具执行过程会在这里显示。';
  AssistantInteraction? interaction;
  static int _sequence = 0;
  static String _id(String prefix) =>
      '$prefix-${DateTime.now().microsecondsSinceEpoch}-${_sequence++}';
  AssistantSession get session => state.activeSession ?? state.sessions.first;
  PromptingVersion get promptingVersion =>
      session.promptingVersion ?? state.promptingVersion;

  void changed() {
    if (_disposed) return;
    workbench.notifyListeners();
    notifyListeners();
  }

  void _idle() {
    if (busy || workbench.closing || workbench.maintainingAssets || _disposed) {
      throw const AgentException('请先停止当前助手任务。');
    }
  }

  void newSession() {
    _idle();
    if (state.sessions.length >= AssistantState.maxSessions) {
      throw const AgentException('会话数量已达上限，请整理旧会话。');
    }
    final next = AssistantSession(
      id: _id('chat'),
      title: '新会话',
      promptingVersion: state.promptingVersion,
    );
    state.sessions.add(next);
    state.activeSessionId = next.id;
    changed();
  }

  void selectSession(String id) {
    _idle();
    if (!state.sessions.any((s) => s.id == id)) return;
    state.activeSessionId = id;
    changed();
  }

  void renameSession(String title) {
    _idle();
    if (title.trim().isEmpty) return;
    session.title = title.trim().substring(
      0,
      title.trim().length.clamp(0, 100),
    );
    changed();
  }

  void deleteSession() {
    _idle();
    state.sessions.remove(session);
    if (state.sessions.isEmpty) {
      newSession();
    } else {
      state.activeSessionId = state.sessions.last.id;
      changed();
    }
  }

  void clearSessions() {
    _idle();
    state.sessions.clear();
    newSession();
  }

  Future<MemoryEntry> saveMemory({
    String? id,
    required String trigger,
    required String content,
    required MemoryKind kind,
    MemorySource source = MemorySource.manual,
    MemoryResolution? resolution,
    int? expectedRevision,
  }) async {
    _idle();
    final result = state.memories.save(
      id: id,
      trigger: trigger,
      content: content,
      kind: kind,
      source: source,
      resolution: resolution,
      expectedRevision: expectedRevision,
    );
    changed();
    await workbench.flush();
    return result;
  }

  Future<MemoryEntry> approveMemory(
    String id, {
    String? trigger,
    String? content,
    MemoryKind? kind,
    MemoryResolution? resolution,
    int? expectedRevision,
  }) async {
    _idle();
    final result = state.memories.approve(
      id,
      trigger: trigger,
      content: content,
      kind: kind,
      resolution: resolution,
      expectedRevision: expectedRevision,
    );
    changed();
    await workbench.flush();
    return result;
  }

  Future<void> deleteMemories(Set<String> ids, {int? expectedRevision}) async {
    _idle();
    state.memories.delete(ids, expectedRevision: expectedRevision);
    changed();
    await workbench.flush();
  }

  void updateInput(String input) {
    session.input = input;
    changed();
  }

  void removeAttachment(String ref) {
    if (!busy) {
      session.attachments.remove(ref);
      changed();
    }
  }

  Future<void> attachImage(Uint8List bytes) async {
    _idle();
    final target = session;
    if (workbench.assets == null) throw const AgentException('当前没有可用的图片存储。');
    if (target.attachments.length >= 4 || bytes.length > 10 * 1024 * 1024) {
      throw const AgentException('每次最多 4 张图片，每张不超过 10 MiB。');
    }
    attaching = true;
    status = '正在保存附图，请稍候…';
    changed();
    try {
      await workbench.prepareEditing(() async {
        final asset = await workbench.assets!.save(bytes);
        if (_disposed || session.id != target.id) return;
        if (!target.attachments.contains(asset.assetRef)) {
          target.attachments.add(asset.assetRef);
        }
        changed();
        await workbench.flush();
      });
      status = '附图已保存，发送后使用已启用的附图分析服务。';
    } finally {
      attaching = false;
      changed();
    }
  }

  Future<void> saveProvider(
    AssistantProvider provider, {
    String secret = '',
  }) async {
    _idle();
    provider.validate();
    final vault = workbench.vault ?? createCredentialVault();
    if (secret.trim().isNotEmpty) await provider.saveSecret(vault, secret);
    _idle();
    final index = state.providers.indexWhere((p) => p.id == provider.id);
    if (index < 0 && state.providers.length >= AssistantState.maxProviders) {
      throw const AgentException('模型连接数量已达上限。');
    }
    if (index < 0) {
      state.providers.add(provider);
    } else {
      state.providers[index] = provider;
    }
    state.mainProviderId ??= provider.id;
    changed();
    await workbench.flush();
  }

  Future<void> removeProvider(String id) async {
    _idle();
    final provider = state.providers.where((p) => p.id == id).firstOrNull;
    if (provider == null) return;
    await provider.deleteSecret(workbench.vault ?? createCredentialVault());
    _idle();
    state.providers.remove(provider);
    if (state.mainProviderId == id) state.mainProviderId = null;
    if (state.visionProviderId == id) state.visionProviderId = null;
    changed();
    await workbench.flush();
  }

  void selectProvider(String? id, {bool vision = false}) {
    _idle();
    if (id != null && !state.providers.any((p) => p.id == id)) {
      throw const AgentException('连接不存在。');
    }
    if (vision) {
      state.visionProviderId = id;
    } else {
      state.mainProviderId = id;
    }
    changed();
  }

  void updateWdTaggerSettings(WdTaggerSettings settings) {
    _idle();
    settings.validate();
    state.wdTagger = settings;
    changed();
  }

  void updateSettings({
    required String systemPrompt,
    required int contextTurns,
    PromptingVersion? promptingVersion,
  }) {
    _idle();
    if (systemPrompt.length > 12000 || contextTurns < 1 || contextTurns > 20) {
      throw const AgentException('助手偏好或上下文范围无效。');
    }
    state.systemPrompt = systemPrompt;
    state.contextTurns = contextTurns;
    if (promptingVersion != null) {
      // Pin legacy sessions before changing the default for future sessions.
      for (final saved in state.sessions) {
        saved.promptingVersion ??= state.promptingVersion;
      }
      state.promptingVersion = promptingVersion;
      session.promptingVersion = promptingVersion;
    }
    changed();
  }

  String _proposalResponse(AssistantTurn turn) {
    final last = turn.messages.lastOrNull;
    return last?['role'] == 'assistant' &&
            last?['content'] is String &&
            (last?['tool_calls'] == null ||
                (last?['tool_calls'] is List &&
                    (last!['tool_calls'] as List).isEmpty))
        ? last!['content'] as String
        : '';
  }

  PromptProposal? proposalForTurn(AssistantTurn turn) {
    if (turn.status != 'complete') return null;
    final proposal = parsePromptProposal(_proposalResponse(turn));
    if (proposal == null || !turn.proposalInpaint) return proposal;
    final fields = <String, String>{};
    for (final entry in proposal.fields.entries) {
      final target = const {'positive', 'negative'}.contains(entry.key)
          ? 'inpaint_${entry.key}'
          : entry.key;
      if (fields.containsKey(target)) throw const FormatException('提案包含重复目标。');
      fields[target] = entry.value;
    }
    return PromptProposal(fields: fields, reason: proposal.reason);
  }

  void _checkProposal(AssistantTurn turn) {
    _idle();
    if (workbench.generating || workbench.encodingVibe) {
      throw const AgentException('图像任务进行中，请完成后再审阅提案。');
    }
    if (!session.turns.contains(turn) || turn.status != 'complete') {
      throw const AgentException('该提案不属于当前已完成会话。');
    }
    if (turn.promptApplication != null) {
      throw const AgentException('此提案已应用，请查看应用记录。');
    }
    if (turn.promptingVersion == null ||
        turn.proposalDraftFingerprint.isEmpty) {
      throw const AgentException('旧回复没有草稿版本记录，请重新请求提案。');
    }
    if (turn.proposalDraftFingerprint != workbench.assistantDraftFingerprint) {
      throw const AgentException('创作草稿已更新，未应用旧提案。请基于当前草稿重新请求。');
    }
  }

  PromptProposalReview preparePromptProposal(AssistantTurn turn) {
    _checkProposal(turn);
    final proposal = proposalForTurn(turn);
    if (proposal == null) throw const AgentException('回复中没有明确的提示词提案。');
    return PromptProposalReview._(
      turn: turn,
      proposal: proposal,
      version: turn.promptingVersion!,
      sessionId: session.id,
      response: _proposalResponse(turn),
      draftFingerprint: workbench.assistantDraftFingerprint,
      before: {
        for (final target in proposal.fields.keys)
          target: workbench.assistantPromptValue(target),
      },
    );
  }

  Future<void> applyPromptProposal(
    PromptProposalReview review, {
    required Set<String> targets,
    required String reason,
  }) async {
    _checkProposal(review.turn);
    if (review.sessionId != session.id ||
        review.draftFingerprint != workbench.assistantDraftFingerprint ||
        review.response != _proposalResponse(review.turn) ||
        review.version != review.turn.promptingVersion) {
      throw const AgentException('提案或草稿已变化，请重新审阅。');
    }
    if (targets.isEmpty ||
        targets.any((t) => !review.proposal.fields.containsKey(t))) {
      throw const AgentException('请选择提案中要应用的词框。');
    }
    if (reason.trim().isEmpty || reason.length > 1000) {
      throw const AgentException('请填写 1–1000 字的变更原因。');
    }
    final before = {
      for (final t in targets) t: workbench.assistantPromptValue(t),
    };
    final after = {for (final t in targets) t: review.proposal.fields[t]!};
    final receipt = PromptApplication(
      version: review.version,
      reason: reason.trim(),
      appliedAt: DateTime.now().toUtc().toIso8601String(),
      before: before,
      after: after,
    );
    _applyingProposal = true;
    // Receipt and fields participate in the same workspace snapshot.
    review.turn.promptApplication = receipt;
    try {
      workbench.applyAssistantPrompts(after);
      changed();
      await workbench.flush();
      status = workbench.store == null
          ? '已应用 ${targets.length} 个词框；当前为会话预览，记录仅在内存中保留。'
          : '已应用 ${targets.length} 个词框，版本与变更原因已保存。';
    } catch (_) {
      status = '提案已留在当前工作区，请检查保存状态；未自动重试。';
      throw const AgentException('提案已写入当前草稿，但尚未确认保存。请检查工作区保存状态，无需重新应用。');
    } finally {
      _applyingProposal = false;
      changed();
    }
  }

  /// Editing forks at the selected user turn. Earlier history stays intact.
  void forkFromTurn(AssistantTurn turn) {
    _idle();
    if (state.sessions.length >= AssistantState.maxSessions) {
      throw const AgentException('会话数量已达上限，请整理旧会话。');
    }
    final source = session;
    final index = source.turns.indexOf(turn);
    if (index < 0) return;
    final next = AssistantSession(
      id: _id('chat'),
      title: '${source.title.take(80)} · 分支',
      promptingVersion: promptingVersion,
      turns: source.turns
          .take(index)
          .map(
            (t) => AssistantTurn.fromJson({...t.toJson(), 'id': _id('turn')}),
          )
          .toList(),
      input: turn.userText,
      attachments: [...turn.attachments],
    );
    state.sessions.add(next);
    state.activeSessionId = next.id;
    changed();
  }

  void answer(String? value) {
    final pending = interaction;
    if (pending != null && !pending.response.isCompleted) {
      pending.response.complete(value);
    }
  }

  Future<String?> _interact(
    AssistantInteraction request,
    AgentCancellation token,
  ) async {
    token.check();
    interaction = request;
    changed();
    try {
      return await token.bind(request.response.future);
    } finally {
      if (identical(interaction, request)) {
        interaction = null;
        changed();
      }
    }
  }

  Future<void> send({
    bool agent = true,
    bool requireTool = false,
    bool diagnostic = false,
  }) {
    _idle();
    final provider = state.mainProvider;
    if (provider == null) throw const AgentException('请先配置并选择对话模型。');
    provider.validate();
    final target = session;
    if (target.turns.length >= AssistantSession.maxTurns) {
      throw const AgentException('会话轮数已达上限，请新建会话。');
    }
    final text = diagnostic ? '测试本连接的结构化工具调用与结果回传。' : target.input.trim();
    if (text.isEmpty) throw const AgentException('请输入要发送的内容。');
    if (text.length > 24000) throw const AgentException('输入超过 24000 字符，请缩短。');
    if (!diagnostic &&
        target.attachments.isNotEmpty &&
        state.visionProvider == null &&
        !state.wdTagger.enabled) {
      throw const AgentException('附图前请绑定识图模型或启用 WD-Tagger。');
    }
    if (!diagnostic && target.attachments.isNotEmpty) {
      if (target.attachments.length > 4 || workbench.assets == null) {
        throw const AgentException('附图存储不可用或图片超过 4 张。');
      }
      state.wdTagger.validate();
    }
    final turn = AssistantTurn(
      id: _id('turn'),
      userText: text,
      attachments: diagnostic ? [] : [...target.attachments],
      providerLabel: '${provider.name} · ${provider.model}'.take(180),
      providerContext: provider.contextKey,
      promptingVersion: promptingVersion,
      proposalDraftFingerprint: diagnostic
          ? ''
          : workbench.assistantDraftFingerprint,
      proposalInpaint:
          workbench.assistantPromptSnapshot['is_inpainting_mode'] == true,
    );
    target.turns.add(turn);
    if (!diagnostic) {
      target.input = '';
      target.attachments.clear();
    }
    if (target.title == '新会话') target.title = text.take(36);
    final token = AgentCancellation();
    _token = token;
    runningSessionId = target.id;
    status = diagnostic ? '正在检查工具调用…' : '正在请求模型…';
    changed();
    final future = _run(
      target,
      turn,
      provider,
      token,
      agent: agent,
      requireTool: requireTool,
      diagnostic: diagnostic,
    );
    _active = future;
    return future;
  }

  Future<void> _run(
    AssistantSession target,
    AssistantTurn turn,
    AssistantProvider provider,
    AgentCancellation token, {
    required bool agent,
    required bool requireTool,
    required bool diagnostic,
  }) async {
    // Capture bindings, preferences and the draft BEFORE any network await.
    final vision = state.visionProvider;
    final wdSettings = state.wdTagger;
    final host = WorkspaceAgentTools(
      workbench,
      askUser: (question, options) => _interact(
        AssistantInteraction(
          title: question,
          preview: const {},
          options: options,
          question: true,
        ),
        token,
      ),
    );
    var tools = [
      ...host.build(),
      ...buildPromptingTools(turn.promptingVersion!),
    ];
    if (diagnostic) {
      final nonce = _id('probe');
      tools = [
        AgentTool(
          name: 'diagnostic_echo',
          label: '工具诊断',
          description: '调用本工具回显提供的 value，再根据工具结果完成回答。',
          parameters: schema(
            {
              'value': {
                'type': 'string',
                'enum': [nonce],
              },
            },
            required: ['value'],
          ),
          prepare: (args, cancel) async => PreparedAgentTool(
            summary: '结构化调用与结果回传',
            execute: () async => {'value': args['value'], 'received': true},
          ),
        ),
      ];
    }
    final context = <Map<String, dynamic>>[
      {
        'role': 'system',
        'content':
            assistantSystemPrompt(state.systemPrompt) +
            (diagnostic
                ? ''
                : '\n${promptingInstructions(turn.promptingVersion!)}\n'
                      '只提供可审阅提案时可输出单一 JSON 代码块，字段 positive、negative、characters（最多6个对象，各含positive/negative）及reason。'
                      '不包含未建议修改的字段。文本提案不会自动执行，须用户在界面确认。'),
      },
    ];
    final history = target.turns
        .where((t) => !identical(t, turn) && t.status == 'complete')
        .toList();
    for (final old in history.skip(
      (history.length - state.contextTurns).clamp(0, history.length),
    )) {
      final observation = replayImageObservations(old.traces);
      context.add({
        'role': 'user',
        'content':
            old.userText + (observation.isEmpty ? '' : '\n\n$observation'),
      });
      context.addAll(
        old.messages.map((message) {
          final copy = Map<String, dynamic>.from(message);
          if (old.providerContext != provider.contextKey) {
            copy.remove('reasoning_content');
          }
          return copy;
        }),
      );
    }
    try {
      // Persist the submitted user turn before contacting any service.
      await workbench.flush();
      token.check();
      var content = turn.userText;
      if (turn.attachments.isNotEmpty) {
        final observations = await analyzeAssistantImages(
          refs: List.unmodifiable(turn.attachments),
          userText: turn.userText,
          assets: workbench.assets!,
          vision: vision,
          transport: transport,
          settings: wdSettings,
          client: wdTaggerClient,
          cancellation: token,
          onStatus: (message) {
            status = message;
            changed();
          },
          onTrace: (trace) {
            final id = '${turn.id}-${trace['callId']}';
            final entry = {...trace, 'callId': id};
            final index = turn.traces.indexWhere((t) => t['callId'] == id);
            if (index < 0) {
              turn.traces.add(entry);
            } else {
              turn.traces[index] = entry;
            }
            changed();
          },
        );
        content += '\n\n$observations';
      }
      context.add({'role': 'user', 'content': content});
      if (jsonEncode(context).length > 300000) {
        throw const AgentException('上下文过长，请减少上下文轮数或新建会话。');
      }
      await AgentEngine(transport: transport, tools: tools).run(
        provider: provider,
        context: context,
        cancellation: token,
        enableTools: agent || diagnostic,
        requireFirstTool: requireTool || diagnostic,
        onRound: (round) {
          status = 'Agent 第 $round / 16 轮';
          turn.liveText = '';
          changed();
        },
        onText: (text) {
          if (!token.isCancelled) {
            turn.liveText = text;
            if (!_disposed) notifyListeners();
          }
        },
        onMessage: (message) {
          turn.messages.add(message);
          turn.liveText = '';
          changed();
        },
        onTrace: (trace) {
          final i = turn.traces.indexWhere(
            (t) => t['callId'] == trace['callId'],
          );
          if (i < 0) {
            turn.traces.add(trace);
          } else {
            turn.traces[i] = trace;
          }
          changed();
        },
        confirm: (call, plan) async =>
            await _interact(
              AssistantInteraction(title: plan.summary, preview: plan.preview),
              token,
            ) ==
            'approve',
      );
      token.check();
      turn.status = 'complete';
      if (!diagnostic) turn.proposalDraftFingerprint = host.draftFingerprint;
      final count = turn.traces
          .where(
            (t) =>
                t['status'] == 'completed' &&
                !const {'vision', 'wd_tagger'}.contains(t['name']),
          )
          .length;
      status = diagnostic
          ? '工具诊断通过：结构化调用 → 本地执行 → 结果回传 → 模型回复。'
          : count == 0
          ? '回复完成 · 本轮未调用工具'
          : '回复完成 · 成功执行 $count 次工具';
      if (turn.traces.any(
        (t) =>
            const {'vision', 'wd_tagger'}.contains(t['name']) &&
            t['status'] == 'failed',
      )) {
        status += ' · 部分附图分析失败，已使用可用结果（详见记录）';
      }
    } on AgentCancelled {
      turn.status = 'cancelled';
      turn.error = '已停止。已经完成的操作保留，未自动重发。';
      status = turn.error;
    } on AgentException catch (error) {
      turn.status = 'failed';
      turn.error = error.message;
      status = error.message;
    } catch (_) {
      turn.status = 'failed';
      turn.error = '助手请求失败；请检查连接配置、图片或本地存储。未自动重试。';
      status = turn.error;
    } finally {
      turn.liveText = '';
      interaction = null;
      if (identical(_token, token)) {
        _token = null;
        runningSessionId = null;
      }
      changed();
      try {
        await workbench.flush();
      } catch (_) {
        status = '助手记录尚未保存，请检查工作区保存状态。';
        if (!_disposed) notifyListeners();
      }
    }
  }

  void cancel() {
    _token?.cancel();
    answer(null);
  }

  Future<void> settle() async {
    cancel();
    await _active;
  }

  @override
  void dispose() {
    if (_disposed) return;
    cancel();
    _disposed = true;
    super.dispose();
  }
}

extension _AssistantTextLimit on String {
  String take(int n) => substring(0, length.clamp(0, n));
}

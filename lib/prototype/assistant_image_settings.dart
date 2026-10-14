import 'package:flutter/material.dart';

import '../assistant/agent_contract.dart';
import '../assistant/assistant_controller.dart';
import '../assistant/wd_tagger.dart';

Future<void> showWdTaggerSettingsDialog(
  BuildContext context,
  AssistantController controller,
) => showDialog<void>(
  context: context,
  builder: (_) => _WdTaggerSettingsDialog(controller: controller),
);

class _WdTaggerSettingsDialog extends StatefulWidget {
  const _WdTaggerSettingsDialog({required this.controller});

  final AssistantController controller;

  @override
  State<_WdTaggerSettingsDialog> createState() =>
      _WdTaggerSettingsDialogState();
}

class _WdTaggerSettingsDialogState extends State<_WdTaggerSettingsDialog> {
  final formKey = GlobalKey<FormState>();
  late final initial = widget.controller.state.wdTagger;
  late final baseUrl = TextEditingController(text: initial.baseUrl);
  late final generalThreshold = TextEditingController(
    text: initial.generalThreshold.toString(),
  );
  late final characterThreshold = TextEditingController(
    text: initial.characterThreshold.toString(),
  );
  late bool enabled = initial.enabled;
  late String model = initial.model;
  late bool generalMcut = initial.generalMcut;
  late bool characterMcut = initial.characterMcut;
  bool saving = false;
  String error = '';

  @override
  void dispose() {
    baseUrl.dispose();
    generalThreshold.dispose();
    characterThreshold.dispose();
    super.dispose();
  }

  String? _thresholdError(String? input) {
    final value = double.tryParse(input?.trim() ?? '');
    if (value == null || !value.isFinite || value < 0 || value > 1) {
      return '请输入 0 到 1 之间的数值。';
    }
    return null;
  }

  Future<void> _save() async {
    if (!formKey.currentState!.validate()) return;
    setState(() {
      saving = true;
      error = '';
    });
    var applied = false;
    try {
      final settings = WdTaggerSettings(
        enabled: enabled,
        baseUrl: baseUrl.text.trim(),
        model: model,
        generalThreshold: double.parse(generalThreshold.text.trim()),
        characterThreshold: double.parse(characterThreshold.text.trim()),
        generalMcut: generalMcut,
        characterMcut: characterMcut,
      );
      settings.validate();
      widget.controller.updateWdTaggerSettings(settings);
      applied = true;
      await widget.controller.workbench.flush(retry: true);
      if (mounted) Navigator.of(context).pop();
    } catch (e) {
      if (mounted) {
        setState(() {
          if (applied) {
            error = '本次运行已生效，但未保存到本地；请检查磁盘空间或目录权限后重试。';
          } else if (e is AgentException) {
            error = e.message;
          } else if (e is FormatException) {
            error = e.message.toString();
          } else {
            error = '保存失败，请检查设置或本地保存状态。';
          }
        });
      }
    } finally {
      if (mounted) setState(() => saving = false);
    }
  }

  @override
  Widget build(BuildContext context) => PopScope(
    canPop: !saving,
    child: Dialog(
      key: const ValueKey('wd-tagger-settings-dialog'),
      insetPadding: const EdgeInsets.all(20),
      child: LayoutBuilder(
        builder: (context, constraints) => SizedBox(
          width: 620,
          height: constraints.maxHeight * .9,
          child: Column(
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(24, 20, 16, 12),
                child: Row(
                  children: [
                    const Expanded(
                      child: Text(
                        'WD-Tagger 图片识别',
                        style: TextStyle(
                          fontSize: 20,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                    IconButton(
                      tooltip: '关闭',
                      onPressed: saving ? null : () => Navigator.pop(context),
                      icon: const Icon(Icons.close),
                    ),
                  ],
                ),
              ),
              const Divider(height: 1),
              Expanded(
                child: Form(
                  key: formKey,
                  child: SingleChildScrollView(
                    padding: const EdgeInsets.fromLTRB(24, 16, 24, 20),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        SwitchListTile(
                          key: const ValueKey('wd-tagger-enabled'),
                          contentPadding: EdgeInsets.zero,
                          title: const Text('启用 WD-Tagger'),
                          subtitle: const Text('默认关闭；开启后，发送附图时执行图片识别。'),
                          value: enabled,
                          onChanged: saving
                              ? null
                              : (value) => setState(() => enabled = value),
                        ),
                        const SizedBox(height: 8),
                        Container(
                          padding: const EdgeInsets.all(12),
                          decoration: BoxDecoration(
                            color: Theme.of(context)
                                .colorScheme
                                .surfaceContainerLow,
                            borderRadius: BorderRadius.circular(8),
                          ),
                          child: const Text(
                            '启用后，发送附图会将图片上传到此处配置的 WD-Tagger 外部识别服务，不使用小助手的 LLM 凭据。WD-Tagger 可以单独使用；若已配置识图模型，同一张附图会由两种方式协作分析。',
                          ),
                        ),
                        const SizedBox(height: 18),
                        TextFormField(
                          key: const ValueKey('wd-tagger-base-url'),
                          controller: baseUrl,
                          enabled: !saving,
                          keyboardType: TextInputType.url,
                          autocorrect: false,
                          decoration: const InputDecoration(
                            labelText: 'WD-Tagger 服务 URL',
                            helperText: '附图会发送到这个服务地址。',
                            border: OutlineInputBorder(),
                          ),
                          validator: (value) =>
                              value == null || value.trim().isEmpty
                              ? '请输入服务 URL。'
                              : null,
                        ),
                        const SizedBox(height: 14),
                        DropdownButtonFormField<String>(
                          key: ValueKey('wd-tagger-model-$model'),
                          initialValue: model,
                          isExpanded: true,
                          decoration: const InputDecoration(
                            labelText: '识别模型',
                            border: OutlineInputBorder(),
                          ),
                          items: [
                            for (final entry in WdTaggerSettings.models.entries)
                              DropdownMenuItem(
                                value: entry.key,
                                child: Text(
                                  entry.value,
                                  overflow: TextOverflow.ellipsis,
                                ),
                              ),
                          ],
                          onChanged: saving
                              ? null
                              : (value) {
                                  if (value != null) {
                                    setState(() => model = value);
                                  }
                                },
                        ),
                        const SizedBox(height: 20),
                        Text(
                          '一般标签',
                          style: Theme.of(context).textTheme.titleSmall,
                        ),
                        const SizedBox(height: 8),
                        TextFormField(
                          key: const ValueKey('wd-tagger-general-threshold'),
                          controller: generalThreshold,
                          enabled: !saving,
                          keyboardType: const TextInputType.numberWithOptions(
                            decimal: true,
                          ),
                          decoration: const InputDecoration(
                            labelText: '阈值',
                            helperText: '范围 0–1。',
                            border: OutlineInputBorder(),
                          ),
                          validator: _thresholdError,
                        ),
                        SwitchListTile(
                          key: const ValueKey('wd-tagger-general-mcut'),
                          contentPadding: EdgeInsets.zero,
                          title: const Text('一般标签使用 MCut'),
                          subtitle: const Text('按当前图片估算一般标签阈值。'),
                          value: generalMcut,
                          onChanged: saving
                              ? null
                              : (value) => setState(() => generalMcut = value),
                        ),
                        const SizedBox(height: 8),
                        Text(
                          '角色标签',
                          style: Theme.of(context).textTheme.titleSmall,
                        ),
                        const SizedBox(height: 8),
                        TextFormField(
                          key: const ValueKey('wd-tagger-character-threshold'),
                          controller: characterThreshold,
                          enabled: !saving,
                          keyboardType: const TextInputType.numberWithOptions(
                            decimal: true,
                          ),
                          decoration: const InputDecoration(
                            labelText: '阈值',
                            helperText: '范围 0–1。',
                            border: OutlineInputBorder(),
                          ),
                          validator: _thresholdError,
                        ),
                        SwitchListTile(
                          key: const ValueKey('wd-tagger-character-mcut'),
                          contentPadding: EdgeInsets.zero,
                          title: const Text('角色标签使用 MCut'),
                          subtitle: const Text('按当前图片估算角色标签阈值。'),
                          value: characterMcut,
                          onChanged: saving
                              ? null
                              : (value) =>
                                    setState(() => characterMcut = value),
                        ),
                        if (error.isNotEmpty) ...[
                          const SizedBox(height: 8),
                          Text(
                            error,
                            key: const ValueKey('wd-tagger-error'),
                            style: TextStyle(
                              color: Theme.of(context).colorScheme.error,
                            ),
                          ),
                        ],
                      ],
                    ),
                  ),
                ),
              ),
              const Divider(height: 1),
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 10, 20, 12),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.end,
                  children: [
                    TextButton(
                      onPressed: saving ? null : () => Navigator.pop(context),
                      child: const Text('取消'),
                    ),
                    const SizedBox(width: 8),
                    FilledButton(
                      key: const ValueKey('wd-tagger-save'),
                      onPressed: saving ? null : _save,
                      child: Text(saving ? '保存中…' : '保存设置'),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    ),
  );
}

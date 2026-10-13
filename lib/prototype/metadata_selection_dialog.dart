import 'dart:convert';

import 'package:flutter/material.dart';

import '../metadata/image_metadata_parser.dart';

const metadataFieldLabels = <String, String>{
  'prompt': '正向提示词',
  'negative_prompt': '负向提示词',
  'model': '模型',
  'width': '请求宽度',
  'height': '请求高度',
  'seed': 'Seed',
  'steps': '步数',
  'scale': 'CFG',
  'cfg_rescale': 'CFG Rescale',
  'sampler': '采样器',
  'noise_schedule': '噪声调度',
  'use_coords': '角色位置控制',
  'characters': '多角色提示词与位置',
  'vibe_references': 'Vibe 编码参考',
};

class MetadataSelectionDialog extends StatefulWidget {
  const MetadataSelectionDialog({super.key, required this.metadata});
  final ImageMetadataResult metadata;
  @override
  State<MetadataSelectionDialog> createState() =>
      _MetadataSelectionDialogState();
}

class _MetadataSelectionDialogState extends State<MetadataSelectionDialog> {
  late final selected = widget.metadata.fields.keys.toSet()
    ..remove('vibe_references');
  @override
  Widget build(BuildContext context) => AlertDialog(
    title: const Text('选择回填参数'),
    content: SizedBox(
      width: 620,
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              '${switch (widget.metadata.source) {
                'png-text' => 'PNG 文本参数',
                'stealth-alpha' => 'PNG 隐写参数',
                'stealth-rgb' => 'PNG 隐写参数',
                null => '图片参数',
                final source => source,
              }} · ${widget.metadata.fields.length} 项可用参数',
            ),
            const SizedBox(height: 8),
            const Text('只应用勾选且有效的字段。图片没有记录的参数保留当前值；原图不会被改写。'),
            for (final warning in widget.metadata.warnings)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  warning,
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ),
            if (widget.metadata.fields.isEmpty)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 24),
                child: Text('未找到可用的生成参数。仍可将这张图片作为参考图使用。'),
              ),
            for (final entry in widget.metadata.fields.entries)
              if (metadataFieldLabels.containsKey(entry.key))
                CheckboxListTile(
                  contentPadding: EdgeInsets.zero,
                  controlAffinity: ListTileControlAffinity.leading,
                  title: Text(metadataFieldLabels[entry.key]!),
                  subtitle: Text(
                    _summary(entry.key, entry.value),
                    maxLines: 4,
                    overflow: TextOverflow.ellipsis,
                  ),
                  value: selected.contains(entry.key),
                  onChanged: (value) => setState(() {
                    value == true
                        ? selected.add(entry.key)
                        : selected.remove(entry.key);
                  }),
                ),
            if (widget.metadata.fields.containsKey('vibe_references'))
              const Text('图片中的 Vibe 编码来源未验证。回填后需在编码库确认适用模型和渠道，再用于生成。'),
          ],
        ),
      ),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('取消'),
      ),
      TextButton(
        onPressed: () => setState(() => selected.clear()),
        child: const Text('全不选'),
      ),
      FilledButton(
        onPressed: selected.isEmpty
            ? null
            : () => Navigator.pop(context, selected),
        child: const Text('应用所选参数'),
      ),
    ],
  );

  String _summary(String key, dynamic value) {
    if (key == 'vibe_references' && value is List) {
      if (value.isEmpty) return '明确为空；应用后清空当前 Vibe 参考';
      return '${value.length} 个编码参考（不展示编码正文）';
    }
    if (key == 'characters' && value is List) {
      if (value.isEmpty) return '明确为空；应用后清空当前角色提示词与位置';
      return value
          .map(
            (v) => v is Map
                ? '${v['prompt'] ?? ''}\n负向：${v['negative_prompt'] ?? ''} · 位置 ${v['center_x'] ?? '自动'}, ${v['center_y'] ?? '自动'}'
                : '',
          )
          .join('\n');
    }
    if (value == null) return '随机';
    if (value == '') return '空文本';
    final text = value is String ? value : jsonEncode(value);
    return text.length > 800 ? '${text.substring(0, 800)}…' : text;
  }
}

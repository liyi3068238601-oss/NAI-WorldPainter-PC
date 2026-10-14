import 'package:flutter/material.dart';

import '../prompts/prompt_capsules.dart';
import '../prompts/prompt_library.dart';

Future<String?> pickAssistantMaterial(
  BuildContext context,
  PromptLibrary library,
) => showDialog<String>(
  context: context,
  builder: (_) => _MaterialPicker(library),
);

class _MaterialPicker extends StatefulWidget {
  const _MaterialPicker(this.library);
  final PromptLibrary library;
  @override
  State<_MaterialPicker> createState() => _MaterialPickerState();
}

class _MaterialPickerState extends State<_MaterialPicker> {
  final search = TextEditingController();
  late final capsules = loadPromptCapsules();
  String category = '风格';
  @override
  void dispose() {
    search.dispose();
    super.dispose();
  }

  List<({String title, String preview, String value})> rows(
    List<PromptCapsule> all,
  ) {
    final query = search.text.trim().toLowerCase();
    if (category == '风格') {
      return [
        for (final style in widget.library.styles)
          if (query.isEmpty ||
              '${style.name} ${style.category} ${style.prompt} ${style.negative}'
                  .toLowerCase()
                  .contains(query))
            (
              title: style.name,
              preview: '${style.prompt}\n负向：${style.negative}',
              value:
                  '[本地风格参考：${style.name}]\n正向：${style.prompt}\n负向：${style.negative}',
            ),
      ];
    }
    if (category == '画师') {
      return [
        for (final artist in widget.library.artists)
          if (query.isEmpty ||
              '${artist.name} ${artist.prompt} ${artist.categories.join(' ')}'
                  .toLowerCase()
                  .contains(query))
            (
              title: artist.name,
              preview: artist.prompt,
              value:
                  '[本地画师参考：${artist.name}]\n${widget.library.composeArtistPrompt({artist.id: artist.defaultWeight})}',
            ),
      ];
    }
    return [
      for (final capsule in queryPromptCapsules(all, search: query).take(100))
        (
          title: '${capsule.zh} · ${capsule.negative ? '负向' : '正向'}',
          preview: capsule.promptText,
          value:
              '[${capsule.negative ? '负向' : '正向'}胶囊参考：${capsule.zh}]\n${capsule.promptText}',
        ),
    ];
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: const Text('插入素材到聊天'),
    content: SizedBox(
      width: 660,
      height: 480,
      child: Column(
        children: [
          const Text('插入后仍可编辑，点击发送才会交给模型；不会直接改动创作词框。'),
          const SizedBox(height: 10),
          Wrap(
            spacing: 8,
            children: [
              for (final label in ['风格', '画师', '胶囊'])
                ChoiceChip(
                  label: Text(label),
                  selected: category == label,
                  onSelected: (_) => setState(() => category = label),
                ),
            ],
          ),
          TextField(
            controller: search,
            decoration: const InputDecoration(labelText: '搜索本地素材'),
            onChanged: (_) => setState(() {}),
          ),
          const SizedBox(height: 10),
          Expanded(
            child: FutureBuilder<List<PromptCapsule>>(
              future: capsules,
              builder: (context, snapshot) {
                if (category == '胶囊' &&
                    snapshot.connectionState != ConnectionState.done) {
                  return const Center(child: CircularProgressIndicator());
                }
                if (category == '胶囊' && snapshot.hasError) {
                  return const Center(child: Text('胶囊加载失败，请关闭后重试。'));
                }
                final entries = rows(snapshot.data ?? []);
                if (entries.isEmpty) {
                  return const Center(child: Text('没有匹配素材。可在提示词素材页添加风格或画师。'));
                }
                return ListView.builder(
                  itemCount: entries.length,
                  itemBuilder: (context, index) {
                    final entry = entries[index];
                    return ListTile(
                      title: Text(entry.title),
                      subtitle: Text(
                        entry.preview,
                        maxLines: 3,
                        overflow: TextOverflow.ellipsis,
                      ),
                      trailing: const Icon(Icons.add_comment_outlined),
                      onTap: () => Navigator.pop(context, entry.value),
                    );
                  },
                );
              },
            ),
          ),
          if (category == '胶囊') const Text('最多显示 100 条匹配结果，请输入关键词缩小范围。'),
        ],
      ),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('取消'),
      ),
    ],
  );
}

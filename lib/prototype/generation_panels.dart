part of 'workbench.dart';

extension _GenerationPanels on _WorkbenchState {
  Widget _art(SceneResult result) => result.assetRef != null && c.assets != null
      ? StoredImage(store: c.assets!, assetRef: result.assetRef!)
      : SceneArt(variant: result.variant);

  Future<void> _connect() async {
    final next = await showConnectionDialog(
      context,
      connection: c.connection,
      vault: c.vault!,
    );
    if (next != null && mounted) {
      c.updateConnection(next);
      _message('接入配置已保存');
    }
  }

  Future<void> _submit() async {
    if (c.generating) return;
    if (scaffold.currentContext != null &&
        !Form.of(scaffold.currentContext!).validate()) {
      _message('请先修正标出的参数。');
      return;
    }
    if (c.liveGeneration && editing != null) {
      await _submitEditedGeneration();
      return;
    }
    await c.generate();
    if (mounted && c.liveGeneration) _message(c.status);
  }

  Future<String?> _importImage({bool select = false}) async {
    try {
      final bytes = await pickImage();
      if (bytes == null || c.assets == null) return null;
      final asset = await c.assets!.save(bytes);
      if (!mounted || c.closing) return null;
      if (select) c.addImported(asset);
      return asset.assetRef;
    } catch (_) {
      if (mounted) _message('图片读取失败，请选择有效的 PNG、JPEG 或 WebP（不超过 30 MB）。');
      return null;
    }
  }

  Widget _number(
    String label,
    num value,
    void Function(num) update, {
    num min = 0,
    num max = 100,
    bool integer = false,
  }) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: ParameterNumberField(
      key: ValueKey('$label:${c.selected.id}:${c.refillRevision}'),
      label: label,
      value: value,
      min: min,
      max: max,
      integer: integer,
      onChanged: update,
    ),
  );

  Widget _advancedParameters() {
    final p = c.parameters;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        TextFormField(
          key: ValueKey('custom-model-${c.refillRevision}-${c.provider}'),
          controller: modelId,
          decoration: const InputDecoration(labelText: '模型 ID · 网关可按其文档填写'),
          style: const TextStyle(fontSize: 12),
          validator: (v) => v == null || v.trim().isEmpty ? '模型 ID 不能为空' : null,
          onChanged: (v) => c.updateModel(v.trim()),
        ),
        const SizedBox(height: 14),
        _dropdown(
          '采样器',
          p.sampler,
          {
            'k_euler',
            'k_euler_ancestral',
            'k_dpm_2',
            'k_dpm_2_ancestral',
            'k_dpmpp_2m',
            'k_dpmpp_2m_sde',
            'k_dpmpp_2s_ancestral',
            'k_dpmpp_sde',
            'ddim',
            'ddim_v3',
            p.sampler,
          }.toList(),
          (v) => c.updateAdvanced(p.copyWith(sampler: v)),
        ),
        const SizedBox(height: 14),
        _dropdown('噪声调度', p.noiseSchedule, [
          'native',
          'karras',
          'exponential',
          'polyexponential',
        ], (v) => c.updateAdvanced(p.copyWith(noiseSchedule: v))),
        const SizedBox(height: 14),
        _number(
          'CFG Rescale',
          p.cfgRescale,
          (v) =>
              c.updateAdvanced(c.parameters.copyWith(cfgRescale: v.toDouble())),
          max: 1,
        ),
        Row(
          children: [
            Expanded(
              child: _number(
                '宽度 · 64 的倍数',
                c.width,
                (v) => c.setSize(v.toInt(), c.height),
                min: 64,
                max: 1920,
                integer: true,
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: _number(
                '高度 · 64 的倍数',
                c.height,
                (v) => c.setSize(c.width, v.toInt()),
                min: 64,
                max: 1920,
                integer: true,
              ),
            ),
          ],
        ),
        _number(
          '批量张数 · 逐张提交',
          c.batchCount,
          (v) => c.updateBatch(v.toInt()),
          min: 1,
          max: 30,
          integer: true,
        ),
        _muted('提交后修改只影响下一批。固定种子用于首张，其余图片使用随机种子。尺寸、采样器和参考组合会在提交前按渠道校验。'),
      ],
    );
  }

  Widget _liveCharacters() {
    final p = c.parameters;
    void update(int index, GenerationCharacter value) {
      final list = [...c.parameters.characters];
      list[index] = value;
      c.updateAdvanced(c.parameters.copyWith(characters: list));
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          title: const Text('使用角色坐标', style: TextStyle(fontSize: 12)),
          value: p.useCoords,
          onChanged: (v) => c.updateAdvanced(p.copyWith(useCoords: v)),
        ),
        for (var i = 0; i < p.characters.length; i++) ...[
          Row(
            children: [
              Expanded(
                child: Text(
                  '角色 ${i + 1}',
                  style: const TextStyle(fontWeight: FontWeight.w600),
                ),
              ),
              Switch(
                value: p.characters[i].enabled,
                onChanged: (v) =>
                    update(i, p.characters[i].copyWith(enabled: v)),
              ),
              _icon(
                Icons.arrow_upward,
                '上移角色 ${i + 1}',
                i == 0 ? null : () => c.moveCharacter(i, -1),
              ),
              _icon(
                Icons.arrow_downward,
                '下移角色 ${i + 1}',
                i == p.characters.length - 1
                    ? null
                    : () => c.moveCharacter(i, 1),
              ),
              _icon(Icons.close, '删除角色 ${i + 1}', () {
                final list = [...c.parameters.characters]..removeAt(i);
                c.updateAdvanced(c.parameters.copyWith(characters: list));
              }),
            ],
          ),
          TextFormField(
            key: ValueKey(
              'character-$i-${c.selected.id}-${p.characters.length}-${c.refillRevision}',
            ),
            initialValue: p.characters[i].prompt,
            minLines: 2,
            maxLines: 5,
            enabled: p.characters[i].enabled,
            decoration: const InputDecoration(labelText: '角色描述'),
            onChanged: (v) =>
                update(i, c.parameters.characters[i].copyWith(prompt: v)),
          ),
          const SizedBox(height: 10),
          TextFormField(
            key: ValueKey(
              'character-uc-$i-${c.selected.id}-${p.characters.length}-${c.refillRevision}',
            ),
            initialValue: p.characters[i].negativePrompt,
            minLines: 1,
            maxLines: 3,
            enabled: p.characters[i].enabled,
            decoration: const InputDecoration(labelText: '角色负向提示词'),
            onChanged: (v) => update(
              i,
              c.parameters.characters[i].copyWith(negativePrompt: v),
            ),
          ),
          const SizedBox(height: 10),
          if (p.useCoords)
            TextButton(
              onPressed: () =>
                  update(i, p.characters[i].copyWith(clearCenter: true)),
              child: Text(
                p.characters[i].centerX == null ? '自动位置 · 已选择' : '使用自动位置',
              ),
            ),
          if (p.useCoords)
            Wrap(
              spacing: 4,
              runSpacing: 4,
              children: [
                for (var y = 0; y < 5; y++)
                  for (var x = 0; x < 5; x++)
                    SizedBox(
                      width: 54,
                      height: 30,
                      child: OutlinedButton(
                        style: OutlinedButton.styleFrom(
                          padding: EdgeInsets.zero,
                          backgroundColor:
                              p.characters[i].centerX == (x + .5) / 5 &&
                                  p.characters[i].centerY == (y + .5) / 5
                              ? colors.primary.withValues(alpha: .15)
                              : null,
                        ),
                        onPressed: () => update(
                          i,
                          p.characters[i].copyWith(
                            centerX: (x + .5) / 5,
                            centerY: (y + .5) / 5,
                          ),
                        ),
                        child: Text(
                          '${String.fromCharCode(65 + x)}${y + 1}',
                          style: const TextStyle(fontSize: 10),
                        ),
                      ),
                    ),
              ],
            ),
          for (var j = 0; j < p.characters[i].referenceImages.length; j++) ...[
            _assetRow(
              p.characters[i].referenceImages[j].assetId,
              '角色参考 ${j + 1}',
              () {
                final refs = [...c.parameters.characters[i].referenceImages]
                  ..removeAt(j);
                update(
                  i,
                  c.parameters.characters[i].copyWith(referenceImages: refs),
                );
              },
            ),
            _number(
              '角色 ${i + 1} 参考 ${j + 1} 强度',
              p.characters[i].referenceImages[j].strength,
              (v) {
                final refs = [...c.parameters.characters[i].referenceImages];
                refs[j] = GenerationCharacterReference(
                  assetId: refs[j].assetId,
                  strength: v.toDouble(),
                );
                update(
                  i,
                  c.parameters.characters[i].copyWith(referenceImages: refs),
                );
              },
              max: 1,
            ),
          ],
          TextButton.icon(
            onPressed: () async {
              final ref = await _importImage();
              if (ref == null) return;
              update(
                i,
                c.parameters.characters[i].copyWith(
                  referenceImages: [
                    ...c.parameters.characters[i].referenceImages,
                    GenerationCharacterReference(assetId: ref),
                  ],
                ),
              );
            },
            icon: const Icon(Icons.add_photo_alternate_outlined, size: 16),
            label: const Text('添加角色参考'),
          ),
          const Divider(),
          const SizedBox(height: 12),
        ],
        OutlinedButton.icon(
          onPressed: p.characters.length >= 6
              ? null
              : () => c.updateAdvanced(
                  p.copyWith(
                    characters: [
                      ...p.characters,
                      GenerationCharacter(prompt: '', centerX: .5, centerY: .5),
                    ],
                  ),
                ),
          icon: const Icon(Icons.add, size: 16),
          label: const Text('添加角色'),
        ),
        const SizedBox(height: 10),
        _muted('关闭角色会保留内容。参考组合以渠道能力为准，不支持时会阻止提交。'),
      ],
    );
  }

  Widget _assetRow(String ref, String label, VoidCallback remove) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 8),
    child: Row(
      children: [
        SizedBox(
          width: 52,
          height: 52,
          child: StoredImage(store: c.assets!, assetRef: ref),
        ),
        const SizedBox(width: 10),
        Expanded(child: Text(label, style: const TextStyle(fontSize: 11))),
        _icon(Icons.close, '移除$label', remove),
      ],
    ),
  );

  Widget _liveReferences() {
    final p = c.parameters;
    final modes = {
      '文生图': GenerationOperation.textToImage,
      '图生图': GenerationOperation.imageToImage,
      '局部重绘': GenerationOperation.inpaint,
    };
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _dropdown(
          '生成方式',
          modes.entries.firstWhere((e) => e.value == p.operation).key,
          modes.keys.toList(),
          (v) => c.updateAdvanced(p.copyWith(operation: modes[v])),
        ),
        const SizedBox(height: 12),
        if (p.operation != GenerationOperation.textToImage) ...[
          _editingSourceControls(),
          const SizedBox(height: 12),
          _number(
            '重绘强度',
            p.operation == GenerationOperation.inpaint
                ? p.inpaintStrength ?? .7
                : p.img2imgStrength ?? .7,
            (v) => c.updateAdvanced(
              c.parameters.copyWith(
                inpaintStrength: v.toDouble(),
                img2imgStrength: v.toDouble(),
              ),
            ),
            min: .01,
            max: 1,
          ),
        ],
        if (p.operation == GenerationOperation.inpaint) ...[
          _editingMaskControls(),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('不保留原图', style: TextStyle(fontSize: 12)),
            value: p.disabledOriginalImage,
            onChanged: (v) =>
                c.updateAdvanced(p.copyWith(disabledOriginalImage: v)),
          ),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('色彩校正', style: TextStyle(fontSize: 12)),
            value: p.colorCorrect,
            onChanged: (v) => c.updateAdvanced(p.copyWith(colorCorrect: v)),
          ),
        ],
        const SizedBox(height: 18),
        _label('Vibe 风格参考'),
        for (var i = 0; i < p.vibeReferences.length; i++) ...[
          _assetRow(p.vibeReferences[i].assetId, 'Vibe ${i + 1}', () {
            final refs = [...c.parameters.vibeReferences]..removeAt(i);
            c.updateAdvanced(c.parameters.copyWith(vibeReferences: refs));
          }),
          _number('Vibe ${i + 1} 强度', p.vibeReferences[i].strength, (v) {
            final refs = [...c.parameters.vibeReferences];
            refs[i] = refs[i].copyWith(strength: v.toDouble());
            c.updateAdvanced(c.parameters.copyWith(vibeReferences: refs));
          }, max: 1),
          _number(
            'Vibe ${i + 1} 信息提取',
            p.vibeReferences[i].informationExtracted,
            (v) {
              final refs = [...c.parameters.vibeReferences];
              refs[i] = refs[i].copyWith(
                informationExtracted: v.toDouble(),
                clearEncodedVibe: true,
              );
              c.updateAdvanced(c.parameters.copyWith(vibeReferences: refs));
            },
            max: 1,
          ),
        ],
        OutlinedButton.icon(
          onPressed: () async {
            final ref = await _importImage();
            if (ref != null) {
              c.updateAdvanced(
                c.parameters.copyWith(
                  vibeReferences: [
                    ...c.parameters.vibeReferences,
                    VibeReference(assetId: ref),
                  ],
                ),
              );
            }
          },
          icon: const Icon(Icons.add, size: 16),
          label: const Text('添加 Vibe'),
        ),
        const SizedBox(height: 18),
        _label('精准参考'),
        for (var i = 0; i < p.preciseReferences.length; i++) ...[
          _assetRow(p.preciseReferences[i].assetId, '精准参考 ${i + 1}', () {
            final refs = [...c.parameters.preciseReferences]..removeAt(i);
            c.updateAdvanced(c.parameters.copyWith(preciseReferences: refs));
          }),
          _dropdown(
            '参考 ${i + 1} 类型',
            p.preciseReferences[i].referenceType,
            ['character', 'style', 'character&style'],
            (v) {
              final refs = [...c.parameters.preciseReferences];
              refs[i] = refs[i].copyWith(referenceType: v);
              c.updateAdvanced(c.parameters.copyWith(preciseReferences: refs));
            },
          ),
          const SizedBox(height: 12),
          _number('参考 ${i + 1} 强度', p.preciseReferences[i].strength, (v) {
            final refs = [...c.parameters.preciseReferences];
            refs[i] = refs[i].copyWith(strength: v.toDouble());
            c.updateAdvanced(c.parameters.copyWith(preciseReferences: refs));
          }, max: 1),
        ],
        OutlinedButton.icon(
          onPressed: () async {
            final ref = await _importImage();
            if (ref != null) {
              c.updateAdvanced(
                c.parameters.copyWith(
                  preciseReferences: [
                    ...c.parameters.preciseReferences,
                    PreciseReference(assetId: ref),
                  ],
                ),
              );
            }
          },
          icon: const Icon(Icons.add, size: 16),
          label: const Text('添加精准参考'),
        ),
      ],
    );
  }
}

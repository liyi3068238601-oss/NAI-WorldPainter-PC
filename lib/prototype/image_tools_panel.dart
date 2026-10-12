part of 'workbench.dart';

const _imageToolNames = {
  'tiled': '分块高清图生图',
  'director': '导演工具',
  'enhance': 'Enhance 重绘增强',
  'upscale': '官方超分',
  'localSr': '本地超分',
};
const _directorNames = {
  'declutter': '去杂物',
  'bg_removal': '背景移除',
  'lineart': '线稿提取',
  'sketch': '草图化',
  'colorize': '线稿上色',
  'emotion': '情感迁移',
};
const _srNames = {
  'realesrganAnime4x': 'Real-ESRGAN 动漫 4×',
  'realcuganConservative2x': 'RealCUGAN 保守 2×',
  'realcuganConservative4x': 'RealCUGAN 保守 4×',
};

extension _ImageToolsPanel on _WorkbenchState {
  Map<String, Object?> get _tools => {
    'version': 1,
    'mode': 'tiled',
    'strength': 0.3,
    'protocol': c.connection.protocol,
    ...c.imageTools,
  };
  String get _toolMode => _tools['mode'] as String;
  String get _toolProviderLabel => _toolMode == 'localSr'
      ? '本地超分'
      : ServiceConnection.labels[const [
                  'enhance',
                  'upscale',
                ].contains(_toolMode)
                ? 'official'
                : _tools['protocol']] ??
            '未选择渠道';

  void _updateTools(Map<String, Object?> fields) =>
      c.updateImageTools({..._tools, ...fields});

  void _changeToolMode(String mode) {
    if (c.generating || mode == _toolMode) return;
    final draft = {..._tools, 'mode': mode, 'active': true};
    draft.remove('postprocess');
    c.updateImageTools(draft);
  }

  PostprocessParameters _toolSpec() {
    final mode = _toolMode;
    final settings = (_tools['settings'] as Map?)?[mode] as Map?;
    final defaults = switch (mode) {
      'director' => <String, Object?>{
        'operation': 'director',
        'model': c.parameters.model,
        'director_tool': 'declutter',
      },
      'enhance' => <String, Object?>{
        'operation': 'enhance',
        'model':
            PostprocessParameters.officialEnhanceModels.contains(
              c.parameters.model,
            )
            ? c.parameters.model
            : 'nai-diffusion-4-5-full',
        'prompt': c.prompt,
        'negative_prompt': c.negative,
        'strength': 0.3,
        'noise': 0.1,
        'scale': 1.5,
        'guidance': c.cfg,
        'steps': c.parameters.model.contains('diffusion-5')
            ? math.min(c.steps, 28)
            : c.steps,
        'upscaled_enhance': false,
      },
      'upscale' => <String, Object?>{'operation': 'upscale', 'scale': 2.0},
      _ => <String, Object?>{
        'operation': 'local_sr',
        'model': 'realesrganAnime4x',
        'scale': 4.0,
      },
    };
    final snapshot = <String, dynamic>{
      ...defaults,
      if (settings != null) ...Map<String, dynamic>.from(settings),
      'source_asset_ref': _tools['sourceAssetRef'] ?? 'unselected',
      'parent_id': _tools['parentId'],
      'width': _tools['sourceWidth'] ?? 1,
      'height': _tools['sourceHeight'] ?? 1,
      if (mode == 'enhance') 'seed': int.tryParse(c.seedText),
    };
    if (mode == 'director') {
      if (const ['colorize', 'emotion'].contains(snapshot['director_tool'])) {
        snapshot['defry'] ??= 5;
      } else {
        snapshot['defry'] = null;
        snapshot['prompt'] = null;
      }
    }
    return PostprocessParameters.fromJson(snapshot);
  }

  void _updateToolSpec(Map<String, Object?> fields) {
    final value = {..._toolSpec().toJson(), ...fields};
    final settings = Map<String, Object?>.from(
      _tools['settings'] as Map? ?? {},
    );
    settings[_toolMode] = value;
    _updateTools({'settings': settings});
  }

  Future<void> _importToolSource() async {
    try {
      final bytes = await pickImage();
      if (bytes == null || c.assets == null) return;
      final asset = await c.prepareEditing(() => c.assets!.save(bytes));
      if (!mounted || c.closing) return;
      c.setImageToolSource(asset);
    } catch (_) {
      if (mounted) _message('无法读取图片，请选择有效 PNG、JPEG 或 WebP。');
    }
  }

  Future<void> _useToolSource([SceneResult? result]) async {
    final source = result ?? c.selected;
    if (source.assetRef == null || c.assets == null) {
      _message('请导入图片，或选择已有的本地原图。');
      return;
    }
    try {
      final asset = await c.prepareEditing(
        () async => (await validateImageAssetBytes(
          await c.assets!.read(source.assetRef!),
        )).asset,
      );
      if (!mounted || c.closing) return;
      c.setImageToolSource(asset, parentId: source.id);
      _setPage(3);
    } catch (_) {
      if (mounted) _message('所选原图不可用，请重新导入。');
    }
  }

  Future<void> _submitImageTools() async {
    if (c.generating) return;
    final form = (scaffold.currentState?.isEndDrawerOpen ?? false)
        ? toolDrawerForm.currentState
        : toolInlineForm.currentState;
    if (form != null && !form.validate()) {
      _message('请先修正参数。');
      return;
    }
    if (_toolMode != 'tiled' && _tools['sourceAssetRef'] != null) {
      _updateTools({'postprocess': _toolSpec().toJson()});
    }
    await c.runImageTool();
    if (mounted && c.imageToolJob['status'] != 'completed') _message(c.status);
  }

  Future<void> _exportToolResult() async {
    final ref = _tools['resultAssetRef'] as String?;
    if (ref == null || c.assets == null) return;
    try {
      final result = await exportImage(
        await c.assets!.read(ref),
        suggestedName: '绘世-${_imageToolNames[_toolMode]}.png',
      );
      if (mounted && result) _message('结果已另存。');
    } catch (_) {
      if (mounted) _message('另存失败，图库中的结果仍保留。');
    }
  }

  Widget _imageToolsWorkspace() {
    final draft = _tools;
    final source = draft['sourceAssetRef'] as String?;
    final result = draft['resultAssetRef'] as String?;
    final job = c.imageToolJob;
    return SingleChildScrollView(
      padding: const EdgeInsets.all(24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('把细节交还给画面', style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 8),
          _muted('分块高清与图片后处理 · 原图保留，结果独立保存'),
          const SizedBox(height: 20),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              OutlinedButton.icon(
                onPressed: c.assets == null || c.generating
                    ? null
                    : _importToolSource,
                icon: const Icon(Icons.add_photo_alternate_outlined),
                label: const Text('导入处理原图'),
              ),
              OutlinedButton.icon(
                onPressed: c.generating ? null : () => _useToolSource(),
                icon: const Icon(Icons.photo_library_outlined),
                label: const Text('使用当前图库图片'),
              ),
              if (source != null)
                _badge('${draft['sourceWidth']} × ${draft['sourceHeight']} 原图'),
              if (result != null)
                _badge(
                  '${draft['resultWidth']} × ${draft['resultHeight']} 结果',
                  gold: true,
                ),
            ],
          ),
          const SizedBox(height: 18),
          if (source != null && c.assets != null) ...[
            LayoutBuilder(
              builder: (context, bounds) => SizedBox(
                height: (bounds.maxWidth * .62).clamp(230.0, 520.0),
                child: ImageComparison(
                  store: c.assets!,
                  sourceRef: source,
                  resultRef: result,
                  position: (draft['compare'] as num? ?? .5).toDouble(),
                  onChanged: (v) => _updateTools({'compare': v}),
                ),
              ),
            ),
            if (result != null) ...[
              const SizedBox(height: 12),
              Row(
                children: [
                  const Text('原图'),
                  Expanded(
                    child: Slider(
                      label: '原图与结果分界',
                      value: (draft['compare'] as num? ?? .5).toDouble().clamp(
                        0,
                        1,
                      ),
                      onChanged: (v) => _updateTools({'compare': v}),
                    ),
                  ),
                  const Text('处理结果'),
                ],
              ),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  FilledButton.icon(
                    onPressed: _exportToolResult,
                    icon: const Icon(Icons.save_alt),
                    label: const Text('另存结果 PNG'),
                  ),
                  OutlinedButton.icon(
                    onPressed: c.generating
                        ? null
                        : () async {
                            final record = c.results
                                .where((r) => r.id == draft['resultId'])
                                .firstOrNull;
                            if (record != null) await _useToolSource(record);
                          },
                    icon: const Icon(Icons.check),
                    label: const Text('结果回填为新原图'),
                  ),
                  TextButton(
                    onPressed: () => _setPage(1),
                    child: const Text('查看图库'),
                  ),
                ],
              ),
            ],
          ] else
            Container(
              height: 320,
              width: double.infinity,
              decoration: BoxDecoration(
                color: colors.surface,
                borderRadius: BorderRadius.circular(16),
              ),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Icon(
                    Icons.auto_fix_high_rounded,
                    size: 46,
                    color: colors.primary,
                  ),
                  const SizedBox(height: 14),
                  const Text('选择一张原图，开始修整细节'),
                  const SizedBox(height: 8),
                  _muted('也可以从图库详情直接送入图片工具'),
                ],
              ),
            ),
          const SizedBox(height: 22),
          if (job.isNotEmpty)
            Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: colors.surface,
                borderRadius: BorderRadius.circular(12),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(job['stage'] as String? ?? '图片处理任务'),
                  const SizedBox(height: 8),
                  if (job['status'] == 'running')
                    LinearProgressIndicator(
                      value: (job['total'] as int? ?? 0) > 0
                          ? (job['done'] as int? ?? 0) / (job['total'] as int)
                          : null,
                    ),
                  if (c.generating && job['status'] == 'running')
                    TextButton.icon(
                      onPressed: c.cancelGeneration,
                      icon: const Icon(Icons.stop),
                      label: const Text('停止处理'),
                    ),
                  _muted('草稿与完成结果自动保存。中断任务保留进度记录，重启后不自动重复请求。'),
                ],
              ),
            ),
        ],
      ),
    );
  }

  Widget _imageToolsParameters({bool drawer = false}) {
    final mode = _toolMode;
    final protocol = const ['enhance', 'upscale'].contains(mode)
        ? 'official'
        : _tools['protocol'] as String;
    final p = mode == 'tiled' ? null : _toolSpec();
    return Form(
      key: drawer ? toolDrawerForm : toolInlineForm,
      child: Material(
        color: colors.surface,
        borderRadius: BorderRadius.circular(16),
        clipBehavior: Clip.antiAlias,
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.all(18),
              child: Row(
                children: [
                  Icon(Icons.tune, size: 17, color: colors.primary),
                  const SizedBox(width: 10),
                  const Text('图片工具参数'),
                ],
              ),
            ),
            const Divider(height: 1),
            Expanded(
              child: SingleChildScrollView(
                padding: const EdgeInsets.all(18),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    _dropdown(
                      '处理方式',
                      _imageToolNames[mode]!,
                      _imageToolNames.values.toList(),
                      c.generating
                          ? null
                          : (v) => _changeToolMode(
                              _imageToolNames.entries
                                  .firstWhere((e) => e.value == v)
                                  .key,
                            ),
                    ),
                    const SizedBox(height: 18),
                    if (mode != 'localSr') ...[
                      if (const ['enhance', 'upscale'].contains(mode))
                        _badge('NovelAI 官方专用')
                      else
                        _dropdown(
                          '处理渠道',
                          ServiceConnection.labels[protocol]!,
                          ServiceConnection.labels.values.toList(),
                          (v) => _updateTools({
                            'protocol': ServiceConnection.labels.entries
                                .firstWhere((e) => e.value == v)
                                .key,
                          }),
                        ),
                      Align(
                        alignment: Alignment.centerRight,
                        child: TextButton.icon(
                          onPressed: c.vault == null
                              ? null
                              : () async {
                                  final next = await showConnectionDialog(
                                    context,
                                    connection: c.connectionFor(protocol),
                                    vault: c.vault!,
                                  );
                                  if (next != null && mounted) {
                                    c.updateConnection(next);
                                  }
                                },
                          icon: const Icon(Icons.key, size: 15),
                          label: const Text('处理接入设置'),
                        ),
                      ),
                    ],
                    if (mode == 'tiled') ..._tiledToolParameters(),
                    if (mode == 'director') ..._directorToolParameters(p!),
                    if (mode == 'enhance') ..._enhanceToolParameters(p!),
                    if (mode == 'upscale') ...[
                      _dropdown(
                        '放大倍率',
                        '${p!.scale!.toInt()}×',
                        ['2×', '4×'],
                        (v) =>
                            _updateToolSpec({'scale': v == '2×' ? 2.0 : 4.0}),
                      ),
                      const SizedBox(height: 12),
                      _muted('4× 会顺序放大两次。超过输入限制先等比缩小，图库记录实际输出尺寸。'),
                    ],
                    if (mode == 'localSr') ...[
                      _dropdown(
                        '超分模型',
                        _srNames[p!.model]!,
                        _srNames.values.toList(),
                        (v) {
                          final key = _srNames.entries
                              .firstWhere((e) => e.value == v)
                              .key;
                          _updateToolSpec({
                            'model': key,
                            'scale': key.endsWith('2x') ? 2.0 : 4.0,
                          });
                        },
                      ),
                      const SizedBox(height: 14),
                      _muted(c.localSrInfo),
                      const SizedBox(height: 12),
                      _muted('在 Windows 本机执行，不消耗图像服务额度。'),
                    ],
                  ],
                ),
              ),
            ),
            const Divider(height: 1),
            Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                children: [
                  _muted(
                    mode == 'localSr'
                        ? '本地处理 · 源图保留'
                        : '提交时冻结源图和参数；在线操作使用所选渠道额度。',
                  ),
                  const SizedBox(height: 12),
                  SizedBox(
                    width: double.infinity,
                    child: FilledButton.icon(
                      onPressed:
                          c.generating ||
                              (mode == 'localSr' && !c.localSrAvailable)
                          ? null
                          : _submitImageTools,
                      icon: const Icon(Icons.auto_fix_high),
                      label: Text(
                        c.generating ? '正在处理…' : '开始${_imageToolNames[mode]}',
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  List<Widget> _tiledToolParameters() {
    String planText = '每块 640px，步幅 320px；请求 1024×1024，最终尺寸为原图 1.6×。';
    if (_tools['sourceWidth'] != null) {
      try {
        final plan = buildTiledImg2ImgPlan(
          _tools['sourceWidth'] as int,
          _tools['sourceHeight'] as int,
        );
        planText +=
            '\n本次共 ${plan.tiles.length} 块、${plan.tiles.length} 次请求，输出 ${plan.outputWidth}×${plan.outputHeight}。';
      } on ArgumentError {
        planText += '\n原图超出最多 16 块的处理限制，请换用较小原图。';
      }
    }
    return [
      _muted(planText),
      const SizedBox(height: 16),
      _number(
        '分块重绘强度',
        (_tools['strength'] as num).toDouble(),
        (v) => _updateTools({'strength': v.toDouble()}),
        min: .01,
        max: 1,
      ),
      TextFormField(
        controller: positive,
        minLines: 3,
        maxLines: 6,
        decoration: const InputDecoration(labelText: '分块正向提示词'),
        onChanged: c.updatePrompt,
      ),
      const SizedBox(height: 12),
      TextFormField(
        controller: negative,
        minLines: 2,
        maxLines: 4,
        decoration: const InputDecoration(labelText: '分块负向提示词'),
        onChanged: c.updateNegative,
      ),
      const SizedBox(height: 14),
      _dropdown(
        '分块模型',
        c.model,
        {...WorkbenchController.modelIds.keys, c.model}.toList(),
        c.updateModel,
      ),
      const SizedBox(height: 14),
      TextFormField(
        controller: seed,
        decoration: const InputDecoration(labelText: 'Seed · 留空随机'),
        keyboardType: TextInputType.number,
        onChanged: c.updateSeed,
      ),
      const SizedBox(height: 14),
      _number(
        '分块步数',
        c.steps,
        (v) => c.updateSteps(v.toDouble()),
        min: 1,
        max: 50,
        integer: true,
      ),
      _number(
        '分块 CFG',
        c.cfg,
        (v) => c.updateCfg(v.toDouble()),
        min: 1,
        max: 10,
      ),
      ExpansionTile(
        tilePadding: EdgeInsets.zero,
        title: const Text('完整高级与参考参数'),
        children: [
          _advancedParameters(includeSize: false, includeBatch: false),
          _liveCharacters(),
          _liveReferences(),
        ],
      ),
      _muted('块任务继承全部生成设置。渠道不支持的角色或参考组合会明确报错，不自动丢弃。'),
    ];
  }

  List<Widget> _directorToolParameters(PostprocessParameters p) {
    final tool = p.toJson()['director_tool'] as String;
    final usesPrompt = const ['colorize', 'emotion'].contains(tool);
    return [
      _dropdown(
        '导演动作',
        _directorNames[tool]!,
        _directorNames.values.toList(),
        (v) => _updateToolSpec({
          'director_tool': _directorNames.entries
              .firstWhere((e) => e.value == v)
              .key,
          'prompt': null,
          'defry': null,
        }),
      ),
      const SizedBox(height: 14),
      if ((_tools['protocol'] as String) != 'official') ...[
        TextFormField(
          key: ValueKey(
            'director-model-${c.refillRevision}-${_tools['sourceRevision']}',
          ),
          initialValue: p.model,
          decoration: const InputDecoration(labelText: '导演模型 ID'),
          onChanged: (v) => _updateToolSpec({'model': v}),
        ),
        const SizedBox(height: 14),
      ],
      if (usesPrompt) ...[
        TextFormField(
          key: ValueKey(
            'director-prompt-$tool-${c.refillRevision}-${_tools['sourceRevision']}',
          ),
          initialValue: p.prompt ?? '',
          minLines: 3,
          maxLines: 6,
          decoration: const InputDecoration(labelText: '导演提示词'),
          onChanged: (v) => _updateToolSpec({'prompt': v}),
        ),
        const SizedBox(height: 12),
        _number(
          '导演 Defry',
          p.defry ?? 5,
          (v) => _updateToolSpec({'defry': v.toInt()}),
          max: 5,
          integer: true,
        ),
      ],
    ];
  }

  List<Widget> _enhanceToolParameters(PostprocessParameters p) => [
    TextFormField(
      key: ValueKey(
        'enhance-model-${c.refillRevision}-${_tools['sourceRevision']}',
      ),
      initialValue: p.model,
      decoration: const InputDecoration(labelText: '增强模型 ID'),
      onChanged: (v) => _updateToolSpec({
        'model': v,
        if (!v.contains('diffusion-5')) 'upscaled_enhance': false,
        if (v.contains('diffusion-5') && p.steps! > 28) 'steps': 28,
      }),
    ),
    const SizedBox(height: 14),
    TextFormField(
      key: ValueKey(
        'enhance-prompt-${c.refillRevision}-${_tools['sourceRevision']}',
      ),
      initialValue: p.prompt ?? '',
      minLines: 3,
      maxLines: 6,
      decoration: const InputDecoration(labelText: '增强正向提示词'),
      onChanged: (v) => _updateToolSpec({'prompt': v}),
    ),
    const SizedBox(height: 12),
    TextFormField(
      key: ValueKey(
        'enhance-negative-${c.refillRevision}-${_tools['sourceRevision']}',
      ),
      initialValue: p.negativePrompt ?? '',
      minLines: 2,
      maxLines: 4,
      decoration: const InputDecoration(labelText: '增强负向提示词'),
      onChanged: (v) => _updateToolSpec({'negative_prompt': v}),
    ),
    const SizedBox(height: 14),
    _dropdown(
      '增强分辨率倍率',
      '${p.scale}×',
      ['1.0×', '1.5×', '2.0×'],
      (v) => _updateToolSpec({
        'scale': double.parse(v.replaceAll('×', '')),
        'upscaled_enhance': false,
      }),
    ),
    const SizedBox(height: 14),
    SwitchListTile(
      contentPadding: EdgeInsets.zero,
      title: const Text('V5 Max · 服务端 2× 增强'),
      value: p.upscaledEnhance,
      onChanged: p.model?.contains('diffusion-5') != true
          ? null
          : (v) =>
                _updateToolSpec({'upscaled_enhance': v, if (v) 'scale': 1.0}),
    ),
    _number(
      '增强强度',
      p.strength!,
      (v) => _updateToolSpec({'strength': v.toDouble()}),
      min: .01,
      max: .99,
    ),
    _number(
      '增强噪声',
      p.noise!,
      (v) => _updateToolSpec({'noise': v.toDouble()}),
      max: .99,
    ),
    _number(
      '增强 CFG',
      p.guidance!,
      (v) => _updateToolSpec({'guidance': v.toDouble()}),
      min: 1,
      max: 10,
    ),
    _number(
      '增强步数',
      p.steps!,
      (v) => _updateToolSpec({'steps': v.toInt()}),
      min: 1,
      max: p.model?.contains('diffusion-5') == true ? 28 : 50,
      integer: true,
    ),
    TextFormField(
      controller: seed,
      decoration: const InputDecoration(labelText: 'Seed · 留空随机'),
      onChanged: c.updateSeed,
    ),
    const SizedBox(height: 12),
    _muted('输入按 64px 对齐并限制像素数；记录实际输入和输出尺寸。'),
  ];
}

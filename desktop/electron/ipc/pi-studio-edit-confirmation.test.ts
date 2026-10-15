import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  settings: {} as Record<string, any>,
  account: { tierLevel: 3, hasActiveSubscription: true },
  executeAgentTool: vi.fn(),
}));

vi.mock('./store', () => ({
  getSettings: () => state.settings,
  getAccountSummary: () => state.account,
}));
vi.mock('./agent-tools', () => ({
  AGENT_READ_TOOLS: ['langbai_read_image_metadata', 'langbai_software_capabilities'],
  AGENT_MUTATING_TOOLS: ['langbai_edit_prompt', 'langbai_reverse_prompt', 'langbai_convert_prompt'],
  executeAgentTool: state.executeAgentTool,
}));
vi.mock('./agent-image-provider', () => ({ compatibleAgentInput: vi.fn() }));

import { DEFAULT_PARAMS } from '../../src/types';
import { activateNaiAccount } from './nai-accounts-runtime';
import { createStudioPiTools, prepareStudioEditConfirmation } from './pi-studio-tools';

const account = {
  id: 'edit-confirmation-account', label: 'Synthetic', method: 'token' as const,
  token: 'synthetic-token-never-rendered', apiBaseUrl: 'https://api.novelai.net',
  imageBaseUrl: 'https://image.novelai.net',
};

beforeEach(() => {
  state.settings = {
    imageProvider: 'novelai',
    modelMode: 'normal',
    generationGroupId: 'fixture-group',
    lastGenerationState: {
      params: {
        ...DEFAULT_PARAMS,
        effort: 'medium',
        steps: 40,
        negativePrompt: 'saved negative',
        stylePrompt: 'saved style',
      },
    },
  };
  state.executeAgentTool.mockReset();
  activateNaiAccount(account, () => {});
});

afterEach(() => activateNaiAccount(undefined, () => {}));

describe('Pi edit approval snapshots', () => {
  it('shows effective inpaint defaults without exposing attachment paths or bytes and rejects settings drift', () => {
    const prepared = prepareStudioEditConfirmation('langbai_inpaint_image', {
      attachmentId: 'source-image-id',
      maskAttachmentId: 'mask-image-id',
      positivePrompt: '  blue-haired character  ',
      path: 'C:\\private\\source.png',
      base64: 'synthetic-image-bytes',
    });

    expect(prepared.metadata).toMatchObject({
      operation: '局部重绘',
      imageProvider: 'novelai',
      sourceAttachmentId: 'source-image-id',
      maskAttachmentId: 'mask-image-id',
      positivePrompt: 'blue-haired character',
      negativePrompt: '',
      stylePrompt: 'saved style',
      model: 'nai-diffusion-5-full-medium',
      width: DEFAULT_PARAMS.width,
      height: DEFAULT_PARAMS.height,
      steps: 14,
      sampler: 'k_euler_ancestral',
      cfgRescale: 0,
      strength: 0.7,
      noise: 0,
      inpaintModel: expect.any(String),
    });
    const encoded = JSON.stringify(prepared.metadata);
    expect(encoded).not.toContain('C:\\private');
    expect(encoded).not.toContain('synthetic-image-bytes');
    expect(encoded).not.toContain('synthetic-token-never-rendered');
    expect(() => prepared.assertCurrent()).not.toThrow();

    state.settings.lastGenerationState.params.width += 64;
    expect(() => prepared.assertCurrent()).toThrow('设置或账户已变化');
  });

  it('rejects account changes after an edit was approved', () => {
    const prepared = prepareStudioEditConfirmation('langbai_upscale_image', {
      attachmentId: 'source-image-id', scale: 2,
    });
    activateNaiAccount({ ...account, id: 'different-synthetic-account' }, () => {});
    expect(() => prepared.assertCurrent()).toThrow('设置或账户已变化');
  });

  it('rejects unsupported references for inpaint and snapshots character prompts only for redraw', () => {
    const characterPrompts = [{
      prompt: 'hooded mage', negativePrompt: 'extra fingers', useCoords: true, x: 0.3, y: 0.4,
    }];
    expect(() => prepareStudioEditConfirmation('langbai_inpaint_image', {
      attachmentId: 'source-image-id', maskAttachmentId: 'mask-image-id',
      positivePrompt: 'blue-haired character', characterPrompts,
    })).toThrow('局部重绘暂不支持');

    const redraw = prepareStudioEditConfirmation('langbai_redraw_image', {
      attachmentId: 'source-image-id', positivePrompt: 'blue-haired character', characterPrompts,
    });
    expect(redraw?.metadata).toMatchObject({
      operation: '图生图',
      references: { characters: [{ prompt: 'hooded mage', negativePrompt: 'extra fingers', x: 0.3, y: 0.4 }] },
    });
  });

  it('normalizes legacy Director colorize prompt into the approved field and rejects conflicts', () => {
    const prepared = prepareStudioEditConfirmation('langbai_director', {
      attachmentId: 'source-image-id', tool: 'colorize', prompt: '  warm sunset  ',
    });
    expect(prepared.metadata).toMatchObject({ colorizePrompt: 'warm sunset', defry: 0 });
    expect(() => prepareStudioEditConfirmation('langbai_director', {
      attachmentId: 'source-image-id', tool: 'colorize', prompt: 'one', colorizePrompt: 'two',
    })).toThrow('内容冲突');
  });

  it('redacts the model-facing result while retaining the raw receipt for the UI', async () => {
    const raw = {
      ok: true,
      title: '元数据读取',
      output: 'C:\\private\\source.png',
      data: {
        attachmentId: 'source-image-id',
        filePath: 'C:\\private\\source.png',
        nested: { base64: 'synthetic-image-bytes', token: 'synthetic-token' },
        note: 'saved to D:\\private\\result.png',
      },
      generatedImages: [{ id: 'result-image-id', filePath: 'C:\\private\\result.png' }],
    };
    state.executeAgentTool.mockResolvedValue(raw);
    const onExecuted = vi.fn();
    const tool = createStudioPiTools({ sessionId: 'redaction-fixture', emit: () => {}, onExecuted })
      .find((item) => item.name === 'langbai_read_image_metadata')!;
    const result = await tool.execute({ attachmentId: 'source-image-id' }, new AbortController().signal);

    expect(onExecuted).toHaveBeenCalledWith('langbai_read_image_metadata', expect.any(Object), raw);
    expect(result.output).toContain('source-image-id');
    expect(result.output).not.toContain('C:\\private');
    expect(result.output).not.toContain('synthetic-image-bytes');
    expect(result.output).not.toContain('synthetic-token');
    expect(JSON.stringify(result.data)).not.toContain('private');
    expect(JSON.stringify(result.data)).not.toContain('synthetic-image-bytes');
    expect(JSON.stringify(result.data)).not.toContain('synthetic-token');
  });

  it('marks remote text and vision model calls as paid and advertises the current per-turn limits', async () => {
    state.executeAgentTool.mockResolvedValue({ ok: true, title: '能力', output: '{}', data: {} });
    const tools = createStudioPiTools({ sessionId: 'catalog-fixture', emit: () => {} });
    for (const name of ['langbai_convert_prompt', 'langbai_reverse_prompt', 'langbai_edit_prompt']) {
      expect(tools.find((item) => item.name === name)).toMatchObject({ paid: true, readonly: false });
    }

    const capabilities = tools.find((item) => item.name === 'langbai_software_capabilities')!;
    const result = await capabilities.execute({}, new AbortController().signal);
    const generation = (result.data as { generation: string }).generation;
    expect(generation).toContain('确认模式每轮最多12次工具调用');
    expect(generation).toContain('全自动模式最多32次');
    expect(generation).toContain('本轮剩余付费操作都会停止');
    expect(generation).toContain('提示词/视觉模型服务可能收费');
  });
});

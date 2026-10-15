import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  inpaint: vi.fn(),
  augment: vi.fn(),
  loadImage: vi.fn(),
  fixturePath: `${process.cwd()}/shared/official-image-metadata-fixtures/gray-alpha-8-plain.png`,
}));

vi.mock('./nai', () => ({
  inpaintImage: state.inpaint,
  augmentImg: state.augment,
  loadImageFromPath: state.loadImage,
}));
vi.mock('./store', () => ({
  getSettings: () => ({ imageProvider: 'novelai' }),
  getHistory: () => [
    { id: 'source', filePath: state.fixturePath, width: 64, height: 128, createdAt: '2026-10-15' },
    { id: 'mask', filePath: state.fixturePath, width: 64, height: 128, createdAt: '2026-10-15' },
  ],
  setSetting: vi.fn(),
}));
vi.mock('./agent-store', () => ({
  conversationForRuntimeSession: () => undefined,
  deleteAgentMemory: vi.fn(),
  readAgentWorkspace: vi.fn(),
  retrieveAgentMemories: vi.fn(),
  upsertAgentMemory: vi.fn(),
}));
vi.mock('./agent-image-provider', () => ({
  PAID_IMAGE_TOOLS: new Set(['langbai_inpaint_image', 'langbai_director']),
  agentImageProviderState: () => ({}),
  assertAgentImageProvider: vi.fn(),
  assertAgentImageTool: vi.fn(),
  bindAgentImageProvider: () => ({}),
  compatibleAgentInput: vi.fn(),
}));
vi.mock('electron', () => ({ app: {}, dialog: {}, nativeImage: {}, protocol: {} }));

import { executeAgentTool } from './agent-tools';
import { createStudioPiTools } from './pi-studio-tools';

const run = (strength?: number) => executeAgentTool({
  tool: 'langbai_inpaint_image',
  args: {
    attachmentId: 'source',
    maskAttachmentId: 'mask',
    positivePrompt: 'blue sky',
    ...(strength !== undefined ? { strength } : {}),
  },
}, () => {});

describe('Agent inpaint strength defaults', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.loadImage.mockResolvedValue({ ok: true, image: { width: 64, height: 128 } });
    state.inpaint.mockResolvedValue({ ok: true, items: [] });
    state.augment.mockResolvedValue({ ok: true, items: [] });
  });

  it('uses the legacy Flutter default when strength is omitted', async () => {
    expect((await run()).ok).toBe(true);
    expect(state.inpaint).toHaveBeenCalledWith(
      expect.objectContaining({ positivePrompt: 'blue sky' }),
      'nai-diffusion-5-full-inpainting',
      expect.any(String),
      0.7,
      0,
    );
  });

  it('preserves an explicitly requested strength', async () => {
    expect((await run(0.42)).ok).toBe(true);
    expect(state.inpaint.mock.calls[0]?.[3]).toBe(0.42);
  });

  it.each(['vibeReferences', 'preciseReferences', 'characterPrompts'])(
    'rejects unsupported inpaint input %s instead of silently dropping it',
    async (field) => {
      const result = await executeAgentTool({
        tool: 'langbai_inpaint_image',
        args: {
          attachmentId: 'source', maskAttachmentId: 'mask', positivePrompt: 'blue sky',
          [field]: [{ attachmentId: 'reference-image', prompt: 'hooded mage' }],
        },
      }, () => {});
      expect(result.ok).toBe(false);
      expect(result.output).toContain('局部重绘暂不支持');
      expect(state.loadImage).not.toHaveBeenCalled();
      expect(state.inpaint).not.toHaveBeenCalled();
    },
  );

  it('advertises the optional strength and its default to the live Pi tool schema', () => {
    const tool = createStudioPiTools({ sessionId: 'fixture', emit: () => {} })
      .find((item) => item.name === 'langbai_inpaint_image');
    expect(tool?.description).toContain('strength?:number');
    expect(tool?.description).toContain('省略时为 0.7');
    expect(tool?.parameters).toMatchObject({
      properties: { strength: { minimum: 0.01, maximum: 1 } },
    });
  });

  it('executes legacy and current Director colorize prompt fields and rejects conflicts or unknown tools', async () => {
    const runDirector = (args: Record<string, unknown>) => executeAgentTool({
      tool: 'langbai_director', args,
    }, () => {});

    expect((await runDirector({ attachmentId: 'source', tool: 'colorize', prompt: ' warm sunset ' })).ok).toBe(true);
    expect(state.augment).toHaveBeenLastCalledWith('colorize', expect.objectContaining({ colorizePrompt: 'warm sunset' }));

    expect((await runDirector({ attachmentId: 'source', tool: 'colorize', colorizePrompt: 'blue dusk' })).ok).toBe(true);
    expect(state.augment).toHaveBeenLastCalledWith('colorize', expect.objectContaining({ colorizePrompt: 'blue dusk' }));

    state.augment.mockClear();
    const conflict = await runDirector({
      attachmentId: 'source', tool: 'colorize', prompt: 'red', colorizePrompt: 'blue',
    });
    expect(conflict.ok).toBe(false);
    expect(conflict.output).toContain('内容冲突');
    expect(state.augment).not.toHaveBeenCalled();

    const unknown = await runDirector({ attachmentId: 'source', tool: 'not-a-director-tool' });
    expect(unknown.ok).toBe(false);
    expect(unknown.output).toContain('不支持的 Director 工具');
    expect(state.augment).not.toHaveBeenCalled();
  });
});

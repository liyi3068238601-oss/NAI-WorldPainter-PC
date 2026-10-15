import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  inpaint: vi.fn(),
  loadImage: vi.fn(),
  fixturePath: `${process.cwd()}/shared/official-image-metadata-fixtures/gray-alpha-8-plain.png`,
}));

vi.mock('./nai', () => ({
  inpaintImage: state.inpaint,
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
  PAID_IMAGE_TOOLS: new Set(['langbai_inpaint_image']),
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

  it('advertises the optional strength and its default to the live Pi tool schema', () => {
    const tool = createStudioPiTools({ sessionId: 'fixture', emit: () => {} })
      .find((item) => item.name === 'langbai_inpaint_image');
    expect(tool?.description).toContain('strength?:number');
    expect(tool?.description).toContain('省略时为 0.7');
    expect(tool?.parameters).toMatchObject({
      properties: { strength: { minimum: 0.01, maximum: 1 } },
    });
  });
});

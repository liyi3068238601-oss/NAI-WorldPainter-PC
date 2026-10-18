import { describe, expect, it, vi } from 'vitest';
import { adaptR4LegacyResult, mapR4LegacyArgs, type R4LegacyScope } from '../../src/agent/r4-legacy-adapter';
import { validateR4Result } from '../../src/agent/r4-contracts';

const scope: R4LegacyScope = { conversationId: 'conversation_test', creationId: 'creation_test' };

describe('R4 legacy adapter', () => {
  it('maps only model fields and applies declared legacy field conversions', () => {
    expect(mapR4LegacyArgs('convert_prompt', {
      text: 'a small forest', modelVersion: 'v4.5', templateRevision: 'host-checked',
      targetConversationId: 'other', targetCreationId: 'other-creation',
    })).toEqual({ text: 'a small forest', templateVersion: 'v4.5' });
    expect(mapR4LegacyArgs('process_image', {
      attachmentId: 'att_1', operation: 'colorize', colorizePrompt: 'warm sunset',
    })).toEqual({ attachmentId: 'att_1', tool: 'colorize', colorizePrompt: 'warm sunset' });
    expect(mapR4LegacyArgs('propose_memory', {
      trigger: 'Mira', category: 'characterName', content: 'mira', scope: 'global',
    })).toEqual({ trigger: 'Mira', type: 'characterName', content: 'mira', scope: 'global' });
    expect(mapR4LegacyArgs('prepare_generation', {
      positivePrompt: 'misty forest', requestedSeedPolicy: 'fixed', requestedSeed: 42,
    })).toEqual({ positivePrompt: 'misty forest', seedMode: 'fixed', seed: 42 });
  });

  it('synthesizes the exact legacy restore command without accepting restoreDefault from the model', () => {
    expect(mapR4LegacyArgs('manage_prompt_templates', {
      action: 'restore', kind: 'convert', mode: 'mixed', modelVersion: 'v5', expectedRevision: 'sha256:rev',
    })).toEqual({
      action: 'restore', kind: 'convert', mode: 'mixed', templateVersion: 'v5',
      expectedRevision: 'sha256:rev', body: '', restoreDefault: true,
    });
    expect(() => mapR4LegacyArgs('manage_prompt_templates', {
      action: 'restore', kind: 'convert', expectedRevision: 'sha256:rev', restoreDefault: true,
    })).toThrow(/invalid manage_prompt_templates input/);
  });

  it('normalizes legacy tags while preserving the actual result and classifying empty searches', async () => {
    const nonempty = await adaptR4LegacyResult('search_tags', { query: 'fox', limit: 10 }, {
      ok: true, data: [{ tag: 'fox_ears', count: 20, category: 0, description: '狐狸耳朵' }],
    }, scope);
    expect(validateR4Result('search_tags', nonempty.result).valid).toBe(true);
    expect(nonempty.result.data).toEqual({ searchStatus: 'ok', query: 'fox', items: [{ tag: 'fox_ears', category: 'general' }] });

    const empty = await adaptR4LegacyResult('search_tags', { query: 'no-result', limit: 10 }, { ok: true, data: [] }, scope);
    expect((empty.result.data as { searchStatus: string }).searchStatus).toBe('no_match');
    await expect(adaptR4LegacyResult('search_tags', { query: 'unavailable', limit: 10 }, {
      ok: false, data: 'search index unavailable',
    }, scope)).rejects.toThrow(/did not return a successful read/);
  });

  it('requires host-resolved artifact identity for history results', async () => {
    const resolveAttachment = vi.fn(async ({ attachmentId }: { attachmentId: string }) => ({
      artifactId: `artifact_${attachmentId}`, attachmentId, attachmentRevision: 'rev_1',
      hash: 'a'.repeat(64), conversationId: scope.conversationId, creationId: scope.creationId,
      outputIndex: 0, parentAttachmentId: null, resolvedSeed: 123,
      resolvedSeedSource: 'provider' as const,
    }));
    const adapted = await adaptR4LegacyResult('list_history', { limit: 10 }, {
      ok: true,
      data: { groups: [{ groupId: 'group_1', label: 'today' }], items: [{ attachmentId: 'att_1', name: 'one.png', seed: 123 }] },
      output: JSON.stringify({ items: [{ attachmentId: 'att_1', filePath: 'private-path' }] }),
      generatedImages: [{ id: 'att_1', name: 'one.png', filePath: 'private-path' }],
    }, scope, { resolveAttachment });
    expect(resolveAttachment).toHaveBeenCalledWith(expect.objectContaining({ attachmentId: 'att_1', scope }));
    expect(validateR4Result('list_history', adapted.result).valid).toBe(true);
    const item = (adapted.result.data as { items: Array<Record<string, unknown>> }).items[0];
    expect(item).toMatchObject({ artifactId: 'artifact_att_1', attachmentId: 'att_1', hash: 'a'.repeat(64) });
    expect(adapted.generatedImages).toHaveLength(1);
    expect(JSON.stringify(adapted.result)).not.toContain('private-path');
    expect(adapted.legacyOutput).toContain('private-path');
    await expect(adaptR4LegacyResult('list_history', { limit: 10 }, {
      ok: true, data: { items: [{ attachmentId: 'att_1' }] },
    }, scope)).rejects.toThrow(/attachment resolver is required/);
    await expect(adaptR4LegacyResult('list_history', { limit: 10 }, {
      ok: true, data: { items: [{ attachmentId: 'att_1' }] },
    }, scope, { resolveAttachment: async () => ({
      artifactId: 'artifact_att_1', attachmentId: 'att_1', attachmentRevision: 'rev_1',
      hash: 'a'.repeat(64), conversationId: scope.conversationId, creationId: 'another_creation',
      outputIndex: 0, parentAttachmentId: null, resolvedSeed: null, resolvedSeedSource: null,
    }) })).rejects.toThrow(/ownership does not match/);
  });

  it('never authorizes a reference preset merely because it was listed', async () => {
    const adapted = await adaptR4LegacyResult('search_reference_presets', { kind: 'all', limit: 5 }, {
      ok: true,
      data: { total: 1, groups: ['palette'], items: [{
        attachmentId: 'att_ref', presetId: 'preset_1', name: 'Palette', originalName: 'Palette',
        group: 'palette', kind: 'vibe', width: 512, height: 512,
        vibeReference: { strength: 0.7, infoExtracted: 0.8 },
      }] },
      generatedImages: [{ id: 'att_ref', name: 'palette.png' }],
    }, scope, {
      resolveAttachment: async ({ attachmentId }) => ({
        artifactId: `artifact_${attachmentId}`, attachmentId, attachmentRevision: 'rev_2',
        hash: 'b'.repeat(64), conversationId: scope.conversationId, creationId: scope.creationId,
        outputIndex: 0, parentAttachmentId: null, resolvedSeed: null, resolvedSeedSource: null,
      }),
    });
    expect(validateR4Result('search_reference_presets', adapted.result).valid).toBe(true);
    const item = (adapted.result.data as { items: Array<Record<string, unknown>> }).items[0];
    expect(item.includeInGeneration).toBe(false);
  });

  it('preserves paid service uncertainty instead of reporting a successful candidate', async () => {
    const failed = await adaptR4LegacyResult('convert_prompt', { text: 'scene', modelVersion: 'v5' }, {
      ok: false, output: 'network ended after request was sent', data: { ok: false, message: 'network ended after request was sent' },
    }, scope);
    expect(validateR4Result('convert_prompt', failed.result).valid).toBe(true);
    expect(failed.result).toMatchObject({ status: 'error', data: { serviceStatus: 'unknown', candidateText: null } });

    const succeeded = await adaptR4LegacyResult('convert_prompt', { text: 'scene', modelVersion: 'v5' }, {
      ok: true, data: { ok: true, result: 'cinematic forest', template: { version: 'v5', source: 'builtin', bodySha256: 'c'.repeat(64) } },
    }, scope, { verifiedTemplateRevision: () => 'host-revision-3' });
    expect(validateR4Result('convert_prompt', succeeded.result).valid).toBe(true);
    expect(succeeded.result).toMatchObject({ data: {
      serviceStatus: 'succeeded', candidateText: 'cinematic forest', templateRevision: 'host-revision-3',
    } });
  });

  it('maps the user answer back to requested question and option indexes', async () => {
    const adapted = await adaptR4LegacyResult('ask_user', {
      questions: [{ prompt: 'Which mood?', options: [{ label: 'Calm' }, { label: 'Bright' }] }],
    }, { ok: true, data: { cancelled: false, answers: [{ question: 'Which mood?', label: 'Bright' }] } }, scope);
    expect(validateR4Result('ask_user', adapted.result).valid).toBe(true);
    expect(adapted.result.data).toEqual({ answerStatus: 'answered', answers: [{ questionIndex: 0, selectedOptionIndex: 1 }] });
  });

  it('validates canonical read-only, template, and memory results from legacy handlers', async () => {
    const snapshot = {
      catalogStatus: 'ok' as const, catalogVersion: 'r4-test', approvalMode: 'confirm' as const,
      available: [], mounted: [], requestedGroups: [], requestedDenied: [],
      providerProjectionStatus: 'host_only' as const,
    };
    const cases: Array<{ name: string; args: Record<string, unknown>; response: Parameters<typeof adaptR4LegacyResult>[2]; dependencies?: Parameters<typeof adaptR4LegacyResult>[4] }> = [
      { name: 'get_capabilities', args: { requestedGroups: [] }, response: { ok: true, data: { readonly: [] } }, dependencies: { capabilitySnapshot: snapshot } },
      { name: 'read_generation_state', args: {}, response: { ok: true, data: {
        params: { positivePrompt: 'scene', width: 832, height: 1216, steps: 28, cfgScale: 5, seed: 42, seedMode: 'fixed' },
        imageProvider: 'novelai', modelMode: 'anime', referenceCapabilities: { maxCharacterPrompts: 4, vibeTransfer: true, preciseReference: true, attachmentIdsRequiredForAgentReferences: true },
      } }, dependencies: { workbenchSnapshot: { draftId: 'draft_1', draftRevision: 3, inputRevision: 7, draftSource: 'workbench' } } },
      { name: 'read_generation_state', args: {}, response: { ok: false, data: 'settings are temporarily unavailable' } },
      { name: 'search_artists', args: { query: 'line art', scope: 'style', limit: 5 }, response: { ok: true, data: { source: 'catalog', items: [{ tag: 'lineart', count: 2 }] } } },
      { name: 'search_gallery', args: { source: 'danbooru', query: 'fox', page: 1, safeOnly: true }, response: { ok: true, data: {
        source: 'danbooru', page: 1, items: [{ id: '1', title: 'fox', sourceUrl: 'https://danbooru.donmai.us/posts/1', cover: { previewUrl: 'https://danbooru.donmai.us/preview/1.png' }, tags: { general: ['fox'] }, rating: 'safe' }],
      } } },
      { name: 'search_web', args: { query: 'local painting', limit: 3 }, response: { ok: true, data: {
        provider: 'public search', sources: [{ title: 'Painting guide', url: 'https://example.org/guide', snippet: 'A short source-backed guide.' }],
      } } },
      { name: 'search_prompt_presets', args: { kind: 'all', query: 'forest', limit: 5 }, response: { ok: true, data: {
        total: 1, items: [{ id: 'preset_1', kind: 'positive', name: 'Forest', prompt: 'misty forest' }],
      } } },
      { name: 'read_image_metadata', args: { attachmentId: 'att_meta' }, response: { ok: true, data: {
        attachmentId: 'att_meta', found: false, kind: 'unknown', parameters: {}, characterPrompts: [], fields: [], fieldsTruncated: false, warnings: [],
      } } },
      { name: 'search_memories', args: { query: 'Mira' }, response: { ok: true, data: [
        { id: 'memory_1', title: 'Mira', type: 'characterName', scope: 'global', content: 'mira', updatedAt: '2026-10-18T00:00:00Z' },
      ] } },
      { name: 'read_skill', args: { skillId: 'skill_1' }, response: { ok: true, data: { name: 'Tag lookup', instructions: 'Search terms first.' } }, dependencies: {
        skillMetadata: () => ({ source: 'user-configured-skill', version: '1' }),
      } },
      { name: 'read_prompting_reference', args: { reference: 'ideation' }, response: { ok: true, data: { content: 'Describe the idea.' } }, dependencies: {
        promptingReferenceMetadata: () => ({ source: 'worldpainter-knowledge', version: 'v5' }),
      } },
      { name: 'save_prompt_preset', args: { name: 'Forest', prompt: 'misty forest' }, response: { ok: true, data: { id: 'preset_2', name: 'Forest', prompt: 'misty forest' } } },
      { name: 'read_prompt_template', args: { kind: 'convert', mode: 'mixed', modelVersion: 'v5' }, response: { ok: true, data: {
        kind: 'convert', mode: 'mixed', templateVersion: 'v5', revision: 'rev_1', body: 'Translate faithfully.', bodySha256: 'd'.repeat(64), source: 'builtin',
      } } },
      { name: 'manage_prompt_templates', args: { action: 'read', kind: 'convert', mode: 'mixed', modelVersion: 'v5' }, response: { ok: true, data: {
        kind: 'convert', mode: 'mixed', templateVersion: 'v5', revision: 'rev_1', body: 'Translate faithfully.', bodySha256: 'd'.repeat(64), source: 'builtin',
      } } },
      { name: 'edit_prompt', args: { kind: 'optimize', currentPrompt: 'forest', instruction: 'add warmth', modelVersion: 'v5' }, response: { ok: true, data: {
        ok: true, result: 'warm forest', template: { version: 'v5', source: 'builtin', bodySha256: 'e'.repeat(64) },
      } } },
      { name: 'reverse_prompt', args: { attachmentId: 'att_image' }, response: { ok: true, data: {
        ok: true, prompt: 'a fox in a forest', template: { version: 'v5', source: 'builtin', bodySha256: 'f'.repeat(64) },
      } } },
      { name: 'propose_memory', args: { trigger: 'Mira', category: 'characterName', content: 'mira', scope: 'global' }, response: { ok: true, data: { workspace: { memories: [
        { id: 'memory_2', title: 'Mira', trigger: 'Mira', type: 'characterName', source: 'pendingLlmCandidate', scope: 'global', content: 'mira' },
      ] } } } },
    ];
    for (const testCase of cases) {
      const adapted = await adaptR4LegacyResult(testCase.name, testCase.args, testCase.response, scope, testCase.dependencies);
      expect(validateR4Result(testCase.name, adapted.result).valid, testCase.name).toBe(true);
    }
  });

  it('uses the same live renderer params as the workbench revision, never the stale persisted legacy params',async()=>{
    const adapted=await adaptR4LegacyResult('read_generation_state',{}, {ok:true,data:{
      params:{positivePrompt:'stale persisted prompt',width:832,height:1216,steps:28,seed:7,seedMode:'fixed'},
      imageProvider:'novelai',modelMode:'anime',referenceCapabilities:{maxCharacterPrompts:4,vibeTransfer:true,preciseReference:true,attachmentIdsRequiredForAgentReferences:true},
    }},scope,{workbenchSnapshot:{draftId:'live-workbench',draftRevision:12,inputRevision:12,draftSource:'workbench',
      params:{positivePrompt:'unsaved live prompt',negativePrompt:'live negative',stylePrompt:'live style',steps:33,width:960,height:1024}}});
    expect(validateR4Result('read_generation_state',adapted.result).valid).toBe(true);
    expect(adapted.result.data).toMatchObject({draftId:'live-workbench',draftRevision:12,inputRevision:12,
      params:{positivePrompt:'unsaved live prompt',negativePrompt:'live negative',stylePrompt:'live style',steps:33,width:960,height:1024}});
  });

  it('requires scope captured before a successful legacy memory delete', async () => {
    const adapted = await adaptR4LegacyResult('delete_memory_candidate', { candidateId: 'mem_1' }, {
      ok: true, data: { workspace: { memories: [] } },
    }, scope, { resolveCandidateScope: () => 'conversation' });
    expect(validateR4Result('delete_memory_candidate', adapted.result).valid).toBe(true);
    expect(adapted.result.data).toEqual({ deleteStatus: 'deleted', candidateId: 'mem_1', scope: 'conversation' });
    await expect(adaptR4LegacyResult('delete_memory_candidate', { candidateId: 'mem_1' }, {
      ok: true, data: { workspace: { memories: [] } },
    }, scope)).rejects.toThrow(/scope captured before deletion/);
  });
});

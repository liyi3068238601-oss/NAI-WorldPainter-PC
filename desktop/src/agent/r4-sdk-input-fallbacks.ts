import type { R4ToolName } from './r4-contracts';

/**
 * Minimal schema-valid values used only to pass Pi's transport validator.
 * R4 execution always uses the untouched toolCall arguments and validates
 * those again with AJV before authorization or dispatch.
 */
export const r4SdkInputFallbacks: Record<R4ToolName, Record<string, unknown>> = {
  apply_prompt: { proposalId: 'x', proposalRevision: 1, targetDraftId: 'x', expectedDraftRevision: 0 },
  write_workbench_prompts: { positivePrompt: 'x', expectedDraftRevision: 0 },
  ask_user: { questions: [{ prompt: 'x', options: [{ label: 'x' }, { label: 'x' }] }] },
  cancel_execution: { executionId: 'x' },
  convert_prompt: { text: 'x' },
  delete_memory_candidate: { candidateId: 'x' },
  edit_prompt: { kind: 'optimize', currentPrompt: 'x' },
  generate_image: { preparationId: 'x' },
  get_capabilities: {},
  get_execution: { executionId: 'x' },
  inpaint_image: { positivePrompt: 'x', attachmentId: 'x', maskAttachmentId: 'x' },
  list_history: {},
  manage_prompt_templates: { action: 'read' },
  patch_creation_inputs: { expectedInputRevision: 0, action: 'clear_edit_source' },
  prepare_generation: { proposalId: 'x', revision: 1 },
  process_image: { attachmentId: 'x', operation: 'colorize' },
  propose_memory: { trigger: 'x', content: 'x' },
  propose_prompt: { positivePrompt: 'x' },
  read_creation: {},
  read_generation_state: {},
  read_image_metadata: { attachmentId: 'x' },
  read_prompt_template: {},
  read_prompting_reference: { reference: 'ideation' },
  read_proposal: { proposalId: 'x', revision: 1 },
  read_skill: { skillId: 'x' },
  redraw_image: { attachmentId: 'x', positivePrompt: 'x' },
  reverse_prompt: { attachmentId: 'x' },
  save_prompt_preset: { name: 'x', prompt: 'x' },
  search_artists: {},
  search_gallery: { source: 'danbooru', query: 'x' },
  search_memories: { query: 'x' },
  search_prompt_presets: {},
  search_reference_presets: {},
  search_tags: { query: 'x' },
  search_web: { query: 'x' },
  set_current_proposal: { proposalId: 'x', revision: 1, expectedSelectionRevision: 0 },
  upscale_image: { attachmentId: 'x', scale: 2 },
};

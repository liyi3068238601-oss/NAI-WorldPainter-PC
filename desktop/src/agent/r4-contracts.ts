import Ajv2020 from 'ajv/dist/2020.js';
import rawRegistry from './r4-registry.json';

export const R4_REGISTRY_SHA256 = '0142e7af90b47413c363c9e95e66950a7dc217fb545921545c1e20777309b72a';

export const R4_TOOL_NAMES = [
  'get_capabilities', 'read_generation_state', 'list_history', 'search_tags',
  'search_artists', 'search_gallery', 'search_web', 'search_prompt_presets',
  'search_reference_presets', 'read_image_metadata', 'search_memories', 'read_skill',
  'read_prompting_reference', 'ask_user', 'get_execution', 'propose_prompt',
  'read_creation', 'read_proposal', 'set_current_proposal', 'apply_prompt',
  'write_workbench_prompts', 'write_workbench_parameters',
  'save_prompt_preset', 'read_prompt_template', 'manage_prompt_templates',
  'convert_prompt', 'edit_prompt', 'reverse_prompt', 'prepare_generation',
  'generate_image', 'redraw_image', 'inpaint_image', 'upscale_image', 'process_image',
  'cancel_execution', 'propose_memory', 'delete_memory_candidate', 'patch_creation_inputs',
] as const;

export type R4ToolName = (typeof R4_TOOL_NAMES)[number];

export interface R4ToolDefinition {
  canonical: R4ToolName;
  schemaVersion: string;
  description: string;
  modelFields: string[];
  hostInjectedFields: string[];
  inputSchema: object;
  resultSchema: object;
  availability: { exposure: string; group: string; requires: string[]; when: string };
  effect: string;
  approval: string;
  cost: { paid: boolean; mayCharge: boolean; chargeKinds: string[]; estimate: string };
  classification: { readonly: boolean; paid: boolean; image: boolean };
  [key: string]: unknown;
}

export interface R4Registry {
  $schema: string;
  $id: string;
  registryVersion: string;
  designState: string;
  title: string;
  tools: R4ToolDefinition[];
  toolCount: number;
  toolNames: R4ToolName[];
  groupCatalog: Array<{ groupId: string; canonicalTools: R4ToolName[]; alwaysOn: boolean }>;
  [key: string]: unknown;
}

/** Immutable design contract. This module validates schemas; it does not grant capabilities or approval. */
export const registry = rawRegistry as unknown as R4Registry;

const definitions = new Map<R4ToolName, R4ToolDefinition>();
for (const tool of registry.tools) {
  if (definitions.has(tool.canonical)) throw new Error(`Duplicate R4 tool definition: ${tool.canonical}`);
  definitions.set(tool.canonical, tool);
}

if (definitions.size !== R4_TOOL_NAMES.length || R4_TOOL_NAMES.some(name => !definitions.has(name))) {
  throw new Error('R4 tool-name index does not match the registry.');
}

/** Returns undefined for an unknown name so callers can turn it into a preflight rejection. */
export function r4Tool(name: string): R4ToolDefinition | undefined {
  return definitions.get(name as R4ToolName);
}

const ajv = new Ajv2020({
  allErrors: true,
  strict: false,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
});

type Validator = ReturnType<Ajv2020['compile']>;
type ValidationError = Readonly<{
  keyword: string;
  instancePath: string;
  schemaPath: string;
  message?: string;
  params: Record<string, unknown>;
}>;

export type R4InputValidation =
  | { valid: true; tool: R4ToolName }
  | { valid: false; resultKind: 'preflight_failure'; errors: ValidationError[] };

export type R4ResultValidation =
  | { valid: true; tool: R4ToolName }
  | { valid: false; kind: 'invalid_result'; errors: ValidationError[] };

const inputValidators = new Map<R4ToolName, Validator>();
const resultValidators = new Map<R4ToolName, Validator>();
for (const tool of registry.tools) {
  inputValidators.set(tool.canonical, ajv.compile(tool.inputSchema));
  resultValidators.set(tool.canonical, ajv.compile(tool.resultSchema));
}

function errorsOf(validator: Validator): ValidationError[] {
  return (validator.errors ?? []).map(error => ({
    keyword: error.keyword,
    instancePath: error.instancePath,
    schemaPath: error.schemaPath,
    ...(error.message ? { message: error.message } : {}),
    params: { ...error.params },
  }));
}

/** Invalid model input is a preflight rejection; callers must reject before authorization or handlers. */
export function validateR4Input(name: string, input: unknown): R4InputValidation {
  const tool = r4Tool(name);
  if (!tool) {
    return {
      valid: false,
      resultKind: 'preflight_failure',
      errors: [{
        keyword: 'toolName', instancePath: '', schemaPath: '',
        message: 'Tool is not in the R4 registry.', params: { name },
      }],
    };
  }
  const validator = inputValidators.get(tool.canonical)!;
  return validator(input)
    ? { valid: true, tool: tool.canonical }
    : { valid: false, resultKind: 'preflight_failure', errors: errorsOf(validator) };
}

/** A bad result may follow a side effect, so it is never mislabeled as preflight_failure. */
export function validateR4Result(name: string, result: unknown): R4ResultValidation {
  const tool = r4Tool(name);
  if (!tool) {
    return {
      valid: false,
      kind: 'invalid_result',
      errors: [{
        keyword: 'toolName', instancePath: '', schemaPath: '',
        message: 'Tool is not in the R4 registry.', params: { name },
      }],
    };
  }
  const validator = resultValidators.get(tool.canonical)!;
  return validator(result)
    ? { valid: true, tool: tool.canonical }
    : { valid: false, kind: 'invalid_result', errors: errorsOf(validator) };
}

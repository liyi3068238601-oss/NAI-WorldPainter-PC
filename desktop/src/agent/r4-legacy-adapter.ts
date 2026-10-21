import {
  r4Tool,
  validateR4Input,
  validateR4Result,
  type R4ToolName,
} from './r4-contracts';

export interface R4LegacyScope {
  conversationId: string;
  creationId: string;
}

export interface R4ResolvedAttachment {
  artifactId: string;
  attachmentId: string;
  attachmentRevision: string;
  hash: string;
  conversationId: string;
  creationId: string;
  outputIndex: number;
  parentAttachmentId: string | null;
  resolvedSeed: number | null;
  resolvedSeedSource: 'provider' | 'verified_embedded' | null;
  role?: 'discussion' | 'reference' | 'source' | 'mask' | 'output' | 'edit_source';
  includeInGeneration?: boolean;
  referencePurpose?: 'color' | 'composition' | 'character' | 'atmosphere';
}

export interface R4LegacyAttachmentInput {
  attachmentId: string;
  scope: R4LegacyScope;
  legacyAttachment?: unknown;
  legacyRecord?: unknown;
}

export interface R4LegacyCapabilitySnapshot {
  catalogStatus: 'ok' | 'partial';
  catalogVersion: string;
  approvalMode: 'confirm' | 'auto';
  available: Array<{ group: string; toolNames: string[]; capabilityKeys: string[] }>;
  mounted: string[];
  requestedGroups: string[];
  requestedDenied: Array<{ group: string; reason: string }>;
  providerProjectionStatus: 'not_implemented' | 'host_only';
}

export interface R4LegacyWorkbenchSnapshot {
  draftId: string;
  draftRevision: number;
  inputRevision: number;
  draftSource?: 'workbench' | 'default';
  /** Captured from the same live renderer revision; overrides persisted legacy params. */
  params?: Record<string, unknown>;
  workbench?: Record<string, unknown>;
}

export interface R4LegacyAdapterDependencies {
  /** Host-owned capability state; the legacy capability text is not a catalog. */
  capabilitySnapshot?: R4LegacyCapabilitySnapshot;
  /** The legacy read handler has settings only; current draft identity/revisions come from the host. */
  workbenchSnapshot?: R4LegacyWorkbenchSnapshot;
  /** Must resolve current ownership/revision and hash readable bytes; never derive a hash from an ID or path. */
  resolveAttachment?: (input: R4LegacyAttachmentInput) => R4ResolvedAttachment | undefined | Promise<R4ResolvedAttachment | undefined>;
  /** A validated host snapshot may provide templateRevision when legacy tools omit it. */
  verifiedTemplateRevision?: (name: R4ToolName, args: Record<string, unknown>) => string | undefined;
  /** Skill records have no version field in the current legacy model. */
  skillMetadata?: (skillId: string) => { source: string; version: string } | undefined;
  /** Prompting-reference version/source are owned by the host knowledge catalog. */
  promptingReferenceMetadata?: (reference: string) => { source: string; version: string } | undefined;
  /** Capture the candidate scope before a destructive legacy delete removes it. */
  resolveCandidateScope?: (candidateId: string) => 'global' | 'conversation' | undefined | Promise<'global' | 'conversation' | undefined>;
}

export interface R4LegacyToolResponse {
  ok: boolean;
  title?: string;
  output?: string;
  data?: unknown;
  generatedImages?: unknown[];
}

export interface R4AdaptedLegacyResult {
  result: Record<string, unknown>;
  /** UI-only legacy attachments; never copied into model-visible canonical data. */
  generatedImages?: unknown[];
  /** Original host-only text receipt, retained for UI/audit fields absent from the fixed schema. */
  legacyOutput?: string;
}

const HOST_IMPLEMENTED_TOOLS = new Set<R4ToolName>([
  'get_execution', 'propose_prompt', 'read_creation', 'read_proposal',
  'set_current_proposal', 'apply_prompt', 'prepare_generation', 'generate_image',
  'redraw_image', 'inpaint_image', 'upscale_image', 'process_image',
  'cancel_execution', 'patch_creation_inputs',
]);

const TARGET_FIELDS = new Set(['targetConversationId', 'targetCreationId']);
const SERVICE_TOOLS = new Set<R4ToolName>(['convert_prompt', 'edit_prompt', 'reverse_prompt']);

type Row = Record<string, unknown>;
type ToolResultStatus = 'accepted' | 'completed' | 'denied' | 'cancelled' | 'blocked' | 'error';

function isRow(value: unknown): value is Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function row(value: unknown, label: string): Row {
  if (!isRow(value)) throw new Error(`R4 legacy adapter: ${label} must be an object.`);
  return value;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`R4 legacy adapter: ${label} must be an array.`);
  return value;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`R4 legacy adapter: ${label} is missing.`);
  return value;
}

function number(value:unknown,fallback:number,min:number,max:number){
  const parsed=typeof value==='number'?value:Number(value);
  return Number.isFinite(parsed)?Math.min(max,Math.max(min,parsed)):fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function resultRecord(
  _name: R4ToolName,
  status: ToolResultStatus,
  data: Row,
  scope: R4LegacyScope,
  error?: { code: string; message: string; allowedActions: string[] },
): Row {
  return {
    resultKind: 'business', status,
    conversationId: scope.conversationId,
    creationId: scope.creationId,
    data,
    ...(error ? { error } : {}),
  };
}

function validated(name: R4ToolName, result: Row): Row {
  const checked = validateR4Result(name, result);
  if (!checked.valid) {
    const summary = checked.errors.map(error => `${error.instancePath || '/'} ${error.message ?? error.keyword}`).join('; ');
    throw new Error(`R4 legacy adapter could not produce a valid ${name} result: ${summary}`);
  }
  return result;
}

function requireLegacyHandler(name: string): { canonical: R4ToolName; handler: string } {
  const tool = r4Tool(name);
  if (!tool) throw new Error(`R4 legacy adapter: unknown tool ${name}.`);
  if (HOST_IMPLEMENTED_TOOLS.has(tool.canonical)) {
    throw new Error(`R4 legacy adapter: ${tool.canonical} is handled by the R4 host.`);
  }
  if (typeof tool.legacyHandler !== 'string' || !tool.legacyHandler) {
    throw new Error(`R4 legacy adapter: ${tool.canonical} has no legacy handler.`);
  }
  return { canonical: tool.canonical, handler: tool.legacyHandler };
}

/** Map only declared model fields. Target scope, revision checks, and host-only values stay out of legacy args. */
export function mapR4LegacyArgs(name: string, args: unknown): Row {
  const tool = r4Tool(name);
  if (!tool) throw new Error(`R4 legacy adapter: unknown tool ${name}.`);
  if (tool.canonical === 'apply_prompt' || !tool.legacyHandler) {
    throw new Error(`R4 legacy adapter: ${tool.canonical} has no legacy-argument mapping.`);
  }
  const checked = validateR4Input(name, args);
  if (!checked.valid) throw new Error(`R4 legacy adapter: invalid ${name} input must be rejected in preflight.`);
  const input = row(args, 'input');
  const fieldMappings = row(tool.fieldMappings, 'fieldMappings');
  const modelToLegacy = isRow(fieldMappings.modelToLegacy) ? fieldMappings.modelToLegacy : {};
  const output: Row = {};

  for (const field of tool.modelFields) {
    if (TARGET_FIELDS.has(field) || !Object.prototype.hasOwnProperty.call(input, field)) continue;
    const mapped = modelToLegacy[field];
    if (mapped !== undefined) {
      // A prose instruction in the registry denotes host resolution, not a legacy property name.
      if (typeof mapped !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(mapped)) continue;
      output[mapped] = input[field];
    } else {
      output[field] = input[field];
    }
  }

  if (tool.canonical === 'manage_prompt_templates' && input.action === 'restore') {
    // The registry explicitly declares this synthesis; the model cannot supply restoreDefault.
    output.body = '';
    output.restoreDefault = true;
  }
  return output;
}

function responseData(response: R4LegacyToolResponse, label: string): Row {
  return row(response.data, `${label} data`);
}

function requireSuccessfulRead(response: R4LegacyToolResponse, name: R4ToolName): void {
  if (!response.ok) throw new Error(`R4 legacy adapter: ${name} did not return a successful read: ${messageOf(response)}`);
}

function messageOf(response: R4LegacyToolResponse): string {
  if (typeof response.data === 'string' && response.data.trim()) return response.data;
  if (isRow(response.data) && typeof response.data.message === 'string' && response.data.message.trim()) return response.data.message;
  if (typeof response.output === 'string' && response.output.trim()) return response.output;
  return `Legacy handler ${response.ok ? 'returned an unusable result' : 'failed without a message'}.`;
}

function copyFields(source: Row, keys: readonly string[]): Row {
  const copied: Row = {};
  for (const key of keys) if (Object.prototype.hasOwnProperty.call(source, key)) copied[key] = source[key];
  return copied;
}

function serviceTemplateData(data: Row, args: Row, dependencies: R4LegacyAdapterDependencies, name: R4ToolName): Row {
  const template = isRow(data.template) ? data.template : {};
  const revision = dependencies.verifiedTemplateRevision?.(name, args)
    ?? optionalString(template.revision);
  const output: Row = {};
  if (revision) output.templateRevision = revision;
  if (typeof template.source === 'string') output.source = template.source;
  if (typeof template.bodySha256 === 'string') output.bodySha256 = template.bodySha256;
  return output;
}

function legacyImage(response: R4LegacyToolResponse, attachmentId: string): unknown {
  return response.generatedImages?.find(item => isRow(item) && item.id === attachmentId);
}

async function resolveAttachment(
  dependency: R4LegacyAdapterDependencies['resolveAttachment'],
  input: R4LegacyAttachmentInput,
): Promise<R4ResolvedAttachment> {
  if (!dependency) throw new Error('R4 legacy adapter: an ownership-checked readable attachment resolver is required.');
  const resolved = await dependency(input);
  if (!resolved) throw new Error(`R4 legacy adapter: attachment ${input.attachmentId} cannot be resolved safely.`);
  return resolved;
}

function identityFields(
  attachment: R4ResolvedAttachment,
  expected: { scope: R4LegacyScope; attachmentId: string },
): Row {
  if (attachment.attachmentId !== expected.attachmentId
      || attachment.conversationId !== expected.scope.conversationId
      || attachment.creationId !== expected.scope.creationId) {
    throw new Error('R4 legacy adapter: resolved attachment ownership does not match the requested target and scope.');
  }
  if (!Number.isInteger(attachment.outputIndex) || attachment.outputIndex < 0
      || !/^[0-9a-f]{64}$/i.test(attachment.hash)) {
    throw new Error('R4 legacy adapter: resolved attachment needs a valid outputIndex and verified SHA-256 hash.');
  }
  return {
    artifactId: nonEmptyString(attachment.artifactId, 'artifactId'),
    attachmentId: nonEmptyString(attachment.attachmentId, 'attachmentId'),
    conversationId: nonEmptyString(attachment.conversationId, 'attachment conversationId'),
    creationId: nonEmptyString(attachment.creationId, 'attachment creationId'),
    outputIndex: attachment.outputIndex,
    attachmentRevision: nonEmptyString(attachment.attachmentRevision, 'attachmentRevision'),
    hash: nonEmptyString(attachment.hash, 'attachment hash'),
    parentAttachmentId: attachment.parentAttachmentId,
  };
}

function tagCategory(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value !== 'number') return undefined;
  return ({ 0: 'general', 1: 'artist', 3: 'copyright', 4: 'character', 5: 'meta' } as Record<number, string>)[value] ?? String(value);
}

function itemSource(data: Row, item: Row): string | undefined {
  return optionalString(item.source) ?? optionalString(data.source) ?? optionalString(data.provider);
}

function asResultList(value: unknown, label: string): Row[] {
  return array(value, label).map((item, index) => row(item, `${label}[${index}]`));
}

function mapQuestionAnswers(args: Row, data: Row): Row {
  const questions = asResultList(args.questions, 'questions');
  const rawAnswers = Array.isArray(data.answers) ? asResultList(data.answers, 'answers') : [];
  const mapped = rawAnswers.map((answer, answerIndex) => {
    const questionIndex = typeof answer.questionIndex === 'number'
      ? answer.questionIndex
      : questions.findIndex(question => question.prompt === answer.question);
    if (!Number.isInteger(questionIndex) || questionIndex < 0 || questionIndex >= questions.length) {
      throw new Error('R4 legacy adapter: user answer does not identify one of the requested questions.');
    }
    const result: Row = { questionIndex };
    const question = questions[questionIndex];
    const options = Array.isArray(question.options) ? asResultList(question.options, `questions[${questionIndex}].options`) : [];
    if (typeof answer.selectedOptionIndex === 'number') result.selectedOptionIndex = answer.selectedOptionIndex;
    else if (typeof answer.optionId === 'string') {
      const index = options.findIndex(option => option.id === answer.optionId);
      if (index < 0) throw new Error(`R4 legacy adapter: selected option for answer ${answerIndex} is absent from the request.`);
      result.selectedOptionIndex = index;
    } else if (typeof answer.label === 'string') {
      const index = options.findIndex(option => option.label === answer.label);
      if (index >= 0) result.selectedOptionIndex = index;
      else result.freeText = answer.label;
    }
    if (typeof answer.text === 'string') result.freeText = answer.text;
    return result;
  });
  const cancelled = data.cancelled === true;
  return {
    answerStatus: cancelled ? 'cancelled' : mapped.length === 0 ? 'unanswered' : mapped.length < questions.length ? 'unanswered' : 'answered',
    ...(mapped.length ? { answers: mapped } : {}),
    ...(typeof data.answeredAt === 'string' ? { answeredAt: data.answeredAt } : {}),
  };
}

function candidateMatches(memory: Row, args: Row, scope: R4LegacyScope): boolean {
  const trigger = String(args.trigger ?? args.title ?? '').trim().slice(0, 200).toLocaleLowerCase();
  const content = typeof args.content === 'string' ? args.content.slice(0, 8_000) : '';
  const requestedScope = args.scope === 'conversation' ? 'conversation' : 'global';
  return memory.source === 'pendingLlmCandidate'
    && memory.type === args.category
    && String(memory.trigger ?? memory.title ?? '').trim().toLocaleLowerCase() === trigger
    && memory.content === content
    && memory.scope === requestedScope
    && (requestedScope !== 'conversation' || memory.conversationId === scope.conversationId);
}

/** Normalize a real legacy response to the strict R4 result schema. This never grants permission or approval. */
export async function adaptR4LegacyResult(
  name: string,
  args: unknown,
  legacyResponse: R4LegacyToolResponse,
  scope: R4LegacyScope,
  dependencies: R4LegacyAdapterDependencies = {},
): Promise<R4AdaptedLegacyResult> {
  const { canonical } = requireLegacyHandler(name);
  const checked = validateR4Input(name, args);
  if (!checked.valid) throw new Error(`R4 legacy adapter: invalid ${name} input must be rejected in preflight.`);
  const input = row(args, 'input');
  nonEmptyString(scope.conversationId, 'conversationId');
  nonEmptyString(scope.creationId, 'creationId');
  const response = legacyResponse;
  let result: Row;

  if (canonical === 'get_capabilities') {
    if (!response.ok || !dependencies.capabilitySnapshot) throw new Error('R4 legacy adapter: get_capabilities requires a host capability snapshot.');
    result = resultRecord(canonical, 'completed', { ...dependencies.capabilitySnapshot }, scope);
  } else if (canonical === 'read_generation_state') {
    if (!response.ok) {
      const message = messageOf(response);
      const readStatus = /not found|missing|不存在|未找到/i.test(message) ? 'not_found' : 'unavailable';
      result = resultRecord(canonical, 'completed', { readStatus }, scope);
    } else {
      const data = responseData(response, canonical);
      const workbench = dependencies.workbenchSnapshot;
      if (!workbench) throw new Error('R4 legacy adapter: read_generation_state requires the host workbench snapshot.');
      const rawParams = row(workbench.params ?? data.params, 'generation params');
      const allowedParams = [
        'positivePrompt', 'negativePrompt', 'stylePrompt', 'model', 'width', 'height', 'steps',
        'cfgScale', 'cfgRescale', 'seed', 'seedMode', 'sampler', 'noiseSchedule', 'smea',
        'smeaDyn', 'variety', 'effort', 'qualityPreset', 'ucPreset', 'transparentBackground',
      ] as const;
      const mapped: Row = {
        readStatus: 'ok',
        draftId: nonEmptyString(workbench.draftId, 'draftId'),
        draftRevision: workbench.draftRevision,
        inputRevision: workbench.inputRevision,
        params: copyFields(rawParams, allowedParams),
      };
      if (workbench.draftSource) mapped.draftSource = workbench.draftSource;
      if(workbench.workbench){
        const live=workbench.workbench,source=isRow(live.source)?live.source:undefined;
        const dims=source&&Number.isSafeInteger(source.width)&&Number.isSafeInteger(source.height)?{width:Number(source.width),height:Number(source.height)}:null;
        const captions=Array.isArray(live.charCaptions)?live.charCaptions.filter(isRow).slice(0,32).flatMap(item=>typeof item.prompt==='string'?[{
          ...(typeof item.name==='string'?{name:item.name.slice(0,64)}:{}),prompt:item.prompt.slice(0,20_000),negativePrompt:typeof item.negativePrompt==='string'?item.negativePrompt.slice(0,20_000):'',enabled:item.enabled!==false,
          useCoords:item.useCoords===true,x:number(item.x,0.5,0,1),y:number(item.y,0.5,0,1),
        }]:[]):[];
        const vibes=Array.isArray(live.vibeImages)?live.vibeImages.filter(isRow).slice(0,16).map(item=>({...(typeof item.name==='string'?{name:item.name.slice(0,200)}:{}),
          strength:number(item.strength,0,0,1),infoExtracted:number(item.infoExtracted,1,0,1)})):[];
        const precise=Array.isArray(live.preciseReferences)?live.preciseReferences.filter(isRow).slice(0,16).map(item=>({
          type:item.type==='style'||item.type==='character&style'?item.type:'character',strength:number(item.strength,1,0,1),fidelity:number(item.fidelity,1,0,1)})):[];
        const busy=isRow(live.busy)?live.busy:{};
        mapped.workbench={mode:typeof live.mode==='string'?live.mode:'generate:t2i',historyGroupId:typeof live.historyGroupId==='string'?live.historyGroupId:undefined,
          modelMode:live.modelMode==='furry'?'furry':'anime',batchCount:number(live.batchCount,1,1,999),
          sourceMode:typeof live.sourceMode==='string'?live.sourceMode:'latest',sourceAvailable:Boolean(source?.filePath),sourceDimensions:dims,
          maskAvailable:typeof live.mask==='string'&&live.mask.length>0,maskRevision:number(live.maskRevision,0,0,Number.MAX_SAFE_INTEGER),
          characterPrompts:captions,vibeReferences:vibes,preciseReferences:precise,
          busy:{isGenerating:busy.isGenerating===true,isGenerateQueueRunning:busy.isGenerateQueueRunning===true,batchRunning:busy.batchRunning===true}};
      }
      const imageProvider = data.imageProvider;
      const providerName = typeof imageProvider === 'string' ? imageProvider : isRow(imageProvider) ? imageProvider.provider : undefined;
      if (providerName === 'novelai' || providerName === 'openai-images') mapped.imageProvider = providerName;
      if (data.modelMode === 'anime' || data.modelMode === 'furry') mapped.modelMode = data.modelMode;
      if (data.referenceCapabilities !== undefined) mapped.referenceCapabilities = data.referenceCapabilities;
      result = resultRecord(canonical, 'completed', mapped, scope);
    }
  } else if (canonical === 'list_history') {
    requireSuccessfulRead(response, canonical);
    const data = responseData(response, canonical);
    const sourceItems = asResultList(data.items, 'history items');
    const generated: Row[] = [];
    for (const [index, item] of sourceItems.entries()) {
      const attachmentId = nonEmptyString(item.attachmentId, `history items[${index}].attachmentId`);
      const resolved = await resolveAttachment(dependencies.resolveAttachment, {
        attachmentId, scope, legacyAttachment: legacyImage(response, attachmentId), legacyRecord: item,
      });
      generated.push({
        ...copyFields(item, [
          'name', 'createdAt', 'date', 'seed', 'model', 'width', 'height', 'positivePrompt',
          'stylePrompt', 'negativePrompt', 'groupId',
        ]),
        ...identityFields(resolved, { scope, attachmentId }),
        resolvedSeed: resolved.resolvedSeed,
        resolvedSeedSource: resolved.resolvedSeedSource,
      });
    }
    const groups = Array.isArray(data.groups) ? data.groups.map((value, index) => {
      const item = row(value, `history groups[${index}]`);
      return copyFields(item, ['groupId', 'label']);
    }) : undefined;
    result = resultRecord(canonical, 'completed', {
      readStatus: generated.length ? 'ok' : 'no_match', items: generated,
      ...(typeof data.nextCursor === 'string' ? { nextCursor: data.nextCursor } : {}),
      ...(groups ? { groups } : {}),
    }, scope);
  } else if (canonical === 'search_tags') {
    requireSuccessfulRead(response, canonical);
    const data = array(response.data, 'tag results');
    const items = asResultList(data, 'tag results').map(item => ({
      tag: nonEmptyString(item.tag, 'tag'),
      ...(tagCategory(item.category) ? { category: tagCategory(item.category) } : {}),
      ...(typeof item.score === 'number' ? { score: item.score } : {}),
      ...(typeof item.source === 'string' ? { source: item.source } : {}),
    }));
    result = resultRecord(canonical, 'completed', {
      searchStatus: items.length ? 'ok' : 'no_match',
      query: nonEmptyString(input.query, 'query'), items,
    }, scope);
  } else if (canonical === 'search_artists') {
    requireSuccessfulRead(response, canonical);
    const data = responseData(response, canonical);
    const sourceItems = asResultList(data.items, 'artist results');
    const items = sourceItems.map(item => {
      const name = nonEmptyString(item.name ?? item.tag, 'artist name');
      return {
        ...(typeof item.id === 'string' ? { id: item.id } : {}),
        name,
        ...(typeof item.scope === 'string' || typeof input.scope === 'string' ? { scope: item.scope ?? input.scope } : {}),
        ...(typeof item.prompt === 'string' ? { prompt: item.prompt } : typeof item.tag === 'string' ? { prompt: item.tag } : {}),
        ...(itemSource(data, item) ? { source: itemSource(data, item) } : {}),
      };
    });
    result = resultRecord(canonical, 'completed', {
      searchStatus: items.length ? 'ok' : 'no_match', items,
      ...(typeof input.query === 'string' ? { query: input.query } : {}),
    }, scope);
  } else if (canonical === 'search_gallery') {
    requireSuccessfulRead(response, canonical);
    const data = responseData(response, canonical);
    const sourceItems = asResultList(data.items, 'gallery items');
    const items = sourceItems.map(item => {
      const cover = isRow(item.cover) ? item.cover : {};
      const tags = isRow(item.tags)
        ? Object.values(item.tags).flatMap(value => Array.isArray(value) ? value : [])
        : Array.isArray(item.tags) ? item.tags : undefined;
      const rating = optionalString(item.rating)?.toLocaleLowerCase();
      const safe = rating === 'safe' || rating === 'general' ? true : rating ? false : undefined;
      const url = optionalString(item.sourceUrl) ?? optionalString(cover.sourceUrl) ?? optionalString(cover.displayUrl);
      return {
        ...(typeof item.id === 'string' ? { id: item.id } : {}),
        ...(typeof item.title === 'string' ? { title: item.title } : {}),
        url: nonEmptyString(url, 'gallery source URL'),
        ...(typeof cover.previewUrl === 'string' ? { thumbnailUrl: cover.previewUrl } : {}),
        ...(tags ? { tags } : {}),
        ...(safe !== undefined ? { safe } : {}),
      };
    });
    const source = input.source;
    if (!['danbooru', 'safebooru', 'gelbooru', 'quicktag'].includes(String(source))) throw new Error('R4 legacy adapter: unsupported gallery source.');
    result = resultRecord(canonical, 'completed', {
      searchStatus: items.length ? 'ok' : 'no_match', source, items,
      page: typeof data.page === 'number' ? data.page : input.page,
      safeOnly: typeof input.safeOnly === 'boolean' ? input.safeOnly : true,
    }, scope);
  } else if (canonical === 'search_web') {
    requireSuccessfulRead(response, canonical);
    const data = responseData(response, canonical);
    const sourceItems = asResultList(data.sources ?? data.items, 'web sources');
    const items = sourceItems.map(item => ({
      title: nonEmptyString(item.title, 'web result title'),
      url: nonEmptyString(item.url, 'web result URL'),
      ...(typeof item.snippet === 'string' ? { snippet: item.snippet } : {}),
      ...(typeof item.publishedAt === 'string' ? { publishedAt: item.publishedAt } : {}),
      ...(typeof item.source === 'string' ? { source: item.source } : typeof data.provider === 'string' ? { source: data.provider } : {}),
    }));
    result = resultRecord(canonical, 'completed', {
      searchStatus: items.length ? 'ok' : 'no_match', query: nonEmptyString(input.query, 'query'), items,
    }, scope);
  } else if (canonical === 'search_prompt_presets') {
    requireSuccessfulRead(response, canonical);
    const data = responseData(response, canonical);
    const sourceItems = asResultList(data.items, 'prompt presets');
    const items = sourceItems.map(item => copyFields(item, [
      'id', 'kind', 'name', 'prompt', 'group', 'promptTruncated', 'previewImageCount', 'createdAt',
    ]));
    const total = typeof data.total === 'number' ? data.total : items.length;
    result = resultRecord(canonical, 'completed', {
      searchStatus: items.length ? 'ok' : 'no_match', total, items,
    }, scope);
  } else if (canonical === 'search_reference_presets') {
    requireSuccessfulRead(response, canonical);
    const data = responseData(response, canonical);
    const sourceItems = asResultList(data.items, 'reference presets');
    const items: Row[] = [];
    for (const [index, item] of sourceItems.entries()) {
      const attachmentId = nonEmptyString(item.attachmentId, `reference presets[${index}].attachmentId`);
      const resolved = await resolveAttachment(dependencies.resolveAttachment, {
        attachmentId, scope, legacyAttachment: legacyImage(response, attachmentId), legacyRecord: item,
      });
      const entry: Row = {
        ...identityFields(resolved, { scope, attachmentId }),
        presetId: nonEmptyString(item.presetId, 'presetId'),
        name: nonEmptyString(item.name, 'reference preset name'),
        kind: item.kind,
        includeInGeneration: false,
        ...copyFields(item, ['originalName', 'group', 'width', 'height']),
      };
      if (item.kind === 'vibe' && isRow(item.vibeReference)) {
        const vibe = copyFields(item.vibeReference, ['infoExtracted', 'strength']);
        if (typeof vibe.strength !== 'number') throw new Error(`R4 legacy adapter: reference preset ${attachmentId} has no vibe strength.`);
        entry.vibeReference = vibe;
      }
      if (item.kind === 'precise' && isRow(item.preciseReference)) {
        const precise = copyFields(item.preciseReference, ['type', 'strength', 'fidelity']);
        if (precise.type === undefined || typeof precise.strength !== 'number' || typeof precise.fidelity !== 'number') {
          throw new Error(`R4 legacy adapter: reference preset ${attachmentId} has incomplete precise-reference data.`);
        }
        entry.preciseReference = precise;
      }
      items.push(entry);
    }
    const groups = Array.isArray(data.groups) ? data.groups.map(group => typeof group === 'string' ? group : isRow(group) ? String(group.group ?? group.name ?? '') : '') : undefined;
    result = resultRecord(canonical, 'completed', {
      searchStatus: items.length ? 'ok' : 'no_match', total: typeof data.total === 'number' ? data.total : items.length,
      items, ...(groups ? { groups: groups.filter(Boolean) } : {}),
    }, scope);
  } else if (canonical === 'read_image_metadata') {
    if (!response.ok) {
      const fallback = {
        readStatus: 'unavailable', attachmentId: nonEmptyString(input.attachmentId, 'attachmentId'),
        found: false, kind: 'unknown', warnings: [messageOf(response)],
      };
      result = resultRecord(canonical, 'completed', fallback, scope);
    } else {
      const data = responseData(response, canonical);
      const mapped = copyFields(data, [
        'attachmentId', 'found', 'kind', 'software', 'parameters', 'characterPrompts',
        'fields', 'fieldsTruncated', 'warnings',
      ]);
      mapped.readStatus = data.readStatus === 'not_found' || data.readStatus === 'stale' || data.readStatus === 'unavailable'
        ? data.readStatus
        : 'ok';
      if (dependencies.resolveAttachment && typeof data.attachmentId === 'string') {
        const resolved = await resolveAttachment(dependencies.resolveAttachment, {
          attachmentId: data.attachmentId, scope, legacyAttachment: legacyImage(response, data.attachmentId),
        });
        mapped.attachment = {
          ...identityFields(resolved, { scope, attachmentId: data.attachmentId }),
          ...(resolved.role ? { role: resolved.role } : {}),
          ...(typeof resolved.includeInGeneration === 'boolean' ? { includeInGeneration: resolved.includeInGeneration } : {}),
          ...(resolved.referencePurpose ? { referencePurpose: resolved.referencePurpose } : {}),
        };
      }
      result = resultRecord(canonical, 'completed', mapped, scope);
    }
  } else if (canonical === 'search_memories') {
    requireSuccessfulRead(response, canonical);
    const sourceItems = asResultList(response.data, 'memories');
    const items = sourceItems.map(item => copyFields(item, ['id', 'title', 'type', 'scope', 'content', 'updatedAt']));
    result = resultRecord(canonical, 'completed', {
      searchStatus: items.length ? 'ok' : 'no_match', query: nonEmptyString(input.query, 'query'), items,
    }, scope);
  } else if (canonical === 'read_skill') {
    const skillId = nonEmptyString(input.skillId, 'skillId');
    if (!response.ok || !isRow(response.data)) {
      result = resultRecord(canonical, 'completed', {
        readStatus: /disabled|removed|not applicable|停用|移除|不适用/i.test(messageOf(response)) ? 'not_found' : 'unavailable',
        skillId, title: null, body: null, source: null, version: null,
      }, scope);
    } else {
      const data = response.data;
      const metadata = dependencies.skillMetadata?.(skillId);
      const source = optionalString(data.source) ?? metadata?.source;
      const version = optionalString(data.version) ?? metadata?.version;
      if (!source || !version) throw new Error('R4 legacy adapter: read_skill requires host-provided source and version metadata.');
      result = resultRecord(canonical, 'completed', {
        readStatus: 'ok', skillId,
        title: nonEmptyString(data.title ?? data.name, 'skill title'),
        body: nonEmptyString(data.body ?? data.instructions, 'skill body'), source, version,
      }, scope);
    }
  } else if (canonical === 'read_prompting_reference') {
    const reference = nonEmptyString(input.reference, 'reference');
    if (!response.ok) {
      result = resultRecord(canonical, 'completed', { readStatus: 'unavailable', reference, version: null, content: null, source: null }, scope);
    } else {
      const data = responseData(response, canonical);
      const metadata = dependencies.promptingReferenceMetadata?.(reference);
      const version = optionalString(data.version) ?? metadata?.version;
      const source = optionalString(data.source) ?? metadata?.source;
      if (!version || !source) throw new Error('R4 legacy adapter: read_prompting_reference requires host-provided version and source metadata.');
      result = resultRecord(canonical, 'completed', {
        readStatus: 'ok', reference, version,
        content: nonEmptyString(data.content, 'prompting reference content'), source,
      }, scope);
    }
  } else if (canonical === 'ask_user') {
    requireSuccessfulRead(response, canonical);
    result = resultRecord(canonical, 'completed', mapQuestionAnswers(input, responseData(response, canonical)), scope);
  } else if (canonical === 'save_prompt_preset') {
    if (!response.ok) {
      const prompt = nonEmptyString(input.prompt, 'prompt');
      const name = typeof input.name === 'string' && input.name.trim()
        ? input.name.trim().slice(0, 100)
        : prompt.replace(/[\r\n,，]+/g, ' ').trim().slice(0, 24) || '提示词';
      result = resultRecord(canonical, 'completed', { writeStatus: 'invalid', id: null, name, kind: 'positive', revision: null }, scope);
    } else {
      const preset = responseData(response, canonical);
      result = resultRecord(canonical, 'completed', {
        writeStatus: 'saved', id: nonEmptyString(preset.id, 'saved preset id'),
        name: nonEmptyString(preset.name, 'saved preset name'), kind: 'positive',
        ...(typeof preset.prompt === 'string' ? { prompt: preset.prompt } : {}),
        // New adapter owns the first R4 revision; the legacy preset has no revision field.
        revision: 1,
      }, scope);
    }
  } else if (canonical === 'read_prompt_template') {
    requireSuccessfulRead(response, canonical);
    const data = responseData(response, canonical);
    const missing = data.readStatus === 'not_found';
    const kind = data.kind ?? input.kind ?? 'convert';
    const mode = data.mode ?? input.mode;
    const modelVersion = data.templateVersion ?? input.modelVersion;
    if (mode === undefined || modelVersion === undefined) {
      throw new Error('R4 legacy adapter: read_prompt_template needs the resolved mode and template version from the handler or request.');
    }
    result = resultRecord(canonical, 'completed', {
      readStatus: missing ? 'not_found' : 'ok',
      kind, mode, modelVersion,
      templateRevision: missing ? null : data.revision,
      body: missing ? null : data.body,
      bodySha256: missing ? null : data.bodySha256,
      source: missing ? null : data.source,
    }, scope);
  } else if (canonical === 'manage_prompt_templates') {
    const action = String(input.action);
    if (response.ok) {
      const data = responseData(response, canonical);
      const actionStatus = action === 'read' ? 'read' : action === 'select' ? 'selected' : action === 'restore' ? 'restored' : 'saved';
      result = resultRecord(canonical, 'completed', {
        templateStatus: actionStatus,
        kind: data.kind ?? input.kind ?? 'convert',
        mode: data.mode ?? input.mode,
        modelVersion: data.templateVersion ?? input.modelVersion,
        templateRevision: data.revision,
        ...(typeof data.body === 'string' ? { body: data.body } : {}),
        ...(typeof data.source === 'string' ? { source: data.source } : {}),
        ...(typeof data.backupPath === 'string' ? { backupPath: data.backupPath } : {}),
      }, scope);
    } else {
      const message = messageOf(response);
      const templateStatus = /cancel|取消/i.test(message) ? 'cancelled' : /changed|变化|stale|revision/i.test(message) ? 'conflict' : 'invalid';
      const known = isRow(response.data) ? response.data : {};
      const kind = known.kind ?? input.kind ?? 'convert';
      const mode = known.mode ?? input.mode;
      const modelVersion = known.templateVersion ?? input.modelVersion;
      if (mode === undefined || modelVersion === undefined) throw new Error('R4 legacy adapter: failed template operation needs the resolved mode and modelVersion.');
      const allowedActions = templateStatus === 'cancelled' ? ['continue_without_action'] : templateStatus === 'conflict' ? ['read_proposal', 'continue_without_action'] : ['correct_arguments'];
      result = resultRecord(canonical, 'completed', {
        templateStatus, kind, mode, modelVersion, templateRevision: null,
      }, scope, {
        code: templateStatus === 'cancelled' ? 'user_denied' : templateStatus === 'conflict' ? 'stale_revision' : 'invalid_arguments',
        message, allowedActions,
      });
    }
  } else if (SERVICE_TOOLS.has(canonical)) {
    const data = isRow(response.data) ? response.data : {};
    const templateData = serviceTemplateData(data, input, dependencies, canonical);
    const resultText = canonical === 'reverse_prompt' ? data.prompt : data.result;
    const succeeded = response.ok && typeof resultText === 'string' && resultText.trim().length > 0;
    const serviceData: Row = { serviceStatus: succeeded ? 'succeeded' : 'unknown', ...templateData };
    if (canonical === 'reverse_prompt') {
      serviceData.attachmentId = nonEmptyString(input.attachmentId, 'attachmentId');
      serviceData.isPartial = false;
      if (succeeded) {
        serviceData.candidateText = resultText;
        // The legacy vision service returns no confidence estimate; say so rather than inventing one.
        serviceData.uncertainty = 'The legacy vision result did not include a confidence estimate.';
      }
    } else {
      serviceData.candidateText = succeeded ? resultText : null;
      if (canonical === 'edit_prompt' && typeof data.changeSummary === 'string') serviceData.changeSummary = data.changeSummary;
    }
    const error = succeeded ? undefined : {
      code: 'provider_unknown',
      message: messageOf(response),
      allowedActions: ['do_not_retry_unknown', 'stop_related_paid_calls', 'wait_for_receipt'],
    };
    result = resultRecord(canonical, succeeded ? 'completed' : 'error', serviceData, scope, error);
  } else if (canonical === 'propose_memory') {
    const requestedScope = input.scope === 'conversation' ? 'conversation' : 'global';
    const data = response.ok ? responseData(response, canonical) : {};
    const memories = response.ok && isRow(data.workspace) && Array.isArray(data.workspace.memories)
      ? asResultList(data.workspace.memories, 'workspace memories') : [];
    const matches = memories.filter(memory => candidateMatches(memory, input, scope));
    if (response.ok && matches.length !== 1) throw new Error(`R4 legacy adapter: expected exactly one persisted pending memory candidate, found ${matches.length}.`);
    result = resultRecord(canonical, 'completed', {
      candidateStatus: response.ok ? 'pending' : 'invalid',
      candidateId: response.ok ? nonEmptyString(matches[0].id, 'candidate id') : null,
      ...(input.category !== undefined ? { category: input.category } : {}),
      scope: requestedScope,
    }, scope);
  } else if (canonical === 'delete_memory_candidate') {
    const candidateId = nonEmptyString(input.candidateId, 'candidateId');
    const candidateScope = await dependencies.resolveCandidateScope?.(candidateId);
    if (!candidateScope) throw new Error('R4 legacy adapter: delete_memory_candidate requires the candidate scope captured before deletion.');
    result = resultRecord(canonical, 'completed', {
      deleteStatus: response.ok ? 'deleted' : /not found|不存在|已清理/i.test(messageOf(response)) ? 'not_found' : 'invalid',
      candidateId, scope: candidateScope,
    }, scope);
  } else {
    throw new Error(`R4 legacy adapter: no canonical result mapper for ${canonical}.`);
  }

  const checkedResult = validated(canonical, result);
  return {
    result: checkedResult,
    ...(response.generatedImages?.length ? { generatedImages: response.generatedImages } : {}),
    ...(typeof response.output === 'string' ? { legacyOutput: response.output } : {}),
  };
}

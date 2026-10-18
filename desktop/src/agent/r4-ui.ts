import type {AgentMessage} from './types';
import type {
  R4Artwork,
  R4ConversationCreativeState,
  R4Creation,
  R4DispatchGate,
  R4Execution,
  R4Preparation,
  R4Proposal,
  R4QueuedMessage,
} from './r4-types';

export type R4ConversationScope = 'all' | 'creation';

/** IPC may succeed while the underlying business command is rejected. */
export function r4CommandFailureMessage(result: {ok:boolean;message?:string;data?:Record<string,unknown>},language?:unknown): string | undefined {
  if (!result.ok) return result.message || undefined;
  const envelope=result.data;
  const error=envelope?.error;
  if(envelope?.status==='error'||envelope?.resultKind==='preflight_failure'){
    if(error&&typeof error==='object'&&'message' in error&&typeof error.message==='string')return error.message;
    return result.message||r4Text(language,'操作被拒绝。','The operation was rejected.');
  }
  const payload=envelope?.data&&typeof envelope.data==='object'&&!Array.isArray(envelope.data)
    ?envelope.data as Record<string,unknown>
    :envelope;
  const rejected=(field:string,statuses:readonly string[],zh:string,en:string)=>{
    const value=payload?.[field];
    return typeof value==='string'&&statuses.includes(value)?r4Text(language,zh,en):undefined;
  };
  return rejected('selectionStatus',['conflict'],'当前方案选择已变化，未覆盖新选择。请刷新后重试。','The selected proposal changed; the newer selection was preserved. Refresh before trying again.')
    ??rejected('inputStatus',['conflict'],'创作输入已变化，未覆盖新内容。请刷新后重试。','The creation inputs changed; newer content was preserved. Refresh before trying again.')
    ??rejected('applyStatus',['conflict'],'工作台草稿已变化，没有写入任何字段。请重新预览。','The workbench draft changed; no fields were written. Preview again.')
    ??rejected('submissionStatus',['stale','invalid'],'此生图预览已失效，未提交任务。请重新预览。','This generation preview is stale or invalid; no task was submitted. Preview again.');
}

export function r4Text(language: unknown, chinese: string, english: string): string {
  return typeof language === 'string' && language.toLowerCase().startsWith('en') ? english : chinese;
}

export type R4MessageOwnership =
  | {status: 'bound'; creationId: string}
  | {status: 'legacy_unversioned'}
  | {status: 'conflict'; messageCreationId: string; stateCreationId: string};

type R4MessageLike = Pick<AgentMessage, 'id'> & {creationId?: string};

/** Resolve only explicit, durable ownership. Missing legacy ownership stays unknown. */
export function resolveR4MessageOwnership(
  message: R4MessageLike,
  state?: Pick<R4ConversationCreativeState, 'messageCreationIds'>,
): R4MessageOwnership {
  const messageCreationId = message.creationId;
  const stateCreationId = state?.messageCreationIds[message.id];
  if (messageCreationId && stateCreationId && messageCreationId !== stateCreationId) {
    return {status: 'conflict', messageCreationId, stateCreationId};
  }
  const creationId = messageCreationId ?? stateCreationId;
  return creationId ? {status: 'bound', creationId} : {status: 'legacy_unversioned'};
}

/** The all-chat view preserves every message; creation scope includes only exact ownership. */
export function filterR4Messages<T extends R4MessageLike>(
  messages: readonly T[],
  state: Pick<R4ConversationCreativeState, 'messageCreationIds'> | undefined,
  scope: R4ConversationScope,
  creationId?: string,
): T[] {
  if (scope === 'all' || !creationId) return [...messages];
  return messages.filter(message => {
    const owner = resolveR4MessageOwnership(message, state);
    return owner.status === 'bound' && owner.creationId === creationId;
  });
}

export function r4CreationList(state?: R4ConversationCreativeState): R4Creation[] {
  return Object.values(state?.creations ?? {}).sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
}

/** A current proposal is the explicit creation pointer, never the newest proposal fallback. */
export function r4CurrentProposal(
  state: R4ConversationCreativeState | undefined,
  creation: R4Creation | undefined,
): R4Proposal | undefined {
  if (!state || !creation?.currentProposalRef) return undefined;
  const proposal = state.proposals[creation.currentProposalRef];
  return proposal?.creationId === creation.id ? proposal : undefined;
}

export function r4ProposalsForCreation(
  state: R4ConversationCreativeState | undefined,
  creationId?: string,
): R4Proposal[] {
  if (!state || !creationId) return [];
  return Object.values(state.proposals)
    .filter(proposal => proposal.creationId === creationId)
    .sort((a, b) => b.revision - a.revision || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}

/** Artwork membership is explicit through artworkIds and must agree with creationId. */
export function r4ArtworksForCreation(
  state: R4ConversationCreativeState | undefined,
  creation: R4Creation | undefined,
): R4Artwork[] {
  if (!state || !creation) return [];
  return creation.artworkIds
    .map(id => state.artworks[id])
    .filter((artwork): artwork is R4Artwork => Boolean(artwork && artwork.creationId === creation.id))
    .sort(compareR4Artworks);
}

function compareR4Artworks(a: R4Artwork, b: R4Artwork): number {
  const aIndex = a.outputIndex ?? Number.MAX_SAFE_INTEGER;
  const bIndex = b.outputIndex ?? Number.MAX_SAFE_INTEGER;
  return aIndex - bIndex || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

export type R4ArtworkScope = 'batch' | 'creation';

/** Viewer ranges never cross creation ownership; a batch falls back only to exact executionId. */
export function r4ViewerArtworks(
  artworks: readonly R4Artwork[],
  selectedArtworkId: string,
  scope: R4ArtworkScope,
): R4Artwork[] {
  const selected = artworks.find(item => item.id === selectedArtworkId);
  if (!selected) return [];
  const creationArtworks = artworks.filter(item => item.creationId === selected.creationId).sort(compareR4Artworks);
  if (scope === 'creation') return creationArtworks;
  const batchId = selected.batchId;
  const executionId = selected.executionId;
  const batch = batchId
    ? creationArtworks.filter(item => item.batchId === batchId)
    : executionId
      ? creationArtworks.filter(item => item.executionId === executionId)
      : [selected];
  return batch.includes(selected) ? batch : [selected, ...batch].sort(compareR4Artworks);
}

export function r4PreparationForCreation(
  state: R4ConversationCreativeState | undefined,
  creationId?: string,
): R4Preparation | undefined {
  if (!state || !creationId) return undefined;
  return Object.values(state.preparations)
    .filter(item => item.creationId === creationId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0];
}

export function r4ExecutionsForCreation(
  state: R4ConversationCreativeState | undefined,
  creationId?: string,
): R4Execution[] {
  if (!state || !creationId) return [];
  return Object.values(state.executions)
    .filter(item => item.creationId === creationId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

export function r4QueueForConversation(state?: R4ConversationCreativeState): R4QueuedMessage[] {
  return Object.values(state?.messageQueue ?? {}).sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
}

export function r4GlobalQueue(states: readonly R4ConversationCreativeState[]): R4QueuedMessage[] {
  return states.flatMap(state => Object.values(state.messageQueue))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.sequence - b.sequence || a.id.localeCompare(b.id));
}

export function r4GlobalExecutions(states: readonly R4ConversationCreativeState[]): R4Execution[] {
  return states.flatMap(state => Object.values(state.executions))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export type R4UnknownGateSource = 'paid-service' | 'critique' | 'image-execution' | 'unknown';

export interface R4UnknownGateView {
  gate: R4DispatchGate;
  source: R4UnknownGateSource;
  detail?: string;
  execution?: R4Execution;
}

/** Preserve every active unknown receipt, including paid tools with no image execution. */
export function r4ActiveUnknownGates(states: readonly R4ConversationCreativeState[]): R4UnknownGateView[] {
  const result: R4UnknownGateView[] = [];
  for (const state of states) {
    for (const gate of Object.values(state.gates)) {
      if (!gate.active || gate.reason !== 'unknown_prior_receipt') continue;
      const operation = state.operations[gate.id];
      if (operation?.operation === 'paid_service') {
        const tool = operation.receipt.tool;
        const phase = operation.receipt.phase;
        const detail = [typeof tool === 'string' ? tool : undefined, typeof phase === 'string' ? phase : undefined]
          .filter(Boolean).join(' · ');
        result.push({gate, source: 'paid-service', ...(detail ? {detail} : {})});
        continue;
      }
      const execution = gate.sourceExecutionId ? state.executions[gate.sourceExecutionId] : undefined;
      if (gate.id.startsWith('critique-unknown:')) {
        result.push({gate, source: 'critique', ...(execution ? {execution} : {})});
        continue;
      }
      if (gate.sourceExecutionId) {
        result.push({gate, source: 'image-execution', ...(execution ? {execution} : {})});
        continue;
      }
      result.push({gate, source: 'unknown'});
    }
  }
  return result.sort((a,b)=>a.gate.createdAt.localeCompare(b.gate.createdAt)||a.gate.id.localeCompare(b.gate.id));
}

/** UI affordance for the explicit new-message continuation; the host repeats every check. */
export function r4CanContinueIndependentMessage(item: R4QueuedMessage, gates: readonly R4DispatchGate[]): boolean {
  if (!['queued','paused'].includes(item.status) || item.startedAt
    || item.steeringStatus === 'requested' || item.steeringStatus === 'consumed'
    || item.status === 'error' || /recovered:running|waiting_execution|unknown|side.effect|tool/i.test(item.pauseReason ?? '')) return false;
  return gates.length > 0 && !gates.some(gate => gate.turnId === item.userIntentRef);
}

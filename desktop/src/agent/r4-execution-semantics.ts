import type {
  R4Execution,
  R4ExecutionStatus,
  R4OutputStatus,
  R4ProviderCancellation,
  R4ProviderReceiptStatus,
  R4RequestGranularity,
} from './r4-types';

export interface R4ExecutionSemanticOutput {
  outputIndex: number;
  status: R4OutputStatus;
  errorCode?: string;
}

/** Canonical `get_execution.data` projection checked by the registry fixtures. */
export interface R4ExecutionSemanticData {
  readStatus?: 'ok' | 'not_found' | 'unavailable';
  executionStatus: R4ExecutionStatus;
  expectedOutputCount: number;
  requestGranularity: R4RequestGranularity;
  outputs: ReadonlyArray<R4ExecutionSemanticOutput>;
  providerReceiptStatus: R4ProviderReceiptStatus;
  blockedReason?: string;
  pauseReason?: string;
  requestedSeedPolicy?: 'random' | 'fixed';
  requestedSeed?: number | null;
}

/** Minimal compatibility view for existing aggregate call sites; persistence must pass the full R4Execution. */
export interface R4ExecutionSemanticSnapshot {
  status: R4ExecutionStatus;
  outputs: ReadonlyArray<{ status: R4OutputStatus }>;
  providerReceiptStatus: R4ProviderReceiptStatus;
  providerCancellation: R4ProviderCancellation;
}

export type R4ExecutionSemanticInput = R4ExecutionSemanticData | R4Execution | R4ExecutionSemanticSnapshot;

export type R4ExecutionSemanticRule =
  | 'status:enum'
  | 'cardinality'
  | 'batch'
  | 'priority:unknown'
  | 'priority:pending'
  | 'receipt:pending-output'
  | 'output:cancelled'
  | 'output:failed'
  | 'gate:known-failure'
  | 'event:shape'
  | 'event:sequence'
  | 'event:boundary'
  | 'event:receipt'
  | 'event:overlap'
  | 'event:slot'
  | 'terminal_hides_in_flight_work'
  | `status:${R4ExecutionStatus}`
  | 'seed';

export interface R4ExecutionSemanticIssue {
  code: R4ExecutionSemanticRule;
  message: string;
}

export type R4ExecutionSemanticValidation =
  | { valid: true; issues: [] }
  | { valid: false; issues: [R4ExecutionSemanticIssue] };

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function fail(code: R4ExecutionSemanticRule, message: string): R4ExecutionSemanticValidation {
  return { valid: false, issues: [{ code, message }] };
}

type R4NativeRequestKind = 'image' | 'vibe_encode' | 'upscale';
type R4NativeReceiptOutcome = 'pending' | 'confirmed' | 'failed' | 'unknown';

interface R4NativeRequestBoundary {
  kind: R4NativeRequestKind;
  sequence: number;
  outputIndexes: number[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Check host-only POST/receipt event evidence; canonical result schemas remain unchanged. */
function validateNativeRequestEvents(execution: R4Execution): R4ExecutionSemanticValidation {
  const events = Array.isArray(execution.events) ? execution.events : [];
  const hasNativeEvents = events.some(event =>
    event.kind === 'native_request_boundary' || event.kind === 'native_request_receipt');
  if (!hasNativeEvents) return { valid: true, issues: [] };

  const boundaries = new Map<number, R4NativeRequestBoundary>();
  const latestOutcomes = new Map<number, R4NativeReceiptOutcome>();
  let boundaryCount = 0;

  for (const event of events) {
    if (event.kind !== 'native_request_boundary' && event.kind !== 'native_request_receipt') continue;
    const detail = event.detail;
    if (!isRecord(detail)) return fail('event:shape', 'Native request events require a structured detail object.');
    const kind = detail.kind;
    const sequence = detail.sequence;
    if ((kind !== 'image' && kind !== 'vibe_encode' && kind !== 'upscale')
        || !Number.isInteger(sequence) || typeof sequence !== 'number' || sequence < 1) {
      return fail('event:shape', 'Native request events require a known request kind and positive integer sequence.');
    }

    if (event.kind === 'native_request_boundary') {
      boundaryCount += 1;
      if (sequence !== boundaryCount || boundaries.has(sequence)) {
        return fail('event:sequence', 'Native request boundary sequences must be unique, contiguous, and execution-local.');
      }
      for (const priorSequence of boundaries.keys()) {
        const outcome = latestOutcomes.get(priorSequence);
        if (priorSequence < sequence
            && (outcome === undefined || outcome === 'pending' || outcome === 'unknown' || outcome === 'failed')) {
          return fail('event:overlap', 'A later native request boundary cannot follow a request without a resolved receipt.');
        }
      }
      if (typeof detail.dispatchClaimId !== 'string' || !detail.dispatchClaimId.trim()) {
        return fail('event:boundary', 'Every native request boundary must identify its dispatch claim.');
      }
      let outputIndexes: number[];
      if (Array.isArray(detail.outputIndexes)) {
        if (Object.prototype.hasOwnProperty.call(detail, 'outputIndex')) {
          return fail('event:boundary', 'A native request boundary cannot use both outputIndex and outputIndexes.');
        }
        outputIndexes = detail.outputIndexes as number[];
      } else if (detail.outputIndex !== undefined) {
        outputIndexes = [detail.outputIndex as number];
      } else {
        // A shared helper request without explicit slot mapping conservatively affects every output.
        outputIndexes = Array.from({ length: execution.expectedOutputCount }, (_unused, index) => index);
      }
      if (!outputIndexes.length || outputIndexes.some(index =>
        !Number.isInteger(index) || index < 0 || index >= execution.expectedOutputCount)
        || new Set(outputIndexes).size !== outputIndexes.length) {
        return fail('event:boundary', 'Native request output indexes must be non-empty, unique, and within the execution output slots.');
      }
      if (execution.requestGranularity === 'batch' && kind === 'image'
          && (outputIndexes.length !== execution.expectedOutputCount
            || outputIndexes.some((index, ordinal) => index !== ordinal))) {
        return fail('event:boundary', 'A batch image request must identify every output slot in index order.');
      }
      boundaries.set(sequence, { kind, sequence, outputIndexes });
      continue;
    }

    const boundary = boundaries.get(sequence);
    if (!boundary || boundary.kind !== kind) {
      return fail('event:receipt', 'Native request receipt must match a preceding boundary with the same kind and sequence.');
    }
    const outcome = detail.status;
    if (outcome !== 'pending' && outcome !== 'confirmed' && outcome !== 'failed' && outcome !== 'unknown') {
      return fail('event:receipt', 'Native request receipt has an unsupported status.');
    }
    latestOutcomes.set(sequence, outcome);
  }

  const lastBoundary = boundaries.get(boundaryCount);
  if (!lastBoundary) return fail('event:boundary', 'Native request receipt events require a corresponding request boundary.');
  const lastOutcome = latestOutcomes.get(lastBoundary.sequence);
  if (lastOutcome === undefined) {
    if (execution.providerReceiptStatus !== 'unknown'
        || lastBoundary.outputIndexes.some(index => execution.outputs[index]?.status !== 'unknown')) {
      return fail('event:slot', 'A request boundary without a receipt must remain unknown on its associated output slots.');
    }
  } else if (lastOutcome === 'pending') {
    if (execution.providerReceiptStatus !== 'pending'
        || lastBoundary.outputIndexes.some(index => execution.outputs[index]?.status !== 'pending')) {
      return fail('event:slot', 'A pending native request receipt must remain pending on its associated output slots.');
    }
  } else if (lastOutcome === 'unknown') {
    if (execution.providerReceiptStatus !== 'unknown'
        || lastBoundary.outputIndexes.some(index => execution.outputs[index]?.status !== 'unknown')) {
      return fail('event:slot', 'An unknown native request receipt must remain unknown on its associated output slots.');
    }
  } else if (execution.providerReceiptStatus !== 'confirmed') {
    return fail('event:receipt', 'A resolved native request receipt must be represented by providerReceiptStatus=confirmed.');
  }

  return { valid: true, issues: [] };
}

/**
 * Apply the full aggregate-state contract in `docs/agent-refactor-v3.2-r4-final/validate_registry.py`.
 * Accept either canonical tool-result data or the durable store model. A non-ok
 * read result has no execution snapshot to check and is intentionally skipped.
 */
export function validateR4ExecutionSemantics(
  input: R4ExecutionSemanticInput,
): R4ExecutionSemanticValidation {
  const isCanonical = 'executionStatus' in input;
  if (isCanonical && input.readStatus !== undefined && input.readStatus !== 'ok') {
    return { valid: true, issues: [] };
  }

  const isSnapshot = !isCanonical && !('approvedInput' in input);
  if (isSnapshot) {
    const terminal = new Set<R4ExecutionStatus>(['completed', 'partial', 'error', 'cancelled', 'blocked', 'denied']);
    const hasPending = input.outputs.some(output => output.status === 'pending')
      || input.providerReceiptStatus === 'pending';
    return terminal.has(input.status) && hasPending
      ? fail('terminal_hides_in_flight_work', `Terminal execution status "${input.status}" hides pending work.`)
      : { valid: true, issues: [] };
  }

  if (!isCanonical && 'approvedInput' in input) {
    const eventValidation = validateNativeRequestEvents(input);
    if (!eventValidation.valid) return eventValidation;
  }

  const executionStatus = isCanonical ? input.executionStatus : input.status;
  const outputs = input.outputs;
  const expectedOutputCount = input.expectedOutputCount;
  const requestGranularity = input.requestGranularity;
  const providerReceiptStatus = input.providerReceiptStatus;
  const blockedReason = input.blockedReason;
  const pauseReason = input.pauseReason;
  const approvedParameters = isCanonical ? undefined : input.approvedInput.publicParameters;
  const requestedSeedPolicy = isCanonical
    ? input.requestedSeedPolicy
    : approvedParameters?.requestedSeedPolicy as R4ExecutionSemanticData['requestedSeedPolicy'];
  const requestedSeed = isCanonical
    ? input.requestedSeed
    : approvedParameters && hasOwn(approvedParameters, 'requestedSeed')
      ? approvedParameters.requestedSeed as number | null
      : undefined;

  const statuses = outputs.map(output => output.status);
  const indices = outputs.map(output => output.outputIndex);
  if (!Number.isInteger(expectedOutputCount) || expectedOutputCount < 0
      || new Set(indices).size !== indices.length
      || indices.some(index => !Number.isInteger(index) || index < 0 || index >= expectedOutputCount)
      || outputs.length !== expectedOutputCount
      || new Set(indices).size !== expectedOutputCount) {
    return fail('cardinality', 'Execution outputs must contain one unique, in-range indexed status for every expected output.');
  }

  const unknownEvidence = providerReceiptStatus === 'unknown' || statuses.includes('unknown');
  const pendingEvidence = providerReceiptStatus === 'pending' || statuses.includes('pending');
  const dispatchedOutputs = statuses.some(status =>
    status === 'pending' || status === 'completed' || status === 'failed'
      || status === 'cancelled' || status === 'unknown');

  if (requestGranularity === 'batch'
      && (providerReceiptStatus === 'pending' || providerReceiptStatus === 'confirmed' || providerReceiptStatus === 'unknown')
      && statuses.includes('not_dispatched')) {
    return fail('batch', 'After a batch provider request, an output cannot be claimed not_dispatched.');
  }

  if (unknownEvidence && executionStatus !== 'unknown') {
    return fail('priority:unknown', 'Unknown provider/output evidence has priority over every other aggregate state.');
  }
  if (!unknownEvidence && pendingEvidence
      && executionStatus !== 'running' && executionStatus !== 'cancel_requested') {
    return fail('priority:pending', 'Pending provider/output evidence requires running or cancel_requested.');
  }
  if (providerReceiptStatus === 'pending' && !statuses.includes('pending')) {
    return fail('receipt:pending-output', 'Pending provider receipt requires a matching pending output.');
  }
  if (outputs.some(output => output.status === 'cancelled' && output.errorCode !== 'cancelled')) {
    return fail('output:cancelled', 'Cancelled output requires errorCode=cancelled.');
  }
  const knownFailureCodes = new Set(['provider_error', 'attachment_unavailable']);
  if (outputs.some(output => output.status === 'failed' && !knownFailureCodes.has(output.errorCode ?? ''))) {
    return fail('output:failed', 'Every failed output requires a known failure errorCode.');
  }
  if (statuses.includes('failed')
      && (executionStatus === 'running' || executionStatus === 'cancel_requested')
      && blockedReason !== 'prior_paid_failure') {
    return fail('gate:known-failure', 'Known failed output beside in-flight work requires the explicit prior_paid_failure dispatch gate.');
  }

  const all = (predicate: (status: R4OutputStatus) => boolean) => statuses.every(predicate);
  const any = (predicate: (status: R4OutputStatus) => boolean) => statuses.some(predicate);
  const noActiveGate = !blockedReason;

  switch (executionStatus) {
    case 'queued':
      if (!all(status => status === 'not_dispatched') || providerReceiptStatus !== 'not_applicable'
          || !hasOwn(input, 'pauseReason') || pauseReason === undefined
          || (Boolean(blockedReason) && pauseReason === 'none')) {
        return fail('status:queued', 'Queued requires every output not_dispatched, providerReceiptStatus=not_applicable, an explicit pauseReason, and no concealed active gate.');
      }
      break;
    case 'dispatching':
      if (!statuses.includes('not_dispatched') || pendingEvidence || unknownEvidence
          || (providerReceiptStatus !== 'not_applicable' && providerReceiptStatus !== 'confirmed')
          || (pauseReason !== undefined && pauseReason !== 'none') || Boolean(blockedReason)) {
        return fail('status:dispatching', 'Dispatching requires remaining unsubmitted work, no pending/unknown receipt, and an active unblocked claim.');
      }
      if (providerReceiptStatus === 'confirmed') {
        if (requestGranularity !== 'per_output'
            || !statuses.includes('completed')
            || !all(status => status === 'completed' || status === 'not_dispatched')) {
          return fail('status:dispatching', 'Confirmed dispatching may only follow completed per-output outputs; a previous failure/cancellation forbids another claim.');
        }
      } else if (!all(status => status === 'not_dispatched')) {
        return fail('status:dispatching', 'Without a provider receipt, dispatching outputs must all remain not_dispatched.');
      }
      break;
    case 'running':
      if (!statuses.includes('pending')
          || (providerReceiptStatus !== 'pending' && providerReceiptStatus !== 'confirmed')) {
        return fail('status:running', 'Running requires an actually dispatched pending output and a pending/confirmed provider receipt.');
      }
      break;
    case 'cancel_requested':
      if (!statuses.includes('pending')
          || (providerReceiptStatus !== 'pending' && providerReceiptStatus !== 'confirmed')) {
        return fail('status:cancel_requested', 'cancel_requested requires an actually dispatched pending output; a request alone is not terminal.');
      }
      break;
    case 'completed':
      if (!all(status => status === 'completed')
          || providerReceiptStatus !== 'confirmed' || !noActiveGate) {
        return fail('status:completed', 'Completed requires every expected output completed, a confirmed provider request receipt, and no active dispatch gate.');
      }
      break;
    case 'partial': {
      const knownTerminal = all(status =>
        status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'not_dispatched');
      const hasKnownNonSuccess = any(status => status === 'failed' || status === 'cancelled' || status === 'not_dispatched');
      if (!knownTerminal || !statuses.includes('completed') || !hasKnownNonSuccess
          || providerReceiptStatus !== 'confirmed' || !noActiveGate) {
        return fail('status:partial', 'Partial requires all known terminal outcomes, a confirmed provider request, at least one success and one known non-success, and no active gate.');
      }
      break;
    }
    case 'error':
      if (!statuses.includes('failed')
          || !all(status => status === 'failed' || status === 'cancelled' || status === 'not_dispatched')
          || providerReceiptStatus !== 'confirmed' || !noActiveGate) {
        return fail('status:error', 'Error requires a confirmed known failure, no success/in-flight/unknown output, and no active gate.');
      }
      break;
    case 'cancelled':
      if (!statuses.includes('cancelled')
          || !all(status => status === 'cancelled' || status === 'not_dispatched')
          || (providerReceiptStatus !== 'confirmed' && providerReceiptStatus !== 'not_applicable') || !noActiveGate) {
        return fail('status:cancelled', 'Cancelled requires at least one cancelled output, no success/failure, and no active gate.');
      }
      break;
    case 'unknown':
      if (!unknownEvidence || providerReceiptStatus === 'not_applicable'
          || (providerReceiptStatus === 'unknown' && !dispatchedOutputs)) {
        return fail('status:unknown', 'Unknown aggregate needs unknown receipt/output evidence and must not claim no dispatch.');
      }
      break;
    case 'blocked':
      if (!all(status => status === 'not_dispatched')
          || providerReceiptStatus !== 'not_applicable' || !blockedReason) {
        return fail('status:blocked', 'Blocked requires all outputs not_dispatched, no provider receipt, and an active blockedReason.');
      }
      break;
    case 'denied':
      if (!all(status => status === 'not_dispatched')
          || providerReceiptStatus !== 'not_applicable' || Boolean(blockedReason)) {
        return fail('status:denied', 'Denied requires a persisted denial decision, no provider dispatch, and no active blockedReason.');
      }
      break;
    default: {
      const exhaustive: never = executionStatus;
      return fail('status:enum', `Unhandled executionStatus: ${String(exhaustive)}.`);
    }
  }

  if (requestedSeedPolicy === 'fixed'
      && (!Number.isInteger(requestedSeed) || typeof requestedSeed !== 'number'
        || requestedSeed < 0 || requestedSeed > 0xffff_ffff)) {
    return fail('seed', 'Fixed seed policy requires an integer uint32 requestedSeed.');
  }
  if (requestedSeedPolicy === 'random' && requestedSeed !== null) {
    return fail('seed', 'Random seed policy requires requestedSeed=null.');
  }
  return { valid: true, issues: [] };
}

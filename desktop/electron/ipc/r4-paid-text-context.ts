import { AsyncLocalStorage } from 'node:async_hooks';

export interface R4PaidTextReceipt {
  certainty: 'received' | 'unknown';
  httpStatus?: number;
  rawStatus: string;
  receivedAt: string;
}

export interface R4PaidTextContext {
  canonicalTool: 'convert_prompt' | 'edit_prompt' | 'reverse_prompt';
  signal: AbortSignal;
  /** Recheck the durable R4 gate immediately before the only network attempt. */
  beforePost: () => void | Promise<void>;
  /** Persist the response/transport receipt before the service can return it. */
  afterReceipt: (receipt: R4PaidTextReceipt) => void | Promise<void>;
}

interface ActiveR4PaidTextContext extends R4PaidTextContext {
  claimed: boolean;
  postStarted: boolean;
  receipt?: R4PaidTextReceipt;
}

const contexts = new AsyncLocalStorage<ActiveR4PaidTextContext>();

/** Scope the existing legacy text-service implementation to one R4 paid call. */
export function withR4PaidTextContext<T>(context: R4PaidTextContext, run: () => Promise<T>): Promise<T> {
  context.signal.throwIfAborted();
  return contexts.run({ ...context, claimed: false, postStarted: false }, run);
}

export function currentR4PaidTextState() {
  const state = contexts.getStore();
  return state ? { canonicalTool: state.canonicalTool, attempted: state.postStarted, receipt: state.receipt, aborted: state.signal.aborted } : undefined;
}

export function currentR4PaidTextSignal() {
  return contexts.getStore()?.signal;
}

/**
 * In R4, at most one actual paid-text POST may start for a canonical call.
 * Existing workbench calls without this async context keep their retry behavior.
 */
export async function postR4PaidText<T extends { status: number }>(send: () => Promise<T>): Promise<T> {
  const state = contexts.getStore();
  if (!state) return send();
  state.signal.throwIfAborted();
  if (state.claimed) throw new Error('R4 paid text service already used its single request allowance; no retry was sent.');
  // Claim before awaiting the gate so concurrent internal branches cannot race into two POSTs.
  state.claimed = true;
  await state.beforePost();
  state.signal.throwIfAborted();
  state.postStarted = true;

  let response: T;
  try {
    response = await send();
  } catch (error) {
    const status = (error as { response?: { status?: unknown } })?.response?.status;
    const httpStatus = Number.isInteger(status) ? Number(status) : undefined;
    const receipt: R4PaidTextReceipt = {
      certainty: httpStatus !== undefined && httpStatus < 500 ? 'received' : 'unknown',
      ...(httpStatus !== undefined ? { httpStatus } : {}),
      rawStatus: httpStatus !== undefined ? `http_${httpStatus}` : 'transport_unknown',
      receivedAt: new Date().toISOString(),
    };
    state.receipt = receipt;
    await state.afterReceipt(receipt);
    throw error;
  }

  const receipt: R4PaidTextReceipt = {
    certainty: response.status >= 500 ? 'unknown' : 'received',
    httpStatus: response.status,
    rawStatus: `http_${response.status}`,
    receivedAt: new Date().toISOString(),
  };
  state.receipt = receipt;
  await state.afterReceipt(receipt);
  return response;
}

import {registerMobileGatewayCancellation, useAppStore} from './store';
import type {GenerateResult, MobileInpaintRequest} from './types';
import type {GatewayPlanPreview} from './gateway-workbench';

export type ConfirmMobileGatewayBatch = (plan: GatewayPlanPreview, count: number, signal: AbortSignal) => Promise<boolean>;

type CancelResult = {accepted: boolean; message: string};

/** One user-confirmed, frozen batch; transport plans and credentials stay in main. */
export function createMobileGatewayRunner(profileId: string, count: number, confirm: ConfirmMobileGatewayBatch) {
  const runId = `mobile-gateway-${crypto.randomUUID()}`;
  let cancelled = false, stopped = false, started = false, finished = false, confirmed = false;
  let planId: string | undefined, selected = false, selectedPromise: Promise<void> | undefined;
  let cancelPlanId: string | undefined, cancelPlanPromise: Promise<CancelResult> | undefined;
  let confirmedProfileRevision: string | undefined;
  let cancelPromise: Promise<void> | undefined, cancelMessage = '', lateUncertainMessage = '';
  let unregisterCancellation: (() => void) | undefined;
  const confirmation = new AbortController();
  const api = () => window.worldpainter.gateway;
  const state = () => useAppStore.getState();
  const ownsRun = () => state().activeGenerationRunId === runId;
  const current = () => !cancelled && !stopped && state().isGenerating && ownsRun();
  const set = (patch: Partial<ReturnType<typeof useAppStore.getState>>) => {if (current()) useAppStore.setState(patch);};
  const setOwned = (patch: Partial<ReturnType<typeof useAppStore.getState>>) => {if (ownsRun()) useAppStore.setState(patch);};

  function begin() {
    if (cancelled || stopped || finished) return false;
    const currentState = state();
    if (currentState.isGenerating && currentState.activeGenerationRunId !== runId) return false;
    if (currentState.activeGenerationRunId === runId && currentState.isGenerating) {
      started = true;
      return true;
    }
    started = true;
    useAppStore.setState({isGenerating: true, activeGenerationRunId: runId, generationPhase: 'preparing', currentAnlasSpent: null, lastAnlasSpent: null, lastError: '', statusText: '正在准备网关重绘…'});
    unregisterCancellation = registerMobileGatewayCancellation(runId, cancel);
    return true;
  }

  async function start() {
    if (!begin()) return false;
    try {
      await ensureSelected();
      return current();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({statusText: message, toast: message, lastError: message});
      throw error;
    }
  }

  async function ensureSelected() {
    if (!selectedPromise) {
      selectedPromise = api().selectProfile(profileId).then(profiles => {
        if (!profiles.some(profile => profile.id === profileId && profile.selected)) throw new Error('网关档案未能设为本批次使用的渠道。');
        selected = true;
      });
    }
    await selectedPromise;
    if (!selected) throw new Error('网关档案未能设为本批次使用的渠道。');
  }

  function cancelPlan(id: string): Promise<CancelResult> {
    if (cancelPlanId === id && cancelPlanPromise) return cancelPlanPromise;
    cancelPlanId = id;
    cancelPlanPromise = api().cancel(id).catch(() => ({
      accepted: false,
      message: '网关取消请求未确认；任务可能仍在处理。',
    }));
    return cancelPlanPromise;
  }

  function publishCancelResult(message: string) {
    cancelMessage = message;
    if (ownsRun()) {
      useAppStore.setState({isGenerating: false, generationPhase: 'idle', currentAnlasSpent: null, statusText: message, toast: message, lastError: ''});
      publishLateUncertain();
    }
  }

  function publishLateUncertain() {
    if (!lateUncertainMessage || !cancelMessage || !ownsRun()) return;
    const currentState = state();
    if (currentState.isGenerating) return;
    const message = `取消响应：${cancelMessage}\n${lateUncertainMessage}`;
    useAppStore.setState({statusText: message, toast: message, lastError: message});
  }

  async function cancel() {
    if (cancelPromise) return cancelPromise;
    cancelled = true;
    confirmation.abort();
    cancelPromise = (async () => {
      if (planId) {
        const response = await cancelPlan(planId);
        publishCancelResult(response.message || (response.accepted ? '网关已接受取消请求；任务状态仍可能变化。' : '网关未确认取消；任务可能仍在处理。'));
      } else {
        publishCancelResult('已取消后续网关重绘候选。');
      }
    })();
    return cancelPromise;
  }

  async function finish() {
    finished = true;
    if (cancelPromise) await cancelPromise;
    if (ownsRun()) useAppStore.setState({isGenerating: false, activeGenerationRunId: null, generationPhase: 'idle', currentAnlasSpent: null});
    unregisterCancellation?.();
    unregisterCancellation = undefined;
  }

  async function run(request: MobileInpaintRequest): Promise<GenerateResult | null> {
    if (cancelled || stopped || finished) return null;
    if (!started ? !begin() : !ownsRun()) return null;
    try {
      if (!selected) await ensureSelected();
      if (!current()) return null;
      set({generationPhase: 'preparing', statusText: '正在准备网关重绘…'});
      const plan = await api().prepareMobileInpaint({profileId, request});
      planId = plan.planId;
      if (!current()) {
        const cancelledPlan = await cancelPlan(plan.planId);
        if (cancelled) publishCancelResult(cancelledPlan.message);
        if (planId === plan.planId) planId = undefined;
        return null;
      }

      const profileRevision = plan.profileRevision;
      if (typeof profileRevision !== 'string' || !profileRevision) {
        stopped = true;
        const cancelledPlan = await cancelPlan(plan.planId);
        planId = undefined;
        setOwned({statusText: `网关未返回凭据版本，已停止本批次。${cancelledPlan.message}`, toast: cancelledPlan.message, lastError: '网关计划缺少凭据版本。'});
        return null;
      }
      if (confirmed && profileRevision !== confirmedProfileRevision) {
        stopped = true;
        const cancelledPlan = await cancelPlan(plan.planId);
        planId = undefined;
        setOwned({statusText: `网关凭据在批次中发生变化，已停止后续请求。${cancelledPlan.message}`, toast: cancelledPlan.message, lastError: '网关凭据版本发生变化；未继续提交。'});
        return null;
      }

      if (!confirmed) {
        const accepted = await confirm(plan, count, confirmation.signal);
        if (!accepted || !current()) {
          if (!cancelled) stopped = true;
          const cancelledPlan = await cancelPlan(plan.planId);
          planId = undefined;
          if (!cancelled) setOwned({statusText: cancelledPlan.message || '已取消网关重绘。', toast: cancelledPlan.message || '已取消网关重绘。', lastError: ''});
          return null;
        }
        confirmed = true;
        confirmedProfileRevision = profileRevision;
      }

      set({generationPhase: 'requesting', statusText: '正在生成网关重绘候选…'});
      const result = await api().generate({planId: plan.planId, confirmed: true});
      if (planId === plan.planId) planId = undefined;
      if (!current()) {
        if (cancelled && result.status === 'uncertain') {
          lateUncertainMessage = result.message || '网关未能确认生成结果；请检查网关任务记录。没有自动重试。';
          publishLateUncertain();
        }
        return null;
      }
      if (result.items?.length) await state().refreshHistory(result.items[0].date).catch(() => undefined);
      if (!current()) return null;
      const message = result.message;
      set({generationPhase: 'saving', statusText: message, toast: message, lastError: result.status === 'succeeded' ? '' : message});
      return {ok: result.status === 'succeeded', items: result.items ?? [], actualSeed: result.items?.[0]?.actualSeed, message};
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (cancelled) return null;
      set({statusText: message, toast: message, lastError: message});
      return current() ? {ok: false, items: [], message} : null;
    }
  }

  return {begin, start, run, cancel, finish};
}

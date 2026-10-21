import {useAppStore} from './store';
import type {GenerateResult, MobileInpaintRequest} from './types';
import type {GatewayPlanPreview} from './gateway-workbench';

export type ConfirmMobileGatewayBatch = (plan: GatewayPlanPreview, count: number, signal: AbortSignal) => Promise<boolean>;

/** One user-confirmed, frozen batch; transport plans and credentials stay in main. */
export function createMobileGatewayRunner(profileId: string, count: number, confirm: ConfirmMobileGatewayBatch) {
  let cancelled = false, confirmed = false, planId: string | undefined, activeRunId: string | undefined;
  const confirmation = new AbortController();
  const api = () => window.worldpainter.gateway;
  async function cancel() {
    cancelled = true;
    confirmation.abort();
    if(activeRunId && useAppStore.getState().activeGenerationRunId === activeRunId) {
      useAppStore.setState({isGenerating: false, activeGenerationRunId: null, generationPhase: 'idle', currentAnlasSpent: null, statusText: '已取消网关重绘。'});
    }
    if (planId) await api().cancel(planId).catch(() => undefined);
  }
  async function run(request: MobileInpaintRequest): Promise<GenerateResult | null> {
    if (cancelled || useAppStore.getState().isGenerating) return null;
    const runId = `mobile-gateway-${crypto.randomUUID()}`;
    activeRunId = runId;
    const current = () => !cancelled && useAppStore.getState().isGenerating && useAppStore.getState().activeGenerationRunId === runId;
    const set = (patch: Partial<ReturnType<typeof useAppStore.getState>>) => {if (current()) useAppStore.setState(patch);};
    useAppStore.setState({isGenerating: true, activeGenerationRunId: runId, generationPhase: 'preparing', currentAnlasSpent: null, lastAnlasSpent: null, lastError: '', statusText: '正在准备网关重绘…'});
    try {
      const plan = await api().prepareMobileInpaint({profileId, request});
      planId = plan.planId;
      if (!current()) {await api().cancel(plan.planId); return null;}
      if (!confirmed) {
        const accepted = await confirm(plan, count, confirmation.signal);
        if (!accepted || !current()) {
          await api().cancel(plan.planId);
          set({isGenerating: false, activeGenerationRunId: null, generationPhase: 'idle', statusText: '已取消网关重绘。'});
          return null;
        }
        confirmed = true;
      }
      set({generationPhase: 'requesting', statusText: '正在生成网关重绘候选…'});
      const result = await api().generate({planId: plan.planId, confirmed: true});
      planId = undefined;
      if (!current()) return null;
      if (result.items?.length) await useAppStore.getState().refreshHistory(result.items[0].date).catch(() => undefined);
      if (!current()) return null;
      const message = result.message;
      set({isGenerating: false, activeGenerationRunId: null, generationPhase: 'idle', statusText: message, toast: message, lastError: result.status === 'succeeded' ? '' : message});
      return {ok: result.status === 'succeeded', items: result.items ?? [], actualSeed: result.items?.[0]?.actualSeed, message};
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const owned = current();
      set({isGenerating: false, activeGenerationRunId: null, generationPhase: 'idle', statusText: message, toast: message, lastError: message});
      return owned ? {ok: false, items: [], message} : null;
    }
  }
  return {run, cancel};
}

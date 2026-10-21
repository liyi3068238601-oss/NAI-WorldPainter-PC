import type {GatewayProtocol} from './gateway-workbench';

export const MOBILE_OUTPUT_PRESETS = [
  [832, 1216], [1216, 832], [1024, 1024], [1024, 1536], [1536, 1024],
  [1472, 1472], [1088, 1920], [1920, 1088], [768, 1344], [1344, 768],
] as const;

// Source: the current phone's ApiConstants and GenerationViewModel, not the
// desktop text-to-image gateway's smaller, separately accepted capability set.
export function mobileSamplerValues(protocol?: GatewayProtocol): readonly string[] {
  if (protocol !== 'ikun') return ['k_euler', 'k_euler_ancestral', 'k_dpm_2', 'k_dpm_2_ancestral', 'k_dpmpp_2m', 'k_dpmpp_2m_sde', 'k_dpmpp_2s_ancestral', 'k_dpmpp_sde', 'ddim'];
  return ['k_euler_ancestral', 'k_euler', 'k_dpmpp_2m', 'k_dpmpp_2m_sde', 'k_dpmpp_sde', 'k_dpmpp_2s_ancestral', 'ddim_v3'];
}

export function mobileNoiseSchedules(protocol?: GatewayProtocol): readonly string[] {
  return protocol !== 'ikun'
    ? ['karras', 'exponential', 'polyexponential']
    : ['native', 'karras', 'exponential', 'polyexponential'];
}

export function mobileOutputChoices(model: string, protocol?: GatewayProtocol, custom: Array<{width: number; height: number}> = []) {
  const sizes: Array<{width: number; height: number}> = MOBILE_OUTPUT_PRESETS.filter(([width, height]) => protocol !== 'gateway7877' || !model.includes('diffusion-5') || width * height <= 1024 * 1024)
    .map(([width, height]) => ({width, height}));
  for (const size of custom) if (!sizes.some(other => other.width === size.width && other.height === size.height)) sizes.push({...size});
  return sizes;
}

export function mobileOutputError(width: number, height: number): string {
  if (![width, height].every(value => Number.isSafeInteger(value) && value >= 64 && value <= 1920)) return '边长需在 64 到 1920 之间。';
  if (width % 64 || height % 64) return '边长需为 64 的倍数。';
  return '';
}

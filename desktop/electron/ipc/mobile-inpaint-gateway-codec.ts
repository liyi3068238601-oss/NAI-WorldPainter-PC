import type { GatewayProtocol } from '../../src/gateway-workbench';
import {normalizeNAIBaseModel} from '../../src/types';

/**
 * Mobile inpaint has its own wire contract. Keep it separate from the desktop
 * text-to-image projection so quality/advanced fields cannot leak across flows.
 */
export interface MobileInpaintGatewayInput {
  protocol: GatewayProtocol;
  model: string;
  prompt: string;
  negativePrompt: string;
  imageBase64: string;
  maskBase64: string;
  strength: number;
  disabledOriginalImage: boolean;
  colorCorrect: boolean;
  width: number;
  height: number;
  steps: number;
  scale: number;
  cfgRescale: number;
  sampler: string;
  noiseSchedule: string;
  seed: number | null;
}

export interface MobileInpaintGatewayRequest {
  path: '/v1/images/generations';
  accept: 'application/json';
  payload: Record<string, unknown>;
}

const PHONE_SAMPLERS: Record<GatewayProtocol, ReadonlySet<string>> = {
  gateway7877: new Set([
    'k_euler', 'k_euler_ancestral', 'k_dpm_2', 'k_dpm_2_ancestral',
    'k_dpmpp_2m', 'k_dpmpp_2m_sde', 'k_dpmpp_2s_ancestral', 'k_dpmpp_sde', 'ddim',
  ]),
  ikun: new Set([
    'k_euler', 'k_euler_ancestral', 'k_dpmpp_2s_ancestral', 'k_dpmpp_2m',
    'k_dpmpp_2m_sde', 'k_dpmpp_sde', 'ddim_v3',
  ]),
};

const PHONE_NOISE_SCHEDULES: Record<GatewayProtocol, ReadonlySet<string>> = {
  gateway7877: new Set(['karras', 'exponential', 'polyexponential']),
  ikun: new Set(['native', 'karras', 'exponential', 'polyexponential']),
};

export function assertMobileInpaintGatewaySampling(
  protocol: GatewayProtocol,
  sampler: string,
  noiseSchedule: string,
) {
  if (!PHONE_SAMPLERS[protocol].has(sampler)) {
    throw new Error(`${protocol === 'gateway7877' ? '7877' : 'ikun'} 网关不支持重绘采样器 ${sampler}。`);
  }
  if (!PHONE_NOISE_SCHEDULES[protocol].has(noiseSchedule)) {
    throw new Error(`${protocol === 'gateway7877' ? '7877' : 'ikun'} 网关不支持重绘噪声计划 ${noiseSchedule}。`);
  }
}

/** Build the exact image-generations payload used by the mobile inpaint route. */
export function buildMobileInpaintGatewayRequest(input: MobileInpaintGatewayInput): MobileInpaintGatewayRequest {
  assertMobileInpaintGatewaySampling(input.protocol, input.sampler, input.noiseSchedule);
  // The desktop picker names the native inpaint checkpoint; the phone gateway
  // task uses the base model and selects inpainting through image/mask/operation.
  const model = normalizeNAIBaseModel(input.model);

  if (input.protocol === 'gateway7877') {
    return {
      path: '/v1/images/generations',
      accept: 'application/json',
      payload: {
        model,
        prompt: input.prompt,
        image: input.imageBase64,
        mask: input.maskBase64,
        strength: input.strength,
        n: 1,
        size: `${input.width}x${input.height}`,
        response_format: 'b64_json',
        params: {
          steps: input.steps,
          scale: input.scale,
          cfg_rescale: input.cfgRescale,
          sampler: input.sampler,
          noise_schedule: input.noiseSchedule,
          ...(input.seed === null ? {} : { seed: input.seed }),
          ...(input.negativePrompt ? { negative_prompt: input.negativePrompt } : {}),
          quality: true,
          uc_preset: 'light',
        },
      },
    };
  }

  return {
    path: '/v1/images/generations',
    accept: 'application/json',
    payload: {
      novelai_operation: 'inpainting',
      model,
      prompt: input.prompt,
      ...(input.negativePrompt ? { negative_prompt: input.negativePrompt } : {}),
      image: input.imageBase64,
      mask: input.maskBase64,
      strength: input.strength,
      noise: 0.0,
      add_original_image: !input.disabledOriginalImage,
      color_correct: input.colorCorrect,
      n: 1,
      size: `${input.width}x${input.height}`,
      width: input.width,
      height: input.height,
      steps: input.steps,
      scale: input.scale,
      cfg_rescale: input.cfgRescale,
      sampler: input.sampler,
      noise_schedule: input.noiseSchedule,
      ...(input.seed === null ? {} : { seed: input.seed }),
      response_format: 'b64_json',
    },
  };
}

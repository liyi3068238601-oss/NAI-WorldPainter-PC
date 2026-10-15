import { describe, expect, it } from 'vitest';
import { buildGatewayGenerationRequest, type GatewayGenerationInput } from './gateway-generation-codec';

const base: GatewayGenerationInput = {
  protocol: 'gateway7877', operation: 'textToImage', model: 'nai-diffusion-5-full',
  prompt: '1girl, portrait', negativePrompt: 'lowres', width: 832, height: 1216,
  steps: 28, scale: 6, cfgRescale: 0.2, sampler: 'k_euler_ancestral',
  noiseSchedule: 'karras', seed: 123,
};

describe('gateway generation codecs', () => {
  it('matches 7877 nested params and leaves credentials to the caller', () => {
    const request = buildGatewayGenerationRequest(base);
    expect(request).toMatchObject({ path: '/v1/images/generations', accept: 'application/json' });
    expect(request.payload).toMatchObject({
      model: base.model, prompt: base.prompt, n: 1, size: '832x1216', width: 832, height: 1216,
      response_format: 'b64_json',
      params: {
        steps: 28, scale: 6, cfg_rescale: 0.2, sampler: 'k_euler_ancestral',
        noise_schedule: 'karras', seed: 123, negative_prompt: 'lowres',
        quality: true, uc_preset: 'light', sm: false, sm_dyn: false,
      },
    });
    expect(request.payload).not.toHaveProperty('negative_prompt');
    expect(JSON.stringify(request)).not.toMatch(/token|authorization/i);
  });

  it('matches Ikun direct-field envelope and protocol operation markers', () => {
    const request = buildGatewayGenerationRequest({ ...base, protocol: 'ikun' });
    expect(request.payload).toMatchObject({
      model: base.model, prompt: base.prompt, negative_prompt: 'lowres',
      width: 832, height: 1216, n: 1, size: '832x1216', response_format: 'b64_json',
      steps: 28, scale: 6, cfg_rescale: 0.2, sampler: 'k_euler_ancestral', seed: 123,
    });
    expect(request.payload).not.toHaveProperty('params');
    const ikunI2i = buildGatewayGenerationRequest({ ...base, protocol: 'ikun', operation: 'imageToImage', imageBase64: 'AQ==' }).payload;
    expect(ikunI2i).toMatchObject({ novelai_operation: 'img2img', image: 'AQ==', strength: 0.7 });
    expect(ikunI2i).not.toHaveProperty('size');
    expect(buildGatewayGenerationRequest({ ...base, protocol: 'ikun', operation: 'inpaint', imageBase64: 'AQ==', maskBase64: 'Ag==' }).payload)
      .toMatchObject({ novelai_operation: 'inpainting', image: 'AQ==', mask: 'Ag==', strength: 0.7, n: 1, size: '832x1216' });
  });

  it('rejects protocol-specific unsupported reference combinations rather than dropping them', () => {
    expect(() => buildGatewayGenerationRequest({ ...base, preciseReferences: [{ imageBase64: 'AQ==', type: 'style', strength: 0.5 }] }))
      .toThrow(/7877 does not support precise references/);
    expect(() => buildGatewayGenerationRequest({ ...base, protocol: 'ikun', operation: 'imageToImage', characters: [{ prompt: 'one' }] }))
      .toThrow(/does not support references or character prompts/);
  });
});

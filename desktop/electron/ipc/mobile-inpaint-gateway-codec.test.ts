import { describe, expect, it } from 'vitest';
import { buildMobileInpaintGatewayRequest } from './mobile-inpaint-gateway-codec';

const common = {
  model: 'nai-diffusion-5-full-inpainting',
  prompt: '1girl, portrait',
  negativePrompt: 'lowres',
  imageBase64: 'source-bytes',
  maskBase64: 'mask-bytes',
  strength: 0.96,
  disabledOriginalImage: true,
  colorCorrect: false,
  width: 832,
  height: 1216,
  steps: 28,
  scale: 5,
  cfgRescale: 0.2,
  sampler: 'ddim',
  noiseSchedule: 'polyexponential',
  seed: 42,
};

describe('mobile inpaint gateway wire contract', () => {
  it('builds the phone 7877 nested params shape without Ikun controls', () => {
    const request = buildMobileInpaintGatewayRequest({ ...common, protocol: 'gateway7877' });
    expect(request.path).toBe('/v1/images/generations');
    expect(request.payload).toStrictEqual({
      model: 'nai-diffusion-5-full',
      prompt: common.prompt,
      image: common.imageBase64,
      mask: common.maskBase64,
      strength: 0.96,
      n: 1,
      size: '832x1216',
      response_format: 'b64_json',
      params: {
        steps: 28,
        scale: 5,
        cfg_rescale: 0.2,
        sampler: 'ddim',
        noise_schedule: 'polyexponential',
        seed: 42,
        negative_prompt: 'lowres',
        quality: true,
        uc_preset: 'light',
      },
    });
  });

  it('builds the phone Ikun direct inpainting shape without T2I quality params', () => {
    const request = buildMobileInpaintGatewayRequest({ ...common, protocol: 'ikun', sampler: 'ddim_v3' });
    expect(request.path).toBe('/v1/images/generations');
    expect(request.payload).toStrictEqual({
      novelai_operation: 'inpainting',
      model: 'nai-diffusion-5-full',
      prompt: common.prompt,
      negative_prompt: 'lowres',
      image: common.imageBase64,
      mask: common.maskBase64,
      strength: 0.96,
      noise: 0,
      add_original_image: false,
      color_correct: false,
      n: 1,
      size: '832x1216',
      width: 832,
      height: 1216,
      steps: 28,
      scale: 5,
      cfg_rescale: 0.2,
      sampler: 'ddim_v3',
      noise_schedule: 'polyexponential',
      seed: 42,
      response_format: 'b64_json',
    });
  });

  it('rejects a sampler or schedule outside the selected mobile protocol', () => {
    expect(() => buildMobileInpaintGatewayRequest({ ...common, protocol: 'ikun' }))
      .toThrow(/ikun 网关不支持重绘采样器 ddim/);
    expect(() => buildMobileInpaintGatewayRequest({ ...common, protocol: 'gateway7877', noiseSchedule: 'native' }))
      .toThrow(/7877 网关不支持重绘噪声计划 native/);
  });
});

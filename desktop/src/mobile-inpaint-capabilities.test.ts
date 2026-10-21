import {describe, expect, it} from 'vitest';
import {mobileNoiseSchedules, mobileOutputChoices, mobileOutputError, mobileSamplerValues} from './mobile-inpaint-capabilities';

describe('mobile inpaint channel capabilities', () => {
  it('retains all phone presets for official/ikun and the phone V5 preset filter for 7877', () => {
    expect(mobileOutputChoices('nai-diffusion-5-full')).toHaveLength(10);
    expect(mobileOutputChoices('nai-diffusion-5-full', 'ikun')).toHaveLength(10);
    expect(mobileOutputChoices('nai-diffusion-5-full', 'gateway7877').every(size => size.width * size.height <= 1024 * 1024)).toBe(true);
    expect(mobileOutputChoices('nai-diffusion-4-5-full', 'gateway7877')).toHaveLength(10);
    // Phone custom sizes are appended after preset filtering.
    expect(mobileOutputChoices('nai-diffusion-5-full', 'gateway7877', [{width: 1920, height: 1920}]).at(-1)).toEqual({width: 1920, height: 1920});
  });
  it('carries gateway-only samplers and polyexponential without changing official sampler types', () => {
    expect(mobileSamplerValues('gateway7877')).toEqual(expect.arrayContaining(['k_dpm_2', 'k_dpm_2_ancestral', 'ddim']));
    expect(mobileSamplerValues('ikun')).toContain('ddim_v3');
    expect(mobileNoiseSchedules('gateway7877')).not.toContain('native');
    expect(mobileNoiseSchedules('ikun')).toContain('polyexponential');
  });
  it('rejects invalid custom dimensions visibly, matching phone validation', () => {
    expect(mobileOutputError(1000, 1216)).toContain('64 的倍数');
    expect(mobileOutputError(0, 1216)).toContain('64 到 1920');
    expect(mobileOutputError(1024, 1216)).toBe('');
  });
});

import {describe,expect,it} from 'vitest';
import {PNG} from 'pngjs';
import {DEFAULT_PARAMS,type MobileInpaintRequest} from '../../src/types';
import {buildPayload} from './nai';
import {applyMobileOfficialInpaintParameters,normalizeMobileInpaintParams,prepareMobileInpaintRequest} from './mobile-inpaint';

describe('phone official inpaint payload uses fixed transport flags and authored text',()=>{
  it.each(['nai-diffusion-4-5-full-inpainting','nai-diffusion-5-full-inpainting'] as const)('retains phone-only sampling without extending other workbench modes: %s',model=>{
    const png=new PNG({width:64,height:64});png.data.fill(255);
    const base64=PNG.sync.write(png).toString('base64');
    const request:MobileInpaintRequest={params:{...DEFAULT_PARAMS,width:64,height:64},model,imageBase64:base64,maskBase64:base64,strength:.96,noise:0,ignoreSource:false,colorCorrection:true,sampling:{sampler:'k_dpm_2',noiseSchedule:'polyexponential'}};
    const payload=buildPayload({...normalizeMobileInpaintParams(request),model},4242);
    applyMobileOfficialInpaintParameters(payload.parameters,prepareMobileInpaintRequest(request));
    expect(payload.parameters.sampler).toBe('k_dpm_2');
    expect(payload.parameters.noise_schedule).toBe(model.startsWith('nai-diffusion-5')?'karras':'polyexponential');
    expect(request.params.sampler).toBe(DEFAULT_PARAMS.sampler);
    expect(()=>prepareMobileInpaintRequest({...request,sampling:{sampler:'unexpected',noiseSchedule:'karras'}})).toThrow(/采样/);
  });
  it.each(['nai-diffusion-3-inpainting','nai-diffusion-5-full-inpainting'] as const)('keeps raw prompt captions with %s',model=>{
    const png=new PNG({width:64,height:64});png.data.fill(255);
    const base64=PNG.sync.write(png).toString('base64');
    const request:MobileInpaintRequest={
      params:{...DEFAULT_PARAMS,width:64,height:64,positivePrompt:'synthetic authored, {subject:1.2}',negativePrompt:'synthetic authored negative',stylePrompt:'',
        steps:50,sampler:'k_euler_ancestral',noiseSchedule:'karras',effort:'high',qualityPreset:'none',qualityToggle:false,ucPreset:3,preservePromptText:true,variety:false,transparentBackground:false,smea:false,smeaDyn:false},
      model,imageBase64:base64,maskBase64:base64,strength:.96,noise:0,ignoreSource:false,colorCorrection:true,
    };
    const params=normalizeMobileInpaintParams(request);
    const payload=buildPayload({...params,model},4242);
    payload.action='infill';
    applyMobileOfficialInpaintParameters(payload.parameters,prepareMobileInpaintRequest(request));
    expect(payload.input).toBe(request.params.positivePrompt);
    expect(payload.parameters.uc).toBe(request.params.negativePrompt);
    expect(payload.parameters.negative_prompt).toBe(request.params.negativePrompt);
    expect(payload.parameters).toMatchObject({qualityToggle:true,quality_toggle:true,ucPreset:1,uc_preset:1,strength:.96});
    expect(payload.parameters).not.toHaveProperty('qualityPresetId');
    expect(payload.parameters).not.toHaveProperty('tag_hint_qt');
    for(const field of ['legacy','legacy_v3_extend','dynamic_thresholding','skip_cfg_above_sigma','tag_hint_transparent_background','straight_alpha','deliberate_euler_ancestral_bug','prefer_brownian']) expect(payload.parameters).not.toHaveProperty(field);
    expect(payload.parameters.steps).toBe(model.includes('-5-')?28:50);
    expect(params.steps).toBe(model.includes('-5-')?28:50);
    if(model.includes('-5-')){
      expect(payload.parameters.v4_prompt).toMatchObject({caption:{base_caption:request.params.positivePrompt,char_captions:[]}});
      expect(payload.parameters.v4_negative_prompt).not.toHaveProperty('legacy_uc');
      expect(payload.parameters.v4_negative_prompt).toMatchObject({caption:{base_caption:request.params.negativePrompt,char_captions:[]}});
    }
    // Saved authored parameters disable PC-side prompt insertion; transport flags above are separate.
    expect(params).toMatchObject({qualityPreset:'none',qualityToggle:false,ucPreset:3});
    expect(request.params.positivePrompt).toBe('synthetic authored, {subject:1.2}');
  });
});

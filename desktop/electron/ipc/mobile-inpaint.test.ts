import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ dialog: { showSaveDialog: vi.fn(), showOpenDialog: vi.fn() } }));
import { PNG } from 'pngjs';
import { dialog } from 'electron';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_PARAMS, type MobileInpaintRequest } from '../../src/types';
import { applyMobileOfficialInpaintParameters, decodeMobilePng, prepareMobileInpaintRequest, saveMobileInpaint, assertMobileInpaintAccount, readMobileInpaintSource, pickMobileInpaintSource, normalizeMobileInpaintParams } from './mobile-inpaint';

function png(width=64,height=64,white=true) { const image=new PNG({width,height}); for(let i=0;i<image.data.length;i+=4){image.data[i]=white?255:0;image.data[i+3]=255;} return PNG.sync.write(image).toString('base64'); }
function request():MobileInpaintRequest {return {params:{...DEFAULT_PARAMS,width:64,height:64},model:'nai-diffusion-5-full-inpainting',imageBase64:png(),maskBase64:png(),strength:.96,noise:0,ignoreSource:false,colorCorrection:true};}
describe('mobile official inpaint boundary',()=>{
  it('records the chosen checkpoint for history replay and removes imported replay fields',()=>{
    const r={...request(),model:'nai-diffusion-3-inpainting' as const,params:{...DEFAULT_PARAMS,model:'nai-diffusion-5-full' as const,positivePrompt:'synthetic prompt',metadataReplay:{model:'nai-diffusion-5-full',parameters:{quality_boost:true}}}};
    const normalized=normalizeMobileInpaintParams(r);
    expect(normalized.model).toBe('nai-diffusion-3');
    expect(normalized.positivePrompt).toBe('synthetic prompt');
    expect(normalized.metadataReplay).toBeUndefined();
    expect(r.params.model).toBe('nai-diffusion-5-full');
    expect(r.params.metadataReplay).toBeDefined();
  });
  it('clamps V5 history/request steps to the phone limit without changing the selected V3 steps',()=>{
    expect(normalizeMobileInpaintParams({...request(),params:{...DEFAULT_PARAMS,steps:50}}).steps).toBe(28);
    expect(normalizeMobileInpaintParams({...request(),model:'nai-diffusion-3-inpainting',params:{...DEFAULT_PARAMS,steps:50}}).steps).toBe(50);
  });
  it('rejects a composite above 32 MP before decode or the save picker',async()=>{
    const bytes=Buffer.from(png(),'base64');bytes.writeUInt32BE(8192,16);bytes.writeUInt32BE(4097,20);
    vi.mocked(dialog.showSaveDialog).mockClear();
    const result=await saveMobileInpaint(bytes.toString('base64'));
    expect(result.ok).toBe(false);expect(result.message).toContain('上限');
    expect(dialog.showSaveDialog).not.toHaveBeenCalled();
  });
  it('rejects missing/stale account stamps and accepts only the frozen active identity',()=>{
    const current={accountId:'synthetic-account',revision:'runtime-stamp'};
    expect(()=>assertMobileInpaintAccount(request(),current)).toThrow(/账户/);
    expect(()=>assertMobileInpaintAccount({...request(),expectedAccountId:'other-account',expectedAccountRevision:'runtime-stamp'},current)).toThrow(/账户/);
    expect(()=>assertMobileInpaintAccount({...request(),expectedAccountId:current.accountId,expectedAccountRevision:'old-stamp'},current)).toThrow(/账户/);
    expect(()=>assertMobileInpaintAccount({...request(),expectedAccountId:current.accountId,expectedAccountRevision:current.revision},current)).not.toThrow();
    expect(()=>assertMobileInpaintAccount({...request(),expectedAccountRevision:'legacy-stamp'},{revision:'legacy-stamp'})).not.toThrow();
  });
  it('forwards the exact full-frame pixels and phone strength without old latent/blend transport',()=>{
    const r=request(),input=prepareMobileInpaintRequest(r),parameters:Record<string,unknown>={img2img:{strength:.7},noise:1,add_original_image:true,color_correct:true,inpaintImg2ImgStrength:.7,qualityPresetId:'none',tag_hint_qt:0};
    applyMobileOfficialInpaintParameters(parameters,input);
    expect(parameters).toEqual({image:r.imageBase64,mask:r.maskBase64,strength:.96,qualityToggle:true,quality_toggle:true,ucPreset:1,uc_preset:1});
    expect(decodeMobilePng(parameters.image as string).png.data).toEqual(decodeMobilePng(r.imageBase64).png.data);
  });
  it('accepts the phone 1920 edge without restricting new mode to legacy 1600 or one megapixel',()=>{
    const r={...request(),params:{...DEFAULT_PARAMS,width:1088,height:1920},imageBase64:png(1088,1920),maskBase64:png(1088,1920)};
    const prepared=prepareMobileInpaintRequest(r);
    expect([prepared.width,prepared.height]).toEqual([1088,1920]);
    expect(()=>prepareMobileInpaintRequest({...r,params:{...r.params,width:1984}})).toThrow(/1920/);
  });
  it('rejects dimensions/masks before a paid request can be submitted',()=>{
    expect(()=>prepareMobileInpaintRequest({...request(),maskBase64:png(128,64)})).toThrow(/一致/);
    expect(()=>prepareMobileInpaintRequest({...request(),maskBase64:png(64,64,false)})).toThrow(/蒙版/);
    expect(()=>prepareMobileInpaintRequest({...request(),params:{...DEFAULT_PARAMS,width:63,height:64}})).toThrow(/64/);
    expect(()=>prepareMobileInpaintRequest({...request(),strength:NaN})).toThrow(/强度/);
    expect(()=>decodeMobilePng('not-a-png')).toThrow(/PNG/);
  });
  it('checks the PNG dimensions before decode allocation and clamps the phone strength limits',()=>{
    const bytes=Buffer.from(png(),'base64'); bytes.writeUInt32BE(2000000,16);
    expect(()=>decodeMobilePng(bytes.toString('base64'))).toThrow(/上限/);
    expect(prepareMobileInpaintRequest({...request(),strength:0}).strength).toBe(.01);
    expect(prepareMobileInpaintRequest({...request(),strength:2}).strength).toBe(1);
  });
  it('saves only to the selected new path, preserves existing files and handles cancellation',async()=>{
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'worldpainter-mobile-save-'));
    const file=path.join(dir,'synthetic-result.png');
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({canceled:false,filePath:file});
    const input=png();
    expect((await saveMobileInpaint(input)).ok).toBe(true);
    expect((await fs.readFile(file)).toString('base64')).toBe(input);
    const source = await readMobileInpaintSource(file);
    expect(source.ok).toBe(true); expect(source.image).toMatchObject({filePath:file,width:64,height:64});
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({canceled:false,filePaths:[file]});
    expect((await pickMobileInpaintSource()).image).toEqual(source.image);
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({canceled:true,filePaths:[]});
    expect((await pickMobileInpaintSource()).ok).toBe(false);
    expect((await readMobileInpaintSource(path.join(dir,'credentials.txt'))).ok).toBe(false);
    const second=await saveMobileInpaint(png(64,64,false));
    expect(second.ok).toBe(false);expect(second.message).toContain('已存在');
    expect((await fs.readFile(file)).toString('base64')).toBe(input);
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({canceled:true,filePath:''});
    expect((await saveMobileInpaint(input)).message).toContain('取消');
    await fs.unlink(file);await fs.rmdir(dir);
  });
});

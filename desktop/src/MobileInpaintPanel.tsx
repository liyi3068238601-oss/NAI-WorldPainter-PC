import {localizedDesktopOptionLabel} from "./i18n";
import {mobileInpaintText} from "./mobile-inpaint-text";
import {useEffect,useState} from 'react';
import {useAppStore} from './store';
import {useMobileInpaintStore, pixelsToDataUrl, decodeMobilePixels} from './mobile-inpaint-store';
import {frameToWorld,type MobilePixels} from './mobile-inpaint';
import {processMobilePixels} from './mobile-inpaint-processing';
import {NAI_INPAINT_MODELS,NAI_SAMPLERS,type GenerateParams,type NAIInpaintModel} from './types';
import {executeMobileInpaintRequest} from './store';
import {confirmAction} from './components/confirm';
import type {GatewayProfile} from './gateway-workbench';
import {createMobileGatewayRunner, type ConfirmMobileGatewayBatch} from './mobile-inpaint-gateway-run';
import {mobileNoiseSchedules, mobileOutputChoices, mobileOutputError, mobileSamplerValues} from './mobile-inpaint-capabilities';
import './mobile-inpaint.css';
import './mobile-inpaint-panel.css';

let mobileRunRevision=0;
let activeGatewayRunner: ReturnType<typeof createMobileGatewayRunner> | undefined;
export function cancelMobileInpaint(){mobileRunRevision++;if(activeGatewayRunner)void activeGatewayRunner.cancel();else void useAppStore.getState().cancel();}
export interface MobileInpaintRunOptions {
  gatewayProfileId?: string;
  sampling?: {sampler: string; noiseSchedule: string};
  confirmGatewayBatch?: ConfirmMobileGatewayBatch;
}
const confirmGatewayBatch: ConfirmMobileGatewayBatch = (plan,count,signal) => confirmAction(
  `${plan.profileName} · ${plan.protocol}\n${plan.endpoint}\n${plan.model} · ${plan.width} × ${plan.height}\n${plan.steps} steps · CFG ${plan.scale} · ${plan.sampler} · ${plan.noiseSchedule}\n正向：${plan.prompt}\n负向：${plan.negativePrompt}\n将串行生成 ${count} 张候选，费用由该网关结算。失败或结果不确定时停止，不自动重试。`,
  '确认网关重绘', undefined, signal,
);
/** Freeze all pixels and parameters before any asynchronous account/request work. */
export async function runMobileInpaint(options: MobileInpaintRunOptions = {}) {
  const s=useMobileInpaintStore.getState(), app=useAppStore.getState();
  if(s.busy||app.isGenerating||!s.pixels)return;
  const revision=s.pixels,runRevision=++mobileRunRevision;
  const sampling=options.sampling?{...options.sampling}:undefined;
  const total=Math.max(1,Math.min(30,Math.floor(app.batchCount||1)));
  const gatewayRunner=options.gatewayProfileId
    ? createMobileGatewayRunner(options.gatewayProfileId,total,options.confirmGatewayBatch??confirmGatewayBatch)
    : undefined;
  activeGatewayRunner=gatewayRunner;
  s.update({busy:true,error:''});
  try {
    const worldRect=frameToWorld(s.frame,s.transform);
    const raster=await processMobilePixels({kind:'prepare',source:s.pixels,strokes:s.strokes,layers:s.layers,worldRect,output:s.output,expand:s.expand}) as {image:MobilePixels;mask:MobilePixels;before:MobilePixels};
    const mask=raster.mask;
    if(!mask.data.some((value,index)=>index%4===0&&value>=128))throw Error('输出框中没有需要重绘的区域。请绘制蒙版或将输出框移到原图外。');
    const params:GenerateParams={...app.params,...s.output,steps:Math.max(1,Math.min(app.inpaintModel.startsWith('nai-diffusion-5')?28:50,Math.floor(app.params.steps)||1)),effort:'high',positivePrompt:s.prompt.trim(),negativePrompt:s.negative.trim(),stylePrompt:'',seedMode:'random',seed:0,qualityToggle:false,qualityPreset:'none',ucPreset:3,variety:false,transparentBackground:false,metadataReplay:undefined,preservePromptText:true,smea:false,smeaDyn:false};
    const beforeFrame=raster.before;
    const batchId=crypto.randomUUID();
    const request={params,model:app.inpaintModel,imageBase64:pixelsToDataUrl(raster.image).split(',')[1],maskBase64:pixelsToDataUrl(mask).split(',')[1],strength:s.strength,noise:0,ignoreSource:s.ignoreSource,colorCorrection:s.colorCorrection,sampling,expectedAccountId:app.settings?.naiAccountId,expectedAccountRevision:app.settings?.naiAccountRevision};
    const candidates=[];
    for(let index=0;index<total;index++){
      if(mobileRunRevision!==runRevision)break;
      const result=await (gatewayRunner?gatewayRunner.run(request):executeMobileInpaintRequest(request));
      if(mobileRunRevision!==runRevision||!result)break;
      if(!result.ok)throw Error(result.message||'重绘失败，未自动重试。');
      const added=await Promise.all(result.items.map(async item=>{
      const generated=await decodeMobilePixels(item.fileUrl);
      if(generated.width!==s.output.width||generated.height!==s.output.height)throw Error('生成结果尺寸与冻结的输出框不一致。');
      const {image,comparison}=await processMobilePixels({kind:'layer',generated,mask,base:beforeFrame,outward:s.outwardFeather}) as {image:MobilePixels;comparison:MobilePixels};
      return {id:item.id,batchId,image,worldRect:{...worldRect},dataUrl:pixelsToDataUrl(image),generatedUrl:pixelsToDataUrl(comparison),beforeUrl:pixelsToDataUrl(beforeFrame),seed:item.actualSeed};
    }));
    // A late response belongs to the source that submitted it.
      if(mobileRunRevision!==runRevision)break;
      if(useMobileInpaintStore.getState().pixels!==revision)throw Error('源图已变化。结果已保留在历史中，未放入当前工作区。');
      candidates.push(...added);
      useMobileInpaintStore.getState().setCandidates([...candidates]);
    }
  } catch(error) {useMobileInpaintStore.getState().update({error:error instanceof Error?error.message:String(error)});}
  finally {if(activeGatewayRunner===gatewayRunner)activeGatewayRunner=undefined;useMobileInpaintStore.getState().update({busy:false});}
}

export function MobileInpaintPanel({openSettings}:{openSettings:()=>void}) {
  const language=useAppStore(state=>state.settings?.language);
  const mt=(key:string,values:Record<string,string|number>={})=>mobileInpaintText(language,key,values);
  const s=useMobileInpaintStore(), generating=useAppStore(a=>a.isGenerating);
  const params=useAppStore(a=>a.params),model=useAppStore(a=>a.inpaintModel);
  const maxSteps=model.startsWith('nai-diffusion-5')?28:50;
  const workbench=useAppStore(a=>a.workbenchImage),hasToken=useAppStore(a=>a.account.hasToken);
  const currentImage=useAppStore(a=>a.currentImage);
  const batchCount=useAppStore(a=>a.batchCount);
  const [saving,setSaving]=useState(false);
  const [profiles,setProfiles]=useState<GatewayProfile[]>([]);
  const [channel,setChannel]=useState(()=>{try{return localStorage.getItem('worldpainter.mobile-inpaint.channel.v1')??'';}catch{return '';}});
  const [channelBusy,setChannelBusy]=useState(false);
  const [sampler,setSampler]=useState<string>(params.sampler);
  const [noiseSchedule,setNoiseSchedule]=useState<string>(params.noiseSchedule);
  const selectedProfile=profiles.find(profile=>profile.id===channel);
  const samplers=mobileSamplerValues(selectedProfile?.protocol);
  const schedules=mobileNoiseSchedules(selectedProfile?.protocol);
  const sizes=mobileOutputChoices(model,selectedProfile?.protocol,s.customOutputs);
  if(!sizes.some(size=>size.width===s.output.width&&size.height===s.output.height))sizes.push({...s.output});
  const locked=s.busy||generating||channelBusy;
  async function refreshProfiles(){
    if(!window.worldpainter?.gateway)return;
    try{setProfiles(await window.worldpainter.gateway.listProfiles());}catch(error){s.update({error:String(error)});}
  }
  useEffect(()=>{void refreshProfiles();const refresh=()=>void refreshProfiles();window.addEventListener('focus',refresh);return()=>window.removeEventListener('focus',refresh);},[]);
  useEffect(()=>{if(!samplers.includes(sampler))setSampler(samplers.includes(params.sampler)?params.sampler:'k_euler_ancestral');if(!schedules.includes(noiseSchedule))setNoiseSchedule('karras');},[channel,params.sampler,params.noiseSchedule]);
  async function selectChannel(value:string){
    if(locked)return;
    setChannelBusy(true);
    try{if(value)setProfiles(await window.worldpainter.gateway.selectProfile(value));setChannel(value);try{localStorage.setItem('worldpainter.mobile-inpaint.channel.v1',value);}catch{/* Profile selection still works when browser persistence is unavailable. */}}
    catch(error){s.update({error:String(error)});}finally{setChannelBusy(false);}
  }
  const [sizeDraft,setSizeDraft]=useState({width:String(s.output.width),height:String(s.output.height)});
  useEffect(()=>setSizeDraft({width:String(s.output.width),height:String(s.output.height)}),[s.output.width,s.output.height]);
  const update=s.update;
  function commitOutput(){
    const width=Number(sizeDraft.width),height=Number(sizeDraft.height),error=mobileOutputError(width,height);
    if(error){update({error});setSizeDraft({width:String(s.output.width),height:String(s.output.height)});return;}
    s.addCustomOutput({width,height});s.setOutput({width,height});update({error:''});
  }
  const numberField=(label:string,key:'expand'|'outwardFeather',max:number)=><label className="field"><span>{label}{mt("（输出像素）")}</span><input type="number" min={0} max={max} step={1} value={s[key]} onChange={e=>update({[key]:Math.max(0,Math.min(max,Number(e.target.value)||0))})}/></label>;
  async function importImage(){
    try{const result=await window.naiDesktop.pickMobileInpaintSource();if(result.ok&&result.image)await s.importSource(result.image);else if(result.message)update({error:result.message});}
    catch(error){update({error:String(error)});}
  }
  async function importCurrentResult(){
    if(!currentImage||locked)return;
    await s.importSource(currentImage);
    const imported=useMobileInpaintStore.getState();
    if(imported.error||imported.source?.filePath!==currentImage.filePath)return;
    // Like the phone's result-to-inpaint action, only non-empty result text
    // replaces the independent drafts. Importing pixels never starts generation.
    const prompt=currentImage.params.positivePrompt.trim(),negative=currentImage.params.negativePrompt.trim();
    update({...(prompt?{prompt}:{}),...(negative?{negative}:{})});
  }
  async function save(){
    if(!s.pixels||saving)return;
    setSaving(true);
    try{const image=await processMobilePixels({kind:'compose',source:s.pixels,strokes:s.strokes,layers:s.layers}) as MobilePixels;const result=await window.naiDesktop.saveMobileInpaint(pixelsToDataUrl(image).split(',')[1]);if(!result.ok&&result.message)throw Error(result.message);if(result.ok)useAppStore.getState().setToast(mt("合成图片已另存为新的 PNG。"));}
    catch(error){update({error:String(error)});}finally{setSaving(false);}
  }
  return <>
    <div className="panel-scroll mobile-inpaint-panel">
      <div className="mobile-inpaint-heading"><strong>{mt("新版局部重绘")}</strong><small>{mt("手机端工作区")}</small></div>
      <label className="field"><span>{mt("生成渠道")}</span><select aria-label={mt("新版重绘生成渠道")} disabled={locked} value={channel} onChange={event=>void selectChannel(event.target.value)}><option value="">{mt("NovelAI 官方 / 兼容中继")}</option>{profiles.map(profile=><option key={profile.id} value={profile.id}>{profile.name} · {profile.protocol==='gateway7877'?'7877':'ikun'}</option>)}{channel&&!selectedProfile&&<option value={channel}>{mt("该网关档案已不可用")}</option>}</select></label>
      <div className="mode-buttons"><button className="btn btn-secondary" disabled={locked} onClick={openSettings}>{mt("管理渠道")}</button><button className="btn btn-secondary" disabled={locked} onClick={()=>void refreshProfiles()}>{mt("刷新渠道")}</button></div>
      <small className="field-hint">{mt("网关档案在设置 → 网关工作台管理；各渠道独立保存凭据。网关生成前会确认整批参数与张数。")}</small>
      <div className="mode-buttons"><button className="btn btn-secondary" disabled={s.busy} onClick={()=>void importImage()}>{mt("导入图片")}</button><button className="btn btn-secondary" disabled={!workbench||s.busy} onClick={()=>workbench&&void s.importSource(workbench)}>{mt("使用当前工作图")}</button></div>
      <button className="btn btn-secondary" disabled={!currentImage||locked} onClick={()=>void importCurrentResult()}>{mt("使用当前结果及提示词")}</button>
      {s.source&&<small className="field-hint">{mt("底图")}{" "}{s.pixels?.width} × {s.pixels?.height}{" "}{mt("· 导入按原始像素保留，可使用超分后的图片。")}</small>}
      <small className="field-hint" role="note">{mt("PC 内存保护：底图与合成最多 32 MP。超限操作会保留当前编辑；可缩小输出框、隐藏/移除越界图层后重新保存。超限原图请先缩小或裁剪再导入。")}</small>
      <small className="field-hint">{mt("生成范围由画布上的输出框决定；输出框可移到原图外。")}</small>
      <fieldset className="mobile-output-size"><legend>{mt("处理分辨率")}</legend>
        <select aria-label={mt("新版预设分辨率")} disabled={locked} value={s.output.width+'x'+s.output.height} onChange={e=>{const [width,height]=e.target.value.split('x').map(Number);s.setOutput({width,height});}}>
          {sizes.map(({width,height})=><option key={width+'x'+height} value={width+'x'+height}>{width} × {height}</option>)}
        </select>
        <div className="mobile-size-inputs">{(['width','height'] as const).map(key=><label key={key}>{key==='width'?mt("宽"):mt("高")}<input aria-label={key==='width'?mt("新版处理宽度"):mt("新版处理高度")} type="number" min={64} max={1920} step={64} disabled={locked} value={sizeDraft[key]} onChange={e=>setSizeDraft({...sizeDraft,[key]:e.target.value})} onBlur={commitOutput}/></label>)}</div>
        <small>{mt("改变分辨率保持输出框中心和宽度，按宽高比调整高度。")}</small>
      </fieldset>
      <label className="field"><span>{mt("重绘模型")}</span><select value={model} onChange={e=>useAppStore.getState().setInpaintModel(e.target.value as NAIInpaintModel)}>{NAI_INPAINT_MODELS.map(m=><option key={m.value} value={m.value}>{localizedDesktopOptionLabel(language,m.value,m.label)}</option>)}</select></label>
      <label className="field"><span>{mt("正向提示词")}</span><textarea aria-label={mt("新版正向提示词")} rows={4} value={s.prompt} onChange={e=>update({prompt:e.target.value})}/></label>
      <label className="field"><span>{mt("负向提示词")}</span><textarea aria-label={mt("新版负向提示词")} rows={3} value={s.negative} onChange={e=>update({negative:e.target.value})}/></label>
      <label className="field"><span>{mt("重绘强度")}{" "}{s.strength.toFixed(2)}</span><input aria-label={mt("新版重绘强度")} type="range" min={0.01} max={1} step={0.01} value={s.strength} onChange={e=>update({strength:Number(e.target.value)})}/></label>
      <label className="field"><span>{mt("候选数量")}</span><input aria-label={mt("新版候选数量")} type="number" min={1} max={30} value={batchCount} onChange={e=>useAppStore.getState().setBatchCount(Math.max(1,Math.min(30,Number(e.target.value)||1)))}/></label>
      <details><summary>{mt("蒙版处理与生成参数")}</summary>
        {numberField(mt("蒙版扩展"),'expand',32)}{numberField(mt("羽化"),'outwardFeather',32)}
        <label className="field"><span>{mt("步数")}</span><input aria-label={mt("新版步数")} type="number" min={1} max={maxSteps} value={Math.max(1,Math.min(maxSteps,params.steps))} onChange={e=>useAppStore.getState().setParam('steps',Math.max(1,Math.min(maxSteps,Math.floor(Number(e.target.value))||1)))}/></label>
        <label className="field"><span>{mt("提示词引导")}</span><input type="number" min={0} max={10} step={0.1} value={params.cfgScale} onChange={e=>useAppStore.getState().setParam('cfgScale',Number(e.target.value))}/></label>
        <label className="field"><span>{mt("采样器")}</span><select aria-label={mt("新版采样器")} disabled={locked} value={sampler} onChange={e=>{setSampler(e.target.value);if(NAI_SAMPLERS.some(item=>item.value===e.target.value))useAppStore.getState().setParam('sampler',e.target.value as GenerateParams['sampler']);}}>{samplers.map(value=><option key={value} value={value}>{NAI_SAMPLERS.find(item=>item.value===value)?.label??value}</option>)}</select></label>
        <label className="field"><span>{mt("噪声计划")}</span><select aria-label={mt("新版噪声计划")} disabled={locked} value={noiseSchedule} onChange={e=>setNoiseSchedule(e.target.value)}>{schedules.map(value=><option key={value} value={value}>{value}</option>)}</select></label>
        <label className="field"><span>CFG Rescale</span><input aria-label={mt("新版 CFG Rescale")} disabled={locked} type="number" min={0} max={1} step={0.05} value={params.cfgRescale} onChange={e=>useAppStore.getState().setParam('cfgRescale',Math.min(1,Math.max(0,Number(e.target.value)||0)))}/></label>
        <label><input type="checkbox" checked={s.ignoreSource} onChange={e=>update({ignoreSource:e.target.checked})}/>{" "}{mt("忽略原图")}</label><label><input type="checkbox" checked={s.colorCorrection} onChange={e=>update({colorCorrection:e.target.checked})}/>{" "}{mt("色彩校正")}</label>
        <small className="field-hint">{mt("与手机一致：忽略原图、色彩校正仅在 ikun 通道发送；官方与 7877 不发送。新版每次使用随机 Seed，不带入主界面的角色或参考图。")}</small>
      </details>
      <button className="btn btn-secondary full" disabled={!s.pixels||saving||s.busy} onClick={()=>void save()}>{saving?mt("正在保存…"):mt("合成并另存 PNG")}</button>
      <small className="field-hint">{mt("仅保存底图、图像笔迹和可见结果图层。候选需先手动应用。")}</small>
      {s.error&&<div role="alert" className="mobile-inpaint-error">{mt(s.error)}</div>}
    </div>
    <div className="mobile-inpaint-run"><button className="btn btn-primary full" disabled={!s.pixels||locked||Boolean(channel&&!selectedProfile)} onClick={()=>channel||hasToken?void runMobileInpaint({gatewayProfileId:channel||undefined,sampling:{sampler,noiseSchedule}}):openSettings()}>{s.busy||generating?mt("正在重绘…"):channel||hasToken?mt("生成重绘候选"):mt("配置 NovelAI 账户")}</button>{(s.busy||generating)&&<button className="btn btn-secondary" onClick={cancelMobileInpaint}>{mt("取消")}</button>}</div>
  </>;
}

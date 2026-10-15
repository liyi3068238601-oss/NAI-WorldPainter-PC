import {useEffect,useRef,useState} from 'react';
import type {AppSettings} from '../types';
import type {AgentDiscoveredModel} from '../agent/types';
import {agentProviderKey,newSavedAgentModel,normalizeSavedAgentModels,selectedAgentModelPatch,type SavedAgentModel} from '../agent/model-selections';
import {studioUxText} from '../agent/ux';
import {CommittedNumberInput,SelectMenuCompat} from './ui';

type ModelLimits=Pick<SavedAgentModel,'contextWindow'|'maxOutputTokens'>;
const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,Math.trunc(value)));

export function updateSavedAgentModelLimits(model:SavedAgentModel,patch:Partial<ModelLimits>):SavedAgentModel{
  const contextWindow=clamp(patch.contextWindow??model.contextWindow,8192,2_000_000);
  const maxOutputTokens=clamp(patch.maxOutputTokens??model.maxOutputTokens,512,contextWindow);
  return {...model,contextWindow,maxOutputTokens};
}

export function AgentModelCollection({draft,onChange,disabled}:{draft:Partial<AppSettings>;onChange:(patch:Partial<AppSettings>)=>void;disabled:boolean}) {
  const [found,setFound]=useState<AgentDiscoveredModel[]>([]),[query,setQuery]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const sequence=useRef(0),key=agentProviderKey(draft as AppSettings),t=(name:string)=>studioUxText(draft.language,name);
  const all=normalizeSavedAgentModels(draft.savedAgentModels),selected=all.filter(model=>model.providerKey===key);
  const outputLabel=String(draft.language??'zh-CN').startsWith('zh')?'最大输出 token 数':'Max output tokens';

  useEffect(()=>{sequence.current++;setFound([]);setBusy(false);setMessage('');return()=>{sequence.current++;};},[key,draft.agentApiKey]);
  const persistModel=(model:SavedAgentModel,updated:SavedAgentModel)=>{
    const next=all.map(item=>item.providerKey===model.providerKey&&item.id===model.id?updated:item);
    const isActive=draft.agentApiModel===model.id&&model.providerKey===key;
    onChange({savedAgentModels:next,...(isActive?selectedAgentModelPatch(updated):{})});
  };
  const remove=(id:string)=>{
    const next=all.filter(model=>model.providerKey!==key||model.id!==id),replacement=next.find(model=>model.providerKey===key);
    onChange({savedAgentModels:next,...(draft.agentApiModel===id?(replacement?selectedAgentModelPatch(replacement):{agentApiModel:''}):{})});
  };
  const add=(model:AgentDiscoveredModel)=>{
    if(selected.some(saved=>saved.id===model.id))return;
    const saved=newSavedAgentModel(draft as AppSettings,model);
    onChange({savedAgentModels:[...all,saved],...(!draft.agentApiModel?selectedAgentModelPatch(saved):{})});
  };
  async function discover(){
    const id=++sequence.current;setBusy(true);setMessage('');
    try{
      const result=await window.naiDesktop.discoverAgentModels({protocol:draft.agentApiProtocol!,baseUrl:draft.agentApiBaseUrl??'',apiKey:draft.agentApiKey??'',currentModel:draft.agentApiModel});
      if(id!==sequence.current)return;
      if(result.ok){setFound(result.models);setMessage(result.models.length?t('foundModels'):t('emptyModels'));}
      else setMessage(t('failedModels'));
    }catch{if(id===sequence.current)setMessage(t('failedModels'));}
    finally{if(id===sequence.current)setBusy(false);}
  }
  const filtered=found.filter(model=>`${model.id} ${model.displayName}`.toLowerCase().includes(query.toLowerCase()));
  const commitLimits=(model:SavedAgentModel,patch:Partial<ModelLimits>)=>persistModel(model,updateSavedAgentModelLimits(model,patch));
  const commitVision=(model:SavedAgentModel,vision:boolean)=>persistModel(model,{...model,vision});

  return <section className="pi-model-collection" aria-label={t('selectedModels')}>
    <div className="pi-model-toolbar">
      <button disabled={disabled||busy||!draft.agentApiBaseUrl?.trim()} onClick={()=>void discover()}>{t(busy?'statusRunning':'loadModels')}</button>
      <button disabled={disabled||!draft.agentApiModel?.trim()} onClick={()=>add({id:draft.agentApiModel!.trim(),displayName:draft.agentApiModel!.trim(),metadataSource:'unknown'})}>{t('addModel')}</button>
    </div>
    {message&&<p role="status">{message}</p>}
    {!!found.length&&<>
      <label>{t('searchModels')}<input value={query} onChange={event=>setQuery(event.target.value)}/></label>
      <div className="pi-model-discovery-list">
        {filtered.slice(0,80).map(model=><label key={model.id}>
          <input type="checkbox" disabled={disabled} checked={selected.some(saved=>saved.id===model.id)} onChange={event=>event.target.checked?add(model):remove(model.id)}/>
          <span title={model.id}>{model.displayName}<small>{model.id} · {t(`modelSource_${model.metadataSource}`)}</small></span>
        </label>)}
      </div>
      {filtered.length>80&&<small>{t('filterModelsHint')}</small>}
    </>}
    <h3>{t('selectedModels')}</h3>
    {selected.map(model=>{
      const isActive=draft.agentApiModel===model.id;
      return <div className="pi-saved-model" key={model.id}>
        <div className="pi-model-toolbar">
          <button disabled={disabled} aria-pressed={isActive} onClick={()=>onChange(selectedAgentModelPatch(model))} title={model.id}>{model.displayName}</button>
          <button disabled={disabled} aria-label={`${t('removeModel')}: ${model.id}`} onClick={()=>remove(model.id)}>{t('removeModel')}</button>
        </div>
        <CommittedNumberInput label={t('contextWindow')} value={model.contextWindow} min={8192} max={2_000_000} disabled={disabled}
          normalize={value=>clamp(value,8192,2_000_000)} onCommit={contextWindow=>commitLimits(model,{contextWindow})}/>
        <CommittedNumberInput label={outputLabel} value={model.maxOutputTokens} min={512} max={model.contextWindow} disabled={disabled}
          normalize={value=>clamp(value,512,model.contextWindow)} onCommit={maxOutputTokens=>commitLimits(model,{maxOutputTokens})}/>
        <label className="pi-check"><input type="checkbox" disabled={disabled} checked={model.vision??(isActive&&draft.agentVisionEnabled!==false)} onChange={event=>commitVision(model,event.target.checked)}/>{t('imageAnalysis')}</label>
        <label>{t('reasoningLevel')}<SelectMenuCompat disabled={disabled} value={model.reasoningEffort} onChange={event=>{
          const updated={...model,reasoningEffort:event.target.value as typeof model.reasoningEffort};
          persistModel(model,updated);
        }}>{['auto','low','medium','high'].map(value=><option key={value} value={value}>{t(`reasoning_${value}`)}</option>)}</SelectMenuCompat></label>
      </div>;
    })}
  </section>;
}

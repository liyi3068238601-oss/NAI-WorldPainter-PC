import {useCallback,useEffect,useId,useMemo,useRef,useState,type KeyboardEvent as ReactKeyboardEvent} from 'react';
import type {AppSettings} from '../types';
import type {AgentProviderRegistry} from '../agent/provider-profiles';
import {studioUxText} from '../agent/ux';
import {AnchoredPopover} from './AnchoredPopover';
import './AgentModelPicker.css';

type PickerCopyKey='chooseModel'|'providers'|'models'|'noProviders'|'noModels'|'manageModels'|'vision'|'active'|'selecting'|'selectFailed';
const pickerCopy:Record<PickerCopyKey,{zh:string;en:string;ux:string}>={
  chooseModel:{zh:'选择模型',en:'Choose a model',ux:'modelSettings'},
  providers:{zh:'服务商',en:'Providers',ux:'providerPreset'},
  models:{zh:'模型',en:'Models',ux:'selectedModels'},
  noProviders:{zh:'尚未配置服务商',en:'No providers configured',ux:'selectProvider'},
  noModels:{zh:'此服务商尚未保存模型',en:'No saved models for this provider',ux:'emptyModels'},
  manageModels:{zh:'管理模型',en:'Manage models',ux:'modelSettings'},
  vision:{zh:'视觉',en:'Vision',ux:'imageAnalysis'},
  active:{zh:'当前',en:'Active',ux:'active'},
  selecting:{zh:'切换中',en:'Selecting',ux:'statusRunning'},
  selectFailed:{zh:'切换模型失败，请重试',en:'Could not switch models. Try again.',ux:'resourceActionFailed'},
};

function text(language:AppSettings['language']|undefined,key:PickerCopyKey){
  const entry=pickerCopy[key],locale=String(language??'zh-CN');
  if(locale==='zh-CN')return entry.zh;
  if(locale==='en-US'||!language)return entry.en;
  const translated=studioUxText(language,entry.ux);
  return translated===entry.ux?entry.en:translated;
}

/** Remove configured endpoints and credentials before a user-facing label is rendered. */
export function safeAgentProviderLabel(value:string,baseUrl:string,apiKey:string,fallback:string){
  let safe=value.replace(/https?:\/\/\S+/gi,' ');
  for(const secret of [apiKey,baseUrl])if(secret)safe=safe.split(secret).join(' ');
  safe=safe.replace(/[\r\n\t]+/g,' ').replace(/\s{2,}/g,' ').replace(/^[\s·|,:;—-]+|[\s·|,:;—-]+$/g,'').trim();
  return safe||fallback;
}

export interface AgentModelPickerProps{
  registry:AgentProviderRegistry;
  onSelect:(providerId:string,modelId:string)=>Promise<void>;
  onManage:()=>void;
  disabled:boolean;
  language?:AppSettings['language'];
}

export function AgentModelPicker({registry,onSelect,onManage,disabled,language}:AgentModelPickerProps){
  const anchor=useRef<HTMLButtonElement>(null),providerButtons=useRef(new Map<string,HTMLButtonElement>()),modelButtons=useRef(new Map<string,Map<string,HTMLButtonElement>>()),manageButton=useRef<HTMLButtonElement>(null),focusOnOpen=useRef(false);
  const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[focusedProviderId,setFocusedProviderId]=useState('');
  const panelId=`agent-model-picker-${useId().replace(/:/g,'')}`;
  const activeProvider=registry.providers.find(provider=>provider.id===registry.activeProviderId);
  const preferredProvider=activeProvider??registry.providers[0];
  const shownProvider=registry.providers.find(provider=>provider.id===focusedProviderId)??preferredProvider;
  const shownProviderId=shownProvider?.id;
  const localText=useMemo(()=>Object.fromEntries((Object.keys(pickerCopy) as PickerCopyKey[]).map(key=>[key,text(language,key)])) as Record<PickerCopyKey,string>,[language]);
  const providerName=(provider:AgentProviderRegistry['providers'][number],index:number)=>safeAgentProviderLabel(provider.name,provider.baseUrl,provider.apiKey,`${String(language??'zh-CN').startsWith('zh')?'服务商':'Provider'} ${index+1}`);
  const modelName=(provider:AgentProviderRegistry['providers'][number],model:AgentProviderRegistry['providers'][number]['models'][number],index:number)=>safeAgentProviderLabel(model.displayName,provider.baseUrl,provider.apiKey,`${String(language??'zh-CN').startsWith('zh')?'模型':'Model'} ${index+1}`);
  const close=useCallback(()=>setOpen(false),[]);

  useEffect(()=>{if(disabled&&open)setOpen(false);},[disabled,open]);
  useEffect(()=>{
    if(!open||!focusOnOpen.current)return;
    focusOnOpen.current=false;
    if(shownProviderId){providerButtons.current.get(shownProviderId)?.focus({preventScroll:true});return;}
    manageButton.current?.focus({preventScroll:true});
  },[open,shownProviderId]);

  const focusModelColumn=(provider:AgentProviderRegistry['providers'][number])=>{
    const preferred=provider.models.find(model=>model.id===provider.modelId)??provider.models[0];
    if(preferred)modelButtons.current.get(provider.id)?.get(preferred.id)?.focus({preventScroll:true});
    else manageButton.current?.focus({preventScroll:true});
  };
  const handleProviderKeyDown=(event:ReactKeyboardEvent<HTMLButtonElement>,provider:AgentProviderRegistry['providers'][number],index:number)=>{
    const count=registry.providers.length;
    if(event.key==='ArrowRight'){
      event.preventDefault();setFocusedProviderId(provider.id);
      requestAnimationFrame(()=>focusModelColumn(provider));
      return;
    }
    let targetIndex:number|undefined;
    if(event.key==='ArrowDown')targetIndex=(index+1)%count;
    else if(event.key==='ArrowUp')targetIndex=(index+count-1)%count;
    else if(event.key==='Home')targetIndex=0;
    else if(event.key==='End')targetIndex=count-1;
    if(targetIndex===undefined||!count)return;
    event.preventDefault();
    const target=registry.providers[targetIndex];
    setFocusedProviderId(target.id);providerButtons.current.get(target.id)?.focus({preventScroll:true});
  };
  const handleModelKeyDown=(event:ReactKeyboardEvent<HTMLButtonElement>,provider:AgentProviderRegistry['providers'][number],index:number)=>{
    if(event.key==='ArrowLeft'){
      event.preventDefault();setFocusedProviderId(provider.id);providerButtons.current.get(provider.id)?.focus({preventScroll:true});
      return;
    }
    const count=provider.models.length;
    let targetIndex:number|undefined;
    if(event.key==='ArrowDown')targetIndex=(index+1)%count;
    else if(event.key==='ArrowUp')targetIndex=(index+count-1)%count;
    else if(event.key==='Home')targetIndex=0;
    else if(event.key==='End')targetIndex=count-1;
    if(targetIndex===undefined||!count)return;
    event.preventDefault();
    const target=provider.models[targetIndex];
    modelButtons.current.get(provider.id)?.get(target.id)?.focus({preventScroll:true});
  };

  const toggle=()=>{
    if(disabled)return;
    if(open){setOpen(false);return;}
    setError('');setFocusedProviderId(preferredProvider?.id??'');focusOnOpen.current=true;setOpen(true);
  };
  const choose=async(providerId:string,modelId:string)=>{
    if(disabled||busy)return;
    setBusy(true);setError('');
    try{await onSelect(providerId,modelId);setOpen(false);}
    catch{setError(localText.selectFailed);}
    finally{setBusy(false);}
  };
  const openManagement=()=>{setOpen(false);onManage();};

  const selectedModel=activeProvider?.models.find(model=>model.id===activeProvider.modelId);
  const activeIndex=activeProvider?registry.providers.indexOf(activeProvider):-1;
  const triggerLabel=selectedModel&&activeProvider
    ?`${providerName(activeProvider,activeIndex)} · ${modelName(activeProvider,selectedModel,activeProvider.models.indexOf(selectedModel))}`
    :activeProvider?`${providerName(activeProvider,activeIndex)} · ${localText.chooseModel}`:localText.chooseModel;

  return <>
    <button ref={anchor} type="button" className="agent-model-picker-trigger" disabled={disabled} aria-expanded={open} aria-controls={panelId} aria-label={triggerLabel} title={triggerLabel} onClick={toggle}>
      <span className="agent-model-picker-trigger-name">{triggerLabel}</span><span aria-hidden="true" className="agent-model-picker-chevron">⌄</span>
    </button>
    {open&&<AnchoredPopover anchor={anchor} onClose={close} label={localText.chooseModel}>
      <div id={panelId} className="agent-model-picker-popover">
        <div className="agent-model-picker-heading"><strong>{localText.chooseModel}</strong>{busy&&<span role="status">{localText.selecting}</span>}</div>
        <div className="agent-model-picker-columns">
          <section className="agent-model-picker-provider-column" aria-label={localText.providers}>
            <h3>{localText.providers}</h3>
            <div className="agent-model-picker-provider-list">
              {registry.providers.map((provider,index)=>{
                const isActive=provider.id===registry.activeProviderId,isFocused=shownProvider?.id===provider.id;
                return <button key={provider.id} ref={element=>{if(element)providerButtons.current.set(provider.id,element);else providerButtons.current.delete(provider.id);}} type="button" className={`agent-model-picker-provider${isFocused?' is-focused':''}`} aria-pressed={isFocused} onMouseEnter={()=>setFocusedProviderId(provider.id)} onClick={()=>setFocusedProviderId(provider.id)} onKeyDown={event=>handleProviderKeyDown(event,provider,index)}>
                  <span className="agent-model-picker-provider-name">{providerName(provider,index)}</span>{isActive&&<span className="agent-model-picker-active">{localText.active}</span>}
                </button>;
              })}
              {!registry.providers.length&&<p className="agent-model-picker-empty">{localText.noProviders}</p>}
            </div>
          </section>
          <section className="agent-model-picker-model-column" aria-label={localText.models}>
            <h3>{localText.models}</h3>
            {shownProvider?<div className="agent-model-picker-model-list">
              {shownProvider.models.map((model,index)=>{
                const isSelected=shownProvider.id===registry.activeProviderId&&model.id===shownProvider.modelId;
                return <button key={model.id} ref={element=>{
                  let providerMap=modelButtons.current.get(shownProvider.id);
                  if(element){if(!providerMap){providerMap=new Map();modelButtons.current.set(shownProvider.id,providerMap);}providerMap.set(model.id,element);}
                  else if(providerMap){providerMap.delete(model.id);if(!providerMap.size)modelButtons.current.delete(shownProvider.id);}
                }} type="button" className={`agent-model-picker-model${isSelected?' is-selected':''}`} aria-pressed={isSelected} disabled={disabled||busy} onClick={()=>void choose(shownProvider.id,model.id)} onKeyDown={event=>handleModelKeyDown(event,shownProvider,index)}>
                  <span className="agent-model-picker-model-name">{modelName(shownProvider,model,index)}</span>
                  {model.vision===true&&<span className="agent-model-picker-vision">{localText.vision}</span>}
                  {isSelected&&<span className="agent-model-picker-check" aria-hidden="true">✓</span>}
                </button>;
              })}
              {!shownProvider.models.length&&<p className="agent-model-picker-empty">{localText.noModels}</p>}
            </div>:<p className="agent-model-picker-empty">{localText.noProviders}</p>}
          </section>
        </div>
        {error&&<p className="agent-model-picker-error" role="alert">{error}</p>}
        <div className="agent-model-picker-footer"><button ref={manageButton} type="button" className="agent-model-picker-manage" disabled={disabled||busy} onClick={openManagement}>{localText.manageModels}</button></div>
      </div>
    </AnchoredPopover>}
  </>;
}

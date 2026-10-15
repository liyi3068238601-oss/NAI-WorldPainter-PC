import type {AppSettings} from '../types';
import {agentEffort,agentProviderKey,normalizeSavedAgentModels,selectedAgentModels,type SavedAgentModel} from './model-selections';
import {DEFAULT_AGENT_PROVIDER_PRESET,normalizeAgentApiBaseUrl,normalizeAgentProviderProtocol} from './provider-catalog';
import type {AgentProviderProtocol} from './types';

export interface AgentProviderProfile {
  id:string;
  name:string;
  protocol:AgentProviderProtocol;
  baseUrl:string;
  apiKey:string;
  modelId:string;
  models:SavedAgentModel[];
}

export interface AgentProviderRegistry {
  version:1;
  activeProviderId:string;
  providers:AgentProviderProfile[];
  /** Legacy models whose protocol cannot be represented by the current provider catalog. */
  legacySavedModels?:SavedAgentModel[];
}

const EMPTY_REGISTRY:AgentProviderRegistry={version:1,activeProviderId:'',providers:[]};

function profilesFromLegacyModels(settings:AppSettings,currentKey:string):{providers:AgentProviderProfile[];legacySavedModels:SavedAgentModel[]} {
  const groups=new Map<string,SavedAgentModel[]>();
  const legacySavedModels:SavedAgentModel[]=[];
  for(const model of normalizeSavedAgentModels(settings.savedAgentModels)){
    if(model.providerKey===currentKey)continue;
    const separator=model.providerKey.indexOf('|');
    if(separator<0){legacySavedModels.push(model);continue;}
    const group=groups.get(model.providerKey)??[];
    group.push(model);
    groups.set(model.providerKey,group);
  }
  const knownProtocols=new Set(['openai-compatible','openai-responses','anthropic-messages','google-gemini']);
  const profiles:AgentProviderProfile[]=[];
  for(const [key,models] of groups){
    const separator=key.indexOf('|');
    const legacyProtocol=key.slice(0,separator);
    if(!knownProtocols.has(legacyProtocol)){
      legacySavedModels.push(...models);
      continue;
    }
    const protocol=legacyProtocol as AgentProviderProtocol;
    const baseUrl=normalizeAgentApiBaseUrl(key.slice(separator+1));
    let parsed:URL;
    try{parsed=new URL(baseUrl);}catch{legacySavedModels.push(...models);continue;}
    if(!['http:','https:'].includes(parsed.protocol)||!parsed.hostname||parsed.username||parsed.password){
      legacySavedModels.push(...models);
      continue;
    }
    let label=baseUrl||'未配置端点';
    try{label=new URL(baseUrl).host||label;}catch{/* Keep the legacy endpoint visible for later repair. */}
    let hash=2166136261;
    for(let index=0;index<key.length;index++)hash=Math.imul(hash^key.charCodeAt(index),16777619);
    const providerId=`migrated-${(hash>>>0).toString(36)}`;
    const profile=normalizeProfile({
      id:providerId,name:`已保存服务 · ${label}`,protocol,baseUrl,
      apiKey:'',modelId:models[0]?.id??'',models,
    });
    if(profile)profiles.push(profile);
    else legacySavedModels.push(...models);
  }
  return {providers:profiles,legacySavedModels:normalizeSavedAgentModels(legacySavedModels)};
}

/** The vault key is stable across protocol/URL edits and isolated per saved profile. */
export function agentProviderCredentialKey(profileId:string) {
  return `agentProviders:${profileId}`;
}

function normalizeProfile(value:unknown):AgentProviderProfile|null {
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const raw=value as Record<string,unknown>;
  if(typeof raw.id!=='string'||!raw.id.trim())return null;
  const id=raw.id.trim().slice(0,120);
  const protocol=normalizeAgentProviderProtocol(raw.protocol);
  const baseUrl=normalizeAgentApiBaseUrl(typeof raw.baseUrl==='string'?raw.baseUrl:'').slice(0,2048);
  const modelId=typeof raw.modelId==='string'?raw.modelId.trim().slice(0,300):'';
  const modelSettings={agentApiProtocol:protocol,agentApiBaseUrl:baseUrl};
  const models=normalizeSavedAgentModels(raw.models);
  return {
    id,
    name:typeof raw.name==='string'?raw.name.trim().slice(0,80):'',
    protocol,
    baseUrl,
    apiKey:typeof raw.apiKey==='string'?raw.apiKey.slice(0,32768):'',
    modelId,
    // Saved models already carry their provider key. Keep only the models
    // explicitly bound to this profile's protocol and endpoint; never
    // re-key an unknown provider's entries into another profile.
    models:models.filter(model=>model.providerKey===agentProviderKey(modelSettings)),
  };
}

/** Normalize only explicit registry data. Legacy migration belongs in getAgentProviderRegistry. */
export function normalizeAgentProviderRegistry(value:unknown):AgentProviderRegistry {
  if(!value||typeof value!=='object'||Array.isArray(value))return {...EMPTY_REGISTRY,providers:[]};
  const raw=value as Record<string,unknown>;
  const providers:AgentProviderProfile[]=[];
  const ids=new Set<string>();
  if(Array.isArray(raw.providers))for(const candidate of raw.providers.slice(0,500)){
    const profile=normalizeProfile(candidate);
    if(!profile||ids.has(profile.id))continue;
    ids.add(profile.id);
    providers.push(profile);
  }
  const requested=typeof raw.activeProviderId==='string'?raw.activeProviderId.trim():'';
  const legacySavedModels=normalizeSavedAgentModels(raw.legacySavedModels);
  return {
    version:1,activeProviderId:ids.has(requested)?requested:'',providers,
    ...(legacySavedModels.length?{legacySavedModels}:{}),
  };
}

/** Migrate the old single flat configuration once, retaining its selected model and settings. */
export function getAgentProviderRegistry(settings:AppSettings):AgentProviderRegistry {
  if(settings.agentProviders!==undefined&&settings.agentProviders!==null){
    return normalizeAgentProviderRegistry(settings.agentProviders);
  }
  const id='legacy-default';
  const currentModelId=String(settings.agentApiModel??'').trim();
  const currentProviderKey=agentProviderKey(settings);
  // During the one-time migration, the flat fields are authoritative for the
  // active model. An older saved-model entry may predate a later flat-setting
  // edit, so preserve its identity/display name but refresh only its settings.
  const models=selectedAgentModels(settings);
  const migratedModels=currentModelId?normalizeSavedAgentModels(models.map(model=>
    model.id===currentModelId&&model.providerKey===currentProviderKey?{
      ...model,
      contextWindow:settings.agentContextWindow,
      maxOutputTokens:settings.agentMaxOutputTokens,
      reasoningEffort:agentEffort(settings.agentReasoningEffort),
      // Store normalization defaults this setting to true when it is absent.
      vision:settings.agentVisionEnabled!==false,
    }:model,
  )):models;
  const profile=normalizeProfile({
    id,
    name:settings.agentProviderName||DEFAULT_AGENT_PROVIDER_PRESET.providerName,
    protocol:settings.agentApiProtocol||DEFAULT_AGENT_PROVIDER_PRESET.protocol,
    baseUrl:typeof settings.agentApiBaseUrl==='string'?settings.agentApiBaseUrl:DEFAULT_AGENT_PROVIDER_PRESET.baseUrl,
    apiKey:settings.agentApiKey||'',
    modelId:settings.agentApiModel||'',
    models:migratedModels,
  });
  if(!profile)return {...EMPTY_REGISTRY,providers:[]};
  const migrated=profilesFromLegacyModels(settings,agentProviderKey(settings));
  return {
    version:1,activeProviderId:id,providers:[profile,...migrated.providers],
    ...(migrated.legacySavedModels.length?{legacySavedModels:migrated.legacySavedModels}:{}),
  };
}

export function selectAgentProviderModel(
  registryValue:AgentProviderRegistry,
  providerId:string,
  modelId:string,
):AgentProviderRegistry {
  const registry=normalizeAgentProviderRegistry(registryValue);
  const provider=registry.providers.find(item=>item.id===providerId);
  const id=String(modelId??'').trim();
  if(!provider||!id||!provider.models.some(model=>model.id===id&&model.providerKey===agentProviderKey({agentApiProtocol:provider.protocol,agentApiBaseUrl:provider.baseUrl})))return registry;
  return {
    ...registry,
    activeProviderId:providerId,
    providers:registry.providers.map(item=>item.id===providerId?{...item,modelId:id}:item),
  };
}

function selectedModel(profile:AgentProviderProfile|undefined) {
  if(!profile||!profile.modelId)return undefined;
  return profile.models.find(model=>model.id===profile.modelId);
}

/** Project one provider atomically to the legacy runtime settings consumed by existing callers. */
export function agentProviderSettingsPatch(registryValue:AgentProviderRegistry):Partial<AppSettings> {
  const registry=normalizeAgentProviderRegistry(registryValue);
  const profile=registry.providers.find(item=>item.id===registry.activeProviderId);
  const model=selectedModel(profile);
  if(!profile)return {
    agentApiProtocol:'openai-compatible',agentApiBaseUrl:'',agentApiKey:'',agentApiModel:'',agentProviderName:'',
    agentContextWindow:128000,agentMaxOutputTokens:8192,agentReasoningEffort:'auto',agentVisionEnabled:false,
    savedAgentModels:registry.legacySavedModels??[],
  };
  return {
    agentApiProtocol:profile.protocol,
    agentApiBaseUrl:profile.baseUrl,
    agentApiKey:profile.apiKey,
    agentApiModel:profile.modelId,
    agentProviderName:profile.name,
    agentContextWindow:model?.contextWindow??128000,
    agentMaxOutputTokens:model?.maxOutputTokens??8192,
    agentReasoningEffort:model?.reasoningEffort??'auto',
    agentVisionEnabled:model?.vision??false,
    savedAgentModels:normalizeSavedAgentModels([...profile.models,...(registry.legacySavedModels??[])]),
  };
}

/** Keep old flat-setting callers compatible without letting them revive a stale active profile. */
export function syncActiveAgentProviderFromSettings(
  registryValue:AgentProviderRegistry,
  settings:AppSettings,
  changedKeys:readonly (keyof AppSettings)[]=[],
):AgentProviderRegistry {
  const registry=normalizeAgentProviderRegistry(registryValue);
  const current=registry.providers.find(item=>item.id===registry.activeProviderId);
  if(!current)return registry;
  const protocol=normalizeAgentProviderProtocol(settings.agentApiProtocol);
  const baseUrl=normalizeAgentApiBaseUrl(settings.agentApiBaseUrl);
  const providerKey=agentProviderKey({agentApiProtocol:protocol,agentApiBaseUrl:baseUrl});
  const selectedId=String(settings.agentApiModel??'').trim();
  // When the model list itself is explicitly replaced, its entries are the
  // source of truth. Otherwise retain the selected manually configured model
  // through the legacy single-provider API.
  let models=changedKeys.includes('savedAgentModels')
    ?normalizeSavedAgentModels(settings.savedAgentModels).filter(model=>model.providerKey===providerKey)
    :selectedAgentModels(settings);
  const parameterFieldsChanged=changedKeys.some(key=>
    ['agentContextWindow','agentMaxOutputTokens','agentReasoningEffort','agentVisionEnabled'].includes(key),
  );
  if(selectedId&&parameterFieldsChanged)models=models.map(model=>{
    if(model.id!==selectedId||model.providerKey!==providerKey)return model;
    return normalizeSavedAgentModels([{
      ...model,
      ...(changedKeys.includes('agentContextWindow')?{contextWindow:settings.agentContextWindow}:{}),
      ...(changedKeys.includes('agentMaxOutputTokens')?{maxOutputTokens:settings.agentMaxOutputTokens}:{}),
      ...(changedKeys.includes('agentReasoningEffort')?{reasoningEffort:settings.agentReasoningEffort}:{}),
      ...(changedKeys.includes('agentVisionEnabled')?{vision:settings.agentVisionEnabled}:{}),
    }])[0];
  });
  const next:AgentProviderProfile={
    ...current,
    name:String(settings.agentProviderName??current.name).trim().slice(0,80),
    protocol,
    baseUrl,
    apiKey:String(settings.agentApiKey??''),
    modelId:String(settings.agentApiModel??'').trim().slice(0,300),
    models,
  };
  const providers=registry.providers.map(item=>item.id===current.id?next:item);
  const currentKey=agentProviderKey(settings);
  const represented=new Set(providers.flatMap(profile=>profile.models.map(model=>`${model.providerKey}\0${model.id}`)));
  const unrepresented=normalizeSavedAgentModels(settings.savedAgentModels).filter(model=>
    model.providerKey!==currentKey&&!represented.has(`${model.providerKey}\0${model.id}`),
  );
  return {
    ...registry,providers,
    ...(unrepresented.length
      ?{legacySavedModels:normalizeSavedAgentModels([...(registry.legacySavedModels??[]),...unrepresented])}
      :{}),
  };
}

/** Validate persisted profiles at the IPC boundary; incomplete values remain valid in unsaved UI drafts. */
export function assertSavableAgentProviderRegistry(registryValue:unknown):AgentProviderRegistry {
  const registry=normalizeAgentProviderRegistry(registryValue);
  for(const profile of registry.providers){
    if(!profile.name)throw new Error('请填写每个 Agent 服务的名称。');
    let parsed:URL;
    try{parsed=new URL(profile.baseUrl);}catch{throw new Error(`请为「${profile.name}」填写有效的 HTTP(S) 服务地址。`);}
    if(!['http:','https:'].includes(parsed.protocol)||!parsed.hostname||parsed.username||parsed.password){
      throw new Error(`请为「${profile.name}」填写有效的 HTTP(S) 服务地址。`);
    }
  }
  if(registry.providers.length&&!registry.activeProviderId)throw new Error('请选择一个已保存的 Agent 服务。');
  return registry;
}

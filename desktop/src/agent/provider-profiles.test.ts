import {describe,expect,it} from 'vitest';
import type {AppSettings} from '../types';
import {
  agentProviderSettingsPatch,
  assertSavableAgentProviderRegistry,
  getAgentProviderRegistry,
  normalizeAgentProviderRegistry,
  selectAgentProviderModel,
} from './provider-profiles';

const legacy={
  agentApiProtocol:'anthropic-messages',agentApiBaseUrl:'https://api.anthropic.example/v1/',agentApiKey:'legacy-secret',
  agentApiModel:'claude-legacy',agentProviderName:'Legacy Claude',agentContextWindow:196000,agentMaxOutputTokens:12000,
  agentVisionEnabled:true,agentReasoningEffort:'high',savedAgentModels:[
    {providerKey:'anthropic-messages|https://api.anthropic.example/v1',id:'saved-claude',displayName:'Saved Claude',contextWindow:196000,maxOutputTokens:12000,reasoningEffort:'high',vision:true},
    {providerKey:'openai-compatible|https://other.example/v1',id:'foreign',displayName:'Foreign',contextWindow:64000,maxOutputTokens:4000,reasoningEffort:'auto'},
  ],
} as AppSettings;

describe('Agent provider registry migration and projection',()=>{
  it('migrates the active flat provider and preserves other known-provider models in credential-free profiles',()=>{
    const registry=getAgentProviderRegistry(legacy);
    expect(registry).toMatchObject({version:1,activeProviderId:'legacy-default'});
    expect(registry.providers.find(profile=>profile.id==='legacy-default')).toMatchObject({
      id:'legacy-default',name:'Legacy Claude',protocol:'anthropic-messages',baseUrl:'https://api.anthropic.example/v1',
      apiKey:'legacy-secret',modelId:'claude-legacy',
    });
    expect(registry.providers.find(profile=>profile.id==='legacy-default')?.models.map(model=>model.id)).toEqual(['claude-legacy','saved-claude']);
    expect(registry.providers.find(profile=>profile.id.startsWith('migrated-'))).toMatchObject({
      protocol:'openai-compatible',baseUrl:'https://other.example/v1',apiKey:'',modelId:'foreign',
      models:[{id:'foreign',providerKey:'openai-compatible|https://other.example/v1'}],
    });
    expect(agentProviderSettingsPatch(registry)).toMatchObject({
      agentApiProtocol:'anthropic-messages',agentApiBaseUrl:'https://api.anthropic.example/v1',agentApiKey:'legacy-secret',
      agentApiModel:'claude-legacy',agentProviderName:'Legacy Claude',agentContextWindow:196000,
      agentMaxOutputTokens:12000,agentReasoningEffort:'high',agentVisionEnabled:true,
    });
  });

  it('uses legacy flat settings for the current model when its saved entry is stale, without changing other models',()=>{
    const settings={...legacy,agentVisionEnabled:undefined,savedAgentModels:[
      {providerKey:'anthropic-messages|https://api.anthropic.example/v1',id:'claude-legacy',displayName:'Selected Claude',contextWindow:64000,maxOutputTokens:4096,reasoningEffort:'low',vision:false},
      {providerKey:'anthropic-messages|https://api.anthropic.example/v1',id:'saved-claude',displayName:'Other Claude',contextWindow:128000,maxOutputTokens:6000,reasoningEffort:'medium',vision:false},
    ]} as unknown as AppSettings;

    const registry=getAgentProviderRegistry(settings);
    const migrated=registry.providers.find(profile=>profile.id==='legacy-default');
    expect(migrated?.models.find(model=>model.id==='claude-legacy')).toMatchObject({
      displayName:'Selected Claude',contextWindow:196000,maxOutputTokens:12000,reasoningEffort:'high',vision:true,
    });
    expect(migrated?.models.find(model=>model.id==='saved-claude')).toMatchObject({
      displayName:'Other Claude',contextWindow:128000,maxOutputTokens:6000,reasoningEffort:'medium',vision:false,
    });
    expect(agentProviderSettingsPatch(registry)).toMatchObject({
      agentContextWindow:196000,agentMaxOutputTokens:12000,agentReasoningEffort:'high',agentVisionEnabled:true,
    });
  });

  it('archives unknown legacy provider keys without creating invalid profiles or losing flat models',()=>{
    const settings={...legacy,savedAgentModels:[
      {providerKey:'future-protocol|https://future.example/v1',id:'future-model',displayName:'Future',contextWindow:64000,maxOutputTokens:4000,reasoningEffort:'auto'},
      {providerKey:'openai-compatible|not a URL',id:'malformed-model',displayName:'Malformed',contextWindow:64000,maxOutputTokens:4000,reasoningEffort:'auto'},
    ]} as AppSettings;
    const registry=getAgentProviderRegistry(settings);
    expect(registry.activeProviderId).toBe('legacy-default');
    expect(registry.providers.some(profile=>profile.id.startsWith('migrated-unresolved-'))).toBe(false);
    expect(registry.legacySavedModels?.map(model=>model.id)).toEqual(['future-model','malformed-model']);
    expect(agentProviderSettingsPatch(registry).savedAgentModels?.map(model=>model.id)).toEqual(['claude-legacy','future-model','malformed-model']);
    expect(selectAgentProviderModel(registry,'missing','future-model').activeProviderId).toBe('legacy-default');
    expect(()=>assertSavableAgentProviderRegistry(registry)).not.toThrow();
  });

  it('preserves archived models while normalizing and projecting an explicit registry',()=>{
    const archive=[{providerKey:'future-protocol|https://future.example/v1',id:'future-model',displayName:'Future',contextWindow:64000,maxOutputTokens:4000,reasoningEffort:'auto'}];
    const registry=normalizeAgentProviderRegistry({version:1,activeProviderId:'profile',legacySavedModels:archive,providers:[{
      id:'profile',name:'Known',protocol:'openai-compatible',baseUrl:'https://known.example/v1',apiKey:'',modelId:'known-model',models:[
        {providerKey:'openai-compatible|https://known.example/v1',id:'known-model',displayName:'Known',contextWindow:64000,maxOutputTokens:4000,reasoningEffort:'auto'},
      ],
    }]});
    expect(registry.legacySavedModels?.map(model=>model.id)).toEqual(['future-model']);
    expect(agentProviderSettingsPatch(registry).savedAgentModels?.map(model=>model.id)).toEqual(['known-model','future-model']);
  });

  it('does not infer legacy profiles while normalizing explicit empty or incomplete registries',()=>{
    expect(normalizeAgentProviderRegistry({version:1,activeProviderId:'missing',providers:[]}))
      .toEqual({version:1,activeProviderId:'',providers:[]});
    expect(getAgentProviderRegistry({...legacy,agentProviders:{version:1,activeProviderId:'',providers:[]}} as AppSettings))
      .toEqual({version:1,activeProviderId:'',providers:[]});
    const draft=normalizeAgentProviderRegistry({version:1,activeProviderId:'draft',providers:[{
      id:'draft',name:'Draft provider',protocol:'openai-compatible',baseUrl:'',apiKey:'',modelId:'',models:[],
    }]});
    expect(draft.providers[0]).toMatchObject({id:'draft',baseUrl:'',modelId:'',models:[]});
    expect(()=>assertSavableAgentProviderRegistry(draft)).toThrow('有效的 HTTP(S)');
  });

  it('keeps same-endpoint profiles, their credentials, and model lists isolated',()=>{
    const value=normalizeAgentProviderRegistry({version:1,activeProviderId:'one',providers:[
      {id:'one',name:'First',protocol:'openai-compatible',baseUrl:'https://same.example/v1',apiKey:'key-one',modelId:'model-one',models:[
        {providerKey:'openai-compatible|https://same.example/v1',id:'model-one',displayName:'One',contextWindow:64000,maxOutputTokens:4000,reasoningEffort:'low'},
      ]},
      {id:'two',name:'Second',protocol:'openai-compatible',baseUrl:'https://same.example/v1',apiKey:'key-two',modelId:'',models:[]},
    ]});
    const switched=selectAgentProviderModel(value,'two','model-two');
    expect(switched.activeProviderId).toBe('one');
    expect(switched.providers.find(profile=>profile.id==='two')?.modelId).toBe('');
    const selectable=normalizeAgentProviderRegistry({...value,providers:value.providers.map(profile=>profile.id==='two'?{
      ...profile,models:[{providerKey:'openai-compatible|https://same.example/v1',id:'model-two',displayName:'Two',contextWindow:32000,maxOutputTokens:2000,reasoningEffort:'auto'}],
    }:profile)});
    const selected=selectAgentProviderModel(selectable,'two','model-two');
    expect(selected.activeProviderId).toBe('two');
    expect(agentProviderSettingsPatch(selected)).toMatchObject({agentApiKey:'key-two',agentApiModel:'model-two',agentContextWindow:32000,agentMaxOutputTokens:2000});
    expect(selected.providers.find(profile=>profile.id==='one')?.models.map(model=>model.id)).toEqual(['model-one']);
    expect(assertSavableAgentProviderRegistry(selected)).toBeTruthy();
  });
});

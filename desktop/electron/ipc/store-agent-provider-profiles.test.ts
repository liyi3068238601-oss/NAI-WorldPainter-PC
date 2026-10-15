import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {WORLDPAINTER_STORE_FILE} from '../../shared/worldpainter-product';

const fixture=vi.hoisted(()=>({root:''}));
vi.mock('electron',()=>({
  app:{isPackaged:false,getPath:()=>fixture.root,getAppPath:()=>fixture.root},
  safeStorage:{
    isEncryptionAvailable:()=>true,
    encryptString:(value:string)=>Buffer.from(`vault:${value}`),
    decryptString:(value:Buffer)=>{
      const decoded=value.toString();if(!decoded.startsWith('vault:'))throw new Error('unknown vault context');return decoded.slice(6);
    },
  },
}));

const profile=(id:string,name:string,apiKey:string,modelId:string)=>({
  id,name,protocol:'openai-compatible' as const,baseUrl:'https://models.example/v1',apiKey,modelId,
  models:modelId?[{providerKey:'openai-compatible|https://models.example/v1',id:modelId,displayName:modelId,contextWindow:64000,maxOutputTokens:4000,reasoningEffort:'medium' as const,vision:true}]:[],
});
const registry=(activeProviderId:string,providers:ReturnType<typeof profile>[])=>({version:1 as const,activeProviderId,providers});

beforeEach(()=>{fixture.root=fs.mkdtempSync(path.join(os.tmpdir(),'agent-profiles-store-'));vi.resetModules();});
afterEach(()=>{
  vi.restoreAllMocks();
  if(path.dirname(fixture.root)!==path.resolve(os.tmpdir())||!path.basename(fixture.root).startsWith('agent-profiles-store-'))throw new Error('Invalid fixture cleanup');
  fs.rmSync(fixture.root,{recursive:true,force:true});
});

it('atomically stores encrypted per-profile credentials and projects the active profile to flat runtime settings',async()=>{
  const store=await import('./store');
  const profiles=registry('first',[
    profile('first','First','secret-first','model-first'),profile('second','Second','secret-second','model-second'),
  ]);
  store.setSetting('agentProviders',profiles);
  expect(store.getSettings()).toMatchObject({agentApiBaseUrl:'https://models.example/v1',agentApiKey:'secret-first',agentApiModel:'model-first',agentProviderName:'First'});
  expect(store.getSettings().agentProviders?.providers.map(item=>item.apiKey)).toEqual(['secret-first','secret-second']);
  store.setSetting('agentProviders',{...profiles,activeProviderId:'second'});
  expect(store.getSettings()).toMatchObject({agentApiKey:'secret-second',agentApiModel:'model-second',agentProviderName:'Second'});
  expect(JSON.stringify(store.getSettings().agentProviders)).not.toContain('enc:v1:');
  store.setSetting('agentProviders',{...profiles,activeProviderId:'first'});
  expect(store.getSettings()).toMatchObject({agentApiKey:'secret-first',agentApiModel:'model-first',agentProviderName:'First'});
  expect(store.getSettings().agentProviders?.providers.map(item=>item.apiKey)).toEqual(['secret-first','secret-second']);
  const file=path.join(fixture.root,WORLDPAINTER_STORE_FILE);
  const onDisk=JSON.parse(fs.readFileSync(file,'utf8'));
  expect(onDisk.settings.agentApiKey).toMatch(/^enc:v1:/);
  expect(onDisk.settings.agentProviders.providers.map((item:any)=>item.apiKey)).toEqual([
    expect.stringMatching(/^enc:v1:/),expect.stringMatching(/^enc:v1:/),
  ]);
  expect(JSON.stringify(onDisk)).not.toContain('secret-first');
  expect(JSON.stringify(onDisk)).not.toContain('secret-second');
  vi.resetModules();
  const reopened=await import('./store');
  expect(reopened.getSettings()).toMatchObject({agentApiKey:'secret-first',agentProviders:{activeProviderId:'first',providers:[
    {id:'first',apiKey:'secret-first'},{id:'second',apiKey:'secret-second'},
  ]}});
});

it('updates registry when an older flat setting caller changes the active provider',async()=>{
  const store=await import('./store');
  store.setSetting('agentProviders',registry('first',[profile('first','First','first-key','old-model'),profile('second','Second','second-key','second-model')]));
  store.setSetting('agentApiBaseUrl','https://changed.example/v1');
  store.setSetting('agentApiKey','changed-key');
  store.setSetting('agentApiModel','new-model');
  const settings=store.getSettings();
  expect(settings.agentApiBaseUrl).toBe('https://changed.example/v1');
  expect(settings.agentApiKey).toBe('changed-key');
  expect(settings.agentApiModel).toBe('new-model');
  expect(settings.agentProviders?.providers).toMatchObject([
    {id:'first',baseUrl:'https://changed.example/v1',apiKey:'changed-key',modelId:'new-model'},
    {id:'second',baseUrl:'https://models.example/v1',apiKey:'second-key',modelId:'second-model'},
  ]);
  expect(settings.agentProviders?.providers[0].models.some(model=>model.id==='new-model')).toBe(true);
});

it('applies legacy flat model-parameter setters to the selected model and keeps them after cold read',async()=>{
  const store=await import('./store');
  store.setSetting('agentProviders',registry('active',[profile('active','Active','active-key','selected-model')]));
  store.setSetting('agentContextWindow',65536);
  store.setSetting('agentMaxOutputTokens',8192);
  store.setSetting('agentReasoningEffort','high');
  store.setSetting('agentVisionEnabled',false);
  const expected={agentContextWindow:65536,agentMaxOutputTokens:8192,agentReasoningEffort:'high',agentVisionEnabled:false};
  expect(store.getSettings()).toMatchObject(expected);
  expect(store.getSettings().agentProviders?.providers[0].models[0]).toMatchObject({
    id:'selected-model',contextWindow:65536,maxOutputTokens:8192,reasoningEffort:'high',vision:false,
  });
  vi.resetModules();
  const reopened=await import('./store');
  expect(reopened.getSettings()).toMatchObject(expected);
  expect(reopened.getSettings().agentProviders?.providers[0].models[0]).toMatchObject({
    id:'selected-model',contextWindow:65536,maxOutputTokens:8192,reasoningEffort:'high',vision:false,
  });
});

it('uses a savedAgentModels setter list as the parameter source instead of stale flat values',async()=>{
  const store=await import('./store');
  store.setSetting('agentProviders',registry('active',[profile('active','Active','active-key','selected-model')]));
  const models=[{
    providerKey:'openai-compatible|https://models.example/v1',id:'selected-model',displayName:'Selected',contextWindow:32768,
    maxOutputTokens:2048,reasoningEffort:'low' as const,vision:false,
  }];
  store.setSetting('savedAgentModels',models);
  expect(store.getSettings()).toMatchObject({agentContextWindow:32768,agentMaxOutputTokens:2048,agentReasoningEffort:'low',agentVisionEnabled:false});
  expect(store.getSettings().agentProviders?.providers[0].models).toEqual(models);
});

it('applies direct legacy writeStore parameter changes to the selected model',async()=>{
  const store=await import('./store');
  store.setSetting('agentProviders',registry('active',[profile('active','Active','active-key','selected-model')]));
  const before=store.readStore();
  store.writeStore({...before,settings:{...before.settings,agentContextWindow:65536,agentReasoningEffort:'high'}});
  expect(store.getSettings()).toMatchObject({agentContextWindow:65536,agentReasoningEffort:'high'});
  expect(store.getSettings().agentProviders?.providers[0].models[0]).toMatchObject({contextWindow:65536,reasoningEffort:'high'});
});

it('round trips archived legacy model keys through the encrypted registry store',async()=>{
  const store=await import('./store');
  const archive=[{providerKey:'future-protocol|https://future.example/v1',id:'future-model',displayName:'Future',contextWindow:64000,maxOutputTokens:4000,reasoningEffort:'auto'}];
  store.setSetting('agentProviders',{...registry('known',[profile('known','Known','known-key','known-model')]),legacySavedModels:archive});
  expect(store.getSettings().savedAgentModels.map(model=>model.id)).toEqual(['known-model','future-model']);
  vi.resetModules();
  const reopened=await import('./store');
  expect(reopened.getSettings().agentProviders?.legacySavedModels?.map(model=>model.id)).toEqual(['future-model']);
  expect(reopened.getSettings().savedAgentModels.map(model=>model.id)).toEqual(['known-model','future-model']);
});

it('preserves an unreadable nested credential during unrelated saves and blocks deleting its profile',async()=>{
  const store=await import('./store');
  store.setSetting('agentProviders',registry('locked',[profile('locked','Locked','will-be-corrupted','model')]));
  const file=path.join(fixture.root,WORLDPAINTER_STORE_FILE);
  const raw=JSON.parse(fs.readFileSync(file,'utf8'));
  raw.settings.agentProviders.providers[0].apiKey='enc:v1:unreadable-fixture';
  fs.writeFileSync(file,JSON.stringify(raw));
  vi.resetModules();
  const reopened=await import('./store');
  expect(reopened.getSettings().agentProviders?.providers[0].apiKey).toBe('');
  expect(reopened.credentialIssues()).toContain('agentProviders:locked');
  reopened.setSetting('language','en-US');
  const preserved=JSON.parse(fs.readFileSync(file,'utf8'));
  expect(preserved.settings.agentProviders.providers[0].apiKey).toBe('enc:v1:unreadable-fixture');
  expect(()=>reopened.setSetting('agentProviders',registry('',[]))).toThrow('凭据仍处于锁定状态');
  expect(JSON.parse(fs.readFileSync(file,'utf8')).settings.agentProviders.providers[0].apiKey).toBe('enc:v1:unreadable-fixture');
});

it('migrates the old flat key into a locked per-profile slot before completing registry migration',async()=>{
  const store=await import('./store');
  store.setSetting('agentApiKey','legacy-key-fixture');
  const file=path.join(fixture.root,WORLDPAINTER_STORE_FILE);
  const raw=JSON.parse(fs.readFileSync(file,'utf8'));
  delete raw.settings.agentProviders;
  raw.settings.agentApiKey='enc:v1:unreadable-legacy-fixture';
  fs.writeFileSync(file,JSON.stringify(raw));
  vi.resetModules();
  const reopened=await import('./store');
  const settings=reopened.getSettings();
  expect(settings.agentProviders?.activeProviderId).toBe('legacy-default');
  expect(settings.agentApiKey).toBe('');
  expect(reopened.credentialIssues()).toContain('agentProviders:legacy-default');
  const migrated=JSON.parse(fs.readFileSync(file,'utf8'));
  expect(migrated.settings.agentProviders.providers[0].apiKey).toBe('enc:v1:unreadable-legacy-fixture');
  expect(()=>reopened.setSetting('agentProviders',registry('',[]))).toThrow('凭据仍处于锁定状态');
});

it('leaves both cached settings and disk unchanged when the combined registry write fails',async()=>{
  const store=await import('./store');
  store.setSetting('agentProviders',registry('first',[profile('first','First','stable-key','model-first')]));
  const file=path.join(fixture.root,WORLDPAINTER_STORE_FILE),before=fs.readFileSync(file);
  const original=fs.renameSync.bind(fs);
  vi.spyOn(fs,'renameSync').mockImplementation((...args:any[])=>{
    if(String(args[1])===file)throw Object.assign(new Error('fixture disk failure'),{code:'ENOSPC'});
    return original(...args);
  });
  expect(()=>store.setSetting('agentProviders',registry('second',[profile('second','Second','new-key','model-second')]))).toThrow('fixture disk failure');
  expect(store.getSettings()).toMatchObject({agentApiKey:'stable-key',agentApiModel:'model-first',agentProviders:{activeProviderId:'first'}});
  expect(fs.readFileSync(file)).toEqual(before);
});

import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import fs from 'node:fs/promises';import path from 'node:path';import JSZip from 'jszip';
const fixture=vi.hoisted(()=>({root:'',store:{settings:{},history:[],historyGroups:[],reverseHistory:[],convertHistory:[]} as any,agentSqlStore:null as any}));
vi.mock('electron',()=>({app:{getPath:()=>fixture.root,getVersion:()=> 'test'},dialog:{showOpenDialog:vi.fn()}}));
vi.mock('./store',()=>({credentialIssues:()=>[],defaultSettings:{},readStore:()=>fixture.store,writeStore:(value:unknown)=>{fixture.store=value;},ensureOutputDir:()=>fixture.root}));
vi.mock('./local-media',()=>({imageFileUrl:(p:string)=>p}));
vi.mock('./agent-store',async()=>{
 const actual=await vi.importActual<typeof import('./agent-store')>('./agent-store');
 return {...actual,getAgentSqlStore:()=>fixture.agentSqlStore,readAgentWorkspace:()=>fixture.agentSqlStore?.readWorkspace(),normalizeAgentWorkspace:(value:unknown)=>value,agentAttachmentsDirectory:()=>path.join(fixture.root,'attachments'),mergeImportedAgentWorkspace:vi.fn(()=>({imported:0,skipped:0,renamed:0}))};
});
vi.mock('./artist-favorites',()=>({ARTIST_FAVORITE_COLLECTIONS:['random','v5-repair','artist-string-draw'],loadArtistFavoriteLibrary:vi.fn(async()=>({collections:{}})),importArtistFavoriteLibrary:vi.fn()}));
vi.mock('./reference-presets',()=>({listReferencePresets:async()=>({groups:[],presets:[]}),importReferencePresets:vi.fn()}));
vi.mock('./nai-accounts',()=>({exportNaiAccountsBackup:()=>[],prepareNaiAccountsBackupRestore:async()=>undefined}));
import {ARTIST_FAVORITE_COLLECTIONS} from './artist-favorites';
import {exportDataBackup,importDataBackup,inspectDataBackup} from './data-backup';
import {createAgentSqlStore} from './r4-store';
import {createEmptyR4AgentState} from '../../src/agent/r4-types';
import type {AgentWorkspaceData} from '../../src/agent/types';
const EMPTY_STAMP='2026-10-18T00:00:00.000Z';
let sqlStoreSequence=0;
function emptyWorkspace(conversations:any[]=[]):AgentWorkspaceData{return {
 version:1,updatedAt:EMPTY_STAMP,conversations,characters:[],personas:[],lorebooks:[],samplerPresets:[],skills:[],memories:[],
 studioDefaults:{},defaultGenerationMode:'tavern',
} as any;}
function conversation(id:string,title:string){return {
 id,title,createdAt:EMPTY_STAMP,updatedAt:EMPTY_STAMP,status:'idle',messages:[],draftAttachments:[],characterIds:[],lorebookIds:[],
 selectedSkillIds:[],studioApprovalMode:'confirm',studioWebSearchEnabled:true,studioTemplateEnabled:true,reasoningEffort:'auto',
 autoPlayGroup:false,pinned:false,compactCount:0,
};}
function resetAgentSqlStore(workspace=emptyWorkspace(),r4State=createEmptyR4AgentState()){
 fixture.agentSqlStore?.close();
 fixture.agentSqlStore=createAgentSqlStore({filename:path.join(fixture.root,`agent-sql-${++sqlStoreSequence}`,'agent-state.sqlite'),legacyFiles:[],loadInitialState:()=>({workspace,r4State}),normalizeWorkspace:(value)=>value as AgentWorkspaceData});
}
it('exports and restores native capsules through the public backup API',async()=>{
 const home=path.join(fixture.root,'TavernAgent/user-home/profiles');await fs.mkdir(home,{recursive:true});await fs.writeFile(path.join(home,'synthetic.json'),'{"synthetic":true}');
 const exported=await exportDataBackup({categories:['tavernAgent','styleLab'],destination:'internal'});expect(exported.ok,exported.message).toBe(true);
 const zip=await JSZip.loadAsync(await fs.readFile(exported.path!));expect(Object.keys(zip.files).filter(n=>n.endsWith('.zip'))).toHaveLength(1);
 const imported=await importDataBackup({path:exported.path!,categories:['tavernAgent','styleLab'],confirmConfigurationOverwrite:true});expect(imported.ok,imported.message).toBe(true);expect(imported.recoveryPaths).toHaveLength(1);expect(await fs.readFile(path.join(home,'synthetic.json'),'utf8')).toBe('{"synthetic":true}');
 const interop=process.env.STUDIO_PORTABLE_INTEROP;
 if(interop){await fs.mkdir(interop,{recursive:true});await fs.copyFile(exported.path!,path.join(interop,'desktop.naisbackup'));
   const returned=path.join(interop,'mobile.naisbackup');try{await fs.access(returned);}catch{return;}
   const roundtrip=await importDataBackup({path:returned,categories:['tavernAgent','styleLab'],confirmConfigurationOverwrite:true});expect(roundtrip.ok,roundtrip.message).toBe(true);expect(roundtrip.recoveryPaths?.length).toBeGreaterThan(0);
   const again=await exportDataBackup({categories:['tavernAgent','styleLab'],destination:'internal'});const output=await JSZip.loadAsync(await fs.readFile(again.path!));const name=Object.keys(zip.files).find(n=>n.endsWith('.zip'))!;expect(await output.file(name)!.async('nodebuffer')).toEqual(await zip.file(name)!.async('nodebuffer'));
 }
});
beforeEach(async()=>{const temp=path.resolve(process.cwd(),'.tmp');await fs.mkdir(temp,{recursive:true});fixture.root=await fs.mkdtemp(path.join(temp,'studio-portable-test-'));fixture.store={settings:{},history:[],historyGroups:[],reverseHistory:[],convertHistory:[]};resetAgentSqlStore();const lib=await import('./artist-favorites');vi.mocked(lib.loadArtistFavoriteLibrary).mockResolvedValue({collections:Object.fromEntries(ARTIST_FAVORITE_COLLECTIONS.map(k=>[k,[]]))} as any);});
afterEach(async()=>{fixture.agentSqlStore?.close();fixture.agentSqlStore=null;if(path.dirname(fixture.root)!==path.resolve(process.cwd(),'.tmp')||!path.basename(fixture.root).startsWith('studio-portable-test-'))throw Error('invalid cleanup');await fs.rm(fixture.root,{recursive:true,force:true});});

it('backs up SQL R4 state and merges it with the legacy workspace in one transaction',async()=>{
 const source=emptyWorkspace([conversation('shared-chat','Incoming title')]);source.selectedConversationId='shared-chat';
 const sourceState=createEmptyR4AgentState();sourceState.conversations['shared-chat']={conversationId:'shared-chat',messageCreationIds:{},selectionRevision:0,updatedAt:EMPTY_STAMP,assistantPresetBinding:{presetId:'studio-complete',enabled:false}};
 sourceState.creations['creation-from-backup']={id:'creation-from-backup',conversationId:'shared-chat',title:'Archived creation',inputRevision:1,selectionRevision:0,positivePrompt:'synthetic',negativePrompt:'',stylePrompt:'',publicParameters:{},references:[],artworkIds:[],currentInput:{inputRevision:1,positivePrompt:'synthetic',negativePrompt:'',stylePrompt:'',publicParameters:{},references:[]},createdAt:EMPTY_STAMP,updatedAt:EMPTY_STAMP};
 resetAgentSqlStore(source,sourceState);
 const exported=await exportDataBackup({categories:['agentWorkspace'],destination:'internal'});expect(exported.ok,exported.message).toBe(true);
 const archive=await JSZip.loadAsync(await fs.readFile(exported.path!));expect(archive.file('data/agent-r4-state.json')).toBeTruthy();
 const current=emptyWorkspace([conversation('shared-chat','Local title')]);current.selectedConversationId='shared-chat';
 resetAgentSqlStore(current,createEmptyR4AgentState());
 const imported=await importDataBackup({path:exported.path!,categories:['agentWorkspace'],confirmConfigurationOverwrite:false});expect(imported.ok,imported.message).toBe(true);
 const savedWorkspace=fixture.agentSqlStore.readWorkspace(),savedState=fixture.agentSqlStore.readR4State();
 const importedChat=savedWorkspace.conversations.find((item:any)=>item.title==='Incoming title')!;
 expect(savedWorkspace.conversations.map((item:any)=>item.title)).toEqual(expect.arrayContaining(['Local title','Incoming title']));
 expect(savedState.creations['creation-from-backup'].conversationId).toBe(importedChat.id);
 expect(savedState.conversations[importedChat.id].assistantPresetBinding).toEqual({presetId:'studio-complete',enabled:false});
});

it('migrates old workspace-only archives using each imported chat and remapped Tavern preset, not the destination default',async()=>{
 const resource=(systemPrompt:string)=>({id:'shared-resource',name:'Shared resource',systemPrompt,jailbreakPrompt:'source jailbreak',source:'fixture',sourceName:'fixture.json',createdAt:EMPTY_STAMP,updatedAt:EMPTY_STAMP});
 const local=emptyWorkspace([conversation('legacy-chat','Local copy')]);
 local.conversations[0].studioPresetId='tavern:shared-resource';local.conversations[0].studioTemplateEnabled=true;
 local.samplerPresets=[resource('local prompt') as any];
 const currentState=createEmptyR4AgentState();currentState.assistantPresetDefaultBinding={presetId:'studio-complete',enabled:true};
 resetAgentSqlStore(local,currentState);

 const incoming=emptyWorkspace([conversation('legacy-chat','Imported copy')]);
 incoming.conversations[0].studioPresetId='tavern:shared-resource';incoming.conversations[0].studioTemplateEnabled=false;
 incoming.conversations[0].samplerPresetId='shared-resource';incoming.samplerPresets=[resource('imported prompt') as any];
 const archive=new JSZip();archive.file('manifest.json',JSON.stringify({format:'langbai-novelai-studio-backup',version:1,categories:[{category:'agentWorkspace',items:1,bytes:0}]}));
 archive.file('data/agent-workspace.json',JSON.stringify(incoming));
 const file=path.join(fixture.root,'legacy-agent-only.naisbackup');await fs.writeFile(file,await archive.generateAsync({type:'nodebuffer'}));

 const result=await importDataBackup({path:file,categories:['agentWorkspace'],confirmConfigurationOverwrite:false});
 expect(result.ok,result.message).toBe(true);
 const savedWorkspace=fixture.agentSqlStore.readWorkspace(),savedState=fixture.agentSqlStore.readR4State();
 const importedChat=savedWorkspace.conversations.find((item:any)=>item.title==='Imported copy')!;
 expect(importedChat.id).not.toBe('legacy-chat');
 expect(importedChat.studioPresetId).toBe(`tavern:${importedChat.samplerPresetId}`);
 expect(importedChat.studioPresetId).not.toBe('tavern:shared-resource');
 expect(savedState.conversations[importedChat.id]).toMatchObject({
  legacyStatus:'legacy_unversioned',assistantPresetBinding:{presetId:importedChat.studioPresetId,enabled:false},
 });
 expect(savedState.assistantPresets[importedChat.studioPresetId]).toMatchObject({
  source:'legacy_tavern',body:'imported prompt\n\nsource jailbreak',
 });
 expect(savedState.conversations['legacy-chat'].assistantPresetBinding).toEqual({presetId:'tavern:shared-resource',enabled:true});
 expect(savedState.assistantPresetDefaultBinding).toEqual({presetId:'studio-complete',enabled:true});
});

it('rolls back both workspace and R4 rows when an imported R4 identity conflicts',async()=>{
 const source=emptyWorkspace([conversation('shared-chat','Incoming title')]);
 const sourceState=createEmptyR4AgentState();sourceState.conversations['shared-chat']={conversationId:'shared-chat',messageCreationIds:{},selectionRevision:0,updatedAt:EMPTY_STAMP};
 sourceState.creations['same-creation']={id:'same-creation',conversationId:'shared-chat',title:'Source',inputRevision:1,selectionRevision:0,positivePrompt:'source',negativePrompt:'',stylePrompt:'',publicParameters:{},references:[],artworkIds:[],currentInput:{inputRevision:1,positivePrompt:'source',negativePrompt:'',stylePrompt:'',publicParameters:{},references:[]},createdAt:EMPTY_STAMP,updatedAt:EMPTY_STAMP};
 resetAgentSqlStore(source,sourceState);
 const exported=await exportDataBackup({categories:['agentWorkspace'],destination:'internal'});expect(exported.ok,exported.message).toBe(true);
 const current=emptyWorkspace([conversation('shared-chat','Local title')]);
 const currentState=createEmptyR4AgentState();currentState.creations['same-creation']={...sourceState.creations['same-creation'],conversationId:'shared-chat',title:'Conflicting local copy'};
 resetAgentSqlStore(current,currentState);
 const beforeWorkspace=fixture.agentSqlStore.readWorkspace(),beforeState=fixture.agentSqlStore.readR4State();
 const imported=await importDataBackup({path:exported.path!,categories:['agentWorkspace'],confirmConfigurationOverwrite:false});
 expect(imported.ok).toBe(false);expect(fixture.agentSqlStore.readWorkspace()).toEqual(beforeWorkspace);expect(fixture.agentSqlStore.readR4State()).toEqual(beforeState);
});
it('round trips mobile-only preferences and desktop drafts through a real archive without overwriting current preferences',async()=>{
 const input=new JSZip();input.file('manifest.json',JSON.stringify({format:'langbai-novelai-studio-backup',version:1,categories:[{category:'workspaceData',items:2,bytes:0}]}));input.file('data/mobile-state.json',JSON.stringify({'mobile-only-project':'keep','existing':'incoming'}));input.file('data/workspace.json',JSON.stringify({'langbai.artist-detective.v1':'{"prompt":"test"}'}));const file=path.join(fixture.root,'incoming.naisbackup');await fs.writeFile(file,await input.generateAsync({type:'nodebuffer'}));await fs.writeFile(path.join(fixture.root,'backup-mobile-state.json'),JSON.stringify({existing:'current'}));
 const result=await importDataBackup({path:file,categories:['workspaceData'],currentWorkspaceData:{},confirmConfigurationOverwrite:false});expect(result.ok,result.message).toBe(true);expect(result.workspaceData).toEqual({'langbai.artist-detective.v1':'{"prompt":"test"}'});
 const output=await exportDataBackup({categories:['workspaceData'],destination:'internal',workspaceData:result.workspaceData});expect(output.ok,output.message).toBe(true);const zip=await JSZip.loadAsync(await fs.readFile(output.path!));expect(JSON.parse(await zip.file('data/mobile-state.json')!.async('string'))).toEqual({'mobile-only-project':'keep',existing:'current'});expect(JSON.parse(await zip.file('data/workspace.json')!.async('string'))).toEqual(result.workspaceData);expect(fixture.store.settings).toEqual({});
});
it('old archives lacking mobile-state remain importable',async()=>{const input=new JSZip();input.file('manifest.json',JSON.stringify({format:'langbai-novelai-studio-backup',version:1,categories:[]}));input.file('data/workspace.json','{}');const file=path.join(fixture.root,'old.naisbackup');await fs.writeFile(file,await input.generateAsync({type:'nodebuffer'}));const result=await importDataBackup({path:file,categories:['workspaceData'],confirmConfigurationOverwrite:false});expect(result.ok,result.message).toBe(true);await expect(fs.stat(path.join(fixture.root,'backup-mobile-state.json'))).rejects.toMatchObject({code:'ENOENT'});});

it('keeps provider keys out of configuration backups and includes nested keys only in API credentials backups',async()=>{
 fixture.store.settings={agentApiKey:'flat-synthetic-secret',agentProviders:{version:1,activeProviderId:'profile-a',providers:[
   {id:'profile-a',name:'Synthetic A',protocol:'openai-compatible',baseUrl:'https://a.example/v1',apiKey:'nested-synthetic-secret',modelId:'model-a',models:[]},
 ]}};
 const configuration=await exportDataBackup({categories:['configuration'],destination:'internal'});
 expect(configuration.ok,configuration.message).toBe(true);
 const configZip=await JSZip.loadAsync(await fs.readFile(configuration.path!));
 const config=JSON.parse(await configZip.file('data/configuration.json')!.async('string'));
 expect(config.agentProviders).toBeUndefined();
 expect(JSON.stringify(config)).not.toContain('synthetic-secret');

 const credentials=await exportDataBackup({categories:['apiCredentials'],destination:'internal'});
 expect(credentials.ok,credentials.message).toBe(true);
 const credentialZip=await JSZip.loadAsync(await fs.readFile(credentials.path!));
 const payload=JSON.parse(await credentialZip.file('data/api-credentials.json')!.async('string'));
 expect(payload.settings.agentApiKey).toBe('flat-synthetic-secret');
 expect(payload.settings.agentProviders.providers[0].apiKey).toBe('nested-synthetic-secret');
});

it('inspection lifts native data from an old manifest into independent categories with real counts',async()=>{
 const home=path.join(fixture.root,'TavernAgent/user-home/profiles');await fs.mkdir(home,{recursive:true});await fs.writeFile(path.join(home,'synthetic.json'),'{}');
 const exported=await exportDataBackup({categories:['tavernAgent'],destination:'internal'});
 expect(exported.categories).toEqual([{category:'tavernAgent',items:1,bytes:2}]);
 const zip=await JSZip.loadAsync(await fs.readFile(exported.path!));
 const manifest=JSON.parse(await zip.file('manifest.json')!.async('string'));
 manifest.categories=[{category:'agentWorkspace',items:0,bytes:0},{category:'apiCredentials',items:0,bytes:0}];
 zip.file('manifest.json',JSON.stringify(manifest));await fs.writeFile(exported.path!,await zip.generateAsync({type:'nodebuffer'}));
 const {dialog}=await import('electron');vi.mocked(dialog.showOpenDialog).mockResolvedValue({canceled:false,filePaths:[exported.path!]} as any);
 const inspected=await inspectDataBackup();expect(inspected.ok,inspected.message).toBe(true);
 expect(inspected.categories).toContainEqual({category:'tavernAgent',items:1,bytes:2});
 const restored=await importDataBackup({path:exported.path!,categories:['tavernAgent'],confirmConfigurationOverwrite:false});
 expect(restored.ok,restored.message).toBe(true);expect(restored.recoveries?.[0].status).toBe('staged');
});

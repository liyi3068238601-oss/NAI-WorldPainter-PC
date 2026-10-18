import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import fs from 'node:fs/promises';import syncFs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import JSZip from 'jszip';
import {DatabaseSync} from 'node:sqlite';
import {exportPortableProjects,inspectPortableProjects,restorePortableProjects,validateCapsule,registerPortableBusy,assertPortableIdle,withPortableLock,listPortableRecoveries,portableSummaries,activatePortableRecovery,portableRecoveryPath} from './portable-projects';
import {createAgentSqlStore} from './r4-store';
import {R4ExecutionWorker} from './r4-execution-worker';
import {createEmptyR4AgentState,type R4Execution} from '../../src/agent/r4-types';
import type {AgentWorkspaceData} from '../../src/agent/types';
import {WORKSPACE_LOCATION,WORKSPACE_MIGRATIONS,inventoryWorkspace} from './agent-workspace-migration';
const tempRoot=path.resolve(process.cwd(),'.tmp','portable-projects');
let root:string;
const all=new Set(['tavernAgent','styleLab']);
async function put(name:string,text:string){const p=path.join(root,name);await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,text);return p;}
function makeWorkspaceExecution():R4Execution{return{
 id:'queued-execution',conversationId:'conversation-1',creationId:'creation-1',operationKey:'generate_image',submissionKey:'submission-1',userIntentRef:'intent-1',inputRevision:1,inputFingerprint:'fingerprint-1',expectedOutputCount:1,requestGranularity:'per_output',providerRef:{providerId:'fixture'},
 approvedInput:{inputRevision:1,positivePrompt:'fixture',negativePrompt:'',stylePrompt:'',publicParameters:{},references:[]},
 conversationConfig:{version:1,providerRef:{providerId:'fixture'},modelId:'fixture-model',presetId:null,enabled:false,publicParameters:{},capturedAt:'2026-10-18T00:00:00.000Z',source:'preview'},
 status:'queued',pauseReason:'none',outputs:[{outputIndex:0,status:'not_dispatched'}],providerReceiptStatus:'not_applicable',providerCancellation:'not_sent',receiptRevision:0,createdAt:'2026-10-18T00:00:00.000Z',updatedAt:'2026-10-18T00:00:00.000Z',events:[],
};}
function makeAgentSqlStore(filename:string,legacyFile:string,workspace:AgentWorkspaceData,state=createEmptyR4AgentState()){
 return createAgentSqlStore({filename,legacyFiles:[legacyFile,`${legacyFile}.bak`,`${legacyFile}.bak2`],loadInitialState:()=>({workspace,r4State:state}),normalizeWorkspace:value=>{
   if(!value||typeof value!=='object'||Array.isArray(value)||Number((value as {version?:unknown}).version)!==4)throw Error('Unsupported fixture workspace');
   return value as AgentWorkspaceData;
 }});
}
beforeEach(async()=>{await fs.mkdir(tempRoot,{recursive:true});root=await fs.mkdtemp(path.join(tempRoot,'fixture-'));registerPortableBusy(()=>false);});
afterEach(async()=>{registerPortableBusy(()=>false);if(path.dirname(root)!==tempRoot||!path.basename(root).startsWith('fixture-'))throw Error('Invalid cleanup');await fs.rm(root,{recursive:true,force:true});});
it('exports native profiles only only with explicit native workspace selection',async()=>{
 await put('TavernAgent/user-home/profiles/custom.yml','SYNTHETIC configuration');
 const excluded=new JSZip();await exportPortableProjects(root,excluded,new Set(['agentWorkspace']));expect(Object.keys(excluded.files)).toHaveLength(0);
 const zip=new JSZip();await exportPortableProjects(root,zip,all);const capsules=await inspectPortableProjects(zip,all);expect(capsules).toHaveLength(1);expect(capsules[0].contents.get('profiles/custom.yml')!.toString()).toBe('SYNTHETIC configuration');
 expect(await inspectPortableProjects(zip,new Set(['agentWorkspace']))).toEqual([]);
});
it('restores fresh native profiles, preserves existing plugins and stages conflicting complete recovery copies',async()=>{
 await put('source/TavernAgent/user-home/profiles/node_modules/custom/index.js','export const synthetic = 1;');const zip=new JSZip();await exportPortableProjects(path.join(root,'source'),zip,all);const capsules=await inspectPortableProjects(zip,all);
 const fresh=path.join(root,'fresh');await restorePortableProjects(fresh,capsules);expect(await fs.readFile(path.join(fresh,'TavernAgent/user-home/profiles/node_modules/custom/index.js'),'utf8')).toContain('synthetic');
 await put('existing/TavernAgent/user-home/profiles/node_modules/custom/index.js','USER CUSTOM');const paths=await restorePortableProjects(path.join(root,'existing'),capsules);expect(await fs.readFile(path.join(root,'existing/TavernAgent/user-home/profiles/node_modules/custom/index.js'),'utf8')).toBe('USER CUSTOM');expect(await fs.readFile(path.join(paths[0].path,'profiles/node_modules/custom/index.js'),'utf8')).toContain('synthetic');
 await restorePortableProjects(path.join(root,'existing'),capsules); // idempotent
});
it('moves reference/results and rebinds image paths without inheriting pid, models or runtime',async()=>{
 const png=await put('source/runs/a/result.png','synthetic image');const ref=await put('reference.png','synthetic reference');
 await put('source/runs/a/search/round-1.json',JSON.stringify({results:[{renders:[{image:png,score:.5}]}]}));await put('source/runs/a/status.json',JSON.stringify({stage:'running',pid:888,completed:1}));await put('source/artist-detective-runtime.json',JSON.stringify({python:'old.exe',assets:'old-assets',directory:path.dirname(png),image:ref}));
 const zip=new JSZip();await exportPortableProjects(path.join(root,'source'),zip,all);const capsules=await inspectPortableProjects(zip,all);
 await put('target/artist-detective-runtime.json',JSON.stringify({python:'LOCAL.exe',assets:'LOCAL-assets'}));await restorePortableProjects(path.join(root,'target'),capsules);
 const config=JSON.parse(await fs.readFile(path.join(root,'target/artist-detective-runtime.json'),'utf8'));expect(config.python).toBe('LOCAL.exe');expect(config.pid).toBeUndefined();expect(await fs.readFile(config.image,'utf8')).toBe('synthetic reference');
 const record=JSON.parse(await fs.readFile(path.join(config.directory,'search/round-1.json'),'utf8'));expect(await fs.readFile(record.results[0].renders[0].image,'utf8')).toBe('synthetic image');expect(JSON.parse(await fs.readFile(path.join(config.directory,'status.json'),'utf8')).stage).toBe('imported');
});
it('does not traverse symlinked files or directories',async()=>{
 await put('outside/secret.txt','NOT EXPORTED');await put('TavernAgent/user-home/own.txt','own');await fs.symlink(path.join(root,'outside'),path.join(root,'TavernAgent/user-home/linked'),process.platform==='win32'?'junction':'dir');
 const zip=new JSZip();await exportPortableProjects(root,zip,all);const [capsule]=await inspectPortableProjects(zip,all);expect([...capsule.contents.keys()]).toEqual(['own.txt']);expect(capsule.manifest.omitted).toContain('linked');
});
it.each(['../escape','/absolute','C:/absolute','CON.txt','a/../b','a\\b','a.'])('rejects invalid portable path %s',async name=>{
 const zip=new JSZip();const data=Buffer.from('x');zip.file('files/'+name,data);zip.file('manifest.json',JSON.stringify({version:1,kind:'agent',files:[{name,bytes:1,hash:crypto.createHash('sha256').update(data).digest('hex')}]}));await expect(validateCapsule(await zip.generateAsync({type:'nodebuffer'}))).rejects.toThrow();
});
it('rejects tampering before creating destination files',async()=>{
 await put('TavernAgent/user-home/own.txt','own');const zip=new JSZip();await exportPortableProjects(root,zip,all);const [entry]=Object.keys(zip.files).filter(n=>n.endsWith('.zip'));zip.file(entry,Buffer.from('bad'));await expect(inspectPortableProjects(zip,all)).rejects.toThrow();
});
it('blocks concurrent startup, running workspaces, and releases locks after errors',async()=>{
 registerPortableBusy(()=>true);await expect(withPortableLock(async()=>{})).rejects.toThrow('Stop');registerPortableBusy(()=>false);
 await withPortableLock(async()=>expect(()=>assertPortableIdle()).toThrow());expect(()=>assertPortableIdle()).not.toThrow();
 await expect(withPortableLock(async()=>{throw Error('synthetic');})).rejects.toThrow('synthetic');expect(()=>assertPortableIdle()).not.toThrow();
});

it('native categories are independent from legacy categories and application credentials',async()=>{
 await put('TavernAgent/user-home/profiles/custom.json','{}');
 const zip=new JSZip();await exportPortableProjects(root,zip,new Set(['tavernAgent']));
 expect(await portableSummaries(zip)).toEqual([{category:'tavernAgent',items:1,bytes:2}]);
 expect(await inspectPortableProjects(zip,new Set(['agentWorkspace','apiCredentials','workspaceData']))).toEqual([]);
 expect(await inspectPortableProjects(zip,new Set(['tavernAgent']))).toHaveLength(1);
});
it('explicit activation preserves current native workspace without changing component or starting a process',async()=>{
 await put('source/TavernAgent/user-home/profiles/custom.json','INCOMING');
 const zip=new JSZip();await exportPortableProjects(path.join(root,'source'),zip,all);
 const capsules=await inspectPortableProjects(zip,all);
 await put('target/TavernAgent/user-home/profiles/custom.json','CURRENT');
 await put('target/TavernAgent/active.json','{"slot":"unchanged"}');
 const [recovery]=await restorePortableProjects(path.join(root,'target'),capsules);expect(recovery.status).toBe('staged');
 const result=await activatePortableRecovery(path.join(root,'target'),'agent',recovery.id);
 expect(await fs.readFile(path.join(root,'target/TavernAgent/user-home/profiles/custom.json'),'utf8')).toBe('INCOMING');
 expect(await fs.readFile(path.join(result.preserved,'user-home/profiles/custom.json'),'utf8')).toBe('CURRENT');
 expect(await fs.readFile(path.join(root,'target/TavernAgent/active.json'),'utf8')).toBe('{"slot":"unchanged"}');
});
it('exports and activates the durable Agent workspace, rebases local assets, and pauses queued work without replay',async()=>{
 const source=path.join(root,'source'),sourceId='11111111-1111-4111-8111-111111111111';
 const active=path.join(source,WORKSPACE_MIGRATIONS,sourceId,'active'),original=path.join(source,WORKSPACE_MIGRATIONS,sourceId,'original');
 const attachment=path.join(active,'attachments','conversation-1','reference.png');
 await fs.mkdir(path.dirname(attachment),{recursive:true});await fs.writeFile(attachment,Buffer.from('synthetic-reference-bytes'));
 await fs.mkdir(path.join(active,'empty-active-folder'),{recursive:true});
 const oldJson=path.join(active,'agent-workspace.json');await fs.writeFile(oldJson,JSON.stringify({version:4,conversations:[]}));
 const sourceLegacy=path.join(original,'agent-workspace.json');await fs.mkdir(path.dirname(sourceLegacy),{recursive:true});await fs.writeFile(sourceLegacy,JSON.stringify({version:4,source:'preserved baseline'}));
 await fs.mkdir(path.join(original,'empty-original-folder'),{recursive:true});
 await fs.mkdir(path.join(original,'attachments','conversation-1'),{recursive:true});await fs.writeFile(path.join(original,'attachments','conversation-1','old.png'),'synthetic-original');
 const workspace={version:4,selectedConversationId:'conversation-1',conversations:[{id:'conversation-1',title:'Fixture',messages:[],draftAttachments:[{id:'reference-1',name:'reference.png',mime:'image/png',size:24,kind:'image',filePath:attachment,fileUrl:'old-local-url',createdAt:'2026-10-18T00:00:00.000Z'}]}],skills:[],memories:[],characters:[],personas:[],lorebooks:[],samplerPresets:[],defaultGenerationMode:'confirm',updatedAt:'2026-10-18T00:00:00.000Z'} as unknown as AgentWorkspaceData;
 const state=createEmptyR4AgentState();state.executions['queued-execution']=makeWorkspaceExecution();
 const legacyBytes=await fs.readFile(oldJson);const sourceStore=makeAgentSqlStore(path.join(active,'agent-state.sqlite'),oldJson,workspace,state);sourceStore.close();
 await fs.writeFile(path.join(active,'agent-binding.key'),Buffer.alloc(32,0x5a),{mode:0o600});
 const sourceDatabaseBytes=await fs.readFile(path.join(active,'agent-state.sqlite'));
 const sourceInventory=inventoryWorkspace(original);
 await put('source/workspace-migrations/11111111-1111-4111-8111-111111111111/receipt.json',JSON.stringify({version:1,id:sourceId,sourcePath:source,createdAt:'2026-10-18T00:00:00.000Z',...sourceInventory}));
 const pointer={version:1,activeId:sourceId,applied:[sourceId],sourcePath:active};
 await put(`source/${WORKSPACE_LOCATION}`,JSON.stringify(pointer));

 const zip=new JSZip();await exportPortableProjects(source,zip,new Set(['tavernAgent']));const [capsule]=await inspectPortableProjects(zip,new Set(['tavernAgent']));
 expect(capsule.contents.has(`agent-workspace/${WORKSPACE_LOCATION}`)).toBe(true);
 expect(capsule.contents.has(`agent-workspace/${WORKSPACE_MIGRATIONS}/${sourceId}/active/agent-state.sqlite`)).toBe(true);
 expect(capsule.contents.get(`agent-workspace/${WORKSPACE_MIGRATIONS}/${sourceId}/active/agent-binding.key`)).toEqual(Buffer.alloc(32,0x5a));
 expect(capsule.contents.get(`agent-workspace/${WORKSPACE_MIGRATIONS}/${sourceId}/active/attachments/conversation-1/reference.png`)?.toString()).toBe('synthetic-reference-bytes');
 expect(capsule.contents.get(`agent-workspace/${WORKSPACE_MIGRATIONS}/${sourceId}/active/agent-workspace.json`)).toEqual(legacyBytes);
 const capsulePointer=JSON.parse(capsule.contents.get(`agent-workspace/${WORKSPACE_LOCATION}`)!.toString('utf8'));
 expect(capsulePointer.sourcePath).toBe('portable://worldpainter-agent-active');expect(JSON.stringify(capsulePointer)).not.toContain(source);
 const packagedDatabase=path.join(root,'packaged-agent-state.sqlite');await fs.writeFile(packagedDatabase,capsule.contents.get(`agent-workspace/${WORKSPACE_MIGRATIONS}/${sourceId}/active/agent-state.sqlite`)!);
 const packagedDb=new DatabaseSync(packagedDatabase,{readOnly:true});
 try{
  const row=packagedDb.prepare('SELECT workspace_json FROM agent_state WHERE id=1').get() as {workspace_json:string};
  const packagedWorkspace=JSON.parse(row.workspace_json);expect(packagedWorkspace.conversations[0].draftAttachments[0].filePath).toBe('portable://worldpainter-agent-active/attachments/conversation-1/reference.png');
  expect(packagedWorkspace.conversations[0].draftAttachments[0].fileUrl).toBe('portable-agent:attachments%2Fconversation-1%2Freference.png');
  expect(row.workspace_json).not.toContain(source);
 }finally{packagedDb.close();}

 const target=path.join(root,'target'),currentId='22222222-2222-4222-8222-222222222222';
 const currentActive=path.join(target,WORKSPACE_MIGRATIONS,currentId,'active');await fs.mkdir(currentActive,{recursive:true});await fs.writeFile(path.join(currentActive,'keep.txt'),'CURRENT ACTIVE BYTES');
 const currentPointerBytes=Buffer.from(JSON.stringify({version:1,activeId:currentId,applied:[currentId],sourcePath:path.join(target,'old-source')}));
 await fs.writeFile(path.join(target,WORKSPACE_LOCATION),currentPointerBytes);
 await put('target/TavernAgent/user-home/profiles/current.yml','CURRENT HOME');
 const [recovery]=await restorePortableProjects(target,[capsule]);
 expect(recovery.status).toBe('staged');
 const result=await activatePortableRecovery(target,'agent',recovery.id);
 const nextPointer=JSON.parse(await fs.readFile(path.join(target,WORKSPACE_LOCATION),'utf8')) as {activeId:string};
 expect(nextPointer.activeId).not.toBe(currentId);expect(nextPointer.activeId).not.toBe(sourceId);
 expect(await fs.readFile(path.join(currentActive,'keep.txt'),'utf8')).toBe('CURRENT ACTIVE BYTES');
 expect(await fs.readFile(path.join(active,'agent-state.sqlite'))).toEqual(sourceDatabaseBytes);
 expect(await fs.readFile(path.join(active,'agent-binding.key'))).toEqual(Buffer.alloc(32,0x5a));
 expect(await fs.readFile(oldJson)).toEqual(legacyBytes);
 expect(await fs.readFile(path.join(target,'TavernAgent/user-home/profiles/current.yml'),'utf8')).toBe('CURRENT HOME');
 expect(await fs.readFile(path.join(result.preservedWorkspaceLocation,'workspace-location.json'))).toEqual(currentPointerBytes);
 const restoredActive=path.join(target,WORKSPACE_MIGRATIONS,nextPointer.activeId,'active');
 expect((await fs.stat(path.join(restoredActive,'empty-active-folder'))).isDirectory()).toBe(true);
 expect((await fs.stat(path.join(target,WORKSPACE_MIGRATIONS,nextPointer.activeId,'original','empty-original-folder'))).isDirectory()).toBe(true);
 expect(await fs.readFile(path.join(restoredActive,'attachments/conversation-1/reference.png'),'utf8')).toBe('synthetic-reference-bytes');
 const restoredStore=makeAgentSqlStore(path.join(restoredActive,'agent-state.sqlite'),path.join(restoredActive,'agent-workspace.json'),workspace);
 const restoredAttachment=restoredStore.readWorkspace().conversations[0].draftAttachments[0];
 expect(restoredAttachment.filePath).toBe(path.join(restoredActive,'attachments','conversation-1','reference.png'));
 expect(restoredAttachment.fileUrl).toContain('nai-local://file/');
 const submits=vi.fn(async()=>{throw new Error('recovered queued work must not auto-submit');});
 const worker=new R4ExecutionWorker(restoredStore,{submit:submits});expect(worker.recover()).toEqual(['queued-execution']);await worker.kick();
 expect(submits).not.toHaveBeenCalled();expect(restoredStore.readR4State().executions['queued-execution'].pauseReason).toBe('user_pause');
 restoredStore.close();
});
it('activation refuses busy workspaces, forged identifiers and tampered capsules before touching current data',async()=>{
 await put('source/TavernAgent/user-home/profiles/custom.json','INCOMING');
 const zip=new JSZip();await exportPortableProjects(path.join(root,'source'),zip,all);
 const capsules=await inspectPortableProjects(zip,all),target=path.join(root,'target');
 await put('target/TavernAgent/user-home/keep.txt','CURRENT');
 const [r]=await restorePortableProjects(target,capsules);
 registerPortableBusy(()=>true);
 await expect(activatePortableRecovery(target,'agent',r.id)).rejects.toThrow('Stop');
 registerPortableBusy(()=>false);
 await expect(portableRecoveryPath(target,'agent','../escape')).rejects.toThrow('identity');
 await fs.writeFile(path.join(target,'portable-project-capsules',capsules[0].name),'tampered');
 await expect(activatePortableRecovery(target,'agent',r.id)).rejects.toThrow();
 expect(await fs.readFile(path.join(target,'TavernAgent/user-home/keep.txt'),'utf8')).toBe('CURRENT');
});
it('style activation retains previous binding and rejects edited recovery images',async()=>{
 const image=await put('source/run/output.png','PNG FIXTURE');
 await put('source/run/status.json','{"stage":"complete","completed":1}');
 await put('source/artist-detective-runtime.json',JSON.stringify({directory:path.dirname(image),image}));
 const zip=new JSZip();await exportPortableProjects(path.join(root,'source'),zip,new Set(['styleLab']));
 const capsules=await inspectPortableProjects(zip,all),target=path.join(root,'target');
 const current=await put('target/current/original.png','CURRENT');
 await put('target/artist-detective-runtime.json',JSON.stringify({directory:path.dirname(current),python:'LOCAL',assets:'LOCAL'}));
 const [r]=await restorePortableProjects(target,capsules);expect(r.status).toBe('staged');
 const result=await activatePortableRecovery(target,'detective',r.id);
 const after=JSON.parse(await fs.readFile(path.join(target,'artist-detective-runtime.json'),'utf8'));
 expect(after.python).toBe('LOCAL');expect(after.directory).toBe(path.join(r.path,'run'));
 expect(JSON.parse(await fs.readFile(path.join(result.preserved,'artist-detective-runtime.json'),'utf8')).directory).toBe(path.dirname(current));
 await fs.writeFile(path.join(r.path,'run/output.png'),'EDITED');
 await expect(activatePortableRecovery(target,'detective',r.id)).rejects.toThrow('changed');
});

it('ordinary data-only exports are not blocked by a running native Agent',async()=>{
 registerPortableBusy(()=>true);
 await expect(exportPortableProjects(root,new JSZip(),new Set(['imageHistory']))).resolves.toBeUndefined();
});

it('recovery copies remain discoverable after reopening settings without claiming to still be active',async()=>{
 await put('source/TavernAgent/user-home/profiles/custom.json','{}');
 const zip=new JSZip();await exportPortableProjects(path.join(root,'source'),zip,all);
 const target=path.join(root,'target'),capsules=await inspectPortableProjects(zip,all);
 const [r]=await restorePortableProjects(target,capsules);expect(r.status).toBe('restored');
 expect(await listPortableRecoveries(target)).toEqual([{...r,status:'available'}]);
});

import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import JSZip from 'jszip';
import { backup as backupSqlite, DatabaseSync } from 'node:sqlite';
import type {DataBackupRecovery} from '../../src/types';
import type {AgentWorkspaceData} from '../../src/agent/types';
import { WORKSPACE_LOCATION, WORKSPACE_MIGRATIONS, inventoryWorkspace } from './agent-workspace-migration';
import { WORLDPAINTER_AGENT_WORKSPACE_DIRECTORY } from '../../shared/worldpainter-product';
import { toLocalMediaUrl } from './local-media-protocol';
import { createAgentSqlStore } from './r4-store';

// Portable data is never a runtime installer. No junctions, processes or engine
// slots cross the boundary. Plugins travel only with explicit credential consent.
export const CAPSULE_ROOT = 'portable-projects/';
const MAX_FILE = 256 * 1024 * 1024;
const MAX_TOTAL = 1024 * 1024 * 1024;
const MAX_FILES = 20000;
const PORTABLE_AGENT_WORKSPACE='agent-workspace/';
const PORTABLE_SOURCE_ROOT='portable://worldpainter-agent-active';
type Kind = 'agent' | 'detective';
type Entry = {name:string; hash:string; bytes:number};
type Manifest = {version:1; kind:Kind; files:Entry[]; omitted:string[]};
type WorkspacePointer = {version:1;activeId:string;applied:string[];sourcePath:string;[key:string]:unknown};
const hash = (b:Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const busyChecks = new Map<string,()=>boolean>();
let locked = false;
export function registerPortableBusy(check:()=>boolean, name='agent') { busyChecks.set(name,check); }
export function assertPortableIdle() { if (locked) throw Error('Backup/restore in progress'); }
export async function withPortableLock<T>(operation:()=>Promise<T>):Promise<T> {
  if (locked || [...busyChecks.values()].some(check=>check())) throw Error('Stop Tavern Agent and Artist Detective before backing up or restoring their workspaces');
  locked = true;
  try { return await operation(); } finally { locked = false; }
}
const UUID=/^[a-f0-9-]{36}$/i;
const inside=(root:string,file:string)=>{const rel=path.relative(path.resolve(root),path.resolve(file));return rel!==''&&rel!=='..'&&!rel.startsWith(`..${path.sep}`)&&!path.isAbsolute(rel)?rel:undefined;};
const isAbsolutePath=(value:string)=>path.isAbsolute(value)||path.win32.isAbsolute(value)||path.posix.isAbsolute(value);
function parseWorkspacePointer(value:unknown,allowPortableSource=false):WorkspacePointer {
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid Agent workspace location pointer');
  const pointer=value as Record<string,unknown>;
  const safeSource=typeof pointer.sourcePath==='string'&&(isAbsolutePath(pointer.sourcePath)||(allowPortableSource&&pointer.sourcePath===PORTABLE_SOURCE_ROOT));
  if(pointer.version!==1||typeof pointer.activeId!=='string'||!UUID.test(pointer.activeId)||!Array.isArray(pointer.applied)||pointer.applied.some(item=>typeof item!=='string')||!safeSource)throw Error('Invalid Agent workspace location pointer');
  return pointer as WorkspacePointer;
}
function inventoriesMatch(a:ReturnType<typeof inventoryWorkspace>,b:ReturnType<typeof inventoryWorkspace>){return JSON.stringify(a)===JSON.stringify(b);}

function inspectPortableAgentWorkspace(contents:Map<string,Buffer>){
  const pointerBytes=contents.get(`${PORTABLE_AGENT_WORKSPACE}${WORKSPACE_LOCATION}`);
  if(!pointerBytes){
    if([...contents.keys()].some(name=>name.startsWith(PORTABLE_AGENT_WORKSPACE)))throw Error('Portable Agent workspace entries have no location pointer');
    return undefined;
  }
  const pointer=parseWorkspacePointer(JSON.parse(pointerBytes.toString('utf8')),true);
  const root=`${PORTABLE_AGENT_WORKSPACE}${WORKSPACE_MIGRATIONS}/${pointer.activeId}/`;
  const activePrefix=`${root}active/`,originalPrefix=`${root}original/`;
  if(!contents.has(`${activePrefix}agent-state.sqlite`))throw Error('Portable Agent workspace has no active SQLite database');
  const originalFiles=[...contents.entries()].filter(([name])=>name.startsWith(originalPrefix));
  if(!originalFiles.length)throw Error('Portable Agent workspace has no retained source snapshot');
  const receiptBytes=contents.get(`${root}receipt.json`);
  if(!receiptBytes)throw Error('Portable Agent workspace migration receipt is missing');
  const receipt=JSON.parse(receiptBytes.toString('utf8')) as {version?:unknown;id?:unknown;sourcePath?:unknown;files?:unknown;directories?:unknown;activeDirectories?:unknown};
  if(receipt.version!==1||receipt.id!==pointer.activeId||typeof receipt.sourcePath!=='string'||!(isAbsolutePath(receipt.sourcePath)||receipt.sourcePath===PORTABLE_SOURCE_ROOT)||!Array.isArray(receipt.files)||!Array.isArray(receipt.directories)||!Array.isArray(receipt.activeDirectories))throw Error('Portable Agent workspace migration receipt is invalid');
  const validateDirectories=(values:unknown[])=>{
    const result=new Set<string>();
    for(const item of values){if(typeof item!=='string')throw Error('Portable Agent workspace directory entry is invalid');const name=relative(item);if(result.has(name))throw Error('Portable Agent workspace directory entry is duplicated');result.add(name);}
    return [...result];
  };
  const sourceDirectories=validateDirectories(receipt.directories),activeDirectories=validateDirectories(receipt.activeDirectories);
  const declared=new Map<string,{size:number;sha256:string}>();
  for(const item of receipt.files){
    if(!item||typeof item!=='object')throw Error('Portable Agent workspace receipt file entry is invalid');
    const file=item as {path?:unknown;size?:unknown;sha256?:unknown};
    if(typeof file.path!=='string'||typeof file.size!=='number'||!Number.isSafeInteger(file.size)||file.size<0||typeof file.sha256!=='string'||!/^[a-f0-9]{64}$/i.test(file.sha256))throw Error('Portable Agent workspace receipt file entry is invalid');
    relative(file.path);declared.set(file.path,{size:Number(file.size),sha256:file.sha256});
  }
  if(declared.size!==originalFiles.length)throw Error('Portable Agent workspace source inventory does not match its receipt');
  for(const [name,bytes] of originalFiles){
    const rel=name.slice(originalPrefix.length),entry=declared.get(rel);
    if(!entry||entry.size!==bytes.length||entry.sha256!==hash(bytes))throw Error('Portable Agent workspace source bytes do not match their receipt');
  }
  return {pointer,root,activePrefix,originalPrefix,sourceDirectories,activeDirectories};
}

function remapPortablePath(value:unknown,sourceRoot:string,targetRoot:string){
  if(typeof value!=='string')return undefined;
  let rel:string|undefined;
  if(sourceRoot===PORTABLE_SOURCE_ROOT){
    const prefix=`${PORTABLE_SOURCE_ROOT}/`;
    if(value.startsWith(prefix))rel=value.slice(prefix.length);
  }else if(isAbsolutePath(value))rel=inside(sourceRoot,value);
  if(!rel)return undefined;
  if(targetRoot===PORTABLE_SOURCE_ROOT)return `${PORTABLE_SOURCE_ROOT}/${rel.split(path.sep).join('/')}`;
  return path.join(targetRoot,...rel.split(/[\\/]/));
}

function remappedMediaUrl(filePath:string,id?:string){
  if(filePath.startsWith(`${PORTABLE_SOURCE_ROOT}/`))return `portable-agent:${encodeURIComponent(filePath.slice(PORTABLE_SOURCE_ROOT.length+1))}`;
  return toLocalMediaUrl(filePath,id);
}

function remapStoredFiles(value:unknown,sourceRoot:string,targetRoot:string):{value:unknown;changed:boolean}{
  if(Array.isArray(value)){
    let changed=false;const items=value.map(item=>{const result=remapStoredFiles(item,sourceRoot,targetRoot);changed||=result.changed;return result.value;});
    return {value:items,changed};
  }
  if(!value||typeof value!=='object')return {value,changed:false};
  const record=value as Record<string,unknown>,next:Record<string,unknown>={};let changed=false;
  const movedFilePath=remapPortablePath(record.filePath,sourceRoot,targetRoot);
  const movedHandle=remapPortablePath(record.readableHandle,sourceRoot,targetRoot);
  for(const [key,item] of Object.entries(record)){
    if(key==='filePath'&&movedFilePath){next.filePath=movedFilePath;changed=true;continue;}
    if(key==='readableHandle'&&movedHandle){next.readableHandle=movedHandle;changed=true;continue;}
    if(key==='fileUrl'&&movedFilePath&&typeof item==='string'){next.fileUrl=remappedMediaUrl(movedFilePath,typeof record.id==='string'?record.id:undefined);continue;}
    if(key==='url'&&movedHandle&&typeof item==='string'){next.url=remappedMediaUrl(movedHandle,typeof record.id==='string'?record.id:undefined);continue;}
    const nested=remapStoredFiles(item,sourceRoot,targetRoot);next[key]=nested.value;changed||=nested.changed;
  }
  return {value:next,changed};
}

function rebaseAgentSqlSnapshot(databaseFile:string,sourceRoot:string,targetRoot:string){
  const db=new DatabaseSync(databaseFile);
  let began=false;
  try{
    db.exec('BEGIN IMMEDIATE');began=true;
    const row=db.prepare('SELECT workspace_json,r4_json,workspace_revision,r4_revision FROM agent_state WHERE id=1')
      .get() as {workspace_json:string;r4_json:string;workspace_revision:number;r4_revision:number}|undefined;
    if(!row)throw Error('Portable Agent SQLite state row is missing');
    const workspace=remapStoredFiles(JSON.parse(row.workspace_json),sourceRoot,targetRoot);
    const r4=remapStoredFiles(JSON.parse(row.r4_json),sourceRoot,targetRoot);
    if(workspace.changed||r4.changed){
      db.prepare(`UPDATE agent_state SET workspace_json=?,workspace_revision=?,r4_json=?,r4_revision=?,updated_at=? WHERE id=1`)
        .run(JSON.stringify(workspace.value),row.workspace_revision+(workspace.changed?1:0),JSON.stringify(r4.value),row.r4_revision+(r4.changed?1:0),new Date().toISOString());
    }
    db.exec('COMMIT');began=false;
  }catch(error){if(began)try{db.exec('ROLLBACK');}catch{/* preserve the original error */}throw error;}
  finally{db.close();}
}

function validatePortableAgentSql(activeDirectory:string){
  const databaseFile=path.join(activeDirectory,'agent-state.sqlite');
  const stat=syncFs.lstatSync(databaseFile);
  if(!stat.isFile()||stat.isSymbolicLink())throw Error('Portable Agent SQLite file is invalid');
  const legacy=path.join(activeDirectory,'agent-workspace.json');
  const store=createAgentSqlStore({filename:databaseFile,legacyFiles:[legacy,`${legacy}.bak`,`${legacy}.bak2`],
    loadInitialState:()=>{throw Error('Refusing to initialize a missing portable Agent database');},
    normalizeWorkspace:value=>{
      if(!value||typeof value!=='object'||Array.isArray(value)||Number((value as {version?:unknown}).version)!==4)throw Error('Portable Agent workspace version is unsupported');
      return value as AgentWorkspaceData;
    },
  });
  try{store.readWorkspace();store.readR4State();}finally{store.close();}
  const keyFile=path.join(activeDirectory,'agent-binding.key');
  if(syncFs.existsSync(keyFile)&&syncFs.statSync(keyFile).size!==32)throw Error('Portable Agent binding key is invalid; current data was not switched');
}

async function writeAtomicJson(file:string,value:unknown){
  const temp=`${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temp,JSON.stringify(value,null,2),{flag:'wx'});
  try{await fs.rename(temp,file);}catch(error){await fs.rm(temp,{force:true}).catch(()=>{});throw error;}
}

async function installPortableWorkspaceSnapshot(userData:string,contents:Map<string,Buffer>){
  const imported=inspectPortableAgentWorkspace(contents);if(!imported)return undefined;
  const migrationRoot=path.join(userData,WORKSPACE_MIGRATIONS),profileId=crypto.randomUUID();
  const profile=path.join(migrationRoot,profileId),active=path.join(profile,'active'),original=path.join(profile,'original');
  await plainDirectory(userData);await plainDirectory(migrationRoot);await fs.mkdir(migrationRoot,{recursive:true});
  const writePrefix=async(prefix:string,targetRoot:string,directories:string[]=[] )=>{
    for(const name of directories){const target=path.join(targetRoot,...name.split('/'));await plainDirectory(path.dirname(target));await fs.mkdir(target,{recursive:true});}
    for(const [name,data] of contents){
      if(!name.startsWith(prefix))continue;
      const rel=relative(name.slice(prefix.length)),target=path.join(targetRoot,...rel.split('/'));
      await plainDirectory(path.dirname(target));await fs.mkdir(path.dirname(target),{recursive:true});
      const mode=path.basename(target)==='agent-binding.key'?0o600:undefined;
      await fs.writeFile(target,data,{flag:'wx',...(mode?{mode}:{})});
    }
  };
  const locationFile=path.join(userData,WORKSPACE_LOCATION);let currentBytes:Buffer|undefined,currentPointer:WorkspacePointer|undefined;
  try{currentBytes=await fs.readFile(locationFile);currentPointer=parseWorkspacePointer(JSON.parse(currentBytes.toString('utf8')));}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  if(currentPointer){
    const currentActive=path.join(migrationRoot,currentPointer.activeId,'active');
    if(!(await exists(currentActive))?.isDirectory())throw Error('Current Agent active workspace is missing; portable activation was stopped');
  }
  const stamp=new Date().toISOString().replace(/[:.]/g,'-')+'-'+crypto.randomBytes(4).toString('hex');
  const staged=path.join(userData,'TavernAgent',`workspace-restore-staging-${stamp}`);
  await plainDirectory(path.dirname(staged));await fs.mkdir(staged,{recursive:true});
  const stagedActive=path.join(staged,'active'),stagedOriginal=path.join(staged,'original');
  let pointerCommitted=false,profileCreated=false;
  try{
    await fs.mkdir(stagedActive,{recursive:true});await fs.mkdir(stagedOriginal,{recursive:true});
    await writePrefix(imported.activePrefix,stagedActive,imported.activeDirectories);await writePrefix(imported.originalPrefix,stagedOriginal,imported.sourceDirectories);
    validatePortableAgentSql(stagedActive);
    const stagedInventory=inventoryWorkspace(stagedOriginal);
    const sourceRoot=imported.pointer.sourcePath;
    // Build the final profile before changing the pointer. It has no receipt yet,
    // so a crash in this window cannot make startup auto-select it as a migration.
    await fs.mkdir(profile,{recursive:false});profileCreated=true;
    await fs.rename(stagedActive,active);await fs.rename(stagedOriginal,original);
    rebaseAgentSqlSnapshot(path.join(active,'agent-state.sqlite'),sourceRoot,active);
    validatePortableAgentSql(active);
    const activeInventory=inventoryWorkspace(active);
    if(!activeInventory.files.some(item=>item.path==='agent-state.sqlite'))throw Error('Portable Agent SQLite file disappeared during activation');
    const receipt={version:1,id:profileId,sourcePath:active,createdAt:new Date().toISOString(),...stagedInventory};
    await fs.writeFile(path.join(profile,'receipt.pending'),JSON.stringify(receipt,null,2),{flag:'wx'});
    const receiptFile=path.join(profile,'receipt.json');
    const localApplied=new Set([...(currentPointer?.applied??[]),profileId]);
    if(syncFs.existsSync(migrationRoot))for(const id of syncFs.readdirSync(migrationRoot)){
      if(UUID.test(id)&&syncFs.existsSync(path.join(migrationRoot,id,'receipt.json')))localApplied.add(id);
    }
    const nextPointer:WorkspacePointer={...(currentPointer??{}),...imported.pointer,version:1,activeId:profileId,applied:[...localApplied],sourcePath:active};
    const preserveRoot=path.join(userData,'TavernAgent','restore-preserved',stamp);
    await plainDirectory(preserveRoot);await fs.mkdir(preserveRoot,{recursive:true});
    if(currentBytes)await fs.writeFile(path.join(preserveRoot,WORKSPACE_LOCATION),currentBytes,{flag:'wx'});
    // The current active profile and its source bytes remain at their old ID;
    // only this one pointer changes which complete profile is live.
    const {closeAgentSqlStore}=await import('./agent-store.js');
    const {resetAgentWorkspaceLocation}=await import('./agent-workspace-location.js');
    closeAgentSqlStore();resetAgentWorkspaceLocation();
    await writeAtomicJson(locationFile,nextPointer);
    pointerCommitted=true;
    // The pointer is the activation commit. A pending receipt is not used for
    // startup selection, so a receipt rename failure must not roll back a now
    // active profile or misreport that the current workspace stayed unchanged.
    await fs.rename(path.join(profile,'receipt.pending'),receiptFile).catch(()=>{});
    return {profileId,activePath:active,preservedPointer:preserveRoot};
  }catch(error){
    await fs.rm(staged,{recursive:true,force:true}).catch(()=>{});
    if(!pointerCommitted&&profileCreated)await fs.rm(profile,{recursive:true,force:true}).catch(()=>{});
    throw error;
  }
}

async function copyWorkspaceDirectory(source:string,destination:string){
  const before=inventoryWorkspace(source);
  await fs.cp(source,destination,{recursive:true,errorOnExist:true,force:false});
  const copied=inventoryWorkspace(destination),after=inventoryWorkspace(source);
  if(!inventoriesMatch(before,copied)||!inventoriesMatch(before,after))throw Error('Agent workspace changed during portable snapshot');
}

/** Build a stable capsule copy of the selected SQL workspace without touching its source bytes. */
async function stagePortableAgentWorkspace(userData:string){
  const locationFile=path.join(userData,WORKSPACE_LOCATION);
  let sourceId:string,activeSource:string,originalSource:string,sourcePointer:WorkspacePointer|undefined;
  try{
    const raw=JSON.parse(await fs.readFile(locationFile,'utf8'));
    sourcePointer=parseWorkspacePointer(raw);
    sourceId=sourcePointer.activeId;
    activeSource=path.join(userData,WORKSPACE_MIGRATIONS,sourceId,'active');
    originalSource=path.join(userData,WORKSPACE_MIGRATIONS,sourceId,'original');
    if(!(await exists(activeSource))?.isDirectory()||!(await exists(originalSource))?.isDirectory())throw Error('Active Agent workspace migration profile is incomplete');
  }catch(error){
    if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
    const direct=path.join(userData,WORLDPAINTER_AGENT_WORKSPACE_DIRECTORY),st=await exists(direct);
    if(!st)return {sources:[] as {root:string;prefix:string;filter?:(name:string)=>boolean}[],extra:new Map<string,Buffer>(),cleanup:async()=>{}};
    if(st.isSymbolicLink()||!st.isDirectory())throw Error('Invalid Agent workspace directory');
    const inventory=inventoryWorkspace(direct);
    if(!inventory.files.length&&!inventory.directories.length)return {sources:[] as {root:string;prefix:string;filter?:(name:string)=>boolean}[],extra:new Map<string,Buffer>(),cleanup:async()=>{}};
    sourceId=crypto.randomUUID();activeSource=direct;originalSource=direct;
  }
  validatePortableAgentSql(activeSource);
  const activeInventory=inventoryWorkspace(activeSource);
  if(!activeInventory.files.some(item=>item.path==='agent-state.sqlite'))throw Error('Agent workspace capsule is missing agent-state.sqlite');
  const stagingRoot=path.join(userData,`.portable-agent-snapshot-${crypto.randomUUID()}`);
  await fs.mkdir(stagingRoot,{recursive:true});
  try{
    const stagedProfile=path.join(stagingRoot,'workspace-migrations',sourceId);
    const stagedActive=path.join(stagedProfile,'active'),stagedOriginal=path.join(stagedProfile,'original');
    await fs.mkdir(path.dirname(stagedActive),{recursive:true});
    await copyWorkspaceDirectory(activeSource,stagedActive);
    if(path.resolve(originalSource)===path.resolve(activeSource))await copyWorkspaceDirectory(activeSource,stagedOriginal);
    else await copyWorkspaceDirectory(originalSource,stagedOriginal);
    const sourceDatabase=path.join(activeSource,'agent-state.sqlite'),snapshotDatabase=path.join(stagedActive,'agent-state.sqlite');
    const database=new DatabaseSync(sourceDatabase,{readOnly:true,timeout:5_000});
    try{await backupSqlite(database,snapshotDatabase);}finally{database.close();}
    if(!inventoriesMatch(activeInventory,inventoryWorkspace(activeSource)))throw Error('Agent workspace changed during portable SQLite snapshot');
    // Replace machine-specific absolute paths only in the capsule copy. The
    // source database and its file URLs remain byte-for-byte untouched.
    rebaseAgentSqlSnapshot(snapshotDatabase,activeSource,PORTABLE_SOURCE_ROOT);
    validatePortableAgentSql(stagedActive);
    const snapshot=new DatabaseSync(snapshotDatabase,{readOnly:true});
    try{if((snapshot.prepare('PRAGMA quick_check').get() as {quick_check?:string}|undefined)?.quick_check!=='ok')throw Error('Agent SQLite portable snapshot failed integrity check');}
    finally{snapshot.close();}
    const finalActive=inventoryWorkspace(stagedActive),finalOriginal=inventoryWorkspace(stagedOriginal);
    const receipt={version:1,id:sourceId,sourcePath:PORTABLE_SOURCE_ROOT,createdAt:new Date().toISOString(),...finalOriginal,activeDirectories:finalActive.directories};
    const pointer:WorkspacePointer={...(sourcePointer??{}),version:1,activeId:sourceId,applied:[sourceId],sourcePath:PORTABLE_SOURCE_ROOT};
    const extra=new Map<string,Buffer>([
      [`${PORTABLE_AGENT_WORKSPACE}${WORKSPACE_LOCATION}`,Buffer.from(JSON.stringify(pointer))],
      [`${PORTABLE_AGENT_WORKSPACE}${WORKSPACE_MIGRATIONS}/${sourceId}/receipt.json`,Buffer.from(JSON.stringify(receipt))],
    ]);
    const sources=[
      {root:stagedActive,prefix:`${PORTABLE_AGENT_WORKSPACE}${WORKSPACE_MIGRATIONS}/${sourceId}/active/`},
      {root:stagedOriginal,prefix:`${PORTABLE_AGENT_WORKSPACE}${WORKSPACE_MIGRATIONS}/${sourceId}/original/`},
    ];
    // Keep a stable copy of the source generation as well as the selected active
    // SQL snapshot; activation later creates a new local profile from these bytes.
    return {sources,extra,cleanup:async()=>{await fs.rm(stagingRoot,{recursive:true,force:true});},activeInventory,finalActive,finalOriginal};
  }catch(error){await fs.rm(stagingRoot,{recursive:true,force:true});throw error;}
}
function relative(name:string) {
  if (!name || name.length>512 || name.includes('\\') || name.includes(':') || name.startsWith('/') || name.split('/').some(p=>!p || p==='.' || p==='..' || /[. ]$/.test(p) || /[\x00-\x1f<>"|?*]/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw Error('Invalid portable path');
  return name;
}
async function exists(p:string) { try { return await fs.lstat(p); } catch(e) { if ((e as NodeJS.ErrnoException).code==='ENOENT') return null; throw e; } }
async function plainDirectory(p:string) {
  for(let current=path.resolve(p);;current=path.dirname(current)) {
    const st=await exists(current);
    // macOS system paths are aliases (/var -> /private/var, etc.). Only these
    // OS-owned exact aliases are accepted, never links inside a user workspace.
    const systemAlias=process.platform==='darwin' && ['/var','/tmp','/etc'].includes(current)
      && st?.isSymbolicLink() && await fs.realpath(current)===`/private${current}`;
    if(st && !systemAlias && (st.isSymbolicLink() || !st.isDirectory())) throw Error('Portable destination must not contain links');
    if(path.dirname(current)===current) break;
  }
}
async function pack(kind:Kind, sources:{root:string;prefix:string;filter?:(name:string)=>boolean}[], extra:Map<string,Buffer>) {
  const zip=new JSZip(), files:Entry[]=[], omitted:string[]=[], seen=new Set<string>(); let total=0;
  const add=(name:string,bytes:Buffer)=>{
    relative(name); const key=name.toLowerCase(); if(seen.has(key)) throw Error('Duplicate portable path'); seen.add(key);
    total+=bytes.length; if(bytes.length>MAX_FILE || total>MAX_TOTAL || files.length>=MAX_FILES) throw Error('Portable workspace exceeds size limit');
    files.push({name,hash:hash(bytes),bytes:bytes.length}); zip.file(`files/${name}`,bytes,{compression:'STORE',date:new Date('2000-01-01T00:00:00Z'),createFolders:false});
  };
  for(const source of sources) {
    const walk=async(file:string,name:string):Promise<void>=>{
      const st=await exists(file); if(!st)return;
      if(st.isSymbolicLink()) { omitted.push(name); return; }
      if(st.isDirectory()) { for(const n of (await fs.readdir(file)).sort()) await walk(path.join(file,n),name?`${name}/${n}`:n); }
      else if(st.isFile() && (!source.filter || source.filter(name))) {
        if(st.size>MAX_FILE)throw Error('Portable file exceeds size limit');
        const data=await fs.readFile(file), after=await fs.stat(file);
        if(st.size!==after.size || st.mtimeMs!==after.mtimeMs)throw Error('Workspace changed during backup');
        add(source.prefix+name,data);
      }
    };
    await plainDirectory(path.dirname(source.root)); await walk(source.root,'');
  }
  for(const [name,data] of extra) add(name,data);
  if(!files.length)return null;
  const manifest:Manifest={version:1,kind,files,omitted}; zip.file('manifest.json',JSON.stringify(manifest),{date:new Date('2000-01-01T00:00:00Z')});
  return zip.generateAsync({type:'nodebuffer',compression:'STORE'});
}
export async function validateCapsule(bytes:Buffer, expected?:Kind) {
  if(bytes.length>MAX_TOTAL+10*1024*1024)throw Error('Portable archive too large');
  const zip=await JSZip.loadAsync(bytes); const mf=zip.file('manifest.json');
  if(!mf || (mf as any)._data?.uncompressedSize>8*1024*1024)throw Error('Invalid portable manifest');
  const manifest=JSON.parse(await mf.async('string')) as Manifest;
  if(manifest.version!==1 || !['agent','detective'].includes(manifest.kind) || expected && manifest.kind!==expected || !Array.isArray(manifest.files) || manifest.files.length>MAX_FILES)throw Error('Unsupported portable capsule');
  const contents=new Map<string,Buffer>(),seen=new Set<string>(); let total=0;
  for(const entry of manifest.files) {
    relative(entry.name); if(seen.has(entry.name.toLowerCase()))throw Error('Duplicate portable path'); seen.add(entry.name.toLowerCase());
    if(!Number.isSafeInteger(entry.bytes) || entry.bytes<0 || entry.bytes>MAX_FILE || (total+=entry.bytes)>MAX_TOTAL)throw Error('Invalid portable size');
    const file=zip.file(`files/${entry.name}`);
    if(!file || (file as any)._data?.uncompressedSize!==entry.bytes)throw Error('Portable size mismatch');
    const data=await file.async('nodebuffer'); if(data.length!==entry.bytes || hash(data)!==entry.hash)throw Error('Portable integrity mismatch');
    if(manifest.kind==='detective' && !/^(?:reference\.(?:png|jpg|jpeg|webp)|run\/(?:.*\.(?:png|jpg|jpeg|webp)|status\.json|fixed-prompt\.json|search\/(?:round-\d+|finalists)\.json))$/i.test(entry.name))throw Error('Unexpected detective file');
    contents.set(entry.name,data);
  }
  // A file may not be the parent of another file, even across case variants.
  for(const name of seen) for(let i=name.indexOf('/');i>=0;i=name.indexOf('/',i+1))if(seen.has(name.slice(0,i)))throw Error('Portable path conflict');
  if(manifest.kind==='agent')inspectPortableAgentWorkspace(contents);
  return {manifest,contents,id:hash(bytes)};
}
export async function exportPortableProjects(userData:string, zip:JSZip, selection:Set<string>) {
  if(!selection.has('tavernAgent')&&!selection.has('styleLab'))return;
  return withPortableLock(()=>exportProjects(userData,zip,selection));
}
async function exportProjects(userData:string, zip:JSZip, selection:Set<string>) {
  const add=async(kind:Kind,bytes:Buffer|null)=>{if(bytes)zip.file(`${CAPSULE_ROOT}${kind}-${hash(bytes)}.zip`,bytes,{compression:'STORE'});};
  if(selection.has('tavernAgent')) {
    const workspace=await stagePortableAgentWorkspace(userData);
    try{
      await add('agent',await pack('agent',[
        {root:path.join(userData,'TavernAgent/user-home'),prefix:'',filter:n=>!/(?:^|\/)(?:\.cache|logs|tmp)(?:\/|$)|(?:^|\/)(?:.*\.lock|.*\.pid)$/i.test(n)},
        ...workspace.sources,
      ],workspace.extra));
    }finally{await workspace.cleanup();}
  }
  if(selection.has('styleLab')) {
    let config:any={};try{config=JSON.parse(await fs.readFile(path.join(userData,'artist-detective-runtime.json'),'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
    if(config.pid) { try{process.kill(config.pid,0);throw Error('Stop Artist Detective before backing up results');}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e;} }
    const extra=new Map<string,Buffer>();
    if(config.image && /\.(png|jpe?g|webp)$/i.test(config.image)) {const st=await exists(config.image);if(st?.isFile()&&!st.isSymbolicLink()&&st.size<=MAX_FILE)extra.set(`reference${path.extname(config.image).toLowerCase()}`,await fs.readFile(config.image));}
    const sources=config.directory?[{root:config.directory,prefix:'run/',filter:(n:string)=>/\.(png|jpe?g|webp)$/i.test(n)||/^(status\.json|fixed-prompt\.json|search\/(round-\d+|finalists)\.json)$/.test(n)}]:[];
    const bytes=await pack('detective',sources,extra);
    if(bytes) {
      const validated=await validateCapsule(bytes,'detective'); const normalized=new Map<string,Buffer>();
      for(const [name,data] of validated.contents) {
        if(name.endsWith('.json')) {
          const remap=(value:any):any=>{
            if(Array.isArray(value))return value.map(remap);
            if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!['pid','token','apiKey','api_key','authorization'].includes(k)).map(([k,v])=>[k,remap(v)]));
            if(typeof value==='string' && config.directory) { const rel=path.relative(config.directory,value).replaceAll('\\','/'); if(validated.contents.has('run/'+rel))return 'portable:'+rel; }
            return value;
          };
          const dataJson=remap(JSON.parse(data.toString('utf8')));if(name==='run/status.json')dataJson.stage='imported';normalized.set(name,Buffer.from(JSON.stringify(dataJson)));
        }else normalized.set(name,data);
      }
      await add('detective',await pack('detective',[],normalized));
    }
  }
  // Capsules brought through a mobile device or conflicting local restore are
  // retained byte-for-byte. Selection gates also apply on every re-export.
  const bridge=path.join(userData,'portable-project-capsules');
  await plainDirectory(bridge);
  for(const name of await fs.readdir(bridge).catch((e)=>{if(e.code==='ENOENT')return [];throw e;})) {
    if(!/^(agent|detective)-[a-f0-9]{64}\.zip$/.test(name))continue;
    const kind=name.startsWith('agent-')?'agent':'detective';
    if(kind==='agent' ? !selection.has('tavernAgent') : !selection.has('styleLab'))continue;
    const st=await fs.lstat(path.join(bridge,name));if(!st.isFile()||st.isSymbolicLink()||st.size>MAX_TOTAL+10*1024*1024)throw Error('Invalid capsule file');
    const bytes=await fs.readFile(path.join(bridge,name)); const valid=await validateCapsule(bytes,kind);
    if(name!==`${kind}-${valid.id}.zip`)throw Error('Capsule filename integrity mismatch');
    zip.file(CAPSULE_ROOT+name,bytes,{compression:'STORE'});
  }
}
export async function inspectPortableProjects(zip:JSZip, selection:Set<string>) {
  const capsules=[];
  for(const [name,file] of Object.entries(zip.files)) {
    if(file.dir || !name.startsWith(CAPSULE_ROOT))continue;
    const match=/^portable-projects\/(agent|detective)-([a-f0-9]{64})\.zip$/.exec(name); if(!match)throw Error('Invalid portable entry');
    const kind=match[1] as Kind;
    if(kind==='agent' ? !selection.has('tavernAgent') : !selection.has('styleLab'))continue;
    if((file as any)._data?.uncompressedSize>MAX_TOTAL+10*1024*1024)throw Error('Capsule too large');
    const bytes=await file.async('nodebuffer'), valid=await validateCapsule(bytes,kind);
    if(valid.id!==match[2])throw Error('Capsule integrity mismatch');
    capsules.push({...valid,bytes,name:path.posix.basename(name)});
  }
  return capsules;
}
export async function restorePortableProjects(userData:string,capsules:Awaited<ReturnType<typeof inspectPortableProjects>>) {
  const recoveryPaths:DataBackupRecovery[]=[];
  if(!capsules.length)return recoveryPaths;
  return withPortableLock(async()=>{
    for(const capsule of capsules) {
      const kind=capsule.manifest.kind;
      const root=path.join(userData,kind==='agent'?'TavernAgent/imports':'artist-detective-imports',capsule.id);
      await plainDirectory(root);await fs.mkdir(root,{recursive:true});
      // Always stage a complete, immutable recovery copy. Existing active data
      // wins; an imported plugin is never loaded during backup restoration.
      for(const [name,original] of capsule.contents) {
        let data=original;
        if(kind==='detective' && name.endsWith('.json')) {
          const rebase=(v:any):any=>Array.isArray(v)?v.map(rebase):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,w])=>[k,rebase(w)])):typeof v==='string'&&v.startsWith('portable:')?path.join(root,'run',relative(v.slice(9))):v;
          data=Buffer.from(JSON.stringify(rebase(JSON.parse(data.toString('utf8')))));
        }
        const target=path.join(root,name);await plainDirectory(path.dirname(target));await fs.mkdir(path.dirname(target),{recursive:true});
        const old=await exists(target);if(old){if(!old.isFile()||old.isSymbolicLink()||!(await fs.readFile(target)).equals(data))throw Error('Recovery copy has been modified');}
        else await fs.writeFile(target,data,{flag:'wx',...(path.basename(target)==='agent-binding.key'?{mode:0o600}:{})});
      }
      if(kind==='agent') {
        const home=path.join(userData,'TavernAgent/user-home');await plainDirectory(home);
        // Fresh installs restore immediately; existing installations retain
        // their complete active profile and get a separate recovery folder.
        // R4's active SQL workspace is always explicit-activation data.
        const fresh=!(await exists(home));
        const homeEntries=[...capsule.contents.entries()].filter(([name])=>!name.startsWith(PORTABLE_AGENT_WORKSPACE));
        if(fresh&&homeEntries.length){
          for(const [name,data] of homeEntries){const target=path.join(home,...relative(name).split('/'));await plainDirectory(path.dirname(target));await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,data,{flag:'wx',...(path.basename(target)==='agent-binding.key'?{mode:0o600}:{})});}
        }
        const containsWorkspace=capsule.contents.has(`${PORTABLE_AGENT_WORKSPACE}${WORKSPACE_LOCATION}`);
        recoveryPaths.push({kind,id:capsule.id,path:root,status:fresh&&!containsWorkspace?'restored':'staged'});
      }else{
        const file=path.join(userData,'artist-detective-runtime.json');let c:any={};try{c=JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
        const fresh=!c.directory || !(await exists(c.directory));
        if(fresh) {
          c.directory=path.join(root,'run');c.image=[...capsule.contents.keys()].find(n=>n.startsWith('reference.'));if(c.image)c.image=path.join(root,c.image);delete c.pid;
          await fs.writeFile(file,JSON.stringify(c));
        }
        recoveryPaths.push({kind,id:capsule.id,path:root,status:fresh?'restored':'staged'});
      }
      const bridge=path.join(userData,'portable-project-capsules');await plainDirectory(bridge);await fs.mkdir(bridge,{recursive:true});
      const target=path.join(bridge,capsule.name);if(!(await exists(target)))await fs.writeFile(target,capsule.bytes,{flag:'wx'});
      else {const st=await fs.lstat(target);if(!st.isFile()||st.isSymbolicLink()||!(await fs.readFile(target)).equals(capsule.bytes))throw Error('Stored capsule integrity mismatch');}
    }
    return recoveryPaths;
  });
}

export async function portableSummaries(zip:JSZip) {
  const capsules=await inspectPortableProjects(zip,new Set(['tavernAgent','styleLab']));
  return (['agent','detective'] as const).flatMap(kind=>{
    const group=capsules.filter(c=>c.manifest.kind===kind);
    return group.length ? [{
      category:kind==='agent'?'tavernAgent' as const:'styleLab' as const,
      items:group.reduce((n,c)=>n+c.manifest.files.length,0),
      bytes:group.reduce((n,c)=>n+c.manifest.files.reduce((a,f)=>a+f.bytes,0),0),
    }] : [];
  });
}
/** Resolve only immutable, verified capsules previously imported by this app. */
export async function portableRecoveryPath(userData:string,kind:Kind,id:string) {
  if(!['agent','detective'].includes(kind)||!/^[a-f0-9]{64}$/.test(id))throw Error('Invalid recovery identity');
  const bridge=path.join(userData,'portable-project-capsules');await plainDirectory(bridge);
  const file=path.join(bridge,kind+'-'+id+'.zip'),st=await fs.lstat(file);
  if(!st.isFile()||st.isSymbolicLink()||st.size>MAX_TOTAL+10*1024*1024)throw Error('Invalid recovery capsule');
  const bytes=await fs.readFile(file),valid=await validateCapsule(bytes,kind);
  if(valid.id!==id)throw Error('Recovery integrity mismatch');
  const directory=path.join(userData,kind==='agent'?'TavernAgent/imports':'artist-detective-imports',id);
  await plainDirectory(directory);
  return {directory,valid};
}
/** Explicit activation: retain current state, never execute or start imported code. */
export async function activatePortableRecovery(userData:string,kind:Kind,id:string) {
 return withPortableLock(async()=>{
  const {directory,valid}=await portableRecoveryPath(userData,kind,id);
  // Rebuild from verified bytes, not possibly user-edited recovery files.
  const stamp=new Date().toISOString().replace(/[:.]/g,'-')+'-'+crypto.randomBytes(4).toString('hex');
  if(kind==='agent'){
    const base=path.join(userData,'TavernAgent'),stage=path.join(base,'restore-staging-'+stamp);
    const home=path.join(base,'user-home'),preserved=path.join(base,'restore-preserved',stamp);
    const homeEntries=[...valid.contents.entries()].filter(([name])=>!name.startsWith(PORTABLE_AGENT_WORKSPACE));
    const hasWorkspace=valid.contents.has(`${PORTABLE_AGENT_WORKSPACE}${WORKSPACE_LOCATION}`);
    await plainDirectory(base);await plainDirectory(home);await plainDirectory(preserved);
    if(homeEntries.length){
      await plainDirectory(stage);await fs.mkdir(stage,{recursive:true});
      for(const [name,data] of homeEntries){
        const target=path.join(stage,...relative(name).split('/'));
        await plainDirectory(path.dirname(target));await fs.mkdir(path.dirname(target),{recursive:true});
        await fs.writeFile(target,data,{flag:'wx',...(path.basename(target)==='agent-binding.key'?{mode:0o600}:{})});
      }
    }
    await fs.mkdir(preserved,{recursive:true});
    let movedHome=false,installedHome=false;
    try {
      if(homeEntries.length){
        if(await exists(home)){await fs.rename(home,path.join(preserved,'user-home'));movedHome=true;}
        await fs.rename(stage,home);installedHome=true;
      }
      const workspaceResult=hasWorkspace?await installPortableWorkspaceSnapshot(userData,valid.contents):undefined;
      return {preserved,...(workspaceResult?{preservedWorkspaceLocation:workspaceResult.preservedPointer}:{})};
    } catch(e){
      // The SQL workspace pointer is the final activation commit. On all
      // failures before it changes, restore the old user-home as well.
      if(installedHome)await fs.rm(home,{recursive:true,force:true}).catch(()=>{});
      if(movedHome)await fs.rename(path.join(preserved,'user-home'),home).catch(()=>{});
      throw e;
    } finally {await fs.rm(stage,{recursive:true,force:true}).catch(()=>{});}
  }
  // Validate staged result bytes (with rebased paths) before binding the project.
  for(const [name,original] of valid.contents) {
    const target=path.join(directory,name);await plainDirectory(path.dirname(target));
    const st=await fs.lstat(target);if(!st.isFile()||st.isSymbolicLink())throw Error('Invalid recovery result');
    let expected=original;
    if(name.endsWith('.json')){
      const rebase=(v:any):any=>Array.isArray(v)?v.map(rebase):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,w])=>[k,rebase(w)])):typeof v==='string'&&v.startsWith('portable:')?path.join(directory,'run',relative(v.slice(9))):v;
      expected=Buffer.from(JSON.stringify(rebase(JSON.parse(original.toString('utf8')))));
    }
    if(!(await fs.readFile(target)).equals(expected))throw Error('Recovery result has changed');
  }
  const file=path.join(userData,'artist-detective-runtime.json');let c:any={};let old:Buffer|null=null;
  try{old=await fs.readFile(file);c=JSON.parse(old.toString('utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  const preserved=path.join(userData,'artist-detective-preserved',stamp);await plainDirectory(preserved);await fs.mkdir(preserved,{recursive:true});
  if(old)await fs.writeFile(path.join(preserved,'artist-detective-runtime.json'),old,{flag:'wx'});
  c.directory=path.join(directory,'run');const ref=[...valid.contents.keys()].find(n=>n.startsWith('reference.'));
  if(ref)c.image=path.join(directory,ref);else delete c.image;
  delete c.pid;
  const temp=file+'.'+stamp+'.tmp';await fs.writeFile(temp,JSON.stringify(c),{flag:'wx'});await fs.rename(temp,file);
  return {preserved};
 });
}

export async function listPortableRecoveries(userData:string):Promise<DataBackupRecovery[]> {
 const bridge=path.join(userData,'portable-project-capsules');await plainDirectory(bridge);
 const names=await fs.readdir(bridge).catch((e)=>{if(e.code==='ENOENT')return [];throw e;});
 const result:DataBackupRecovery[]=[];
 for(const name of names.sort()){
   const match=/^(agent|detective)-([a-f0-9]{64})\.zip$/.exec(name);if(!match)continue;
   const kind=match[1] as Kind,id=match[2];
   const {directory}=await portableRecoveryPath(userData,kind,id);
   if(!(await exists(directory)))continue;
   // A past import is not evidence that current user data still matches it.
   result.push({kind,id,path:directory,status:'available'});
 }
 return result;
}

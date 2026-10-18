import {it,expect,vi,beforeEach,afterEach} from 'vitest';
import {EventEmitter} from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
const mock=vi.hoisted(()=>({handlers:new Map<string,Function>(),show:vi.fn(),settings:{theme:'system'} as Record<string,unknown>,set:vi.fn(),userDataPath:'',workspacePath:'',workspace:{samplerPresets:[],characters:[],personas:[],lorebooks:[],conversations:[],messages:[],attachments:[]} as any,workspaceWrites:[] as any[]}));
vi.mock('electron',()=>({app:{getPath:()=>mock.userDataPath},dialog:{showMessageBox:mock.show},ipcMain:{handle:(name:string,fn:Function)=>mock.handlers.set(name,fn)}}));
vi.mock('./store',()=>({getSettings:()=>mock.settings,setSetting:(key:string,value:unknown)=>{mock.set(key,value);mock.settings[key]=value;}}));
vi.mock('./agent-store',()=>({agentWorkspacePath:()=>mock.workspacePath,readAgentWorkspace:()=>mock.workspace,writeAgentWorkspace:(workspace:any)=>{mock.workspaceWrites.push(workspace);mock.workspace=workspace;return workspace;}}));
import {createStudioDataTools} from './studio-data-tools';
import type {AgentToolBridgeRequest} from '../../src/agent/types';
const testDirectories:string[]=[];
beforeEach(async()=>{mock.handlers.clear();mock.show.mockReset();mock.show.mockResolvedValue({response:1});mock.set.mockClear();mock.settings={theme:'system'};mock.workspaceWrites=[];mock.workspace={samplerPresets:[{id:'existing',name:'existing'}],characters:[],personas:[],lorebooks:[],conversations:[],messages:[],attachments:[]};const root=path.join(process.cwd(),'.tmp');await fs.mkdir(root,{recursive:true});const directory=await fs.mkdtemp(path.join(root,'studio-data-tools-'));testDirectories.push(directory);mock.userDataPath=directory;mock.workspacePath=path.join(directory,'agent','agent-workspace.json');});
afterEach(async()=>{await Promise.all(testDirectories.splice(0).map(directory=>fs.rm(directory,{recursive:true,force:true})));});
function fixture(respond=true,timeout=1000,approve=vi.fn(async()=>true)) {
  const sent:any[]=[];
  const contents={isDestroyed:()=>false,send:(_channel:string,request:any)=>{
    sent.push(request);
    if(respond)queueMicrotask(()=>mock.handlers.get('studio-agent:reply')!({sender:contents},request.id,{ok:true,data:{revision:'v1',change:{after:'dark'}}}));
  }};
  const owner={isDestroyed:()=>false,webContents:contents};
  const tools=createStudioDataTools(()=>owner as any,timeout,approve);
  const request={tool:'langbai_update_studio_config',args:{expectedRevision:'v1',target:'settings',patch:{theme:'dark'}},callId:'a',sessionId:'b'} as AgentToolBridgeRequest;
  return {tools,request,sent,contents,approve};
}
it('reads live data without a confirmation',async()=>{const f=fixture();expect((await f.tools.execute({...f.request,tool:'langbai_read_studio_state'})).ok).toBe(true);expect(mock.show).not.toHaveBeenCalled();expect(f.sent[0].action).toBe('read');});
it('ordinary settings prepare/apply directly without either confirmation',async()=>{const f=fixture();expect((await f.tools.execute(f.request)).ok).toBe(true);expect(mock.show).not.toHaveBeenCalled();expect(f.approve).not.toHaveBeenCalled();expect(f.sent.map(x=>x.action)).toEqual(['prepare','apply']);});
it('existing style overwrite waits for Agent approval and cancellation leaves it unchanged',async()=>{
 const f=fixture(true,1000,vi.fn(async()=>false));
 const request={...f.request,tool:'langbai_save_style_preset',args:{id:'style',name:'new',prompt:'new',expectedRevision:'v1'}};
 expect((await f.tools.execute(request)).ok).toBe(false);expect(f.approve).toHaveBeenCalledOnce();expect(mock.show).not.toHaveBeenCalled();expect(f.sent.map(x=>x.action)).toEqual(['prepare']);
});
it('new style saves directly, existing style needs Agent approval exactly once',async()=>{
 const f=fixture();const args={name:'name',prompt:'prompt',expectedRevision:'v1'};
 expect((await f.tools.execute({...f.request,tool:'langbai_save_style_preset',args})).ok).toBe(true);expect(f.approve).not.toHaveBeenCalled();
 expect((await f.tools.execute({...f.request,tool:'langbai_save_style_preset',args:{...args,id:'existing'}})).ok).toBe(true);expect(f.approve).toHaveBeenCalledOnce();expect(mock.show).not.toHaveBeenCalled();
});
it('timeouts do not substitute saved settings for live state',async()=>{const f=fixture(false,40);const r=await f.tools.execute({...f.request,tool:'langbai_read_studio_state'});expect(r.ok).toBe(false);expect(r.output).toContain('超时');});
it('rejects forged replies without consuming the real pending request',async()=>{const f=fixture(false);const p=f.tools.execute({...f.request,tool:'langbai_read_studio_state'});const id=f.sent[0].id;expect(()=>mock.handlers.get('studio-agent:reply')!({sender:{}},id,{ok:true})).toThrow();mock.handlers.get('studio-agent:reply')!({sender:f.contents},id,{ok:true,data:{live:true}});expect((await p).ok).toBe(true);});
it('does not allow commits without a pending confirmed apply',async()=>{fixture();await expect(mock.handlers.get('studio-agent:commit')!({sender:{}},'fake','theme','system','dark')).rejects.toThrow();expect(mock.set).not.toHaveBeenCalled();});
it('compare-and-set commits once and rejects concurrent edits or replay',async()=>{
  const f=fixture(false);const task=f.tools.execute(f.request);
  await vi.waitFor(()=>expect(f.sent).toHaveLength(1));
  mock.handlers.get('studio-agent:reply')!({sender:f.contents},f.sent[0].id,{ok:true,data:{change:{theme:'dark'}}});
  await vi.waitFor(()=>expect(f.sent).toHaveLength(2));
  const id=f.sent[1].id,commit=mock.handlers.get('studio-agent:commit')!;
  mock.settings.theme='light';await expect(commit({sender:f.contents},id,'theme','system','dark')).rejects.toThrow('changed');expect(mock.set).not.toHaveBeenCalled();
  mock.settings.theme='system';await commit({sender:f.contents},id,'theme','system','dark');expect(mock.set).toHaveBeenCalledOnce();
  await expect(commit({sender:f.contents},id,'theme','dark','light')).rejects.toThrow();
  mock.handlers.get('studio-agent:reply')!({sender:f.contents},id,{ok:true,data:{persisted:true}});expect((await task).ok).toBe(true);
});

function waitingFixture(){
 const sent:any[]=[];const contents=Object.assign(new EventEmitter(),{isDestroyed:()=>false,send:(_channel:string,request:any)=>sent.push(request)});
 const owner={isDestroyed:()=>false,webContents:contents};return {sent,contents,tools:createStudioDataTools(()=>owner as any,20)};
}
it('run completion wait outlives ordinary IPC timeout and cleans sender lifecycle listeners',async()=>{
 const f=waitingFixture();let settled=false;const waiting=f.tools.comicRunSettled('run').then(r=>{settled=true;return r;});
 await new Promise(r=>setTimeout(r,50));expect(settled).toBe(false);expect(f.sent[0].args).toEqual({action:'_comic.generation.wait',runId:'run'});
 expect(()=>mock.handlers.get('studio-agent:reply')!({sender:{}},f.sent[0].id,{ok:true,data:{phase:'completed'}})).toThrow();
 mock.handlers.get('studio-agent:reply')!({sender:f.contents},f.sent[0].id,{ok:true,data:{phase:'completed'}});expect(await waiting).toEqual({phase:'completed'});expect(f.contents.eventNames()).toEqual([]);
});
it.each(['destroyed','render-process-gone','did-start-navigation'])('run wait rejects on %s rather than waiting forever',async event=>{
 const f=waitingFixture(),waiting=f.tools.comicRunSettled('run');const rejection=expect(waiting).rejects.toThrow('未自动重试');f.contents.emit(event,{isMainFrame:true,isSameDocument:false});await rejection;expect(f.contents.eventNames()).toEqual([]);
 expect(()=>mock.handlers.get('studio-agent:reply')!({sender:f.contents},f.sent[0].id,{ok:true})).toThrow();
});
it('same-document or subframe navigation does not interrupt a real run',async()=>{
 const f=waitingFixture(),waiting=f.tools.comicRunSettled('run');f.contents.emit('did-start-navigation',{isMainFrame:true,isSameDocument:true});f.contents.emit('did-start-navigation',{isMainFrame:false,isSameDocument:false});
 mock.handlers.get('studio-agent:reply')!({sender:f.contents},f.sent[0].id,{ok:true,data:{phase:'completed'}});expect(await waiting).toEqual({phase:'completed'});
});
it('local library import creates a real pre-import workspace backup before writing through SQL-backed store',async()=>{
 const f=fixture();
 const owner={isDestroyed:()=>false,webContents:{isDestroyed:()=>false}};
 const tools=createStudioDataTools(()=>owner as any);
 const result=await tools.execute({...f.request,tool:'langbai_import_studio_data',args:{collection:'samplerPresets',items:[{name:'imported preset',prompt:'new body'}]}});
 expect(result.ok).toBe(true);
 const data=JSON.parse(result.output) as {backupPath:string;collection:string;imported:number};
 expect(data.collection).toBe('samplerPresets');expect(data.imported).toBe(1);
 expect(data.backupPath).toContain(path.join('TavernAgent','library-import-backups'));
 const backup=JSON.parse(await fs.readFile(data.backupPath,'utf8')) as {collection:string;workspace:{samplerPresets:Array<{id:string}>}};
 expect(backup.collection).toBe('samplerPresets');expect(backup.workspace.samplerPresets).toEqual([{id:'existing',name:'existing'}]);
 expect(mock.workspaceWrites).toHaveLength(1);expect(mock.workspaceWrites[0].samplerPresets).toHaveLength(2);
 expect(await fs.stat(data.backupPath)).toBeTruthy();
});

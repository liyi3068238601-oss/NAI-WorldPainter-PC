import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';

const fixture=vi.hoisted(()=>({root:'',handlers:new Map<string,(...args:any[])=>any>()}));
vi.mock('electron',()=>({app:{getPath:()=>path.join(fixture.root,'profile'),getAppPath:()=>fixture.root,isPackaged:false},
  ipcMain:{handle:(name:string,fn:(...args:any[])=>any)=>fixture.handlers.set(name,fn)},dialog:{showOpenDialog:vi.fn()}}));
const book=(content:string)=>JSON.stringify({entries:[{id:1,title:'Synthetic',source:'test',keywords:['cat'],content}]});
const call=(name:string,...args:unknown[])=>fixture.handlers.get('worldpainter:knowledge:'+name)!({},...args);
beforeEach(async()=>{
  vi.resetModules();fixture.handlers.clear();
  const base=path.resolve('.tmp/knowledge-tests');await fs.mkdir(base,{recursive:true});fixture.root=await fs.mkdtemp(path.join(base,'case-'));
  await fs.mkdir(path.join(fixture.root,'public/worldpainter/mobile'),{recursive:true});
  await fs.writeFile(path.join(fixture.root,'public/worldpainter/mobile/nsfw_knowledge.json'),book('bundled'));
  const referenceDir=path.join(fixture.root,'public/worldpainter/mobile/nai5-prompting/references');
  await fs.mkdir(referenceDir,{recursive:true});
  await fs.cp(path.resolve('public/worldpainter/mobile/nai5-prompting/references'),referenceDir,{recursive:true});
  (await import('./worldpainter-knowledge')).registerWorldpainterKnowledgeIpc();
});
afterEach(async()=>{await fs.rm(fixture.root,{recursive:true,force:true});});
describe('knowledge source transactions',()=>{
  it('validates replacement before saving and retains previous settings on failure',async()=>{
    const initial=await call('status');
    const external=path.join(fixture.root,'中文 知识.json');await fs.writeFile(external,book('external'));
    const saved=await call('save',{...initial.settings,path:external});expect(saved.source).toBe('external');
    await expect(call('save',{...saved.settings,path:path.join(fixture.root,'missing.json')})).rejects.toThrow();
    expect((await call('status')).sha256).toBe(saved.sha256);
    expect(JSON.parse(await fs.readFile(path.join(fixture.root,'profile/worldpainter-knowledge.json'),'utf8')).path).toBe(external);
  });
  it('reloads a changed external file and visibly falls back when it disappears',async()=>{
    const initial=await call('status');const external=path.join(fixture.root,'external.json');await fs.writeFile(external,book('first'));
    const first=await call('save',{...initial.settings,path:external});await fs.writeFile(external,book('second'));
    expect((await call('status')).sha256).toBe(first.sha256);
    const next=await call('reload');expect(next.sha256).not.toBe(first.sha256);
    await fs.unlink(external);const fallback=await call('reload');expect(fallback.source).toBe('bundled');expect(fallback.warning).toContain('外部');expect(fallback.settings.path).toBe(external);
  });
  it('restores the configured file after a fresh service instance',async()=>{
    const initial=await call('status');const external=path.join(fixture.root,'external.json');await fs.writeFile(external,book('persisted'));
    await call('save',{...initial.settings,path:external,version:'v5',v5StyleWords:'ink'});
    vi.resetModules();(await import('./worldpainter-knowledge')).registerWorldpainterKnowledgeIpc();
    expect((await call('status')).settings.v5StyleWords).toBe('ink');
    const context=await (await import('./worldpainter-knowledge')).worldpainterKnowledgeContext('cat');
    expect(context.prompt).toContain('persisted');expect(context.prompt).not.toContain('bundled');
    expect(context.prompt).toContain('Configured prompting-reference version: V5');
    expect(context.prompt).toContain('does not report or change the active generation model');
    expect(context.prompt).toContain('read_generation_state');
    expect(context.prompt).toContain('read_prompting_reference');
    expect(context.prompt).toContain('ink');
    expect(context.prompt).not.toContain('langbai_');
    expect(context.prompt).not.toContain('Skill');
  });
  it('returns adapted creative references only for the two PC-supported names',async()=>{
    const service=await import('./worldpainter-knowledge');
    const ideation=await service.readWorldpainterPromptingReference('ideation');
    expect(ideation).toContain('PC 端适配版');
    expect(ideation).toContain('read_prompting_reference');
    const writing=await service.readWorldpainterPromptingReference('writing');
    expect(writing).toContain('接触点必须有主人');
    expect(writing).not.toContain('search_tags');
    expect(writing).not.toContain('Custom position');
    await expect(service.readWorldpainterPromptingReference('skill')).rejects.toThrow('ideation 或 writing');
  });
  it('bounds the complete serialized knowledge JSON including long metadata and escaped Unicode',async()=>{
    const initial=await call('status');
    const external=path.join(fixture.root,'long-metadata.json');
    const entries=Array.from({length:5},(_,i)=>({id:i+1,title:('"\\\n🧪').repeat(2000),source:'🧪'.repeat(10000),
      keywords:Array(1024).fill('cat'),content:`cat ${String(i).repeat(2000)}`}));
    await fs.writeFile(external,JSON.stringify({entries}),'utf8');
    await call('save',{...initial.settings,path:external,version:'v5'});
    const {prompt}=await (await import('./worldpainter-knowledge')).worldpainterKnowledgeContext('cat');
    const marker='Relevant knowledge excerpts (bounded source material):\n';
    const serialized=prompt.slice(prompt.indexOf(marker)+marker.length);
    expect(serialized.length).toBeLessThanOrEqual(12000);
    const refs=JSON.parse(serialized);
    expect(refs).toHaveLength(5);
    expect(refs[0].title.length).toBeLessThanOrEqual(128);
    expect(refs[0].source.length).toBeLessThanOrEqual(64);
    expect(refs.every((entry:any)=>entry.keywords.length<=6)).toBe(true);
    expect(refs.every((entry:any)=>entry.content.length<=900)).toBe(true);
  });
});

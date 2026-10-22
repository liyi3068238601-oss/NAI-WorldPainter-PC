'use strict';
// Run with the packaged Electron executable and ELECTRON_RUN_AS_NODE=1.
// All model responses are local fixtures; this probe never calls a provider.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {createRequire}=require('node:module');
const {pathToFileURL}=require('node:url');
const root=path.resolve(process.argv[2]||'');
const baseline=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
const load=createRequire(path.join(root,'package.json'));
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
function assert(value,message){if(!value)throw Error(message);}

(async()=>{
  const controls=load('./dist-electron/src/agent/workspace-controls.js');
  const base=load('./dist-electron/src/agent/r4-system-prompt.js').R4_SYSTEM_PROMPT;
  const skills=controls.createBuiltinAgentSkills();
  assert(skills.length===7,'Expected seven registered creative Skills');
  assert(controls.STUDIO_BUILTIN_PRESETS.length===4,'Optional built-in presets missing');
  for(const previous of baseline.presets.filter(p=>p.id!=='studio-novelai-assistant')){
    const current=controls.STUDIO_BUILTIN_PRESETS.find(p=>p.id===previous.id);
    assert(current&&hash(current.body)===previous.hash,'Optional preset changed: '+previous.id);
  }
  const preset=controls.STUDIO_NOVELAI_ASSISTANT_PRESET_BODY;
  assert(preset.length<1500,'The default creative preset still contains workflow manuals');
  assert(!/langbai_|权重范围 0[–-]8/.test([base,preset,...skills.map(s=>s.instructions)].join('\n')),'Legacy tool or conflicting weighting rules remain active');
  assert(!skills.some(skill=>base.includes(skill.instructions)),'Skill bodies eagerly injected into the base prompt');
  const registry=load('./dist-electron/src/agent/r4-registry.json');
  const write=registry.tools.find(tool=>tool.canonical==='write_workbench_prompts');
  assert(JSON.stringify(write).includes('characterLayoutIntent'),'Coordinate-intent contract missing from packaged registry');
  const knowledgeFile=path.join(root,'dist',baseline.mobileKnowledge.path.replace(/^public\//,''));
  assert(hash(fs.readFileSync(knowledgeFile))===baseline.mobileKnowledge.hash,'Bundled mobile knowledge changed');
  for(const reference of baseline.mobileReferences){
    const file=path.join(root,'dist/worldpainter/mobile/nai5-prompting',reference.file);
    assert(hash(fs.readFileSync(file))===reference.hash,'Original mobile reference changed: '+reference.file);
  }
  const knowledge=load('./dist-electron/src/agent/knowledge.js');
  const book=knowledge.parseKnowledgeBook(fs.readFileSync(knowledgeFile,'utf8'));
  assert(book.length===12738,'Bundled mobile knowledge entry count changed');
  const rows=[{id:1,title:'General',source:'fixture',keywords:['red'],content:'Generic clothing'},
    {id:200,title:'red dress',source:'fixture',keywords:['red dress'],content:'Specific clothing'}];
  assert(knowledge.matchKnowledge(rows,'red dress')[0]?.id===200,'Knowledge retrieval still prioritizes old IDs');
  const aiMeta=JSON.parse(fs.readFileSync(path.join(root,'node_modules/@earendil-works/pi-ai/package.json'),'utf8'));
  const ai=await import(pathToFileURL(path.join(root,'node_modules/@earendil-works/pi-ai',aiMeta.main)).href);
  const model={id:'offline-fixture',name:'Offline fixture',provider:'fixture',api:'openai-completions',baseUrl:'https://fixture.invalid',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:4096,maxTokens:1024};
  const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
  const reply=(content,stopReason)=>({role:'assistant',content,stopReason,api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),usage});
  const replies=[reply([{type:'toolCall',id:'read-state',name:'read_generation_state',arguments:{}}],'toolUse'),reply([{type:'text',text:'OFFLINE_CANONICAL_TOOL_OK'}],'stop')];
  let reads=0;
  const result=await load('./dist-electron/electron/ipc/pi-agent-core.js').runStudioPiAgent({model,history:[],systemPrompt:base,text:'Inspect the synthetic workbench',
    tools:[{name:'read_generation_state',description:'Offline fixture',readonly:true,flatArguments:true,parameters:{type:'object',properties:{},additionalProperties:false},
      execute:async()=>{reads++;return {ok:true,output:'Synthetic read receipt'};}}],authorize:async()=>false,
    streamFn:()=>{const stream=ai.createAssistantMessageEventStream(),message=replies.shift();assert(message,'Unexpected extra model call');
      queueMicrotask(()=>{stream.push({type:'start',partial:message});stream.push({type:'done',reason:message.stopReason,message});});return stream;}});
  assert(reads===1&&result.text==='OFFLINE_CANONICAL_TOOL_OK','Packaged canonical native tool loop failed');
  console.log(JSON.stringify({pass:true,source:'packaged production modules',skillCount:skills.length,optionalPresetsUnchanged:3,
    knowledgeEntries:book.length,mobileContentUnchanged:true,canonicalNativeToolLoop:true,defaultPresetCharacters:preset.length,
    baseInstructionCharacters:base.length,paidCalls:0,providerRequests:0,archiveSha256:hash(require('original-fs').readFileSync(root))}));
})().catch(error=>{console.error(error.stack||String(error));process.exitCode=1;});

const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{createHash}=require('node:crypto'),sharp=require('sharp');
const root=path.resolve(__dirname,'..'),evidence=path.resolve(root,'../docs/evidence');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
(async()=>{
  const summaries=[];
  for(const name of ['uiux-phase2-20261020','uiux-prototype-20261020']){
    const dir=path.join(evidence,name),actions=read(path.join(dir,'actions.json')),shots=[];
    for(const file of fs.readdirSync(path.join(dir,'screenshots')).filter(f=>f.endsWith('.png')).sort()){
      const bytes=fs.readFileSync(path.join(dir,'screenshots',file)),size=await sharp(bytes).metadata();
      const action=actions.find(a=>a.screenshot?.file===file);
      shots.push({file,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),pixels:{width:size.width,height:size.height},viewport:action?.screenshot.viewport??null});
    }
    fs.writeFileSync(path.join(dir,'screenshot-manifest.json'),JSON.stringify({screenshots:shots,unaltered:true,prototype:name.includes('prototype')},null,2));
    fs.writeFileSync(path.join(dir,'task-records.md'),'# 逐步操作记录\n\n原始截图不作后期编辑。所有点击为截图发现后的坐标操作；provider-check 仅测量已发现的按钮。\n\n|序号|动作|输入/参数|截图|\n|---:|---|---|---|\n'+actions.map((a,i)=>`|${i+1}|${esc(a.action)}|${esc(a.text??a.key??(a.x!==undefined?`${a.x},${a.y}`:a.width!==undefined?`${a.width}×${a.height}`:''))}|${a.screenshot?`[${a.screenshot.file}](screenshots/${a.screenshot.file})`:a.closed?'关闭':''}|`).join('\n')+'\n');
    fs.writeFileSync(path.join(dir,'index.html'),`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(name)} 证据</title><style>body{font:15px/1.6 system-ui;background:#17171b;color:#eee;margin:24px}a{color:#f5d57a}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(330px,1fr));gap:20px}img{width:100%;height:230px;object-fit:contain;background:#000}article{border:1px solid #555;border-radius:10px;padding:14px}small{color:#bbb}</style><h1>${name.includes('prototype')?'独立交互原型预览记录（业务模拟）':'实际 Windows Electron 局部修复回归'}</h1><p><a href="../../UIUX_PHASE2_20261020.md">阶段报告</a> · <a href="task-records.md">逐步操作</a> · <a href="screenshot-manifest.json">原图哈希与尺寸</a></p><main>${shots.map(s=>`<article><a href="screenshots/${s.file}"><img loading="lazy" src="screenshots/${s.file}" alt="${esc(s.file)}">${esc(s.file)}</a><p><small>${s.pixels.width}×${s.pixels.height} px${s.viewport?` · ${s.viewport.width}×${s.viewport.height} CSS px · DPR ${s.viewport.dpr}`:''}</small></p></article>`).join('')}</main></html>`);
    summaries.push({directory:name,screenshots:shots.length,actions:actions.length,bytes:shots.reduce((n,s)=>n+s.bytes,0)});
  }
  const actions=read(path.join(evidence,'uiux-phase2-20261020/actions.json'));
  const checks=actions.filter(a=>a.checks);
  assert(checks.length>=8);
  for(const a of checks)assert(a.checks.buttons.every(b=>b.inside&&b.hit));
  const top=checks.find(a=>a.label==='u04-after-actions-visible'),bottom=checks.find(a=>a.label==='u04-after-bottom-actions');
  assert(bottom.checks.scrollTop>top.checks.scrollTop);
  assert.deepEqual(top.checks.buttons.map(b=>b.rect.y),bottom.checks.buttons.map(b=>b.rect.y));
  const ownProfile=name=>read(path.join(root,'.tmp',name,'profile/worldpainter-desktop.json'));
  const provider=ownProfile('uiux-1792489808392').settings.agentProviders.providers[0];
  assert.equal(provider.models.find(m=>m.id==='uiux-second-model').contextWindow,64000);
  assert.equal(provider.models.length,2);
  const newProfile=ownProfile('uiux-1792490496480'),legacy=ownProfile('uiux-phase2-legacy-20261020');
  for(const profile of [newProfile,legacy]){
    assert.equal(profile.settings.lastGenerationState.params.model,'nai-diffusion-4-5-full');
    assert.equal(profile.history.length,0);
  }
  const result={summaries,providerChecksPassed:checks.length,scrollKeepsActionPosition:true,savedContextAfterSaveAndCancel:64000,newAndLegacySavedModel:'nai-diffusion-4-5-full',productHistoryCounts:[newProfile.history.length,legacy.history.length],visualReview:'See report: assertions do not replace visual acceptance'};
  fs.writeFileSync(path.join(evidence,'uiux-phase2-20261020/verification.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
})().catch(e=>{console.error(e);process.exitCode=1});

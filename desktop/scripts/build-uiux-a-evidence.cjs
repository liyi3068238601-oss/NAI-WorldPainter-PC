const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{createHash}=require('node:crypto'),sharp=require('sharp');
const root=path.resolve(__dirname,'..'),dir=path.resolve(root,'../docs/evidence/uiux-a-20261020');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
(async()=>{
  const run=path.resolve(process.argv[2]||fs.readFileSync(path.join(root,'.tmp/uiux-active.txt'),'utf8').trim());
  assert(run.startsWith(path.join(root,'.tmp')+path.sep),'Only synthetic audit profiles allowed');
  const data=read(path.join(run,'profile/worldpainter-desktop.json')),before=read(path.join(dir,'draft-before-restart.json'));
  const after=Object.fromEntries(Object.keys(before).map(key=>[key,data.settings.lastGenerationState.params[key]]));
  assert.deepEqual(after,before); assert.equal(after.width,1024); assert.equal(after.seed,424242); assert.equal(data.history.length,0);
  fs.writeFileSync(path.join(dir,'draft-after-restart.json'),JSON.stringify(after,null,2));
  const actions=read(path.join(dir,'actions.json')),shots=[];
  const excluded={3:'Window minimized: contentBounds zero',4:'Window minimized: contentBounds zero',27:'Build/start order uncertain; superseded by 028+'};
  for(const file of fs.readdirSync(path.join(dir,'screenshots')).filter(f=>f.endsWith('.png')).sort()){
    const bytes=fs.readFileSync(path.join(dir,'screenshots',file)),meta=await sharp(bytes).metadata(),number=Number(file.slice(0,3));
    const action=actions.find(a=>a.screenshot?.file===file);
    shots.push({number,file,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),pixels:{width:meta.width,height:meta.height},viewport:action?.screenshot.viewport??null,excludedFromAcceptance:excluded[number]||null});
  }
  const finalStart=actions.find(a=>a.screenshot?.file.startsWith('029-')).at;
  const finalActions=actions.filter(a=>a.at>=finalStart),finalChecks=finalActions.filter(a=>a.checks),finalErrors=finalActions.filter(a=>a.error);
  assert.equal(finalErrors.length,0); assert(finalChecks.length>=18);
  for(const a of finalChecks){assert(a.checks.buttons.every(b=>b.inside&&b.hit));assert.equal(a.checks.section,a.expected);assert(a.checks.visibleHeight>=20);}
  assert.equal(new Set(finalChecks.map(a=>a.checks.theme)).size,2);
  assert.deepEqual([...new Set(finalChecks.map(a=>a.checks.section))].sort(),['model','prompt','size']);
  const result={screenshots:shots.length,bytes:shots.reduce((n,s)=>n+s.bytes,0),actions:actions.length,finalBuildChecksPassed:finalChecks.length,finalBuildErrors:finalErrors.length,earlierErrorCount:actions.filter(a=>a.error&&a.at<finalStart).length,excludedFromAcceptance:excluded,viewports:[...new Set(finalChecks.map(a=>`${a.screenshot.viewport.width}x${a.screenshot.viewport.height}`))],themes:[...new Set(finalChecks.map(a=>a.checks.theme))],draftUnchangedAfterColdRestart:true,syntheticDraft:after,productHistoryCount:data.history.length,profileInsideAuditRoot:true,visualReview:'Original captures reviewed separately; unit tests and rectangle assertions do not replace visual acceptance'};
  fs.writeFileSync(path.join(dir,'verification.json'),JSON.stringify(result,null,2));
  fs.writeFileSync(path.join(dir,'screenshot-manifest.json'),JSON.stringify({unaltered:true,screenshots:shots},null,2));
  fs.writeFileSync(path.join(dir,'task-records.md'),'# A 方案落实：逐步记录\n\n坐标是 CSS 像素。文件名表达意图，实际结果见截图、viewport 和错误记录；003/004/027 不作为验收。017/018 为输入未聚焦的操作错误。\n\n|序号|动作|输入/参数|截图/结果|\n|---:|---|---|---|\n'+actions.map((a,i)=>`|${i+1}|${esc(a.action)}|${esc(a.text??a.key??(a.x!==undefined?`${a.x},${a.y}`:a.width!==undefined?`${a.width}×${a.height}`:a.expected??''))}|${a.screenshot?`[${a.screenshot.file}](screenshots/${a.screenshot.file})`:a.error?'错误：'+esc(a.error).replace(/\|/g,'&#124;'):a.closed?'已关闭':''}|`).join('\n')+'\n');
  const highlights=[6,36,38,68,77,90,94,97].map(n=>shots.find(s=>s.number===n)).filter(Boolean);
  const card=s=>`<article><a href="screenshots/${s.file}"><img loading="lazy" src="screenshots/${s.file}" alt="${esc(s.file)}">${esc(s.file)}</a><p>${s.pixels.width}×${s.pixels.height} px${s.viewport?` · viewport ${s.viewport.width}×${s.viewport.height} · DPR ${s.viewport.dpr}`:''}</p>${s.excludedFromAcceptance?`<strong>排除验收：${esc(s.excludedFromAcceptance)}</strong>`:''}</article>`;
  fs.writeFileSync(path.join(dir,'index.html'),`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>绘世 A 方向：真实 Electron 验收</title><style>body{margin:24px;background:#17171b;color:#eee;font:15px/1.6 system-ui}a{color:#f5d57a}section{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:18px}article{border:1px solid #555;padding:14px;border-radius:12px}img{width:100%;height:230px;object-fit:contain;background:#000}article p{font-size:12px}strong{color:#ffa1a1}</style><h1>A 方向 · 生图页局部落实</h1><p>保留三栏和参数优先；仅新增文生图分区直达。真实 Electron、隔离合成数据、125% DPI。</p><p><a href="../../UIUX_A_20261020.md">完整报告与 A 差异</a> · <a href="task-records.md">逐步操作</a> · <a href="verification.json">验证结果</a> · <a href="screenshot-manifest.json">原图哈希</a></p><h2>主要前后与冷启动证据</h2><section>${highlights.map(card).join('')}</section><h2>全部 ${shots.length} 张原图</h2><p>保留早期失败与无效工具证据；不将截图数量当成全软件验收覆盖。</p><section>${shots.map(card).join('')}</section></html>`);
  console.log(JSON.stringify(result));
})().catch(e=>{console.error(e);process.exitCode=1});

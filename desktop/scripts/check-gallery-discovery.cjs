// Native Electron UI regression with synthetic gallery IPC only. No external traffic.
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const desktop = path.resolve(__dirname, '..');
const repo = path.dirname(desktop);
const playwrightPath = process.env.GALLERY_PLAYWRIGHT_PATH || path.join(path.dirname(repo), 'dot-uiux', 'desktop', '.tmp', 'uiux-tools', 'node_modules', 'playwright-core');
const {_electron} = require(playwrightPath);
const {PNG} = require(path.join(desktop, 'node_modules', 'pngjs'));
const run = path.join(desktop, '.tmp', `gallery-discovery-${Date.now()}`);
const evidence = path.join(repo, 'docs', 'evidence', 'gallery-discovery-20261022');
fs.mkdirSync(run, {recursive:true}); fs.mkdirSync(evidence, {recursive:true});
const png = new PNG({width:240,height:320});
for(let y=0;y<320;y++)for(let x=0;x<240;x++){const p=(y*240+x)*4;png.data[p]=40+x/2;png.data[p+1]=70+y/3;png.data[p+2]=150;png.data[p+3]=255;}
const fixture = path.join(run,'synthetic.png');fs.writeFileSync(fixture,PNG.sync.write(png));
const env={...process.env};
for(const key of Object.keys(env))if(/TOKEN|API.?KEY|SECRET|CREDENTIAL|PORTABLE_EXECUTABLE|ELECTRON_RUN_AS_NODE|VITE_DEV_SERVER_URL|NAI_UI_CAPTURE_PATH/i.test(key))delete env[key];
for(const key of ['APPDATA','LOCALAPPDATA','USERPROFILE','TEMP','TMP','HOME']){env[key]=path.join(run,key.toLowerCase());fs.mkdirSync(env[key],{recursive:true});}
env.WORLDPAINTER_DATA_DIR=path.join(run,'profile');env.UIUX_AUDIT_ROOT=run;
env.HTTP_PROXY=env.HTTPS_PROXY=env.ALL_PROXY='http://127.0.0.1:9';env.NO_PROXY='localhost,127.0.0.1';
let app,page;const checks=[],errors=[];
const check=(condition,name)=>{if(!condition)throw Error(name);checks.push(name);};
async function choose(label,option){await page.getByRole('button',{name:new RegExp(`^${label}:`)}).click();await page.getByRole('option',{name:option,exact:true}).click();}
async function lastRequest(){return app.evaluate(()=>globalThis.galleryTestRequests.at(-1));}
async function waitRequest(source,sort){await page.waitForFunction(({source,sort})=>window.__galleryUiRequest?.source===source&&(!sort||window.__galleryUiRequest.sort===sort),{source,sort});}
async function snapshot(name){await page.screenshot({path:path.join(evidence,`${name}.png`)});}
async function settled(){await page.locator('.aitag-search-panel button').filter({hasText:'搜索'}).waitFor();await page.waitForFunction(()=>!document.querySelector('.online-gallery-search-row button')?.disabled);}
(async()=>{
 try{
  app=await _electron.launch({executablePath:require(path.join(desktop,'node_modules','electron')),args:[path.join(desktop,'scripts','uiux-offline-entry.cjs'),'--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'],cwd:desktop,env,timeout:45000});
  page=await app.firstWindow();page.setDefaultTimeout(12000);page.on('pageerror',error=>errors.push(String(error)));
  await app.evaluate(({ipcMain},input)=>{
   const req=process.getBuiltinModule('node:module').createRequire(input.desktop+'/package.json');
   const store=req(input.desktop+'/dist-electron/electron/ipc/store.js');
   const {loadCivitaiGalleryDetail}=req(input.desktop+'/dist-electron/src/civitai-gallery.js');
   store.setSetting('language','zh-CN');store.setSetting('hasOnboarded',true);
   globalThis.galleryTestRequests=[];globalThis.galleryTestFailPageTwo=true;
   const item=(r,id)=>({source:r.source,id:String(id),kind:'work',title:`Synthetic ${r.source} ${id}`,author:'Synthetic author',description:'',createdAt:'2026-10-22',rating:'g',score:20,favoriteCount:5,viewCount:0,mediaCount:1,prompt:String(id)==='3'?'':'synthetic gallery prompt',negativePrompt:'synthetic negative',tags:{artists:[],characters:[],copyrights:[],general:[],meta:[]},cover:{id:String(id),previewUrl:'https://example.invalid/test.png',displayUrl:'https://example.invalid/test.png',downloadUrl:'https://example.invalid/test.png',width:240,height:320},sourceUrl:'https://example.invalid/'});
   for(const name of ['online-gallery:search','online-gallery:detail','online-gallery:cache-image','online-gallery:clear-data-cache'])ipcMain.removeHandler(name);
   ipcMain.handle('online-gallery:search',async(event,r)=>{
    const {gelbooruApiKey,gelbooruUserId,...safeRequest}=r;globalThis.galleryTestRequests.push(safeRequest);
    await event.sender.executeJavaScript(`window.__galleryUiRequest=${JSON.stringify(safeRequest)}`);
    if(r.source==='civitai'&&r.page===2&&globalThis.galleryTestFailPageTwo){globalThis.galleryTestFailPageTwo=false;throw Error('Synthetic transient page failure');}
    const empty=r.source==='civitai'&&r.page===2;
    return {source:r.source,page:r.page,pageSize:r.pageSize,items:empty?[]:[item(r,r.page)],hasMore:r.page<3,nextCursor:r.source==='civitai'&&r.page<3?`cursor-${r.page+1}`:undefined};
   });
   ipcMain.handle('online-gallery:detail',(_event,r)=>loadCivitaiGalleryDetail(async()=>({items:[{id:Number(r.id),type:'image',url:'https://image.civitai.com/synthetic.png',width:240,height:320,nsfw:false,nsfwLevel:'None',baseModel:'Synthetic model',meta:r.id==='3'?null:{id:Number(r.id),meta:{prompt:'synthetic gallery prompt',negativePrompt:'synthetic negative'}}}]}),r.id));
   ipcMain.handle('online-gallery:cache-image',()=>input.image);
   ipcMain.handle('online-gallery:clear-data-cache',()=>{});
  },{desktop,image:pathToFileURL(fixture).href});
  await page.addInitScript(()=>localStorage.setItem('langbai.online-gallery.source.v1','danbooru'));
  await page.reload();
  const notice=page.locator('.v5-migration-notice');if(await notice.count())await notice.getByRole('button').first().click();
  const windowHandle=await app.browserWindow(page);await windowHandle.evaluate(win=>{if(win.isMaximized())win.unmaximize();win.setContentSize(1360,900);});
  await page.locator('[data-tab="onlineGallery"]').click();await settled();await waitRequest('danbooru');
  await choose('排序','收藏数');await settled();check((await lastRequest()).sort==='favorites','Danbooru favorites sends server sort');
  await choose('时间范围','最近7天');await settled();check((await lastRequest()).timeRange==='week','Booru time range resets page');
  await snapshot('01-danbooru-sort');
  await choose('画廊来源','Gelbooru');await settled();
  await page.getByRole('button',{name:/^排序:/}).click();check(await page.getByRole('option',{name:'收藏数',exact:true}).count()===0,'Gelbooru hides unsupported favorite sorting');await page.keyboard.press('Escape');
  await choose('画廊来源','TAGs Gallery');await settled();await choose('模型','V5');await settled();await choose('排序','收藏数');await settled();
  check((await lastRequest()).model==='v5'&&(await lastRequest()).sort==='favorites','TAGs model and sort forwarded together');await snapshot('02-tags-v5');
  await choose('画廊来源','Civitai');await settled();check(await page.locator('.gallery-page-number-input').count()===0,'Civitai has no unsupported numeric jump');
  check((await lastRequest()).timeRange==='all'&&(await lastRequest()).page===1,'Source switch clears prior filters');
  await page.getByRole('button',{name:'下一页',exact:true}).click();await page.getByRole('button',{name:'重试',exact:true}).waitFor();
  await page.getByRole('button',{name:'重试',exact:true}).click();await settled();
  check((await lastRequest()).page===2&&(await lastRequest()).cursor==='cursor-2','Retry preserves failed page cursor');
  check(await page.locator('.aitag-card').count()===0,'Empty Civitai page stays empty');
  check(await page.getByRole('button',{name:'下一页',exact:true}).isEnabled(),'Empty page keeps next cursor available');
  await page.getByRole('button',{name:'下一页',exact:true}).click();await settled();
  check((await lastRequest()).cursor==='cursor-3','Cursor continuation reaches third page');
  await page.locator('.aitag-card-hit').first().click();await page.getByText('这张图片没有可用的生成提示词。',{exact:true}).waitFor();
  check(await page.locator('.online-gallery-inline-actions button').count()===0,'Missing prompt has no apply action');
  await page.getByRole('button',{name:'返回搜索结果',exact:true}).click();
  await page.getByRole('button',{name:'上一页',exact:true}).click();await settled();check((await lastRequest()).page===2,'Cursor history supports back navigation');
  await choose('排序','随机');await settled();check((await lastRequest()).page===1&&(await lastRequest()).cursor===undefined,'Sort change starts a new cursor sequence');
  check(await page.getByRole('button',{name:'下一页',exact:true}).count()===1,'Random Civitai still offers continuation');
  await snapshot('03-civitai-random');
  await page.locator('.aitag-card-hit').first().click();await page.locator('.online-gallery-inline-actions').waitFor();
  check(await page.locator('.online-gallery-detail-info').textContent().then(t=>t.includes('synthetic gallery prompt')&&t.includes('synthetic negative')),'Nested Civitai detail metadata exposes positive and negative prompts');
  await page.locator('.online-gallery-inline-actions .btn.primary').click();
  check(await page.locator('[data-tab="generate"][aria-current="page"]').count()===1,'Apply prompt navigates to creation');
  check(await page.locator('body').textContent().then(t=>t.includes('synthetic gallery prompt')),'Applied prompt is visible in creation');
  await snapshot('04-applied-prompt');
 }catch(error){errors.push(String(error.stack||error));if(page)await snapshot('failure').catch(()=>{});}
 finally{
  const requests=app?await app.evaluate(()=>globalThis.galleryTestRequests||[]).catch(()=>[]):[];
  if(app)await app.close();
  const report={ok:errors.length===0,checks,errors,requests,boundary:'Native Electron built renderer with synthetic gallery IPC; external network blocked; no user profile or generation service used.'};
  fs.writeFileSync(path.join(evidence,'native-ui-report.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({ok:report.ok,checks:checks.length,errors,report:path.join(evidence,'native-ui-report.json')}));
  process.exitCode=errors.length?1:0;
 }
})();

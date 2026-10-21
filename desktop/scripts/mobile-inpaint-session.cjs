// Screenshot-led Electron audit controller. Actions intentionally use coordinates.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { _electron } = require('../.tmp/uiux-tools/node_modules/playwright-core');
const root = path.resolve(__dirname, '..');
const run = process.env.UIUX_RESUME === '1' ? fs.readFileSync(path.join(root,'.tmp/uiux-active.txt'),'utf8').trim() : path.join(root, '.tmp', 'uiux-' + Date.now());
if (!path.resolve(run).startsWith(path.join(root,'.tmp') + path.sep)) throw Error('Run must stay inside desktop/.tmp');
const evidence = path.resolve(root, process.env.UIUX_EVIDENCE || '../docs/evidence/uiux-20261020');
if (!evidence.startsWith(path.resolve(root, '../docs/evidence') + path.sep)) throw Error('Evidence must stay inside docs/evidence');
fs.mkdirSync(run, {recursive: true});
fs.mkdirSync(path.join(evidence, 'screenshots'), {recursive: true});
fs.writeFileSync(path.join(root, '.tmp/uiux-active.txt'), run);
const env = {...process.env};
for (const key of Object.keys(env)) if (/TOKEN|API.?KEY|SECRET|CREDENTIAL|PORTABLE_EXECUTABLE|ELECTRON_RUN_AS_NODE|VITE_DEV_SERVER_URL|NAI_UI_CAPTURE_PATH/i.test(key)) delete env[key];
for (const key of ['APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'TEMP', 'TMP', 'HOME']) {env[key] = path.join(run, key.toLowerCase()); fs.mkdirSync(env[key], {recursive: true});}
env.WORLDPAINTER_DATA_DIR = env.NAI_UI_CAPTURE_USER_DATA = path.join(run, 'profile');
env.UIUX_AUDIT_ROOT = run;
env.HTTP_PROXY = env.HTTPS_PROXY = env.ALL_PROXY = 'http://127.0.0.1:9';
env.NO_PROXY = 'localhost,127.0.0.1';
let mockEnabled=false;
let application, page, windowHandle, selectedFixture, seq = fs.readdirSync(path.join(evidence,'screenshots')).reduce((n,f)=>Math.max(n,Number(f.split('-')[0])||0),0);
const log = fs.existsSync(path.join(evidence,'actions.json')) ? JSON.parse(fs.readFileSync(path.join(evidence,'actions.json'),'utf8')) : [];
async function snap(label) {
  if(mockEnabled)await page.evaluate(()=>{
    if(document.getElementById('mobile-inpaint-mock-badge'))return;
    const el=document.createElement('div');el.id='mobile-inpaint-mock-badge';
    el.textContent='合成测试 · IPC MOCK · 无真实生图 / 收费';
    Object.assign(el.style,{position:'fixed',right:'12px',bottom:'27px',zIndex:'99999',padding:'5px 9px',background:'#163a52',color:'#fff',font:'11px sans-serif',border:'1px solid #85caef',borderRadius:'5px',pointerEvents:'none'});
    document.body.appendChild(el);
  });
  await page.waitForTimeout(1200);
  const file = `${String(++seq).padStart(3, '0')}-${label.replace(/[^a-z0-9-]/gi, '-')}.png`;
  const capture = await windowHandle.evaluate(async win => { const png = await win.webContents.capturePage(); return {png:png.toPNG().toString('base64'), pixels:png.getSize(), bounds:win.getBounds(), contentBounds:win.getContentBounds()}; });
  fs.writeFileSync(path.join(evidence, 'screenshots', file), Buffer.from(capture.png,'base64'));
  delete capture.png;
  return {file,...capture,viewport:await page.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio}))};
}
async function action(command) {
  let checks;
  await windowHandle.evaluate(win=>{if(win.isMinimized()){win.restore();win.show();win.focus();}});
  await page.waitForTimeout(150);
  switch (command.action) {
    case 'click': await page.mouse.click(command.x, command.y, {button: command.button || 'left', clickCount: command.count || 1}); break;
    case 'type': await page.keyboard.insertText(command.text); break;
    case 'key': await page.keyboard.press(command.key); break;
    case 'wheel': await page.mouse.move(command.x, command.y); await page.mouse.wheel(command.dx || 0, command.dy); break;
    case 'drag': await page.mouse.move(command.points[0][0], command.points[0][1]); await page.mouse.down(); for (const [x,y] of command.points.slice(1)) await page.mouse.move(x,y,{steps:8}); await page.mouse.up(); break;
    case 'resize': await windowHandle.evaluate((win,size)=>{if(win.isMaximized())win.unmaximize();win.setContentSize(size.width,size.height);},command); break;
    case 'dialog-fixture': {
      const file=path.resolve(command.path); if (!file.startsWith(path.join(root,'.tmp') + path.sep)) throw Error('Only synthetic fixture files allowed');
      selectedFixture=file;
      await application.evaluate(({dialog}, file) => {dialog.showOpenDialog = async () => ({canceled:false,filePaths:[file]});},file); break;
    }
        case 'inspect-mobile': {
      checks=await page.evaluate(()=>{
        const bounds=el=>{if(!el)return null;const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};
        return {viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},theme:document.documentElement.className,
          status:document.querySelector('.mobile-inpaint-status')?.textContent,
          error:document.querySelector('.mobile-inpaint-error')?.textContent,
          layers:[...document.querySelectorAll('.mobile-inpaint-layer')].map(el=>el.textContent),
          inputs:[...document.querySelectorAll('.mobile-inpaint-panel input')].map(el=>({label:el.getAttribute('aria-label'),value:el.value,min:el.min,max:el.max})),
          candidates:document.querySelectorAll('.mobile-inpaint-candidate-list button').length,
          reviewOpen:Boolean(document.querySelector('.mobile-inpaint-review')),
          stage:bounds(document.querySelector('.mobile-inpaint-stage')),
          legacySource:document.querySelector('.inpaint-base-img')?.getAttribute('src'),
          legacyMask:document.querySelector('.inpaint-mask-canvas')?.toDataURL(),
          controls:[...document.querySelectorAll('.inpaint-mode-switch button,.mobile-inpaint-workspace button,.mobile-inpaint-panel button,.mobile-inpaint-run button')].filter(el=>el.getClientRects().length).map(el=>({text:el.textContent,aria:el.getAttribute('aria-label'),disabled:el.disabled,bounds:bounds(el)}))};
      });
      if(checks.legacyMask){checks.legacyMaskHash=require('node:crypto').createHash('sha256').update(checks.legacyMask).digest('hex');delete checks.legacyMask;}
      break;
    }
    case 'ui-click': await page.getByRole(command.role||'button',{name:command.name,exact:true}).click();break;
    case 'ui-fill': await page.getByLabel(command.name,{exact:true}).fill(command.value);break;
    case 'ui-select': await page.getByLabel(command.name,{exact:true}).selectOption(command.value);break;
    case 'zoom': await windowHandle.evaluate((win,zoom)=>win.webContents.setZoomFactor(zoom),command.factor);break;
    case 'reload': await page.reload();await page.waitForTimeout(1800);break;
    case 'save-dialog-fixture': {
      const file=path.resolve(command.path);if(!file.startsWith(path.join(root,'.tmp')+path.sep))throw Error('Synthetic save only');
      await application.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},file);break;
    }
    case 'mock-inpaint': {
      mockEnabled=true;
      await application.evaluate(({ipcMain},input)=>{
        const require=process.getBuiltinModule('node:module').createRequire(input.root+'/package.json');
        const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
        const {PNG}=require(path.join(input.root,'node_modules/pngjs'));
        globalThis.mobileMockMode=input.mode||'success';
        globalThis.mobileMockCount=globalThis.mobileMockCount||0;
        for(const channel of ['nai:hasToken','nai:accountCached','nai:quoteAnlas','nai:mobileInpaint'])ipcMain.removeHandler(channel);
        const account={hasToken:true,anlasBalance:100000,hasActiveSubscription:true};
        ipcMain.handle('nai:hasToken',()=>account);ipcMain.handle('nai:accountCached',()=>account);
        ipcMain.handle('nai:quoteAnlas',()=>({ok:true,amount:0,source:'local-estimate',balance:100000,insufficient:false,message:'MOCK ONLY / no paid request'}));
        ipcMain.handle('nai:mobileInpaint',async(_event,request)=>{
          const count=++globalThis.mobileMockCount;
          const image=Buffer.from(request.imageBase64,'base64'),mask=Buffer.from(request.maskBase64,'base64');
          const logFile=path.join(input.evidence,'mock-requests.json');
          const log=fs.existsSync(logFile)?JSON.parse(fs.readFileSync(logFile,'utf8')):[];
          log.push({count,mode:globalThis.mobileMockMode,params:request.params,model:request.model,strength:request.strength,imageHash:crypto.createHash('sha256').update(image).digest('hex'),maskHash:crypto.createHash('sha256').update(mask).digest('hex'),note:'IPC replaced by explicit mock; no provider, token, or network request'});
          fs.writeFileSync(logFile,JSON.stringify(log,null,2));
          fs.writeFileSync(path.join(input.evidence,`mock-${count}-input.png`),image);fs.writeFileSync(path.join(input.evidence,`mock-${count}-mask.png`),mask);
          if(globalThis.mobileMockMode==='delay')await new Promise(resolve=>setTimeout(resolve,3500));
          if(globalThis.mobileMockMode==='failure')return {ok:false,items:[],message:'MOCK：合成失败，未重试。'};
          const png=PNG.sync.read(image);
          for(let y=0;y<png.height;y++)for(let x=0;x<png.width;x++){const i=(y*png.width+x)*4;png.data[i]=40+count*30;png.data[i+1]=80+Math.floor(x/png.width*90);png.data[i+2]=230;png.data[i+3]=255;}
          const generated=PNG.sync.write(png),filePath=path.join(input.run,`mock-candidate-${count}.png`);fs.writeFileSync(filePath,generated);
          return {ok:true,message:'MOCK候选已返回（未调用真实服务）',items:[{id:`mock-${count}`,filePath,fileUrl:'data:image/png;base64,'+generated.toString('base64'),date:'2026-10-21',actualSeed:4242+count,model:request.model,width:png.width,height:png.height}]};
        });
      },{root,run,evidence,mode:command.mode});
      break;
    }

    case 'snapshot': break;
    case 'generation-check': {
      checks=await page.evaluate(expected=>{
        const panel=document.querySelector('#generate-parameter-fields');
        const bar=document.querySelector('.generate-section-shortcuts');
        if(!panel||!bar)throw Error('Generation form is not open');
        const rect=el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right};};
        const buttons=[...bar.querySelectorAll('button')].map(el=>{const r=rect(el),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return{text:el.textContent,rect:r,inside:r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight,hit:el===hit||el.contains(hit)};});
        const focus=document.activeElement,pr=rect(panel),fr=focus?rect(focus):null;
        const section=focus?.closest('[data-generation-section="model"]')?'model':focus?.matches('.prompt-editor textarea')?'prompt':focus?.closest('.resolution-tier-picker')?'size':null;
        const visibleHeight=fr?Math.max(0,Math.min(fr.bottom,pr.bottom)-Math.max(fr.y,pr.y)):0;
        return{buttons,panel:pr,scrollTop:panel.scrollTop,section,expected,focused:focus?{tag:focus.tagName,rect:fr,value:'value'in focus?focus.value:null}:null,visibleHeight,theme:document.documentElement.classList.contains('theme-dark')?'dark':'light'};
      },command.expected||null);
      if(checks.buttons.length!==3||checks.buttons.some(b=>!b.inside||!b.hit))throw Error('Generation shortcut covered/outside viewport: '+JSON.stringify(checks));
      if(command.expected&&(checks.section!==command.expected||checks.visibleHeight<20))throw Error('Generation focus target is not reachable: '+JSON.stringify(checks));
      break;
    }
    // These assertions are used only after screenshot-led discovery. They
    // measure the discovered controls; they do not choose navigation targets.
    case 'provider-check': {
      checks=await page.evaluate(()=>{
        const root=document.querySelector('.agent-provider-settings');
        if(!root)throw Error('Provider editor is not open');
        const rect=(el)=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right};};
        const buttons=[...root.querySelectorAll('.agent-provider-actions button')].map(el=>{const r=rect(el),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return{text:el.textContent,rect:r,inside:r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight,hit:hit===el||el.contains(hit)};});
        const fields=root.querySelector('.agent-provider-layout');
        return{buttons,fields:rect(fields),scrollTop:fields.scrollTop,scrollHeight:fields.scrollHeight,clientHeight:fields.clientHeight};
      });
      if(!checks.buttons.length||checks.buttons.some(b=>!b.inside||!b.hit))throw Error('Provider action is outside viewport or covered: '+JSON.stringify(checks));
      break;
    }
    case 'close': await application.close(); return {closed:true};
    default: throw Error('Unknown action');
  }
  return {screenshot: await snap(command.label || command.action),...(checks?{checks}:{})};
}
(async () => {
  application=await _electron.launch({executablePath: require('electron'), args:[path.join(__dirname,process.env.UIUX_PROTOTYPE==='1'?'uiux-prototype-entry.cjs':'uiux-offline-entry.cjs'),'--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'],cwd:root,env,timeout:45000});
  page=await application.firstWindow();
  windowHandle=await application.browserWindow(page);
  page.on('filechooser', async chooser => {await chooser.setFiles(selectedFixture ? [selectedFixture] : []);});
  // Prevent occlusion/background throttling from returning a previous compositor frame.
  // This does not establish a performance or physical-pointer acceptance result.
  await windowHandle.evaluate(win=>{win.webContents.setBackgroundThrottling(false);win.show();win.focus();});
  page.on('pageerror', e => fs.appendFileSync(path.join(evidence,'renderer-errors.txt'), e.stack+'\n'));
  await page.waitForTimeout(4500);
  const metadata=await application.evaluate(({app,screen})=>({electron:process.versions.electron,chrome:process.versions.chrome,node:process.versions.node,platform:process.platform,arch:process.arch,userData:app.getPath('userData'),display:screen.getPrimaryDisplay()}));
  fs.writeFileSync(path.join(evidence,'runtime.json'),JSON.stringify({run,metadata,os:os.release(),prototype:process.env.UIUX_PROTOTYPE==='1',automation:'Playwright Electron; visible BrowserWindow; coordinate and accessibility controls; isolated network guard; no capture fixture query'},null,2));
  console.log(JSON.stringify({ready:true,run,...await action({action:'snapshot',label:'cold-start'})}));
  while (true) {
    await new Promise(r=>setTimeout(r,250));
    const request=path.join(run,'request.json');
    if (!fs.existsSync(request)) continue;
    const command=JSON.parse(fs.readFileSync(request,'utf8').replace(/^\uFEFF/,'')); fs.unlinkSync(request);
    try {const result=await action(command);log.push({at:new Date().toISOString(),...command,...result});fs.writeFileSync(path.join(evidence,'actions.json'),JSON.stringify(log,null,2));fs.writeFileSync(path.join(run,'response.json'),JSON.stringify(result));console.log(JSON.stringify(result)); if(result.closed)break;}
    catch(e){const result={error:e.message};log.push({at:new Date().toISOString(),...command,...result});fs.writeFileSync(path.join(evidence,'actions.json'),JSON.stringify(log,null,2));fs.writeFileSync(path.join(run,'response.json'),JSON.stringify(result));console.log(JSON.stringify(result));}
  }
})().catch(async e=>{console.error(e.stack);await application?.close();process.exit(1)});

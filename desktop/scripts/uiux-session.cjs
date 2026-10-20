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
let application, page, windowHandle, selectedFixture, seq = fs.readdirSync(path.join(evidence,'screenshots')).reduce((n,f)=>Math.max(n,Number(f.split('-')[0])||0),0);
const log = fs.existsSync(path.join(evidence,'actions.json')) ? JSON.parse(fs.readFileSync(path.join(evidence,'actions.json'),'utf8')) : [];
async function snap(label) {
  await page.waitForTimeout(1200);
  const file = `${String(++seq).padStart(3, '0')}-${label.replace(/[^a-z0-9-]/gi, '-')}.png`;
  const capture = await windowHandle.evaluate(async win => { const png = await win.webContents.capturePage(); return {png:png.toPNG().toString('base64'), pixels:png.getSize(), bounds:win.getBounds(), contentBounds:win.getContentBounds()}; });
  fs.writeFileSync(path.join(evidence, 'screenshots', file), Buffer.from(capture.png,'base64'));
  delete capture.png;
  return {file,...capture,viewport:await page.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio}))};
}
async function action(command) {
  let checks;
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
    case 'snapshot': break;
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
  fs.writeFileSync(path.join(evidence,'runtime.json'),JSON.stringify({run,metadata,os:os.release(),prototype:process.env.UIUX_PROTOTYPE==='1',automation:'Playwright Electron; visible BrowserWindow; coordinate discovery; isolated network guard; no capture fixture query'},null,2));
  console.log(JSON.stringify({ready:true,run,...await action({action:'snapshot',label:'cold-start'})}));
  while (true) {
    await new Promise(r=>setTimeout(r,250));
    const request=path.join(run,'request.json');
    if (!fs.existsSync(request)) continue;
    const command=JSON.parse(fs.readFileSync(request,'utf8').replace(/^\uFEFF/,'')); fs.unlinkSync(request);
    try {const result=await action(command);log.push({at:new Date().toISOString(),...command,...result});fs.writeFileSync(path.join(evidence,'actions.json'),JSON.stringify(log,null,2));fs.writeFileSync(path.join(run,'response.json'),JSON.stringify(result));console.log(JSON.stringify(result)); if(result.closed)break;}
    catch(e){const result={error:e.message};fs.writeFileSync(path.join(run,'response.json'),JSON.stringify(result));console.log(JSON.stringify(result));}
  }
})().catch(async e=>{console.error(e.stack);await application?.close();process.exit(1)});

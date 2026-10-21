// Launch this development checkout with its own persistent application data.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const desktop=path.resolve(__dirname,'..'),project=path.dirname(desktop);
function configuration(smoke=false){
 const executablePath=path.join(desktop,'node_modules/electron/dist/electron.exe');
 for(const file of [executablePath,path.join(desktop,'dist/index.html'),path.join(desktop,'dist-electron/electron/bootstrap.js')])if(!fs.existsSync(file))throw Error('Missing development dependency/build: '+file+'; install dependencies and run npm run build inside desktop.');
 const dataRoot=path.join(desktop,'.tmp',smoke?'launcher-smoke-'+crypto.randomUUID():'dot-uiux-app');
 fs.mkdirSync(dataRoot,{recursive:true});
 const env={...process.env};
 for(const key of Object.keys(env))if(/TOKEN|API.?KEY|SECRET|CREDENTIAL|^NAI_UI_CAPTURE_|^UIUX_|^PORTABLE_EXECUTABLE|^VITE_DEV_SERVER_URL$|^ELECTRON_RUN_AS_NODE$|^NODE_OPTIONS$|^NODE_EXTRA_CA_CERTS$|^(?:HTTP|HTTPS|ALL|NO)_PROXY$/i.test(key))delete env[key];
 for(const key of ['APPDATA','LOCALAPPDATA','USERPROFILE','HOME','TEMP','TMP']){env[key]=path.join(dataRoot,key.toLowerCase());fs.mkdirSync(env[key],{recursive:true});}
 env.WORLDPAINTER_DATA_DIR=env.NAI_UI_CAPTURE_USER_DATA=path.join(dataRoot,'profile');
 const args=[desktop];
 if(smoke){env.HTTP_PROXY=env.HTTPS_PROXY=env.ALL_PROXY='http://127.0.0.1:9';env.NO_PROXY='localhost,127.0.0.1';args.push('--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1');}
 return {launch:{executablePath,args,cwd:desktop,env},dataRoot};
}
async function smoke(){
 const {launch,dataRoot}=configuration(true),{_electron}=require(path.join(desktop,'.tmp/uiux-tools/node_modules/playwright-core'));
 const proof=path.join(project,'.tmp/migration-20261021');fs.mkdirSync(proof,{recursive:true});
 const report={at:new Date().toISOString(),launcher:path.join(project,'启动绘世-A分支.cmd'),dataRoot,realModelCalls:0};let app;
 try{
  app=await _electron.launch({...launch,timeout:45000});const page=await app.firstWindow(),win=await app.browserWindow(page);
  await win.evaluate(w=>{w.setContentSize(1440,900);w.webContents.setZoomFactor(1);w.webContents.setBackgroundThrottling(false);w.show();w.focus();});await page.waitForTimeout(4500);
  report.runtime=await app.evaluate(({app})=>({exe:process.execPath,cwd:process.cwd(),appPath:app.getAppPath(),userData:app.getPath('userData'),electron:process.versions.electron}));
  if(path.resolve(report.runtime.appPath)!==desktop||path.resolve(report.runtime.userData)!==path.join(dataRoot,'profile')||!path.resolve(report.runtime.exe).startsWith(desktop+path.sep))throw Error('Launcher used an unexpected application or data path');
  if(await page.locator('.onboarding-top button').count())await page.locator('.onboarding-top button').click();
  await page.mouse.click(162,108);await page.getByRole('button',{name:'新模式 · 手机端',exact:true}).click();
  report.account=await page.evaluate(async()=>({hasToken:(await window.naiDesktop.hasToken()).hasToken}));if(report.account.hasToken)throw Error('Fresh launcher smoke profile unexpectedly has credentials');
  report.viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio}));
  await page.waitForTimeout(500);const png=await win.evaluate(async w=>(await w.webContents.capturePage()).toPNG().toString('base64'));fs.writeFileSync(path.join(proof,'launcher-smoke.png'),Buffer.from(png,'base64'));
  report.passed=true;
 }catch(error){report.passed=false;report.error=error.stack||String(error);process.exitCode=1;}
 finally{if(app){await app.close();report.closedOwnInstance=true;}fs.writeFileSync(path.join(proof,'launcher-smoke.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
}
function start(){
 const {launch,dataRoot}=configuration();const child=spawn(launch.executablePath,launch.args,{cwd:launch.cwd,env:launch.env,detached:true,stdio:'ignore',windowsHide:false});
 child.once('error',error=>{console.error(error.message);process.exitCode=1;});child.once('spawn',()=>{const record={at:new Date().toISOString(),pid:child.pid,executable:launch.executablePath,cwd:launch.cwd,dataRoot,userData:launch.env.WORLDPAINTER_DATA_DIR};fs.writeFileSync(path.join(dataRoot,'last-launch.json'),JSON.stringify(record,null,2));child.unref();console.log('Started this checkout. Isolated application data: '+dataRoot);});
}
module.exports={configuration};
if(require.main===module){try{if(process.argv.includes('--smoke'))void smoke();else start();}catch(error){console.error(error.message);process.exitCode=1;}}

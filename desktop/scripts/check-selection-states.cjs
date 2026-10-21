const fs=require('node:fs'),path=require('node:path');
const desktop=path.resolve(__dirname,'..');
const {_electron}=require(path.resolve(desktop,'..','..','dot-uiux','desktop','.tmp','uiux-tools','node_modules','playwright-core'));
const run=path.join(desktop,'.tmp','selection-state-'+new Date().toISOString().replace(/[:.]/g,'-'));fs.mkdirSync(run,{recursive:true});
const env={...process.env};
for(const key of Object.keys(env))if(/TOKEN|API.?KEY|SECRET|CREDENTIAL|PORTABLE_EXECUTABLE|ELECTRON_RUN_AS_NODE|VITE_DEV_SERVER_URL|NAI_UI_CAPTURE/i.test(key))delete env[key];
env.WORLDPAINTER_DATA_DIR=path.join(run,'profile');env.NAI_UI_CAPTURE_USER_DATA=env.WORLDPAINTER_DATA_DIR;env.UIUX_AUDIT_ROOT=run;
env.HTTP_PROXY=env.HTTPS_PROXY=env.ALL_PROXY='http://127.0.0.1:9';env.NO_PROXY='localhost,127.0.0.1';
let app,page,win;const report={isolatedProfile:env.WORLDPAINTER_DATA_DIR,networkBlocked:true,paidRequests:0,groups:[],errors:[]};
async function group(label,selector){
 const value=await page.locator(selector).first().evaluate(node=>({
  buttons:[...node.querySelectorAll('button')].map(button=>{const css=getComputedStyle(button);return {text:button.textContent.trim(),className:button.className,pressed:button.getAttribute('aria-pressed'),background:css.backgroundColor,color:css.color,border:css.borderTopColor}}),
 }));
 const selected=value.buttons.filter(button=>button.pressed==='true');
 if(selected.length!==1)throw Error(label+': expected one selected button');
 const unselected=value.buttons.filter(button=>button.pressed==='false');
 if(!unselected.length||unselected.some(button=>button.background===selected[0].background&&button.color===selected[0].color))throw Error(label+': selected state is indistinguishable');
 report.groups.push({label,theme:await page.evaluate(()=>document.documentElement.className),...value});
}
async function shot(name){const frame=await win.evaluate(async w=>(await w.webContents.capturePage()).toPNG().toString('base64'));fs.writeFileSync(path.join(run,name),Buffer.from(frame,'base64'));}
(async()=>{try{
 app=await _electron.launch({executablePath:require(path.join(desktop,'node_modules','electron')),args:[path.join(desktop,'scripts','uiux-offline-entry.cjs')],cwd:desktop,env,timeout:45000});
 page=await app.firstWindow();win=await app.browserWindow(page);page.setDefaultTimeout(10000);
 await win.evaluate(w=>{if(w.isMaximized())w.unmaximize();w.setContentSize(1440,950);w.webContents.setBackgroundThrottling(false);});
 await page.waitForTimeout(1800);
 const onboarding=page.locator('.onboarding');if(await onboarding.count())await onboarding.getByRole('button').first().click();
 const notice=page.locator('.v5-migration-notice');if(await notice.count())await notice.getByRole('button').first().click();
 await page.locator('.tab-bar [data-tab="inpaint"]').click();await page.getByRole('button',{name:'旧模式',exact:true}).click();
 await page.evaluate(()=>document.documentElement.classList.add('theme-dark'));await page.mouse.move(1,1);await page.waitForTimeout(300);
 const source='.i2i-source-policy';const engine='.mode-buttons[aria-label="重绘引擎"]';
 await group('inpaint-source-initial',source);await group('inpaint-engine-initial',engine);await shot('inpaint-dark.png');
 await page.locator(source).getByRole('button',{name:'使用最新结果',exact:true}).click();await page.mouse.move(1,1);await page.waitForTimeout(300);await group('inpaint-source-after-latest',source);
 await page.locator(engine).getByRole('button',{name:'OpenAI 图像编辑',exact:true}).click();await page.mouse.move(1,1);await page.waitForTimeout(500);await group('inpaint-engine-after-openai',engine);
 await page.evaluate(()=>document.documentElement.classList.remove('theme-dark'));await page.waitForTimeout(250);await group('inpaint-source-light',source);await group('inpaint-engine-light',engine);
 await page.locator('.tab-bar [data-tab="postprocess"]').click();await page.locator('.scale-buttons').first().waitFor();
 await page.evaluate(()=>document.documentElement.classList.add('theme-dark'));await page.waitForTimeout(250);await group('postprocess-scale-initial','.scale-buttons');
 await page.locator('.scale-buttons').first().getByRole('button',{name:'4×',exact:true}).click();await page.mouse.move(1,1);await page.waitForTimeout(250);await group('postprocess-scale-after-4x','.scale-buttons');await shot('postprocess-dark.png');
 await page.evaluate(()=>document.documentElement.classList.remove('theme-dark'));await page.waitForTimeout(250);await group('postprocess-scale-light','.scale-buttons');
 }catch(error){report.errors.push(error.stack||String(error));try{await shot('failure.png');}catch{}}
 finally{if(app)await app.close();fs.writeFileSync(path.join(run,'report.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));if(report.errors.length)process.exitCode=1;}
})();

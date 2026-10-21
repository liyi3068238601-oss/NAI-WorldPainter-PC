const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path');
const source=process.env.POINTER_SOURCE||path.resolve(__dirname,'..');
const output=process.env.POINTER_OUTPUT||fs.mkdtempSync(path.join(require('node:os').tmpdir(),'mobile-pointer-'));
app.setPath('userData',path.join(output,'profile'));app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
 const watchdog=setTimeout(()=>{console.error('MOBILE_POINTER_WATCHDOG');app.exit(2)},20000);
 const win=new BrowserWindow({show:false,width:900,height:720,webPreferences:{nodeIntegration:true,contextIsolation:false,sandbox:false,backgroundThrottling:false,offscreen:true}});
 await win.loadFile(path.join(__dirname,'mobile-inpaint-pointer-fixture.html'));
 const wait=()=>new Promise(resolve=>setTimeout(resolve,65)),js=code=>win.webContents.executeJavaScript(code);
 for(let i=0;i<100&&!(await js('Boolean(window.fixtureReady)'));i++)await wait();
 if(!(await js('Boolean(window.fixtureReady)')))throw Error('Mobile fixture did not initialize');
 win.webContents.focus();win.webContents.debugger.attach('1.3');
 const rect=await js('(()=>{const r=document.querySelector(".mobile-inpaint-stage").getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})()');
 const x=Math.round(rect.x+140),y=Math.round(rect.y+100),snap=()=>js('window.pointerSnapshot()');let pressed=null;
 async function input(type,xx=x,yy=y,button='left'){
  if(type==='mouseDown')pressed=button;if(type==='mouseUp')pressed=null;
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:{mouseMove:'mouseMoved',mouseDown:'mousePressed',mouseUp:'mouseReleased'}[type],x:xx,y:yy,button:type==='mouseMove'?(pressed||'none'):button,buttons:pressed==='left'?1:pressed==='middle'?4:0,clickCount:type==='mouseMove'?0:1});await wait();
 }
 const checks=[],check=(name,pass)=>checks.push({name,pass:!!pass}),same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
 const initial=await snap();await input('mouseDown');await input('mouseMove',x+45,y+20);let s=await snap();check('held frame drag changes its position',!same(initial.frame,s.frame)&&s.captured);
 await input('mouseUp',x+45,y+20);const released=await snap();await input('mouseMove',45,50);await input('mouseDown',45,50);await input('mouseUp',45,50);await win.webContents.debugger.sendCommand('Input.insertText',{text:'synthetic prompt'});await wait();s=await snap();check('moving to and typing in left prompt leaves frame unchanged',same(released.frame,s.frame)&&!s.captured);
 await input('mouseMove');await input('mouseDown');await input('mouseMove',x+15,y+12);const beforeHover=await snap();await js('window.releaseByHover()');await wait();s=await snap();check('zero-button hover terminates stale frame capture without moving or snapping',same(beforeHover.frame,s.frame)&&!s.captured);
 await input('mouseUp',x+15,y+12);await input('mouseMove',x+140,y+80);s=await snap();check('later hover cannot resume the terminated pan',same(beforeHover.frame,s.frame));
 await js('window.setPointerTool("brush")');await wait();const beforeStroke=await snap();await input('mouseDown');await input('mouseMove',x+25,y+15);await js('window.releaseByHover()');await wait();s=await snap();check('zero-button brush cleanup commits the existing stroke once',s.strokes===beforeStroke.strokes+1&&!s.captured);await input('mouseUp',x+25,y+15);await input('mouseMove',x+60,y+40);check('hover after brush cleanup adds no further stroke',(await snap()).strokes===s.strokes);
 await js('window.setPointerTool("image")');await wait();await input('mouseDown',x,y,'middle');await input('mouseMove',x+25,y+10,'middle');await input('mouseUp',x+25,y+10,'middle');const middleReleased=await snap();await input('mouseMove',40,50);s=await snap();check('released middle-button global pan stays fixed over the left panel',same(middleReleased.frame,s.frame)&&same(middleReleased.transform,s.transform)&&!s.captured);
 const result={checks,passed:checks.filter(c=>c.pass).length,total:checks.length,automation:'Electron CDP with the real MobileInpaintCanvas and store; explicit synthetic zero-button capture loss',physicalPointerTested:false,realPaidCalls:false};
 fs.writeFileSync(path.join(output,'RESULT.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));clearTimeout(watchdog);win.destroy();app.exit(result.passed===result.total?0:1);
}).catch(error=>{console.error(error.stack);app.exit(2)});

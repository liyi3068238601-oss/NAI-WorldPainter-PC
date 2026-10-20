// Standalone layout comparison only. No product bootstrap or preload is loaded.
const {app,BrowserWindow,session}=require('electron');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const auditRoot=path.resolve(process.env.UIUX_AUDIT_ROOT||'');
if(!auditRoot.startsWith(path.join(root,'.tmp')+path.sep))throw Error('Isolated audit root required');
app.setPath('userData',path.join(auditRoot,'profile'));
app.whenReady().then(()=>{
  session.defaultSession.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!['file:','data:','blob:'].some(s=>details.url.startsWith(s))}));
  const win=new BrowserWindow({width:1280,height:720,show:true,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}});
  win.loadFile(path.resolve(root,'../docs/prototypes/uiux-20261020/workbench.html'));
});
app.on('window-all-closed',()=>app.quit());

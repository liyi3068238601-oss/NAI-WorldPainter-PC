// Send one coordinate audit action, waiting for its completed capture.
const fs=require('node:fs'), path=require('node:path');
const run=fs.readFileSync(path.resolve(__dirname,'../.tmp/uiux-active.txt'),'utf8').trim();
const request=path.join(run,'request.json'), response=path.join(run,'response.json');
if(fs.existsSync(request))throw Error('Previous action still pending');
fs.rmSync(response,{force:true});
fs.writeFileSync(request,process.argv[2]);
const started=Date.now();
const timer=setInterval(()=>{
  if(fs.existsSync(response)){clearInterval(timer);process.stdout.write(fs.readFileSync(response,'utf8'));}
  else if(Date.now()-started>30000){clearInterval(timer);process.exitCode=1;console.error('Action outcome uncertain: inspect controller before sending another action');}
},200);

// Sequential commands for this task's isolated visible Electron controller.
// Stop on the first error; a failed/uncertain action must be inspected first.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const run=fs.readFileSync(path.join(root,'.tmp/uiux-active.txt'),'utf8').trim();
if(!path.resolve(run).startsWith(path.join(root,'.tmp')+path.sep))throw Error('Isolated run required');
const request=path.join(run,'request.json'),response=path.join(run,'response.json');
const input=process.argv[2];
const commands=JSON.parse(input.startsWith('[')||input.startsWith('{')?input:fs.readFileSync(input,'utf8'));
(async()=>{
 for(const command of Array.isArray(commands)?commands:[commands]){
  if(fs.existsSync(request))throw Error('Previous action still pending; inspect controller');
  fs.rmSync(response,{force:true});fs.writeFileSync(request,JSON.stringify(command));
  const start=Date.now();
  while(!fs.existsSync(response)){
   if(Date.now()-start>40000)throw Error('Outcome uncertain; inspect controller before another action');
   await new Promise(r=>setTimeout(r,150));
  }
  const result=JSON.parse(fs.readFileSync(response,'utf8'));
  console.log(JSON.stringify({label:command.label,...result}));
  if(result.error)throw Error('Controller action failed; sequence stopped');
 }
})().catch(error=>{console.error(error.message);process.exitCode=1;});

// All pixels and prompt values are synthetic. No model invocation.
const fs=require('node:fs'); const path=require('node:path'); const sharp=require('sharp');
const {createHash}=require('node:crypto');
const dir=path.resolve(__dirname,'../.tmp/uiux-fixtures');fs.mkdirSync(dir,{recursive:true});
function crc(buf){let c=0xffffffff;for(const b of buf){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
function textChunk(key,value){const type=Buffer.from('tEXt');const data=Buffer.from(key+'\0'+value,'latin1');const n=Buffer.alloc(4),check=Buffer.alloc(4);n.writeUInt32BE(data.length);check.writeUInt32BE(crc(Buffer.concat([type,data])));return Buffer.concat([n,type,data,check]);}
(async()=>{
const svg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="512" height="768"><rect width="512" height="768" fill="#e8dcc2"/><rect x="80" y="80" width="352" height="352" rx="32" fill="#385a8c"/><circle cx="256" cy="256" r="95" fill="#f5d57a"/><text x="64" y="550" font-size="36" fill="#172033">UIUX FIXTURE</text></svg>');
const bytes=await sharp(svg).png().toBuffer();
const params={prompt:'uiux_fixture, blue square',uc:'uiux_fixture_negative',seed:424242,steps:28,scale:5,width:512,height:768,sampler:'k_euler_ancestral'};
const fields={Software:'NovelAI',Source:'NovelAI Diffusion V4.5',Description:params.prompt,Comment:JSON.stringify(params)};
const result=Buffer.concat([bytes.subarray(0,bytes.length-12),...Object.entries(fields).map(([k,v])=>textChunk(k,v)),bytes.subarray(bytes.length-12)]);
fs.writeFileSync(path.join(dir,'metadata-fixture.png'),result);
fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify({synthetic:true,sha256:createHash('sha256').update(result).digest('hex'),bytes:result.length,fields},null,2));console.log(path.join(dir,'metadata-fixture.png'));
})().catch(e=>{console.error(e);process.exit(1)});

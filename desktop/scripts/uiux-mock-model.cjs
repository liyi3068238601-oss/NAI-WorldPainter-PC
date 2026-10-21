// Loopback-only model transport fixture. No outbound client and no paid service.
const http=require('node:http'), fs=require('node:fs'),path=require('node:path');
const output=path.resolve(__dirname,'../../docs/evidence/uiux-20261020/mock-model.json');
const requests=[];let proposalStage=0;
const server=http.createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{
  let data;try{data=JSON.parse(body||'{}')}catch{res.writeHead(400);return res.end('{}')}
  if(req.url.endsWith('/models')){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({object:'list',data:[{id:'uiux-offline',object:'model',owned_by:'local-fixture'},{id:'uiux-alternate',object:'model',owned_by:'local-fixture'}]}))}
  const tools=(data.tools||[]).map(t=>t.function||t);requests.push({path:req.url,model:data.model,stream:data.stream,tools:tools.map(t=>({name:t.name,parameters:t.parameters})),messageCount:data.messages?.length||0});fs.writeFileSync(output,JSON.stringify({loopbackOnly:true,requests},null,2));
  const text='离线模拟回复：已收到你的合成测试内容。本次没有调用外部模型，也没有执行生图。';
  let call;
  if(JSON.stringify(data.messages).includes('UIUX_CONFIRM')){
    if(proposalStage===0){proposalStage=1;call={name:'langbai_prepare_generation',arguments:JSON.stringify({args:{positivePrompt:'uiux_fixture, geometric blue square',count:1,model:'nai-diffusion-4-5-full',width:512,height:768}})};}
    else if(proposalStage===1){const results=(data.messages||[]).filter(m=>m.role==='tool').map(m=>m.content).join('\n');const match=results.match(/"preparationId"\s*:\s*"([a-z0-9-]+)"/i);proposalStage=2;if(match)call={name:'langbai_generate_image',arguments:JSON.stringify({args:{preparationId:match[1]}})};}
  }
  if(data.stream){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});const deltas=call?[{role:'assistant'},{tool_calls:[{index:0,id:'call_uiux_'+proposalStage,type:'function',function:call}]},{}]:[{role:'assistant'},{content:text},{}];for(const delta of deltas)res.write('data: '+JSON.stringify({id:'uiux-fixture',object:'chat.completion.chunk',created:Math.floor(Date.now()/1000),model:data.model,choices:[{index:0,delta,finish_reason:Object.keys(delta).length?null:call?'tool_calls':'stop'}]})+'\n\n');res.end('data: [DONE]\n\n')}
  else {res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'uiux-fixture',object:'chat.completion',created:Math.floor(Date.now()/1000),model:data.model,choices:[{index:0,message:{role:'assistant',content:text},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}))}
})});server.listen(42377,'127.0.0.1',()=>console.log('UIUX mock model listening on http://127.0.0.1:42377/v1'));

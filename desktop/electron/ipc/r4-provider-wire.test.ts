import {createServer,type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {afterEach,it,expect,vi} from 'vitest';
import {runStudioPiAgent} from './pi-agent-core';
import {studioPiModel,studioPiStream} from './pi-agent-provider';
import {createR4PiToolSession} from './r4-pi-tools';
import {registry,validateR4Result} from '../../src/agent/r4-contracts';
import type {AppSettings} from '../../src/types';
vi.mock('./agent-tools',()=>({executeAgentTool:vi.fn()}));
vi.mock('./store',()=>({getSettings:()=>({proxyMode:'direct'})}));
const servers:Server[]=[];
afterEach(async()=>{await Promise.all(servers.splice(0).map(server=>new Promise<void>(resolve=>server.close(()=>resolve()))));});
const protocols=['openai-compatible','openai-responses','anthropic-messages','google-gemini'] as const;

function emitReply(protocol:typeof protocols[number],response:import('node:http').ServerResponse,call:boolean){
  response.writeHead(200,{'content-type':'text/event-stream'});
  const args={positivePrompt:'rainy bookshop',requestedSeedPolicy:'fixed'};
  const event=(type:string,values:object)=>response.write(`event: ${type}\ndata: ${JSON.stringify({type,...values})}\n\n`);
  if(protocol==='openai-compatible'){
    const delta=call?{tool_calls:[{index:0,id:'native-call-1',type:'function',function:{name:'prepare_generation',arguments:JSON.stringify(args)}}]}:{content:'input rejected'};
    response.write(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',model:'wire-model',choices:[{index:0,delta:{role:'assistant',...delta},finish_reason:null}]})}\n\n`);
    response.write(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',model:'wire-model',choices:[{index:0,delta:{},finish_reason:call?'tool_calls':'stop'}]})}\n\n`);response.end('data: [DONE]\n\n');return;
  }
  if(protocol==='google-gemini'){
    response.end(`data: ${JSON.stringify({candidates:[{content:{role:'model',parts:call?[{functionCall:{id:'native-call-1',name:'prepare_generation',args}}]:[{text:'input rejected'}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:1,candidatesTokenCount:1,totalTokenCount:2}})}\n\n`);return;
  }
  if(protocol==='anthropic-messages'){
    event('message_start',{message:{id:'message-fixture',type:'message',role:'assistant',model:'wire-model',content:[],stop_reason:null,usage:{input_tokens:1,output_tokens:0}}});
    event('content_block_start',{index:0,content_block:call?{type:'tool_use',id:'native-call-1',name:'prepare_generation',input:{}}:{type:'text',text:''}});
    event('content_block_delta',{index:0,delta:call?{type:'input_json_delta',partial_json:JSON.stringify(args)}:{type:'text_delta',text:'input rejected'}});
    event('content_block_stop',{index:0});event('message_delta',{delta:{stop_reason:call?'tool_use':'end_turn',stop_sequence:null},usage:{output_tokens:1}});event('message_stop',{});response.end();return;
  }
  const item=call?{id:'fc-fixture',type:'function_call',call_id:'native-call-1',name:'prepare_generation',arguments:JSON.stringify(args),status:'completed'}
    :{id:'msg-fixture',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'input rejected',annotations:[]}]};
  event('response.created',{response:{id:'resp-fixture',status:'in_progress',output:[]}});
  event('response.output_item.added',{output_index:0,item:call?{...item,arguments:'',status:'in_progress'}:{...item,content:[],status:'in_progress'}});
  if(call)event('response.function_call_arguments.delta',{output_index:0,item_id:item.id,delta:JSON.stringify(args)});
  else event('response.output_text.delta',{output_index:0,content_index:0,item_id:item.id,delta:'input rejected'});
  event('response.output_item.done',{output_index:0,item});
  event('response.completed',{response:{id:'resp-fixture',status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}});response.end();
}

it.each(protocols)('R4 flat schema and strict host preflight survive the actual %s HTTP/SDK path',async protocol=>{
  const bodies:any[]=[];
  const server=createServer(async(request,response)=>{let raw='';for await(const chunk of request)raw+=chunk;bodies.push(JSON.parse(raw));emitReply(protocol,response,bodies.length===1);});
  servers.push(server);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const invoke=vi.fn(),authorize=vi.fn(async()=>true);
  const scope={conversationId:'chat',creationId:'creation',userIntentRef:'intent',operationKey:'operation'};
  const session=createR4PiToolSession({host:{invoke} as any,coordinator:{} as any,scope,emit:()=>{},authorize,assertNoDispatchGate:()=>{},approvalMode:'confirm',webSearchEnabled:false,
    initialMounted:['prepare_generation'],adapterDependencies:()=>({}),capabilitySnapshot:()=>({catalogStatus:'ok',catalogVersion:'r4-wire',approvalMode:'confirm',available:[{group:'generation',toolNames:['prepare_generation'],capabilityKeys:registry.tools.find(tool=>tool.canonical==='prepare_generation')!.availability.requires}],mounted:['prepare_generation'],requestedGroups:[],requestedDenied:[],providerProjectionStatus:'host_only'})});
  const settings={agentApiProtocol:protocol,agentApiBaseUrl:`http://127.0.0.1:${(server.address() as AddressInfo).port}${protocol==='google-gemini'?'/v1beta':''}`,agentApiKey:'public-fixture-key',agentApiModel:protocol==='google-gemini'?'gemini-3.7-flash':'wire-model',agentContextWindow:128000,agentMaxOutputTokens:4096,agentVisionEnabled:false,proxyMode:'direct'} as AppSettings;
  const result=await runStudioPiAgent({model:studioPiModel(settings),streamFn:studioPiStream(settings),systemPrompt:session.systemPrompt,history:[],text:'fixture',tools:session.getTools(),getTools:session.getTools,beforeModelCall:session.beforeModelCall,authorize});
  expect(result.text).toBe('input rejected');expect(bodies).toHaveLength(2);expect(invoke).not.toHaveBeenCalled();expect(authorize).not.toHaveBeenCalled();
  const tool=protocol==='google-gemini'
    ?bodies[0].tools.flatMap((entry:any)=>entry.functionDeclarations??[]).find((entry:any)=>entry.name==='prepare_generation')
    :bodies[0].tools.find((entry:any)=>(entry.function?.name??entry.name)==='prepare_generation');
  const wireSchema=protocol==='openai-compatible'?tool.function.parameters:protocol==='openai-responses'?tool.parameters:protocol==='anthropic-messages'?tool.input_schema:tool.parametersJsonSchema;
  expect(wireSchema.properties).toHaveProperty('positivePrompt');expect(wireSchema.properties).not.toHaveProperty('args');
  const receipts=result.messages.filter(message=>message.role==='toolResult');expect(receipts).toHaveLength(1);
  const resultData=JSON.parse((receipts[0].content[0] as {text:string}).text);
  expect(resultData).toMatchObject({resultKind:'preflight_failure',status:'error'});expect(resultData).not.toHaveProperty('data');expect(validateR4Result('prepare_generation',resultData).valid).toBe(true);
});

it.each(protocols)('%s transport never automatically retries a failed billed model request',async protocol=>{
  let requests=0;const server=createServer(async(request,response)=>{for await(const _ of request){/* drain */}requests++;response.writeHead(503,{'content-type':'application/json'});response.end(JSON.stringify({error:{message:'fixture outage',type:'api_error'}}));});
  servers.push(server);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const settings={agentApiProtocol:protocol,agentApiBaseUrl:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,agentApiKey:'public-fixture-key',agentApiModel:protocol==='google-gemini'?'gemini-3.7-flash':'wire-model',agentContextWindow:128000,agentMaxOutputTokens:4096,agentVisionEnabled:false,proxyMode:'direct'} as AppSettings;
  await expect(runStudioPiAgent({model:studioPiModel(settings),streamFn:studioPiStream(settings),systemPrompt:'fixture',history:[],text:'fixture',tools:[],authorize:async()=>false})).rejects.toThrow();expect(requests).toBe(1);
});

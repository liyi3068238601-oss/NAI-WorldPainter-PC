// Loopback-only fixture for Windows provider switching. No external calls.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const root = path.resolve(__dirname, '..');
const profile = path.resolve(process.argv[2] || path.join(root, '.tmp', 'agent-providers-native'));
if (!profile.startsWith(path.join(root, '.tmp') + path.sep)) throw Error('Use a profile inside PC端/.tmp');
fs.mkdirSync(profile, {recursive:true});
if (fs.existsSync(path.join(profile, 'worldpainter-desktop.json'))) throw Error('Use a fresh synthetic fixture profile');
const eventsFile = path.join(profile, 'provider-events.jsonl');
const server = http.createServer(async (request, response) => {
  const provider = request.url.startsWith('/provider-b/') ? 'b' : request.url.startsWith('/provider-a/') ? 'a' : '';
  const expectedKey = `fixture-provider-${provider}`;
  const credentialMatched = !!provider && request.headers.authorization === `Bearer ${expectedKey}`;
  if (!credentialMatched) { response.writeHead(401); response.end('{"error":{"message":"Fixture credential mismatch"}}'); return; }
  if (request.method === 'GET' && request.url.endsWith('/models')) {
    fs.appendFileSync(eventsFile, JSON.stringify({kind:'models',provider,credentialMatched})+'\n');
    response.writeHead(200, {'content-type':'application/json'});
    response.end(JSON.stringify({object:'list',data:[{id:'shared-chat',object:'model'},{id:`provider-${provider}-vision`,object:'model',context_window:131072}]})); return;
  }
  if (request.method !== 'POST' || !request.url.endsWith('/chat/completions')) { response.writeHead(404); response.end(); return; }
  let raw = ''; for await (const chunk of request) {raw += chunk; if (raw.length > 2_000_000) {response.writeHead(413);response.end();return;}}
  let body; try {body=JSON.parse(raw);} catch {response.writeHead(400);response.end();return;}
  fs.appendFileSync(eventsFile, JSON.stringify({kind:'chat',provider,model:body.model,credentialMatched})+'\n');
  response.writeHead(200,{'content-type':'text/event-stream'});
  response.write(`data: ${JSON.stringify({id:'provider-fixture',choices:[{index:0,delta:{role:'assistant',content:`本地供应商 ${provider.toUpperCase()} 收到请求，模型 ${body.model}。未调用生图服务。`},finish_reason:null}]})}\n\n`);
  response.write(`data: ${JSON.stringify({id:'provider-fixture',choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}})}\n\n`);
  response.end('data: [DONE]\n\n');
});
server.listen(0,'127.0.0.1',()=>{
  const port = server.address().port;
  const settings = {language:'zh-CN',theme:'dark',proxyMode:'direct',proxyForAi:false,outputDir:path.join(profile,'images'),
    agentApiProtocol:'openai-compatible',agentApiBaseUrl:`http://127.0.0.1:${port}/provider-a/v1`,
    agentProviderName:'本地供应商 A',agentApiKey:'fixture-provider-a',agentApiModel:'shared-chat',
    agentContextWindow:128000,agentMaxOutputTokens:8192,agentVisionEnabled:false,
    agentUiPreferences:{resourcesOpen:false}};
  fs.writeFileSync(path.join(profile,'worldpainter-desktop.json'),JSON.stringify({settings,history:[],historyGroups:[],convertHistory:[],reverseHistory:[]}));
  fs.writeFileSync(path.join(profile,'fixture-server.json'),JSON.stringify({port,pid:process.pid,providerBUrl:`http://127.0.0.1:${port}/provider-b/v1`,externalRequests:0}));
});

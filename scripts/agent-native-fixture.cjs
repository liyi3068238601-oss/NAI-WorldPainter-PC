// Local-only Windows acceptance provider. It never calls an external service.
// Run with: node scripts/agent-native-fixture.cjs <profile directory>
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const profile = path.resolve(process.argv[2] || path.join(root, '.tmp', 'agent-native-v1'));
if (!profile.startsWith(path.join(root, '.tmp') + path.sep)) throw new Error('Use a fixture profile inside PC端/.tmp');
fs.mkdirSync(profile, { recursive: true });
let requests = 0;
const contentText = m => typeof m.content === 'string' ? m.content : (m.content || []).map(part => part.text || '').join('\n');
const server = http.createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(404); response.end(); return;
  }
  let raw = '';
  for await (const chunk of request) { raw += chunk; if (raw.length > 2_000_000) { response.writeHead(413); response.end(); return; } }
  const body = JSON.parse(raw);
  const messages = body.messages || [];
  const latestUser = messages.findLastIndex(m => m.role === 'user' && !contentText(m).startsWith('Application protocol notice:'));
  const fresh = messages.slice(latestUser + 1);
  const tools = fresh.filter(m => m.role === 'tool');
  const repaired = fresh.some(m => m.role === 'user' && contentText(m).startsWith('Application protocol notice:'));
  const roundTwo = contentText(messages[latestUser] || {}).includes('第二轮');
  let tool, args, text;
  if (roundTwo && !repaired) text = 'functions.langbai_apply_prompt({"positivePrompt":"1cat, window light"})';
  else if (!tools.length && !roundTwo) { tool = 'read_skill'; args = {skillId:'builtin-prompt-term-lookup'}; }
  else if (tools.length < 2 && !roundTwo) { tool = 'langbai_get_generation_state'; args = {}; }
  else if (!tools.some(m => /langbai_apply_prompt/.test(m.name || '') || String(m.content).includes('已应用'))) {
    // After the first apply result, the last assistant native call identifies it
    // even when an OpenAI provider does not include name on tool-result messages.
    const applied = fresh.some(m => (m.tool_calls || []).some(c => c.function.name === 'langbai_apply_prompt'));
    if (!applied) { tool = 'langbai_apply_prompt'; args = {positivePrompt:roundTwo?'1cat, window light':'1cat, watercolor'}; }
    else text = '本地模拟验收：已通过真实工具应用提示词，未调用生图服务。';
  } else text = '本地模拟验收：已通过真实工具应用提示词，未调用生图服务。';
  text ||= tool ? undefined : '本地模拟验收完成，工具结果已保留。';
  const entry = {request:++requests,tool:tool||null,repaired,historyToolCalls:messages.slice(0,latestUser).filter(m=>m.tool_calls?.length).length,
    historyResults:messages.slice(0,latestUser).filter(m=>m.role==='tool').length,final:!!text};
  fs.appendFileSync(path.join(profile,'fixture-requests.jsonl'),JSON.stringify(entry)+'\n');
  response.writeHead(200,{'content-type':'text/event-stream'});
  const delta = tool ? {role:'assistant',tool_calls:[{index:0,id:`fixture-${requests}`,type:'function',function:{name:tool,arguments:JSON.stringify({args})}}]} : {role:'assistant',content:text};
  response.write(`data: ${JSON.stringify({id:`fixture-${requests}`,choices:[{index:0,delta,finish_reason:null}]})}\n\n`);
  response.write(`data: ${JSON.stringify({id:`fixture-${requests}`,choices:[{index:0,delta:{},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}})}\n\n`);
  response.end('data: [DONE]\n\n');
});
server.listen(0,'127.0.0.1',()=>{
  const port=server.address().port;
  const settings={language:'zh-CN',theme:'dark',outputDir:path.join(profile,'images'),proxyMode:'direct',proxyForAi:false,
    agentApiProtocol:'openai-compatible',agentApiBaseUrl:`http://127.0.0.1:${port}/v1`,agentApiModel:'local-acceptance-fixture',
    agentApiKey:'fixture-local-only',agentContextWindow:32768,agentMaxOutputTokens:2048,agentVisionEnabled:false,
    agentUiPreferences:{resourcesOpen:true,resourceTab:'skills'}};
  fs.writeFileSync(path.join(profile,'worldpainter-desktop.json'),JSON.stringify({settings,history:[],historyGroups:[],convertHistory:[],reverseHistory:[]}));
  fs.writeFileSync(path.join(profile,'fixture-server.json'),JSON.stringify({port,pid:process.pid,externalRequests:0}));
});

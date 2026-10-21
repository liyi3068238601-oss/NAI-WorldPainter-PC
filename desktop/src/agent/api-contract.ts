export type ApiField={key:string;title:string;type:'url'|'text'|'boolean'|'choice'|'json';values?:string[]};
const field=(key:string,title:string,type:ApiField['type']='text',values?:string[]):ApiField=>({key,title,type,...(values?{values}:{})});
export const API_PROFILES:Record<string,{title:string;secret:string;mobile:boolean;fields:Record<string,ApiField>}>= {
 novelai:{title:'NovelAI 生图',secret:'token',mobile:true,fields:{baseUrl:field('apiBaseUrl','账户 API 地址','url'),imageUrl:field('imageBaseUrl','图片 API 地址','url'),allowCustomEndpoint:field('allowCustomEndpoint','允许自定义服务接收凭据','boolean'),allowCustomEndpointFallback:field('allowCustomEndpointFallback','自定义失败后尝试官方收费服务','boolean')}},
 reverse:{title:'图片反推',secret:'visionApiKey',mobile:true,fields:{baseUrl:field('visionApiUrl','API 地址','url'),model:field('visionApiModel','模型')}},
 convert:{title:'提示词转换',secret:'convertApiKey',mobile:true,fields:{baseUrl:field('convertApiUrl','API 地址','url'),model:field('convertApiModel','模型')}},
 agent:{title:'酒馆对话',secret:'agentApiKey',mobile:true,fields:{baseUrl:field('agentApiBaseUrl','API 地址','url'),model:field('agentApiModel','模型'),protocol:field('agentApiProtocol','接口协议','choice',['openai-compatible','openai-responses','anthropic-messages','google-gemini']),name:field('agentProviderName','服务名称')}},
 tags:{title:'标签检索服务',secret:'tagServerApiKey',mobile:true,fields:{baseUrl:field('tagServerUrl','服务地址','url'),enabled:field('tagServerEnabled','启用','boolean'),transport:field('tagServerType','连接方式','choice',['rest','http','sse']),tool:field('tagServerTool','检索工具名称')}},
 translate:{title:'AI 翻译',secret:'translateAiApiKey',mobile:false,fields:{baseUrl:field('translateAiApiUrl','API 地址','url'),model:field('translateAiModel','模型')}}
};
function isOfficialNovelAiHost(hostname:string) {
 const host=hostname.toLocaleLowerCase();return host==='novelai.net'||host.endsWith('.novelai.net');
}
export function apiUrl(value:unknown,allowCustomHttp=false):string {
 if(typeof value!=='string'||value.length>2048||value!==value.trim()||/[\s\\]/.test(value))throw Error('API 地址格式无效');
 let u:URL;try{u=new URL(value);}catch{throw Error('API 地址格式无效');}
 const host=u.hostname.replace(/^\[|\]$/g,'').toLocaleLowerCase();
 const local=host==='localhost'||host==='::1'||/^127(?:\.\d{1,3}){3}$/.test(host);
 const schemeAllowed=u.protocol==='https:'||(u.protocol==='http:'&&(local||allowCustomHttp&&!isOfficialNovelAiHost(host)));
 if(!u.hostname||u.username||u.password||u.search||u.hash||!schemeAllowed)throw Error('使用 HTTPS 地址（本机允许 HTTP；自定义服务可使用 HTTP），地址不要包含密钥、查询参数或账号密码');
 return u.href.replace(/\/$/,'');
}
export function validateApiRequest(args:Record<string,unknown>,currentConfig?:Record<string,unknown>) {
 const action=String(args.action??''),profile=String(args.profile??'');
 if(!['read','configure','credential','clearCredential','test'].includes(action))throw Error('API 操作无效');
 if(profile&&!Object.hasOwn(API_PROFILES,profile))throw Error('API 分类无效');
 if(action!=='read'&&!profile)throw Error('请选择 API 分类');
 const allowed=['action','profile',...(['configure','credential','clearCredential'].includes(action)?['expectedRevision']:[]),...(action==='configure'?['patch']:[])];
 if(Object.keys(args).some(k=>!allowed.includes(k)))throw Error('未知 API 参数；密钥请在 Agent 的私密输入框填写');
 if(['configure','credential','clearCredential'].includes(action)&&(typeof args.expectedRevision!=='string'||!args.expectedRevision))throw Error('请先读取 API 配置');
 if(action==='configure'){
  const patchValue=args.patch;if(!patchValue||typeof patchValue!=='object'||Array.isArray(patchValue)||!Object.keys(patchValue).length)throw Error('请选择要修改的配置');
  const patch=patchValue as Record<string,unknown>;
  for(const [key,value] of Object.entries(patch)){
   const rule=Object.hasOwn(API_PROFILES[profile].fields,key)?API_PROFILES[profile].fields[key]:undefined;if(!rule)throw Error('未知 API 字段');
   if(rule.type==='boolean'){if(typeof value!=='boolean')throw Error('开关值无效');}
   else if(rule.type==='json'){
    if(!value||typeof value!=='object'||Array.isArray(value)||JSON.stringify(value).length>16384)throw Error('扩展参数须为不超过 16 KiB 的对象');
    for(const [name,v] of Object.entries(value)){
     if(['negative_prompt','sampler'].includes(name)){if(typeof v!=='string'||v.length>12000||/\x00/.test(v))throw Error('扩展参数类型无效');}
     else if(['steps','scale','seed'].includes(name)){if(typeof v!=='number'||!Number.isFinite(v)||name!=='scale'&&!Number.isSafeInteger(v))throw Error('扩展参数数值无效');}
     else throw Error('未支持的网关扩展字段');
    }
   }
   else if(rule.type==='url'){
    const explicitOptIn=typeof patch.allowCustomEndpoint==='boolean'?patch.allowCustomEndpoint:currentConfig?.allowCustomEndpoint===true;
    const allowCustomHttp=profile!=='novelai'||explicitOptIn;
    apiUrl(value,allowCustomHttp);
   }
   else if(typeof value!=='string'||!value.trim()||value.length>200||/[\r\n\x00]/.test(value)||rule.values&&!rule.values.includes(value))throw Error('API 字段值无效');
  }
 }
 return {action,profile,expectedRevision:args.expectedRevision as string,patch:args.patch as Record<string,unknown>|undefined};
}

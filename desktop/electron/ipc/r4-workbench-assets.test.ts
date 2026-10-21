import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';

const fake=vi.hoisted(()=>{
  let directory='';
  let state:any={artworks:{}};
  const workspace={version:4,conversations:[{id:'chat',title:'Fixture',messages:[],draftAttachments:[]}]};
  const store={
    readWorkspace:()=>workspace,
    readR4State:()=>state,
    transaction:(run:(tx:any)=>unknown)=>{
      const next=structuredClone(state);
      let committed=next;
      const result=run({getR4State:()=>committed,setR4State:(value:any)=>{committed=value;}});
      state=committed;
      return result;
    },
  };
  const withExclusive=vi.fn(async(run:()=>unknown)=>run());
  const generateCompatible=vi.fn(async(..._args:unknown[])=>({ok:true,message:'fixture',items:[]}));
  return {store,withExclusive,generateCompatible,setDirectory:(value:string)=>{directory=value;},directory:()=>directory,setState:(value:any)=>{state=value;},readState:()=>state};
});

vi.mock('./agent-store',()=>({agentAttachmentsDirectory:()=>fake.directory(),getAgentSqlStore:()=>fake.store}));
vi.mock('./store',()=>({getHistory:()=>[],getSettings:()=>({})}));
vi.mock('./nai',()=>({generateImage:vi.fn(),redrawImage:vi.fn(),inpaintImage:vi.fn(),upscaleImg:vi.fn(),augmentImg:vi.fn(),extractEmbeddedGenerationMetadata:vi.fn()}));
vi.mock('./job-registry',()=>({withR4ExclusiveGeneration:(run:()=>unknown)=>fake.withExclusive(run)}));
vi.mock('./compatible-generation',()=>({generateConfiguredImages:(...args:unknown[])=>fake.generateCompatible(...args)}));
vi.mock('./r4-agent-service',()=>({r4ImageProviderRef:()=>({providerId:'openai-images',accountRef:'fixture-account'})}));

import {importR4WorkbenchVibeEncoding,readR4WorkbenchVibeEncoding} from './r4-workbench-assets';
import {buildR4ImageProviderExtras,R4ImageProvider} from './r4-image-provider';

let root='';
beforeEach(()=>{
  root=fs.mkdtempSync(path.join(os.tmpdir(),'r4-vibe-encoding-'));
  fake.setDirectory(root);fake.setState({artworks:{}});
  fake.withExclusive.mockClear();fake.generateCompatible.mockClear();
});
afterEach(()=>{fs.rmSync(root,{recursive:true,force:true});});

describe('durable encoding-only Vibe workbench assets',()=>{
  const model='nai-diffusion-4-5-full';
  const encoding='AQIDBA==';
  const hash=createHash('sha256').update(Buffer.from(encoding,'ascii')).digest('hex');

  it('stores the exact encoding as a hash-bound workbench attachment without image decoding',async()=>{
    const binding=await importR4WorkbenchVibeEncoding({conversationId:'chat',creationId:'creation',encoding,model,infoExtracted:.7,name:'encoded reference'});
    expect(binding).toMatchObject({role:'vibe',revision:1,hash,mime:'application/vnd.novelai.vibe-transfer-encoding',name:'encoded reference'});
    expect(binding).not.toHaveProperty('width');expect(binding).not.toHaveProperty('height');
    const artwork=fake.readState().artworks[binding.attachmentId];
    expect(artwork).toMatchObject({attachmentId:binding.attachmentId,hash,mime:binding.mime,sourceKind:'workbench'});
    expect(fs.readFileSync(artwork.readableHandle,'ascii')).toBe(encoding);
    expect(readR4WorkbenchVibeEncoding(binding,{conversationId:'chat',creationId:'creation'})).toBe(encoding);
    expect(()=>readR4WorkbenchVibeEncoding(binding,{conversationId:'other-chat',creationId:'creation'})).toThrow('不匹配');
  });

  it('recovers verified bytes into a matching-model Vibe encoding, not an image reference',async()=>{
    const binding=await importR4WorkbenchVibeEncoding({conversationId:'chat',creationId:'creation',encoding,model,infoExtracted:.7});
    const execution={conversationId:'chat',creationId:'creation',approvedInput:{editSource:null,mask:null,references:[],workbenchAssets:[binding],publicParameters:{
      params:{model},vibeReferences:[{attachmentId:binding.attachmentId,encodingModel:model,encodingInfoExtracted:.7,infoExtracted:.7,strength:.31}],
    }}} as any;
    expect(buildR4ImageProviderExtras(execution).vibeImages).toEqual([{
      base64:'',encodings:[{model,infoExtracted:.7,encoding}],infoExtracted:.7,strength:.31,
    }]);
  });

  it('refuses tampered managed bytes and mismatched frozen model/extraction metadata',async()=>{
    const binding=await importR4WorkbenchVibeEncoding({conversationId:'chat',creationId:'creation',encoding,model,infoExtracted:.7});
    const artwork=fake.readState().artworks[binding.attachmentId];fs.writeFileSync(artwork.readableHandle,'BQYHCA==');
    const execution={conversationId:'chat',creationId:'creation',approvedInput:{editSource:null,mask:null,references:[],workbenchAssets:[binding],publicParameters:{
      params:{model},vibeReferences:[{attachmentId:binding.attachmentId,encodingModel:model,encodingInfoExtracted:.7,infoExtracted:.7,strength:1}],
    }}} as any;
    expect(()=>buildR4ImageProviderExtras(execution)).toThrow('内容已变化');
    fs.writeFileSync(artwork.readableHandle,encoding);
    execution.approvedInput.publicParameters.vibeReferences[0].encodingModel='nai-diffusion-4-5-curated';
    expect(()=>buildR4ImageProviderExtras(execution)).toThrow('模型或提取值不匹配');
  });

  it('rejects malformed and oversized encoding payloads before persistence',async()=>{
    await expect(importR4WorkbenchVibeEncoding({conversationId:'chat',creationId:'creation',encoding:'not base64',model,infoExtracted:.7})).rejects.toThrow('编码无效');
    expect(Object.keys(fake.readState().artworks)).toHaveLength(0);
  });

  it('runs the compatible-image provider inside the R4/manual generation exclusion gate',async()=>{
    const providerRef={providerId:'openai-images',accountRef:'fixture-account'};
    const execution={providerRef,expectedOutputCount:1,conversationId:'chat',creationId:'creation',approvedInput:{positivePrompt:'fixture prompt',publicParameters:{
      providerRef,compatibleConfig:{},
    }}} as any;
    const context={signal:new AbortController().signal,beforeSubmit:vi.fn(),afterReceipt:vi.fn()};
    await new R4ImageProvider().submit(execution,null,context as any);
    expect(fake.withExclusive).toHaveBeenCalledOnce();
    expect(fake.generateCompatible).toHaveBeenCalledOnce();
  });
});

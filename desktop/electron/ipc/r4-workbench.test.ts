import {describe,it,expect,vi} from 'vitest';
import {DEFAULT_PARAMS,DEFAULT_AUGMENT_OPTIONS} from '../../src/types';
import {validateR4Result} from '../../src/agent/r4-contracts';
import {createStudioAgentService} from '../../src/studio-agent';
import type {R4HostScope} from './r4-creative-host';
import {createR4WorkbenchService} from './r4-workbench';

vi.mock('../../src/store',()=>({useAppStore:{}}));

const scope:R4HostScope={conversationId:'chat-a',creationId:'creation-a',userIntentRef:'intent-a',operationKey:'operation-a',messageId:'message-a'};

function fixture() {
  let writes=0;
  let state:any={bootDone:true,settings:{modelMode:'anime'},params:{...DEFAULT_PARAMS,positivePrompt:'before positive',negativePrompt:'before negative',stylePrompt:'before style',steps:31},
    charCaptions:[{id:'caption-1',prompt:'keep character'}],batchCount:4,i2iParams:{strength:.5,noise:0,extraNoiseSeed:0},inpaintModel:'inpaint',inpaintStrength:.7,inpaintNoise:0,
    inpaintPositivePrompt:'keep inpaint',brushSize:32,brushOpacity:.8,brushColor:'#fff',brushShape:'round',upscaleScale:2,directorTool:'colorize',augmentOptions:{...DEFAULT_AUGMENT_OPTIONS},
    vibeImages:[{id:'vibe-1',base64:'synthetic-only',strength:.7,infoExtracted:.8}],preciseReferences:[{id:'reference-1',base64:'synthetic-only',type:'style',strength:.6,fidelity:.7}],
    i2iSourceMode:'image',i2iOriginalImage:{filePath:'fixture.png',width:512,height:512},workbenchImage:{filePath:'fixture.png',width:512,height:512},maskRevision:3,inpaintMask:'synthetic-mask',
    applyParams(patch:Record<string,unknown>){state={...state,params:{...state.params,...patch}};writes++;}};
  const renderer=createStudioAgentService({getState:()=>state,setState:patch=>{state={...state,...patch};},api:{} as never,uuid:()=>`renderer-workbench`});
  const rendererRequest=async(action:'r4-workbench-read'|'r4-workbench-apply',args:Record<string,unknown>)=>renderer.handle({id:'synthetic',action,args});
  const host={invoke:vi.fn(async(name:string,args:Record<string,unknown>,target:R4HostScope)=>{
    if(name!=='read_proposal'||target.conversationId!=='chat-a'||target.creationId!=='creation-a'||args.proposalId!=='proposal-a'||args.revision!==7){
      return {resultKind:'business',status:'completed',conversationId:target.conversationId,creationId:target.creationId,
        data:{proposalReadStatus:'not_found',proposalId:String(args.proposalId),revision:Number(args.revision)}};
    }
    return {resultKind:'business',status:'completed',conversationId:target.conversationId,creationId:target.creationId,
      data:{proposalReadStatus:'ok',proposalId:'proposal-a',revision:7,positivePrompt:'after positive',negativePrompt:'after negative',stylePrompt:'after style',changeSummary:'fixture prompt proposal',currentProposalRef:null,selectionRevision:0}};
  })};
  const workbench=createR4WorkbenchService({window:()=>null,host:()=>host as never,rendererRequest,uuid:(()=>{let n=0;return()=>`preview-${++n}`})()});
  return {workbench,host,get state(){return state;},get writes(){return writes;},setState:(patch:Record<string,unknown>)=>{state={...state,...patch};}};
}

async function read(f:ReturnType<typeof fixture>) {return f.workbench.readR4WorkbenchSnapshot();}

describe('R4 live workbench prompt CAS',()=>{
  it('typing after preview invalidates its renderer revision and causes zero writes',async()=>{
    const f=fixture(),snapshot=await read(f);
    const preview=await f.workbench.previewR4PromptApply({proposalId:'proposal-a',proposalRevision:7,targetDraftId:snapshot.draftId,expectedDraftRevision:snapshot.draftRevision},scope) as {previewId:string;draftId:string;draftRevision:number};
    f.setState({params:{...f.state.params,positivePrompt:'user typed while preview was open'}});
    const applied=await f.workbench.applyR4PromptCAS(preview.previewId,preview.draftId,preview.draftRevision,scope);
    expect(validateR4Result('apply_prompt',applied).valid).toBe(true);
    expect(applied).toMatchObject({resultKind:'business',data:{applyStatus:'conflict'}});
    expect(f.writes).toBe(0);
    expect(f.state.params.positivePrompt).toBe('user typed while preview was open');
  });

  it('applies only the three prompt fields and preserves live generation, source, reference, and character state',async()=>{
    const f=fixture(),before=f.state,snapshot=await read(f);
    const preview=await f.workbench.previewR4PromptApply({proposalId:'proposal-a',proposalRevision:7,targetDraftId:snapshot.draftId,expectedDraftRevision:snapshot.draftRevision},scope) as {previewId:string;draftId:string;draftRevision:number;diff:Record<string,boolean>};
    expect(preview.diff).toEqual({positivePromptChanged:true,negativePromptChanged:true,stylePromptChanged:true});
    const applied=await f.workbench.applyR4PromptCAS(preview.previewId,preview.draftId,preview.draftRevision,scope);
    expect(validateR4Result('apply_prompt',applied).valid).toBe(true);
    expect(applied).toMatchObject({resultKind:'business',data:{applyStatus:'applied'}});
    expect(f.state.params).toMatchObject({positivePrompt:'after positive',negativePrompt:'after negative',stylePrompt:'after style',steps:31});
    expect(f.state.charCaptions).toEqual(before.charCaptions);
    expect(f.state.vibeImages).toEqual(before.vibeImages);
    expect(f.state.preciseReferences).toEqual(before.preciseReferences);
    expect(f.state.i2iOriginalImage).toEqual(before.i2iOriginalImage);
    expect(f.state.workbenchImage).toEqual(before.workbenchImage);
    expect(f.state.inpaintMask).toBe(before.inpaintMask);
    expect(f.state.maskRevision).toBe(before.maskRevision);
    expect(f.writes).toBe(1);
  });

  it('binds preview to the exact conversation and creation and never retargets from active UI scope',async()=>{
    const f=fixture(),snapshot=await read(f);
    const preview=await f.workbench.previewR4PromptApply({proposalId:'proposal-a',proposalRevision:7,targetDraftId:snapshot.draftId,expectedDraftRevision:snapshot.draftRevision},scope) as {previewId:string;draftId:string;draftRevision:number};
    const wrongScope={...scope,conversationId:'chat-b',creationId:'creation-b'};
    const rejected=await f.workbench.applyR4PromptCAS(preview.previewId,preview.draftId,preview.draftRevision,wrongScope);
    expect(validateR4Result('apply_prompt',rejected).valid).toBe(true);
    expect(rejected).toMatchObject({resultKind:'preflight_failure',error:{code:'context_mismatch'}});
    expect(f.writes).toBe(0);
    expect(f.host.invoke).toHaveBeenCalledWith('read_proposal',{proposalId:'proposal-a',revision:7},scope);
  });

  it('shows the diff to real authorization before applying; denial is a valid no-write preflight result',async()=>{
    const f=fixture(),snapshot=await read(f),authorize=vi.fn(async(_name:string,args:Record<string,unknown>)=>{
      expect(args.preview).toMatchObject({before:{positivePrompt:'before positive'},after:{positivePrompt:'after positive'}});
      return false;
    });
    const apply=f.workbench.createR4ApplyPrompt({scope,authorize});
    const result=await apply({proposalId:'proposal-a',proposalRevision:7,targetDraftId:snapshot.draftId,expectedDraftRevision:snapshot.draftRevision},scope,new AbortController().signal);
    expect(validateR4Result('apply_prompt',result).valid).toBe(true);
    expect(result).toMatchObject({resultKind:'preflight_failure',status:'denied'});
    expect(authorize).toHaveBeenCalledOnce();
    expect(f.writes).toBe(0);
  });
});

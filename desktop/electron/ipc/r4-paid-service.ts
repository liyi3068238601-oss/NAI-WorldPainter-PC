import {createHash} from 'node:crypto';
import type {AgentSqlStore} from './r4-store';
import {r4Hash,type R4HostScope} from './r4-creative-host';
import {withR4PaidTextContext,currentR4PaidTextState} from './r4-paid-text-context';
import {validateR4Result,type R4ToolName} from '../../src/agent/r4-contracts';

type PaidServiceResult={result:Record<string,unknown>;generatedImages?:unknown[];legacyOutput?:string};
const now=()=>new Date().toISOString();
const idFor=(scope:R4HostScope)=>'paid-service:'+createHash('sha256').update(scope.conversationId+':'+scope.operationKey).digest('hex');
function gate(store:AgentSqlStore,id:string,scope:R4HostScope,phase:'unknown'|'failed'){
  return store.transaction(tx=>{const state=tx.getR4State();state.gates[id]={id,conversationId:scope.conversationId,turnId:scope.turnLineageRef??scope.userIntentRef,active:true,reason:phase==='unknown'?'unknown_prior_receipt':'prior_paid_failure',createdAt:now()};tx.setR4State(state);});
}

/** Host-only request ledger for the three external, potentially paid text tools. */
export async function runR4PaidService(store:AgentSqlStore,name:string,args:Record<string,unknown>,scope:R4HostScope,run:()=>Promise<PaidServiceResult>,options:{signal?:AbortSignal;beforePost?:()=>void}={}):Promise<PaidServiceResult>{
  const id=idFor(scope),argumentHash=r4Hash({name,args,dependencyRevision:scope.paidServiceRevision??null});
  const admission=store.transaction(tx=>{
    const state=tx.getR4State(),old=state.operations[id];
    if(old){
      if(old.creationId!==scope.creationId||old.receipt.argumentHash!==argumentHash)throw Error('同一收费工具操作标识对应不同输入，未重新发送。');
      if(old.receipt.phase==='completed'&&old.receipt.result)return {replay:structuredClone(old.receipt.result) as Record<string,unknown>};
      if(old.receipt.phase==='blocked')throw Error('此旧工具请求确定尚未发送，已暂停；请明确发起新的操作。');
      return {unsettled:true};
    }
    state.operations[id]={id,conversationId:scope.conversationId,creationId:scope.creationId,operationKey:scope.operationKey,operation:'paid_service',status:'applied',userIntentRef:scope.userIntentRef,
      receipt:{phase:'pending',tool:name,argumentHash,turnLineageRef:scope.turnLineageRef??scope.userIntentRef},createdAt:now()};
    tx.setR4State(state);return {};
  });
  if(admission.replay)return {result:admission.replay};
  if(admission.unsettled){gate(store,id,scope,'unknown');throw Error('原收费工具请求尚无可核实回执，未重新发送。');}
  try{
    if(!['convert_prompt','edit_prompt','reverse_prompt'].includes(name))throw Error('收费文字工具类型无效。');
    const response=await withR4PaidTextContext({canonicalTool:name as 'convert_prompt'|'edit_prompt'|'reverse_prompt',signal:options.signal??new AbortController().signal,
      beforePost:()=>{
        options.beforePost?.();
        store.transaction(tx=>{const state=tx.getR4State(),operation=state.operations[id];operation.receipt={...operation.receipt,dispatchStartedAt:now(),providerRequestCount:1};tx.setR4State(state);});
      },
      afterReceipt:receipt=>store.transaction(tx=>{const state=tx.getR4State();state.operations[id].receipt.providerReceipt=structuredClone(receipt);tx.setR4State(state);}),
    },async()=>{
      const response=await run(),transport=currentR4PaidTextState();
      const data=response.result.data as Record<string,unknown>|undefined;
      if(response.result.status==='error'&&data?.serviceStatus==='unknown'&&transport?.receipt){
        const known=transport.receipt.certainty==='received',result=structuredClone(response.result);
        (result.data as Record<string,unknown>).serviceStatus=known?'failed':'unknown';
        result.error={...(result.error as Record<string,unknown>??{}),code:'provider_unknown',message:known?'服务已返回响应，但没有可用的完整结果；未自动再次请求。':'服务请求回执待核实；未自动重发。',allowedActions:known?['stop_related_paid_calls']:['do_not_retry_unknown','stop_related_paid_calls','wait_for_receipt']};
        if(!validateR4Result(name as R4ToolName,result).valid)throw Error('收费文字工具回执不符合当前合同。');
        return {...response,result};
      }
      return response;
    });
    store.transaction(tx=>{
      const state=tx.getR4State(),operation=state.operations[id],data=response.result.data as Record<string,unknown>|undefined;
      const unknown=data?.serviceStatus==='unknown',failed=response.result.status==='error';
      operation.receipt={...operation.receipt,phase:'completed',result:structuredClone(response.result),completedAt:now()};
      if(unknown||failed)state.gates[id]={id,conversationId:scope.conversationId,turnId:scope.turnLineageRef??scope.userIntentRef,active:true,reason:unknown?'unknown_prior_receipt':'prior_paid_failure',createdAt:now()};
      else if(state.gates[id]){state.gates[id].active=false;state.gates[id].releasedAt=now();state.gates[id].releasedBy='verified_service_receipt';}
      tx.setR4State(state);
    });
    return response;
  }catch(error){
    store.transaction(tx=>{const state=tx.getR4State(),operation=state.operations[id],attempted=Boolean(operation.receipt.dispatchStartedAt);operation.receipt={...operation.receipt,phase:attempted?'unknown':'blocked',updatedAt:now()};
      if(attempted)state.gates[id]={id,conversationId:scope.conversationId,turnId:scope.turnLineageRef??scope.userIntentRef,active:true,reason:'unknown_prior_receipt',createdAt:now()};tx.setR4State(state);});
    throw error;
  }
}

export function recoverR4PaidServices(store:AgentSqlStore){
  store.transaction(tx=>{const state=tx.getR4State();let changed=false;
    for(const operation of Object.values(state.operations))if(operation.operation==='paid_service'&&operation.receipt.phase==='pending'){
      const attempted=Boolean(operation.receipt.dispatchStartedAt);operation.receipt.phase=attempted?'unknown':'blocked';operation.receipt.recoveredAt=now();
      if(attempted)state.gates[operation.id]={id:operation.id,conversationId:operation.conversationId,turnId:String(operation.receipt.turnLineageRef??operation.userIntentRef),active:true,reason:'unknown_prior_receipt',createdAt:now()};changed=true;
    }
    if(changed)tx.setR4State(state);
  });
}

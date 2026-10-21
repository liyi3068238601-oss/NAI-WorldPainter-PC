import {useEffect, useState} from 'react';
import {LuArrowDownToLine, LuCheck, LuChevronDown, LuCircleAlert, LuFileText, LuImage, LuLayers, LuPencil, LuPlus, LuRotateCcw, LuSparkles, LuX, LuZoomIn} from 'react-icons/lu';
import type {AgentAttachment} from '../agent/types';
import type {R4Artwork, R4AttachmentBinding, R4ConversationCreativeState, R4Creation, R4Execution, R4OperationReceipt, R4Preparation, R4Proposal, R4ReferenceBinding, R4ReferencePurpose} from '../agent/r4-types';
import {r4Text} from '../agent/r4-ui';

const purposes: Array<{value:R4ReferencePurpose;zh:string;en:string}> = [
  {value:'color',zh:'色彩',en:'Color'},
  {value:'composition',zh:'构图',en:'Composition'},
  {value:'character',zh:'角色',en:'Character'},
  {value:'atmosphere',zh:'氛围',en:'Atmosphere'},
];

export function AgentR4CreativePanel(props: {
  language: unknown;
  /** Conversation inline references and confirmation; the Generate page owns prompts/results. */
  workbench?: boolean;
  state?: R4ConversationCreativeState;
  creation?: R4Creation;
  currentProposal?: R4Proposal;
  proposals: R4Proposal[];
  artworks: R4Artwork[];
  selectedArtwork?: R4Artwork;
  preparation?: R4Preparation;
  executions: R4Execution[];
  receipts: R4OperationReceipt[];
  attachments: AgentAttachment[];
  disabled: boolean;
  generationDisabled?: boolean;
  onSelectProposal: (proposal:R4Proposal)=>void;
  onPrepare: (proposal?:R4Proposal)=>void;
  onPreviewWorkbenchApply: (proposal:R4Proposal)=>void;
  onSelectArtwork: (artwork:R4Artwork)=>void;
  onOpenArtwork: (artwork:R4Artwork)=>void;
  onSetEditSource: (binding:R4AttachmentBinding)=>void;
  onRemoveEditSource: ()=>void;
  onAddReference: (attachment:AgentAttachment|R4Artwork,role:'reference'|'discussion',purpose?:R4ReferencePurpose)=>void;
  onChangeReference: (binding:R4ReferenceBinding,change:{purpose?:R4ReferencePurpose;includeInGeneration:boolean;role:'reference'|'discussion'})=>void;
  onRemoveReference: (binding:R4ReferenceBinding)=>void;
  onSaveInputs: (patch:{requirements?:string;positivePrompt?:string;negativePrompt?:string;stylePrompt?:string})=>void;
  onApprovePreparation: (preparation:R4Preparation)=>void;
  onDenyPreparation: (preparation:R4Preparation)=>void;
  onUndo: (receipt:R4OperationReceipt)=>void;
  attachmentUrl: (binding:R4AttachmentBinding)=>string|undefined;
}) {
  const {language,state,creation,disabled}=props;
  const t=(zh:string,en:string)=>r4Text(language,zh,en);
  const current=props.currentProposal;
  const selected=props.selectedArtwork;
  const selectedUrl=selected?(selected.url??props.attachmentUrl(selected)):undefined;
  const editSource=creation?.editSource;
  const references=creation?.references??[];
  const [editing,setEditing]=useState(false);
  const [requirements,setRequirements]=useState(creation?.requirements??'');
  const [positive,setPositive]=useState(creation?.positivePrompt??'');
  const [negative,setNegative]=useState(creation?.negativePrompt??'');
  const [style,setStyle]=useState(creation?.stylePrompt??'');
  useEffect(()=>{
    setRequirements(creation?.requirements??'');setPositive(creation?.positivePrompt??'');setNegative(creation?.negativePrompt??'');setStyle(creation?.stylePrompt??'');setEditing(false);
  },[creation?.id,creation?.inputRevision]);

  if(!creation&&props.workbench)return null;
  if(!creation)return <aside className="r4-creative-panel" aria-label={t('创作面板','Creative panel')}><div className="r4-panel-empty"><LuSparkles/><h3>{t('还没有创作','No creation yet')}</h3><p>{t('创建创作后，方案、作品和生成要求会保存在当前对话中。','Create a workspace to keep proposals, artwork, and requirements with this conversation.')}</p></div></aside>;

  const findAsset=(binding:R4AttachmentBinding)=>{
    const artwork=Object.values(state?.artworks??{}).find(item=>item.attachmentId===binding.attachmentId&&item.revision===binding.revision);
    const attachment=props.attachments.find(item=>item.id===binding.attachmentId&&(item.revision===undefined||item.revision===binding.revision));
    return {artwork,attachment,url:artwork?.url??attachment?.fileUrl};
  };
  // The user explicitly binds a selected conversation attachment to this creation.
  // Do not infer ownership from message history, and keep source/reference as separate roles.
  const available=props.attachments.filter(item=>item.kind==='image'&&!item.unavailable&&!references.some(reference=>reference.attachmentId===item.id));
  const sourceAsset=editSource?findAsset(editSource):undefined;
  const latestExecution=props.executions[0];
  const preparation=props.preparation;

  return <aside className={props.workbench?"r4-workbench-context":"r4-creative-panel"} aria-label={props.workbench?t('参考与生成确认','References and generation confirmation'):t('创作面板','Creative panel')}>
    {!props.workbench&&<><header className="r4-panel-header"><div><small>{t('当前创作','Current creation')}</small><strong title={creation.title}>{creation.title}</strong></div><span className="r4-revision">r{creation.inputRevision}</span></header>

    <section className="r4-panel-section r4-proposal-section" aria-labelledby="r4-current-proposal-title">
      <div className="r4-section-heading"><h3 id="r4-current-proposal-title"><LuSparkles/>{t('当前方案','Current proposal')}</h3><span>{current?`v${current.revision}`:t('未设置','Not set')}</span></div>
      {current?<AgentR4ProposalCard language={language} proposal={current} current disabled={disabled} generationDisabled={props.generationDisabled} onPrepare={()=>props.onPrepare(current)} onSelect={()=>props.onSelectProposal(current)} onApplyToWorkbench={()=>props.onPreviewWorkbenchApply(current)}/>:<div className="r4-empty-inline"><p>{t('尚无当前方案。可以从右侧历史方案中选择，也可以继续与 Agent 讨论。','No current proposal. Choose a version from history, or continue discussing it with Agent.')}</p>{props.proposals.length>0&&<button type="button" disabled={disabled} onClick={()=>props.onSelectProposal(props.proposals[0])}><LuCheck/>{t('设为最新版本','Set latest version')}</button>}</div>}
      {props.proposals.length>1&&<details className="r4-proposal-history"><summary><LuLayers/>{t('方案版本','Proposal versions')} · {props.proposals.length}</summary><div className="r4-proposal-list">{props.proposals.map(proposal=><AgentR4ProposalCard key={`${proposal.id}@${proposal.revision}`} language={language} proposal={proposal} current={proposal.id===current?.id&&proposal.revision===current.revision} disabled={disabled} generationDisabled={props.generationDisabled} compact onPrepare={()=>props.onPrepare(proposal)} onSelect={()=>props.onSelectProposal(proposal)} onApplyToWorkbench={()=>props.onPreviewWorkbenchApply(proposal)}/>)}</div></details>}
    </section>

    <section className="r4-panel-section r4-artwork-section" aria-labelledby="r4-selected-artwork-title">
      <div className="r4-section-heading"><h3 id="r4-selected-artwork-title"><LuImage/>{t('选中作品','Selected artwork')}</h3>{selected&&<span>{selected.width&&selected.height?`${selected.width} × ${selected.height}`:''}</span>}</div>
      {selected?<>
        {selectedUrl?<button className="r4-selected-artwork" type="button" onClick={()=>props.onOpenArtwork({...selected,url:selectedUrl})} aria-label={`${t('查看','View')}: ${selected.name}`}><img src={selectedUrl} alt={selected.name}/><span><LuZoomIn/>{t('查看大图','Open viewer')}</span></button>:<div className="r4-artwork-missing"><LuCircleAlert/><span>{t('作品文件当前不可读','Artwork file is unavailable')}</span></div>}
        <div className="r4-artwork-meta"><strong title={selected.name}>{selected.name}</strong><small>{selected.resolvedSeed==null?t('种子未返回', 'Seed not returned'):`${t('实际种子','Resolved seed')}: ${selected.resolvedSeed}`}{selected.resolvedSeedSource&&` · ${selected.resolvedSeedSource==='provider_receipt'?t('服务回执','provider receipt'):t('已验证元数据','verified metadata')}`}</small></div>
        <div className="r4-inline-actions"><button type="button" disabled={disabled} onClick={()=>props.onSetEditSource({attachmentId:selected.attachmentId,revision:selected.revision,hash:selected.hash,name:selected.name,mime:selected.mime,width:selected.width,height:selected.height})}><LuPencil/>{t('继续修改','Continue editing')}</button><ReferencePurposeMenu language={language} disabled={disabled} onChoose={(role,purpose)=>props.onAddReference(selected,role,purpose)} /></div>
      </>:<p className="r4-empty-inline">{props.artworks.length?t('从下方作品列表中选择要查看的图片。','Choose an image from the artwork list below.'):t('生成完成后，作品会显示在这里。','Completed artwork appears here.')}</p>}
      {props.artworks.length>0&&(!selected||props.artworks.length>1)&&<div className="r4-artwork-strip" aria-label={t('当前创作作品','Artwork in this creation')}>{props.artworks.map(artwork=>{const url=artwork.url??props.attachmentUrl(artwork);return <button type="button" key={artwork.id} aria-current={artwork.id===selected?.id?'true':undefined} aria-label={artwork.name} title={artwork.name} onClick={()=>props.onSelectArtwork(artwork)}>{url?<img src={url} alt=""/>:<span><LuImage/></span>}</button>})}</div>}
    </section>

    </>}
    <section className="r4-panel-section r4-input-section" aria-labelledby="r4-creation-inputs-title">
      <div className="r4-section-heading"><h3 id="r4-creation-inputs-title"><LuFileText/>{props.workbench?t('参考图','References'):t('创作要求','Creation requirements')}</h3>{!props.workbench&&<button type="button" disabled={disabled} aria-expanded={editing} onClick={()=>setEditing(value=>!value)}>{editing?t('收起编辑','Done'):t('编辑','Edit')}</button>}</div>
      {editSource&&<div className="r4-binding-row r4-source-binding"><div className="r4-binding-thumb">{sourceAsset?.url?<img src={sourceAsset.url} alt=""/>:<LuImage/>}</div><div className="r4-binding-copy"><strong>{t('改图源','Edit source')}</strong><span>{editSource.name||sourceAsset?.attachment?.name||editSource.attachmentId}</span><small>{t('修订','Revision')} {editSource.revision}</small></div><button className="r4-binding-remove" type="button" disabled={disabled} aria-label={t('移除改图源','Remove edit source')} title={t('移除改图源','Remove edit source')} onClick={props.onRemoveEditSource}><LuX/></button></div>}
      {references.map(binding=>{
        const asset=findAsset(binding);const purpose=purposes.find(item=>item.value===binding.purpose);const authorized=binding.authorizationStatus==='authorized'&&binding.includeInGeneration;
        const onlyDiscussion=binding.role==='discussion'||!binding.purpose;
        return <div className="r4-binding-row" key={`${binding.attachmentId}:${binding.revision}`}>
          <div className="r4-binding-thumb">{asset.url?<img src={asset.url} alt=""/>:<LuImage/>}</div>
          <div className="r4-binding-copy"><strong>{onlyDiscussion?t('仅讨论','Discussion only'):purpose?t(purpose.zh,purpose.en):t('用途未指定','Purpose not set')}</strong><span>{binding.name||asset.attachment?.name||asset.artwork?.name||binding.attachmentId}</span><small>{binding.authorizationStatus==='unknown'||binding.authorizationStatus==='revoked'?t('参与授权待核实','Generation authorization needs review'):authorized?t('参与生成','Included in generation'):t('不参与生成','Not included in generation')}</small>
            <div className="r4-binding-controls"><select aria-label={`${t('参考用途','Reference purpose')}: ${binding.name||binding.attachmentId}`} disabled={disabled} value={onlyDiscussion?'discussion':binding.purpose??'discussion'} onChange={event=>{const value=event.target.value;props.onChangeReference(binding,value==='discussion'?{role:'discussion',includeInGeneration:false}:{role:'reference',purpose:value as R4ReferencePurpose,includeInGeneration:false});}}><option value="discussion">{t('仅讨论','Discussion only')}</option>{purposes.map(item=><option key={item.value} value={item.value}>{t(item.zh,item.en)}</option>)}</select>
              <label><input type="checkbox" checked={authorized} disabled={disabled||onlyDiscussion||binding.authorizationStatus==='unknown'||binding.authorizationStatus==='revoked'} onChange={event=>props.onChangeReference(binding,{role:'reference',purpose:binding.purpose,includeInGeneration:event.target.checked})}/><span>{t('参与生成','Use in generation')}</span></label>
            </div>
          </div>
          <button className="r4-binding-remove" type="button" disabled={disabled} aria-label={`${t('移除参考','Remove reference')}: ${binding.name||binding.attachmentId}`} title={t('移除参考','Remove reference')} onClick={()=>props.onRemoveReference(binding)}><LuX/></button>
        </div>;
      })}
      {available.length>0&&<details className="r4-add-reference"><summary><LuPlus/>{t('添加参考','Add reference')}</summary><div>{available.map(attachment=><div key={attachment.id} className="r4-available-reference"><span>{attachment.fileUrl?<img src={attachment.fileUrl} alt=""/>:<LuImage/>}<span>{attachment.name}</span></span><ReferencePurposeMenu language={language} disabled={disabled} onChoose={(role,purpose)=>props.onAddReference(attachment,role,purpose)}/></div>)}</div></details>}
      {references.length===0&&!available.length&&<p className="r4-empty-inline">{t('暂无参考图。当前对话中没有可安全绑定的图片。','No references. This conversation has no image with a safe revision to bind.')}</p>}
      {!props.workbench&&(editing?<div className="r4-input-editor">
        <label>{t('创作要求','Requirements')}<textarea value={requirements} onChange={event=>setRequirements(event.target.value)} rows={3}/></label>
        <label>{t('正向提示词','Positive prompt')}<textarea value={positive} onChange={event=>setPositive(event.target.value)} rows={4}/></label>
        <label>{t('负向提示词','Negative prompt')}<textarea value={negative} onChange={event=>setNegative(event.target.value)} rows={3}/></label>
        <label>{t('风格提示词','Style prompt')}<textarea value={style} onChange={event=>setStyle(event.target.value)} rows={3}/></label>
        <div><button type="button" disabled={disabled} onClick={()=>{props.onSaveInputs({requirements,positivePrompt:positive,negativePrompt:negative,stylePrompt:style});setEditing(false);}}><LuCheck/>{t('保存修改','Save changes')}</button></div>
      </div>:<div className="r4-input-summary"><p>{creation.requirements||t('还没有补充创作要求。','No additional requirements yet.')}</p><details><summary>{t('提示词详情','Prompt details')}</summary><dl><dt>{t('正向','Positive')}</dt><dd>{creation.positivePrompt||'—'}</dd><dt>{t('负向','Negative')}</dt><dd>{creation.negativePrompt||'—'}</dd><dt>{t('风格','Style')}</dt><dd>{creation.stylePrompt||'—'}</dd></dl></details></div>)}
    </section>

    {preparation&&<section className={`r4-preparation-card r4-preparation-${preparation.status}`} aria-label={t('生成预览','Generation preview')}>
      <header><strong>{t('生成预览','Generation preview')}</strong><span>{preparation.status}</span></header>
      {preparation.blockedReason&&<p role="alert" className="r4-preparation-blocked"><LuCircleAlert/>{preparation.blockedReason}</p>}
      <PreviewSummary language={language} preview={preparation.preview} inputSnapshot={preparation.inputSnapshot} providerRef={preparation.providerRef} requestEditSource={preparation.inputSnapshot.editSource} currentEditSource={editSource}/>
      <details><summary>{t('输入快照详情','Input snapshot details')}</summary>
        <div className="r4-preview-prompts"><strong>{t('本次请求的实际提示词（冻结值）','Actual prompts for this request (frozen)')}</strong><dl><dt>{t('正向','Positive')}</dt><dd>{preparation.inputSnapshot.positivePrompt||'—'}</dd><dt>{t('负向','Negative')}</dt><dd>{preparation.inputSnapshot.negativePrompt||'—'}</dd><dt>{t('风格','Style')}</dt><dd>{preparation.inputSnapshot.stylePrompt||'—'}</dd></dl></div>
        <pre>{JSON.stringify({fingerprint:preparation.fingerprint,inputRevision:preparation.inputRevision,conversationConfig:preparation.conversationConfig,preview:preparation.preview},null,2)}</pre></details>
      {preparation.status==='ready'&&<footer><button type="button" disabled={disabled} onClick={()=>props.onDenyPreparation(preparation)}>{t('取消预览','Dismiss')}</button><button type="button" className="r4-primary" disabled={disabled||props.generationDisabled} onClick={()=>props.onApprovePreparation(preparation)}><LuCheck/>{t('确认并排队','Approve and queue')}</button></footer>}
    </section>}

    <details className="r4-details-section"><summary>{t('详情','Details')}</summary>
      <dl><dt>{t('创作 ID','Creation ID')}</dt><dd>{creation.id}</dd><dt>{t('输入修订','Input revision')}</dt><dd>{creation.inputRevision}</dd><dt>{t('当前方案','Current proposal')}</dt><dd>{current?`v${current.revision} · ${current.title}`:t('未设置','Not set')}</dd><dt>{t('会话模型','Conversation model')}</dt><dd>{state?.config?`${state.config.providerRef.providerId} · ${state.config.modelId}`:t('历史配置未版本化','Legacy configuration unversioned')}</dd><dt>{t('助手预设快照','Assistant preset snapshot')}</dt><dd>{state?.assistantPresetBinding?`${state.assistantPresetBinding.presetId} · ${state.assistantPresetBinding.enabled?t('已启用','enabled'):t('已停用','disabled')}`:state?.assistantPresetDefaultBinding?`${state.assistantPresetDefaultBinding.presetId} · ${state.assistantPresetDefaultBinding.enabled?t('已启用','enabled'):t('已停用','disabled')} · ${t('新会话默认','new-chat default')}`:t('未设置或未版本化','Not set or unversioned')}</dd>{props.selectedArtwork&&<><dt>{t('作品修订','Artwork revision')}</dt><dd>{props.selectedArtwork.revision}</dd><dt>{t('实际种子来源','Seed source')}</dt><dd>{props.selectedArtwork.resolvedSeedSource??t('未返回','Not returned')}</dd></>}</dl>
      {props.receipts.length>0&&<div className="r4-receipts"><strong>{t('可撤销操作','Reversible changes')}</strong>{props.receipts.map(receipt=><div key={receipt.id} className={`r4-receipt r4-receipt-${receipt.status}`}><span>{receipt.operation} · {receipt.status==='applied'?t('已应用','applied'):receipt.status==='conflict'?t('发生冲突','conflict'):t('未应用','not applied')}</span>{receipt.status==='applied'&&<button type="button" disabled={disabled} onClick={()=>props.onUndo(receipt)}><LuRotateCcw/>{t('撤销','Undo')}</button>}{receipt.status==='conflict'&&<small>{t('当前输入已变化，此操作未撤销。','Inputs changed; this operation was not undone.')}</small>}</div>)}</div>}
      {latestExecution&&<div className="r4-latest-execution"><strong>{t('最近生成','Latest generation')}</strong><span>{latestExecution.status} · {latestExecution.expectedOutputCount} {t('张','outputs')}</span>{latestExecution.blockedReason&&<small>{latestExecution.blockedReason}</small>}</div>}
    </details>
  </aside>;
}

export function AgentR4ProposalCard(props: {language:unknown;proposal:R4Proposal;current:boolean;compact?:boolean;disabled?:boolean;generationDisabled?:boolean;onPrepare:()=>void;onSelect:()=>void;onApplyToWorkbench?:()=>void}) {
  const {language,proposal,current}=props;const t=(zh:string,en:string)=>r4Text(language,zh,en);
  return <article className={`r4-proposal-card${current?' is-current':''}${props.compact?' is-compact':''}`}>
    <header><div><strong>{proposal.title||`${t('方案','Proposal')} v${proposal.revision}`}</strong><span>v{proposal.revision}</span></div>{current&&<small><LuCheck/>{t('当前','Current')}</small>}</header>
    {proposal.change&&<p className="r4-proposal-change">{proposal.change}</p>}
    {proposal.summary&&<p className="r4-proposal-summary">{proposal.summary}</p>}
    {!!proposal.keywords.length&&<div className="r4-proposal-keywords">{proposal.keywords.slice(0,5).map((keyword,index)=><span key={`${keyword}-${index}`}>{keyword}</span>)}</div>}
    <details><summary>{t('查看完整词','View full prompts')}</summary><dl><dt>{t('正向提示词','Positive prompt')}</dt><dd>{proposal.positivePrompt||'—'}</dd><dt>{t('负向提示词','Negative prompt')}</dt><dd>{proposal.negativePrompt||'—'}</dd><dt>{t('风格提示词','Style prompt')}</dt><dd>{proposal.stylePrompt||'—'}</dd></dl></details>
    <footer><button type="button" className="r4-primary" disabled={props.disabled||props.generationDisabled} onClick={props.onPrepare}><LuSparkles/>{t('用此版本生成','Generate this version')}</button>{!current&&<button type="button" disabled={props.disabled} onClick={props.onSelect}><LuCheck/>{t('设为当前方案','Set as current')}</button>}{props.onApplyToWorkbench&&<button type="button" disabled={props.disabled} onClick={props.onApplyToWorkbench}><LuArrowDownToLine/>{t('应用到工作台','Apply to workbench')}</button>}</footer>
  </article>;
}

function ReferencePurposeMenu({language,disabled,onChoose}:{language:unknown;disabled:boolean;onChoose:(role:'reference'|'discussion',purpose?:R4ReferencePurpose)=>void}) {
  const t=(zh:string,en:string)=>r4Text(language,zh,en);
  return <label className="r4-purpose-menu"><span>{t('作为参考','Use as reference')}</span><select aria-label={t('参考用途','Reference purpose')} disabled={disabled} value="" onChange={event=>{if(event.target.value==='discussion')onChoose('discussion');else if(event.target.value)onChoose('reference',event.target.value as R4ReferencePurpose);event.target.value='';}}><option value="" disabled>{t('选择用途','Choose purpose')}</option><option value="discussion">{t('仅讨论','Discussion only')}</option>{purposes.map(item=><option key={item.value} value={item.value}>{t(item.zh,item.en)}</option>)}</select><LuChevronDown aria-hidden/></label>;
}

function PreviewSummary({language,preview,inputSnapshot,providerRef,requestEditSource,currentEditSource}:{language:unknown;preview:Record<string,unknown>;inputSnapshot:R4Preparation['inputSnapshot'];providerRef?:R4Preparation['providerRef'];requestEditSource?:R4AttachmentBinding|null;currentEditSource?:R4AttachmentBinding|null}) {
  const t=(zh:string,en:string)=>r4Text(language,zh,en);
  const operation=String(preview.operation??inputSnapshot.publicParameters.operation??'unknown');
  const operationLabel:Record<string,[string,string]>={generate_image:['文生图','Generate image'],redraw_image:['图生图','Redraw image'],inpaint_image:['局部重绘','Inpainting'],upscale_image:['放大','Upscale'],process_image:['图片处理','Image processing']};
  const operationName=operationLabel[operation]?t(...operationLabel[operation]!):operation==='unknown'?t('未知操作','Unknown operation'):operation;
  const referenceCount=inputSnapshot.references.filter(binding=>binding.includeInGeneration).length+(inputSnapshot.mask?1:0);
  const provider=providerRef?.providerId||t('未知服务商','Unknown provider');
  const account=providerRef?.accountRef||t('未知账号','Unknown account');
  const fields:Array<[string,string,string,unknown]>=[
    ['operation','操作类型','Operation',operationName],
    ['provider','图片渠道','Image provider',provider],
    ['account','图片账号','Image account',account],
    ['editMode','模式','Mode',preview.editMode],
    ['processOperation','处理方式','Processing',preview.processOperation],
    ['scale','放大倍率','Upscale factor',typeof preview.scale==='number'?`${preview.scale}×`:undefined],
    ['requestCount','服务请求数','Provider requests',preview.requestCount],
    ['model','模型','Model',preview.model],
    ['width','尺寸','Dimensions',preview.width&&preview.height?`${preview.width} × ${preview.height}`:undefined],
    ['count','数量','Image count',preview.count],
    ['estimatedAnlas','预计费用','Estimated cost',preview.estimatedAnlas],
    ['referenceCount','参与生成的参考/蒙版','Generation references / mask',referenceCount],
  ];
  const sourceLabel=(binding?:R4AttachmentBinding|null)=>binding?`${binding.name||binding.attachmentId} · r${binding.revision}`:t('无改图源','No edit source');
  return <dl className="r4-preview-summary">
    <div className="r4-preview-source-request"><dt>{t('本次任务改图源（冻结快照）','This request edit source (frozen snapshot)')}</dt><dd>{sourceLabel(requestEditSource)}</dd></div>
    <div className="r4-preview-source-current"><dt>{t('当前创作改图源','Current creation edit source')}</dt><dd>{sourceLabel(currentEditSource)}</dd></div>
    {fields.filter(([, , ,value])=>value!==undefined&&value!==null).map(([key,zh,en,value])=><div key={key}><dt>{t(zh,en)}</dt><dd>{typeof value==='object'?JSON.stringify(value):String(value)}</dd></div>)}
  </dl>;
}

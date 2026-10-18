import type {R4WorkbenchPromptPreview} from '../agent/r4-workbench-contract';
import {r4Text} from '../agent/r4-ui';

const fields=[
  {key:'positivePrompt',diffKey:'positivePromptChanged',zh:'正向提示词',en:'Positive prompt'},
  {key:'negativePrompt',diffKey:'negativePromptChanged',zh:'负向提示词',en:'Negative prompt'},
  {key:'stylePrompt',diffKey:'stylePromptChanged',zh:'风格提示词',en:'Style prompt'},
] as const;

export function AgentR4WorkbenchApplyPreview(props:{language:unknown;preview:R4WorkbenchPromptPreview;busy:boolean;onClose:()=>void;onApply:()=>void}) {
  const {language,preview,busy}=props;
  const t=(zh:string,en:string)=>r4Text(language,zh,en);
  const changed=fields.some(field=>preview.diff[field.diffKey]);
  const display=(value:string)=>value||t('（空）','(empty)');
  return <div className="r4-workbench-apply-preview">
    <p>{t('仅将此方案版本的三个提示词字段应用到当前图像工作台。工作台其他设置、当前创作和源图引用保持不变。','Only these three prompt fields from this proposal version will be applied to the live image workbench. Other workbench settings, the current creation, and its source bindings are untouched.')}</p>
    <p className="r4-workbench-apply-identity">{t('创作','Creation')} {preview.creationId} · {t('方案','Proposal')} v{preview.proposalRevision} · {t('工作台草稿修订','Workbench draft revision')} {preview.draftRevision}</p>
    <div className="r4-workbench-apply-fields">
      {fields.map(field=><section key={field.key} className={preview.diff[field.diffKey]?'is-changing':'is-unchanged'}>
        <header><strong>{t(field.zh,field.en)}</strong><span>{preview.diff[field.diffKey]?t('将更改','Will change'):t('保持不变','Unchanged')}</span></header>
        <div><small>{t('工作台当前值','Current workbench value')}</small><pre>{display(preview.before[field.key])}</pre></div>
        <div><small>{t('方案应用值','Value from proposal')}</small><pre>{display(preview.after[field.key])}</pre></div>
      </section>)}
    </div>
    {!changed&&<p className="r4-workbench-apply-no-change" role="status">{t('三个字段都与工作台相同，无需应用。','All three fields already match the workbench; nothing needs applying.')}</p>}
    <footer><button type="button" disabled={busy} onClick={props.onClose}>{t('返回','Back')}</button><button type="button" className="pi-primary" disabled={busy||!changed} onClick={props.onApply}>{busy?t('正在应用…','Applying…'):t('确认应用到工作台','Apply to workbench')}</button></footer>
  </div>;
}

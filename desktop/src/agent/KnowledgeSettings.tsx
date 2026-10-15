import {useEffect,useState} from 'react';
import type {KnowledgeSettings as Settings,KnowledgeStatus} from './knowledge';
import {defaultKnowledgeSettings} from './knowledge';
import {useFeatureText} from '../feature-i18n';
import '../worldpainter-api';

export function KnowledgeSettings({disabled=false}:{disabled?:boolean}) {
  const ft=useFeatureText();
  const [config,setConfig]=useState<Settings>(defaultKnowledgeSettings);
  const [status,setStatus]=useState<KnowledgeStatus>();
  const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const receive=(value:KnowledgeStatus)=>{setStatus(value);setConfig(value.settings);};
  useEffect(()=>{let active=true;void window.worldpainter.knowledgeStatus().then(value=>{if(active)receive(value);}).catch(error=>{if(active)setMessage(ft(error instanceof Error?error.message:String(error)));});return()=>{active=false;};},[ft]);
  const action=async(run:()=>Promise<void>)=>{setBusy(true);setMessage('');try{await run();}catch(error){setMessage(ft(error instanceof Error?error.message:String(error)));}finally{setBusy(false);}};
  const locked=disabled||busy;
  return <section className="wp-knowledge" aria-label={ft('提示词知识库')}>
    <h3>{ft('提示词知识库')}</h3><p className="pi-muted">{ft('按当前输入匹配参考；每次最多 5 条、正文合计 2,000 字符。')}</p>
    <label>{ft('提示词版本')}<select aria-label={ft('知识库提示词版本')} value={config.version} disabled={locked} onChange={event=>setConfig({...config,version:event.target.value as Settings['version']})}><option value="v45">NovelAI V4.5</option><option value="v5">NovelAI V5</option></select></label>
    <label>{ft('V4.5 默认画风词')}<textarea aria-label={ft('V4.5 默认画风词')} rows={3} maxLength={12000} value={config.v45StyleWords} disabled={locked} onChange={event=>setConfig({...config,v45StyleWords:event.target.value})}/></label>
    <label>{ft('V5 默认画风词')}<textarea aria-label={ft('V5 默认画风词')} rows={3} maxLength={12000} value={config.v5StyleWords} disabled={locked} onChange={event=>setConfig({...config,v5StyleWords:event.target.value})}/></label>
    <label>{ft('外部知识库 JSON 路径')}<input aria-label={ft('外部知识库 JSON 路径')} placeholder={ft('留空使用内置知识库')} value={config.path} disabled={locked} onChange={event=>setConfig({...config,path:event.target.value})}/></label>
    <div className="wp-knowledge-actions">
      <button className="btn" disabled={locked} onClick={()=>void action(async()=>{const selected=await window.worldpainter.chooseKnowledgeFile();if(selected)setConfig({...config,path:selected});})}>{ft('选择文件')}</button>
      <button className="btn btn-primary" disabled={locked} onClick={()=>void action(async()=>{receive(await window.worldpainter.saveKnowledgeSettings(config));setMessage(ft('知识库设置已保存，下次发送使用新设置。'));})}>{ft('校验并保存')}</button>
      <button className="btn" disabled={locked} onClick={()=>void action(async()=>{receive(await window.worldpainter.reloadKnowledge());setMessage(ft('已按保存的路径重新加载。'));})}>{ft('重新加载')}</button>
    </div>
    {status&&<div className="pi-muted"><p>{ft(status.source==='bundled'?'内置知识库':'外部知识库')} · {ft('{count} 条',{count:status.entries.toLocaleString()})}</p><details><summary>{ft('来源与校验信息')}</summary><p className="wp-break-path">{status.activePath}</p><p className="wp-break-path">{ft('SHA-256：{hash}',{hash:status.sha256})}</p></details>{status.warning&&<p role="status">{ft(status.warning)}</p>}</div>}
    {message&&<p role="status">{message}</p>}
  </section>;
}

import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, CommittedNumberInput, SelectMenu } from '../../src/components/ui';
import { EffortControl } from '../../src/components/EffortControl';
import { ResolutionPicker } from '../../src/components/CompactPromptControls';
import { NAI_MODELS, type NAIEffort } from '../../src/types';
import '../../src/styles.css';
import '../../src/layout-motion.css';
import '../../src/studio-interactions.css';
import '../../src/studio-typography.css';
import '../../src/studio-controls.css';
import '../../src/typography.css';
import './prototype.css';

type Page = '生成' | '重绘' | 'Agent' | '漫画' | '素材' | '创作' | '设置';
type Draft = { positive: string; negative: string; artist: string; seed: number; model: string; width: number; height: number; effort: NAIEffort };
const emptyDraft = (): Draft => ({ positive:'', negative:'lowres, blurry', artist:'', seed:4242, model:'nai-diffusion-5-full', width:832, height:1216, effort:'high' });
const clampSize = (value: number) => Math.max(64, Math.min(4096, Math.round(value/64)*64));
const pages: Page[] = ['生成','重绘','Agent','漫画','素材','创作','设置'];
function Prototype() {
  const [dark, setDark] = useState(true), [proposal, setProposal] = useState(true), [accountOpen, setAccountOpen] = useState(false);
  const [page, setPage] = useState<Page>('生成'), [drafts, setDrafts] = useState<Partial<Record<Page,Draft>>>({});
  const [status, setStatus] = useState('在正向提示词输入内容，切换页面和方案后再回来检查草稿。');
  const [phase, setPhase] = useState<'idle'|'confirm'|'running'|'done'>('idle');
  const [history, setHistory] = useState<Draft[]>([]), [selected, setSelected] = useState<number|null>(null);
  const [image, setImage] = useState(''), [brush, setBrush] = useState('绘制'), [mask, setMask] = useState(false);
  const [agentText, setAgentText] = useState(''), [messages, setMessages] = useState<string[]>([]);
  const [agentConfirm, setAgentConfirm] = useState(false);
  const draft = drafts[page] ?? emptyDraft();
  const patch = (next: Partial<Draft>) => setDrafts(all => ({...all,[page]:{...(all[page]??emptyDraft()),...next}}));
  useEffect(()=>{document.documentElement.classList.toggle('theme-dark',dark);},[dark]);
  useEffect(()=>{
    if(phase!=='running')return;
    const timer=setTimeout(()=>{setPhase('done');setHistory(items=>[{...draft},...items]);setStatus('演示结果已加入本页内存历史。没有网络请求或文件写入。');},1200);
    return()=>clearTimeout(timer);
  },[phase]);
  const params=<section className="proto-fields" aria-label="生成参数">
    <label>模型<SelectMenu ariaLabel="模型" value={draft.model} options={NAI_MODELS.map(m=>({value:m.value,label:m.label}))} onChange={model=>patch({model})}/></label>
    <EffortControl model={draft.model} value={draft.effort} language="zh-CN" onChange={effort=>patch({effort})}/>
    <label>画师串 / 风格提示词<input value={draft.artist} onChange={e=>patch({artist:e.target.value})} placeholder="artist:example（示例，不调用模型）"/></label>
    <ResolutionPicker width={draft.width} height={draft.height} language="zh-CN" onChange={patch}>
      <CommittedNumberInput label="宽度" value={draft.width} min={64} max={4096} step={64} normalize={clampSize} onCommit={width=>patch({width})}/>
      <CommittedNumberInput label="高度" value={draft.height} min={64} max={4096} step={64} normalize={clampSize} onCommit={height=>patch({height})}/>
    </ResolutionPicker>
    <CommittedNumberInput label="Seed（固定）" value={draft.seed} min={0} max={4294967295} normalize={v=>Math.max(0,Math.min(4294967295,Math.round(v)))} onCommit={seed=>patch({seed})}/>
  </section>;
  const prompts=<section className="proto-prompts" aria-label="提示词编辑">
    <label>正向提示词 <small>页面草稿 · {draft.positive.length} 字</small><textarea aria-label="正向提示词" rows={5} value={draft.positive} onChange={e=>patch({positive:e.target.value})} placeholder="先描述画面，例如：blue geometric square, soft light…"/></label>
    <label>负向提示词<textarea aria-label="负向提示词" rows={2} value={draft.negative} onChange={e=>patch({negative:e.target.value})}/></label>
    <div className="proto-minibar"><Button variant="ghost" onClick={()=>{patch({positive:draft.positive+', soft light'});setStatus('追加了示例词；可在输入框使用系统文本撤销。');}}>＋ 示例词</Button><small>参考图 0 · 角色 0</small></div>
  </section>;
  return <div className="proto-shell">
    <div className="proto-review"><strong>交互原型 · 待确认</strong><span>所有生成、Agent、图库均为内存模拟；无业务 IPC、付费调用或真实工作区访问。</span><div><Button aria-pressed={!proposal} variant={!proposal?'primary':'secondary'} onClick={()=>{setProposal(false);setAccountOpen(true);}}>A 参数在前</Button><Button aria-pressed={proposal} variant={proposal?'primary':'secondary'} onClick={()=>{setProposal(true);setAccountOpen(false);}}>B 提示词在前</Button><Button onClick={()=>setDark(v=>!v)}>{dark?'切换浅色':'切换深色'}</Button></div></div>
    <header className="proto-header"><strong>◈ 绘世 · NAI WorldPainter</strong><span>工作台方案比较</span><Button onClick={()=>{setAccountOpen(v=>!v);setStatus('账户区折叠不改变提示词或页面草稿。');}} aria-expanded={accountOpen}>未配置账户 {accountOpen?'收起 ▴':'展开 ▾'}</Button></header>
    {accountOpen&&<section className="proto-account"><strong>生成账户 · 未连接</strong><span>此原型不接受密钥。产品仍保留账户入口；方案 B 默认压缩账户信息。</span><Button onClick={()=>setStatus('账户管理为演示入口；不读取或保存账户。')}>账户管理（演示）</Button></section>}
    <nav className="proto-nav" aria-label="原型页面">{pages.map(p=><Button key={p} aria-pressed={page===p} variant={page===p?'primary':'ghost'} onClick={()=>{setPage(p);setStatus(`已切换到${p}，各页输入保留在本次打开的原型内。`);}}>{p}</Button>)}</nav>
    <main className="proto-workspace">
      {(page==='生成'||page==='重绘')?<>
        <aside className="proto-editor"><header><h2>{page==='生成'?'文生图 / 图生图':'局部重绘'}</h2><small>{proposal?'B · 提示词优先，参数继续向下滚动':'A · 参数优先，保留较高账户区'}</small></header><div className="proto-scroll">{proposal?<>{prompts}{params}</>:<>{params}{prompts}</>}</div><footer><span>未连接 · 演示不计费</span><Button variant="primary" disabled={phase==='running'} onClick={()=>{setPhase('confirm');setStatus('请确认演示任务，或取消。');}}>生成演示</Button></footer></aside>
        <section className="proto-preview"><header><h2>{page==='重绘'?'蒙版编辑（模拟）':'画面预览'}</h2><span>{draft.width} × {draft.height} · Seed {draft.seed}</span></header>
          {page==='重绘'&&<div className="proto-minibar"><label className="proto-upload">导入本地预览<input type="file" accept="image/*" onChange={e=>{const f=e.target.files?.[0];if(f){const r=new FileReader();r.onload=()=>{setImage(String(r.result));setStatus('仅在此页内存中显示所选图片，未保存。');};r.readAsDataURL(f);}}}/></label>{['绘制','擦除'].map(b=><Button key={b} aria-pressed={brush===b} onClick={()=>setBrush(b)}>{b}</Button>)}<Button onClick={()=>setMask(false)}>撤销蒙版演示</Button></div>}
          <div className={'proto-canvas '+(mask?'proto-mask':'')} onClick={()=>{if(page==='重绘'){setMask(brush==='绘制');setStatus('蒙版仅演示绘制/擦除状态，不代表真实重绘编辑器。');}}}>{image&&page==='重绘'?<img src={image} alt="本地预览"/>:phase==='done'?<div className="proto-result"><div/> <strong>合成示例</strong><small>没有生成真实图片</small></div>:<div className="proto-empty"><b>✦</b><h2>{phase==='running'?'正在运行演示…':'从提示词开始创作'}</h2><p>{page==='重绘'?'点击画布切换蒙版演示，或导入本地预览。':'左侧保留文字，右侧保留预览与历史。'}</p></div>}</div>
          {phase==='confirm'&&<div className="proto-confirm" role="status"><strong>确认演示任务</strong><span>使用当前输入生成一个几何图形占位结果。</span><Button onClick={()=>{setPhase('idle');setStatus('已取消演示，草稿保留。');}}>取消</Button><Button variant="primary" onClick={()=>setPhase('running')}>确认演示</Button></div>}
          {phase==='running'&&<Button onClick={()=>{setPhase('idle');setStatus('已停止演示，草稿保留。');}}>停止演示</Button>}
        </section>
        <aside className="proto-history"><h2>历史与素材</h2><span className="proto-badge">本次原型 · {history.length}</span>{!history.length?<p>暂无演示结果。<br/>生成后在此查看与回填。</p>:history.map((item,i)=><Button key={i} onClick={()=>setSelected(i)}><span className="proto-thumb"/><span>合成示例 {history.length-i}<small>Seed {item.seed}</small></span></Button>)}{selected!==null&&history[selected]&&<div className="proto-meta"><h3>示例元数据</h3><p>{history[selected].positive||'（空正向）'}</p><small>{history[selected].model}</small><Button onClick={()=>{patch(history[selected!]);setStatus('已回填所选演示参数；不会清空真实参考图。');}}>回填本页草稿</Button></div>}</aside>
      </>:page==='Agent'?<section className="proto-page proto-agent"><header><h2>生图智能体</h2><span>模拟模型 · 每次确认</span></header><div className="proto-messages">{messages.length?messages.map((m,i)=><p key={i}>{m}</p>):<p>输入想法，再体验确认与取消。这里不会连接任何模型。</p>}{agentConfirm&&<div className="proto-confirm"><strong>准备步骤已模拟</strong><span>是否确认这份模拟方案？</span><Button onClick={()=>{setAgentConfirm(false);setStatus('已取消模拟方案，Agent 草稿仍保留。');}}>取消</Button><Button onClick={()=>{setAgentConfirm(false);setMessages(m=>[...m,'助手：示例方案已确认，可以继续编辑。']);}}>确认模拟</Button></div>}</div><label>Agent 草稿<textarea aria-label="Agent 草稿" value={agentText} onChange={e=>setAgentText(e.target.value)} placeholder="切换页面后返回，草稿仍在。"/></label><Button variant="primary" onClick={()=>{if(!agentText.trim()){setStatus('请先输入想法。');return;}setMessages(m=>[...m,'你：'+agentText]);setAgentConfirm(true);}}>准备模拟方案</Button></section>:page==='设置'?<section className="proto-page"><h2>外观与草稿</h2><p>深色沿用暖金，浅色沿用白蓝。切换不会清除本次原型的页面草稿。</p><Button onClick={()=>setDark(v=>!v)}>切换{dark?'浅色':'深色'}</Button><p>所有输入只在内存中保留；刷新或关闭原型后清除。产品草稿持久化策略尚待确认。</p></section>:<section className="proto-page"><h2>{page}</h2><p>{page==='漫画'?'分镜与页面组织入口示意。':page==='素材'?'素材筛选与导入入口示意。':'创作项目入口示意。'}功能细节未在本原型实现。</p><label>{page}草稿<textarea aria-label={page+'草稿'} value={draft.positive} onChange={e=>patch({positive:e.target.value})} placeholder="输入内容，切换页面后回来验证保留"/></label><Button onClick={()=>setStatus(`${page}入口已响应（模拟），没有写入文件。`)}>打开{page}（演示）</Button></section>}
    </main><div className="proto-status" role="status">{status}</div>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Prototype/>);

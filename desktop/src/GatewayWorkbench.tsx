import { useEffect, useMemo, useRef, useState } from 'react';
import type { GenerateParams, ModelMode } from './types';
import type { GatewayDraftFeatures, GatewayJobResult, GatewayPlanPreview, GatewayProfile, GatewayProfileInput, GatewayProtocol, GatewayWorkbenchApi } from './gateway-workbench';
import { useFeatureText } from './feature-i18n';
import './gateway-workbench.css';

const DEFAULT_BASE: Record<GatewayProtocol, string> = {
  gateway7877: '',
  ikun: 'https://novelai.ikun114.top',
};

export interface GatewayWorkbenchProps {
  api: GatewayWorkbenchApi;
  /** Snapshot of the live绘世 text-to-image controls; a prepared plan is invalidated on change. */
  draft: GenerateParams;
  operation: 'textToImage' | 'imageToImage' | 'inpaint' | null;
  modelMode?: ModelMode;
  features?: GatewayDraftFeatures;
  disabled?: boolean;
  onHistoryAdded?: () => void;
}

export function GatewayWorkbench({ api, draft, operation, modelMode = 'anime', features, disabled = false, onHistoryAdded }: GatewayWorkbenchProps) {
  const ft = useFeatureText();
  const [profiles, setProfiles] = useState<GatewayProfile[]>([]);
  const [protocol, setProtocol] = useState<GatewayProtocol>('gateway7877');
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE.gateway7877);
  const [token, setToken] = useState('');
  const [plan, setPlan] = useState<GatewayPlanPreview>();
  const [planFingerprint, setPlanFingerprint] = useState('');
  const [result, setResult] = useState<GatewayJobResult>();
  const [busy, setBusy] = useState(false);
  const [runningPlanId, setRunningPlanId] = useState('');
  const [removing, setRemoving] = useState('');
  const [message, setMessage] = useState('');
  const apiRef = useRef(api);
  apiRef.current = api;

  const selected = profiles.find((profile) => profile.selected);
  const currentOperation = operation ?? undefined;
  const fingerprint = useMemo(() => JSON.stringify({ draft, operation: currentOperation, modelMode, features, profileId: selected?.id }), [draft, currentOperation, modelMode, features, selected?.id]);
  useEffect(() => {
    let active = true;
    void apiRef.current.listProfiles().then((value) => { if (active) setProfiles(value); }).catch((error) => {
      if (active) setMessage(ft(error instanceof Error ? error.message : String(error)));
    });
    return () => { active = false; };
  }, [ft]);
  useEffect(() => {
    if (plan && planFingerprint !== fingerprint) {
      setPlan(undefined);
      setPlanFingerprint('');
      setMessage(ft('绘世草稿或网关档案已变化；请重新预览本次参数计划。'));
    }
  }, [fingerprint, ft, plan, planFingerprint]);

  const locked = disabled || busy;
  const action = async (run: () => Promise<void>) => {
    setBusy(true);
    setMessage('');
    try { await run(); }
    catch (error) { setMessage(ft(error instanceof Error ? error.message : String(error))); }
    finally { setBusy(false); }
  };

  const addProfile = () => action(async () => {
    const input: GatewayProfileInput = { name: name.trim() || ft(protocol === 'gateway7877' ? '绘世 7877 网关' : '绘世 ikun 网关'), protocol, baseUrl, token };
    setProfiles(await api.addProfile(input));
    setToken('');
    setName('');
    setPlan(undefined);
    setResult(undefined);
    setMessage(ft('网关档案已保存并选中；令牌由系统凭据加密保存。'));
  });

  const preview = () => action(async () => {
    if (!selected) throw new Error(ft('请先添加并选择一个网关档案。'));
    if (!currentOperation) throw new Error(ft('绘世没有传入当前生成模式；已阻止提交以避免把其他模式误发成文生图。'));
    setResult(undefined);
    const next = await api.prepare({ profileId: selected.id, operation: currentOperation, draft, modelMode, features });
    setPlan(next);
    setPlanFingerprint(fingerprint);
    setMessage(ft('参数计划已生成；核对请求地址、提示词和参数后，再明确确认提交。'));
  });

  const generate = () => {
    if (!plan || planFingerprint !== fingerprint || busy) return;
    const current = plan;
    void action(async () => {
      setRunningPlanId(current.planId);
      try {
        const outcome = await api.generate({ planId: current.planId, confirmed: true });
        setResult(outcome);
        setMessage(ft(outcome.message));
        if (outcome.status === 'succeeded') onHistoryAdded?.();
      } finally {
        setRunningPlanId('');
      }
    });
  };

  const cancel = () => {
    const id = runningPlanId;
    if (!id) return;
    void api.cancel(id).then((outcome) => setMessage(ft(outcome.message))).catch((error) => setMessage(ft(error instanceof Error ? error.message : String(error))));
  };

  const chooseProtocol = (next: GatewayProtocol) => {
    setProtocol(next);
    setBaseUrl(DEFAULT_BASE[next]);
  };

  return <section className="wp-gateway" aria-label={ft('绘世网关工作台')}>
    <header className="wp-gateway-header">
      <div><h3>{ft('绘世网关工作台')}</h3><p>{ft('独立管理 7877 / ikun 网关凭据；每次请求先预览、再确认。')}</p></div>
      {selected && <span className="wp-gateway-chip">{ft('当前：{name} · {protocol}', { name: selected.name, protocol: selected.protocol === 'gateway7877' ? '7877' : 'ikun' })}</span>}
    </header>

    <details className="wp-gateway-capabilities" open>
      <summary>{ft('当前支持范围')}</summary>
      <p>{ft('此入口只发送纯文生图。图生图、局部重绘、Vibe、精准参考、角色提示、透明背景、SMEA 和 Variety+ 暂不支持；遇到这些当前草稿会阻止提交，不会静默省略。请在绘世主工作台完成这些操作。')}</p>
      <p>{ft('生成请求提交后不自动重试；取消只停止本地等待，服务端可能继续处理。失败、超时或返回格式不完整时，请先核对网关记录和绘世输出目录。')}</p>
    </details>

    <div className="wp-gateway-profile-grid">
      <section className="wp-gateway-profiles" aria-label={ft('已保存的网关档案')}>
        <h4>{ft('网关档案')}</h4>
        {profiles.length === 0 && <p className="pi-muted">{ft('尚未保存网关凭据。')}</p>}
        {profiles.map((profile) => <article className={`wp-gateway-profile${profile.selected ? ' is-selected' : ''}`} key={profile.id}>
          <div><strong>{profile.name}</strong><small>{ft('{protocol} 网关 · {baseUrl}', { protocol: profile.protocol === 'gateway7877' ? '7877' : 'ikun', baseUrl: profile.baseUrl })}</small></div>
          <div className="wp-gateway-actions">
            {!profile.selected && <button className="btn" disabled={locked} onClick={() => void action(async () => { setProfiles(await api.selectProfile(profile.id)); setPlan(undefined); setResult(undefined); })}>{ft('选择')}</button>}
            {removing === profile.id
              ? <><span className="wp-gateway-remove-confirm">{ft('确认删除此档案和令牌？')}</span><button className="btn" disabled={locked} onClick={() => void action(async () => { setProfiles(await api.removeProfile(profile.id)); setRemoving(''); setPlan(undefined); setResult(undefined); })}>{ft('确认删除')}</button><button className="btn" disabled={locked} onClick={() => setRemoving('')}>{ft('取消')}</button></>
              : <button className="btn" disabled={locked} onClick={() => setRemoving(profile.id)}>{ft('删除')}</button>}
          </div>
        </article>)}
      </section>

      <section className="wp-gateway-add" aria-label={ft('添加或更新网关档案')}>
        <h4>{ft('添加或更新档案')}</h4>
        <label>{ft('协议')}<select value={protocol} disabled={locked} onChange={(event) => chooseProtocol(event.target.value as GatewayProtocol)}>
          <option value="gateway7877">{ft('7877 网关')}</option><option value="ikun">{ft('ikun 网关')}</option>
        </select></label>
        <label>{ft('显示名称')}<input value={name} maxLength={120} disabled={locked} placeholder={ft(protocol === 'gateway7877' ? '绘世 7877 网关' : '绘世 ikun 网关')} onChange={(event) => setName(event.target.value)} /></label>
        <label>{ft('服务根地址')}<input value={baseUrl} maxLength={2048} disabled={locked} placeholder="https://gateway.example" autoComplete="url" onChange={(event) => setBaseUrl(event.target.value)} /></label>
        <label>{ft('独立网关令牌')}<input type="password" value={token} maxLength={16384} disabled={locked} autoComplete="new-password" onChange={(event) => setToken(event.target.value)} /></label>
        <button className="btn btn-primary" disabled={locked || !token.trim() || !baseUrl.trim()} onClick={() => void addProfile()}>{ft('加密保存并选中')}</button>
        <small>{ft('令牌保存在独立的系统加密档案中，不进入官方账户列表或绘世历史。')}</small>
      </section>
    </div>

    <section className="wp-gateway-plan" aria-label={ft('文生图参数计划')}>
      <div className="wp-gateway-plan-title"><div><h4>{ft('当前文生图草稿')}</h4><p className="pi-muted">{ft('读取绘世当前参数；预览后若草稿、协议或档案变化，需重新确认。')}</p></div>
        <button className="btn" disabled={locked || !selected || currentOperation !== 'textToImage'} onClick={() => void preview()}>{ft('预览参数计划')}</button>
      </div>
      {plan && <div className="wp-gateway-plan-body">
        <dl><dt>{ft('网关')}</dt><dd>{ft('{protocol} 网关', { protocol: plan.protocol === 'gateway7877' ? '7877' : 'ikun' })} · {plan.profileName}</dd><dt>{ft('请求地址')}</dt><dd><code>{plan.endpoint}</code></dd>
          <dt>{ft('模型与画布')}</dt><dd>{plan.model} · {plan.width} × {plan.height}</dd>
          <dt>{ft('采样参数')}</dt><dd>{ft('{steps} steps · CFG {scale} · CFG Rescale {cfgRescale} · {sampler} · {noiseSchedule} · seed {seed}', { steps: plan.steps, scale: plan.scale, cfgRescale: plan.cfgRescale, sampler: plan.sampler, noiseSchedule: plan.noiseSchedule, seed: plan.seed })}</dd>
          <dt>{ft('正向提示词')}</dt><dd><pre>{plan.prompt}</pre></dd><dt>{ft('负向提示词')}</dt><dd><pre>{plan.negativePrompt || ft('（空）')}</pre></dd></dl>
        <details><summary>{ft('查看将发送的完整网关参数')}</summary><pre>{JSON.stringify(plan.requestPayload, null, 2)}</pre></details>
        <p className="wp-gateway-confirm-note">{ft('计划将在 {time} 过期。确认后绘世会向此地址提交一次请求；不查询余额、不自动重试。', { time: new Date(plan.expiresAt).toLocaleTimeString() })}</p>
        <button className="btn btn-primary" disabled={locked || !!runningPlanId || planFingerprint !== fingerprint} onClick={generate}>{ft('我已核对计划，确认并生成')}</button>
      </div>}
      {!plan && <button className="btn btn-primary" disabled={locked || !selected || currentOperation !== 'textToImage'} onClick={() => void preview()}>{ft('读取当前草稿并预览')}</button>}
      {currentOperation && currentOperation !== 'textToImage' && <p className="wp-gateway-message">{ft('当前主工作台为{mode}；此网关入口不会把它改发成文生图。', { mode: currentOperation === 'imageToImage' ? ft('图生图') : ft('局部重绘') })}</p>}
      {!currentOperation && <p className="wp-gateway-message">{ft('没有收到当前生成模式，已禁用网关提交以防参数被降级。')}</p>}
    </section>

    {runningPlanId && <div className="wp-gateway-running" role="status"><span>{ft('已提交网关请求，正在等待结果；不要重复提交。')}</span><button className="btn" onClick={cancel}>{ft('停止本地等待')}</button></div>}
    {message && <p className="wp-gateway-message" role="status">{message}</p>}
    {result && <section className={`wp-gateway-result is-${result.status}`} aria-label={ft('网关生成结果')}>
      <strong>{ft(result.status === 'succeeded' ? '已完成' : result.status === 'failed' ? '请求失败' : '完成状态不确定')}</strong><p>{ft(result.message)}</p>
      {result.items?.map((item) => <figure key={item.id}><img src={item.fileUrl} alt={ft('网关生成结果')}/><figcaption>{item.filePath}</figcaption></figure>)}
    </section>}
  </section>;
}

import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AgentDiscoveredModel, AgentModelDiscoveryResult, AgentProviderProbe } from '../src/agent/types';
import {
  agentProviderSettingsPatch,
  getAgentProviderRegistry,
  normalizeAgentProviderRegistry,
  selectAgentProviderModel,
  type AgentProviderRegistry,
} from '../src/agent/provider-profiles';
import { AgentModelPicker, safeAgentProviderLabel } from '../src/components/AgentModelPicker';
import { AgentProviderSettings } from '../src/components/AgentProviderSettings';
import { StartupScreen } from '../src/components/StartupScreen';
import { useAppStore } from '../src/store';
import type { AppSettings, NaiDesktopApi, SettingKey } from '../src/types';
import '../src/styles.css';
import '../src/pi-agent-page.css';

type QaTab = 'startup' | 'settings' | 'switcher';
type QaTheme = 'light' | 'dark';

const providerAUrl = 'https://provider-a.invalid/v1';
const providerAModelKey = `openai-compatible|${providerAUrl}`;
const initialRegistry: AgentProviderRegistry = {
  version: 1,
  activeProviderId: 'qa-provider-a',
  providers: [{
    id: 'qa-provider-a',
    name: '供应商 A',
    protocol: 'openai-compatible',
    baseUrl: providerAUrl,
    apiKey: '',
    modelId: 'shared-chat',
    models: [{
      providerKey: providerAModelKey,
      id: 'shared-chat',
      displayName: 'shared-chat',
      contextWindow: 128_000,
      maxOutputTokens: 8_192,
      reasoningEffort: 'auto',
      vision: false,
    }],
  }],
};

const discoveryFixture: AgentDiscoveredModel[] = [
  {
    id: 'shared-chat',
    displayName: 'shared-chat',
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    suggestedOutputTokens: 8_192,
    vision: false,
    reasoning: true,
    metadataSource: 'api',
  },
  {
    id: 'vision-demo',
    displayName: 'vision-demo',
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    suggestedOutputTokens: 8_192,
    vision: true,
    reasoning: true,
    metadataSource: 'api',
  },
];

// This page intentionally persists only in this module's memory. Reloading restores fixture A.
let persistedSettings = {
  language: 'zh-CN' as const,
  agentProviders: initialRegistry,
  ...agentProviderSettingsPatch(initialRegistry),
} as AppSettings;

const mockGetSettings: NaiDesktopApi['getSettings'] = async () => ({
  ...persistedSettings,
  agentProviders: normalizeAgentProviderRegistry(persistedSettings.agentProviders),
});

const mockSetSetting: NaiDesktopApi['setSetting'] = async <K extends SettingKey>(key: K, value: AppSettings[K]) => {
  if (key === 'agentProviders') {
    const registry = normalizeAgentProviderRegistry(value);
    persistedSettings = {
      ...persistedSettings,
      agentProviders: registry,
      ...agentProviderSettingsPatch(registry),
    } as AppSettings;
  } else {
    persistedSettings = { ...persistedSettings, [key]: value };
  }
  return persistedSettings[key];
};

const mockDiscoverAgentModels: NaiDesktopApi['discoverAgentModels'] = async (_probe: AgentProviderProbe): Promise<AgentModelDiscoveryResult> => ({
  ok: true,
  message: '本地模拟模型列表',
  models: discoveryFixture.map(model => ({ ...model })),
});

const mockDesktopApi = {
  getSettings: mockGetSettings,
  setSetting: mockSetSetting,
  discoverAgentModels: mockDiscoverAgentModels,
} satisfies Pick<NaiDesktopApi, 'getSettings' | 'setSetting' | 'discoverAgentModels'>;

Object.defineProperty(window, 'naiDesktop', { configurable: true, value: mockDesktopApi });

async function refreshQaSettings() {
  persistedSettings = await window.naiDesktop.getSettings();
  useAppStore.setState({ settings: persistedSettings });
}

useAppStore.setState({ settings: persistedSettings, refreshSettings: refreshQaSettings });

function QaApp() {
  const settings = useAppStore(state => state.settings) ?? persistedSettings;
  const registry = useMemo(() => getAgentProviderRegistry(settings), [settings]);
  const [tab, setTab] = useState<QaTab>('startup');
  const [theme, setTheme] = useState<QaTheme>('light');
  const activeProvider = registry.providers.find(provider => provider.id === registry.activeProviderId);
  const activeModel = activeProvider?.models.find(model => model.id === activeProvider.modelId);
  const providerLabel = activeProvider
    ? safeAgentProviderLabel(activeProvider.name, activeProvider.baseUrl, activeProvider.apiKey, '未选择')
    : '未选择';
  const modelLabel = activeProvider && activeModel
    ? safeAgentProviderLabel(activeModel.displayName, activeProvider.baseUrl, activeProvider.apiKey, '未选择')
    : '未选择';

  useEffect(() => {
    document.documentElement.classList.toggle('theme-dark', theme === 'dark');
    return () => document.documentElement.classList.remove('theme-dark');
  }, [theme]);

  const chooseModel = async (providerId: string, modelId: string) => {
    const next = selectAgentProviderModel(getAgentProviderRegistry(persistedSettings), providerId, modelId);
    await window.naiDesktop.setSetting('agentProviders', next);
    await useAppStore.getState().refreshSettings();
  };

  const pickerProps = {
    registry,
    onSelect: chooseModel,
    onManage: () => setTab('settings'),
    disabled: false,
    language: settings.language,
  };

  return (
    <div className="agent-provider-qa">
      <header className="agent-provider-qa__header">
        <div className="agent-provider-qa__brand">
          <span className="agent-provider-qa__mark" aria-hidden="true">绘</span>
          <div>
            <strong>绘世 · Agent Provider UI</strong>
            <small>临时前端验收入口</small>
          </div>
        </div>
        <nav className="agent-provider-qa__nav" aria-label="验收页面">
          {([
            ['startup', '启动屏'],
            ['settings', '模型设置'],
            ['switcher', '模型切换'],
          ] as const).map(([id, label]) => (
            <button key={id} type="button" aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </nav>
        <button
          type="button"
          className="agent-provider-qa__theme"
          aria-label={theme === 'dark' ? '切换浅色主题' : '切换深色主题'}
          onClick={() => setTheme(value => value === 'dark' ? 'light' : 'dark')}
        >
          {theme === 'dark' ? '☀ 浅色' : '☾ 深色'}
        </button>
      </header>

      <div className="agent-provider-qa__notice" role="note">
        前端组件验收 · 本地模拟数据 · 不代表 Windows 原生验收
      </div>

      <main className="agent-provider-qa__main">
        {tab === 'startup' && (
          <section className="agent-provider-qa__startup" aria-label="启动屏组件预览">
            <StartupScreen language="zh-CN" bootError={null} onRetry={() => undefined} />
          </section>
        )}

        {tab === 'settings' && (
          <section className="agent-provider-qa__panel">
            <div className="agent-provider-qa__section-heading">
              <div>
                <span className="agent-provider-qa__eyebrow">REAL COMPONENT</span>
                <h1>模型供应商设置</h1>
                <p>此页直接复用 AgentProviderSettings；保存只写入当前浏览器内存。</p>
              </div>
              <div className="agent-provider-qa__stats" aria-live="polite">
                <span>已保存供应商 <b>{registry.providers.length}</b></span>
                <span>当前供应商 <b>{providerLabel}</b></span>
                <span>模型 / Context <b>{modelLabel} · {activeModel?.contextWindow?.toLocaleString() ?? '—'}</b></span>
              </div>
            </div>
            <AgentProviderSettings settings={settings} onSaved={() => undefined} />
          </section>
        )}

        {tab === 'switcher' && (
          <section className="agent-provider-qa__panel agent-provider-qa__switcher">
            <span className="agent-provider-qa__eyebrow">ANCHORED MODEL PICKER</span>
            <h1>模型切换</h1>
            <p>选择服务商后查看该服务商保存的模型；相同模型 ID 仍按各自服务商独立切换。</p>
            <div className="agent-provider-qa__switcher-card">
              <AgentModelPicker {...pickerProps} />
              <div className="agent-provider-qa__current" aria-live="polite">
                <span>当前选择</span>
                <strong>{providerLabel} · {modelLabel}</strong>
                <small>Context window：{activeModel?.contextWindow?.toLocaleString() ?? '—'}</small>
              </div>
            </div>
            <p className="agent-provider-qa__hint">键盘可用：Enter / Space 打开，↑↓浏览服务商或模型，→进入模型列，←返回服务商列，Escape 关闭。</p>
          </section>
        )}
      </main>

      <aside className="agent-provider-qa__dock" aria-label="固定底部模型切换示例">
        <div className="agent-provider-qa__dock-label">
          <strong>固定底部 Picker 示例</strong>
          <span>{providerLabel} · {modelLabel}</span>
        </div>
        <AgentModelPicker {...pickerProps} />
      </aside>
      <style>{`
        .agent-provider-qa{height:100vh;min-height:0;display:grid;grid-template-rows:auto auto minmax(0,1fr);overflow:hidden;background:var(--bg-window);color:var(--text-primary)}
        .agent-provider-qa__header{position:relative;z-index:2;display:flex;align-items:center;gap:24px;min-height:66px;padding:10px 22px;border-bottom:1px solid var(--border);background:var(--bg-panel)}
        .agent-provider-qa__brand{display:flex;align-items:center;gap:10px;min-width:220px}.agent-provider-qa__brand>div{display:grid;gap:2px}.agent-provider-qa__brand strong{font-size:14px}.agent-provider-qa__brand small{color:var(--text-secondary);font-size:11px}
        .agent-provider-qa__mark{display:grid;place-items:center;width:34px;height:34px;border:1px solid var(--border-strong);border-radius:10px;background:var(--accent-soft);color:var(--accent);font-weight:800}
        .agent-provider-qa__nav{display:flex;align-items:center;gap:5px;flex:1}.agent-provider-qa__nav button,.agent-provider-qa__theme{min-height:36px;padding:7px 12px;border:1px solid transparent;border-radius:9px;background:transparent;color:var(--text-secondary);cursor:pointer}.agent-provider-qa__nav button:hover,.agent-provider-qa__theme:hover{background:var(--bg-hover);color:var(--text-primary)}.agent-provider-qa__nav button[aria-current=page]{border-color:var(--border);background:var(--bg-canvas);color:var(--accent);font-weight:650}.agent-provider-qa__theme{border-color:var(--border);white-space:nowrap}
        .agent-provider-qa__notice{position:relative;z-index:2;padding:8px 18px;background:var(--accent-soft);color:var(--text-primary);font-size:12px;font-weight:650;text-align:center}
        .agent-provider-qa__main{min-height:0;overflow:auto;padding:20px 22px 108px}.agent-provider-qa__startup{height:min(78vh,760px);min-height:560px;overflow:hidden;border:1px solid var(--border);border-radius:18px;background:var(--bg-panel)}.agent-provider-qa__startup .startup-screen{height:100%;min-height:0}
        .agent-provider-qa__panel{max-width:1180px;margin:0 auto;padding:22px;border:1px solid var(--border);border-radius:16px;background:var(--bg-panel);box-shadow:var(--shadow-sm,0 12px 30px rgba(30,20,60,.06))}.agent-provider-qa__section-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:18px}.agent-provider-qa__section-heading h1,.agent-provider-qa__switcher h1{margin:3px 0 5px;font-size:24px}.agent-provider-qa__section-heading p,.agent-provider-qa__switcher>p{margin:0;color:var(--text-secondary)}.agent-provider-qa__eyebrow{color:var(--accent);font-size:10px;font-weight:750;letter-spacing:.12em}
        .agent-provider-qa__stats{display:grid;gap:5px;min-width:min(360px,38vw);padding:12px 14px;border:1px solid var(--border);border-radius:12px;background:var(--bg-canvas);font-size:12px;color:var(--text-secondary)}.agent-provider-qa__stats span{display:flex;justify-content:space-between;gap:10px}.agent-provider-qa__stats b{color:var(--text-primary);text-align:right}
        .agent-provider-qa__switcher{min-height:340px}.agent-provider-qa__switcher-card{display:flex;align-items:center;gap:18px;flex-wrap:wrap;margin-top:26px;padding:20px;border:1px solid var(--border);border-radius:14px;background:var(--bg-canvas)}.agent-provider-qa__switcher-card>.agent-model-picker-trigger{min-width:280px}.agent-provider-qa__current{display:grid;gap:4px}.agent-provider-qa__current span,.agent-provider-qa__current small,.agent-provider-qa__hint{color:var(--text-secondary);font-size:12px}.agent-provider-qa__current strong{font-size:14px}.agent-provider-qa__hint{margin-top:18px}
        .agent-provider-qa__dock{position:fixed;z-index:var(--z-overlay-top,1000);right:0;bottom:0;left:0;display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:68px;padding:10px 18px;border-top:1px solid var(--border);background:color-mix(in srgb,var(--bg-panel) 94%,transparent);box-shadow:0 -8px 28px rgba(20,15,35,.08);backdrop-filter:blur(14px)}.agent-provider-qa__dock-label{display:grid;gap:3px;min-width:0}.agent-provider-qa__dock-label strong{font-size:12px}.agent-provider-qa__dock-label span{max-width:55vw;overflow:hidden;color:var(--text-secondary);font-size:11px;text-overflow:ellipsis;white-space:nowrap}.agent-provider-qa__dock>.agent-model-picker-trigger{min-width:min(360px,52vw)}
        @media(max-width:760px){.agent-provider-qa__header{flex-wrap:wrap;gap:8px;padding:9px 12px}.agent-provider-qa__brand{min-width:0;flex:1}.agent-provider-qa__nav{order:3;flex-basis:100%;overflow-x:auto}.agent-provider-qa__main{padding:12px 10px 100px}.agent-provider-qa__panel{padding:14px}.agent-provider-qa__section-heading{display:grid}.agent-provider-qa__stats{min-width:0}.agent-provider-qa__startup{height:620px;min-height:0}.agent-provider-qa__startup .startup-screen{grid-template-columns:1fr;grid-template-rows:200px minmax(0,1fr);gap:10px;padding:12px}.agent-provider-qa__startup .startup-screen__image-frame{width:auto;height:190px;aspect-ratio:3/4}.agent-provider-qa__startup .startup-screen__panel{min-height:0;padding:18px}.agent-provider-qa__dock{gap:8px;padding:8px 10px}.agent-provider-qa__dock-label{max-width:42vw}.agent-provider-qa__dock>.agent-model-picker-trigger{min-width:0;max-width:58vw}.agent-provider-qa__switcher-card>.agent-model-picker-trigger{min-width:min(280px,100%)}}
        @media(max-width:460px){.agent-provider-qa__dock-label span{display:none}.agent-provider-qa__dock>.agent-model-picker-trigger{max-width:65vw}.agent-provider-qa__section-heading h1,.agent-provider-qa__switcher h1{font-size:20px}}
      `}</style>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<QaApp />);

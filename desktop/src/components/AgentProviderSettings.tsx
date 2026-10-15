import { useState } from 'react';
import { LuCheck, LuNetwork, LuPlus, LuTrash2 } from 'react-icons/lu';
import type { AppSettings } from '../types';
import { AGENT_PROVIDER_PRESETS } from '../agent/provider-catalog';
import { agentProviderKey, newSavedAgentModel, normalizeSavedAgentModels } from '../agent/model-selections';
import { getAgentProviderRegistry, type AgentProviderProfile, type AgentProviderRegistry } from '../agent/provider-profiles';
import { studioUxText } from '../agent/ux';
import { useAppStore } from '../store';
import { AgentModelCollection } from './AgentModelCollection';
import { confirmAction } from './confirm';
import { SelectMenuCompat } from './ui';
import './agent-provider-settings.css';

function providerDraft(profile: AgentProviderProfile, language: AppSettings['language']): Partial<AppSettings> {
  const model = profile.models.find(item => item.id === profile.modelId);
  const connection = { agentApiProtocol: profile.protocol, agentApiBaseUrl: profile.baseUrl };
  return {
    ...connection, language, agentProviderName: profile.name, agentApiKey: profile.apiKey,
    agentApiModel: profile.modelId, savedAgentModels: profile.models.map(item => ({ ...item, providerKey: agentProviderKey(connection) })),
    agentContextWindow: model?.contextWindow ?? 128000, agentMaxOutputTokens: model?.maxOutputTokens ?? 8192,
    agentVisionEnabled: model?.vision ?? false, agentReasoningEffort: model?.reasoningEffort ?? 'auto',
  };
}

export function AgentProviderSettings({ settings, onSaved, onCancel, disabled = false }: {
  settings: AppSettings; onSaved?: () => void; onCancel?: () => void; disabled?: boolean;
}) {
  const [registry, setRegistry] = useState<AgentProviderRegistry>(() => getAgentProviderRegistry(settings));
  const [editorId, setEditorId] = useState(() => registry.activeProviderId || registry.providers[0]?.id || '');
  const [template, setTemplate] = useState('custom');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const t = (key: string, value = '') => studioUxText(settings.language, key, value);
  const locked = disabled || saving;
  const profile = registry.providers.find(item => item.id === editorId);
  const draft = profile ? providerDraft(profile, settings.language) : undefined;
  function change(next: AgentProviderRegistry) { setRegistry(next); setDirty(true); setMessage(''); setError(''); }
  function patchProfile(patch: Partial<AgentProviderProfile>) {
    if (!profile) return;
    change({ ...registry, providers: registry.providers.map(item => item.id === profile.id ? { ...item, ...patch } : item) });
  }
  function patchModel(patch: Partial<AppSettings>) {
    if (!profile || !draft) return;
    const modelId = patch.agentApiModel ?? profile.modelId;
    let models = patch.savedAgentModels ?? profile.models;
    models = models.map(model => model.id === modelId ? {
      ...model,
      ...(patch.agentContextWindow !== undefined ? { contextWindow: patch.agentContextWindow } : {}),
      ...(patch.agentMaxOutputTokens !== undefined ? { maxOutputTokens: patch.agentMaxOutputTokens } : {}),
      ...(patch.agentVisionEnabled !== undefined ? { vision: patch.agentVisionEnabled } : {}),
      ...(patch.agentReasoningEffort !== undefined ? { reasoningEffort: patch.agentReasoningEffort } : {}),
    } : model);
    patchProfile({ modelId, models });
  }
  function addProvider() {
    const preset = AGENT_PROVIDER_PRESETS.find(item => item.id === template)!;
    const connection = {
      agentApiProtocol: preset.protocol, agentApiBaseUrl: preset.baseUrl,
      agentContextWindow: preset.contextWindow, agentMaxOutputTokens: preset.maxOutputTokens, agentVisionEnabled: preset.vision,
    };
    const next: AgentProviderProfile = {
      id: crypto.randomUUID(), name: preset.id === 'custom' ? t('newProvider') : preset.providerName,
      protocol: preset.protocol, baseUrl: preset.baseUrl, apiKey: '', modelId: preset.model,
      models: preset.model ? [newSavedAgentModel(connection, { id: preset.model, displayName: preset.model })] : [],
    };
    change({ ...registry, activeProviderId: registry.activeProviderId || next.id, providers: [...registry.providers, next] });
    setEditorId(next.id);
  }
  async function removeProvider() {
    if (!profile || !await confirmAction(t('deleteProviderPrompt', profile.name), t('deleteProvider'))) return;
    const providers = registry.providers.filter(item => item.id !== profile.id);
    const activeProviderId = registry.activeProviderId === profile.id ? providers[0]?.id ?? '' : registry.activeProviderId;
    change({ ...registry, providers, activeProviderId });
    setEditorId(providers[0]?.id ?? '');
  }
  async function save() {
    if (locked) return;
    setError(''); setMessage('');
    const providers: AgentProviderProfile[] = [];
    for (const item of registry.providers) {
      if (!item.name.trim()) { setEditorId(item.id); setError(t('providerNameRequired')); return; }
      try {
        const url = new URL(item.baseUrl);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error();
      } catch { setEditorId(item.id); setError(t('providerAddressInvalid', item.name)); return; }
      const itemDraft = providerDraft(item, settings.language);
      const modelId = item.modelId.trim();
      const models = normalizeSavedAgentModels(itemDraft.savedAgentModels);
      if (modelId && !models.some(model => model.id === modelId)) models.push(newSavedAgentModel(itemDraft as AppSettings, { id: modelId, displayName: modelId }));
      providers.push({ ...item, name: item.name.trim(), baseUrl: item.baseUrl.trim(), modelId, models });
    }
    setSaving(true);
    try {
      await window.naiDesktop.setSetting('agentProviders', { ...registry, providers });
      await useAppStore.getState().refreshSettings();
      const saved = getAgentProviderRegistry(useAppStore.getState().settings!);
      setRegistry(saved); setDirty(false); setMessage(t('providersSaved')); onSaved?.();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSaving(false); }
  }
  return <div className="agent-provider-settings">
    <p className="agent-provider-hint">{t('providersHint')}</p>
    <div className="agent-provider-layout">
      <aside className="agent-provider-sidebar" aria-label={t('savedProviders')}>
        <strong>{t('savedProviders')}</strong>
        <div className="agent-provider-list">{registry.providers.map(item => <button type="button" key={item.id}
          aria-pressed={item.id === editorId} disabled={locked} onClick={() => { setEditorId(item.id); setError(''); }}>
          <LuNetwork aria-hidden /><span>{item.name}<small>{t('providerModelCount', String(item.models.length))}</small></span>
          {item.id === registry.activeProviderId && <LuCheck aria-label={t('activeProvider')} />}
        </button>)}</div>
        <label>{t('providerTemplate')}<SelectMenuCompat disabled={locked} value={template} onChange={event => setTemplate(event.target.value)}>
          {AGENT_PROVIDER_PRESETS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
        </SelectMenuCompat></label>
        <button type="button" disabled={locked} onClick={addProvider}><LuPlus aria-hidden />{t('addProvider')}</button>
      </aside>
      <div className="agent-provider-editor">
        {profile && draft ? <fieldset disabled={locked} key={profile.id}>
          <div className="agent-provider-heading"><h3>{t('providerConnection')}</h3><button type="button" className="agent-provider-remove" onClick={() => void removeProvider()}><LuTrash2 aria-hidden />{t('deleteProvider')}</button></div>
          <label>{t('providerName')}<input maxLength={80} value={profile.name} onChange={event => patchProfile({ name: event.target.value })} /></label>
          <label>{t('apiAddress')}<input placeholder="https://your-provider.example/v1" value={profile.baseUrl} onChange={event => patchProfile({ baseUrl: event.target.value })} /></label>
          <label>{t('apiKey')}<input type="password" autoComplete="off" value={profile.apiKey} onChange={event => patchProfile({ apiKey: event.target.value })} /></label>
          <label>{t('protocol')}<SelectMenuCompat value={profile.protocol} onChange={event => patchProfile({ protocol: event.target.value as AgentProviderProfile['protocol'] })}>
            <option value="openai-compatible">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option>
            <option value="anthropic-messages">Anthropic Messages</option><option value="google-gemini">Google Gemini</option>
          </SelectMenuCompat></label>
          <label>{t('modelId')}<input value={profile.modelId} onChange={event => patchProfile({ modelId: event.target.value })} placeholder={t('manualModelHint')} /></label>
          <AgentModelCollection draft={draft} disabled={locked} onChange={patchModel} />
        </fieldset> : <p className="agent-provider-empty">{t('noProviders')}</p>}
      </div>
    </div>
    {error && <p className="agent-provider-error" role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
    <footer className="agent-provider-actions"><small>{dirty ? t('unsavedChanges') : t('imageApi')}</small>
      <button type="button" disabled={locked} onClick={() => { if (onCancel) onCancel(); else { const current = getAgentProviderRegistry(settings); setRegistry(current); setEditorId(current.activeProviderId || current.providers[0]?.id || ''); setDirty(false); setError(''); setMessage(''); } }}>{t('cancel')}</button>
      <button type="button" className="agent-provider-save" disabled={locked} onClick={() => void save()}>{t(saving ? 'saveBusy' : 'save')}</button>
    </footer>
  </div>;
}

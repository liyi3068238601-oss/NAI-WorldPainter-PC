import {readFileSync} from 'node:fs';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it} from 'vitest';
import {AgentModelPicker,safeAgentProviderLabel} from './AgentModelPicker';

const endpoint='https://private-provider.invalid/v1';
const credential='QA_SECRET_DO_NOT_RENDER';
const registry={version:1 as const,activeProviderId:'provider-1',providers:[{
  id:'provider-1',name:`OpenAI-compatible ${endpoint} ${credential}`,protocol:'openai-compatible' as const,baseUrl:endpoint,apiKey:credential,modelId:'gpt-4.1',
  models:[{providerKey:`openai-compatible|${endpoint}`,id:'gpt-4.1',displayName:'GPT 4.1',contextWindow:128000,maxOutputTokens:8192,reasoningEffort:'auto' as const,vision:true}],
}]};

it('renders an anchored button using safe provider and model labels only',()=>{
  const html=renderToStaticMarkup(<AgentModelPicker registry={registry as never} onSelect={async()=>{}} onManage={()=>{}} disabled={false} language="zh-CN"/>);
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain('OpenAI-compatible · GPT 4.1');
  expect(html).not.toContain(endpoint);
  expect(html).not.toContain(credential);
});

it('redacts endpoint and credential material from a saved display name',()=>{
  expect(safeAgentProviderLabel(`Local ${endpoint} ${credential}`,endpoint,credential,'Provider 1')).toBe('Local');
  expect(safeAgentProviderLabel(endpoint,endpoint,credential,'Provider 1')).toBe('Provider 1');
});

it('uses the existing viewport-aware non-modal popover and keeps its actions keyboard reachable',()=>{
  const component=readFileSync(new URL('./AgentModelPicker.tsx',import.meta.url),'utf8');
  const popover=readFileSync(new URL('./AnchoredPopover.tsx',import.meta.url),'utf8');
  const css=readFileSync(new URL('./AgentModelPicker.css',import.meta.url),'utf8');
  expect(component).toContain('<AnchoredPopover');
  expect(component).toContain('aria-expanded={open}');
  expect(component).toContain('className={`agent-model-picker-provider');
  expect(component).toContain('className={`agent-model-picker-model');
  expect(component).toContain('},[open,shownProviderId]);');
  expect(component).not.toContain('},[open,shownProvider]);');
  expect(component).toContain('onMouseEnter={()=>setFocusedProviderId(provider.id)}');
  expect(component).toContain("event.key==='ArrowRight'");
  expect(component).toContain("event.key==='ArrowLeft'");
  expect(component).toContain("event.key==='ArrowDown'");
  expect(component).toContain("event.key==='ArrowUp'");
  expect(component).toContain('catch{setError(localText.selectFailed);}');
  expect(component).toContain('className="agent-model-picker-error" role="alert"');
  expect(popover).toContain("event.key==='Escape'");
  expect(popover).toContain("document.addEventListener('pointerdown',dismiss,true)");
  expect(popover).toContain('window.visualViewport');
  expect(css).toContain('grid-template-columns:minmax(112px,.8fr) minmax(0,1.2fr)');
});

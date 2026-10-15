import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import type {SavedAgentModel} from '../agent/model-selections';
import {updateSavedAgentModelLimits} from './AgentModelCollection';

const model:SavedAgentModel={providerKey:'openai-compatible|https://provider.invalid/v1',id:'reasoner',displayName:'Reasoner',contextWindow:128000,maxOutputTokens:64000,reasoningEffort:'auto'};

it('caps model output when the context limit is reduced and allows independent output edits',()=>{
  expect(updateSavedAgentModelLimits(model,{contextWindow:16000})).toMatchObject({contextWindow:16000,maxOutputTokens:16000});
  expect(updateSavedAgentModelLimits(model,{maxOutputTokens:90000})).toMatchObject({contextWindow:128000,maxOutputTokens:90000});
  expect(updateSavedAgentModelLimits(model,{maxOutputTokens:999999})).toMatchObject({maxOutputTokens:128000});
});

it('keeps numeric text as a local draft until blur or Enter commits it',()=>{
  const component=readFileSync(new URL('./AgentModelCollection.tsx',import.meta.url),'utf8');
  const sharedUi=readFileSync(new URL('./ui.tsx',import.meta.url),'utf8');
  expect(component).toContain("import {CommittedNumberInput,SelectMenuCompat} from './ui'");
  expect(component).toContain('<CommittedNumberInput label={t(\'contextWindow\')');
  expect(component).toContain('onCommit={contextWindow=>commitLimits(model,{contextWindow})}');
  expect(component).not.toContain('contextWindow:Number(event.target.value)');
  expect(sharedUi).toContain('onChange={(event) => setDraft(event.target.value)}');
  expect(sharedUi).toContain('onBlur={commit}');
  expect(sharedUi).toContain('event.key === "Enter"');
});

it('exposes per-model max output and vision controls through the existing draft callback',()=>{
  const component=readFileSync(new URL('./AgentModelCollection.tsx',import.meta.url),'utf8');
  expect(component).toContain('onCommit={maxOutputTokens=>commitLimits(model,{maxOutputTokens})}');
  expect(component).toContain('onChange={event=>commitVision(model,event.target.checked)}');
  expect(component).toContain('selectedAgentModelPatch(updated)');
});

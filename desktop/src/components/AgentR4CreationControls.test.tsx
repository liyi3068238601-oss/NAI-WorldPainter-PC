import {describe, expect, it, vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import type {R4AssistantPreset, R4ConversationConfigSnapshot} from '../agent/r4-types';
import {AgentR4AssistantPresetControl} from './AgentR4CreationControls';

const presets:Record<string,R4AssistantPreset>={
  concise:{id:'concise',name:'Concise',body:'Be concise.',revision:3,hash:'abc123',source:'builtin'},
  detailed:{id:'detailed',name:'Detailed',body:'Explain steps.',revision:1,hash:'def456',source:'user'},
};

describe('Agent R4 assistant preset control',()=>{
  it('uses the seeded new-chat binding when the conversation has no override and offers no clear option',()=>{
    const html=renderToStaticMarkup(<AgentR4AssistantPresetControl language="en-US" presets={presets} defaults={{presetId:'concise',enabled:false}} disabled={false} onChange={vi.fn()} onSetDefault={vi.fn()}/>);

    expect(html).toContain('value="concise"');
    expect(html).toContain('>Concise</option>');
    expect(html).not.toContain('No preset selected');
    expect(html).not.toContain('value=""');
  });

  it('keeps a conversation selection instead of silently replacing it with the default',()=>{
    const html=renderToStaticMarkup(<AgentR4AssistantPresetControl language="en-US" presets={presets} binding={{presetId:'detailed',enabled:true}} defaults={{presetId:'concise',enabled:false}} disabled={false} onChange={vi.fn()} onSetDefault={vi.fn()}/>);

    expect(html).toContain('value="detailed"');
    expect(html).toContain('checked=""');
  });

  it('shows the restored turn preset snapshot while leaving the ordinary controls available without another confirmation step',()=>{
    const restored: R4ConversationConfigSnapshot={version:1,providerRef:{providerId:'provider-original'},modelId:'model-original',presetId:'detailed',enabled:false,publicParameters:{},capturedAt:'2026-10-18T00:00:00.000Z',source:'message_send'};
    const html=renderToStaticMarkup(<AgentR4AssistantPresetControl language="en-US" presets={presets} binding={{presetId:'concise',enabled:true}} defaults={{presetId:'concise',enabled:false}} restoredConfig={restored} disabled={false} onChange={vi.fn()} onSetDefault={vi.fn()}/>);

    expect(html).toContain('value="detailed"');
    expect(html).not.toContain('checked=""');
    expect(html).not.toContain('dialog');
    expect(html).not.toContain('No preset selected');
  });
});

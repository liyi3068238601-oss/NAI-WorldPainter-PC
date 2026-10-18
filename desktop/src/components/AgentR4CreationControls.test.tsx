import {describe, expect, it, vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import type {R4AssistantPreset, R4ConversationConfigSnapshot, R4Creation} from '../agent/r4-types';
import {studioUxText} from '../agent/ux';
import {AgentR4AssistantPresetControl, AgentR4CreationControls} from './AgentR4CreationControls';

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

  it.each(['zh-CN','zh-TW','en-US','ja-JP','ko-KR'])('uses localized role wording and friendly built-in names in %s while preserving preset identity',language=>{
    const builtin:R4AssistantPreset={id:'dsh-infinite-gen-5',name:'presetInfiniteFive',body:'Built-in body.',revision:1,hash:'builtin-hash',source:'builtin'};
    const html=renderToStaticMarkup(<AgentR4AssistantPresetControl language={language} presets={{[builtin.id]:builtin}} binding={{presetId:builtin.id,enabled:true}} disabled={false} onChange={vi.fn()} onSetDefault={vi.fn()}/>);

    expect(html).toContain(studioUxText(language,'assistantRolePreset'));
    expect(html).toContain(studioUxText(language,'presetInfiniteFive'));
    expect(html).toContain('value="dsh-infinite-gen-5"');
    expect(html).toContain('presetInfiniteFive');
    expect(html).toContain('ID: dsh-infinite-gen-5');
  });

  it('does not translate a user preset whose saved name matches an internal locale key',()=>{
    const custom:R4AssistantPreset={id:'user-preset',name:'presetInfiniteFive',body:'User body.',revision:1,hash:'user-hash',source:'user'};
    const html=renderToStaticMarkup(<AgentR4AssistantPresetControl language="zh-CN" presets={{[custom.id]:custom}} binding={{presetId:custom.id,enabled:true}} disabled={false} onChange={vi.fn()} onSetDefault={vi.fn()}/>);

    expect(html).toContain('>presetInfiniteFive</option>');
    expect(html).not.toContain('>无限五代 · 生图适配</option>');
    expect(html).toContain('value="user-preset"');
  });
});

describe('Agent R4 creation controls',()=>{
  it('keeps the full conversation title available and explains the historical creation without editing saved data',()=>{
    const creation={
      id:'creation-1',conversationId:'chat-1',title:'历史创作',inputRevision:2,selectionRevision:1,
      positivePrompt:'',negativePrompt:'',stylePrompt:'',publicParameters:{},references:[],artworkIds:['art-1','art-2'],
      currentInput:{inputRevision:2,positivePrompt:'',negativePrompt:'',stylePrompt:'',publicParameters:{},references:[]},
      createdAt:'2026-10-18T00:00:00.000Z',updatedAt:'2026-10-18T00:00:00.000Z',legacyStatus:'legacy_unversioned',
    } as R4Creation;
    const conversationTitle='请读取当前生图设置，告诉我完整的提示词与参数说明';
    const html=renderToStaticMarkup(<AgentR4CreationControls language="zh-CN" conversationTitle={conversationTitle} creations={[creation]} currentCreationId={creation.id} scope="all" queueCount={0} queueOpen={false} resourcesOpen={false} disabled={false} onScope={vi.fn()} onSelectCreation={vi.fn()} onCreateCreation={vi.fn()} onToggleChats={vi.fn()} onToggleQueue={vi.fn()} onToggleResources={vi.fn()}/>);

    expect(html).toContain(`title="${conversationTitle}"`);
    expect(html).toContain('value="creation-1"');
    expect(html).toContain('title="创作：历史创作');
    expect(html).toContain('输入修订：v2');
    expect(html).toContain('关联作品：2');
    expect(html).toContain(studioUxText('zh-CN','legacyCreationHint'));
    expect(creation.title).toBe('历史创作');
  });

  it.each(['zh-CN','zh-TW','en-US','ja-JP','ko-KR'])('keeps the template and role-preset labels distinct in %s',language=>{
    expect(studioUxText(language,'presetToggle')).not.toBe('presetToggle');
    expect(studioUxText(language,'presetSwitchHint')).not.toBe('presetSwitchHint');
    expect(studioUxText(language,'assistantRolePreset')).not.toBe('assistantRolePreset');
    expect(studioUxText(language,'assistantRolePresetHint')).not.toBe('assistantRolePresetHint');
  });
});

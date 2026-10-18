import {describe,expect,it,vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import type {R4WorkbenchPromptPreview} from '../agent/r4-workbench-contract';
import {AgentR4WorkbenchApplyPreview} from './AgentR4WorkbenchApplyPreview';

const preview:R4WorkbenchPromptPreview={
  previewId:'preview-1',conversationId:'conversation-1',creationId:'creation-1',proposalId:'proposal-1',proposalRevision:3,
  draftId:'draft-1',draftRevision:9,inputRevision:4,
  before:{positivePrompt:'old positive',negativePrompt:'avoid text',stylePrompt:'soft light'},
  after:{positivePrompt:'new positive',negativePrompt:'avoid text',stylePrompt:'ink illustration'},
  diff:{positivePromptChanged:true,negativePromptChanged:false,stylePromptChanged:true},
};

describe('Agent R4 workbench apply preview',()=>{
  it('shows frozen proposal identity and exact before/after prompt values',()=>{
    const html=renderToStaticMarkup(<AgentR4WorkbenchApplyPreview language="en-US" preview={preview} busy={false} onClose={vi.fn()} onApply={vi.fn()}/>);
    expect(html).toContain('Creation creation-1');
    expect(html).toContain('Proposal v3');
    expect(html).toContain('Workbench draft revision');
    expect(html).toContain('old positive');
    expect(html).toContain('new positive');
    expect(html).toContain('avoid text');
    expect(html).toContain('soft light');
    expect(html).toContain('ink illustration');
    expect(html).toContain('Only these three prompt fields');
  });

  it('does not offer a write when all three fields already match',()=>{
    const unchanged={...preview,diff:{positivePromptChanged:false,negativePromptChanged:false,stylePromptChanged:false}};
    const html=renderToStaticMarkup(<AgentR4WorkbenchApplyPreview language="en-US" preview={unchanged} busy={false} onClose={vi.fn()} onApply={vi.fn()}/>);
    expect(html).toContain('All three fields already match the workbench');
    expect(html).toMatch(/Apply to workbench<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Apply to workbench/);
  });
});

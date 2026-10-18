import {describe, expect, it, vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import type {R4ConversationConfigSnapshot, R4Creation, R4Preparation} from '../agent/r4-types';
import {AgentR4CreativePanel} from './AgentR4CreativePanel';

const config: R4ConversationConfigSnapshot={version:1,providerRef:{providerId:'provider-a'},modelId:'model-a',presetId:null,enabled:false,publicParameters:{},capturedAt:'2026-10-18T00:00:00.000Z',source:'preview'};
const currentSource={attachmentId:'art-current',revision:4,name:'Current source.png',mime:'image/png'};
const requestedSource={attachmentId:'art-requested',revision:2,name:'Requested source.png',mime:'image/png'};

describe('Agent R4 creative panel preparation source context',()=>{
  it('distinguishes the frozen request source from the current creation edit source',()=>{
    const creation: R4Creation={
      id:'creation-a',conversationId:'conversation-a',title:'Portrait',inputRevision:8,selectionRevision:1,
      positivePrompt:'portrait',negativePrompt:'',stylePrompt:'',publicParameters:{},editSource:currentSource,
      references:[],artworkIds:[],currentInput:{inputRevision:8,positivePrompt:'portrait',negativePrompt:'',stylePrompt:'',publicParameters:{},editSource:currentSource,references:[]},
      createdAt:'2026-10-18T00:00:00.000Z',updatedAt:'2026-10-18T00:00:00.000Z',
    };
    const preparation: R4Preparation={
      id:'preparation-a',conversationId:'conversation-a',creationId:'creation-a',inputRevision:8,fingerprint:'fingerprint-a',preview:{target:'image-to-image'},
      inputSnapshot:{inputRevision:8,positivePrompt:'portrait',negativePrompt:'no watermark',stylePrompt:'illustration style',publicParameters:{operation:'upscale_image'},editSource:requestedSource,mask:{attachmentId:'mask-a',revision:1,name:'Mask.png',mime:'image/png'},references:[
        {attachmentId:'reference-a',revision:3,name:'Reference A.png',mime:'image/png',role:'reference',purpose:'color',includeInGeneration:true,authorizationStatus:'authorized'},
        {attachmentId:'discussion-a',revision:1,name:'Discussion only.png',mime:'image/png',role:'discussion',includeInGeneration:false,authorizationStatus:'not_authorized'},
      ]},
      conversationConfig:config,status:'ready',createdAt:'2026-10-18T00:00:00.000Z',
      providerRef:{providerId:'novelai',accountRef:'account-42'},
    };
    preparation.preview={...preparation.preview,operation:'upscale_image',scale:4,requestCount:2};
    const html=renderToStaticMarkup(<AgentR4CreativePanel
      language="en-US" state={undefined} creation={creation} proposals={[]} artworks={[]} preparation={preparation} executions={[]} receipts={[]} attachments={[]} disabled={false}
      onSelectProposal={vi.fn()} onPrepare={vi.fn()} onPreviewWorkbenchApply={vi.fn()} onSelectArtwork={vi.fn()} onOpenArtwork={vi.fn()} onSetEditSource={vi.fn()} onRemoveEditSource={vi.fn()}
      onAddReference={vi.fn()} onChangeReference={vi.fn()} onRemoveReference={vi.fn()} onSaveInputs={vi.fn()} onApprovePreparation={vi.fn()} onDenyPreparation={vi.fn()} onUndo={vi.fn()} attachmentUrl={()=>undefined}
    />);

    expect(html).toContain('This request edit source (frozen snapshot)');
    expect(html).toContain('Requested source.png · r2');
    expect(html).toContain('Current creation edit source');
    expect(html).toContain('Current source.png · r4');
    expect(html).toContain('Image provider');
    expect(html).toContain('novelai');
    expect(html).toContain('account-42');
    expect(html).toContain('Upscale factor');
    expect(html).toContain('4×');
    expect(html).toContain('Provider requests');
    expect(html).toContain('2');
    expect(html).toContain('Generation references / mask');
    expect(html).toContain('>2</dd>');
    expect(html).toContain('Actual prompts for this request (frozen)');
    expect(html).toContain('<dt>Positive</dt><dd>portrait</dd>');
    expect(html).toContain('<dt>Negative</dt><dd>no watermark</dd>');
    expect(html).toContain('<dt>Style</dt><dd>illustration style</dd>');
  });
});

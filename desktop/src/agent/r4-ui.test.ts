import {describe, expect, it} from 'vitest';
import type {R4Artwork, R4ConversationCreativeState, R4Creation, R4DispatchGate, R4Proposal, R4QueuedMessage} from './r4-types';
import {filterR4Messages, r4ActiveUnknownGates, r4ArtworksForCreation, r4CanContinueIndependentMessage, r4CommandFailureMessage, r4CurrentProposal, r4ViewerArtworks, resolveR4MessageOwnership} from './r4-ui';

const artwork = (id: string, outputIndex: number, batchId: string, creationId = 'creation-a'): R4Artwork => ({
  id,
  attachmentId: `attachment-${id}`,
  revision: 1,
  conversationId: 'conversation-a',
  creationId,
  executionId: `execution-${batchId}`,
  batchId,
  outputIndex,
  name: `${id}.png`,
  mime: 'image/png',
  createdAt: '2026-10-18T00:00:00.000Z',
});

describe('R4 UI selectors', () => {
  it('surfaces a business rejection even when the IPC envelope succeeded', () => {
    expect(r4CommandFailureMessage({ok:true,data:{resultKind:'preflight_failure',status:'error',error:{code:'invalid_arguments',message:'工具入参不符合当前合同。'}}})).toBe('工具入参不符合当前合同。');
    expect(r4CommandFailureMessage({ok:true,data:{resultKind:'business',status:'completed'}})).toBeUndefined();
    expect(r4CommandFailureMessage({ok:true,data:{resultKind:'business',status:'completed',data:{selectionStatus:'conflict'}}})).toContain('当前方案选择已变化');
    expect(r4CommandFailureMessage({ok:true,data:{resultKind:'business',status:'completed',data:{inputStatus:'conflict'}}})).toContain('创作输入已变化');
    expect(r4CommandFailureMessage({ok:true,data:{resultKind:'business',status:'completed',data:{applyStatus:'conflict'}}})).toContain('工作台草稿已变化');
    expect(r4CommandFailureMessage({ok:true,data:{resultKind:'business',status:'completed',data:{submissionStatus:'stale'}}})).toContain('预览已失效');
    expect(r4CommandFailureMessage({ok:true,data:{resultKind:'business',status:'accepted',data:{submissionStatus:'accepted'}}})).toBeUndefined();
    expect(r4CommandFailureMessage({ok:true,data:{resultKind:'business',status:'completed',data:{cancelDisposition:'already_terminal'}}})).toBeUndefined();
    expect(r4CommandFailureMessage({ok:false,message:'IPC unavailable'})).toBe('IPC unavailable');
  });
  it('keeps missing ownership explicit and excludes it from a creation filter', () => {
    const state = {messageCreationIds: {bound: 'creation-a'}} as Pick<R4ConversationCreativeState, 'messageCreationIds'>;
    const messages = [{id: 'bound'}, {id: 'legacy'}];

    expect(resolveR4MessageOwnership(messages[1], state)).toEqual({status: 'legacy_unversioned'});
    expect(filterR4Messages(messages, state, 'all')).toEqual(messages);
    expect(filterR4Messages(messages, state, 'creation', 'creation-a')).toEqual([{id: 'bound'}]);
  });

  it('fails closed when message and conversation ownership disagree', () => {
    const state = {messageCreationIds: {message: 'creation-a'}} as Pick<R4ConversationCreativeState, 'messageCreationIds'>;
    const message = {id: 'message', creationId: 'creation-b'};

    expect(resolveR4MessageOwnership(message, state)).toEqual({
      status: 'conflict',
      messageCreationId: 'creation-b',
      stateCreationId: 'creation-a',
    });
    expect(filterR4Messages([message], state, 'creation', 'creation-a')).toEqual([]);
  });

  it('uses the exact current proposal pointer instead of selecting the newest version', () => {
    const old = {id:'proposal',creationId:'creation-a',revision:1} as R4Proposal;
    const latest = {id:'proposal',creationId:'creation-a',revision:2} as R4Proposal;
    const state = {proposals:{'proposal@1':old,'proposal@2':latest}} as unknown as R4ConversationCreativeState;
    const creation = {id:'creation-a',currentProposalRef:'proposal@1'} as R4Creation;

    expect(r4CurrentProposal(state,creation)).toBe(old);
    expect(r4CurrentProposal(state,{...creation,currentProposalRef:'missing@3'})).toBeUndefined();
  });

  it('requires explicit artwork membership and matching creation ownership', () => {
    const owned=artwork('owned',0,'batch-a','creation-a');
    const foreign=artwork('foreign',1,'batch-a','creation-b');
    const state={artworks:{owned,foreign}} as unknown as R4ConversationCreativeState;
    const creation={id:'creation-a',artworkIds:['owned','foreign','missing']} as R4Creation;

    expect(r4ArtworksForCreation(state,creation).map(item=>item.id)).toEqual(['owned']);
  });

  it('keeps viewer navigation within a batch or the selected creation', () => {
    const artworks = [
      artwork('a1', 1, 'batch-a'),
      artwork('a0', 0, 'batch-a'),
      artwork('b0', 0, 'batch-b'),
      artwork('other-creation', 0, 'batch-a', 'creation-b'),
    ];

    expect(r4ViewerArtworks(artworks, 'a1', 'batch').map(item => item.id)).toEqual(['a0', 'a1']);
    expect(r4ViewerArtworks(artworks, 'a1', 'creation').map(item => item.id)).toEqual(['a0', 'b0', 'a1']);
  });

  it('surfaces paid-service and critique unknown gates even without an image execution', () => {
    const paid = {id:'paid-op',conversationId:'conversation-a',active:true,reason:'unknown_prior_receipt',createdAt:'2026-10-18T00:00:00.000Z'} as R4DispatchGate;
    const critique = {id:'critique-unknown:exec-1',conversationId:'conversation-a',sourceExecutionId:'exec-1',active:true,reason:'unknown_prior_receipt',createdAt:'2026-10-18T00:00:01.000Z'} as R4DispatchGate;
    const image = {id:'image-unknown',conversationId:'conversation-a',sourceExecutionId:'exec-2',active:true,reason:'unknown_prior_receipt',createdAt:'2026-10-18T00:00:02.000Z'} as R4DispatchGate;
    const state = {
      gates:{paid,critique,image},
      operations:{'paid-op':{operation:'paid_service',receipt:{tool:'rewrite_prompt',phase:'unknown'}}},
      executions:{'exec-1':{id:'exec-1'}},
      creations:{},
    } as unknown as R4ConversationCreativeState;

    expect(r4ActiveUnknownGates([state]).map(item=>[item.source,item.detail,item.execution?.id])).toEqual([
      ['paid-service','rewrite_prompt · unknown',undefined],
      ['critique',undefined,'exec-1'],
      ['image-execution',undefined,undefined],
    ]);
  });

  it('offers explicit continuation only for an unrelated, unstarted message', () => {
    const gate = {id:'unknown',conversationId:'conversation-a',turnId:'original-intent',active:true,reason:'unknown_prior_receipt',createdAt:'now'} as R4DispatchGate;
    const message = {id:'queue-1',messageId:'message-1',conversationId:'conversation-a',sequence:2,userIntentRef:'new-intent',conversationConfig:{},status:'paused'} as R4QueuedMessage;
    expect(r4CanContinueIndependentMessage(message,[gate])).toBe(true);
    expect(r4CanContinueIndependentMessage({...message,userIntentRef:'original-intent'},[gate])).toBe(false);
    expect(r4CanContinueIndependentMessage({...message,startedAt:'now'},[gate])).toBe(false);
    expect(r4CanContinueIndependentMessage({...message,steeringStatus:'requested'},[gate])).toBe(false);
    expect(r4CanContinueIndependentMessage({...message,pauseReason:'recovered:running'},[gate])).toBe(false);
  });
});

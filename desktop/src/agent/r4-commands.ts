import type { R4ConversationCreativeState, R4ReferencePurpose } from './r4-types';

/** Renderer commands are user events; they do not accept host permission fields. */
export interface R4CreativeCommandArguments {
  create_creation: {title:string;requirements?:string};
  select_creation: {creationId:string};
  update_creation: {expectedInputRevision:number;requirements?:string;positivePrompt?:string;negativePrompt?:string;stylePrompt?:string;publicParameters?:Record<string,unknown>};
  set_current_proposal: {proposalId:string;revision:number;expectedSelectionRevision:number};
  undo_operation: {operationId:string};
  set_edit_source: {attachmentId:string;attachmentRevision?:string;expectedInputRevision:number;maskAttachmentId?:string};
  patch_inputs: {expectedInputRevision:number;action:'clear_edit_source'|'set_reference_usage';expectedAttachmentId?:string;attachmentId?:string;attachmentRevision?:string;role?:'reference'|'discussion';referencePurpose?:R4ReferencePurpose;includeInGeneration?:boolean};
  set_reference_usage: {attachmentId:string;attachmentRevision?:string;expectedInputRevision:number;role:'reference'|'discussion';referencePurpose?:R4ReferencePurpose;includeInGeneration:boolean};
  remove_reference: {attachmentId:string;attachmentRevision?:string;expectedInputRevision:number};
  prepare_generation: {proposalId?:string;revision?:number;positivePrompt?:string;negativePrompt?:string;stylePrompt?:string;count?:number;[parameter:string]:unknown};
  approve_generation: {preparationId:string;fingerprint:string};
  deny_preparation: {preparationId:string};
  resume_queue: {executionIds:string[]};
  cancel_execution: {executionId:string};
  verify_execution: {executionId:string};
  set_preset_binding: {presetId:string;enabled:boolean};
  set_model_binding: {providerId:string;modelId:string};
  set_new_chat_defaults: {presetId:string;enabled:boolean};
  update_preset: {presetId:string;expectedRevision:number;body:string;name?:string};
  save_draft: {text:string;expectedDraftRevision:number;attachmentIds?:string[]};
  cancel_message: {messageId:string;draftRevision?:number};
  steer_message: {messageId:string};
  restore_message: {messageId:string;expectedDraftRevision:number};
  resume_messages: {messageIds?:string[];acknowledgedGateIds?:string[]};
  download_artwork: {artworkId:string};
  select_artwork: {artworkId:string};
}

export type R4CreativeCommandType = keyof R4CreativeCommandArguments;
export interface R4CreativeCommand {
  conversationId:string;
  creationId?:string;
  type:R4CreativeCommandType;
  args?:Record<string,unknown>;
  /** Allocated by the UI for one gesture and reused for transport retries. */
  operationId?:string;
}

export interface R4CreativeCommandResult {
  ok:boolean;
  message?:string;
  state?:R4ConversationCreativeState;
  data?:Record<string,unknown>;
}

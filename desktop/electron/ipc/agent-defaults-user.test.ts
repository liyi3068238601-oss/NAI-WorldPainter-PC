import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
const fixture=vi.hoisted(()=>({root:''}));
vi.mock('./store',()=>({getSettings:()=>({agentContextWindow:8192,agentAutoCompactThreshold:.8,outputDir:''}),getHistoryReferenceItems:()=>[],fileExistsWithDirectoryCache:()=>false,readWithBackupRecoverySync:()=>null,atomicWriteFileSync:vi.fn(),rotateBackupsSync:vi.fn()}));
vi.mock('./agent-workspace-location',()=>({agentWorkspaceDirectory:()=>fixture.root,rebaseAgentWorkspaceFile:(value:string)=>value}));
import {createEmptyAgentWorkspace,createAgentConversation,normalizeAgentWorkspace,resetAgentStoreCacheForTests,setStudioConversationOptions} from './agent-store';
import {studioSessionOptions,studioCreativeReferenceData,studioSelectedSystemPrompt,STUDIO_DEFAULT_PRESET_ID} from '../../src/agent/workspace-controls';

let fixtureRoot='';
beforeEach(()=>{const temp=path.resolve(process.cwd(),'.tmp');fs.mkdirSync(temp,{recursive:true});fixtureRoot=fs.mkdtempSync(path.join(temp,'agent-defaults-user-'));fixture.root=fixtureRoot;resetAgentStoreCacheForTests();});
afterEach(()=>{resetAgentStoreCacheForTests();if(!fixtureRoot)return;const temp=path.resolve(process.cwd(),'.tmp');if(path.dirname(fixtureRoot)!==temp||!path.basename(fixtureRoot).startsWith('agent-defaults-user-'))throw Error('Refusing to remove an unexpected defaults fixture.');fs.rmSync(fixtureRoot,{recursive:true,force:true});fixtureRoot='';});

describe('fresh Studio defaults without private profiles',()=>{
 it('defaults fresh and missing approval choices to confirmation while preserving explicit saved auto',()=>{
  const fresh=createEmptyAgentWorkspace();
  expect(studioSessionOptions(fresh.conversations[0])).toMatchObject({approvalMode:'confirm',webSearchEnabled:true});
  expect(fresh.studioDefaults).toMatchObject({studioApprovalMode:'confirm',studioWebSearchEnabled:true});
  expect(studioSessionOptions()).toMatchObject({approvalMode:'confirm'});
  const missing=normalizeAgentWorkspace({...fresh,studioDefaults:undefined,conversations:[{...fresh.conversations[0],studioApprovalMode:undefined,studioWebSearchEnabled:undefined}]});
  expect(studioSessionOptions(missing.conversations[0])).toMatchObject({approvalMode:'confirm',webSearchEnabled:true});
  expect(missing.studioDefaults).toMatchObject({studioApprovalMode:'confirm'});
  const savedAuto=normalizeAgentWorkspace({...fresh,studioDefaults:{studioApprovalMode:'auto'},conversations:[{...fresh.conversations[0],studioApprovalMode:'auto'}]});
  expect(studioSessionOptions(savedAuto.conversations[0])).toMatchObject({approvalMode:'auto'});
  expect(savedAuto.studioDefaults).toMatchObject({studioApprovalMode:'auto'});
  const saved=normalizeAgentWorkspace({...fresh,studioDefaults:{studioApprovalMode:'confirm',studioWebSearchEnabled:false},conversations:[{...fresh.conversations[0],studioApprovalMode:'confirm',studioWebSearchEnabled:false}]});
  expect(studioSessionOptions(saved.conversations[0])).toMatchObject({approvalMode:'confirm',webSearchEnabled:false});
  expect(saved.studioDefaults).toMatchObject({studioApprovalMode:'confirm',studioWebSearchEnabled:false});
 });
 it('new chats use confirmation by default and inherit persisted explicit choices',()=>{
  const first=createAgentConversation('fresh');
  expect(first.ok).toBe(true);
  const id=first.workspace.selectedConversationId!;
  expect(studioSessionOptions(first.workspace.conversations.find(c=>c.id===id))).toMatchObject({approvalMode:'confirm',webSearchEnabled:true});
  const savedAuto=setStudioConversationOptions(id,{studioApprovalMode:'auto'});
  expect(savedAuto.ok).toBe(true);
  const second=createAgentConversation('inherited');
  const current=second.workspace.conversations.find(c=>c.id===second.workspace.selectedConversationId)!;
  expect(studioSessionOptions(current)).toMatchObject({approvalMode:'auto',webSearchEnabled:true});
  const saved=setStudioConversationOptions(id,{studioApprovalMode:'confirm',studioWebSearchEnabled:false});
  expect(saved.ok).toBe(true);
  const third=createAgentConversation('inherited confirmation');
  const confirmed=third.workspace.conversations.find(c=>c.id===third.workspace.selectedConversationId)!;
  expect(studioSessionOptions(confirmed)).toMatchObject({approvalMode:'confirm',webSearchEnabled:false});
  const cold=normalizeAgentWorkspace(JSON.parse(JSON.stringify(third.workspace)));
  expect(studioSessionOptions(cold.conversations.find(c=>c.id===cold.selectedConversationId))).toMatchObject({approvalMode:'confirm',webSearchEnabled:false});
  expect(studioSessionOptions(cold.conversations.find(c=>c.id===id))).toMatchObject({approvalMode:'confirm',webSearchEnabled:false});
  expect(studioSessionOptions(cold.conversations.find(c=>c.id===current.id))).toMatchObject({approvalMode:'auto',webSearchEnabled:true});
 });
 it('使用预设 gates selected creative instruction input, not sampler settings or tool permission',()=>{
  const workspace=createEmptyAgentWorkspace();const chat=workspace.conversations[0];
  expect(studioSessionOptions(chat).presetId).toBe(STUDIO_DEFAULT_PRESET_ID);
  const enabled=JSON.parse(studioCreativeReferenceData(workspace,chat,[]));
  expect(enabled.preset?.id).toBe(STUDIO_DEFAULT_PRESET_ID);
  expect(enabled.preset?.body).toBeUndefined();
  expect(studioSelectedSystemPrompt(workspace,chat)).toContain('image');
  expect(enabled.preset?.name).toBe('presetInfiniteFive');
  const disabled=JSON.parse(studioCreativeReferenceData(workspace,{...chat,studioTemplateEnabled:false},[]));
  expect(disabled.preset).toBeNull();
  expect(disabled.characters).toEqual(enabled.characters);
 });
});

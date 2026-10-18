import {EffortControl, effortText} from './components/EffortControl';
import {supportsNAIMediumEffort} from './types';
import {AgentProviderSettings} from './components/AgentProviderSettings';
import {AgentModelPicker} from './components/AgentModelPicker';
import {getAgentProviderRegistry} from './agent/provider-profiles';
import {PreviewImageViewer} from './components/PreviewImageViewer';
import {AnchoredPopover} from './components/AnchoredPopover';
import {createStudioScrollFollower} from './agent/scroll-follower';
import { normalizeStudioComposerActions, studioComposerActionLabel } from './agent/composer-actions';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import { LuArrowDown, LuArrowUp, LuCheck, LuChevronDown, LuCopy, LuImage, LuLoaderCircle, LuMessageSquare, LuPencil, LuPlus, LuSearch, LuSettings, LuSparkles, LuSquare, LuArchive, LuArchiveRestore, LuTrash2, LuEllipsis, LuX, LuUserRound, LuWrench, LuGauge, LuFileText, LuShieldCheck, LuZap, LuPanelLeftOpen, LuPanelLeftClose, LuPanelRightOpen, LuPanelRightClose } from 'react-icons/lu';
import type { AgentComposerAction, AgentConversation, AgentAttachment, AgentEvent, AgentMessage, AgentPermissionRequest, AgentWorkspaceData } from './agent/types';
import { agentProviderRequiresApiKey } from './agent/provider-catalog';
import { studioSourceUrl, studioWebSources, studioContextMeter, preparedStudioPreview, studioToolStatus, studioToolTitle, studioUxText } from './agent/ux';
import { clampCompactThreshold } from './agent/context';
import { useAppStore } from './store';
import {confirmAction} from './components/confirm';
import {MotionDisclosure} from './components/MotionDisclosure';
import {useStudioRegionMotion} from './use-studio-motion';
import {normalizeAgentUiPreferences,type AgentUiPreferences} from './agent/preferences';
import { AppPortal, SelectMenu, SelectMenuCompat } from './components/ui';
import './pi-agent-page.css';
import {useDisclosurePresence,disclosureAttributes} from './components/disclosure-motion';
import {AgentQuestionCards} from './components/AgentQuestionCards';
import type {AgentQuestionRequest} from './agent/types';
import {AgentResourcePanel} from './components/AgentResourcePanel';
import {studioSessionOptions,type StudioConversationOptions} from './agent/workspace-controls';
import {AgentR4CreationControls,AgentR4AssistantPresetControl,countR4QueueItems} from './components/AgentR4CreationControls';
import {AgentR4CreativePanel,AgentR4ProposalCard} from './components/AgentR4CreativePanel';
import {AgentR4QueuePanel} from './components/AgentR4QueuePanel';
import {AgentR4ArtworkViewer} from './components/AgentR4ArtworkViewer';
import {AgentR4WorkbenchApplyPreview} from './components/AgentR4WorkbenchApplyPreview';
import type {R4Artwork,R4AttachmentBinding,R4ConversationCreativeState,R4Execution,R4OperationReceipt,R4Preparation,R4Proposal,R4QueuedMessage,R4ReferencePurpose} from './agent/r4-types';
import type {R4CreativeCommandArguments,R4CreativeCommandResult,R4CreativeCommandType} from './agent/r4-commands';
import type {R4WorkbenchPromptPreview} from './agent/r4-workbench-contract';
import {filterR4Messages,r4ArtworksForCreation,r4CommandFailureMessage,r4CreationList,r4CurrentProposal,r4ExecutionsForCreation,r4GlobalExecutions,r4GlobalQueue,r4PreparationForCreation,r4ProposalsForCreation,r4Text,resolveR4MessageOwnership} from './agent/r4-ui';

function AgentDialog({title, children, close}: {title: string; children: ReactNode; close: () => void}) {
  const ref=useRef<HTMLElement>(null),id=useId();
  useLayoutEffect(()=>{ref.current?.querySelector<HTMLElement>('[autofocus],input,button')?.focus({preventScroll:true});},[]);
  return <AppPortal><div className="modal-backdrop pi-dialog-mask" onMouseDown={event=>{if(event.target===event.currentTarget)close();}} onKeyDown={event=>{if(event.key==='Escape'&&!event.defaultPrevented){event.preventDefault();close();}}}>
    <section ref={ref} className="pi-agent pi-modal" role="dialog" aria-modal="true" aria-labelledby={id}>
    <header><h2 id={id}>{title}</h2><button type="button" className="pi-icon" aria-label={studioUxText(useAppStore.getState().settings?.language, 'close')} onClick={close}><LuX /></button></header>{children}
    </section></div></AppPortal>;

}

function AgentToolGroup({message, language, children}: {message: AgentMessage; language: unknown; children: ReactNode}) {
  const [expanded, setExpanded] = useState<boolean>();
  const id = useId();
  const attention = message.tools.some(tool => ['pending', 'running', 'error'].includes(tool.status));
  const open = expanded ?? attention;
  return <section className="pi-tool-group"><button type="button" className="pi-tool-toggle" aria-expanded={open} aria-controls={id} onClick={()=>setExpanded(!open)}>
    {message.tools.some(tool=>tool.status==='error')?<LuX aria-hidden/>:attention?<LuLoaderCircle aria-hidden/>:<LuCheck aria-hidden/>}<span>{studioUxText(language,'toolProgress',String(message.tools.length))}</span><LuChevronDown className={open?'is-expanded':''} aria-hidden/>
  </button><MotionDisclosure id={id} open={open}><div className="pi-tools">{children}</div></MotionDisclosure></section>;
}

export function AgentWebSources({preview, language, onOpen}: {preview: ReturnType<typeof studioWebSources>; language: unknown; onOpen: (url: string) => void}) {
  if (!preview) return null;
  const t = (key: string) => studioUxText(language,key);
  return <section className="pi-web-sources" aria-label={t('webSources')}><strong>{t('webSources')}</strong>{preview.fetchedAt&&<p className="pi-muted">{t('fetchedAt')} <time>{preview.fetchedAt}</time></p>}<p className="pi-notice">{t('sourceWarning')}</p>{preview.warning&&<p>{preview.warning}</p>}{preview.invalid?<p role="alert">{t('invalidSources')}</p>:!preview.sources.length&&<p>{t('emptySources')}</p>}{preview.blocked>0&&<p>{t('blockedSources')}</p>}<ol>{preview.sources.map(source=><li key={source.url}><a href={source.url} onClick={event=>{event.preventDefault();onOpen(source.url)}} onAuxClick={event=>{event.preventDefault();if(event.button===1)onOpen(source.url)}}>{source.title}</a><small>{new URL(source.url).hostname}</small>{source.snippet&&<p>{source.snippet}</p>}</li>)}</ol></section>;
}

/** Studio's own tools and durable conversations; no new general Agent powers. */
export default function PiAgentPage({ active }: { active: boolean }) {
  const settings = useAppStore((state) => state.settings);
  const refreshSettings = useAppStore((state) => state.refreshSettings);
  const imageParams = useAppStore(state => state.params);
  const setImageParam = useAppStore(state => state.setParam);
  const imageOptionsAnchor = useRef<HTMLButtonElement>(null);
  const [imageOptionsOpen, setImageOptionsOpen] = useState(false);
  const closeImageOptions = useCallback(() => setImageOptionsOpen(false), []);
  const t = useCallback((key: string, name?: string) => studioUxText(settings?.language, key, name), [settings?.language]);
  const [workspace, setWorkspace] = useState<AgentWorkspaceData>();
  const latestWorkspace = useRef<AgentWorkspaceData | undefined>(undefined);
  const [creativeStates,setCreativeStates]=useState<Record<string,R4ConversationCreativeState>>({});
  const latestCreativeStates=useRef<Record<string,R4ConversationCreativeState>>({});
  latestCreativeStates.current=creativeStates;
  const [scopeByConversation,setScopeByConversation]=useState<Record<string,'all'|'creation'>>({});
  const [queueOpen,setQueueOpen]=useState(false),[rightPanelTab,setRightPanelTab]=useState<'creative'|'resources'>('creative');
  const [viewerArtworkId,setViewerArtworkId]=useState<string>(),[viewerConversationId,setViewerConversationId]=useState<string>();
  const draftSaveChains=useRef<Record<string,Promise<unknown>>>({});
  const draftRevisionRef=useRef<Record<string,number>>({});
  const draftSyncPaused=useRef(new Set<string>());
  const skipDraftSync=useRef(new Map<string,string>());
  const draftsRef=useRef<Record<string,string>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [search, setSearch] = useState('');
  const [archivedView, setArchivedView] = useState(settings?.agentUiPreferences?.archivedView??false);
  const [error, setError] = useState('');
  const [workbenchPromptPreview,setWorkbenchPromptPreview]=useState<R4WorkbenchPromptPreview>();
  const [workbenchApplyBusy,setWorkbenchApplyBusy]=useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [configSwitchNotice,setConfigSwitchNotice]=useState(false);
  const configSwitchNoticeTimer=useRef<number|undefined>(undefined);
  const [compacting, setCompacting] = useState(false);
  const [uploading,setUploading]=useState(false),[dragging,setDragging]=useState(false);
  const uploadLock=useRef(false);
  const providers=settings?getAgentProviderRegistry(settings):{version:1 as const,activeProviderId:"",providers:[]};
  const [draftActions, setDraftActions] = useState<Record<string, AgentComposerAction[]>>({});
  const contextRef=useRef<HTMLButtonElement>(null),[contextOpen,setContextOpen]=useState(false);
  const closeContext=useCallback(()=>setContextOpen(false),[]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(()=>settings?.agentUiPreferences?.sidebarOpen??window.innerWidth>1100);
  const [resourcesOpen,setResourcesOpen]=useState(settings?.agentUiPreferences?.resourcesOpen??window.innerWidth>1100);
  const [narrowLayout,setNarrowLayout]=useState(()=>window.innerWidth<=1100);
  const [resourceTab,setResourceTab]=useState<NonNullable<AgentUiPreferences['resourceTab']>>(normalizeAgentUiPreferences(settings?.agentUiPreferences).resourceTab??'presets');
  const sidebarPresent=useDisclosurePresence(sidebarOpen),resourcesPresent=useDisclosurePresence(resourcesOpen);
  const leftToggle=useRef<HTMLButtonElement>(null),rightToggle=useRef<HTMLButtonElement>(null);
  const pageRoot=useRef<HTMLDivElement>(null),leftPane=useRef<HTMLDivElement>(null),rightPane=useRef<HTMLDivElement>(null);
  const drawerFocusReturn=useRef<HTMLElement|null>(null);
  useEffect(()=>{const resize=()=>setNarrowLayout(window.innerWidth<=1100);window.addEventListener('resize',resize);return()=>window.removeEventListener('resize',resize);},[]);
  useEffect(()=>{if(narrowLayout&&sidebarOpen&&resourcesOpen)setSidebarOpen(false);},[narrowLayout,sidebarOpen,resourcesOpen]);
  const [optionsBusy,setOptionsBusy]=useState(false);
  const [composerHeight,setComposerHeight]=useState(()=>{if(settings?.agentUiPreferences?.composerHeight)return settings.agentUiPreferences.composerHeight;try{return Math.max(108,Math.min(420,Number(localStorage.getItem('studio-agent-composer-height'))||154));}catch{return 154;}});
  const preferencesReady=useRef(!!settings),preferenceWrite=useRef(Promise.resolve());
  const flushPreferences=useRef<(()=>void)|undefined>(undefined);
  useEffect(()=>()=>{flushPreferences.current?.();},[]);
  useEffect(()=>{if(settings&&!preferencesReady.current){const value=normalizeAgentUiPreferences(settings.agentUiPreferences);setSidebarOpen(value.sidebarOpen??window.innerWidth>1100);setResourcesOpen(value.resourcesOpen??window.innerWidth>1100);setArchivedView(value.archivedView??false);setResourceTab(value.resourceTab??'presets');if(value.composerHeight)setComposerHeight(value.composerHeight);preferencesReady.current=true;}},[settings]);
  useEffect(()=>{
    if(!preferencesReady.current)return;
    const value=normalizeAgentUiPreferences({sidebarOpen,resourcesOpen,archivedView,resourceTab,composerHeight});
    const save=()=>{preferenceWrite.current=preferenceWrite.current.then(async()=>{await window.naiDesktop.setSetting('agentUiPreferences',value);useAppStore.setState(state=>({settings:state.settings?{...state.settings,agentUiPreferences:value}:state.settings}));}).catch(reason=>{useAppStore.getState().setToast(String(reason));});};
    // Debounce dragging, flush on unmount; serialize writes so old replies cannot win.
    flushPreferences.current=save;
    const timer=window.setTimeout(()=>{save();flushPreferences.current=undefined;},200);
    return()=>{window.clearTimeout(timer);};
  },[sidebarOpen,resourcesOpen,archivedView,resourceTab,composerHeight]);
  const resizePress=useRef<{y:number;height:number}|null>(null);
  const [questions,setQuestions]=useState<AgentQuestionRequest[]>([]);
  const [permissions, setPermissions] = useState<AgentPermissionRequest[]>([]);
  const [answering, setAnswering] = useState(false);
  const [image, setImage] = useState<AgentAttachment>();
  const [chatAction, setChatAction] = useState<AgentConversation>();
  const [chatName, setChatName] = useState('');
  const [copied, setCopied] = useState('');
  const [away, setAway] = useState(false);
  useEffect(()=>()=>{if(configSwitchNoticeTimer.current!==undefined)window.clearTimeout(configSwitchNoticeTimer.current);},[]);
  const transcript = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const following = useRef(true);
  const scrollFollower=useRef<ReturnType<typeof createStudioScrollFollower>|undefined>(undefined);
  const touchY=useRef<number|undefined>(undefined);
  useLayoutEffect(()=>{const el=transcript.current;if(!el)return;const follower=createStudioScrollFollower(el,requestAnimationFrame,cancelAnimationFrame,value=>{following.current=value;setAway(!value);});scrollFollower.current=follower;const observer=new ResizeObserver(()=>follower.pin());observer.observe(el);if(el.firstElementChild)observer.observe(el.firstElementChild);return()=>{observer.disconnect();follower.dispose();scrollFollower.current=undefined;};},[]);
  const readingPositions = useRef<Record<string, {top: number; following: boolean}>>({});
  const restoredChat = useRef<string | undefined>(undefined);
  const selectedId = useRef<string | undefined>(undefined);
  const updateWorkspace = useCallback((value: AgentWorkspaceData) => { latestWorkspace.current = value; setWorkspace(value); }, []);
  const updateCreativeState=useCallback((value:R4ConversationCreativeState)=>{
    const cached=latestCreativeStates.current[value.conversationId];
    if(cached&&cached.updatedAt>value.updatedAt)return;
    latestCreativeStates.current={...latestCreativeStates.current,[value.conversationId]:value};
    if(value.composerDraft)draftRevisionRef.current[value.conversationId]=value.composerDraft.revision;
    setCreativeStates(current=>{
      const previous=current[value.conversationId];
      if(previous&&previous.updatedAt>value.updatedAt)return current;
      return {...current,[value.conversationId]:value};
    });
  },[]);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    setLoading(true);
    void Promise.all([window.naiDesktop.getAgentWorkspace(), window.naiDesktop.getAgentPendingPermissions(),window.naiDesktop.getAgentPendingQuestions?.()??Promise.resolve([])])
      .then(([value, pending, pendingQuestions]) => { if (alive) { updateWorkspace(value); setPermissions(pending);setQuestions(pendingQuestions); setError(''); } })
      .catch((reason) => { if (alive) setError(String(reason)); }).finally(() => { if (alive) setLoading(false); });
    const unsubscribe = window.naiDesktop.onAgentEvent((event: AgentEvent) => {
      if (!alive) return;
      if (event.kind === 'workspace') updateWorkspace(event.workspace);
      if(event.kind==='creative-state')updateCreativeState(event.state);
      if (event.kind === 'error' && (!event.conversationId || event.conversationId === selectedId.current)) setError(event.message);
      if(event.kind==='question')setQuestions(current=>[...current.filter(q=>q.id!==event.request.id),event.request]);
      if(event.kind==='question-resolved')setQuestions(current=>current.filter(q=>q.id!==event.requestId));
      if (event.kind === 'permission') setPermissions((current) => [...current.filter((item) => item.id !== event.request.id), event.request]);
      if (event.kind === 'permission-resolved') setPermissions((current) => current.filter((item) => item.id !== event.permissionId));
      if (event.kind === 'message-delta') {
        const current = latestWorkspace.current;
        if (!current) return;
        const next = structuredClone(current);
        const message = next.conversations.find((chat) => chat.id === event.conversationId)?.messages.find((item) => item.id === event.messageId);
        if (message) { message.content += event.delta; updateWorkspace(next); }
      }
    });
    return () => { alive = false; unsubscribe(); };
  }, [active, updateWorkspace, updateCreativeState]);

  const chat = useMemo(() => workspace?.conversations.find((item) => item.id === workspace.selectedConversationId) ?? workspace?.conversations.find(item=>!item.archivedAt), [workspace]);
  useEffect(()=>{if(workbenchPromptPreview&&workbenchPromptPreview.conversationId!==chat?.id)setWorkbenchPromptPreview(undefined);},[chat?.id,workbenchPromptPreview?.conversationId]);
  const conversationIdList=workspace?.conversations.map(item=>item.id).join('\u0000')??'';
  useEffect(()=>{
    if(!active||!conversationIdList)return;
    let alive=true;
    const ids=conversationIdList.split('\u0000');
    void Promise.allSettled(ids.map(id=>window.naiDesktop.getAgentCreativeState(id))).then(results=>{
      if(!alive)return;
      results.forEach((result,index)=>{if(result.status==='fulfilled')updateCreativeState(result.value);else if(ids[index]===selectedId.current)setError(String(result.reason));});
    });
    return()=>{alive=false;};
  },[active,conversationIdList,updateCreativeState]);
  const creativeState=chat?creativeStates[chat.id]:undefined;
  const creations=r4CreationList(creativeState);
  const currentCreation=creativeState?.currentCreationId?creativeState.creations[creativeState.currentCreationId]:undefined;
  const currentProposal=r4CurrentProposal(creativeState,currentCreation);
  const proposals=r4ProposalsForCreation(creativeState,currentCreation?.id);
  const artworks=r4ArtworksForCreation(creativeState,currentCreation);
  const selectedCandidate=creativeState?.selectedArtworkId?creativeState.artworks[creativeState.selectedArtworkId]:undefined;
  const selectedArtwork=selectedCandidate?.creationId===currentCreation?.id?selectedCandidate:undefined;
  const preparation=r4PreparationForCreation(creativeState,currentCreation?.id);
  const executions=r4ExecutionsForCreation(creativeState,currentCreation?.id);
  const currentScope=chat?scopeByConversation[chat.id]??'all':'all';
  const visibleMessages=useMemo(()=>filterR4Messages(chat?.messages??[],creativeState,currentScope,currentCreation?.id),[chat?.messages,creativeState,currentScope,currentCreation?.id]);
  const liveConversationIds=new Set((workspace?.conversations??[]).map(item=>item.id));
  const allCreativeStates=Object.values(creativeStates).filter(state=>liveConversationIds.has(state.conversationId));
  const globalMessages=r4GlobalQueue(allCreativeStates);
  const globalExecutions=r4GlobalExecutions(allCreativeStates);
  const globalQueueCount=countR4QueueItems(globalMessages)+globalExecutions.filter(item=>['queued','dispatching','running','cancel_requested','unknown','blocked'].includes(item.status)).length;
  const conversationTitles=Object.fromEntries((workspace?.conversations??[]).map(item=>[item.id,item.title]));
  const creationTitles=Object.fromEntries(allCreativeStates.flatMap(state=>Object.values(state.creations).map(item=>[item.id,item.title] as const)));
  const archived = !!chat?.archivedAt;
  selectedId.current = chat?.id;
  const restoredDraftConfig=creativeState?.composerDraft?.requiresConfigConfirmation?creativeState.composerDraft.restoredConversationConfig:undefined;
  const toolbarConversationConfig=restoredDraftConfig??creativeState?.config;
  const stateModelProvider=toolbarConversationConfig?.providerRef.providerId;
  const hasConfigurationIssue=Boolean(creativeState?.configurationIssue);
  const effectiveModelProvider=toolbarConversationConfig?providers.providers.find(provider=>provider.id===stateModelProvider):hasConfigurationIssue?undefined:providers.providers.find(provider=>provider.id===providers.activeProviderId);
  const effectiveModelId=toolbarConversationConfig?.modelId??(hasConfigurationIssue?undefined:effectiveModelProvider?.modelId??settings?.agentApiModel);
  const modelPickerRegistry={...providers,activeProviderId:effectiveModelProvider?.id??'',providers:providers.providers.map(provider=>provider.id===effectiveModelProvider?.id&&effectiveModelId?{...provider,modelId:effectiveModelId}:provider)};
  const configured=!hasConfigurationIssue&&(creativeState?.config
    ?Boolean(effectiveModelProvider?.baseUrl.trim()&&effectiveModelId?.trim()&&(!agentProviderRequiresApiKey(effectiveModelProvider.protocol,effectiveModelProvider.baseUrl)||effectiveModelProvider.apiKey.trim()))
    :Boolean(settings?.agentApiBaseUrl?.trim()&&settings.agentApiModel?.trim()&&(!agentProviderRequiresApiKey(settings.agentApiProtocol,settings.agentApiBaseUrl)||settings.agentApiKey?.trim())));
  async function runR4CommandFor<T extends R4CreativeCommandType>(conversationId:string,type:T,args:R4CreativeCommandArguments[T],creationId?:string):Promise<R4CreativeCommandResult>{
    try{
      const received=await window.naiDesktop.agentCreativeCommand({conversationId,creationId,type,args:args as Record<string,unknown>,operationId:crypto.randomUUID()});
      const failure=r4CommandFailureMessage(received,settings?.language);
      const result=failure?{...received,ok:false,message:failure}:received;
      if(result.state)updateCreativeState(result.state);
      else if(result.ok){const latest=await window.naiDesktop.getAgentCreativeState(conversationId);updateCreativeState(latest);}
      if(!result.ok)setError(result.message??t('statusError'));
      return result;
    }catch(reason){setError(String(reason));return {ok:false,message:String(reason)};}
  }
  async function saveDraftFor(conversationId:string,draftText:string,attachmentIds:string[]):Promise<number>{
    const previous=draftSaveChains.current[conversationId]??Promise.resolve();
    let savedRevision=0;
    const task=previous.catch(()=>undefined).then(async()=>{
      const state=latestCreativeStates.current[conversationId];
      const expectedDraftRevision=draftRevisionRef.current[conversationId]??state?.composerDraft?.revision??0;
      const result=await runR4CommandFor(conversationId,'save_draft',{text:draftText,expectedDraftRevision,attachmentIds});
      if(!result.ok)throw Error(result.message??t('statusError'));
      savedRevision=result.state?.composerDraft?.revision??expectedDraftRevision+1;
      draftRevisionRef.current[conversationId]=savedRevision;
    });
    draftSaveChains.current[conversationId]=task.then(()=>undefined,()=>undefined);
    await task;
    return savedRevision;
  }
  const draftAttachmentIds=chat?.draftAttachments.map(item=>item.id)??[];
  const draftAttachmentKey=draftAttachmentIds.join('\u0000');
  const pendingQuestion=questions.find(q=>q.conversationId===chat?.id);
  const pending = permissions.find((item) => item.conversationId === chat?.id);
  const running = busy || compacting || !!pending || !!pendingQuestion || chat?.status === 'running' || chat?.status === 'waiting-permission';
  // Local preference persistence blocks conflicting edits, but is not a model run.
  const controlsBusy = running || optionsBusy;
  const sessionOptions=studioSessionOptions(chat);
  const text = chat ? drafts[chat.id] ?? '' : '';
  const selectedActions = chat ? draftActions[chat.id] ?? [] : [];
  useEffect(()=>{
    const id=chat?.id;
    if(!id||archived)return;
    const skipped=skipDraftSync.current.get(id);
    if(skipped===text){skipDraftSync.current.delete(id);return;}
    if(draftSyncPaused.current.has(id))return;
    const persisted=creativeStates[id]?.composerDraft;
    if((persisted?.text??'')===text&&draftAttachmentIds.length===(persisted?.attachmentIds.length??0)&&draftAttachmentIds.every((attachmentId,index)=>attachmentId===persisted?.attachmentIds[index]))return;
    const timer=window.setTimeout(()=>{void saveDraftFor(id,text,draftAttachmentIds).catch(reason=>{if(selectedId.current===id)setError(String(reason));});},350);
    return()=>window.clearTimeout(timer);
  },[chat?.id,archived,text,draftAttachmentKey,creativeStates[chat?.id??'']?.composerDraft?.revision]);
  useEffect(() => {if(chat)try{const cached=sessionStorage.getItem(`studio-agent-actions:${chat.id}`);if(cached)setDraftActions(current=>({...current,[chat.id]:current[chat.id]??normalizeStudioComposerActions(JSON.parse(cached))}));}catch{/* Optional named-selection cache. */}},[chat?.id]);
  useEffect(() => {
    setError('');
    if (!chat) return;
    let saved:string|null=null;
    try { saved=sessionStorage.getItem(`studio-agent-draft:${chat.id}`); } catch { /* Optional session cache. */ }
    const durable=creativeStates[chat.id]?.composerDraft?.text;
    setDrafts(current=>{
      if(Object.prototype.hasOwnProperty.call(current,chat.id))return current;
      const value=saved??durable;
      if(value===undefined||value===null)return current;
      const next={...current,[chat.id]:value};draftsRef.current=next;return next;
    });
  }, [chat?.id,creativeStates[chat?.id??'']?.composerDraft?.revision]);
  useLayoutEffect(() => {
    if (!chat || !transcript.current || restoredChat.current === chat.id) return;
    const saved = readingPositions.current[chat.id];
    following.current = saved?.following ?? true;
    scrollFollower.current?.restore(following.current);
    setAway(!following.current);
    transcript.current.scrollTop = following.current ? transcript.current.scrollHeight : saved?.top ?? 0;
    restoredChat.current = chat.id;
  }, [chat?.id]);
  useEffect(() => {
    const el = transcript.current;
    if (following.current && el) scrollFollower.current?.pin();
  }, [chat?.id, chat?.messages, pending, pendingQuestion?.id]);
  const [composerHeightLimit,setComposerHeightLimit]=useState(420);
  useLayoutEffect(()=>{
    const main=inputRef.current?.closest('.pi-main');
    if(!main)return;
    const area=main.querySelector('.pi-compose-area');
    const surface=main.querySelector('.pi-composer-shell');
    const update=()=>{
      const viewportLimit=window.innerHeight<=560?160:window.innerHeight*(window.innerWidth<=760?.36:.4);
      const controlsHeight=area&&surface?area.getBoundingClientRect().height-surface.getBoundingClientRect().height:0;
      const readingBudget=main.clientHeight-controlsHeight-96;
      setComposerHeightLimit(Math.max(108,Math.floor(Math.min(420,main.clientHeight*.5,viewportLimit,readingBudget))));
    };
    const observer=new ResizeObserver(update);observer.observe(main);
    if(area)observer.observe(area);
    window.addEventListener('resize',update);update();
    return()=>{observer.disconnect();window.removeEventListener('resize',update);};
  },[]);
  const resizeMax=()=>composerHeightLimit;
  const effectiveComposerHeight=Math.min(composerHeight,resizeMax());
  const resizeComposer=(value:number)=>{const next=Math.round(Math.max(108,Math.min(resizeMax(),value)));setComposerHeight(next);try{localStorage.setItem('studio-agent-composer-height',String(next));}catch{/* Optional layout preference. */}};
  const saveOptions=async(patch:Partial<StudioConversationOptions>)=>{
    if(!chat||controlsBusy||archived)return;setOptionsBusy(true);setError('');
    try{const result=await window.naiDesktop.setStudioConversationOptions(chat.id,patch);if(result.ok)updateWorkspace(result.workspace);else setError(result.message??t('statusError'));}
    catch(reason){setError(String(reason));}finally{setOptionsBusy(false);}
  };

  const setText = (value: string, id = chat?.id) => {
    if (!id) return;
    draftsRef.current={...draftsRef.current,[id]:value};
    setDrafts((current) => ({ ...current, [id]: value }));
    try { sessionStorage.setItem(`studio-agent-draft:${id}`, value); } catch { /* Draft still retained while page is mounted. */ }
  };
  const prefill = (value: string) => { setText(value); inputRef.current?.focus(); };
  const setChatActions = (value: AgentComposerAction[], id=chat?.id) => {
    if(!id)return; const actions=normalizeStudioComposerActions(value);
    setDraftActions(current=>({...current,[id]:actions}));
    try{sessionStorage.setItem(`studio-agent-actions:${id}`,JSON.stringify(actions));}catch{/* Remains in memory. */}
  };
  const mutateChat = async (action: Promise<{ok: boolean; workspace: AgentWorkspaceData; message?: string}>) => {
    if (chat && transcript.current) readingPositions.current[chat.id] = {top: transcript.current.scrollTop, following: following.current};
    try { const result = await action; if (result.ok) { updateWorkspace(result.workspace); if(window.innerWidth<=760)setSidebarOpen(false); } else setError(result.message ?? t('statusError')); }
    catch (reason) { setError(String(reason)); }
  };
  const importResources=async(kind:'presets'|'characters')=>{
    if(controlsBusy)return;setOptionsBusy(true);setError('');
    try{const result=await window.naiDesktop.importStudioResources(kind);if(result.ok){updateWorkspace(result.workspace);if(!result.cancelled&&result.message)useAppStore.getState().setToast(result.message);}else setError(result.message??t('statusError'));}catch(reason){setError(String(reason));}finally{setOptionsBusy(false);}
  };
  const run = async (delivery:'queue'|'steer'='queue') => {
    if (archived || !chat || optionsBusy || busy || uploadLock.current || !configured || (!text.trim() && !selectedActions.length && !chat.draftAttachments.length)) return;
    const input=text.trim(),id=chat.id,actions=selectedActions,attachmentIds=chat.draftAttachments.map(item=>item.id),before=chat.messages.filter(item=>item.role==='user').length;
    const creationId=creativeState?.currentCreationId;
    let sentSnapshot=false;
    draftSyncPaused.current.add(id);setError('');setBusy(true);scrollFollower.current?.latest();
    try{
      const composerDraftRevision=await saveDraftFor(id,input,attachmentIds);
      if(draftsRef.current[id]===text){skipDraftSync.current.set(id,'');setText('',id);setChatActions([],id);sentSnapshot=true;}
      const restoredDraft=latestCreativeStates.current[id]?.composerDraft;
      const result=await window.naiDesktop.sendAgentMessage({conversationId:id,text:input,actions,creationId,composerDraftRevision,delivery,
        ...(restoredDraft?.requiresConfigConfirmation&&restoredDraft.restoredConfigFingerprint?{confirmedConversationConfigHash:restoredDraft.restoredConfigFingerprint}:{})});
      if(!result.ok){
        const after=latestWorkspace.current?.conversations.find(item=>item.id===id)?.messages.filter(item=>item.role==='user').length??before;
        if(after===before&&sentSnapshot&&draftsRef.current[id]===''){setText(input,id);setChatActions(actions,id);}
        setError(result.message??t('statusError'));
      }
    }catch(reason){
      const after=latestWorkspace.current?.conversations.find(item=>item.id===id)?.messages.filter(item=>item.role==='user').length??before;
      if(after===before&&sentSnapshot&&draftsRef.current[id]===''){setText(input,id);setChatActions(actions,id);}
      setError(String(reason));
    }finally{
      draftSyncPaused.current.delete(id);setBusy(false);
      const latestDraft=draftsRef.current[id]??'';
      if(latestDraft&&latestDraft!==input){const latestAttachments=latestWorkspace.current?.conversations.find(item=>item.id===id)?.draftAttachments.map(item=>item.id)??[];void saveDraftFor(id,latestDraft,latestAttachments).catch(reason=>setError(String(reason)));}
    }
  };
  const importAttachments = async (sourcePaths?: string[]) => {
    if (archived || !chat || uploadLock.current) return;
    uploadLock.current=true;setUploading(true);
    try {
      const result = await window.naiDesktop.importAgentFiles(chat.id, sourcePaths);
      if (!result.ok && !result.cancelled) setError(result.message ?? t('statusError'));
      updateWorkspace(await window.naiDesktop.getAgentWorkspace());
    } catch (reason) { setError(String(reason)); }
    finally{uploadLock.current=false;setUploading(false);}
  };
  const importFileData=async(files:File[]|Array<{name:string;bytes:Uint8Array}>)=>{
    if(archived||!chat||uploadLock.current||!files.length)return;
    const id=chat.id;uploadLock.current=true;setUploading(true);setError('');
    try {
      if(files.length>64)throw Error(t('attachmentLimit'));
      let total=0;const inputs:Array<{name:string;bytes:Uint8Array}>=[];
      for(const file of files){const isFile=typeof (file as File).arrayBuffer==='function';const size=isFile?(file as File).size:(file as {bytes:Uint8Array}).bytes.length;total+=size;if(!size||size>48*1024*1024||total>192*1024*1024)throw Error(t('attachmentLimit'));inputs.push({name:file.name||'clipboard.png',bytes:isFile?new Uint8Array(await (file as File).arrayBuffer()):(file as {bytes:Uint8Array}).bytes});}
      const result=await window.naiDesktop.importAgentFileData(id,inputs);if(!result.ok)setError(result.message??t('statusError'));
      updateWorkspace(await window.naiDesktop.getAgentWorkspace());
    }catch(reason){setError(String(reason));}finally{uploadLock.current=false;setUploading(false);}
  };
  const compact = async () => {
    if (archived || !chat || controlsBusy || !configured) return;
    setCompacting(true); setError('');
    try {
      const result = await window.naiDesktop.compactAgentConversation(chat.id);
      if (!result.ok) setError(result.message ?? t('statusError'));
      updateWorkspace(await window.naiDesktop.getAgentWorkspace());
    } catch (reason) { setError(String(reason)); }
    finally { setCompacting(false); }
  };
  const chooseModel = async (providerId: string, modelId: string) => {
    if (controlsBusy || saving||!chat) return;
    setSaving(true); setError('');
    try {
      const result=await runR4CommandFor(chat.id,'set_model_binding',{providerId,modelId},currentCreation?.id);
      if(!result.ok)throw Error(result.message??t('statusError'));
      setConfigSwitchNotice(true);
      if(configSwitchNoticeTimer.current!==undefined)window.clearTimeout(configSwitchNoticeTimer.current);
      configSwitchNoticeTimer.current=window.setTimeout(()=>setConfigSwitchNotice(false),5000);
    } catch (reason) { setError(String(reason)); throw reason; }
    finally { setSaving(false); }
  };
  const openSettings = () => setSettingsOpen(true);
  const createCreation=()=>{if(chat&&!archived&&!controlsBusy)void runR4CommandFor(chat.id,'create_creation',{title:r4Text(settings?.language,'新创作','New creation')});};
  const selectCreation=(creationId:string)=>{if(chat&&!archived&&!controlsBusy)void runR4CommandFor(chat.id,'select_creation',{creationId},creationId);};
  const saveCreationInputs=(patch:{requirements?:string;positivePrompt?:string;negativePrompt?:string;stylePrompt?:string})=>{
    if(!chat||!currentCreation||archived||controlsBusy)return;
    void runR4CommandFor(chat.id,'update_creation',{expectedInputRevision:currentCreation.inputRevision,...patch},currentCreation.id);
  };
  const selectProposal=(proposal:R4Proposal)=>{
    if(!chat||archived||controlsBusy)return;
    const target=latestCreativeStates.current[chat.id]?.creations[proposal.creationId];
    if(!target){setError(r4Text(settings?.language,'找不到此方案所属的创作。','The creation that owns this proposal is unavailable.'));return;}
    void runR4CommandFor(chat.id,'set_current_proposal',{proposalId:proposal.id,revision:proposal.revision,expectedSelectionRevision:target.selectionRevision},target.id);
  };
  const prepareProposal=(proposal?:R4Proposal)=>{
    if(!chat||archived||controlsBusy)return;
    const target=latestCreativeStates.current[chat.id]?.creations[proposal?.creationId??currentCreation?.id??''];
    if(!target){setError(r4Text(settings?.language,'找不到目标创作。','Target creation is unavailable.'));return;}
    void runR4CommandFor(chat.id,'prepare_generation',proposal?{proposalId:proposal.id,revision:proposal.revision}:{positivePrompt:target.positivePrompt,negativePrompt:target.negativePrompt,stylePrompt:target.stylePrompt},target.id);
  };
  const previewProposalWorkbenchApply=async(proposal:R4Proposal)=>{
    if(!chat||archived||workbenchApplyBusy||proposal.conversationId!==chat.id){setError(r4Text(settings?.language,'无法预览：方案不属于当前对话。','Cannot preview: this proposal does not belong to the current conversation.'));return;}
    setWorkbenchApplyBusy(true);setError('');
    try{
      const reply=await window.naiDesktop.previewR4PromptApply({conversationId:chat.id,creationId:proposal.creationId,proposalId:proposal.id,proposalRevision:proposal.revision});
      if(!reply.ok){setError(reply.message);return;}
      if(reply.data.conversationId!==chat.id||reply.data.creationId!==proposal.creationId||reply.data.proposalId!==proposal.id||reply.data.proposalRevision!==proposal.revision){setError(r4Text(settings?.language,'预览返回的方案版本不匹配，工作台未修改。','The preview returned a different proposal version; the workbench was not changed.'));return;}
      setWorkbenchPromptPreview(reply.data);
    }catch(reason){setError(String(reason));}
    finally{setWorkbenchApplyBusy(false);}
  };
  const applyWorkbenchPromptPreview=async()=>{
    const preview=workbenchPromptPreview;
    if(!preview||workbenchApplyBusy)return;
    setWorkbenchApplyBusy(true);setError('');
    try{
      const reply=await window.naiDesktop.applyR4PromptCAS({previewId:preview.previewId,conversationId:preview.conversationId,creationId:preview.creationId,proposalId:preview.proposalId,proposalRevision:preview.proposalRevision,draftId:preview.draftId,draftRevision:preview.draftRevision});
      if(!reply.ok){setError(reply.message);setWorkbenchPromptPreview(undefined);return;}
      if(reply.data.data.applyStatus!=='applied'){
        setError(reply.data.data.applyStatus==='conflict'?r4Text(settings?.language,'预览后工作台已变化，未写入任何字段。请重新打开预览。','The workbench changed after preview; nothing was written. Open a fresh preview.'):r4Text(settings?.language,'工作台草稿或方案版本已不可用，未写入任何字段。请重新预览。','The workbench draft or proposal version is no longer available; nothing was written. Preview again.'));
        setWorkbenchPromptPreview(undefined);return;
      }
      setWorkbenchPromptPreview(undefined);
      useAppStore.getState().setToast(r4Text(settings?.language,'方案提示词已应用到图像工作台','Proposal prompts applied to the image workbench'));
    }catch(reason){setError(String(reason));setWorkbenchPromptPreview(undefined);}
    finally{setWorkbenchApplyBusy(false);}
  };
  const bindEditSource=async(binding:Omit<R4AttachmentBinding,'revision'>&Partial<Pick<R4AttachmentBinding,'revision'>>,targetCreationId=currentCreation?.id):Promise<boolean>=>{
    if(!chat||!targetCreationId||archived)return false;
    let targetState=latestCreativeStates.current[chat.id];
    if(targetState?.currentCreationId!==targetCreationId){
      try{await saveDraftFor(chat.id,draftsRef.current[chat.id]??'',chat.draftAttachments.map(attachment=>attachment.id));}catch{return false;}
      const selection=await runR4CommandFor(chat.id,'select_creation',{creationId:targetCreationId},targetCreationId);
      if(!selection.ok)return false;
      targetState=selection.state??latestCreativeStates.current[chat.id]??await window.naiDesktop.getAgentCreativeState(chat.id);
      updateCreativeState(targetState);
    }
    const target=targetState?.creations[targetCreationId];
    if(!target){setError(r4Text(settings?.language,'找不到源图所属创作。','Could not find the artwork’s creation.'));return false;}
    const result=await runR4CommandFor(chat.id,'set_edit_source',{attachmentId:binding.attachmentId,...(Number.isSafeInteger(binding.revision)?{attachmentRevision:String(binding.revision)}:{}),expectedInputRevision:target.inputRevision},targetCreationId);
    if(result.ok)setViewerArtworkId(undefined);
    return result.ok;
  };
  const clearEditSource=()=>{
    if(!chat||!currentCreation||archived||controlsBusy)return;
    void runR4CommandFor(chat.id,'patch_inputs',{expectedInputRevision:currentCreation.inputRevision,action:'clear_edit_source'},currentCreation.id);
  };
  const addReference=async(asset:AgentAttachment|R4Artwork,role:'reference'|'discussion',purpose?:R4ReferencePurpose,creationId=currentCreation?.id)=>{
    if(!chat||!creationId||archived)return;
    const revision='revision' in asset?asset.revision:undefined;
    const target=latestCreativeStates.current[chat.id]?.creations[creationId];
    if(!target){setError(r4Text(settings?.language,'找不到目标创作。','Target creation is unavailable.'));return;}
    void runR4CommandFor(chat.id,'set_reference_usage',{attachmentId:'attachmentId'in asset?asset.attachmentId:asset.id,...(Number.isSafeInteger(revision)?{attachmentRevision:String(revision)}:{}),expectedInputRevision:target.inputRevision,role,...(role==='reference'&&purpose?{referencePurpose:purpose}:{}),includeInGeneration:false},creationId);
  };
  const addReferenceFromViewer=(asset:R4Artwork,role:'reference'|'discussion',purpose?:R4ReferencePurpose,includeInGeneration=false)=>{
    if(!chat||!currentCreation||archived||!Number.isInteger(asset.revision)){setError(r4Text(settings?.language,'当前创作不可用，或作品缺少修订记录。','Current creation is unavailable, or the artwork has no revision.'));return;}
    const target=latestCreativeStates.current[chat.id]?.creations[currentCreation.id];
    if(!target){setError(r4Text(settings?.language,'找不到目标创作。','Target creation is unavailable.'));return;}
    void runR4CommandFor(chat.id,'set_reference_usage',{attachmentId:asset.attachmentId,attachmentRevision:String(asset.revision),expectedInputRevision:target.inputRevision,role,...(role==='reference'&&purpose?{referencePurpose:purpose}:{}),includeInGeneration:role==='reference'&&includeInGeneration},currentCreation.id);
  };
  const changeReference=(binding:import('./agent/r4-types').R4ReferenceBinding,change:{purpose?:import('./agent/r4-types').R4ReferencePurpose;includeInGeneration:boolean;role:'reference'|'discussion'})=>{
    if(!chat||!currentCreation||archived||controlsBusy)return;
    void runR4CommandFor(chat.id,'set_reference_usage',{attachmentId:binding.attachmentId,attachmentRevision:String(binding.revision),expectedInputRevision:currentCreation.inputRevision,role:change.role,...(change.role==='reference'&&change.purpose?{referencePurpose:change.purpose}:{}),includeInGeneration:change.role==='reference'&&change.includeInGeneration},currentCreation.id);
  };
  const removeReference=(binding:import('./agent/r4-types').R4ReferenceBinding)=>{
    if(!chat||!currentCreation||archived||controlsBusy)return;
    void runR4CommandFor(chat.id,'remove_reference',{attachmentId:binding.attachmentId,attachmentRevision:String(binding.revision),expectedInputRevision:currentCreation.inputRevision},currentCreation.id);
  };
  const approvePreparation=(item:R4Preparation)=>{if(chat)void runR4CommandFor(chat.id,'approve_generation',{preparationId:item.id,fingerprint:item.fingerprint},item.creationId);};
  const denyPreparation=(item:R4Preparation)=>{if(chat)void runR4CommandFor(chat.id,'deny_preparation',{preparationId:item.id},item.creationId);};
  const undoReceipt=(item:R4OperationReceipt)=>{if(chat)void runR4CommandFor(chat.id,'undo_operation',{operationId:item.id},item.creationId);};
  const selectArtwork=(item:R4Artwork)=>{void runR4CommandFor(item.conversationId,'select_artwork',{artworkId:item.id},item.creationId);};
  const openArtwork=async(item:R4Artwork)=>{const result=await runR4CommandFor(item.conversationId,'select_artwork',{artworkId:item.id},item.creationId);if(result.ok){setViewerConversationId(item.conversationId);setViewerArtworkId(item.id);}};
  const attachmentUrl=(binding:R4AttachmentBinding)=>{
    const artwork=Object.values(creativeState?.artworks??{}).find(item=>item.attachmentId===binding.attachmentId&&item.revision===binding.revision);
    const attachment=chat?.messages.flatMap(message=>message.attachments).concat(chat.draftAttachments).find(item=>item.id===binding.attachmentId&&(item.revision===undefined||item.revision===binding.revision));
    return artwork?.url??attachment?.fileUrl;
  };
  const continueEditingArtwork=async(item:R4Artwork)=>{
    if(item.conversationId!==chat?.id){setError(r4Text(settings?.language,'请先切换到作品所属对话，再继续修改。','Switch to the artwork’s conversation before continuing the edit.'));return;}
    const changed=await bindEditSource({attachmentId:item.attachmentId,revision:item.revision,hash:item.hash,name:item.name,mime:item.mime,width:item.width,height:item.height},item.creationId);
    if(changed){setViewerArtworkId(undefined);setViewerConversationId(undefined);prefill(t('continueImageDraft'));if(narrowLayout){setResourcesOpen(false);requestAnimationFrame(()=>requestAnimationFrame(()=>inputRef.current?.focus({preventScroll:true})));}}
  };
  const continueEditingLegacyAttachment=async(item:AgentAttachment)=>{
    if(!chat||!currentCreation||archived||item.unavailable)return;
    const binding:Omit<R4AttachmentBinding,'revision'>&Partial<Pick<R4AttachmentBinding,'revision'>>={
      attachmentId:item.id,
      ...(Number.isSafeInteger(item.revision)?{revision:item.revision}:{}),
      ...(item.sha256?{hash:item.sha256}:{}),
      name:item.name,
      mime:item.mime,
      ...(item.width?{width:item.width}:{}),
      ...(item.height?{height:item.height}:{})
    };
    const changed=await bindEditSource(binding,currentCreation.id);
    if(changed){prefill(t('continueImageDraft'));if(narrowLayout){setResourcesOpen(false);requestAnimationFrame(()=>requestAnimationFrame(()=>inputRef.current?.focus({preventScroll:true})));}}
  };
  const continueEditingFromPanel=async(binding:R4AttachmentBinding)=>{
    const changed=await bindEditSource(binding,currentCreation?.id);
    if(changed){prefill(t('continueImageDraft'));if(narrowLayout){setResourcesOpen(false);requestAnimationFrame(()=>requestAnimationFrame(()=>inputRef.current?.focus({preventScroll:true})));}}
  };
  const sendResumeQueue=(items:R4Execution[])=>{
    const byConversation=new Map<string,R4Execution[]>();
    for(const item of items)byConversation.set(item.conversationId,[...(byConversation.get(item.conversationId)??[]),item]);
    for(const [conversationId,itemsInChat] of byConversation)void runR4CommandFor(conversationId,'resume_queue',{executionIds:itemsInChat.map(item=>item.id)});
  };
  const resumeMessages=(conversationId:string,messageIds?:string[],acknowledgedGateIds?:string[])=>{
    if(messageIds?.length&&acknowledgedGateIds?.length){void runR4CommandFor(conversationId,'resume_messages',{messageIds:[...messageIds],acknowledgedGateIds:[...acknowledgedGateIds]});return;}
    void runR4CommandFor(conversationId,'resume_messages',{});
  };
  const cancelQueuedMessage=async(item:R4QueuedMessage)=>{
    const activeState=latestCreativeStates.current[item.conversationId];
    let revision=draftRevisionRef.current[item.conversationId]??activeState?.composerDraft?.revision;
    if(chat?.id===item.conversationId){
      const textNow=draftsRef.current[item.conversationId]??'';
      const attachmentIds=chat.draftAttachments.map(attachment=>attachment.id);
      const persisted=activeState?.composerDraft;
      const unchanged=Boolean(persisted&&(persisted.text??'')===textNow&&persisted.attachmentIds.length===attachmentIds.length&&persisted.attachmentIds.every((id,index)=>id===attachmentIds[index]));
      try{revision=unchanged?persisted!.revision:!persisted&&!textNow&&!attachmentIds.length?(revision??0):await saveDraftFor(item.conversationId,textNow,attachmentIds);}catch{return;}
    }
    const result=await runR4CommandFor(item.conversationId,'cancel_message',{messageId:item.messageId,...(revision!==undefined?{draftRevision:revision}:{})},item.creationId);
    if(result.ok&&result.data?.restored===true){
      setText(result.state?.composerDraft?.text??'',item.conversationId);
      setChatActions(Array.isArray(result.data.actions)?normalizeStudioComposerActions(result.data.actions):[],item.conversationId);
      try{updateWorkspace(await window.naiDesktop.getAgentWorkspace());}catch(reason){setError(String(reason));}
    }
  };
  const restoreQueuedMessage=async(item:R4QueuedMessage)=>{
    let state=latestCreativeStates.current[item.conversationId];
    let expectedDraftRevision=draftRevisionRef.current[item.conversationId]??state?.composerDraft?.revision??0;
    if(chat?.id===item.conversationId){
      try{expectedDraftRevision=await saveDraftFor(item.conversationId,draftsRef.current[item.conversationId]??'',chat.draftAttachments.map(attachment=>attachment.id));}catch{return;}
    }
    const result=await runR4CommandFor(item.conversationId,'restore_message',{messageId:item.messageId,expectedDraftRevision},item.creationId);
    if(result.ok){
      setChatActions(Array.isArray(result.data?.actions)?normalizeStudioComposerActions(result.data.actions):[],item.conversationId);
      const selected=await window.naiDesktop.selectAgentConversation(item.conversationId);
      if(selected.ok)updateWorkspace(selected.workspace);
      state=result.state??latestCreativeStates.current[item.conversationId];
      if(state?.composerDraft){draftRevisionRef.current[item.conversationId]=state.composerDraft.revision;setText(state.composerDraft.text,item.conversationId);}
    }
  };
  const cancelExecution=(item:R4Execution)=>void runR4CommandFor(item.conversationId,'cancel_execution',{executionId:item.id},item.creationId);
  const verifyExecution=(item:R4Execution)=>void runR4CommandFor(item.conversationId,'verify_execution',{executionId:item.id},item.creationId);
  const steerQueuedMessage=(item:R4QueuedMessage)=>void runR4CommandFor(item.conversationId,'steer_message',{messageId:item.messageId},item.creationId);
  const setPresetBinding=async(presetId:string,enabled:boolean)=>{if(!chat||!presetId)return;const result=await runR4CommandFor(chat.id,'set_preset_binding',{presetId,enabled},currentCreation?.id);if(result.ok){setConfigSwitchNotice(true);if(configSwitchNoticeTimer.current!==undefined)window.clearTimeout(configSwitchNoticeTimer.current);configSwitchNoticeTimer.current=window.setTimeout(()=>setConfigSwitchNotice(false),5000);}};
  const setNewChatDefault=(presetId:string,enabled:boolean)=>{if(chat&&presetId)void runR4CommandFor(chat.id,'set_new_chat_defaults',{presetId,enabled},currentCreation?.id);};
  const respond = async (response: 'once' | 'reject', revise = false) => {
    if (!pending || answering) return;
    setAnswering(true);
    try {
      const result = await window.naiDesktop.respondAgentPermission(pending.id, response);
      if (!result.ok) setError(result.message ?? t('statusError'));
      else { setPermissions((current) => current.filter((item) => item.id !== pending.id)); if (revise) prefill(t('changePlanDraft')); }
    } catch (reason) { setError(String(reason)); }
    finally { setAnswering(false); }
  };
  const openSource = async (value: string) => {
    const url = studioSourceUrl(value);
    if (!url) {setError(t('blockedSources'));return;}
    try { await window.naiDesktop.openExternal(url); } catch (reason) {setError(String(reason));}
  };
  const copy = async (value: string, id: string) => {
    try { await navigator.clipboard.writeText(value); setCopied(id); }
    catch (reason) { setError(String(reason)); }
  };
  const plan = (value: Record<string, unknown>, actions = false) => <section className={`pi-plan ${actions ? 'pi-plan-pending' : ''}`} aria-label={t('planTitle')}>
    <header><LuSparkles aria-hidden/><strong>{t('planTitle')}</strong>{actions && <span>{t('statusPending')}</span>}</header>
    <div className="pi-plan-body">
    {(actions || 'estimatedAnlas' in value) && <p className="pi-cost">{typeof value.estimatedAnlas === 'number' ? t('estimatedCost',String(value.estimatedAnlas)) : t('unknownCost')}</p>}
    <dl>{[['model',value.model],['size',value.width && value.height ? `${value.width} × ${value.height}` : undefined],['effort',value.effort],['steps',value.steps],['count',value.count]].filter(([,v])=>v!==undefined).map(([key,v])=><div key={String(key)}><dt>{key==='effort' ? effortText(settings?.language).title : t(String(key))}</dt><dd>{String(v)}</dd></div>)}</dl>
    {value.positivePrompt != null && <div className="pi-plan-prompt"><span>{t('prompt')}</span><p>{String(value.positivePrompt)}</p></div>}
    {actions && <><p>{t('confirmationHint')}</p><p className="pi-cost">{t('paidWarning')}</p></>}</div>
    {actions && <footer><button disabled={answering} onClick={()=>void respond('reject')}>{t('cancel')}</button><button disabled={answering} onClick={()=>void respond('reject',true)}><LuPencil/>{t('changePlan')}</button><button className="pi-primary" disabled={answering} onClick={()=>void respond('once')}><LuCheck/>{t('confirm')}</button></footer>}
  </section>;
  const renderMessage = (message: AgentMessage) => {
    const ownership=resolveR4MessageOwnership(message,creativeState);
    const ownerCreation=ownership.status==='bound'?creativeState?.creations[ownership.creationId]:undefined;
    const sourceProposals=ownership.status==='bound'?Object.values(creativeState?.proposals??{}).filter(proposal=>proposal.sourceMessageId===message.id&&proposal.creationId===ownership.creationId).sort((a,b)=>b.revision-a.revision):[];
    const config=message.conversationConfig;
    const safePublicParameters=config?Object.fromEntries(Object.entries(config.publicParameters).filter(([key])=>!/(api.?key|token|secret|password|credential)/i.test(key))):undefined;
    return <article key={message.id} className={`pi-message pi-message-${message.role}`}>
    <div className="pi-message-role"><span className="pi-message-avatar">{message.role==='user'?<LuUserRound aria-hidden/>:<LuSparkles aria-hidden/>}</span>{t(message.role === 'user' ? 'you' : 'title')}
      {ownership.status==='bound'?<span className="r4-message-owner" title={ownership.creationId}>{ownerCreation?.title||r4Text(settings?.language,'所属创作','Creation')} · {ownerCreation?.title?`#${ownerCreation.id.slice(0,7)}`:ownership.creationId.slice(0,12)}</span>:ownership.status==='conflict'||message.r4LegacyStatus==='migration_conflict'?<span className="r4-message-owner is-conflict">{r4Text(settings?.language,'归属冲突','Ownership conflict')}</span>:<span className="r4-message-owner is-legacy">{r4Text(settings?.language,'历史消息未归属','Unversioned history')}</span>}
    </div>
    {message.content && <div className="pi-message-body"><ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>{message.content}</ReactMarkdown></div>}
    {config&&<details className="r4-message-config"><summary>{r4Text(settings?.language,'本条消息使用的模型快照','Configuration used for this message')}</summary><dl><dt>{r4Text(settings?.language,'模型','Model')}</dt><dd>{config.providerRef.providerId} · {config.modelId}{config.modelRevision?` · ${String(config.modelRevision)}`:''}</dd><dt>{r4Text(settings?.language,'预设','Preset')}</dt><dd>{config.presetId??r4Text(settings?.language,'未使用','None')}{config.enabled?' · enabled':' · disabled'}</dd>{(config.revision||config.hash)&&<><dt>{r4Text(settings?.language,'配置修订','Config revision')}</dt><dd>{config.revision??'—'}{config.hash?` · ${config.hash.slice(0,12)}`:''}</dd></>}{safePublicParameters&&Object.keys(safePublicParameters).length>0&&<><dt>{r4Text(settings?.language,'公开参数','Public parameters')}</dt><dd><pre>{JSON.stringify(safePublicParameters,null,2)}</pre></dd></>}</dl></details>}
    {message.error && <div role="alert" className="pi-notice pi-notice-error"><strong>{t('statusError')}</strong><p>{message.error}</p><small>{t('errorHint')}</small><button disabled={controlsBusy} onClick={()=>{const index=chat?.messages.findIndex(item=>item.id===message.id)??-1;const request=chat?.messages.slice(0,index).reverse().find(item=>item.role==='user');if(request){prefill(request.content);setChatActions(request.actions??[])}}}>{t('retryDraft')}</button><button onClick={()=>void copy(message.error??'',message.id)}>{t('copy')}</button></div>}
    {message.status === 'aborted' && <p className="pi-muted">{t('statusStopped')}</p>}
    {message.tools.length > 0 && <AgentToolGroup message={message} language={settings?.language}>{message.tools.map((tool) => {
      const preview = preparedStudioPreview(tool);
      const web = studioWebSources(tool);
      return <div key={tool.id} className="pi-tool"><div className="pi-tool-heading">{['pending','running'].includes(tool.status)?<LuLoaderCircle aria-hidden/>:tool.status==='completed'?<LuCheck aria-hidden/>:<LuX aria-hidden/>}<span>{studioToolTitle(settings?.language,tool.name,tool.title)}</span><span className={`pi-status pi-status-${tool.status}`}>{t(studioToolStatus(tool.status))}</span></div>
        {preview && !(pending && message.id === chat?.messages.at(-1)?.id) && plan(preview)}
        {tool.status==='error'&&<p role="alert" className="pi-notice pi-notice-error">{tool.error||t('statusError')}</p>}
        {tool.status === 'denied' && <p>{t('cancelledSafe')}</p>}
        <AgentWebSources preview={web} language={settings?.language} onOpen={url=>void openSource(url)}/>
        {(tool.output || tool.error) && <details><summary>{t('details')}</summary><pre>{tool.error || tool.output}</pre></details>}
      </div>;
    })}</AgentToolGroup>}
    {message.attachments.filter((item) => item.kind === 'image').map((item) => {
      const artwork=ownership.status==='bound'&&typeof item.revision==='number'?Object.values(creativeState?.artworks??{}).find(candidate=>candidate.attachmentId===item.id&&candidate.revision===item.revision&&candidate.creationId===ownership.creationId):undefined;
      const imageUrl=artwork?.url??item.fileUrl;
      return <div key={item.id} className="pi-image-wrap">{imageUrl && !item.unavailable ? <button className="pi-image-button" aria-label={t('preview')} onClick={()=>artwork?void openArtwork(artwork):setImage(item)}><img className="pi-result-image" src={imageUrl} alt={item.name}/></button> : <div className="pi-notice"><p>{t('missingImage')}</p><button disabled={controlsBusy} onClick={()=>void importAttachments()}>{t('reattach')}</button></div>}{message.role==='assistant'&&!artwork&&<button disabled={archived||controlsBusy||!!item.unavailable||!currentCreation} onClick={()=>void continueEditingLegacyAttachment(item)}><LuPencil/>{r4Text(settings?.language,'绑定为当前创作改图源并继续','Bind as current creation edit source')}</button>}{artwork&&<button disabled={archived||controlsBusy} onClick={()=>void continueEditingArtwork(artwork)}><LuPencil/>{r4Text(settings?.language,'继续修改此创作','Continue editing this creation')}</button>}</div>;
    })}
    {!!message.actions?.length && <div className="pi-selected-actions pi-message-selections">{message.actions.map((action,index)=><span key={index}><LuWrench aria-hidden/>{studioComposerActionLabel(action,settings?.language,settings?.promptTemplates)}</span>)}</div>}
    {!!sourceProposals.length&&<section className="r4-message-proposals" aria-label={r4Text(settings?.language,'此消息生成的方案','Proposals from this message')}><h4>{r4Text(settings?.language,'方案','Proposals')}</h4>{sourceProposals.map(proposal=><AgentR4ProposalCard key={`${proposal.id}@${proposal.revision}`} language={settings?.language} proposal={proposal} current={ownerCreation?.currentProposalRef===`${proposal.id}@${proposal.revision}`} compact disabled={archived||controlsBusy} onPrepare={()=>void prepareProposal(proposal)} onSelect={()=>selectProposal(proposal)} onApplyToWorkbench={()=>void previewProposalWorkbenchApply(proposal)}/>)}</section>}
    {message.content && <footer className="pi-message-actions"><button title={t('copy')} onClick={()=>void copy(message.content,message.id)}><LuCopy/>{t(copied===message.id?'copied':'copy')}</button>{message.role==='user' && <button onClick={()=>{prefill(message.content);setChatActions(message.actions??[])}}><LuPencil/>{t('editRequest')}</button>}</footer>}
  </article>;
  };
  const meter = studioContextMeter(chat?.context);
  const chatListMotion=useStudioRegionMotion(archivedView);
  const chats = workspace?.conversations.filter(item=>!!item.archivedAt===archivedView).filter((item)=>item.title.toLocaleLowerCase().includes(search.toLocaleLowerCase())) ?? [];
  const unboundMessageCount=chat?.messages.filter(message=>message.role!=='system'&&resolveR4MessageOwnership(message,creativeState).status!=='bound').length??0;
  const currentAttachments=chat?[...chat.messages.flatMap(message=>message.attachments),...chat.draftAttachments]:[];
  const currentReceipts=Object.values(creativeState?.operations??{}).filter(item=>item.creationId===currentCreation?.id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));

  const changeArchived = async (id: string, value: boolean) => {
    if (controlsBusy) return;
    try {const result=await window.naiDesktop.setAgentConversationArchived(id,value);if(result.ok){updateWorkspace(result.workspace);if(!value)setArchivedView(false);}else setError(result.message??t('statusError'));}catch(reason){setError(String(reason));}
  };
  const deleteChat=async(item:AgentConversation)=>{
    if(controlsBusy||['running','waiting-permission'].includes(item.status))return;
    if(!await confirmAction(t('deleteChatConfirm',item.title),t('deleteChat'),undefined,undefined,{confirm:t('deleteChat'),cancel:t('cancel')}))return;
    await mutateChat(window.naiDesktop.deleteAgentConversation(item.id));
  };
  const rowAction = (item: AgentConversation, action: string) => {if(action==='rename'){setChatName(item.title);setChatAction(item);}else if(action==='delete')void deleteChat(item);else void changeArchived(item.id,action==='archive');};
  const handleDrawerKeyDown=(event:ReactKeyboardEvent<HTMLDivElement>,side:'chats'|'creation')=>{
    if(event.key==='Escape'&&!event.defaultPrevented){event.preventDefault();if(side==='chats')setSidebarOpen(false);else setResourcesOpen(false);return;}
    if(!narrowLayout||event.key!=='Tab')return;
    const focusable=Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex="0"]')).filter(item=>!item.hidden&&item.getAttribute('aria-hidden')!=='true');
    const first=focusable[0],last=focusable.at(-1);
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
  };
  useEffect(()=>{
    if(!narrowLayout)return;
    const pane=sidebarOpen?leftPane.current:resourcesOpen?rightPane.current:null;
    const root=pageRoot.current;
    if(!pane||!root)return;
    drawerFocusReturn.current=document.activeElement instanceof HTMLElement?document.activeElement:null;
    const exceptions=new Set<HTMLElement>([pane,...Array.from(root.querySelectorAll<HTMLElement>('.pi-sidebar-scrim,.pi-resource-scrim'))]);
    const inerted=Array.from(root.children).map(node=>node as HTMLElement).filter(node=>!exceptions.has(node));
    const previousInert=inerted.map(node=>node.inert);
    inerted.forEach(node=>{node.inert=true;});
    const frame=requestAnimationFrame(()=>pane.querySelector<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]')?.focus({preventScroll:true}));
    return()=>{
      cancelAnimationFrame(frame);
      inerted.forEach((node,index)=>{node.inert=previousInert[index]??false;});
      const target=drawerFocusReturn.current;
      if(target?.isConnected)target.focus({preventScroll:true});
      drawerFocusReturn.current=null;
    };
  },[narrowLayout,sidebarOpen,resourcesOpen]);

  return <div ref={pageRoot} className={`pi-agent${sidebarOpen?' has-left-pane':''}${resourcesOpen?' has-right-pane':''}`}>
    <AgentR4CreationControls language={settings?.language} conversationTitle={chat?.title??''} creations={creations} currentCreationId={creativeState?.currentCreationId} scope={currentScope} queueCount={globalQueueCount} queueOpen={queueOpen} resourcesOpen={resourcesOpen} disabled={archived||optionsBusy||!chat} onScope={scope=>{if(chat)setScopeByConversation(current=>({...current,[chat.id]:scope}));}} onSelectCreation={selectCreation} onCreateCreation={createCreation} onToggleChats={()=>{setQueueOpen(false);if(window.innerWidth<=1100)setResourcesOpen(false);setSidebarOpen(value=>!value);}} onToggleQueue={()=>setQueueOpen(value=>!value)} onToggleResources={()=>{setQueueOpen(false);if(window.innerWidth<=1100)setSidebarOpen(false);setResourcesOpen(value=>!value);}}/>
    <AgentR4QueuePanel language={settings?.language} states={allCreativeStates} conversationTitles={conversationTitles} creationTitles={creationTitles} currentConversationId={chat?.id} currentCreationId={currentCreation?.id} canSteerCurrentReply={chat?.status==='running'} visible={queueOpen} onClose={()=>setQueueOpen(false)} onResumeQueue={sendResumeQueue} onResumeMessages={resumeMessages} onCancelMessage={cancelQueuedMessage} onRestoreMessage={restoreQueuedMessage} onSteerMessage={steerQueuedMessage} onCancelExecution={cancelExecution} onVerifyExecution={verifyExecution}/>
    <div ref={leftPane} id="pi-conversations-pane" className="pi-pane-slot pi-pane-left" role={narrowLayout&&sidebarOpen?'dialog':undefined} aria-modal={narrowLayout&&sidebarOpen?true:undefined} aria-label={narrowLayout&&sidebarOpen?t('chats'):undefined} {...disclosureAttributes(sidebarOpen)} onKeyDown={event=>handleDrawerKeyDown(event,'chats')}>
    {sidebarPresent&&<aside id="pi-conversations" className="pi-sidebar is-open" aria-label={t('chats')}>
      <button disabled={controlsBusy} title={controlsBusy?t('busySwitch'):undefined} onClick={()=>{setArchivedView(false);void mutateChat(window.naiDesktop.createAgentConversation(t('newChat')))}}><LuPlus/>{t('newChat')}</button>
      <label className="pi-search"><LuSearch aria-hidden/><input aria-label={t('searchChats')} placeholder={t('searchChats')} value={search} onChange={(event)=>setSearch(event.target.value)}/></label>
      <div className="pi-chat-scope" aria-label={t('chats')}><button aria-pressed={!archivedView} onClick={()=>setArchivedView(false)}><LuMessageSquare/>{t('activeChats')}</button><button aria-pressed={archivedView} onClick={()=>setArchivedView(true)}><LuArchive/>{t('archivedChats')}</button></div>
      <nav ref={chatListMotion}>{chats.map(item=><div className={`pi-chat-row${item.id===chat?.id?' is-active':''}`} key={item.id}><button className="pi-chat-select" aria-current={item.id===chat?.id?'page':undefined} disabled={controlsBusy} title={controlsBusy?t('busySwitch'):item.title} onClick={()=>void mutateChat(window.naiDesktop.selectAgentConversation(item.id))}>{item.archivedAt?<LuArchive/>:<LuMessageSquare/>}<span>{item.title}</span></button><SelectMenu value="" minMenuWidth={148} ariaLabel={`${t('chatActions')}: ${item.title}`} label={<LuEllipsis/>} className="pi-chat-more" popoverClassName="pi-chat-menu" disabled={controlsBusy} options={[{value:'rename',label:t('rename'),icon:<LuPencil/>},item.archivedAt?{value:'restore',label:t('restoreChat'),icon:<LuArchiveRestore/>}:{value:'archive',label:t('archiveChat'),icon:<LuArchive/>},{value:'delete',label:t('deleteChat'),icon:<LuTrash2/>,disabled:['running','waiting-permission'].includes(item.status)}]} onChange={action=>rowAction(item,action)}/></div>)}{!chats.length&&<p>{t(archivedView?'noArchivedChats':'noChats')}</p>}</nav>
      <div className="pi-sidebar-footer"><span className={`pi-model-dot ${configured?'is-ready':''}`}/><span role="status">{pending?t('statusPending'):running?t('statusRunning'):t(configured?'ready':'missingModel')}</span><button className="pi-icon" disabled={controlsBusy} aria-label={t('modelSettings')} title={t('modelSettings')} onClick={openSettings}><LuSettings/></button></div>
    </aside>}
    </div>
    {sidebarOpen && <button className="pi-sidebar-scrim" aria-label={t('close')} onClick={()=>setSidebarOpen(false)}/>}
    <button ref={leftToggle} className="pi-side-toggle pi-left-toggle" aria-label={t(sidebarOpen?'collapseChats':'expandChats')} title={t(sidebarOpen?'collapseChats':'expandChats')} aria-expanded={sidebarOpen} aria-controls="pi-conversations-pane" onClick={()=>{if(window.innerWidth<=1100)setResourcesOpen(false);setSidebarOpen(!sidebarOpen)}}>{sidebarOpen?<LuPanelLeftClose/>:<LuPanelLeftOpen/>}</button>
    <section className="pi-main">
      {!configured && !loading && !archived && <div className="pi-setup"><div><strong>{t('missingModel')}</strong><p>{t('setupBody')}</p></div><button className="pi-primary" onClick={openSettings}>{t('setup')}</button></div>}
      {archived&&<div className="pi-archive-banner"><LuArchive/><span>{t('archivedReadOnly')}</span><button disabled={controlsBusy} onClick={()=>chat&&void changeArchived(chat.id,false)}><LuArchiveRestore/>{t('restoreChat')}</button></div>}
      <div className="pi-transcript-wrap"><main className="pi-transcript" tabIndex={0} ref={transcript} aria-label={t('chats')} onWheel={event=>{if(event.deltaY<0)scrollFollower.current?.intentUp();}} onTouchStart={event=>{touchY.current=event.touches[0]?.clientY;}} onTouchMove={event=>{const y=event.touches[0]?.clientY;if(y!==undefined&&touchY.current!==undefined&&y>touchY.current)scrollFollower.current?.intentUp();touchY.current=y;}} onPointerDown={event=>{if(event.target===event.currentTarget)scrollFollower.current?.intentUp();}} onKeyDown={event=>{if(event.target===event.currentTarget&&['ArrowUp','PageUp','Home'].includes(event.key))scrollFollower.current?.intentUp();}} onScroll={()=>{const el=transcript.current;if(el){scrollFollower.current?.scrolled();if(chat)readingPositions.current[chat.id]={top:el.scrollTop,following:following.current};}}}>
        <div className="pi-transcript-content">{loading ? <p role="status">{t('statusRunning')}</p> : !chat?.messages.length && <div className="pi-empty"><LuSparkles className="pi-empty-icon"/><h3>{t('heroTitle')}</h3><p>{t('heroBody')}</p><div className="pi-starters"><button onClick={()=>prefill(t('quickSettingsDraft'))}><LuSettings/>{t('quickSettings')}</button><button onClick={()=>prefill(t('quickPromptDraft'))}><LuPencil/>{t('quickPrompt')}</button><button onClick={()=>{prefill(t('quickReferenceDraft'));void importAttachments()}}><LuImage/>{t('quickReference')}</button></div></div>}
        {currentScope==='creation'&&unboundMessageCount>0&&<p className="r4-filter-note" role="status">{r4Text(settings?.language,`当前仅显示明确归属此创作的消息；${unboundMessageCount} 条历史或归属冲突消息仍保留在“全部对话”中。`,`Only explicitly owned messages are shown. ${unboundMessageCount} unversioned or conflicting messages remain in All messages.`)}</p>}
        {visibleMessages.filter(item=>item.role!=='system').map(renderMessage)}

        {pendingQuestion&&<AgentQuestionCards key={pendingQuestion.id} request={pendingQuestion} language={settings?.language} onRespond={async response=>{
          const result=await window.naiDesktop.respondAgentQuestion?.(response)??{ok:false};
          if(!result.ok)setQuestions(await window.naiDesktop.getAgentPendingQuestions?.()??[]);
          return result;
        }}/>}
        {running&&!pending&&!pendingQuestion && <div className="pi-working" role="status"><span className="pi-pulse"/><span>{t('workingBody')}</span></div>}
      </div></main>{away&&<button className="pi-latest" onClick={()=>{scrollFollower.current?.latest()}}><LuArrowDown/>{t('latest')}</button>}</div>
      {pending && <div className="pi-decision-tray" aria-label={t("decisionArea")}>{pending.type==='langbai_generate_image'?plan(pending.metadata??{},true):<section className="pi-plan"><header><strong>{t('confirmTool',pending.title)}</strong></header><div className="pi-plan-body"><p>{t('confirmationHint')}</p>{pending.metadata?.positivePrompt!=null&&<p>{String(pending.metadata.positivePrompt)}</p>}{Boolean(pending.metadata?.paid)&&<p className="pi-cost">{typeof pending.metadata?.estimatedAnlas==='number'?t('estimatedCost',String(pending.metadata.estimatedAnlas)):t('unknownCost')} {t('paidWarning')}</p>}<details><summary>{t('details')}</summary><pre>{JSON.stringify(pending.metadata,null,2)}</pre></details></div><footer><button disabled={answering} onClick={()=>void respond('reject')}>{t('cancel')}</button><button className="pi-primary" disabled={answering} onClick={()=>void respond('once')}>{t('confirm')}</button></footer></section>}</div>}
      {error && <div role="alert" className="pi-notice pi-notice-error pi-global-error"><span>{error}</span><button className="pi-icon" aria-label={t('close')} onClick={()=>setError('')}><LuX/></button></div>}
      <div className={`pi-compose-area${dragging?' is-file-dragging':''}`} onDragOver={e=>{if(!archived&&chat&&Array.from(e.dataTransfer.types).includes('Files')){e.preventDefault();e.dataTransfer.dropEffect='copy';setDragging(true);}}} onDragLeave={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node|null))setDragging(false);}} onDrop={e=>{setDragging(false);if(Array.from(e.dataTransfer.types).includes('Files')){e.preventDefault();void importFileData(Array.from(e.dataTransfer.files));}}}>
        {uploading&&<p role="status">{t('uploadingAttachments')}</p>}{running&&!!chat?.draftAttachments.length&&<small>{t('nextMessageAttachments')}</small>}
        {!!chat?.draftAttachments.length && <div className="pi-attachments">{chat.draftAttachments.map(item=><div key={item.id}>{item.kind==='image'&&item.fileUrl?<button className="pi-thumb" onClick={()=>setImage(item)} aria-label={t('preview')}><img src={item.fileUrl} alt={item.name}/></button>:<LuImage/>}<span>{item.name}</span><button className="pi-icon" disabled={archived||uploading} aria-label={t('removeAttachment')} onClick={()=>void mutateChat(window.naiDesktop.deleteAgentAttachment(chat.id,item.id))}><LuX/></button></div>)}</div>}
        {!!selectedActions.length&&<div className="pi-selected-actions" aria-label={t('selectedActions')}>{selectedActions.map((action,index)=><span key={index}><LuWrench aria-hidden/><span>{studioComposerActionLabel(action,settings?.language,settings?.promptTemplates)}</span><button className="pi-icon" disabled={archived||controlsBusy} aria-label={`${t('removeAction')}: ${studioComposerActionLabel(action,settings?.language,settings?.promptTemplates)}`} onClick={()=>setChatActions(selectedActions.filter((_,i)=>i!==index))}><LuX/></button></span>)}</div>}
        <div className="pi-composer-shell" style={{height:effectiveComposerHeight}}>
        <div className="pi-composer-grip" role="separator" tabIndex={0} aria-orientation="horizontal" aria-label={t('resizeComposer')} title={t('resizeComposer')} aria-valuemin={108} aria-valuemax={Math.round(resizeMax())} aria-valuenow={effectiveComposerHeight} onPointerDown={e=>{if(e.button!==0)return;e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);resizePress.current={y:e.clientY,height:effectiveComposerHeight};}} onPointerMove={e=>{const start=resizePress.current;if(start)resizeComposer(start.height+start.y-e.clientY);}} onPointerUp={()=>{resizePress.current=null;}} onPointerCancel={()=>{resizePress.current=null;}} onLostPointerCapture={()=>{resizePress.current=null;}} onKeyDown={e=>{if(['ArrowUp','ArrowDown','Home','End'].includes(e.key)){e.preventDefault();resizeComposer(e.key==='Home'?108:e.key==='End'?resizeMax():effectiveComposerHeight+(e.key==='ArrowUp'?16:-16));}}}><span/></div>
        <div className="pi-composer"><button className="pi-icon" disabled={archived||!chat||uploading} aria-label={t('addAttachment')} onClick={()=>void importAttachments()}><LuPlus/></button><textarea readOnly={archived} onPaste={event=>{const files=Array.from(event.clipboardData.files);if(files.length){event.preventDefault();void importFileData(files);}else if(!event.clipboardData.getData('text/plain')&&!archived&&chat&&!uploadLock.current){void window.naiDesktop.readAgentClipboardFiles().then(images=>{if(images.length)void importFileData(images);}).catch(reason=>setError(String(reason)));}}} ref={inputRef} aria-label={t('compose')} title={t('sendHint')} value={text} rows={1} onChange={event=>setText(event.target.value)} placeholder={t(archived?'archivedReadOnly':'hint')} onKeyDown={event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing&&event.nativeEvent.keyCode!==229){event.preventDefault();void run()}}}/>{running&&<button className="pi-icon pi-stop" aria-label={t('stop')} title={t('stop')} onClick={()=>chat&&void window.naiDesktop.abortAgentMessage(chat.id)}><LuSquare/></button>}<button className="pi-primary pi-send-queue" aria-label={r4Text(settings?.language,'发送并排队','Send and queue')} title={r4Text(settings?.language,'发送并排队','Send and queue')} disabled={archived||busy||uploading||optionsBusy||!configured||(!text.trim()&&!selectedActions.length&&!chat?.draftAttachments.length)} onClick={()=>void run('queue')}><LuArrowUp/><span>{r4Text(settings?.language,'排队发送','Queue')}</span></button>{chat?.status==='running'&&<button className="pi-steer-reply" aria-label={r4Text(settings?.language,'立即引导回复','Guide the current reply')} title={r4Text(settings?.language,'立即引导回复','Guide the current reply')} disabled={archived||busy||uploading||optionsBusy||!configured||(!text.trim()&&!selectedActions.length&&!chat?.draftAttachments.length)} onClick={()=>void run('steer')}><LuSparkles/><span>{r4Text(settings?.language,'引导回复','Steer')}</span></button>}</div></div>
        <div className="pi-compose-meta">
          {creativeState?.configurationIssue&&<div className="r4-configuration-issue" role="alert"><strong>{r4Text(settings?.language,'配置需要修复','Configuration needs repair')}</strong><span>{creativeState.configurationIssue}</span><span>{r4Text(settings?.language,'请使用下方模型选择器与助手预设控件重新选择有效配置；修复前不能发送消息或确认生图。','Choose valid settings with the model and assistant preset controls below. Sending and image generation stay disabled until repaired.')}</span></div>}
          {restoredDraftConfig&&<span className="r4-restored-config-notice" role="status" title={r4Text(settings?.language,'发送将使用恢复消息的模型和预设快照。','The next send will use the restored message model and preset snapshot.')}>{r4Text(settings?.language,`恢复草稿配置：${restoredDraftConfig.providerRef.providerId} · ${restoredDraftConfig.modelId} · ${restoredDraftConfig.presetId??'无预设'}${restoredDraftConfig.enabled?'（预设启用）':'（预设停用）'}`,`Restored draft: ${restoredDraftConfig.providerRef.providerId} · ${restoredDraftConfig.modelId} · ${restoredDraftConfig.presetId??'no preset'} (${restoredDraftConfig.enabled?'preset enabled':'preset disabled'})`)}</span>}
          <div className="pi-compose-config-row" role="group" aria-label={r4Text(settings?.language,'对话配置','Conversation configuration')}>
            <div className="pi-compose-model"><span>{r4Text(settings?.language,'对话模型','Conversation model')}</span><AgentModelPicker registry={modelPickerRegistry} language={settings?.language} disabled={optionsBusy||saving} onSelect={chooseModel} onManage={openSettings}/></div>
            <AgentR4AssistantPresetControl language={settings?.language} presets={creativeState?.assistantPresets??{}} binding={creativeState?.assistantPresetBinding} defaults={creativeState?.assistantPresetDefaultBinding} restoredConfig={restoredDraftConfig} disabled={archived||optionsBusy||!chat} onChange={setPresetBinding} onSetDefault={setNewChatDefault}/>{configSwitchNotice&&<span className="r4-config-switch-notice" role="status">{r4Text(settings?.language,'之后发送生效，已排队保持原版本','Applies to the next send; queued messages keep their snapshot')}</span>}
            <button ref={contextRef} className="pi-context-trigger" aria-expanded={contextOpen} aria-label={t('context')} onClick={()=>setContextOpen(value=>!value)} title={`${t('context')} · ${meter.used.toLocaleString()} / ${meter.limit.toLocaleString()} ${t(meter.estimated?'tokensEstimated':'tokensReported')}`}><LuGauge aria-hidden/><span>{Math.round(meter.percent)}%</span></button>{contextOpen&&<AnchoredPopover anchor={contextRef} onClose={closeContext} label={t('context')}><div className="pi-context-panel-content"><p>{t('context')} · {meter.used.toLocaleString()} / {meter.limit.toLocaleString()} {t(meter.estimated?'tokensEstimated':'tokensReported')}</p><progress className={chat?.context.danger?'is-danger':undefined} aria-label={t('context')} max={100} value={meter.percent}/><div className="pi-context-controls"><button disabled={archived||controlsBusy||!configured||!chat?.messages.length} onClick={()=>void compact()}>{t(compacting?'statusRunning':'compactNow')}</button><label><input type="checkbox" disabled={controlsBusy} checked={settings?.agentAutoCompact===true} onChange={async event=>{try{await window.naiDesktop.setSetting('agentAutoCompact',event.target.checked);await refreshSettings()}catch(reason){setError(String(reason))}}}/>{t('autoCompact')}</label><label>{t('compactThreshold')}<SelectMenuCompat aria-label={t('compactThreshold')} disabled={controlsBusy} value={clampCompactThreshold(settings?.agentAutoCompactThreshold)} onChange={async event=>{try{await window.naiDesktop.setSetting('agentAutoCompactThreshold',Number(event.target.value));await refreshSettings()}catch(reason){setError(String(reason))}}}>{Array.from(new Set([0.5,0.7,0.8,0.88,0.9,0.95,clampCompactThreshold(settings?.agentAutoCompactThreshold)])).sort((a,b)=>a-b).map(value=><option key={value} value={value}>{Math.round(value*100)}%</option>)}</SelectMenuCompat></label><small>{t('compactHint')}</small></div>{chat?.lastSummary&&<pre>{chat.lastSummary}</pre>}</div></AnchoredPopover>}
          </div>
          <div className="pi-compose-actions-row" role="group" aria-label={r4Text(settings?.language,'执行与查询','Execution and search')}>
            <div className="pi-execution-modes" role="group" aria-label={t('approvalMode')}><button disabled={archived||controlsBusy||!chat} aria-pressed={sessionOptions.approvalMode==='confirm'} title={t('confirmModeHint')} onClick={()=>void saveOptions({studioApprovalMode:'confirm'})}><LuShieldCheck/>{t('confirmMode')}</button><button className={sessionOptions.approvalMode==='auto'?'pi-full-auto':''} disabled={archived||controlsBusy||!chat} aria-pressed={sessionOptions.approvalMode==='auto'} title={t('autoModeHint')} onClick={()=>void saveOptions({studioApprovalMode:'auto'})}><LuZap/>{t('autoMode')}</button></div>
            <button className="pi-option-toggle" disabled={archived||controlsBusy||!chat} aria-pressed={sessionOptions.webSearchEnabled} title={t('webToggleHint')} onClick={()=>void saveOptions({studioWebSearchEnabled:!sessionOptions.webSearchEnabled})}><LuSearch/>{t('webQuery')}</button>
            {supportsNAIMediumEffort(imageParams.model)&&<>
            <button ref={imageOptionsAnchor} type="button" className="pi-option-toggle pi-image-options-trigger" disabled={archived||controlsBusy} aria-expanded={imageOptionsOpen} aria-label={r4Text(settings?.language,'生图设置','Image settings')} onClick={()=>setImageOptionsOpen(value=>!value)}><LuSettings aria-hidden/><span>{r4Text(settings?.language,'生图设置','Image settings')}</span><span className="pi-image-options-value">{imageParams.effort==='medium'?'Medium':'High'}</span><LuChevronDown aria-hidden/></button>
            {imageOptionsOpen&&<AnchoredPopover anchor={imageOptionsAnchor} onClose={closeImageOptions} label={r4Text(settings?.language,'生图设置','Image settings')}><div className="pi-image-options"><fieldset disabled={archived||controlsBusy}><EffortControl model={imageParams.model} value={imageParams.effort??'high'} language={settings?.language} onChange={effort=>setImageParam('effort',effort)}/></fieldset><p>{r4Text(settings?.language,'用于下一次图片生成，不改变对话模型。','Applies to the next image generation; the conversation model stays the same.')}</p></div></AnchoredPopover>}
          </>}
            {sessionOptions.approvalMode==='auto'&&<small className="pi-auto-note" role="status">{t('autoCostNote')}</small>}
          </div>
        </div>
      </div>
    </section>
    <button ref={rightToggle} className="pi-side-toggle pi-right-toggle" aria-label={t(resourcesOpen?'collapseResources':'expandResources')} title={t(resourcesOpen?'collapseResources':'expandResources')} aria-expanded={resourcesOpen} aria-controls="pi-creative-resources-pane" onClick={()=>{if(window.innerWidth<=1100)setSidebarOpen(false);setResourcesOpen(!resourcesOpen)}}>{resourcesOpen?<LuPanelRightClose/>:<LuPanelRightOpen/>}</button>
    {resourcesOpen&&<button className="pi-resource-scrim" aria-label={t('close')} onClick={()=>setResourcesOpen(false)}/>}
    <div ref={rightPane} id="pi-creative-resources-pane" className="pi-pane-slot pi-pane-right" role={narrowLayout&&resourcesOpen?'dialog':undefined} aria-modal={narrowLayout&&resourcesOpen?true:undefined} aria-label={narrowLayout&&resourcesOpen?r4Text(settings?.language,'当前创作面板','Current creation panel'):undefined} {...disclosureAttributes(resourcesOpen)} onKeyDown={event=>handleDrawerKeyDown(event,'creation')}>
    {resourcesPresent&&<div className="r4-right-panel"><div className="r4-right-panel-tabs" role="tablist" aria-label={r4Text(settings?.language,'创作和资源面板','Creation and resources')}><button type="button" role="tab" aria-selected={rightPanelTab==='creative'} onClick={()=>setRightPanelTab('creative')}><LuSparkles/>{r4Text(settings?.language,'创作','Creation')}</button><button type="button" role="tab" aria-selected={rightPanelTab==='resources'} onClick={()=>setRightPanelTab('resources')}><LuFileText/>{r4Text(settings?.language,'资源','Resources')}</button></div>{rightPanelTab==='creative'?<AgentR4CreativePanel language={settings?.language} state={creativeState} creation={currentCreation} currentProposal={currentProposal} proposals={proposals} artworks={artworks} selectedArtwork={selectedArtwork?{...selectedArtwork,url:selectedArtwork.url??attachmentUrl(selectedArtwork)}:undefined} preparation={preparation} executions={executions} receipts={currentReceipts} attachments={currentAttachments} disabled={archived||controlsBusy||!chat} generationDisabled={!configured} onSelectProposal={selectProposal} onPrepare={prepareProposal} onPreviewWorkbenchApply={previewProposalWorkbenchApply} onSelectArtwork={selectArtwork} onOpenArtwork={item=>void openArtwork(item)} onSetEditSource={binding=>void continueEditingFromPanel(binding)} onRemoveEditSource={clearEditSource} onAddReference={(asset,purpose)=>void addReference(asset,purpose)} onChangeReference={changeReference} onRemoveReference={removeReference} onSaveInputs={saveCreationInputs} onApprovePreparation={approvePreparation} onDenyPreparation={denyPreparation} onUndo={undoReceipt} attachmentUrl={attachmentUrl}/>:<AgentResourcePanel tab={resourceTab} onTab={setResourceTab} workspace={workspace} chat={chat} language={settings?.language} disabled={archived||controlsBusy||!chat} onChange={patch=>void saveOptions(patch)} onImport={kind=>void importResources(kind)} onWorkspaceChange={updateWorkspace}/>}</div>}
    </div>
    {settingsOpen&&settings&&<AgentDialog title={t('agentModelsTitle')} close={()=>{if(!saving)setSettingsOpen(false)}}><AgentProviderSettings settings={settings} disabled={controlsBusy} onSaved={()=>setSettingsOpen(false)} onCancel={()=>setSettingsOpen(false)}/></AgentDialog>}
    {workbenchPromptPreview&&<AgentDialog title={r4Text(settings?.language,'将方案应用到图像工作台','Apply proposal to image workbench')} close={()=>{if(!workbenchApplyBusy)setWorkbenchPromptPreview(undefined)}}><AgentR4WorkbenchApplyPreview language={settings?.language} preview={workbenchPromptPreview} busy={workbenchApplyBusy} onClose={()=>setWorkbenchPromptPreview(undefined)} onApply={()=>void applyWorkbenchPromptPreview()}/></AgentDialog>}
    {chatAction&&<AgentDialog title={t('rename')} close={()=>setChatAction(undefined)}><label>{t('chatName')}<input autoFocus value={chatName} maxLength={100} onChange={e=>setChatName(e.target.value)}/></label><footer><button onClick={()=>setChatAction(undefined)}>{t('cancel')}</button><button className="pi-primary" disabled={!chatName.trim()||controlsBusy} onClick={()=>{void mutateChat(window.naiDesktop.renameAgentConversation(chatAction.id,chatName.trim()));setChatAction(undefined)}}>{t('save')}</button></footer></AgentDialog>}
    {image?.fileUrl&&<AppPortal><div className="tavern-image-lightbox" role="dialog" aria-modal="true" aria-label={t('preview')}><button className="tavern-image-lightbox-close" aria-label={t('close')} onClick={()=>setImage(undefined)}><LuX/></button><PreviewImageViewer images={[{src:image.fileUrl,alt:image.name}]} index={0} onIndex={()=>{}} showNavigation={false} onBackgroundClick={()=>setImage(undefined)}/></div></AppPortal>}
      {viewerArtworkId&&viewerConversationId&&creativeStates[viewerConversationId]&&<AgentR4ArtworkViewer language={settings?.language} artworks={Object.values(creativeStates[viewerConversationId].artworks).map(item=>({...item,url:item.url??attachmentUrl(item)}))} initialArtworkId={viewerArtworkId} onClose={()=>{setViewerArtworkId(undefined);setViewerConversationId(undefined);}} onDownload={item=>void runR4CommandFor(item.conversationId,'download_artwork',{artworkId:item.id},item.creationId)} onContinueEditing={item=>void continueEditingArtwork(item)} onSelectArtwork={selectArtwork} onAddReference={(item,role,purpose,include)=>void addReferenceFromViewer(item,role,purpose,include)}/>}
  </div>;
}

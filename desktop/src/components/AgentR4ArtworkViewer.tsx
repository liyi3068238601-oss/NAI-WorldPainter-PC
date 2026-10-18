import {useEffect, useMemo, useRef, useState, type KeyboardEvent} from 'react';
import {createPortal} from 'react-dom';
import {LuChevronLeft, LuChevronRight, LuDownload, LuMaximize, LuMinus, LuPlus, LuPencil, LuX} from 'react-icons/lu';
import type {R4Artwork, R4ReferencePurpose} from '../agent/r4-types';
import {r4ViewerArtworks, r4Text} from '../agent/r4-ui';

export function AgentR4ArtworkViewer(props: {
  language: unknown;
  artworks: R4Artwork[];
  initialArtworkId: string;
  onClose: () => void;
  onDownload: (artwork:R4Artwork) => void;
  onContinueEditing: (artwork:R4Artwork) => void;
  onSelectArtwork: (artwork:R4Artwork) => void;
  onAddReference: (artwork:R4Artwork,role:'reference'|'discussion',purpose?:R4ReferencePurpose,includeInGeneration?:boolean) => void;
}) {
  const t=(zh:string,en:string)=>r4Text(props.language,zh,en);
  const previousFocus=useRef<HTMLElement|null>(null);
  const closeRef=useRef<HTMLButtonElement>(null),previousRef=useRef<HTMLButtonElement>(null),nextRef=useRef<HTMLButtonElement>(null),scopeRef=useRef<HTMLSelectElement>(null),titleRef=useRef<HTMLHeadingElement>(null),viewportRef=useRef<HTMLDivElement>(null);
  const [scope,setScope]=useState<'batch'|'creation'>('batch');
  const [selectedId,setSelectedId]=useState(props.initialArtworkId);
  const [zoom,setZoom]=useState(1);
  const [fit,setFit]=useState(true);
  const [size,setSize]=useState({width:0,height:0});
  const [imageSize,setImageSize]=useState<{width:number;height:number}>();
  const [referencePurpose,setReferencePurpose]=useState<'discussion'|R4ReferencePurpose>('discussion');
  const [includeInGeneration,setIncludeInGeneration]=useState(false);
  const selectedBase=props.artworks.find(item=>item.id===selectedId)??props.artworks.find(item=>item.id===props.initialArtworkId);
  const visible=useMemo(()=>selectedBase?r4ViewerArtworks(props.artworks,selectedBase.id,scope):[],[props.artworks,selectedBase?.id,scope]);
  const index=Math.max(0,visible.findIndex(item=>item.id===selectedBase?.id));
  const current=visible[index]??selectedBase;
  const fitScale=imageSize&&size.width&&size.height?Math.min(size.width/imageSize.width,size.height/imageSize.height):1;
  const imageScale=fit?Math.max(.05,fitScale):zoom;

  useEffect(()=>{
    previousFocus.current=document.activeElement instanceof HTMLElement?document.activeElement:null;
    closeRef.current?.focus({preventScroll:true});
    const originalOverflow=document.body.style.overflow;
    document.body.style.overflow='hidden';
    return()=>{document.body.style.overflow=originalOverflow;previousFocus.current?.focus({preventScroll:true});};
  },[]);
  useEffect(()=>{
    const observer=new ResizeObserver(entries=>{const rect=entries[0]?.contentRect;if(rect)setSize({width:rect.width,height:rect.height});});
    if(viewportRef.current)observer.observe(viewportRef.current);
    return()=>observer.disconnect();
  },[]);
  useEffect(()=>{
    setFit(true);setZoom(1);setImageSize(undefined);setReferencePurpose('discussion');setIncludeInGeneration(false);
    if(viewportRef.current)viewportRef.current.scrollTo(0,0);
  },[current?.id]);

  const focusAvailableNavigation=(direction:-1|1,targetIndex:number)=>{
    requestAnimationFrame(()=>{
      if(direction>0&&targetIndex>=visible.length-1){
        if(!previousRef.current?.disabled)previousRef.current?.focus({preventScroll:true});else scopeRef.current?.focus({preventScroll:true});
      }else if(direction<0&&targetIndex<=0){
        if(!nextRef.current?.disabled)nextRef.current?.focus({preventScroll:true});else scopeRef.current?.focus({preventScroll:true});
      }
    });
  };
  const move=(direction:-1|1)=>{
    const nextIndex=index+direction;
    if(nextIndex<0||nextIndex>=visible.length)return;
    const next=visible[nextIndex];setSelectedId(next.id);props.onSelectArtwork(next);focusAvailableNavigation(direction,nextIndex);
  };
  const close=(event?:KeyboardEvent)=>{if(event?.key==='Escape'){event.preventDefault();event.stopPropagation();}props.onClose();};
  const trapFocus=(event:KeyboardEvent<HTMLDivElement>)=>{
    if(event.key==='Escape'){close(event);return;}
    if(event.key!=='Tab')return;
    const root=event.currentTarget.querySelector<HTMLElement>('[role="dialog"]');
    const focusable=Array.from(root?.querySelectorAll<HTMLElement>('button:not([disabled]),select:not([disabled]),input:not([disabled]),[tabindex="0"]')??[]).filter(item=>!item.hidden);
    const first=focusable[0],last=focusable.at(-1);
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
  };

  if(!current){
    return createPortal(<div className="r4-viewer-backdrop" role="presentation" onMouseDown={event=>{if(event.target===event.currentTarget)close();}} onKeyDown={trapFocus}>
      <section className="r4-artwork-viewer" role="dialog" aria-modal="true" aria-label={t('作品查看器','Artwork viewer')}><header><h2>{t('作品查看器','Artwork viewer')}</h2><button ref={closeRef} type="button" aria-label={t('关闭','Close')} onClick={()=>props.onClose()}><LuX/></button></header><p>{t('当前创作还没有可查看的作品。','This creation has no artwork to view.')}</p></section>
    </div>,document.body);
  }

  const assetUrl=current.url;
  const resolvedSeed=current.resolvedSeed;
  const seedSource=current.resolvedSeedSource;
  const purposeOptions:[string,string][]=[['discussion',t('仅讨论','Discussion only')],['color',t('色彩','Color')],['composition',t('构图','Composition')],['character',t('角色','Character')],['atmosphere',t('氛围','Atmosphere')]];

  return createPortal(<div className="r4-viewer-backdrop" role="presentation" onMouseDown={event=>{if(event.target===event.currentTarget)close();}} onKeyDown={event=>{trapFocus(event);if(event.defaultPrevented||event.key==='Escape'||event.key==='Tab')return;const target=event.target;if(target instanceof HTMLElement&&(target.isContentEditable||target.closest('button,select,input,textarea,[contenteditable="true"]')))return;if(event.key==='ArrowLeft')move(-1);if(event.key==='ArrowRight')move(1);}}>
    <section className="r4-artwork-viewer" role="dialog" aria-modal="true" aria-label={t('作品查看器','Artwork viewer')}>
      <header><div><h2 ref={titleRef} tabIndex={-1}>{current.name}</h2><span>{index+1} / {visible.length} · {current.width&&current.height?`${current.width} × ${current.height}`:t('尺寸未知','Dimensions unknown')}</span></div><button ref={closeRef} type="button" aria-label={t('关闭','Close')} title={t('关闭','Close')} onClick={()=>props.onClose()}><LuX/></button></header>
      <div className="r4-viewer-toolbar">
        <div className="r4-viewer-nav"><button ref={previousRef} type="button" disabled={index<=0} aria-label={t('上一张','Previous image')} title={t('上一张','Previous image')} onClick={()=>move(-1)}><LuChevronLeft/></button><button ref={nextRef} type="button" disabled={index>=visible.length-1} aria-label={t('下一张','Next image')} title={t('下一张','Next image')} onClick={()=>move(1)}><LuChevronRight/></button><span>{scope==='batch'?t('本批次','This batch'):t('当前创作','This creation')}</span></div>
        <label className="r4-viewer-scope"><span>{t('范围','Range')}</span><select ref={scopeRef} value={scope} onChange={event=>{setScope(event.target.value as 'batch'|'creation');setFit(true);setZoom(1);}}><option value="batch">{t('本批次','This batch')}</option><option value="creation">{t('当前创作全部作品','All artwork in this creation')}</option></select></label>
        <div className="r4-viewer-zoom"><button type="button" aria-label={t('缩小','Zoom out')} title={t('缩小','Zoom out')} disabled={!fit&&zoom<=.1} onClick={()=>{setZoom(value=>Math.max(.1,(fit?imageScale:value)-.2));setFit(false);}}><LuMinus/></button><span>{fit?`${Math.round(imageScale*100)}% · ${t('适应','Fit')}`:`${Math.round(zoom*100)}%`}</span><button type="button" aria-label={t('放大','Zoom in')} title={t('放大','Zoom in')} disabled={!fit&&zoom>=4} onClick={()=>{setZoom(value=>Math.min(4,(fit?imageScale:value)+.2));setFit(false);}}><LuPlus/></button><button type="button" aria-label={t('适应窗口','Fit to window')} title={t('适应窗口','Fit to window')} aria-pressed={fit} onClick={()=>setFit(true)}><LuMaximize/></button></div>
      </div>
      <div className="r4-viewer-viewport" ref={viewportRef}>
        {assetUrl?<img className="r4-viewer-image" src={assetUrl} alt={current.name} style={{width:imageSize?Math.max(1,imageSize.width*imageScale):undefined,height:imageSize?Math.max(1,imageSize.height*imageScale):undefined}} onLoad={event=>setImageSize({width:event.currentTarget.naturalWidth,height:event.currentTarget.naturalHeight})}/>:<div className="r4-viewer-unavailable"><span>{t('当前文件不可读取','This file is unavailable')}</span></div>}
      </div>
      <footer className="r4-viewer-footer">
        <div className="r4-viewer-seed"><strong>{t('实际种子','Resolved seed')}</strong><span>{resolvedSeed==null?t('未返回','Not returned'):resolvedSeed}</span><small>{seedSource==='provider_receipt'?t('来源：服务回执','Source: provider receipt'):seedSource==='verified_embedded_metadata'?t('来源：已验证嵌入元数据','Source: verified embedded metadata'):t('来源未知','Source unknown')}</small></div>
        <div className="r4-viewer-actions"><button type="button" disabled={!assetUrl} onClick={()=>props.onDownload(current)}><LuDownload/>{t('下载原图','Download original')}</button><button type="button" onClick={()=>props.onContinueEditing(current)}><LuPencil/>{t('继续修改','Continue editing')}</button><label className="r4-viewer-reference"><span>{t('作为参考','Use as reference')}</span><select value={referencePurpose} onChange={event=>{setReferencePurpose(event.target.value as typeof referencePurpose);setIncludeInGeneration(false);}}>{purposeOptions.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><label className="r4-viewer-include"><input type="checkbox" checked={includeInGeneration} disabled={referencePurpose==='discussion'} onChange={event=>setIncludeInGeneration(event.target.checked)}/>{t('参与生成','Use in generation')}</label><button type="button" onClick={()=>props.onAddReference(current,referencePurpose==='discussion'?'discussion':'reference',referencePurpose==='discussion'?undefined:referencePurpose,referencePurpose==='discussion'?false:includeInGeneration)}>{t('添加参考','Add reference')}</button></div>
      </footer>
    </section>
  </div>,document.body);
}

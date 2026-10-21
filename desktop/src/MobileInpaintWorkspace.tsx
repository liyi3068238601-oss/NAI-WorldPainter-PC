import {mobileInpaintText} from "./mobile-inpaint-text";
import {lazy,Suspense,type ReactNode} from 'react';
import {useAppStore} from './store';
import {useMobileInpaintStore} from './mobile-inpaint-store';
import {MobileInpaintPanel} from './MobileInpaintPanel';
import './mobile-inpaint.css';
const Canvas=lazy(()=>import('./MobileInpaintCanvas').then(m=>({default:m.MobileInpaintCanvas})));

export function MobileInpaintWorkspace({children}:{children:ReactNode}) {
  const language=useAppStore(state=>state.settings?.language);
  const mt=(key:string,values:Record<string,string|number>={})=>mobileInpaintText(language,key,values);
  const mode=useMobileInpaintStore(s=>s.mode),update=useMobileInpaintStore(s=>s.update);
  const busy=useMobileInpaintStore(s=>s.busy),generating=useAppStore(s=>s.isGenerating);
  return <div className="inpaint-mode-workspace">
    <div className="inpaint-mode-switch" role="group" aria-label={mt("局部重绘版本")}>
      <button type="button" aria-pressed={mode==='legacy'} disabled={busy||generating} className={`btn ${mode==='legacy'?'btn-primary':'btn-secondary'}`} onClick={()=>update({mode:'legacy'})}>{mt("旧模式")}</button>
      <button type="button" aria-pressed={mode==='mobile'} disabled={busy||generating} className={`btn ${mode==='mobile'?'btn-primary':'btn-secondary'}`} onClick={()=>update({mode:'mobile'})}>{mt("新模式 · 手机端")}</button>
    </div>
    <div className="inpaint-version-canvas" hidden={mode!=='legacy'}>{children}</div>
    <div className="inpaint-version-canvas" hidden={mode!=='mobile'}><Suspense fallback={<div className="lazy-tool-loading">{mt("正在加载新版重绘…")}</div>}><Canvas/></Suspense></div>
  </div>;
}

export function InpaintModePanel({legacy,openSettings}:{legacy:ReactNode;openSettings:()=>void}) {
  const mode=useMobileInpaintStore(s=>s.mode);
  return mode==='mobile'?<MobileInpaintPanel openSettings={openSettings}/>:legacy;
}

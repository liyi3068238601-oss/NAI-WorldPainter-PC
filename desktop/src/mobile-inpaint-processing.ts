import {composeMobile,rasterizeMobile,alignMobileMask,maskMobileLayer,type MobilePixels,type MobileRect,type MobileStroke,type MobileLayer} from './mobile-inpaint';
export type MobileProcessingRequest=
 | {kind:'prepare';source:MobilePixels;strokes:MobileStroke[];layers:MobileLayer[];worldRect:MobileRect;output:{width:number;height:number};expand:number}
 | {kind:'layer';generated:MobilePixels;mask:MobilePixels;base:MobilePixels;outward:number}
 | {kind:'compose';source:MobilePixels;strokes:MobileStroke[];layers:MobileLayer[]};
export function computeMobilePixels(request:MobileProcessingRequest){
  if(request.kind==='compose')return composeMobile(request.source,request.strokes,request.layers.filter(layer=>layer.visible));
  if(request.kind==='layer'){
    const image=maskMobileLayer(request.generated,request.mask,request.outward,undefined,request.base);
    const comparison=composeMobile(request.base,[],[{image,worldRect:{x:0,y:0,width:image.width,height:image.height},visible:true}]);
    return {image,comparison};
  }
  const base=composeMobile(request.source,request.strokes,[]);
  const raster=rasterizeMobile(base,request.worldRect,request.output,request.strokes.filter(stroke=>stroke.target==='mask'),request.expand);
  const mask=alignMobileMask(raster.mask);
  const before=composeMobile(request.source,request.strokes,request.layers.filter(layer=>layer.visible));
  return {image:raster.image,mask,before:rasterizeMobile(before,request.worldRect,request.output,[],0).image};
}
export async function processMobilePixels(request:MobileProcessingRequest):Promise<ReturnType<typeof computeMobilePixels>>{
  // Node tests use the same deterministic implementation; Electron uses a worker
  // so source-sized compositing and mask feathering do not block canvas input.
  if(typeof Worker==='undefined')return computeMobilePixels(request);
  const worker=new Worker(new URL('./mobile-inpaint-worker.ts',import.meta.url),{type:'module'});
  return new Promise((resolve,reject)=>{
    worker.onmessage=event=>{worker.terminate();event.data.error?reject(Error(event.data.error)):resolve(event.data.result);};
    worker.onerror=event=>{worker.terminate();reject(Error(event.message||'图像处理失败。'));};
    // Never transfer/detach the live document's source buffers.
    worker.postMessage(request);
  });
}

import {computeMobilePixels,type MobileProcessingRequest} from './mobile-inpaint-processing';
self.onmessage=(event:MessageEvent<MobileProcessingRequest>)=>{
  try{self.postMessage({result:computeMobilePixels(event.data)});}
  catch(error){self.postMessage({error:error instanceof Error?error.message:String(error)});}
};

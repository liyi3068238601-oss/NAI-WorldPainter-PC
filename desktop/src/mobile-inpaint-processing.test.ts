import {describe,expect,it} from 'vitest';
import {computeMobilePixels} from './mobile-inpaint-processing';
import type {MobilePixels} from './mobile-inpaint';

function solid(rgba:number[]):MobilePixels {
  const data=new Uint8ClampedArray(48*48*4);
  for(let i=0;i<data.length;i+=4)data.set(rgba,i);
  return {width:48,height:48,data};
}
function layer(outward:number) {
  const generated=solid([240,80,30,255]),base=solid([20,60,100,255]),mask=solid([0,0,0,0]);
  for(let y=16;y<32;y++)for(let x=16;x<32;x++)mask.data.fill(255,(y*48+x)*4,(y*48+x)*4+4);
  return computeMobilePixels({kind:'layer',generated,base,mask,outward}) as {image:MobilePixels;comparison:MobilePixels};
}
const alpha=(image:MobilePixels,x:number,y=24)=>image.data[(y*image.width+x)*4+3];

describe('mobile workspace single feather control',()=>{
  it('uses phone outward 8 / automatic inward 2, rather than an independent inward 8',()=>{
    const {image}=layer(8);
    // Phone signed distance: outside at x15 is -0.5; (8-.5)/(8+2)*255 = 191.
    expect(alpha(image,15)).toBe(191);
    expect(alpha(image,20)).toBe(255);
  });
  it('automatically reduces inner feather to the outward radius and keeps zero binary',()=>{
    expect(alpha(layer(1).image,15)).toBe(64);
    const zero=layer(0).image;
    expect(alpha(zero,15)).toBe(0);
    expect(alpha(zero,16)).toBe(255);
  });
});

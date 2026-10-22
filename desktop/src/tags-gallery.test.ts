import {expect,it,vi} from 'vitest';
import {parseTagsGalleryPage,parseTagsGalleryDetail,loadTagsGalleryPage,tagsGalleryCategory,tagsGalleryDetailUrl,tagsGalleryUrl,TAGS_GALLERY_CATEGORIES,tagsGalleryLabels} from './tags-gallery';
import {galleryImageHeaders} from './gallery-download';

// Synthetic HTML shaped like the current public Next.js markup. All image
// names and prompt strings here are placeholders; no upstream media is copied.
function escapeHtml(value:string){return value.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');}
function listingPage(model:'v4-5'|'v5',category:string,start:number,count:number,total:number,wrongModel=false){
 const prefix=wrongModel?(model==='v5'?'v45':'v5'):(model==='v5'?'v5':'v45');
 const cards=Array.from({length:count},(_,offset)=>{
  const index=start+offset;const slug=`sample_${index}`;const title=index===0?'blue & white':`sample tag ${index}`;
  return `<div class="card-scan"><a aria-label="Open detail: ${escapeHtml(title)}" href="/${category}/${slug}"><picture><source srcSet="/images/thumbs/${prefix}_${slug}.webp" type="image/webp"/><img src="/images/${prefix}_${slug}.webp" alt="${escapeHtml(title)}" width="480" height="702"/></picture></a><div><button aria-label="いいね — お気に入りに追加"></button><span aria-label="累計いいね ${index+7}">${index+7}</span><span>posts=${index+3}·▲${2800-index}</span></div></div>`;
 }).join('');
 return `<html><body><span>hits=</span><span>${total.toLocaleString('en-US')}</span><div class="grid">${cards}</div></body></html>`;
}
const comparisonDetail=`<html><body>
 <h1><button aria-label="Copy tag: blue &amp; white"></button></h1>
 <button aria-label="Copy tag: blue_white"></button>
 <div>V5 vs V4.5 · SAME SEED</div>
 <div class="compare"><img src="/images/v5_sample.webp" alt="V5 sample"/><img src="/images/v45_sample.webp" alt="V4.5 sample"/><img src="/images/v5_sample_2.webp" alt="second V5 sample"/></div>
 <div class="grid grid-cols-3"><span>top score</span></div><aside><img src="/images/v5_related_tag.webp" alt="related tag"/></aside>
 <div class="prompt-label">PROMPT / 使用時</div><div><button aria-label="Copy tag: blue &amp; white, shared synthetic prompt"></button></div>
 </body></html>`;

it('parses live listing structure, model-qualified V5 IDs, metrics, and same-model covers',()=>{
 const page=parseTagsGalleryPage(listingPage('v5','artist',0,2,1953),'artist','v5');
 expect(page.total).toBe(1953);expect(page.items).toHaveLength(2);
 expect(page.items[0]).toMatchObject({id:'v5/artist/sample_0',title:'blue & white',prompt:'blue & white',score:2800,favoriteCount:7,viewCount:0,mediaCount:1});
 expect(page.items[0].cover).toMatchObject({previewUrl:'https://tags.gallery/images/thumbs/v5_sample_0.webp',displayUrl:'https://tags.gallery/images/v5_sample_0.webp',width:480,height:702});
 expect(page.items[0].sourceUrl).toBe('https://tags.gallery/artist/sample_0');
});
it('keeps V4.5 legacy IDs stable and refuses a listing image from the other model',()=>{
 const v45=parseTagsGalleryPage(listingPage('v4-5','hair',0,1,1),'hair');
 expect(v45.items[0].id).toBe('hair/sample_0');expect(v45.items[0].cover.displayUrl).toContain('/v45_sample_0.webp');
 const mismatched=parseTagsGalleryPage(listingPage('v5','hair',0,1,1,true),'hair','v5');
 expect(mismatched.items[0].id).toBe('v5/hair/sample_0');expect(mismatched.items[0].mediaCount).toBe(0);expect(mismatched.items[0].cover.downloadUrl).toBe('');
});
it('selects only the requested model image and prompt from a comparison detail page',()=>{
 const v5=parseTagsGalleryDetail(comparisonDetail,'v5/artist/sample');
 const v45=parseTagsGalleryDetail(comparisonDetail,'artist/sample');
 expect(v5.media.map(image=>image.displayUrl)).toEqual(['https://tags.gallery/images/v5_sample.webp','https://tags.gallery/images/v5_sample_2.webp']);
 expect(v5.item.cover.displayUrl).toBe(v5.media[0].displayUrl);expect(v5.item.mediaCount).toBe(2);
 expect(v5.prompt).toBe('blue & white, shared synthetic prompt');expect(v5.metadata.model).toBe('NAI Diffusion Anime V5 Full');
 expect(v45.media.map(image=>image.displayUrl)).toEqual(['https://tags.gallery/images/v45_sample.webp']);
 expect(v45.item.id).toBe('artist/sample');expect(v45.prompt).toBe(v5.prompt);expect(v45.metadata.model).toBe('NAI Diffusion Anime V4.5 Full');
 expect(tagsGalleryDetailUrl('v5/artist/sample')).toBe('https://tags.gallery/artist/sample');
});
it('chooses explicitly model-scoped prompts when the detail layout supplies them',()=>{
 const html=`<h1><button aria-label="Copy tag: sample"></button></h1><button aria-label="Copy tag: sample"></button>
 <div data-model="v5"><h2>PROMPT / V5</h2><button aria-label="Copy tag: sample, synthetic v5 prompt"></button></div>
 <div data-model="v4-5"><h2>PROMPT / V4.5</h2><button aria-label="Copy tag: sample, synthetic v4.5 prompt"></button></div>
 <img src="/images/v5_sample.webp"/><img src="/images/v45_sample.webp"/>`;
 expect(parseTagsGalleryDetail(html,'v5/character/sample').prompt).toBe('sample, synthetic v5 prompt');
 expect(parseTagsGalleryDetail(html,'character/sample').prompt).toBe('sample, synthetic v4.5 prompt');
});
it('does not borrow another model prompt when no shared or matching prompt exists',()=>{
 const html=`<h1><button aria-label="Copy tag: sample"></button></h1><button aria-label="Copy tag: sample"></button>
 <div>V5 vs V4.5 · SAME SEED</div><img src="/images/v5_sample.webp"/><img src="/images/v45_sample.webp"/>
 <div class="grid grid-cols-3">top score</div><div data-model="v5"><h2>PROMPT / V5</h2><button aria-label="Copy tag: sample, synthetic v5-only prompt"></button></div>`;
 expect(parseTagsGalleryDetail(html,'character/sample').prompt).toBe('sample');
});
it('uses true 60-item upstream pages and carries query, model, and sort across a client boundary',async()=>{
 const fetch=vi.fn(async(url:string)=>{
  const parsed=new URL(url);const upstreamPage=Number(parsed.searchParams.get('p')??1);const start=(upstreamPage-1)*60;const total=128;
  return listingPage('v5','character',start,Math.min(60,total-start),total);
 });
 const result=await loadTagsGalleryPage(fetch,'character',2,48,'blue & white','favorites','v5');
 expect(result.items.map(item=>item.id)).toEqual(Array.from({length:48},(_,i)=>`v5/character/sample_${48+i}`));
 expect(result.total).toBe(128);expect(result.hasMore).toBe(true);expect(fetch).toHaveBeenCalledTimes(2);
 const urls=fetch.mock.calls.map(([url])=>new URL(url));
 expect(urls.map(url=>url.pathname)).toEqual(['/v5/character','/v5/character']);
 expect(urls.map(url=>url.searchParams.get('p')??'1')).toEqual(['1','2']);
 expect(urls.every(url=>url.searchParams.get('q')==='blue & white'&&url.searchParams.get('s')==='favorites')).toBe(true);
});
it('builds official model/category/sort URLs and validates IDs, sorts, and image hosts',()=>{
 expect(tagsGalleryUrl('artist',2,'blue & white','favorites','v5')).toBe('https://tags.gallery/v5?p=2&q=blue+%26+white&s=favorites');
 expect(tagsGalleryUrl('hair',1,'','count')).toBe('https://tags.gallery/v4-5/hair?s=count');
 expect(tagsGalleryUrl('character',1,'','name','v5')).toBe('https://tags.gallery/v5/character?s=name');
 expect(tagsGalleryUrl('artist',1,'','score')).toBe('https://tags.gallery/v4-5');
 expect(()=>tagsGalleryUrl('hair',1,'','newest')).toThrow('TAGS_GALLERY_INVALID_SORT');
 expect(()=>tagsGalleryDetailUrl('hair/../../secret')).toThrow('TAGS_GALLERY_INVALID_ID');
 expect(()=>tagsGalleryDetailUrl('hair/%2e%2e')).toThrow('TAGS_GALLERY_INVALID_ID');
 expect(()=>tagsGalleryDetailUrl('hair/%2Fsecret')).toThrow('TAGS_GALLERY_INVALID_ID');
 expect(()=>tagsGalleryDetailUrl('v6/hair/tag')).toThrow('TAGS_GALLERY_INVALID_ID');
 expect(tagsGalleryDetailUrl('hair/percentage_50%25')).toBe('https://tags.gallery/hair/percentage_50%25');
 expect(()=>tagsGalleryCategory('whatever')).toThrow('TAGS_GALLERY_INVALID_CATEGORY');
 const hostile=comparisonDetail.replace('/images/v45_sample.webp','https://evil.test/images/v45_sample.webp');
 expect(parseTagsGalleryDetail(hostile,'artist/sample').media).toHaveLength(0);
 expect(galleryImageHeaders('tags-gallery').Referer).toBe('https://tags.gallery/');
});
it('handles a legitimate empty result and rejects changed markup or oversized HTML',()=>{
 expect(parseTagsGalleryPage('<main>hits=0</main>','hair').items).toEqual([]);
 expect(()=>parseTagsGalleryPage('<html>challenge page</html>','hair')).toThrow('TAGS_GALLERY_LAYOUT_CHANGED');
 expect(()=>parseTagsGalleryPage('x'.repeat(5_000_001),'hair')).toThrow('TAGS_GALLERY_RESPONSE_TOO_LARGE');
});
it('has the nine upstream categories in every app language',()=>{
 expect(TAGS_GALLERY_CATEGORIES).toHaveLength(9);
 for(const language of ['zh-CN','zh-TW','en-US','ja-JP','ko-KR'])expect(tagsGalleryLabels(language).map(item=>item.value)).toEqual([...TAGS_GALLERY_CATEGORIES]);
});

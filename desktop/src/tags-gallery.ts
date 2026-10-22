import type {OnlineGalleryItem,OnlineGalleryMedia,OnlineGalleryPage,OnlineGalleryDetail} from './online-gallery';
import {emptyOnlineGalleryTagGroups} from './online-gallery';

export const TAGS_GALLERY_ORIGIN='https://tags.gallery';
export const TAGS_GALLERY_CATEGORIES=['artist','character','copyright','fashion_style','face','face_parts','hair','accessories','composition'] as const;
export type TagsGalleryCategory=typeof TAGS_GALLERY_CATEGORIES[number];
export type TagsGalleryModel='v4-5'|'v5';
const UPSTREAM_PAGE_SIZE=60;

export function tagsGalleryLabels(language:unknown){
 const labels:Record<string,string[]>={
 'zh-CN':['画师','角色','作品','服装风格','面容','五官','发型','配饰','构图'],
 'zh-TW':['畫師','角色','作品','服裝風格','面容','五官','髮型','配飾','構圖'],
 'en-US':['Artists','Characters','Series','Fashion','Faces','Facial features','Hair','Accessories','Composition'],
 'ja-JP':['絵師','キャラ','作品','服','顔','顔パーツ','髪','小物','構図'],
 'ko-KR':['작가','캐릭터','작품','패션','얼굴','얼굴 특징','머리','액세서리','구도']};
 return TAGS_GALLERY_CATEGORIES.map((value,i)=>({value,label:(labels[String(language)]??labels['en-US'])[i]}));
}
export function tagsGalleryCategory(value:unknown):TagsGalleryCategory{
 if(value==null||value==='')return 'artist';
 if(TAGS_GALLERY_CATEGORIES.includes(value as TagsGalleryCategory))return value as TagsGalleryCategory;
 throw new Error('TAGS_GALLERY_INVALID_CATEGORY');
}
function tagsGalleryModel(value:unknown):TagsGalleryModel{
 if(value==null||value==='v4-5')return 'v4-5';
 if(value==='v5')return 'v5';
 throw new Error('TAGS_GALLERY_INVALID_MODEL');
}
function decodeHtml(value:string){return value.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi,(_,key:string)=>{
 if(key[0]==='#'){const n=parseInt(key.slice(key[1].toLowerCase()==='x'?2:1),key[1].toLowerCase()==='x'?16:10);return n>0&&n<=0x10ffff?String.fromCodePoint(n):'';}
 return ({amp:'&',quot:'"',apos:"'",lt:'<',gt:'>',nbsp:' '} as Record<string,string>)[key.toLowerCase()]??'';
});}
function attributes(raw:string){return Object.fromEntries([...raw.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(m=>[m[1].toLowerCase(),decodeHtml(m[2]??m[3]??'')]));}
function htmlBody(raw:string){if(raw.length>5_000_000)throw new Error('TAGS_GALLERY_RESPONSE_TOO_LARGE');return raw.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<!--[\s\S]*?-->/g,'');}
function textContent(raw:string){return decodeHtml(raw.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim());}

type GalleryIdentity={category:TagsGalleryCategory;slug:string;model:TagsGalleryModel};
function safeSlug(raw:string){
 let slug:string;
 try{slug=decodeURIComponent(raw);}catch{return '';}
 if(!slug||slug==='.'||slug==='..'||/[\/\\?#\u0000-\u001f\u007f]/.test(slug)||slug.length>500)return '';
 return slug;
}
function parseGalleryId(id:string):GalleryIdentity{
 if(typeof id!=='string'||!id||id.length>1200)throw new Error('TAGS_GALLERY_INVALID_ID');
 const parts=id.split('/');let model:TagsGalleryModel='v4-5';let categoryPart:string;let slugPart:string;
 // The pre-model identifier was "category/slug" and remains the V4.5 ID so
 // existing bookmarks keep resolving to the same gallery entry.
 if(parts.length===2){[categoryPart,slugPart]=parts;}
 else if(parts.length===3&&parts[0]==='v5'){model='v5';categoryPart=parts[1];slugPart=parts[2];}
 else throw new Error('TAGS_GALLERY_INVALID_ID');
 const category=tagsGalleryCategory(categoryPart);const slug=safeSlug(slugPart);
 if(!slug)throw new Error('TAGS_GALLERY_INVALID_ID');
 return {category,slug,model};
}
function galleryId(category:TagsGalleryCategory,slug:string,model:TagsGalleryModel){const encoded=encodeURIComponent(slug);return model==='v5'?`v5/${category}/${encoded}`:`${category}/${encoded}`;}
function detailPath(identity:GalleryIdentity){return `/${identity.category}/${encodeURIComponent(identity.slug)}`;}

export function tagsGalleryDetailUrl(id:string){const identity=parseGalleryId(id);return `${TAGS_GALLERY_ORIGIN}${detailPath(identity)}`;}
function listingSlug(href:string,category:TagsGalleryCategory){
 try{
  const url=new URL(href,TAGS_GALLERY_ORIGIN);if(url.origin!==TAGS_GALLERY_ORIGIN||url.search||url.hash)return '';
  const parts=url.pathname.split('/').filter(Boolean);if(parts.length!==2||parts[0]!==category)return '';
  return safeSlug(parts[1]);
 }catch{return '';}
}

function safeImageUrl(raw:string){
 if(!raw)return '';
 try{
  const url=new URL(decodeHtml(raw.trim()),TAGS_GALLERY_ORIGIN);
  if(url.protocol!=='https:'||url.origin!==TAGS_GALLERY_ORIGIN||url.username||url.password||!/^\/images\/(?:thumbs\/)?[^/]+\.(?:webp|png|jpe?g|gif|avif)$/i.test(url.pathname))return '';
  return url.toString();
 }catch{return '';}
}
function imageBelongsToModel(url:string,model:TagsGalleryModel){
 if(!url)return false;
 const name=new URL(url).pathname.split('/').at(-1)??'';
 return model==='v5'?name.startsWith('v5_'):name.startsWith('v45_');
}
function sourceSetUrls(raw:string){return raw.split(',').map(part=>part.trim().split(/\s+/)[0]).filter(Boolean);}
function imageExtension(url:string){const ext=url.match(/\.([a-z\d]+)(?:$|\?)/i)?.[1]?.toLowerCase();return ext&&['webp','png','jpg','jpeg','gif','avif'].includes(ext)?ext:'webp';}
function mediaFromAttrs(img:Record<string,string>,source:Record<string,string>,id:string,model:TagsGalleryModel):OnlineGalleryMedia{
 const rawDisplay=img.src??img['data-src']??'';const candidateDisplay=safeImageUrl(rawDisplay);
 const displayUrl=imageBelongsToModel(candidateDisplay,model)?candidateDisplay:'';
 const previews=[...sourceSetUrls(source.srcset??''),...sourceSetUrls(img.srcset??'')].map(safeImageUrl).filter(url=>imageBelongsToModel(url,model));
 const previewUrl=previews[0]??displayUrl;
 return {id,previewUrl,displayUrl,downloadUrl:displayUrl,width:Number(img.width)||0,height:Number(img.height)||0,extension:imageExtension(displayUrl||previewUrl)};
}
function emptyMedia(id:string):OnlineGalleryMedia{return {id,previewUrl:'',displayUrl:'',downloadUrl:'',width:0,height:0,extension:'webp'};}
function tagsForCategory(category:TagsGalleryCategory,title:string){
 const tags=emptyOnlineGalleryTagGroups();
 if(category==='artist')tags.artists=[title];else if(category==='character')tags.characters=[title];else if(category==='copyright')tags.copyrights=[title];else tags.general=[title];
 return tags;
}
export function tagsGalleryItem(id:string,title:string,cover:OnlineGalleryMedia,model?:TagsGalleryModel,prompt=title,metrics:{score?:number;favoriteCount?:number;viewCount?:number}={}):OnlineGalleryItem{
 const identity=parseGalleryId(id);const effectiveModel=tagsGalleryModel(model??identity.model);const mediaCount=cover.displayUrl?1:0;
 if(effectiveModel!==identity.model)throw new Error('TAGS_GALLERY_MODEL_ID_MISMATCH');
 return {source:'tags-gallery',id,kind:'work',title,author:identity.category==='artist'?title:'',description:title,createdAt:'',rating:'',score:metrics.score??0,favoriteCount:metrics.favoriteCount??0,viewCount:metrics.viewCount??0,mediaCount,prompt,negativePrompt:'',tags:tagsForCategory(identity.category,title),cover,sourceUrl:tagsGalleryDetailUrl(id)};
}
function imageTagsFromCard(card:string,id:string,model:TagsGalleryModel){
 const img=attributes(card.match(/<img\b([^>]*)>/i)?.[1]??'');const source=attributes(card.match(/<source\b([^>]*)>/i)?.[1]??'');
 return mediaFromAttrs(img,source,id,model);
}
function cardMetric(segment:string,pattern:RegExp){const match=pattern.exec(textContent(segment));return match?Number(match[1].replaceAll(',',''))||0:0;}
function cardFavoriteCount(segment:string){
 const labels=[...segment.matchAll(/aria-label\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].map(match=>decodeHtml(match[1]??match[2]??''));
 for(const label of labels){const match=label.match(/(?:累計\s*)?いいね\s*([\d,]+)|(?:total\s*)?likes?\s*([\d,]+)/i);if(match)return Number((match[1]??match[2]).replaceAll(',',''))||0;}
 return 0;
}
export function parseTagsGalleryPage(raw:string,category:TagsGalleryCategory,model:TagsGalleryModel='v4-5'){
 const selectedCategory=tagsGalleryCategory(category);const selectedModel=tagsGalleryModel(model);const html=htmlBody(raw);const plain=textContent(html);
 const count=plain.match(/\bhits\s*=\s*([\d,]+)/i)?.[1];if(count==null)throw new Error('TAGS_GALLERY_LAYOUT_CHANGED');
 const total=Number(count.replaceAll(',',''));if(!Number.isSafeInteger(total)||total<0)throw new Error('TAGS_GALLERY_LAYOUT_CHANGED');
 const matches=[...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)];const cards=matches.map((match,index)=>({match,index})).filter(({match})=>{
  const attrs=attributes(match[1]);return (attrs['aria-label']??'').startsWith('Open detail: ');
 });
 const items:OnlineGalleryItem[]=[];
 for(let index=0;index<cards.length;index++){
  const {match}=cards[index];const attrs=attributes(match[1]);const slug=listingSlug(attrs.href??'',selectedCategory);if(!slug)continue;
  const id=galleryId(selectedCategory,slug,selectedModel);const title=attrs['aria-label'].slice('Open detail: '.length).trim();if(!title)continue;
  const next=cards[index+1]?.match.index??html.length;const segment=html.slice(match.index,next);const cover=imageTagsFromCard(match[2],id,selectedModel);
  items.push(tagsGalleryItem(id,title,cover,selectedModel,title,{
   score:cardMetric(segment,/▲\s*([\d,]+)/),
   favoriteCount:cardFavoriteCount(segment),
  }));
 }
 if(total>0&&!items.length)throw new Error('TAGS_GALLERY_LAYOUT_CHANGED');
 return {total,items};
}

function sortValue(sort:string){
 if(sort==='default'||sort==='score')return 'score';
 if(['count','name','favorites'].includes(sort))return sort;
 throw new Error('TAGS_GALLERY_INVALID_SORT');
}
export function tagsGalleryUrl(category:TagsGalleryCategory,page:number,query:string,sort='score',model:TagsGalleryModel='v4-5'){
 const selectedModel=tagsGalleryModel(model);if(!Number.isInteger(page)||page<1||page>100000)throw new Error('TAGS_GALLERY_INVALID_PAGE');
 const base=selectedModel==='v5'?'/v5':'/v4-5';const selectedCategory=tagsGalleryCategory(category);const path=selectedCategory==='artist'?base:`${base}/${selectedCategory}`;const u=new URL(path,TAGS_GALLERY_ORIGIN);
 if(page>1)u.searchParams.set('p',String(page));if(query)u.searchParams.set('q',query);const selectedSort=sortValue(sort);if(selectedSort!=='score')u.searchParams.set('s',selectedSort);return u.toString();
}
export async function loadTagsGalleryPage(fetchHtml:(url:string)=>Promise<string>,category:TagsGalleryCategory,page=1,pageSize=12,query='',sort='score',model:TagsGalleryModel='v4-5'):Promise<OnlineGalleryPage>{
 if(!Number.isInteger(page)||page<1||page>100000)throw new Error('TAGS_GALLERY_INVALID_PAGE');
 const size=[12,24,48,60].includes(pageSize)?pageSize:12;const offset=(page-1)*size;const upstreamPage=Math.floor(offset/UPSTREAM_PAGE_SIZE)+1;const skip=offset%UPSTREAM_PAGE_SIZE;
 const first=parseTagsGalleryPage(await fetchHtml(tagsGalleryUrl(category,upstreamPage,query,sort,model)),category,model);let total=first.total;const items:OnlineGalleryItem[]=[];
 let nextPage=upstreamPage;let localSkip=skip;let current=first;
 while(items.length<size&&offset+items.length<total){
  const available=current.items.slice(localSkip,localSkip+size-items.length);items.push(...available);localSkip=0;
  if(items.length>=size||offset+items.length>=total)break;
  if(current.items.length<UPSTREAM_PAGE_SIZE)break;
  nextPage++;current=parseTagsGalleryPage(await fetchHtml(tagsGalleryUrl(category,nextPage,query,sort,model)),category,model);total=Math.min(total,current.total||total);
  if(!current.items.length)break;
 }
 return {source:'tags-gallery',page,pageSize:size,total,items,hasMore:offset+items.length<total};
}

type DetailButton={index:number;label:string;attrs:Record<string,string>};
function detailButtons(html:string):DetailButton[]{return [...html.matchAll(/<button\b([^>]*)>/gi)].map(match=>({index:match.index??0,label:attributes(match[1])['aria-label']??'',attrs:attributes(match[1])})).filter(button=>button.label.startsWith('Copy tag: '));}
function modelMarker(value:string):TagsGalleryModel|undefined{
 if(/(?:^|[^\w])(?:v5|NAI Diffusion Anime V5 Full)(?:$|[^\w])/i.test(value))return 'v5';
 if(/(?:^|[^\w])(?:v4[.-]?5|NAI Diffusion Anime V4\.5 Full)(?:$|[^\w])/i.test(value))return 'v4-5';
 return undefined;
}
function modelPrompt(buttons:DetailButton[],html:string,model:TagsGalleryModel,tag:string,slug:string){
 const promptStart=html.search(/PROMPT\s*(?:\/|:|-)/i);if(promptStart<0)return tag;
 const candidates=buttons.filter(button=>button.index>=promptStart&&button.index<promptStart+30_000).map(button=>{
  const value=button.label.slice('Copy tag: '.length).trim();const context=html.slice(promptStart,button.index);
  const explicit=[...context.matchAll(/data-model\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].at(-1);
  const modelHeadings=[...context.matchAll(/PROMPT\s*(?:\/|:|-)\s*([^<\n]{0,80})/gi)].map(match=>match[1]);
  const marker=explicit?modelMarker(explicit[1]??explicit[2]??''):modelMarker(modelHeadings.at(-1)??'');
  return {value,marker};
 }).filter(candidate=>candidate.value&&candidate.value!==tag&&candidate.value!==slug);
 const specific=candidates.find(candidate=>candidate.marker===model);if(specific)return specific.value;
 const shared=candidates.find(candidate=>candidate.marker==null);if(shared)return shared.value;
 // Current TAGs pages have one shared prompt for their side-by-side V5/V4.5
 // comparison. Its heading contains no model marker, so it applies to either.
 return tag;
}
function detailMedia(html:string,id:string,model:TagsGalleryModel){
 // Current detail pages mark the comparison block "V5 vs V4.5 · SAME SEED";
 // end at its following stats row so recommendation/related cards cannot leak
 // into the current entry's media list.
 const comparison=html.search(/V5\s+vs\s+V4\.5\s*[·-]\s*SAME\s+SEED/i);if(comparison<0)return [];
 const firstImage=html.indexOf('<img',comparison);if(firstImage<0)return [];
 const statsText=html.toLowerCase().indexOf('top score',firstImage);const statsRow=html.indexOf('class="grid grid-cols-3',firstImage);
 const endings=[statsText,statsRow].filter(index=>index>=0);const end=endings.length?Math.min(...endings):Math.min(html.length,firstImage+5_000);
 const region=html.slice(firstImage,end);const media:OnlineGalleryMedia[]=[];const seen=new Set<string>();
 for(const match of region.matchAll(/<img\b([^>]*)>/gi)){
  const attrs=attributes(match[1]);const candidate=safeImageUrl(attrs.src??attrs['data-src']??'');if(!imageBelongsToModel(candidate,model)||seen.has(candidate))continue;
  if(new URL(candidate).pathname.includes('/thumbs/'))continue;
  seen.add(candidate);media.push(mediaFromAttrs(attrs,{},`${id}:media:${media.length}`,model));
 }
 return media;
}
export function parseTagsGalleryDetail(raw:string,id:string):OnlineGalleryDetail{
 const identity=parseGalleryId(id);const sourceUrl=tagsGalleryDetailUrl(id);const html=htmlBody(raw);const buttons=detailButtons(html);
 const tag=buttons[0]?.label.slice('Copy tag: '.length).trim();if(!tag)throw new Error('TAGS_GALLERY_LAYOUT_CHANGED');
 const prompt=modelPrompt(buttons,html,identity.model,tag,identity.slug);const media=detailMedia(html,id,identity.model);const cover=media[0]??emptyMedia(id);
 const item=tagsGalleryItem(id,tag,cover,identity.model,prompt);
 item.mediaCount=media.length;
 return {item,media,prompt,negativePrompt:'',note:'',categoryPath:[identity.category],metadata:{sourceUrl,model:identity.model==='v5'?'NAI Diffusion Anime V5 Full':'NAI Diffusion Anime V4.5 Full'}};
}

export function tagsGalleryUi(language:unknown){
 const [category,pending]=({
 'zh-CN':['分类','官网尚未提供样例图'], 'zh-TW':['分類','官網尚未提供範例圖'],
 'en-US':['Category','No sample image provided by the source'], 'ja-JP':['カテゴリ','元サイトにサンプル画像がありません'],
 'ko-KR':['카테고리','원본 사이트에 샘플 이미지가 없습니다']
 } as Record<string,string[]>)[String(language)]??['Category','No sample image provided by the source'];return {category,pending};
}

import {describe,it,expect} from 'vitest';
import {parseKnowledgeBook,matchKnowledge,validateKnowledgeSettings,defaultKnowledgeSettings} from './knowledge';

const entry=(id:number,keywords=['cat'],content='reference')=>({id,title:`Entry ${id}`,source:'synthetic',keywords,content});
describe('WorldPainter knowledge compatibility',()=>{
  it('accepts mobile entries with or without optional file metadata',()=>{
    const entries=[entry(1,['猫','cat'])];
    expect(parseKnowledgeBook(JSON.stringify({entries}))).toEqual(entries);
    expect(parseKnowledgeBook('\uFEFF'+JSON.stringify({version:1,date:'2026-10-15',total:1,entries}))).toEqual(entries);
  });
  it('rejects partial or ambiguous entries before replacement',()=>{
    expect(()=>parseKnowledgeBook(JSON.stringify({entries:[entry(1),entry(1)]}))).toThrow('重复');
    expect(()=>parseKnowledgeBook(JSON.stringify({total:5,entries:[entry(1)]}))).toThrow('total');
    expect(()=>parseKnowledgeBook(JSON.stringify({entries:[{...entry(1),keywords:[null]}]}))).toThrow('关键词');
  });
  it('matches English boundaries, short tags, phrases and Chinese substrings without mutating source entries',()=>{
    const entries=[entry(2,['猫'],'cat reference'),entry(1,['cat'],'cat reference one'),entry(3,['x'],'short tag'),entry(4,['cat girl'],'cat_girl reference'),entry(5,['猫娘角色'],'partial Chinese phrase')];
    const before=JSON.stringify(entries);
    expect(matchKnowledge(entries,'concatenate')).toEqual([]);
    expect(matchKnowledge(entries,'CAT 和猫').map(e=>e.id)).toEqual([1,2]);
    expect(matchKnowledge(entries,'x').map(e=>e.id)).toEqual([3]);
    expect(matchKnowledge(entries,'CAT_GIRL').map(e=>e.id)).toEqual([4,1]);
    expect(matchKnowledge(entries,'猫娘').map(e=>e.id)).toContain(5);
    expect(JSON.stringify(entries)).toBe(before);
  });
  it('ranks more relevant entries first and uses stable IDs for ties',()=>{
    const entries=[entry(1,['cat'],'one'),entry(9,['cat','dog'],'nine'),entry(3,['cat','dog'],'three')];
    expect(matchKnowledge(entries,'cat dog').map(e=>e.id)).toEqual([3,9,1]);
  });
  it('deduplicates normalized content across different titles and falls back to title for empty content',()=>{
    const entries=[
      {...entry(1,['cat'],'  Same   CAT reference  '),title:'First title'},
      {...entry(2,['cat'],'same cat REFERENCE'),title:'Different title'},
      {...entry(3,['cat'],''),title:'Empty duplicate'},
      {...entry(4,['cat'],''),title:' empty   duplicate '},
    ];
    expect(matchKnowledge(entries,'cat').map(e=>e.id)).toEqual([1,3]);
  });
  it('keeps five relevant items, centers excerpts and caps total content at 2400 UTF-16 code units',()=>{
    const entries=[
      entry(1,['cat'],'x'.repeat(5000)+' cat '+ 'y'.repeat(1000)),
      ...Array.from({length:5},(_,i)=>entry(i+2,['cat'],'short '.repeat(90)+i)),
    ];
    const matched=matchKnowledge(entries,'cat');
    expect(matched).toHaveLength(5);
    expect(matched[0].content).toContain('cat');
    expect(matched.every(item=>item.content.length<=900)).toBe(true);
    expect(matched.reduce((n,item)=>n+item.content.length,0)).toBeLessThanOrEqual(2400);
    expect(entries[0].content.length).toBe(6005);
  });
  it('keeps emoji excerpts well-formed and returns only a bounded set of matched keywords',()=>{
    const longKeyword='k'.repeat(100);
    const keywords=Array.from({length:10},(_,i)=>`t${i}_${longKeyword}`);
    const content='🦄'.repeat(400)+' t0_'+longKeyword+' '+ '🌙'.repeat(400);
    const source=entry(1,keywords,content);
    const result=matchKnowledge([source],keywords.join(' '))[0];
    expect(result.keywords).toHaveLength(8);
    expect(result.keywords.every(keyword=>keyword.length<=80)).toBe(true);
    expect(result.content.length).toBeLessThanOrEqual(900);
    expect(result.content).not.toMatch(/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/);
    for(let i=0;i<result.content.length;i++){
      const code=result.content.charCodeAt(i);
      if(code>=0xd800&&code<=0xdbff)expect(result.content.charCodeAt(i+1)).toBeGreaterThanOrEqual(0xdc00);
      if(code>=0xdc00&&code<=0xdfff)expect(result.content.charCodeAt(i-1)).toBeGreaterThanOrEqual(0xd800);
    }
    expect(source.keywords).toEqual(keywords);
    expect(source.content).toBe(content);
  });
  it('caps references and uses the full bounded excerpt budget without a long first item starving the rest',()=>{
    const entries=[entry(0,['cat'],'x'.repeat(3000)),...Array.from({length:9},(_,i)=>entry(i+1,['cat'],'x'.repeat(450)+i))];
    const matched=matchKnowledge(entries,'cat');
    expect(matched).toHaveLength(5);
    expect(matched.reduce((n,e)=>n+e.content.length,0)).toBeLessThanOrEqual(2400);
    expect(matchKnowledge(entries.map(e=>({...e,content:`x${e.id}`})),'cat')).toHaveLength(5);
    expect(matchKnowledge([entry(1,['cat'],'x'.repeat(3000))],'cat')[0].content.length).toBeLessThanOrEqual(900);
  });
  it('validates saved settings and preserves independent version defaults',()=>{
    expect(validateKnowledgeSettings({...defaultKnowledgeSettings(),v45StyleWords:'A',v5StyleWords:'B'}).v5StyleWords).toBe('B');
    expect(()=>validateKnowledgeSettings({...defaultKnowledgeSettings(),version:'v6'})).toThrow();
    expect(()=>validateKnowledgeSettings({...defaultKnowledgeSettings(),path:'bad\0path'})).toThrow();
  });
});

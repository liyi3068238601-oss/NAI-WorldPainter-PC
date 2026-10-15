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
  it('uses English token boundaries and Chinese substring matching without mutating the book',()=>{
    const entries=[entry(2,['猫']),entry(1,['cat'])];
    expect(matchKnowledge(entries,'concatenate')).toEqual([]);
    expect(matchKnowledge(entries,'CAT 和猫')).toEqual([entries[1],entries[0]]);
    expect(entries[0].id).toBe(2);
  });
  it('caps reference count and body budget using the mobile truncation rule',()=>{
    const entries=Array.from({length:10},(_,i)=>entry(i,['cat'],'x'.repeat(450)));
    const matched=matchKnowledge(entries,'cat');
    expect(matched).toHaveLength(4); // 200 remaining characters are not admitted.
    expect(matched.reduce((n,e)=>n+e.content.length,0)).toBe(1800);
    expect(matchKnowledge(entries.map(e=>({...e,content:'x'})),'cat')).toHaveLength(5);
    expect(matchKnowledge([entry(1,['cat'],'x'.repeat(3000))],'cat')[0].content).toHaveLength(2000);
  });
  it('validates saved settings and preserves independent version defaults',()=>{
    expect(validateKnowledgeSettings({...defaultKnowledgeSettings(),v45StyleWords:'A',v5StyleWords:'B'}).v5StyleWords).toBe('B');
    expect(()=>validateKnowledgeSettings({...defaultKnowledgeSettings(),version:'v6'})).toThrow();
    expect(()=>validateKnowledgeSettings({...defaultKnowledgeSettings(),path:'bad\0path'})).toThrow();
  });
});

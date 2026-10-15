export interface KnowledgeEntry {
  id: number; title: string; source: string; keywords: string[]; content: string;
}
export interface KnowledgeSettings {
  schema: 1; path: string; version: 'v45' | 'v5'; v45StyleWords: string; v5StyleWords: string;
}
export interface KnowledgeStatus {
  settings: KnowledgeSettings; source: 'bundled' | 'external'; activePath: string;
  sha256: string; bytes: number; entries: number; warning: string;
}
export const defaultKnowledgeSettings = (): KnowledgeSettings => ({
  schema: 1, path: '', version: 'v45', v45StyleWords: '', v5StyleWords: '',
});
export function validateKnowledgeSettings(raw: unknown): KnowledgeSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('知识库设置无效。');
  const v = raw as Record<string, unknown>;
  if (v.schema !== 1 || !['v45','v5'].includes(String(v.version)) ||
      Object.keys(v).some(key => !['schema','path','version','v45StyleWords','v5StyleWords'].includes(key))) throw Error('知识库设置版本或字段无效。');
  for (const key of ['path','v45StyleWords','v5StyleWords'] as const) {
    if (typeof v[key] !== 'string' || v[key].length > (key === 'path' ? 32767 : 12000) || v[key].includes('\0')) throw Error('知识库设置文本无效或过长。');
  }
  return {...v, path: (v.path as string).trim()} as unknown as KnowledgeSettings;
}
export function parseKnowledgeBook(raw: string): KnowledgeEntry[] {
  if (new TextEncoder().encode(raw).length > 12 * 1024 * 1024) throw Error('知识库超过 12 MiB。');
  const value: unknown = JSON.parse(raw.replace(/^\uFEFF/, ''));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('知识库需要包含 entries 的 JSON 对象。');
  const root = value as Record<string,unknown>;
  if (!Array.isArray(root.entries) || root.entries.length > 20000) throw Error('知识库 entries 无效或超过 20000 条。');
  if (root.total !== undefined && root.total !== root.entries.length) throw Error('知识库 total 与实际条目数不一致。');
  const ids = new Set<number>();
  return root.entries.map((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw Error('知识库条目无效。');
    const e = item as Record<string,unknown>;
    if (!Number.isSafeInteger(e.id) || (e.id as number) < 0 || ids.has(e.id as number)) throw Error('知识库条目 ID 无效或重复。');
    for (const key of ['title','source','content'] as const) {
      if (typeof e[key] !== 'string' || e[key].length > 40000 || e[key].includes('\0')) throw Error('知识库条目文本无效。');
    }
    if (!(e.title as string).trim() || !(e.source as string).trim()) throw Error('知识库条目标题和来源不能为空。');
    if (!Array.isArray(e.keywords) || e.keywords.length > 1024 || e.keywords.some(k=>typeof k!=='string'||!k.trim()||k.length>1000)) throw Error('知识库关键词无效。');
    ids.add(e.id as number);
    return {id:e.id as number,title:e.title as string,source:e.source as string,content:e.content as string,keywords:[...e.keywords] as string[]};
  });
}
/** Mobile parity: only the current input, at most five matches / 2000 characters. */
export function matchKnowledge(entries: readonly KnowledgeEntry[], text: string): KnowledgeEntry[] {
  if (!text.trim()) return [];
  const input = text.toLowerCase();
  const matches = entries.filter(entry=>entry.keywords.some(keyword=>{
    const k=keyword.toLowerCase();
    return /^[a-z][a-z0-9_]+$/.test(k) ? new RegExp(`\\b${k}\\b`).test(input) : input.includes(k);
  })).sort((a,b)=>a.id-b.id);
  const result:KnowledgeEntry[]=[];
  let length=0;
  for (const entry of matches) {
    if (result.length===5) break;
    const remaining=2000-length;
    if (entry.content.length>remaining) {
      if (remaining>200) result.push({...entry,content:entry.content.slice(0,remaining)});
      break;
    }
    result.push({...entry,keywords:[...entry.keywords]}); length+=entry.content.length;
  }
  return result;
}

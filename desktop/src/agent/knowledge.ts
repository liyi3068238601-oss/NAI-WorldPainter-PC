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
const MAX_KNOWLEDGE_MATCHES = 5;
const MAX_KNOWLEDGE_CONTENT_CHARS = 2400;
const MAX_KNOWLEDGE_ENTRY_CHARS = 900;

interface SearchTerm {
  raw: string;
  comparable: string;
  englishPhrase: string;
  hasCjk: boolean;
}
interface IndexedEntry {
  entry: KnowledgeEntry;
  title: SearchTerm;
  keywords: SearchTerm[];
}
interface RankedEntry {
  indexed: IndexedEntry;
  score: number;
  matchedTerms: SearchTerm[];
  matchedKeywords: string[];
}
interface QueryText {
  comparable: string;
  englishBoundaries: string;
  cjkSegments: string[];
}

const knowledgeIndexCache = new WeakMap<object, IndexedEntry[]>();

function prepareSearchTerm(raw: string): SearchTerm {
  const comparable = raw.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
  return {
    raw,
    comparable,
    englishPhrase: comparable.replace(/[^a-z0-9]+/g, ' ').trim(),
    hasCjk: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(comparable),
  };
}

function prepareQuery(text: string): QueryText {
  const comparable = text.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
  const english = comparable.replace(/[^a-z0-9]+/g, ' ').trim();
  return {
    comparable,
    englishBoundaries: english ? ` ${english} ` : ' ',
    cjkSegments: comparable.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu) ?? [],
  };
}

function getKnowledgeIndex(entries: readonly KnowledgeEntry[]): IndexedEntry[] {
  const key = entries as object;
  const cached = knowledgeIndexCache.get(key);
  if (cached) return cached;
  const index = entries.map(entry => ({
    entry,
    title: prepareSearchTerm(entry.title),
    keywords: [...new Set(entry.keywords.map(value => value.trim()).filter(Boolean))].map(prepareSearchTerm),
  }));
  knowledgeIndexCache.set(key, index);
  return index;
}

function termMatchScore(term: SearchTerm, query: QueryText): number {
  if (term.hasCjk) {
    const length = Array.from(term.comparable).length;
    if (!term.comparable) return 0;
    if (query.comparable.includes(term.comparable)) return 28 + Math.min(length, 12) * 1.5;
    const fragment = query.cjkSegments.find(segment => Array.from(segment).length >= 2 && term.comparable.includes(segment));
    return fragment ? 16 + Math.min(Array.from(fragment).length, 8) : 0;
  }
  if (!term.englishPhrase || !query.englishBoundaries.includes(` ${term.englishPhrase} `)) return 0;
  const tokenCount = term.englishPhrase.split(' ').length;
  const characterCount = term.englishPhrase.replace(/ /g, '').length;
  return 34 + Math.min(tokenCount, 5) * 3 + Math.min(characterCount, 20) * 0.2;
}

function rankEntry(indexed: IndexedEntry, query: QueryText): RankedEntry | undefined {
  let score = 0;
  const matchedTerms: SearchTerm[] = [];
  const matchedKeywords: string[] = [];
  const seen = new Set<string>();
  for (const term of indexed.keywords) {
    const matchScore = termMatchScore(term, query);
    if (!matchScore || seen.has(term.comparable)) continue;
    seen.add(term.comparable);
    score += matchScore;
    matchedTerms.push(term);
    matchedKeywords.push(term.raw);
  }
  const titleScore = termMatchScore(indexed.title, query);
  if (titleScore) {
    score += titleScore + 12;
    matchedTerms.unshift(indexed.title);
  }
  return score ? {indexed, score, matchedTerms, matchedKeywords} : undefined;
}

function findExcerptAnchor(content: string, terms: readonly SearchTerm[]): number {
  const lower = content.toLowerCase();
  for (const term of terms) {
    if (term.hasCjk) {
      const index = lower.indexOf(term.comparable);
      if (index >= 0) return index;
      continue;
    }
    if (!term.englishPhrase) continue;
    const phrasePattern = term.englishPhrase.split(' ').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s_-]+');
    const match = new RegExp(`(^|[^a-z0-9])(${phrasePattern})(?=$|[^a-z0-9])`, 'i').exec(lower);
    if (match) return match.index + match[1].length;
  }
  return -1;
}

function safeSliceBoundary(text: string, offset: number, direction: 'forward' | 'backward' = 'forward'): number {
  if (offset > 0 && offset < text.length) {
    const current = text.charCodeAt(offset);
    const previous = text.charCodeAt(offset - 1);
    if (current >= 0xdc00 && current <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) {
      return direction === 'forward' ? offset + 1 : offset - 1;
    }
  }
  return offset;
}

function excerptContent(content: string, terms: readonly SearchTerm[], limit: number): string {
  if (content.length <= limit) return content;
  const anchor = findExcerptAnchor(content, terms);
  const prefix = anchor > 0 ? '…' : '';
  const suffix = '…';
  const windowLength = Math.max(1, limit - prefix.length - suffix.length);
  let start = anchor >= 0 ? Math.max(0, anchor - Math.floor(windowLength * 0.25)) : 0;
  let end = Math.min(content.length, start + windowLength);
  if (end === content.length) start = Math.max(0, end - windowLength);
  start = safeSliceBoundary(content, start, 'forward');
  end = safeSliceBoundary(content, end, 'backward');
  return `${start > 0 ? '…' : ''}${content.slice(start, end)}${end < content.length ? '…' : ''}`;
}

function duplicateKey(entry: KnowledgeEntry): string {
  const content = entry.content.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
  if (content) return `content\0${content}`;
  return `title\0${entry.title.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ')}`;
}

/** Deterministic local retrieval with bounded results and relevance-centered excerpts. */
export function matchKnowledge(entries: readonly KnowledgeEntry[], text: string): KnowledgeEntry[] {
  if (!text.trim()) return [];
  const query = prepareQuery(text);
  if (!query.comparable) return [];
  const ranked: RankedEntry[] = [];
  for (const indexed of getKnowledgeIndex(entries)) {
    const match = rankEntry(indexed, query);
    if (match) ranked.push(match);
  }
  ranked.sort((a, b) => b.score - a.score || a.indexed.entry.id - b.indexed.entry.id);

  const selected: RankedEntry[] = [];
  const seen = new Set<string>();
  for (const candidate of ranked) {
    const key = duplicateKey(candidate.indexed.entry);
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(candidate);
    if (selected.length === MAX_KNOWLEDGE_MATCHES) break;
  }
  if (!selected.length) return [];

  const perEntryBudget = Math.min(MAX_KNOWLEDGE_ENTRY_CHARS, Math.floor(MAX_KNOWLEDGE_CONTENT_CHARS / selected.length));
  return selected.map(({indexed, matchedTerms, matchedKeywords}) => ({
    ...indexed.entry,
    keywords: [...new Set(matchedKeywords)].slice(0, 8).map(keyword => keyword.slice(0, 80)),
    content: excerptContent(indexed.entry.content, matchedTerms, perEntryBudget),
  }));
}

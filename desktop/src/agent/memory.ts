import {
  AGENT_MEMORY_SOURCES,
  AGENT_MEMORY_TYPES,
  type AgentMemory,
  type AgentMemorySource,
  type AgentMemoryType,
} from "./types";

export const PROMPT_TAG_MEMORY_TYPES: readonly AgentMemoryType[] = [
  "characterName",
  "characterFeature",
  "style",
];

const TAG_WILDCARD = /\{[^{}]*\|[^{}]*\}|\[[^[\]]*\|[^\[\]]*\]|\$\{[^}]*\}|<[^>]+>/g;
const TAG_CHARACTER_SET = /^[a-z0-9_():.+\-{}\[\]$<>|]+$/;

export function isAgentMemoryType(value: unknown): value is AgentMemoryType {
  return typeof value === "string" && (AGENT_MEMORY_TYPES as readonly string[]).includes(value);
}

export function isAgentMemorySource(value: unknown): value is AgentMemorySource {
  return typeof value === "string" && (AGENT_MEMORY_SOURCES as readonly string[]).includes(value);
}

export function isPromptTagMemoryType(type: AgentMemoryType | undefined): boolean {
  return type !== undefined && PROMPT_TAG_MEMORY_TYPES.includes(type);
}

/**
 * Match the phone repository's tag-only normalization while shielding the
 * NovelAI wildcard forms already recognized by the desktop prompt normalizer.
 * Weighted braces/brackets and `n::tag::` remain part of the stored tag.
 */
export function normalizePromptMemoryTags(input: string): string {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of input.replace(/[，、､]/g, ",").split(/[\r\n,]+/)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    // Pick a marker absent from the complete input. A fixed marker can collide
    // with a legitimate prompt tag (and be replaced by a nearby wildcard).
    let marker = "zzmemorywildcard";
    const lowerTrimmed = trimmed.toLowerCase();
    while (lowerTrimmed.includes(marker)) marker = `z${marker}`;
    const wildcards: string[] = [];
    const protectedText = trimmed.replace(TAG_WILDCARD, (match) => {
      const index = wildcards.push(match) - 1;
      return `${marker}${index}zz`;
    });
    const normalized = protectedText.toLowerCase().replace(/\s+/g, "_");
    if (!TAG_CHARACTER_SET.test(normalized)) continue;
    const restored = normalized.replace(new RegExp(`${marker}(\\d+)zz`, "g"), (_match, index: string) => wildcards[Number(index)] ?? "");
    if (!restored || seen.has(restored)) continue;
    seen.add(restored);
    result.push(restored);
  }
  return result.join(", ");
}

/** Ordinary memory is preserved byte-for-byte; only prompt-tag categories normalize. */
export function normalizeAgentMemoryContent(type: AgentMemoryType, content: string): string {
  return isPromptTagMemoryType(type) ? normalizePromptMemoryTags(content) : content;
}

/**
 * Schema-1 desktop snapshots had only title/content/scope. Add M4 defaults
 * without rewriting legacy content so old notes and tags remain recoverable.
 */
export function normalizeAgentMemorySnapshot(raw: unknown, fallbackNow = new Date().toISOString()): AgentMemory | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== "string" || typeof value.content !== "string") return undefined;
  const title = typeof value.title === "string" && value.title.trim()
    ? value.title.trim().slice(0, 100)
    : "记忆";
  const trigger = typeof value.trigger === "string" && value.trigger.trim()
    ? value.trigger.trim().slice(0, 200)
    : title.slice(0, 200);
  const hitCount = typeof value.hitCount === "number" && Number.isFinite(value.hitCount)
    ? Math.max(0, Math.trunc(value.hitCount))
    : 0;
  const weight = typeof value.weight === "number" && Number.isFinite(value.weight)
    ? Math.max(0.1, Math.min(5, value.weight))
    : 1;
  const source: AgentMemorySource = isAgentMemorySource(value.source) ? value.source : "manual";
  return {
    id: value.id,
    title,
    trigger,
    content: value.content.slice(0, 20_000),
    type: isAgentMemoryType(value.type) ? value.type : "other",
    source,
    scope: value.scope === "conversation" ? "conversation" : "global",
    ...(value.scope === "conversation" && typeof value.conversationId === "string" ? { conversationId: value.conversationId } : {}),
    hitCount,
    ...(typeof value.lastHitAt === "string" && value.lastHitAt ? { lastHitAt: value.lastHitAt } : {}),
    weight,
    ...(typeof value.supersededBy === "string" && value.supersededBy ? { supersededBy: value.supersededBy } : {}),
    createdAt: typeof value.createdAt === "string" ? value.createdAt : fallbackNow,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : fallbackNow,
  };
}

export function isRetrievableAgentMemory(memory: AgentMemory): boolean {
  return memory.source !== "pendingLlmCandidate" && !memory.supersededBy;
}

export function sameAgentMemoryConflictKey(left: AgentMemory, right: Pick<AgentMemory, "trigger" | "title" | "scope" | "conversationId">): boolean {
  const leftTrigger = (left.trigger ?? left.title).trim().toLocaleLowerCase();
  const rightTrigger = (right.trigger ?? right.title).trim().toLocaleLowerCase();
  return leftTrigger !== ""
    && leftTrigger === rightTrigger
    && left.scope === right.scope
    && (left.scope !== "conversation" || Boolean(left.conversationId && left.conversationId === right.conversationId));
}

export function findAgentMemoryConflicts(memories: AgentMemory[], candidate: AgentMemory, excludeId = candidate.id): AgentMemory[] {
  return memories
    .filter((memory) => memory.id !== excludeId && isRetrievableAgentMemory(memory) && sameAgentMemoryConflictKey(memory, candidate))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function isStaleAgentMemory(memory: AgentMemory, now = Date.now(), ageDays = 90): boolean {
  if (!isRetrievableAgentMemory(memory) || (memory.hitCount ?? 0) > 0) return false;
  const threshold = now - ageDays * 24 * 60 * 60 * 1000;
  const lastHit = memory.lastHitAt ? Date.parse(memory.lastHitAt) : Number.NaN;
  const created = Date.parse(memory.createdAt);
  return Number.isFinite(created) && created <= threshold
    && (!Number.isFinite(lastHit) || lastHit <= threshold);
}

export function mergeAgentMemoryContent(type: AgentMemoryType, newer: string, older: string): string {
  if (isPromptTagMemoryType(type)) {
    return normalizePromptMemoryTags(`${newer}, ${older}`);
  }
  return `${newer}${newer.endsWith("\n") ? "" : "\n"}---\n${older}`;
}

function memorySearchTokens(query: string): string[] {
  const normalized = query.toLocaleLowerCase()
    .replace(/_/g, " ")
    .replace(/[,，;；|/\\]+/g, " ")
    .replace(/[^a-z0-9\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af\s]+/g, " ");
  return [...new Set(normalized.split(/\s+/).map((token) => token.trim()).filter(Boolean))];
}

export function scoreAgentMemoryQuery(query: string, memory: AgentMemory): number {
  const tokens = memorySearchTokens(query);
  if (!tokens.length) return 0;
  const trigger = `${memory.trigger ?? ""} ${memory.title}`.toLocaleLowerCase().replace(/_/g, " ");
  const content = memory.content.toLocaleLowerCase().replace(/_/g, " ");
  let score = 0;
  let matched = 0;
  for (const token of tokens) {
    const inTrigger = trigger.includes(token);
    const inContent = content.includes(token);
    if (inTrigger || inContent) matched += 1;
    if (inTrigger) score += token === trigger.trim() ? 6 : 3;
    if (inContent) score += 1;
  }
  if (!matched) return 0;
  if (matched === tokens.length) score += tokens.length * 2;
  return score;
}

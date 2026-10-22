export type CharacterLayoutIntent = 'planned' | 'free';

/** Agent-visible role fields. Character store IDs deliberately stay local. */
export interface CharacterLayoutPrompt {
  name?: string;
  prompt: string;
  negativePrompt?: string;
  enabled: boolean;
  useCoords: boolean;
  x: number;
  y: number;
}

interface CharacterLayoutPromptInput extends Omit<CharacterLayoutPrompt, 'enabled'> {
  enabled?: boolean;
}

interface RowMatches {
  byNextIndex: Map<number, number>;
  reordered: boolean;
}

function uniqueIndices(rows: readonly (CharacterLayoutPromptInput | CharacterLayoutPrompt)[], key: (row: CharacterLayoutPromptInput | CharacterLayoutPrompt) => string) {
  const result = new Map<string, number[]>();
  rows.forEach((row, index) => {
    const value = key(row);
    const indices = result.get(value) ?? [];
    indices.push(index);
    result.set(value, indices);
  });
  return result;
}

function layoutSignature(row: CharacterLayoutPromptInput | CharacterLayoutPrompt): string {
  return JSON.stringify([row.enabled !== false, row.useCoords, row.x, row.y]);
}

function isPermutation(before: readonly string[], after: readonly string[]): boolean {
  if (before.length !== after.length || before.every((value, index) => value === after[index])) return false;
  const sort = (values: readonly string[]) => [...values].sort();
  return JSON.stringify(sort(before)) === JSON.stringify(sort(after));
}

/** Match named roles first, then unique prompts. Ambiguous repeated prompts are never assigned arbitrarily. */
function matchRows(previous: readonly CharacterLayoutPrompt[], next: readonly CharacterLayoutPromptInput[]): RowMatches {
  const byNextIndex = new Map<number, number>();
  const usedPrevious = new Set<number>();
  const usedNext = new Set<number>();
  let reordered = false;

  const matchUnique = (key: (row: CharacterLayoutPromptInput | CharacterLayoutPrompt) => string) => {
    const beforeKeys = uniqueIndices(previous, key);
    const afterKeys = uniqueIndices(next, key);
    for (const [value, beforeIndices] of beforeKeys) {
      const afterIndices = afterKeys.get(value);
      if (beforeIndices.length !== 1 || afterIndices?.length !== 1) continue;
      const beforeIndex = beforeIndices[0];
      const afterIndex = afterIndices[0];
      if (usedPrevious.has(beforeIndex) || usedNext.has(afterIndex)) continue;
      byNextIndex.set(afterIndex, beforeIndex);
      usedPrevious.add(beforeIndex);
      usedNext.add(afterIndex);
      if (beforeIndex !== afterIndex) reordered = true;
    }
  };

  matchUnique((row) => {
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    return name ? `name:${name}` : `no-name:${row.prompt}`;
  });
  matchUnique((row) => `prompt:${row.prompt}`);

  const layoutReordered = isPermutation(
    previous.map(layoutSignature),
    next.map(layoutSignature),
  );
  reordered ||= layoutReordered;

  // Repeated unnamed prompts cannot establish which disabled role a row
  // belongs to. Positional fallback would silently inherit the wrong enabled
  // flag when the rows were reordered, so require complete enabled values.
  const previousUnnamedPromptCounts = uniqueIndices(
    previous,
    (row) => typeof row.name === 'string' && row.name.trim() ? `named:${row.name.trim()}` : `prompt:${row.prompt}`,
  );
  const hasAmbiguousDisabledIdentity = previous.some((row) => row.enabled === false)
    && previous.some((row) => {
      const name = typeof row.name === 'string' ? row.name.trim() : '';
      return !name && (previousUnnamedPromptCounts.get(`prompt:${row.prompt}`)?.length ?? 0) > 1;
    });

  // With no evidence of a reorder, same-slot text edits preserve that slot's
  // disabled flag and layout. A detected reorder must be proven by unique role
  // identity rather than guessed from array position.
  if (!reordered && !hasAmbiguousDisabledIdentity && previous.length === next.length) {
    for (let index = 0; index < next.length; index += 1) {
      if (usedNext.has(index) || usedPrevious.has(index)) continue;
      byNextIndex.set(index, index);
      usedNext.add(index);
      usedPrevious.add(index);
    }
  }

  return { byNextIndex, reordered };
}

function validateInputRows(value: unknown): CharacterLayoutPromptInput[] {
  if (!Array.isArray(value) || value.length > 32) {
    throw new Error('characterPrompts 必须是最多32个角色项的完整数组。');
  }
  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`characterPrompts[${index}] 格式无效。`);
    }
    const row = raw as Record<string, unknown>;
    if (Object.keys(row).some((key) => !['name', 'prompt', 'negativePrompt', 'enabled', 'useCoords', 'x', 'y'].includes(key))) {
      throw new Error(`characterPrompts[${index}] 包含不支持的字段。`);
    }
    if (typeof row.prompt !== 'string' || !row.prompt.trim() || row.prompt.length > 20_000) {
      throw new Error(`characterPrompts[${index}].prompt 不能为空且最多20000字符。`);
    }
    if (row.negativePrompt !== undefined && (typeof row.negativePrompt !== 'string' || row.negativePrompt.length > 20_000)) {
      throw new Error(`characterPrompts[${index}].negativePrompt 格式无效。`);
    }
    if (row.name !== undefined && (typeof row.name !== 'string' || row.name.length > 64)) {
      throw new Error(`characterPrompts[${index}].name 格式无效。`);
    }
    if (row.enabled !== undefined && typeof row.enabled !== 'boolean') {
      throw new Error(`characterPrompts[${index}].enabled 格式无效。`);
    }
    if (typeof row.useCoords !== 'boolean' || typeof row.x !== 'number' || !Number.isFinite(row.x) || row.x < 0 || row.x > 1
      || typeof row.y !== 'number' || !Number.isFinite(row.y) || row.y < 0 || row.y > 1) {
      throw new Error(`characterPrompts[${index}] 必须包含有效的 useCoords/x/y 坐标。`);
    }
    return {
      ...(typeof row.name === 'string' ? { name: row.name } : {}),
      prompt: row.prompt,
      ...(typeof row.negativePrompt === 'string' ? { negativePrompt: row.negativePrompt } : {}),
      ...(typeof row.enabled === 'boolean' ? { enabled: row.enabled } : {}),
      useCoords: row.useCoords,
      x: row.x,
      y: row.y,
    };
  });
}

function preservesRows(previous: readonly CharacterLayoutPrompt[], next: readonly CharacterLayoutPrompt[], matches: RowMatches, requireAllPrevious: boolean): boolean {
  if (requireAllPrevious && previous.length !== next.length) return false;
  if (matches.byNextIndex.size !== next.length) return false;
  if (requireAllPrevious && new Set(matches.byNextIndex.values()).size !== previous.length) return false;
  for (let nextIndex = 0; nextIndex < next.length; nextIndex += 1) {
    const previousIndex = matches.byNextIndex.get(nextIndex);
    if (previousIndex === undefined) return false;
    const before = previous[previousIndex];
    const after = next[nextIndex];
    if (before.useCoords !== after.useCoords || before.x !== after.x || before.y !== after.y
      || before.enabled !== after.enabled) return false;
  }
  return true;
}

function preserveUnmatchedDisabledLayouts(previous: readonly CharacterLayoutPrompt[], next: readonly CharacterLayoutPrompt[], matches: RowMatches): void {
  const matchedPrevious = new Set(matches.byNextIndex.values());
  const unmatchedPreviousDisabled = new Set(previous.flatMap((row, index) =>
    row.enabled === false && !matchedPrevious.has(index) ? [index] : []));
  for (let nextIndex = 0; nextIndex < next.length; nextIndex += 1) {
    if (matches.byNextIndex.has(nextIndex) || next[nextIndex].enabled !== false) continue;
    const signature = layoutSignature(next[nextIndex]);
    const sameLayout = [...unmatchedPreviousDisabled].filter(previousIndex => layoutSignature(previous[previousIndex]) === signature);
    if (sameLayout.length) {
      // Equal layout signatures carry the exact disabled fields being protected;
      // pairing indistinguishable signatures cannot change generation behavior.
      matches.byNextIndex.set(nextIndex, sameLayout[0]);
      unmatchedPreviousDisabled.delete(sameLayout[0]);
      continue;
    }
    if (unmatchedPreviousDisabled.size) {
      throw new Error(`characterPrompts[${nextIndex}] 的停用角色无法可靠匹配旧布局；请保留稳定的 name/prompt 或原样保留布局字段。`);
    }
  }
}

function validateLayoutTransition(previous: readonly CharacterLayoutPrompt[], next: readonly CharacterLayoutPrompt[], intent: unknown, matches: RowMatches): void {
  if (intent !== undefined && intent !== 'planned' && intent !== 'free') {
    throw new Error("characterLayoutIntent 必须是 'planned' 或 'free'。");
  }
  if (next.length === 0) return;

  const participating = next.filter((row) => row.enabled !== false);
  // With no participating roles, toggling or preserving disabled rows carries
  // no layout-mode implication. Keep their stored values intact.
  if (participating.length === 0) return;

  if (intent === 'free') {
    if (participating.some((row) => row.useCoords)) {
      throw new Error("characterLayoutIntent='free' 时所有启用角色都必须设置 useCoords=false。");
    }
    return;
  }

  const allPlanned = participating.length > 0 && participating.every((row) => row.useCoords);
  if (intent === 'planned') {
    if (participating.some((row) => !row.useCoords)) {
      throw new Error("characterLayoutIntent='planned' 时所有启用角色都必须设置 useCoords=true 并提供有效坐标。");
    }
    return;
  }
  if (allPlanned) return;

  const allFree = participating.length === 0 || participating.every((row) => !row.useCoords);
  if (allFree) {
    const previousParticipants = previous.filter((row) => row.enabled !== false);
    const previousWasFree = previousParticipants.every((row) => !row.useCoords);
    if (previousWasFree && preservesRows(previous, next, matches, false)) return;
    throw new Error("新增角色或切换到自由布局时必须显式传入 characterLayoutIntent='free'，并将所有角色的 useCoords 设为 false。");
  }

  const previousParticipants = previous.filter((row) => row.enabled !== false);
  const previousWasMixed = previousParticipants.some((row) => row.useCoords)
    && previousParticipants.some((row) => !row.useCoords);
  if (previousWasMixed && preservesRows(previous, next, matches, false)) return;
  throw new Error('角色坐标布局为混合状态；请将所有启用角色规划为 useCoords=true，或明确选择 characterLayoutIntent=\'free\' 并将所有角色设为 false。');
}

/** Validate and normalize an Agent full-list write against the live role layout. */
export function prepareCharacterLayoutPrompts(
  previous: readonly CharacterLayoutPrompt[],
  rawNext: unknown,
  intent: unknown,
): CharacterLayoutPrompt[] {
  const input = validateInputRows(rawNext);
  const matches = matchRows(previous, input);
  const hasDisabledPrevious = previous.some((row) => row.enabled === false);
  const next = input.map((row, index): CharacterLayoutPrompt => {
    const matchedIndex = matches.byNextIndex.get(index);
    let enabled = row.enabled;
    if (enabled === undefined && matchedIndex !== undefined) enabled = previous[matchedIndex].enabled;
    if (enabled === undefined && hasDisabledPrevious) {
      throw new Error(`characterPrompts[${index}] 无法可靠匹配旧的停用角色；请为完整角色项显式提供 enabled。`);
    }
    return { ...row, enabled: enabled ?? true };
  });
  preserveUnmatchedDisabledLayouts(previous, next, matches);
  for (let nextIndex = 0; nextIndex < next.length; nextIndex += 1) {
    const previousIndex = matches.byNextIndex.get(nextIndex);
    if (previousIndex === undefined || next[nextIndex].enabled !== false) continue;
    const before = previous[previousIndex];
    const after = next[nextIndex];
    if (before.useCoords !== after.useCoords || before.x !== after.x || before.y !== after.y) {
      throw new Error(`characterPrompts[${nextIndex}] 对应的停用角色布局字段必须保持原值。`);
    }
  }
  validateLayoutTransition(previous, next, intent, matches);
  return next;
}

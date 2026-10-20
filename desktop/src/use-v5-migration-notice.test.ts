import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Runs the production hook's state/effects in a deterministic lifecycle harness.
// Real Electron captures separately verify React/DOM timing and visible dialogs.
const harness = vi.hoisted(() => {
  const slots: Array<{ value?: unknown; deps?: unknown[] }> = [];
  const effects: Array<() => void> = [];
  let cursor = 0;
  return {
    begin() { cursor = 0; },
    reset() { slots.length = 0; effects.length = 0; cursor = 0; },
    state(initial: unknown) {
      const i = cursor++;
      if (!slots[i]) slots[i] = { value: typeof initial === 'function' ? initial() : initial };
      return [slots[i].value, (value: unknown) => { slots[i].value = value; }];
    },
    effect(callback: () => void, deps: unknown[]) {
      const i = cursor++;
      if (!slots[i]?.deps || deps.some((value, j) => !Object.is(value, slots[i].deps![j]))) {
        slots[i] = { deps };
        effects.push(callback);
      }
    },
    flush() { while (effects.length) effects.shift()!(); },
  };
});
vi.mock('react', () => ({
  useState: (initial: unknown) => harness.state(initial),
  useEffect: (effect: () => void, deps: unknown[]) => harness.effect(effect, deps),
}));
import { useV5MigrationNotice, V5_MIGRATION_NOTICE_KEY as key, V5_MIGRATION_NOTICE_LEGACY_KEY as legacy } from './use-v5-migration-notice';

const storage = new Map<string, string>();
const V5 = 'nai-diffusion-5-full', V45 = 'nai-diffusion-4-5-full';
function render(ready: boolean, model: string, capture = false) {
  harness.begin(); const result = useV5MigrationNotice(ready, model, capture); harness.flush(); return result;
}
beforeEach(() => {
  harness.reset(); storage.clear();
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, value: string) => storage.set(k, value) });
});
afterEach(() => vi.unstubAllGlobals());

describe('V5 migration notice profile lifecycle', () => {
  it('waits for hydration before deciding an old profile needs its notice', () => {
    expect(render(false, V5).shouldShow).toBe(false);
    expect(storage.has(key)).toBe(false);
    expect(render(true, V45).shouldShow).toBe(true);
  });
  it('keeps a deliberate older-model choice quiet after starting with V5', () => {
    expect(render(true, V5).shouldShow).toBe(false);
    expect(render(true, V45).shouldShow).toBe(false);
    expect(storage.get(key)).toBe('seen');
  });
  it('keeps that saved manual choice quiet in a new application lifecycle', () => {
    render(true, V5); render(true, V45); harness.reset();
    expect(render(true, V45).shouldShow).toBe(false);
  });
  it('keeps the legacy notice visible until dismissed', () => {
    expect(render(true, V45).shouldShow).toBe(true);
    expect(render(true, V45).shouldShow).toBe(true);
    render(true, V45).dismiss();
    expect(render(true, V45).shouldShow).toBe(false);
  });
  it('does not repeat an old-profile notice after force-close on first presentation', () => {
    expect(render(true, V45).shouldShow).toBe(true); harness.reset();
    expect(render(true, V45).shouldShow).toBe(false);
  });
  it.each([[key, 'seen'], [legacy, 'dismissed']])('respects existing completion key %s', (k, value) => {
    storage.set(k, value); expect(render(true, V45).shouldShow).toBe(false);
  });
  it('does not mark an unhydrated V5 profile as assessed', () => {
    render(false, V5); render(false, V5); expect(storage.size).toBe(0);
  });
  it('suppresses capture mode without consuming the ordinary profile notice', () => {
    expect(render(true, V45, true).shouldShow).toBe(false);
    expect(storage.size).toBe(0); harness.reset();
    expect(render(true, V45).shouldShow).toBe(true);
  });
});

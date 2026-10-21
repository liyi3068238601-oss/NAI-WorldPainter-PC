import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { focusGenerationSection, generationSectionText } from './generation-section-navigation';
import { GenerationSectionShortcuts } from './components/GenerationSectionShortcuts';

// Unit contract for the scoped scroll/focus adapter; real Electron screenshots
// and focus/viewport assertions separately verify visible reachability.
function fixture() {
  const field = { value: 'KEEP_DRAFT', focus: vi.fn() };
  const target = { getBoundingClientRect: () => ({ top: 620 }), querySelector: vi.fn(() => field) };
  const panel = { scrollTop: 40, getBoundingClientRect: () => ({ top: 200 }), scrollTo: vi.fn(), querySelector: vi.fn((selector: string) => selector === '.prompt-editor textarea' ? field : target) };
  return { field, target, panel, element: panel as unknown as HTMLElement };
}
describe('generation section shortcuts', () => {
  it.each(['model', 'prompt', 'size'] as const)('focuses existing %s fields while scrolling only the form', section => {
    const f = fixture();
    expect(focusGenerationSection(f.element, section)).toBe(true);
    expect(f.panel.scrollTo).toHaveBeenCalledWith({ top: 452, behavior: 'instant' });
    expect(f.field.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(f.field.value).toBe('KEEP_DRAFT');
  });
  it('focuses the prompt editor without changing the active positive/negative tab', () => {
    const f = fixture(); focusGenerationSection(f.element, 'prompt');
    expect(f.panel.querySelector).toHaveBeenCalledWith('.prompt-editor textarea');
    expect(f.target.querySelector).not.toHaveBeenCalled();
  });
  it('focuses the model menu rather than the nearby Furry toggle', () => {
    const f = fixture(); focusGenerationSection(f.element, 'model');
    expect(f.target.querySelector).toHaveBeenCalledWith('button[aria-haspopup="listbox"]');
  });
  it('safely ignores missing/unmounted forms', () => {
    expect(focusGenerationSection(null, 'prompt')).toBe(false);
    const f = fixture(); f.panel.querySelector.mockReturnValue(null as never);
    expect(focusGenerationSection(f.element, 'size')).toBe(false);
    expect(f.panel.scrollTo).not.toHaveBeenCalled(); expect(f.field.focus).not.toHaveBeenCalled();
  });
  it.each(['zh-CN', 'zh-TW', 'en-US', 'ja-JP', 'ko-KR'])('renders localized non-submit controls for %s', language => {
    const html = renderToStaticMarkup(<GenerationSectionShortcuts panelRef={{current:null}} language={language}/>);
    const text = generationSectionText(language);
    expect(html).toContain(text.label);
    expect((html.match(/type="button"/g) ?? []).length).toBe(3);
    expect(html).toContain('aria-controls="generate-parameter-fields"');
  });
});

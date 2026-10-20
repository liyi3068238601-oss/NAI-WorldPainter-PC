import type { RefObject } from 'react';
import { focusGenerationSection, generationSectionText, type GenerationSection } from '../generation-section-navigation';
import './generation-section-shortcuts.css';

export function GenerationSectionShortcuts({ panelRef, language }: {
  panelRef: RefObject<HTMLDivElement | null>; language: unknown;
}) {
  const text = generationSectionText(language);
  return <div className="generate-section-shortcuts" role="group" aria-label={text.label}>
    {(['model', 'prompt', 'size'] as GenerationSection[]).map(section => <button key={section} type="button"
      aria-controls="generate-parameter-fields" title={text[section]}
      onClick={() => focusGenerationSection(panelRef.current, section)}>{text[section]}</button>)}
  </div>;
}

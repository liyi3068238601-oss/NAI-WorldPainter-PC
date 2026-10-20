import type { AppLanguage } from './types';

export type GenerationSection = 'model' | 'prompt' | 'size';
const labels = {
  'zh-CN': { label: '定位生图编辑区域', model: '模型 / 风格', prompt: '提示词', size: '尺寸 / Seed' },
  'zh-TW': { label: '定位生圖編輯區域', model: '模型 / 風格', prompt: '提示詞', size: '尺寸 / Seed' },
  'en-US': { label: 'Go to generation fields', model: 'Model / style', prompt: 'Prompts', size: 'Size / Seed' },
  'ja-JP': { label: '生成設定へ移動', model: 'モデル / 画風', prompt: 'プロンプト', size: 'サイズ / Seed' },
  'ko-KR': { label: '생성 설정으로 이동', model: '모델 / 스타일', prompt: '프롬프트', size: '크기 / Seed' },
} satisfies Record<AppLanguage, Record<'label' | GenerationSection, string>>;

export function generationSectionText(language: unknown) {
  return labels[language as AppLanguage] ?? labels['zh-CN'];
}

// Scroll only this form, and focus its existing field without scrolling the
// page or replacing any draft. Keep A's parameter-first order intact.
export function focusGenerationSection(panel: HTMLElement | null, section: GenerationSection) {
  if (!panel) return false;
  const selector = { model: '[data-generation-section="model"]', prompt: '[data-generation-section="prompt"]', size: '.resolution-tier-picker' }[section];
  const target = panel.querySelector<HTMLElement>(selector);
  if (!target) return false;
  const field = section === 'prompt'
    ? panel.querySelector<HTMLTextAreaElement>('.prompt-editor textarea')
    : target.querySelector<HTMLElement>(section === 'model' ? 'button[aria-haspopup="listbox"]' : 'input');
  panel.scrollTo({ top: Math.max(0, panel.scrollTop + target.getBoundingClientRect().top - panel.getBoundingClientRect().top - 8), behavior: 'instant' });
  field?.focus({ preventScroll: true });
  return true;
}

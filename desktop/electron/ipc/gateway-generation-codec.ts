/**
 * Payload-only port of the old PC Flutter 7877/ikun generation codecs.
 *
 * This module deliberately does not choose an account, read a token, issue a
 * request, quote billing, or persist results. The caller must bind the matching
 * gateway credential and endpoint explicitly before using the returned body.
 */
export type NovelAiGatewayProtocol = 'gateway7877' | 'ikun';
export type GatewayImageOperation = 'textToImage' | 'imageToImage' | 'inpaint';

export interface GatewayCharacter {
  enabled?: boolean;
  prompt: string;
  negativePrompt?: string;
  x?: number;
  y?: number;
}

export interface GatewayReference {
  /** Source bytes for ikun; provider-encoded Vibe bytes for 7877. */
  imageBase64: string;
  strength: number;
  informationExtracted: number;
}

export interface GatewayPreciseReference {
  imageBase64: string;
  type: 'character' | 'style' | 'character&style';
  strength: number;
}

export interface GatewayGenerationInput {
  protocol: NovelAiGatewayProtocol;
  operation: GatewayImageOperation;
  model: string;
  /** Final prompt after workbench prompt locks and prompt normalization. */
  prompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
  steps: number;
  scale: number;
  cfgRescale: number;
  sampler: string;
  noiseSchedule: string;
  seed: number | null;
  characters?: GatewayCharacter[];
  useCoords?: boolean;
  references?: GatewayReference[];
  preciseReferences?: GatewayPreciseReference[];
  imageBase64?: string;
  maskBase64?: string;
  strength?: number;
  noise?: number;
  disabledOriginalImage?: boolean;
  colorCorrect?: boolean;
}

export interface GatewayGenerationRequest {
  path: '/v1/images/generations';
  accept: 'application/json';
  payload: Record<string, unknown>;
}

function clamp01(value: number | undefined, fallback = 1) {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value!)) : fallback;
}

function image(value: string | undefined, label: string) {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${label} is required for gateway generation`);
  return normalized;
}

function enabledCharacters(input: GatewayGenerationInput) {
  return (input.characters ?? []).filter((item) => item.enabled !== false);
}

function gatewayCharacters(input: GatewayGenerationInput) {
  return enabledCharacters(input).map((item) => ({
    prompt: item.prompt,
    uc: item.negativePrompt ?? '',
    ...(Number.isFinite(item.x) && Number.isFinite(item.y)
      ? { center: { x: item.x, y: item.y } }
      : {}),
  }));
}

function ikunCharacters(input: GatewayGenerationInput) {
  return enabledCharacters(input).map((item) => ({
    prompt: item.prompt,
    ...(Number.isFinite(item.x) && Number.isFinite(item.y)
      ? { center: { x: item.x, y: item.y } }
      : {}),
  }));
}

function ikunCharacterNegativePrompt(input: GatewayGenerationInput) {
  const characters = enabledCharacters(input);
  if (!characters.some((item) => item.negativePrompt)) return undefined;
  return {
    caption: {
      base_caption: input.negativePrompt ?? '',
      char_captions: characters.map((item) => ({
        char_caption: item.negativePrompt ?? '',
        centers: Number.isFinite(item.x) && Number.isFinite(item.y)
          ? [{ x: item.x, y: item.y }]
          : [],
      })),
    },
    legacy_uc: false,
  };
}

function basePayload(input: GatewayGenerationInput, includeNegativePrompt = true) {
  return {
    model: input.model,
    prompt: input.prompt,
    ...(includeNegativePrompt && input.negativePrompt ? { negative_prompt: input.negativePrompt } : {}),
    width: input.width,
    height: input.height,
    steps: input.steps,
    scale: input.scale,
    cfg_rescale: input.cfgRescale,
    sampler: input.sampler,
    noise_schedule: input.noiseSchedule,
    seed: input.seed,
  };
}

function build7877(input: GatewayGenerationInput): Record<string, unknown> {
  if (input.preciseReferences?.length) throw new Error('7877 does not support precise references');
  if (input.operation === 'inpaint' && input.references?.length) {
    throw new Error('7877 inpainting does not support Vibe references');
  }

  const characters = gatewayCharacters(input);
  const references = input.references ?? [];
  const params: Record<string, unknown> = {
    steps: input.steps,
    scale: input.scale,
    cfg_rescale: input.cfgRescale,
    sampler: input.sampler,
    noise_schedule: input.noiseSchedule,
    seed: input.seed,
    ...(input.negativePrompt ? { negative_prompt: input.negativePrompt } : {}),
    quality: true,
    uc_preset: 'light',
    sm: false,
    sm_dyn: false,
    ...(input.operation !== 'inpaint' && characters.length
      ? { characters, use_coords: input.useCoords === true }
      : {}),
    ...(input.operation !== 'inpaint' && references.length
      ? {
          reference_image_multiple: references.map((item) => item.imageBase64),
          reference_strength_multiple: references.map((item) => clamp01(item.strength)),
          reference_information_extracted_multiple: references.map((item) => clamp01(item.informationExtracted)),
        }
      : {}),
  };
  const base = {
    // 7877's OpenAI-like envelope nests negative_prompt under `params`; its
    // top-level shape differs from Ikun's direct-field envelope.
    ...basePayload(input, false),
    n: 1,
    size: `${input.width}x${input.height}`,
    response_format: 'b64_json',
  };

  if (input.operation === 'textToImage') return { ...base, params };
  if (input.operation === 'imageToImage') {
    return {
      ...base,
      image: image(input.imageBase64, 'image'),
      strength: input.strength ?? 0.7,
      noise: input.noise ?? 0,
      color_correct: input.colorCorrect !== false,
      params,
    };
  }
  return {
    ...base,
    image: image(input.imageBase64, 'image'),
    mask: image(input.maskBase64, 'mask'),
    strength: input.strength ?? 0.7,
    params,
  };
}

function buildIkun(input: GatewayGenerationInput): Record<string, unknown> {
  const references = input.references ?? [];
  const precise = input.preciseReferences ?? [];
  const characters = enabledCharacters(input);
  if (references.length && precise.length) throw new Error('Vibe and precise references cannot be combined');
  if (input.operation !== 'textToImage' && precise.length) throw new Error('Precise references only support text-to-image');
  if (input.operation === 'imageToImage' && (references.length || characters.length)) {
    throw new Error('Ikun image-to-image does not support references or character prompts');
  }
  if (input.operation === 'inpaint' && (references.length || characters.length)) {
    throw new Error('Ikun inpainting does not support references or character prompts');
  }

  const base = {
    ...basePayload(input),
    response_format: 'b64_json',
  };
  if (input.operation === 'textToImage' && precise.length) {
    return {
      novelai_operation: 'precise-reference',
      ...base,
      size: `${input.width}x${input.height}`,
      n_samples: 1,
      references: precise.map((item) => ({
        reference_image: image(item.imageBase64, 'precise reference'),
        reference_type: item.type,
        strength: clamp01(item.strength),
        fidelity: 1,
      })),
    };
  }

  if (input.operation === 'textToImage') {
    const charactersForPayload = ikunCharacters(input);
    return {
      ...base,
      n: 1,
      size: `${input.width}x${input.height}`,
      ...(charactersForPayload.length ? {
        characterPrompts: charactersForPayload,
        use_coords: input.useCoords === true,
      } : {}),
      ...(ikunCharacterNegativePrompt(input)
        ? { v4_negative_prompt: ikunCharacterNegativePrompt(input) }
        : {}),
      ...(references.length === 1 ? {
        reference_image: image(references[0].imageBase64, 'reference image'),
        reference_strength: clamp01(references[0].strength),
        reference_information_extracted: clamp01(references[0].informationExtracted),
      } : {}),
      ...(references.length > 1 ? {
        reference_images: references.map((item) => image(item.imageBase64, 'reference image')),
        reference_strength_multiple: references.map((item) => clamp01(item.strength)),
        reference_information_extracted_multiple: references.map((item) => clamp01(item.informationExtracted)),
      } : {}),
    };
  }
  if (input.operation === 'imageToImage') {
    return {
      novelai_operation: 'img2img',
      ...base,
      image: image(input.imageBase64, 'image'),
      strength: input.strength ?? 0.7,
      noise: input.noise ?? 0,
      response_format: 'b64_json',
    };
  }
  return {
    novelai_operation: 'inpainting',
    ...base,
    n: 1,
    size: `${input.width}x${input.height}`,
    image: image(input.imageBase64, 'image'),
    mask: image(input.maskBase64, 'mask'),
    strength: input.strength ?? 0.7,
    noise: input.noise ?? 0,
    add_original_image: input.disabledOriginalImage !== true,
    color_correct: input.colorCorrect !== false,
    response_format: 'b64_json',
  };
}

/** Build the old PC gateway endpoint and request envelope without credentials. */
export function buildGatewayGenerationRequest(input: GatewayGenerationInput): GatewayGenerationRequest {
  return {
    path: '/v1/images/generations',
    accept: 'application/json',
    payload: input.protocol === 'gateway7877' ? build7877(input) : buildIkun(input),
  };
}

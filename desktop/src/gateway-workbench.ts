import type { GenerateParams, HistoryItem, ModelMode } from './types';

export type GatewayProtocol = 'gateway7877' | 'ikun';

/** Safe profile projection. Secrets are accepted only by add and never returned. */
export interface GatewayProfile {
  id: string;
  name: string;
  protocol: GatewayProtocol;
  baseUrl: string;
  selected: boolean;
}

export interface GatewayProfileInput {
  name: string;
  protocol: GatewayProtocol;
  baseUrl: string;
  token: string;
}

/** Features present in the current image workbench that this first release cannot carry. */
export interface GatewayDraftFeatures {
  characterPrompts?: number;
  vibeReferences?: number;
  preciseReferences?: number;
}

export interface GatewayPlanRequest {
  profileId: string;
  operation: 'textToImage' | 'imageToImage' | 'inpaint';
  draft: GenerateParams;
  modelMode?: ModelMode;
  features?: GatewayDraftFeatures;
}

export interface GatewayPlanPreview {
  planId: string;
  expiresAt: string;
  profileId: string;
  profileName: string;
  protocol: GatewayProtocol;
  endpoint: string;
  model: string;
  prompt: string;
  negativePrompt: string;
  width: number;
  height: number;
  steps: number;
  scale: number;
  cfgRescale: number;
  sampler: string;
  noiseSchedule: string;
  seed: number;
  requestPayload: Record<string, unknown>;
}

export type GatewayJobStatus = 'succeeded' | 'failed' | 'uncertain';
export interface GatewayJobResult {
  status: GatewayJobStatus;
  message: string;
  items?: HistoryItem[];
}

export interface GatewayWorkbenchApi {
  listProfiles(): Promise<GatewayProfile[]>;
  addProfile(input: GatewayProfileInput): Promise<GatewayProfile[]>;
  selectProfile(profileId: string): Promise<GatewayProfile[]>;
  removeProfile(profileId: string): Promise<GatewayProfile[]>;
  prepare(request: GatewayPlanRequest): Promise<GatewayPlanPreview>;
  generate(input: { planId: string; confirmed: true }): Promise<GatewayJobResult>;
  cancel(planId: string): Promise<{ accepted: boolean; message: string }>;
}

import type { KnowledgeSettings, KnowledgeStatus } from './agent/knowledge';
import type { LegacyImportPreview, LegacyImportResult } from './agent/legacy-import-types';

export interface WorldpainterAPI {
  gateway: import('./gateway-workbench').GatewayWorkbenchApi;
  legacyImport: {
    selectAndPreview(): Promise<LegacyImportPreview | null>;
    confirm(previewId: string): Promise<LegacyImportResult>;
    cancel(previewId: string): Promise<void>;
  };
  knowledgeStatus(): Promise<KnowledgeStatus>;
  chooseKnowledgeFile(): Promise<string | null>;
  saveKnowledgeSettings(settings: KnowledgeSettings): Promise<KnowledgeStatus>;
  reloadKnowledge(): Promise<KnowledgeStatus>;
}
declare global { interface Window { worldpainter: WorldpainterAPI; } }

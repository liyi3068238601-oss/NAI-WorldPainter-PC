/** Safe renderer-facing summary for a user-selected Flutter desktop snapshot. */
export interface LegacyImportCounts {
  draft: number;
  gallery: number;
  styles: number;
  artists: number;
  approvedMemories: number;
  pendingMemories: number;
  sessions: number;
  assets: number;
  archivedFields: number;
  invalidRows: number;
  duplicateRows: number;
  missingAssets: number;
}

export interface LegacyImportPreview {
  /** Opaque, in-memory key; never a source path. */
  previewId: string;
  sourceFile: string;
  schemaVersion: number;
  revision: number;
  counts: LegacyImportCounts;
  archivedFieldCounts: Record<string, number>;
  draft?: {
    positivePromptCharacters: number;
    negativePromptCharacters: number;
    width: number;
    height: number;
    model: string;
  };
  samples: {
    gallery: string[];
    styles: string[];
    artists: string[];
    memories: string[];
    sessions: string[];
  };
  warnings: string[];
}

export interface LegacyImportResult {
  sourceFile: string;
  imported: Pick<LegacyImportCounts,
    "draft" | "gallery" | "styles" | "artists" | "approvedMemories" | "pendingMemories" | "sessions" | "assets">;
  skipped: Pick<LegacyImportCounts, "draft" | "invalidRows" | "duplicateRows" | "missingAssets">;
  archiveFileName: string;
}

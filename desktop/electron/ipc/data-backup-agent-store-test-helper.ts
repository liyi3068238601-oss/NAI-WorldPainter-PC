/** Minimal inert Agent state used when a backup test exercises other categories. */
export function dataBackupAgentStoreStub() {
  const workspace = () => ({
    version: 1,
    conversations: [],
    characters: [],
    personas: [],
    lorebooks: [],
    samplerPresets: [],
    skills: [],
    memories: [],
    studioDefaults: {},
    defaultGenerationMode: "tavern",
  });
  const r4State = () => ({
    schemaVersion: 1,
    conversations: {},
    creations: {},
    proposals: {},
    artworks: {},
    preparations: {},
    executions: {},
    messageQueue: {},
    gates: {},
    operations: {},
    critiqueQueue: {},
    assistantPresets: {},
    compatibility: {},
    updatedAt: "2026-10-18T00:00:00.000Z",
  });
  return {
    getAgentSqlStore: () => ({
      transaction: <T>(work: (tx: { getWorkspace: () => unknown; getR4State: () => unknown }) => T) =>
        work({ getWorkspace: workspace, getR4State: r4State }),
    }),
    normalizeAgentWorkspace: (value: unknown) => value,
    readAgentWorkspace: workspace,
    agentAttachmentsDirectory: () => process.cwd(),
    mergeImportedAgentWorkspace: () => ({ imported: 0, skipped: 0, renamed: 0 }),
  };
}

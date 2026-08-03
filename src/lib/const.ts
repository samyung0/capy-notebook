export const NOTIFICATION_PAGE_SIZE = 50;

export const MATERIAL_SCHEMA_VERSION = 1 as const;

// IMPORTANT: KEEP IN SYNC WITH VALUES IN collaboration/src/persistence.ts
export const MATERIAL_DOCUMENT_LIMITS = {
  maxContentBytes: 2 * 1024 * 1024,
  maxDepth: 16,
  maxNodes: 10_000,
} as const;

export const EDITOR_CHECKPOINT_MAP = 'evo:checkpoints';
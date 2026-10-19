export const NOTIFICATION_PAGE_SIZE = 50;

export const MATERIAL_SCHEMA_VERSION = 1 as const;

// Display denominators only; the collaboration service owns enforcement.
// IMPORTANT: KEEP IN SYNC WITH VALUES IN collaboration-rs/crates/notes/src/limits.rs
export const MATERIAL_DOCUMENT_LIMITS = {
  maxContentBytes: 2 * 1024 * 1024,
  maxDepth: 16,
  maxNodes: 10_000,
} as const;

// The ceiling on any source state, which also bounds the edits a device holds
// while offline (a room's own cap is lower: state_cap). IMPORTANT: KEEP IN
// SYNC WITH MAX_SOURCE_STATE_BYTES IN collaboration-rs/crates/sources/src/lib.rs
export const SOURCE_STATE_MAX_BYTES = 100 * 1024 * 1024;

/**
 * When to warn before opening a document, deliberately NOT derived from
 * MATERIAL_DOCUMENT_LIMITS. Those caps protect the collaboration service and
 * the database and apply on write; these describe what this browser can mount
 * comfortably. Keeping them independent means a document that legitimately
 * exceeds a cap — an operator import, an account allowed to bypass, a limit
 * lowered after the fact — still opens, and lowering a cap does not silently
 * start nagging about documents that were fine yesterday.
 */
export const MATERIAL_RENDER_WARNING = {
  contentBytes: 1_500_000,
  nodeCount: 6000,
} as const;

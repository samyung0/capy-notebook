import { MATERIAL_DOCUMENT_DEPTH_CEILING } from './materialDocument.js';

// IMPORTANT: KEEP IN SYNC WITH src/lib/const.ts and
// server/internal/materialdoc/document.go
export const MATERIAL_DOCUMENT_LIMITS = {
  maxContentBytes: 2 * 1024 * 1024,
  maxDepth: 16,
  maxNodes: 10_000,
} as const;

export interface MaterialDocumentMetrics {
  contentBytes: number;
  maxDepth: number;
  nodeCount: number;
}

export type MaterialLimitCode =
  | 'document_depth_exceeded'
  | 'document_nodes_exceeded'
  | 'document_size_exceeded';

export class MaterialDocumentLimitError extends Error {
  readonly code: MaterialLimitCode;
  readonly metrics: MaterialDocumentMetrics;

  constructor(code: MaterialLimitCode, metrics: MaterialDocumentMetrics) {
    super(`invalid material document: ${code}`);
    this.name = 'MaterialDocumentLimitError';
    this.code = code;
    this.metrics = metrics;
  }
}

function stripRuntimeCommentMarks(value: unknown[]): unknown[] {
  return value.map((node) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
    const normalized: Record<string, unknown> = {};
    const record = node as Record<string, unknown>;
    const isTextLeaf = record.text !== null && record.text !== undefined;
    for (const [key, child] of Object.entries(record)) {
      if (isTextLeaf && (key === 'comment' || key.startsWith('comment_'))) {
        continue;
      }
      normalized[key] =
        key === 'children' && Array.isArray(child)
          ? stripRuntimeCommentMarks(child)
          : child;
    }
    return normalized;
  });
}

export function measureMaterialValue(
  value: unknown[]
): MaterialDocumentMetrics {
  const normalized = stripRuntimeCommentMarks(value);
  const metrics: MaterialDocumentMetrics = {
    contentBytes: Buffer.byteLength(
      JSON.stringify({ schemaVersion: 1, value: normalized }),
      'utf8'
    ),
    maxDepth: 0,
    nodeCount: 0,
  };
  const visit = (node: unknown, depth: number) => {
    metrics.nodeCount += 1;
    if (depth > metrics.maxDepth) metrics.maxDepth = depth;
    // Structural validation rejects children beyond this point. Walking every
    // structurally valid level keeps shrink-only comparisons exact even when a
    // legacy document already exceeds the product depth cap.
    if (depth >= MATERIAL_DOCUMENT_DEPTH_CEILING) return;
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    const children = (node as { children?: unknown }).children;
    if (!Array.isArray(children)) return;
    for (const child of children) visit(child, depth + 1);
  };
  for (const node of normalized) visit(node, 0);
  return metrics;
}

export function materialLimitCode(
  metrics: MaterialDocumentMetrics
): MaterialLimitCode | null {
  if (metrics.contentBytes > MATERIAL_DOCUMENT_LIMITS.maxContentBytes) {
    return 'document_size_exceeded';
  }
  if (metrics.nodeCount > MATERIAL_DOCUMENT_LIMITS.maxNodes) {
    return 'document_nodes_exceeded';
  }
  if (metrics.maxDepth > MATERIAL_DOCUMENT_LIMITS.maxDepth) {
    return 'document_depth_exceeded';
  }
  return null;
}

/**
 * An over-limit document must stay editable in the shrinking direction.
 * Rejecting every write once a document is too large would also reject the
 * deletions needed to recover, leaving the material permanently unsavable.
 */
export function recoversMaterialLimits(
  next: MaterialDocumentMetrics,
  previous: MaterialDocumentMetrics | null
): boolean {
  if (!previous) return false;
  return (
    next.contentBytes <= previous.contentBytes &&
    next.nodeCount <= previous.nodeCount &&
    next.maxDepth <= previous.maxDepth
  );
}

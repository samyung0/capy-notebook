import { m } from '@/i18n';
import { MATERIAL_DOCUMENT_LIMITS } from '@/lib/const';

/**
 * Stateless room messages exchanged with the collaboration service.
 * IMPORTANT: KEEP IN SYNC WITH collaboration/src/server.ts.
 */
/** Authentication refusal reason for a writer whose room turned read-only. */
export const COLLABORATION_READ_ONLY_REASON = 'collaboration-read-only';
/** Refusal reasons for a trashed or deleted document and for lost access.
 * Any other refusal is retried with a fresh token (roomConnection.ts). */
export const COLLABORATION_NOT_FOUND_REASON = 'collaboration-not-found';
export const COLLABORATION_FORBIDDEN_REASON = 'collaboration-forbidden';

export interface MaterialDocumentStats {
  contentBytes: number;
  maxDepth: number;
  nodeCount: number;
}

export type MaterialLimitCode =
  | 'document_depth_exceeded'
  | 'document_nodes_exceeded'
  | 'document_size_exceeded';

export type CollaborationEvent =
  /** Durable receipts. A request with nothing to save is answered at once,
   * without `metrics` (the editor keeps what it shows). */
  | {
      checkpointIds: string[];
      limitCode: MaterialLimitCode | null;
      materialId: string;
      metrics: MaterialDocumentStats | null;
      type: 'checkpoint-persisted';
    }
  /** The room refused this editor's state for good (a limit, or an invalid
   * document): the editor reloads the last saved version. */
  | {
      code: MaterialLimitCode | 'invalid_document';
      materialId: string;
      metrics: MaterialDocumentStats | null;
      room: string;
      type: 'document-rejected';
    }
  /** A store failed and is being retried; the editor keeps its edits. */
  | { materialId: string; type: 'checkpoint-failed' }
  /** The room discarded an update from a writer who lost access: every
   * editor drops its copy and reloads the last saved version. */
  | { room: string; type: 'authorization-revoked' }
  | { materialId: string; type: 'comments-invalidated' }
  | { materialId: string; type: 'projection-updated' }
  | {
      materialId?: string;
      newRoom?: string;
      room?: string;
      type: 'compaction-complete' | 'compaction-evict';
    }
  /** The room turned read-only for this writer (a frozen account). */
  | { room: string; type: 'room-read-only' }
  /** The children pass kept these ids as the note's own (some just left the
   * trash): blocks waiting on one load it again. */
  | { assetIds: string[]; materialIds: string[]; type: 'children-ready' }
  /** A pasted copy did not fit the payer's storage; its block was removed.
   * Sent only to the writer who pasted. */
  | { type: 'children-refused' };

const LIMIT_CODES = new Set<string>([
  'document_depth_exceeded',
  'document_nodes_exceeded',
  'document_size_exceeded',
]);

function readStats(value: unknown): MaterialDocumentStats | null {
  if (!value || typeof value !== 'object') return null;
  const { contentBytes, maxDepth, nodeCount } = value as Record<
    string,
    unknown
  >;
  if (
    typeof contentBytes !== 'number' ||
    typeof maxDepth !== 'number' ||
    typeof nodeCount !== 'number'
  ) {
    return null;
  }
  return { contentBytes, maxDepth, nodeCount };
}

export function parseCollaborationEvent(
  payload: string
): CollaborationEvent | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const materialId = typeof raw.materialId === 'string' ? raw.materialId : '';
  switch (raw.type) {
    case 'checkpoint-persisted': {
      const metrics = readStats(raw.metrics);
      if (!materialId || (raw.metrics !== undefined && !metrics)) return null;
      return {
        checkpointIds: Array.isArray(raw.checkpointIds)
          ? raw.checkpointIds.filter(
              (id): id is string => typeof id === 'string'
            )
          : [],
        limitCode:
          typeof raw.limitCode === 'string' && LIMIT_CODES.has(raw.limitCode)
            ? (raw.limitCode as MaterialLimitCode)
            : null,
        materialId,
        metrics,
        type: 'checkpoint-persisted',
      };
    }
    case 'document-rejected': {
      const code = raw.code;
      if (
        !materialId ||
        typeof code !== 'string' ||
        !(LIMIT_CODES.has(code) || code === 'invalid_document')
      ) {
        return null;
      }
      return {
        code: code as MaterialLimitCode | 'invalid_document',
        materialId,
        metrics: readStats(raw.metrics),
        room: typeof raw.room === 'string' ? raw.room : '',
        type: 'document-rejected',
      };
    }
    case 'checkpoint-failed':
      return materialId ? { materialId, type: 'checkpoint-failed' } : null;
    case 'authorization-revoked':
      return typeof raw.room === 'string'
        ? { room: raw.room, type: 'authorization-revoked' }
        : null;
    case 'comments-invalidated':
    case 'projection-updated':
      return materialId ? { materialId, type: raw.type } : null;
    case 'room-read-only':
      return typeof raw.room === 'string'
        ? { room: raw.room, type: 'room-read-only' }
        : null;
    case 'children-ready': {
      const ids = (value: unknown) =>
        Array.isArray(value)
          ? value.filter((id): id is string => typeof id === 'string')
          : [];
      return {
        assetIds: ids(raw.assetIds),
        materialIds: ids(raw.materialIds),
        type: 'children-ready',
      };
    }
    case 'children-refused':
      return { type: 'children-refused' };
    case 'compaction-complete':
    case 'compaction-evict':
      return {
        materialId:
          typeof raw.materialId === 'string' ? raw.materialId : undefined,
        newRoom: typeof raw.newRoom === 'string' ? raw.newRoom : undefined,
        room: typeof raw.room === 'string' ? raw.room : undefined,
        type: raw.type,
      };
    default:
      return null;
  }
}

export function materialLimitMessage(code: MaterialLimitCode): string {
  switch (code) {
    case 'document_size_exceeded':
      return m.editor_limit_size({
        kb: Math.ceil(
          MATERIAL_DOCUMENT_LIMITS.maxContentBytes / 1024
        ).toLocaleString(),
      });
    case 'document_nodes_exceeded':
      return m.editor_limit_nodes({
        max: MATERIAL_DOCUMENT_LIMITS.maxNodes.toLocaleString(),
      });
    case 'document_depth_exceeded':
      return m.editor_limit_depth({
        max: String(MATERIAL_DOCUMENT_LIMITS.maxDepth),
      });
  }
}

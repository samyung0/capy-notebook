import { m } from '@/i18n';
import { MATERIAL_DOCUMENT_LIMITS } from '@/lib/const';

/**
 * Stateless room messages exchanged with the collaboration service.
 * IMPORTANT: KEEP IN SYNC WITH collaboration/src/server.ts.
 */
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
  | {
      checkpointIds: string[];
      limitCode: MaterialLimitCode | null;
      materialId: string;
      metrics: MaterialDocumentStats;
      type: 'checkpoint-persisted';
      yjsVersion: number;
    }
  | {
      code: MaterialLimitCode;
      materialId: string;
      metrics: MaterialDocumentStats;
      room: string;
      type: 'document-rejected';
    }
  | { materialId: string; type: 'comments-invalidated' }
  | { materialId: string; type: 'projection-updated' }
  | {
      materialId?: string;
      newRoom?: string;
      room?: string;
      type: 'compaction-complete' | 'compaction-evict';
    };

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
      if (!(metrics && materialId) || typeof raw.yjsVersion !== 'number') {
        return null;
      }
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
        yjsVersion: raw.yjsVersion,
      };
    }
    case 'document-rejected': {
      const metrics = readStats(raw.metrics);
      if (
        !(metrics && materialId) ||
        typeof raw.code !== 'string' ||
        !LIMIT_CODES.has(raw.code)
      ) {
        return null;
      }
      return {
        code: raw.code as MaterialLimitCode,
        materialId,
        metrics,
        room: typeof raw.room === 'string' ? raw.room : '',
        type: 'document-rejected',
      };
    }
    case 'comments-invalidated':
    case 'projection-updated':
      return materialId ? { materialId, type: raw.type } : null;
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

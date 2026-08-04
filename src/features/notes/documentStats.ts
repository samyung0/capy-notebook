import { MATERIAL_DOCUMENT_LIMITS } from '@/lib/const';
import type { MaterialDocumentStats } from './collaborationEvents';

export function shouldShowDocumentStats(
  stats: MaterialDocumentStats | null
): boolean {
  if (!stats) return false;
  return (
    stats.nodeCount >= MATERIAL_DOCUMENT_LIMITS.maxNodes / 2 ||
    stats.maxDepth >= MATERIAL_DOCUMENT_LIMITS.maxDepth / 2 ||
    stats.contentBytes >= MATERIAL_DOCUMENT_LIMITS.maxContentBytes / 2
  );
}

export function contentSizeKilobytes(contentBytes: number): number {
  return Math.ceil(contentBytes / 1024);
}

export function formatContentSize(contentBytes: number | null): string {
  return contentBytes == null
    ? '—'
    : `${contentSizeKilobytes(contentBytes).toLocaleString()} KB`;
}

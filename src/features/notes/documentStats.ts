import { type MaterialDocumentMetrics } from "@/features/materials/document";
import { MATERIAL_DOCUMENT_LIMITS } from "@/lib/const";

export function shouldShowDocumentStats(
  metrics: MaterialDocumentMetrics,
  contentBytes: number | null,
): boolean {
  return (
    metrics.nodeCount >= MATERIAL_DOCUMENT_LIMITS.maxNodes / 2 ||
    metrics.maxDepth >= MATERIAL_DOCUMENT_LIMITS.maxDepth / 2 ||
    (contentBytes ?? 0) >= MATERIAL_DOCUMENT_LIMITS.maxContentBytes / 2
  );
}

export function contentSizeKilobytes(contentBytes: number): number {
  return Math.ceil(contentBytes / 1024);
}

export function formatContentSize(contentBytes: number | null): string {
  return contentBytes == null
    ? "—"
    : `${contentSizeKilobytes(contentBytes).toLocaleString()} KB`;
}

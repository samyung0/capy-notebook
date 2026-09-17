import type { Material, MaterialRef, SourceFile } from '@/api/types';

export interface ContentActionTarget {
  chapterId: string | null;
  createdAt: string;
  id: string;
  kind: string;
  maxDepth?: number;
  name: string;
  nodeCount?: number;
  sizeBytes?: number;
  status?: SourceFile['status'];
  type: 'file' | 'material';
}

export function toFileActionTarget(file: SourceFile): ContentActionTarget {
  return {
    chapterId: file.chapterId,
    createdAt: file.addedAt,
    id: file.id,
    kind: file.kind,
    name: file.name,
    sizeBytes: file.sizeBytes,
    status: file.status,
    type: 'file',
  };
}

export function toMaterialActionTarget(
  material: Material | MaterialRef
): ContentActionTarget {
  return {
    chapterId: material.chapterId,
    createdAt: material.createdAt,
    id: material.id,
    kind: 'type' in material ? material.type : material.kind,
    maxDepth: material.maxDepth,
    name: material.title,
    nodeCount: material.nodeCount,
    type: 'material',
  };
}

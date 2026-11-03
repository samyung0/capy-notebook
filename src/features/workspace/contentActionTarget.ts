import type {
  Material,
  MaterialListItem,
  MaterialRef,
  SourceFile,
} from '@/api/types';

export interface ContentActionTarget {
  createdAt: string;
  id: string;
  kind: string;
  maxDepth?: number;
  name: string;
  nodeCount?: number;
  sizeBytes?: number;
  status?: SourceFile['status'];
  topicId: string | null;
  type: 'file' | 'material';
}

export function toFileActionTarget(file: SourceFile): ContentActionTarget {
  return {
    createdAt: file.addedAt,
    id: file.id,
    kind: file.kind,
    name: file.name,
    sizeBytes: file.sizeBytes,
    status: file.status,
    topicId: file.topicId,
    type: 'file',
  };
}

export function toMaterialActionTarget(
  material: Material | MaterialRef | MaterialListItem
): ContentActionTarget {
  return {
    createdAt: material.createdAt,
    id: material.id,
    kind: 'type' in material ? material.type : material.kind,
    topicId: material.topicId,
    ...('maxDepth' in material
      ? { maxDepth: material.maxDepth, nodeCount: material.nodeCount }
      : {}),
    name: material.title,
    ...('sizeBytes' in material ? { sizeBytes: material.sizeBytes } : {}),
    type: 'material',
  };
}

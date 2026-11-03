import type {
  Material,
  MaterialListItem,
  MaterialRef,
  SourceFile,
} from '@/api/types';

export interface ContentActionTarget {
  chapterId: string | null;
  createdAt: string;
  /** Hidden from members: owners and editors see it and may show it. */
  hidden?: boolean;
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
    hidden: file.hidden,
    id: file.id,
    kind: file.kind,
    name: file.name,
    sizeBytes: file.sizeBytes,
    status: file.status,
    type: 'file',
  };
}

export function toMaterialActionTarget(
  material: Material | MaterialRef | MaterialListItem
): ContentActionTarget {
  return {
    chapterId: material.chapterId,
    createdAt: material.createdAt,
    hidden: material.hidden,
    id: material.id,
    kind: 'type' in material ? material.type : material.kind,
    ...('maxDepth' in material
      ? { maxDepth: material.maxDepth, nodeCount: material.nodeCount }
      : {}),
    name: material.title,
    ...('sizeBytes' in material ? { sizeBytes: material.sizeBytes } : {}),
    type: 'material',
  };
}

import type { MaterialRef, SourceFile, Topic } from '@/api/types';

/** A file or material as the workspace tree lists it. */
export type WorkspaceContentItem =
  | {
      type: 'file';
      id: string;
      position: number;
      createdAt: string;
      data: SourceFile;
    }
  | {
      type: 'material';
      id: string;
      position: number;
      createdAt: string;
      data: MaterialRef;
    };

/** One topic's files and materials (unfiled for null), in tree order. */
export function contentFor(
  files: SourceFile[] | undefined,
  materials: MaterialRef[] | undefined,
  topicId: string | null
): WorkspaceContentItem[] {
  const topicFiles = files?.filter((file) => file.topicId === topicId) ?? [];
  const topicMaterials =
    materials?.filter((material) => (material.topicId ?? null) === topicId) ??
    [];
  return [
    ...topicFiles.map(
      (file): WorkspaceContentItem => ({
        createdAt: file.addedAt,
        data: file,
        id: file.id,
        position: file.position,
        type: 'file',
      })
    ),
    ...topicMaterials.map(
      (material): WorkspaceContentItem => ({
        createdAt: material.createdAt,
        data: material,
        id: material.id,
        position: material.position,
        type: 'material',
      })
    ),
  ].sort(treeOrder);
}

interface Ordered {
  createdAt: string;
  position: number;
  type: 'file' | 'material';
}

/** Inside one topic: by position, files first on ties, then newest. */
function treeOrder(a: Ordered, b: Ordered) {
  const positionDiff = a.position - b.position;
  if (positionDiff) return positionDiff;
  if (a.type !== b.type) return a.type === 'file' ? -1 : 1;
  return +new Date(b.createdAt) - +new Date(a.createdAt);
}

/** Every item in reading order: topics by position, then unfiled. */
export function readingOrder(
  topics: Topic[] | undefined,
  files: SourceFile[] | undefined,
  materials: MaterialRef[] | undefined
): WorkspaceContentItem[] {
  return [
    ...[...(topics ?? [])]
      .sort((a, b) => a.order - b.order)
      .flatMap((ch) => contentFor(files, materials, ch.id)),
    ...contentFor(files, materials, null),
  ];
}

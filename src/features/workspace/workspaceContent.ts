import type { Chapter, MaterialRef, SourceFile } from '@/api/types';

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

/** One chapter's files and materials (unfiled for null), in tree order. */
export function contentFor(
  files: SourceFile[] | undefined,
  materials: MaterialRef[] | undefined,
  chapterId: string | null
): WorkspaceContentItem[] {
  const chapterFiles =
    files?.filter((file) => file.chapterId === chapterId) ?? [];
  const chapterMaterials =
    materials?.filter(
      (material) => (material.chapterId ?? null) === chapterId
    ) ?? [];
  return [
    ...chapterFiles.map(
      (file): WorkspaceContentItem => ({
        createdAt: file.addedAt,
        data: file,
        id: file.id,
        position: file.position,
        type: 'file',
      })
    ),
    ...chapterMaterials.map(
      (material): WorkspaceContentItem => ({
        createdAt: material.createdAt,
        data: material,
        id: material.id,
        position: material.position,
        type: 'material',
      })
    ),
  ].sort((a, b) => {
    const positionDiff = a.position - b.position;
    if (positionDiff) return positionDiff;
    if (a.type !== b.type) return a.type === 'file' ? -1 : 1;
    return +new Date(b.createdAt) - +new Date(a.createdAt);
  });
}

/** Every item in reading order: chapters by position, then unfiled. */
export function readingOrder(
  chapters: Chapter[] | undefined,
  files: SourceFile[] | undefined,
  materials: MaterialRef[] | undefined
): WorkspaceContentItem[] {
  return [
    ...[...(chapters ?? [])]
      .sort((a, b) => a.order - b.order)
      .flatMap((ch) => contentFor(files, materials, ch.id)),
    ...contentFor(files, materials, null),
  ];
}

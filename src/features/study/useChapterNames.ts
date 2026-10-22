import { useChapters, useMaterials } from '@/api/hooks';

/** Looks up the name of the chapter a workspace material sits in, once the
 * workspace's chapters and materials have loaded; undefined outside a
 * chapter. */
export function useChapterNames(workspaceId: string | undefined) {
  const { data: chapters } = useChapters(workspaceId ?? '', {
    errorBoundary: false,
  });
  const { data: materials } = useMaterials(workspaceId ?? '', {
    errorBoundary: false,
  });
  return (materialId: string): string | undefined => {
    const chapterId = materials?.find((mt) => mt.id === materialId)?.chapterId;
    return chapterId
      ? chapters?.find((c) => c.id === chapterId)?.name
      : undefined;
  };
}

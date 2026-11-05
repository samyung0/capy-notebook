import { useMaterials, useTopics } from '@/api/hooks';

/** Looks up the name of the topic a workspace material sits in, once the
 * workspace's topics and materials have loaded; undefined outside a
 * topic. */
export function useTopicNames(workspaceId: string | undefined) {
  const { data: topics } = useTopics(workspaceId ?? '', {
    errorBoundary: false,
  });
  const { data: materials } = useMaterials(workspaceId ?? '', {
    errorBoundary: false,
  });
  return (materialId: string): string | undefined => {
    const topicId = materials?.find((mt) => mt.id === materialId)?.topicId;
    return topicId ? topics?.find((c) => c.id === topicId)?.name : undefined;
  };
}

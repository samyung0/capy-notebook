import type { CoverConfig } from '@/api/types';
import { finishKey } from '@/features/questions/trailMap/finish';
import { coverInk } from '@/lib/coverInk';
import { RailMap } from './railMap/RailMap';

/** One workspace's tracked items on the railway map, as Learning's lead and
 * the workspace's Study page draw it: `topics` in order, `items` in
 * reading order. */
export function WorkspaceRailMap({
  workspaceId,
  cover,
  topics,
  items,
  onOpen,
}: {
  workspaceId: string;
  cover?: CoverConfig;
  topics: readonly { id: string; name: string }[];
  items: readonly {
    id: string;
    topicId?: string | null;
    state?: string;
    title: string;
  }[];
  onOpen: (itemId: string) => void;
}) {
  const topicIndex = new Map(topics.map((ch, i) => [ch.id, i]));
  return (
    <RailMap
      color={coverInk(cover)}
      finishKey={finishKey('workspace', workspaceId, items.length)}
      items={items.map((it) => ({
        id: it.id,
        state:
          it.state === 'done' || it.state === 'started' ? it.state : undefined,
        title: it.title,
        topic: it.topicId ? (topicIndex.get(it.topicId) ?? null) : null,
      }))}
      onOpen={onOpen}
      topics={topics.map((ch) => ch.name)}
      workspaceId={workspaceId}
    />
  );
}

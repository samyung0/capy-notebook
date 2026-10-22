import type { CoverConfig } from '@/api/types';
import { finishKey } from '@/features/questions/trailMap/finish';
import { coverInk } from '@/lib/coverInk';
import { RailMap } from './railMap/RailMap';

/** One workspace's tracked items on the railway map, as Learning's lead and
 * the workspace's Study page draw it: `chapters` in order, `items` in
 * reading order. */
export function WorkspaceRailMap({
  workspaceId,
  cover,
  chapters,
  items,
  onOpen,
}: {
  workspaceId: string;
  cover?: CoverConfig;
  chapters: readonly { id: string; name: string }[];
  items: readonly {
    id: string;
    chapterId?: string | null;
    state?: string;
    title: string;
  }[];
  onOpen: (itemId: string) => void;
}) {
  const chapterIndex = new Map(chapters.map((ch, i) => [ch.id, i]));
  return (
    <RailMap
      chapters={chapters.map((ch) => ch.name)}
      color={coverInk(cover)}
      finishKey={finishKey('workspace', workspaceId, items.length)}
      items={items.map((it) => ({
        chapter: it.chapterId ? (chapterIndex.get(it.chapterId) ?? null) : null,
        id: it.id,
        state:
          it.state === 'done' || it.state === 'started' ? it.state : undefined,
        title: it.title,
      }))}
      onOpen={onOpen}
      workspaceId={workspaceId}
    />
  );
}

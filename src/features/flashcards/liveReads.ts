import { useEffect, useRef, useState } from 'react';
import type { InNote } from '@/features/collaboration/noteSeat';
import { whileVisible } from '@/features/collaboration/whileVisible';
import type { FlashcardContent } from '@/features/materials/blocks';

/**
 * A set's cards as its live room holds them, for readers (the study page, a
 * set's View, a note's embed in View): the stored cards paint first, then
 * the room's once synced, then every edit as it lands (Epo 2026-10-10).
 * The room code (yjs, the provider) loads only after first paint, so pages
 * that read pay nothing until then.
 */
export function useLiveSetCards(
  setId: string,
  stored: FlashcardContent[],
  enabled = true,
  { inside, wake }: InNote = {}
): FlashcardContent[] {
  const [live, setLive] = useState<FlashcardContent[] | null>(null);
  // A room that ended here (it moved to a new lineage) is joined afresh.
  const [generation, setGeneration] = useState(0);
  const joined = useRef<{ wake: () => void } | null>(null);
  useEffect(() => {
    if (wake) joined.current?.wake();
  }, [wake]);
  useEffect(() => {
    if (!enabled) return;
    // A read channel (REVIEW5 N2), left while the tab is hidden (N5).
    return whileVisible(() => {
      let cancelled = false;
      let close: (() => void) | undefined;
      void Promise.all([
        import('@/features/collaboration/itemRoom'),
        import('./liveSet'),
      ]).then(([{ ItemRoom }, { readCards, setScope }]) => {
        if (cancelled) return;
        const room = new ItemRoom(setId, {
          inside,
          onReplace: () => setGeneration((value) => value + 1),
          read: true,
        });
        joined.current = room;
        const update = () => {
          if (room.getSnapshot().synced) setLive(readCards(room.doc));
        };
        room.subscribe(update);
        setScope(room.doc).observeDeep(update);
        void room.start();
        close = () => {
          if (joined.current === room) joined.current = null;
          room.destroy();
        };
      });
      return () => {
        cancelled = true;
        close?.();
      };
    });
  }, [setId, enabled, inside, generation]);
  return live ?? stored;
}

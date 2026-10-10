import { useEffect, useState } from 'react';
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
  enabled = true
): FlashcardContent[] {
  const [live, setLive] = useState<FlashcardContent[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let close: (() => void) | undefined;
    void Promise.all([
      import('@/features/collaboration/itemRoom'),
      import('./liveSet'),
    ]).then(([{ ItemRoom }, { readCards, setScope }]) => {
      if (cancelled) return;
      const room = new ItemRoom(setId);
      const update = () => {
        if (room.getSnapshot().synced) setLive(readCards(room.doc));
      };
      room.subscribe(update);
      setScope(room.doc).observeDeep(update);
      void room.start();
      close = () => room.destroy();
    });
    return () => {
      cancelled = true;
      close?.();
    };
  }, [setId, enabled]);
  return live ?? stored;
}

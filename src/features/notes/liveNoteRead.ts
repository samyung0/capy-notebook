import * as Y from 'yjs';
import { ItemRoom } from '@/features/collaboration/itemRoom';
import type { MaterialValue } from '@/features/materials/document';
import { NoteBlocks } from './liveNoteBlocks';

/**
 * A note's View following its room (live-items DESIGN.md 3, Epo 2026-10-10),
 * loaded only once a signed-in reader's View painted the projection. It joins
 * the note room on the tab's collaboration socket with the token the API
 * gives (a viewer's is read-only: the server closes a read channel that
 * writes and sends it no presence; nothing here writes). Once the room syncs,
 * `onValue` gets its value handed over from `painted`, then, after each
 * remote change, the value with only the touched blocks read again. A room
 * that ends here (moved to a new lineage, reset) is joined afresh; one this
 * user cannot read leaves the painted projection as it is. Returns the leave.
 */
export function readNoteLive(
  materialId: string,
  painted: MaterialValue,
  onValue: (value: MaterialValue) => void
): () => void {
  let left = false;
  let leave: () => void = () => undefined;
  const join = () => {
    if (left) return;
    const room = new ItemRoom(materialId, {
      onReplace: () => {
        leave();
        join();
      },
    });
    const root = room.doc.get('content', Y.XmlText);
    const blocks = new NoteBlocks(root);
    let synced = false;
    const observe = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
      if (synced && blocks.apply(events)) onValue(blocks.value);
    };
    root.observeDeep(observe);
    const unsubscribe = room.subscribe(() => {
      if (synced || !room.getSnapshot().synced) return;
      synced = true;
      onValue(blocks.handOver(painted));
    });
    leave = () => {
      unsubscribe();
      root.unobserveDeep(observe);
      room.destroy();
    };
    void room.start();
  };
  join();
  return () => {
    left = true;
    leave();
  };
}

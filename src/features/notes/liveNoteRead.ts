import * as Y from 'yjs';
import { ItemRoom } from '@/features/collaboration/itemRoom';
import type { NoteSeat } from '@/features/collaboration/noteSeat';
import { whileVisible } from '@/features/collaboration/whileVisible';
import type { MaterialValue } from '@/features/materials/document';
import { NoteBlocks } from './liveNoteBlocks';

/**
 * A note's View following its room (live-items DESIGN.md 3, Epo 2026-10-10),
 * loaded only once a signed-in reader's View painted the projection. It joins
 * the note room on the tab's collaboration socket on a read channel, whoever
 * the user is (REVIEW5 N2: the server closes a read channel that writes and
 * sends it no presence; nothing here writes). Once the room syncs, `onValue`
 * gets its value handed over from what the View shows, then, after each
 * remote change, the value with only the touched blocks read again. A room
 * that ends here (moved to a new lineage, reset, closed for writing) is joined
 * afresh; one this user cannot read leaves the View as it is. A tab hidden
 * for 5 minutes leaves the room and joins again when it shows (REVIEW5 N5).
 * Its channel is `seat`, inside which the note's embeds join (Epo
 * 2026-10-20). Returns the leave.
 */
export function readNoteLive(
  materialId: string,
  painted: MaterialValue,
  onValue: (value: MaterialValue) => void,
  seat?: NoteSeat
): () => void {
  let shown = painted;
  const show = (value: MaterialValue) => {
    shown = value;
    onValue(value);
  };
  return whileVisible(() => follow(materialId, () => shown, show, seat));
}

/** Follows the room until left, joining afresh each time it ends here. */
function follow(
  materialId: string,
  shown: () => MaterialValue,
  show: (value: MaterialValue) => void,
  seat: NoteSeat | undefined
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
      read: true,
      seat,
    });
    const root = room.doc.get('content', Y.XmlText);
    const blocks = new NoteBlocks(root);
    let synced = false;
    const observe = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
      if (synced && blocks.apply(events)) show(blocks.value);
    };
    root.observeDeep(observe);
    const unsubscribe = room.subscribe(() => {
      if (synced || !room.getSnapshot().synced) return;
      synced = true;
      show(blocks.handOver(shown()));
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

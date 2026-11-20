/* Items whose open room refused this person for access (Epo 2026-11-20):
 * when the page's read then refuses them too, the unavailable page says they
 * lost access (`useAccessLostNotice`), never for an item simply opened
 * unavailable. Only an item a page watches is marked: an embed's, a study
 * view's or a card's room refusing marks nothing. Rooms import this, so it
 * imports nothing. */

const watched = new Map<string, number>();
const refused = new Set<string>();

const refusalKey = (file: boolean, id: string) =>
  `${file ? 'file' : 'material'}:${id}`;

/** A page shows this item and says when it is kicked from it: rooms'
 * refusals of it are marked until the release, which drops the mark. */
export function watchRoomRefusals(file: boolean, id: string) {
  const key = refusalKey(file, id);
  watched.set(key, (watched.get(key) ?? 0) + 1);
  return () => {
    const left = (watched.get(key) ?? 1) - 1;
    if (left) {
      watched.set(key, left);
      return;
    }
    watched.delete(key);
    refused.delete(key);
  };
}

/** A room that had joined refused this person (not found, forbidden, an
 * access change): the item's read decides what its page shows. */
export function markRoomRefusal(file: boolean, id: string) {
  const key = refusalKey(file, id);
  if (watched.has(key)) refused.add(key);
}

/** Whether a room refused this person since the mark was last taken; the
 * mark goes. */
export function takeRoomRefusal(file: boolean, id: string) {
  return refused.delete(refusalKey(file, id));
}

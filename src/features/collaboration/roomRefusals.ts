/* Items that worked on the page showing them (Epo 2026-11-20): a room of the
 * item synced, or the page's read answered. When the page's read then refuses
 * the person, whether a room refused them first or not, the unavailable page
 * says they lost access (`useAccessLostNotice`); an item simply opened
 * unavailable never worked there. Only an item a page watches is marked, and
 * the mark lasts while it does, past a room replaced meanwhile (a tab hidden
 * for 5 minutes, a moved room): an embed's, a study view's or a card's room
 * marks nothing. Rooms import this, so it imports nothing. */

const watched = new Map<string, number>();
const working = new Set<string>();

const itemKey = (file: boolean, id: string) =>
  `${file ? 'file' : 'material'}:${id}`;

/** A page shows this item and says when it is kicked from it: the item's
 * mark lasts until the release, which drops it. */
export function watchItem(file: boolean, id: string) {
  const key = itemKey(file, id);
  watched.set(key, (watched.get(key) ?? 0) + 1);
  return () => {
    const left = (watched.get(key) ?? 1) - 1;
    if (left) {
      watched.set(key, left);
      return;
    }
    watched.delete(key);
    working.delete(key);
  };
}

/** A room of the item synced with the service, or the page's read answered. */
export function markItemWorking(file: boolean, id: string) {
  const key = itemKey(file, id);
  if (watched.has(key)) working.add(key);
}

/** Whether the item worked on its page since the mark was last taken; the
 * mark goes. */
export function takeItemWorking(file: boolean, id: string) {
  return working.delete(itemKey(file, id));
}

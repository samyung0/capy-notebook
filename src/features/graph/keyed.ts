/* A list held one entry per item id (Epo 2026-11-16, D9/D10): each value one
 * plain item with an order key, so two editors changing different items both
 * keep their work when the entries merge key by key. A graph's elements, in
 * quiz rooms, note figures and the canvas plane, and a canvas chart's bars,
 * pie labels and pie lines (Epo 2026-11-22) are held so. Reading sorts by
 * order key and breaks a tie (two editors adding at once) by id. A Y.Map fits
 * `EntryMap`, so this module needs no Yjs. */
import { keyBetween, risingOrders } from '@/lib/orderKey';
import { sameJson } from '@/lib/sameJson';

/** What a keyed list holds: anything with an id. */
export type Keyed = { id: string };

export type ElementEntry<E extends Keyed = Keyed> = {
  element: E;
  order: string;
};

/** The keyed map a writer takes: a Y.Map, or a plain Map in tests. */
export type EntryMap<E extends Keyed> = {
  delete(key: string): void;
  entries(): IterableIterator<[string, unknown]>;
  set(key: string, value: ElementEntry<E>): unknown;
};

/** Whether a held value is an entry for `id` (a malformed one reads as
 * missing). */
export const isElementEntry = (
  value: unknown,
  id: string
): value is ElementEntry =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as ElementEntry).order === 'string' &&
  typeof (value as ElementEntry).element === 'object' &&
  (value as ElementEntry).element?.id === id;

const before = (a: [string, ElementEntry], b: [string, ElementEntry]) =>
  a[1].order < b[1].order
    ? -1
    : a[1].order > b[1].order
      ? 1
      : a[0] < b[0]
        ? -1
        : 1;

/** The items in order. Each is the stored value itself, so an unchanged one
 * stays the same object from one read to the next. */
export function readElements<E extends Keyed>(
  entries: Iterable<[string, ElementEntry<E>]>
): E[] {
  return [...entries].sort(before).map(([, entry]) => entry.element);
}

/** Entries for a list, in its order: a new list's first value. */
export function keyedElements<E extends Keyed>(list: E[]) {
  let order: string | null = null;
  const out: Record<string, ElementEntry<E>> = {};
  for (const element of list) {
    order = keyBetween(order, null);
    out[element.id] = { element, order };
  }
  return out;
}

/** Makes `map` hold `next`, in its order, touching only what changed (Epo
 * 2026-11-16, D10: the one writer of every keyed list). An item alike its
 * stored one, the same object or equal JSON (a note's Slate value hands fresh
 * objects), keeps its stored object; a changed one is replaced; order keys
 * come from `risingOrders`, so every held key that can stay does (ties
 * compared by id, as readers sort: a tie two editors' adds left stays, since
 * re-keying would rewrite the whole entry over a peer's edit) and a moved or
 * new item takes a key between its neighbours (one between tied neighbours
 * re-keys the later tied neighbours); a gone one is deleted, of those in
 * `seen` alone when given (the ones the writer's copy was read from: an entry
 * it never saw stays, Epo 2026-11-22). Each entry is written at most once. */
export function writeElements<E extends Keyed>(
  map: EntryMap<E>,
  next: E[],
  seen?: ReadonlySet<string>
) {
  const held = [...map.entries()];
  const stored = new Map<string, ElementEntry<E>>();
  for (const [id, value] of held)
    if (isElementEntry(value, id)) stored.set(id, value as ElementEntry<E>);
  const orders = risingOrders(
    next.map(({ id }) => ({ id, order: stored.get(id)?.order ?? '' }))
  );
  next.forEach((element, i) => {
    const entry = stored.get(element.id);
    const same =
      entry !== undefined &&
      (entry.element === element || sameJson(entry.element, element));
    if (same && entry.order === orders[i]) return;
    map.set(element.id, {
      element: same ? entry.element : element,
      order: orders[i],
    });
  });
  const kept = new Set(next.map((element) => element.id));
  for (const [id] of held)
    if (!(kept.has(id) || (seen && !seen.has(id)))) map.delete(id);
}

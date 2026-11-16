/* A graph's elements held one entry per element id (Epo 2026-11-16, D9/D10):
 * each value one plain element with an order key, so two editors changing
 * different elements both keep their work when the entries merge key by key.
 * Reading sorts by order key and breaks a tie (two editors adding at once) by
 * id. A Y.Map fits `EntryMap`, so this module needs no Yjs. */
import { keyBetween, risingOrders } from '@/lib/orderKey';
import { sameJson } from '@/lib/sameJson';
import type { GraphElement } from './model';

export type ElementEntry<E extends GraphElement = GraphElement> = {
  element: E;
  order: string;
};

/** The keyed map a writer takes: a Y.Map, or a plain Map in tests. */
export type EntryMap<E extends GraphElement> = {
  delete(key: string): void;
  entries(): IterableIterator<[string, unknown]>;
  set(key: string, value: ElementEntry<E>): unknown;
};

/** Whether a held value is an element entry for `id` (a malformed one reads
 * as missing). */
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

/** The elements in order. Each is the stored value itself, so an unchanged one
 * stays the same object from one read to the next. */
export function readElements<E extends GraphElement>(
  entries: Iterable<[string, ElementEntry<E>]>
): E[] {
  return [...entries].sort(before).map(([, entry]) => entry.element);
}

/** Entries for a list, in its order: a new graph's first value. */
export function keyedElements<E extends GraphElement>(list: E[]) {
  let order: string | null = null;
  const out: Record<string, ElementEntry<E>> = {};
  for (const element of list) {
    order = keyBetween(order, null);
    out[element.id] = { element, order };
  }
  return out;
}

/** Makes `map` hold `next`, in its order, touching only what changed (Epo
 * 2026-11-16, D10: the plane's, a quiz's and a note's one writer). An element
 * alike its stored one, the same object or equal JSON (a note's Slate value
 * hands fresh objects), keeps its stored object; a changed one is replaced;
 * order keys come from `risingOrders`, so every held key that can stay does
 * and a moved or new element takes a key between its neighbours; a gone one
 * is deleted. Each entry is written at most once. */
export function writeElements<E extends GraphElement>(
  map: EntryMap<E>,
  next: E[]
) {
  const held = [...map.entries()];
  const stored = new Map<string, ElementEntry<E>>();
  for (const [id, value] of held)
    if (isElementEntry(value, id)) stored.set(id, value as ElementEntry<E>);
  const orders = risingOrders(
    next.map((element) => stored.get(element.id)?.order ?? '')
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
  for (const [id] of held) if (!kept.has(id)) map.delete(id);
}

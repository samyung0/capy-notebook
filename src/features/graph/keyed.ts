/* A graph's elements held one entry per element id (Epo 2026-11-16, D9/D10):
 * each value one plain element with an order key, so two editors changing
 * different elements both keep their work when the entries merge key by key.
 * Reading sorts by order key and breaks a tie (two editors adding at once) by
 * id. A Y.Map fits `EntryMap`, so this module needs no Yjs. */
import { keyBetween } from '@/lib/orderKey';
import type { GraphElement } from './model';

export type ElementEntry<E extends GraphElement = GraphElement> = {
  element: E;
  order: string;
};

/** The writes a keyed map takes: a Y.Map, or a plain Map in tests. */
export type EntryMap<E extends GraphElement> = {
  delete(key: string): void;
  entries(): IterableIterator<[string, ElementEntry<E>]>;
  set(key: string, value: ElementEntry<E>): unknown;
};

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

/** Makes `map` hold `next`, touching only what changed: a new element is set
 * after every other, a changed one (a different object) replaced under its own
 * order key, a gone one deleted. Order among kept elements stays as stored. */
export function writeElements<E extends GraphElement>(
  map: EntryMap<E>,
  next: E[]
) {
  const stored = new Map(map.entries());
  let last: string | null = null;
  for (const { order } of stored.values())
    if (last === null || order > last) last = order;
  const kept = new Set<string>();
  for (const element of next) {
    kept.add(element.id);
    const entry = stored.get(element.id);
    if (entry?.element === element) continue;
    if (entry) {
      map.set(element.id, { element, order: entry.order });
      continue;
    }
    last = keyBetween(last, null);
    map.set(element.id, { element, order: last });
  }
  for (const id of stored.keys()) if (!kept.has(id)) map.delete(id);
}

import * as Y from 'yjs';
import { uid } from '@/lib/id';
import { risingOrders } from '@/lib/orderKey';
import { alignPlaces } from './align';

/* The Y.Map helpers live documents are read and written with (a quiz's
 * documents, figure maps in quiz and note rooms): entries held under ids with
 * an order key, a table's or chart's axes (id -> order key), plain values
 * written only when they differ. */

export type YMap = Y.Map<unknown>;
export type Entry = { entry: YMap; id: string; order: string };

const byOrder = (a: Entry, b: Entry) =>
  a.order < b.order
    ? -1
    : a.order > b.order
      ? 1
      : a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0;

export function mapAt(parent: YMap | undefined, key: string): YMap | undefined {
  const value = parent?.get(key);
  return value instanceof Y.Map ? (value as YMap) : undefined;
}

/** A map's entries that are maps, in `(order, id)` order. */
export function ordered(map: YMap | undefined): Entry[] {
  const out: Entry[] = [];
  map?.forEach((value, id) => {
    if (!(value instanceof Y.Map)) return;
    const order = value.get('order');
    out.push({
      entry: value as YMap,
      id,
      order: typeof order === 'string' ? order : '',
    });
  });
  return out.sort(byOrder);
}

/** A table's rows or columns, a chart's series or labels (id -> order key),
 * in order. */
export function orderedKeys(map: YMap | undefined): string[] {
  const out: { id: string; order: string }[] = [];
  map?.forEach((value, id) => {
    out.push({ id, order: typeof value === 'string' ? value : '' });
  });
  return out
    .sort((a, b) =>
      a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : 1
    )
    .map((row) => row.id);
}

export const plain = <T>(map: YMap | undefined, key: string) =>
  map?.get(key) as T | undefined;

/** Two plain (JSON) values alike, whatever their keys' order. */
export function samePlain(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((item, i) => samePlain(item, b[i]));
  const left = Object.entries(a).filter(([, value]) => value !== undefined);
  const right = b as Record<string, unknown>;
  return (
    left.length ===
      Object.values(right).filter((value) => value !== undefined).length &&
    left.every(([key, value]) => samePlain(value, right[key]))
  );
}

/** Sets a plain value (undefined removes it), writing only a change. */
export function setPlain(map: YMap, key: string, value: unknown) {
  if (value === undefined) {
    if (map.has(key)) map.delete(key);
    return;
  }
  if (!map.has(key) || !samePlain(map.get(key), value)) map.set(key, value);
}

/** The map at `key`, created when missing. */
export function child(map: YMap, key: string): YMap {
  const found = mapAt(map, key);
  if (found) return found;
  const created = new Y.Map<unknown>();
  map.set(key, created);
  return created;
}

/** Reorders `entries` (current order) so they read as `ids` ([risingOrders]). */
export function reorder(entries: Map<string, YMap>, ids: string[]) {
  const held = ids.map((id) => plain<string>(entries.get(id), 'order') ?? '');
  risingOrders(held).forEach((order, i) => {
    if (order !== held[i]) entries.get(ids[i])?.set('order', order);
  });
}

/** An axis (id -> order key: a table's rows or columns, a chart's series or
 * labels) brought to `count` entries as one editor action leaves it, aligned
 * by `alignPlaces`: the ids it drops go (`drop` clears what they held), new
 * ones come in between their neighbours. The ids, in order. */
export function alignAxis(
  map: YMap,
  count: number,
  same: (held: number, wanted: number) => boolean,
  prefix: string,
  drop: (id: string) => void
): string[] {
  const ids = orderedKeys(map);
  if (ids.length === count) return ids;
  const places = alignPlaces(ids.length, count, same);
  const kept = new Set(places);
  ids.forEach((id, i) => {
    if (kept.has(i)) return;
    map.delete(id);
    drop(id);
  });
  const next = places.map((at) => (at < 0 ? uid(prefix) : ids[at]));
  const held = places.map((at) =>
    at < 0 ? '' : ((map.get(ids[at]) as string | undefined) ?? '')
  );
  risingOrders(held).forEach((order, i) => {
    if (order !== held[i]) map.set(next[i], order);
  });
  return next;
}

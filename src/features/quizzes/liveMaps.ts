import * as Y from 'yjs';
import { applyTextChange } from '@/features/collaboration/yText';
import { uid } from '@/lib/id';
import { keyBetween } from '@/lib/orderKey';

/* The map helpers a quiz's live documents are read and written with
 * (liveQuiz.ts, liveFigures.ts): entries held under ids with an order key,
 * a table's or chart's axes (id -> order key), plain values written only when
 * they differ. */

export const QUESTIONS_ROOT = 'questions';
export const KEYS_ROOT = 'keys';

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

export function text(map: YMap | undefined, key: string): string {
  const value = map?.get(key);
  return value instanceof Y.Text ? value.toString() : '';
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

export function setText(map: YMap, key: string, value: string) {
  const current = map.get(key);
  if (current instanceof Y.Text) applyTextChange(current, value, null);
  else map.set(key, new Y.Text(value));
}

/** Order keys for `count` new entries between two existing ones. */
export function keysBetween(
  after: string | null,
  before: string | null,
  count: number
) {
  const out: string[] = [];
  let last = after;
  for (let i = 0; i < count; i++) {
    // Past the last key a key after `last` suffices; otherwise squeeze in.
    last = before === null ? keyBetween(last, null) : keyBetween(last, before);
    out.push(last);
  }
  return out;
}

/** Order keys that read in the given order ('' for an entry with none yet):
 * keys already in a rising run stay, the others get new keys between their
 * neighbours. */
export function risingOrders(held: string[]): string[] {
  const orders = [...held];
  for (let i = 0; i < orders.length; i++) {
    const previous = i > 0 ? orders[i - 1] : null;
    if (previous === null ? orders[i] !== '' : orders[i] > previous) {
      // Keep it if it also stays below the next kept key.
      const next = orders.slice(i + 1).find((order) => order > orders[i]);
      if (next !== undefined || i === orders.length - 1) continue;
    }
    const upper = orders.slice(i + 1).find((order) => order > (previous ?? ''));
    orders[i] = keyBetween(previous, upper ?? null);
  }
  return orders;
}

/** Reorders `entries` (current order) so they read as `ids` ([risingOrders]). */
export function reorder(entries: Map<string, YMap>, ids: string[]) {
  const held = ids.map((id) => plain<string>(entries.get(id), 'order') ?? '');
  risingOrders(held).forEach((order, i) => {
    if (order !== held[i]) entries.get(ids[i])?.set('order', order);
  });
}

/** An axis (id -> order key: a table's rows or columns, a chart's series or
 * labels) brought to `count` entries as one editor action leaves it: entries
 * alike at the head and tail (`same(heldIndex, wantedIndex)`) keep their ids,
 * a changed middle keeps as many ids as it can by position, and the rest go
 * (`drop` clears what they held) or come in between their neighbours. With
 * the count unchanged every id keeps its place. The ids, in order. */
export function alignAxis(
  map: YMap,
  count: number,
  same: (held: number, wanted: number) => boolean,
  prefix: string,
  drop: (id: string) => void
): string[] {
  const ids = orderedKeys(map);
  if (ids.length === count) return ids;
  let head = 0;
  while (head < ids.length && head < count && same(head, head)) head++;
  let tail = 0;
  while (
    tail < ids.length - head &&
    tail < count - head &&
    same(ids.length - 1 - tail, count - 1 - tail)
  )
    tail++;
  const removed = ids.slice(head, ids.length - tail);
  const keep = Math.min(removed.length, count - head - tail);
  for (const id of removed.slice(keep)) {
    map.delete(id);
    drop(id);
  }
  const orderOf = (id: string | undefined) =>
    id === undefined ? null : ((map.get(id) as string | undefined) ?? null);
  const after = orderOf(ids[head + keep - 1]);
  const before = tail > 0 ? orderOf(ids.at(-tail)) : null;
  for (const order of keysBetween(after, before, count - head - tail - keep))
    map.set(uid(prefix), order);
  return orderedKeys(map);
}

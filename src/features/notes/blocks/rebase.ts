import { sameJson } from '@/lib/sameJson';

type Fields = Record<string, unknown>;

const isRecord = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** One entry of a list: the user's change since `base` wins, else the peer's
 * value, absent (`undefined`) included. */
const pick = (base: unknown, draft: unknown, peer: unknown) =>
  sameJson(draft, base) ? peer : draft;

function fields(
  base: Fields,
  draft: Fields,
  peer: Fields,
  lists: readonly string[]
): Fields {
  const out: Fields = {};
  const keys = new Set([
    ...Object.keys(peer),
    ...Object.keys(draft),
    ...Object.keys(base),
  ]);
  for (const key of keys) {
    const [b, d, p] = [base[key], draft[key], peer[key]];
    const value =
      lists.includes(key) &&
      Array.isArray(b) &&
      Array.isArray(d) &&
      Array.isArray(p)
        ? list(b, d, p)
        : pick(b, d, p);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** An entry present in all three merges field by field (a chart series'
 * values cell by cell); one the user added, changed or deleted keeps the
 * user's say, one only the peer touched follows the peer. */
function entry(base: unknown, draft: unknown, peer: unknown): unknown {
  if (isRecord(base) && isRecord(draft) && isRecord(peer))
    return fields(base, draft, peer, ['values']);
  return pick(base, draft, peer);
}

function list(base: unknown[], draft: unknown[], peer: unknown[]): unknown[] {
  const idOf = (item: unknown) =>
    isRecord(item) && typeof item.id === 'string' ? item.id : undefined;
  const all = [...base, ...draft, ...peer];
  if (!all.every((item) => idOf(item) !== undefined)) {
    // By index: series, labels, a series' values.
    const out: unknown[] = [];
    for (let i = 0; i < Math.max(draft.length, peer.length); i++) {
      const value = entry(base[i], draft[i], peer[i]);
      if (value !== undefined) out.push(value);
    }
    return out;
  }
  // By id: graph elements, in the peer's order with the user's additions
  // after the entry they follow in the draft.
  const byId = (items: unknown[]) =>
    new Map(items.map((item) => [idOf(item) as string, item]));
  const [b, d] = [byId(base), byId(draft)];
  const out = peer.flatMap((item) => {
    const id = idOf(item) as string;
    const value = entry(b.get(id), d.get(id), item);
    return value === undefined ? [] : [value];
  });
  const placed = new Set(out.map(idOf));
  draft.forEach((item, at) => {
    const id = idOf(item) as string;
    if (placed.has(id)) return;
    const value = entry(b.get(id), item, undefined);
    if (value === undefined) return;
    const before = draft
      .slice(0, at)
      .reverse()
      .map(idOf)
      .find((other) => placed.has(other));
    const index = before ? out.findIndex((x) => idOf(x) === before) + 1 : 0;
    out.splice(index, 0, value);
    placed.add(id);
  });
  return out;
}

/** The lists a figure's draft follows entry by entry, as its room merges
 * them (figures/figureMap.ts): a graph's elements by id, a chart's series and
 * labels by index; a plot's series by index too, finer than its room, which
 * holds them as one value. */
const LISTS: Record<string, readonly string[]> = {
  chart: ['series', 'labels'],
  graph: ['elements'],
  plot: ['series'],
};

/**
 * A figure dialog's draft on a peer's newer block (Epo 2026-10-17): what the
 * user changed since `base` keeps the user's value, the rest follows `peer`.
 * Fields are the block's keys, a graph's board field by field; its lists go
 * entry by entry, each entry's fields on their own, so Save writes the
 * figure's map only where the user changed it.
 */
export function rebaseBlock<T extends { type: string }>(
  base: T,
  draft: T,
  peer: T
): T {
  const merged = fields(
    base as unknown as Fields,
    draft as unknown as Fields,
    peer as unknown as Fields,
    LISTS[peer.type] ?? []
  );
  const [b, d, p] = [base, draft, peer].map(
    (block) => (block as unknown as Fields).board
  );
  if (isRecord(b) && isRecord(d) && isRecord(p))
    merged.board = fields(b, d, p, []);
  return merged as unknown as T;
}

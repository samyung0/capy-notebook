import * as Y from 'yjs';

/**
 * Target guards for direct AI edits and their Undo.
 *
 * A guard is the Yjs item-run signature of a region: the (client, clock)
 * identities of every item in the region, including deleted items and format
 * items, with one character of each neighbour so an insert-then-delete inside
 * a gap still shows as new (tombstoned) runs. Two states with equal values but
 * different histories therefore produce different guards, which is what lets
 * Undo refuse a target that was written and reverted in between. Compaction or
 * a source rebase creates fresh item identities, so old guards stop matching by
 * construction.
 */
export interface GuardRun {
  client: number;
  clock: number;
  deleted?: true;
  format?: true;
  len: number;
  nested?: GuardRun[];
}

type YType = Y.AbstractType<any>;

function typeOf(item: Y.Item): YType | null {
  const content = item.content as { type?: YType };
  return content instanceof Y.ContentType ? (content.type as YType) : null;
}

/**
 * Item runs of one shared type, clipped to [start, end) plus `pad` neighbour
 * units on each side. Gaps need a neighbour to be observable at all; a present
 * target is guarded on its own so edits beside it keep its Undo valid.
 */
export function rangeGuard(
  type: YType,
  start: number,
  end: number,
  pad = 1
): GuardRun[] {
  const low = start - pad;
  const from = Math.max(0, low);
  const to = end + pad;
  const runs: GuardRun[] = [];
  let index = 0;
  for (let item = type._start; item !== null; item = item.right) {
    if (item.deleted || !item.countable) {
      // Tombstones sit between countable units; only those strictly inside
      // the window count, so a gap sees its own tombstones and nothing beyond
      // its neighbours, and an unpadded target owns none.
      if (index > low && index < to) {
        runs.push({
          client: item.id.client,
          clock: item.id.clock,
          len: item.length,
          ...(item.deleted
            ? { deleted: true as const }
            : { format: true as const }),
        });
      }
      continue;
    }
    const itemStart = index;
    const itemEnd = index + item.length;
    index = itemEnd;
    if (itemEnd <= from) continue;
    if (itemStart >= to) break;
    const clipFrom = Math.max(from, itemStart) - itemStart;
    const clipTo = Math.min(to, itemEnd) - itemStart;
    const run: GuardRun = {
      client: item.id.client,
      clock: item.id.clock + clipFrom,
      len: clipTo - clipFrom,
    };
    // Padding neighbours count by identity only; their content is not ours.
    const nested = itemStart >= start && itemStart < end ? typeOf(item) : null;
    if (nested) run.nested = fullGuard(nested);
    runs.push(run);
  }
  return normalize(runs);
}

/** Item runs of a whole shared type, recursing into embedded types. */
export function fullGuard(type: YType): GuardRun[] {
  const runs: GuardRun[] = [];
  for (let item = type._start; item !== null; item = item.right) {
    const run: GuardRun = {
      client: item.id.client,
      clock: item.id.clock,
      len: item.length,
    };
    if (item.deleted) run.deleted = true;
    else if (item.countable) {
      const nested = typeOf(item);
      if (nested) run.nested = fullGuard(nested);
    } else run.format = true;
    runs.push(run);
  }
  return normalize(runs);
}

/**
 * Yjs merges adjacent items of one client lazily, so two identical documents
 * can differ in how their runs are split. Merging contiguous plain runs makes
 * the signature independent of that split.
 */
function normalize(runs: GuardRun[]): GuardRun[] {
  const out: GuardRun[] = [];
  for (const run of runs) {
    const last = out.at(-1);
    if (
      last &&
      !last.nested &&
      !run.nested &&
      last.client === run.client &&
      last.clock + last.len === run.clock &&
      !!last.deleted === !!run.deleted &&
      !!last.format === !!run.format
    ) {
      last.len += run.len;
      continue;
    }
    out.push({ ...run });
  }
  return out;
}

export function guardsEqual(a: GuardRun[], b: GuardRun[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.client !== y.client ||
      x.clock !== y.clock ||
      x.len !== y.len ||
      !!x.deleted !== !!y.deleted ||
      !!x.format !== !!y.format ||
      !!x.nested !== !!y.nested
    )
      return false;
    if (x.nested && y.nested && !guardsEqual(x.nested, y.nested)) return false;
  }
  return true;
}

export function isGuardRuns(value: unknown): value is GuardRun[] {
  return (
    Array.isArray(value) &&
    value.every(
      (run) =>
        run &&
        typeof run === 'object' &&
        typeof (run as GuardRun).client === 'number' &&
        typeof (run as GuardRun).clock === 'number' &&
        typeof (run as GuardRun).len === 'number' &&
        ((run as GuardRun).nested === undefined ||
          isGuardRuns((run as GuardRun).nested))
    )
  );
}

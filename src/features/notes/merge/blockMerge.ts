import type { MaterialElement } from '@/features/materials/document';

/**
 * The three-way merge of a note by top-level block id (Q229, Epo
 * 2026-10-24): `base` is what the user's copy started from, `mine` the copy
 * as the user left it, `theirs` the room's document now. A block is one
 * top-level element with everything nested in it, so an edit anywhere inside
 * (a list item in a column, a table cell) changes that block.
 *
 * - A block only the user changed (edited, inserted, deleted, moved) becomes
 *   a step on `theirs`; inserts and moves go after the block before them in
 *   `mine` that the result holds, else at the start.
 * - A block only the room changed, or neither, stays as `theirs` has it.
 * - A block both changed differently is a conflict, left out of the steps
 *   (`theirs` keeps it): edited on both sides, edited by one and deleted by
 *   the other. Both moving it keeps the room's place.
 * - A block without an id is matched by content: one `base` holds an equal
 *   block of is unchanged, any other is inserted under a new id; its
 *   deletion cannot be placed and is dropped.
 *
 * Pure: the merge view reuses it. Applying the steps (applyBlocks.ts) reads
 * `theirs` again by id, so they apply to the document as it is then.
 */

export type MergeStep =
  /** Put the user's version in place of the block. */
  | { block: MaterialElement; id: string; kind: 'set' }
  | { id: string; kind: 'remove' }
  /** `after`: the block it follows, null for the start of the note. */
  | { after: string | null; block: MaterialElement; kind: 'insert' }
  | { after: string | null; id: string; kind: 'move' };

export interface BlockConflict {
  /** The block before it in the user's version: where it would go. */
  after: string | null;
  base: MaterialElement | null;
  id: string;
  /** The user's version; null when the user deleted it. */
  mine: MaterialElement | null;
  /** The room's version; null when the room deleted it. */
  theirs: MaterialElement | null;
}

/** Whether two plain JSON values are equal, whatever their key order; a key
 * holding `undefined` counts as absent. */
export function sameBlock(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (
    typeof left !== 'object' ||
    typeof right !== 'object' ||
    left === null ||
    right === null
  )
    return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!(Array.isArray(left) && Array.isArray(right))) return false;
    return (
      left.length === right.length &&
      left.every((item, index) => sameBlock(item, right[index]))
    );
  }
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a).filter((key) => a[key] !== undefined);
  return (
    keys.length ===
      Object.keys(b).filter((key) => b[key] !== undefined).length &&
    keys.every((key) => sameBlock(a[key], b[key]))
  );
}

const idOf = (block: MaterialElement) =>
  typeof block.id === 'string' ? block.id : undefined;

function byId(blocks: MaterialElement[]) {
  const found = new Map<string, MaterialElement>();
  for (const block of blocks) {
    const id = idOf(block);
    if (id !== undefined) found.set(id, block);
  }
  return found;
}

/** Ids of `blocks` whose order differs from `base`'s: those outside a
 * longest run of shared blocks in base order (patience sort). */
function moved(base: MaterialElement[], blocks: MaterialElement[]) {
  const at = new Map<string, number>();
  base.forEach((block, index) => {
    const id = idOf(block);
    if (id !== undefined) at.set(id, index);
  });
  const shared: { id: string; index: number }[] = [];
  for (const block of blocks) {
    const id = idOf(block);
    const index = id === undefined ? undefined : at.get(id);
    if (id !== undefined && index !== undefined) shared.push({ id, index });
  }
  // tails[k]: the position in `shared` ending the best run of length k + 1.
  const tails: number[] = [];
  const previous = new Array<number>(shared.length).fill(-1);
  shared.forEach(({ index }, position) => {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (shared[tails[middle]].index < index) low = middle + 1;
      else high = middle;
    }
    if (low > 0) previous[position] = tails[low - 1];
    tails[low] = position;
  });
  const kept = new Set<number>();
  for (let at = tails.at(-1) ?? -1; at >= 0; at = previous[at]) kept.add(at);
  return new Set(
    shared.filter((_, position) => !kept.has(position)).map(({ id }) => id)
  );
}

export function mergeBlocks(
  base: MaterialElement[],
  mine: MaterialElement[],
  theirs: MaterialElement[],
  newId: () => string = () => crypto.randomUUID()
): { conflicts: BlockConflict[]; steps: MergeStep[] } {
  const baseById = byId(base);
  const mineById = byId(mine);
  const theirsById = byId(theirs);
  const content: MergeStep[] = [];
  const conflicts: BlockConflict[] = [];
  const inserts = new Set<string>();
  const removed = new Set<string>();
  const conflicting = new Set<string>();
  // The block before each of the user's, for a conflict's place.
  const before = new Map<string, string | null>();
  let last: string | null = null;
  for (const block of mine) {
    const id = idOf(block);
    if (id === undefined) continue;
    before.set(id, last);
    last = id;
  }

  for (const id of new Set([...baseById.keys(), ...mineById.keys()])) {
    const was = baseById.get(id);
    const ours = mineById.get(id);
    const now = theirsById.get(id);
    if (sameBlock(was, ours)) continue;
    if (sameBlock(was, now)) {
      if (!ours) {
        content.push({ id, kind: 'remove' });
        removed.add(id);
      } else if (was) content.push({ block: ours, id, kind: 'set' });
      else inserts.add(id);
      continue;
    }
    if (sameBlock(ours, now)) continue;
    conflicting.add(id);
    conflicts.push({
      after: before.get(id) ?? null,
      base: was ?? null,
      id,
      mine: ours ?? null,
      theirs: now ?? null,
    });
  }

  // Inserts and moves, in the user's order.
  const ourMoves = moved(base, mine);
  const theirMoves = moved(base, theirs);
  const unmatched = base.filter((block) => idOf(block) === undefined);
  const order: MergeStep[] = [];
  let after: string | null = null;
  for (const block of mine) {
    const id = idOf(block);
    if (id === undefined) {
      const equal = unmatched.findIndex((other) => sameBlock(other, block));
      if (equal >= 0) {
        unmatched.splice(equal, 1);
        continue;
      }
      const fresh = newId();
      order.push({ after, block: { ...block, id: fresh }, kind: 'insert' });
      after = fresh;
      continue;
    }
    if (inserts.has(id)) {
      order.push({ after, block, kind: 'insert' });
      after = id;
      continue;
    }
    if (!theirsById.has(id) || removed.has(id)) continue;
    if (ourMoves.has(id) && !theirMoves.has(id) && !conflicting.has(id))
      order.push({ after, id, kind: 'move' });
    after = id;
  }
  return { conflicts, steps: [...content, ...order] };
}

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
 * - Blocks are matched by their top-level id, which every stored note block
 *   has (`stableElementIds`); a block without one is left as `theirs` has
 *   it, never duplicated.
 *
 * Pure: the merge view reuses it, and the bind merge runs it in a worker
 * (`mergeCopies`). Applying the steps (applyBlocks.ts) reads the editor's
 * blocks again by id.
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

/**
 * Whether two blocks are equal as JSON, whatever their key order; a key
 * holding `undefined` counts as absent. Below the top level element ids are
 * left out (REVIEW5 N1, Q397): normalization gives an element without one a
 * random id on every parse, while the room holds some without (a Mermaid
 * caption, table rows and cells, columns, toggles), and nothing renders
 * differently for them.
 */
export function sameBlock(left: unknown, right: unknown, top = true): boolean {
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
      left.every((item, index) => sameBlock(item, right[index], false))
    );
  }
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = (value: Record<string, unknown>) =>
    Object.keys(value).filter(
      (key) => value[key] !== undefined && (top || key !== 'id')
    );
  const own = keys(a);
  return (
    own.length === keys(b).length &&
    own.every((key) => sameBlock(a[key], b[key], false))
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
  theirs: MaterialElement[]
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
  const order: MergeStep[] = [];
  let after: string | null = null;
  for (const block of mine) {
    const id = idOf(block);
    if (id === undefined) continue;
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

/** `steps` on plain blocks, as applyMergeSteps runs them on the editor: a
 * block found by id, an insert or a move after its anchor (else at the end
 * when the anchor is gone). */
export function applyToBlocks(blocks: MaterialElement[], steps: MergeStep[]) {
  const out = [...blocks];
  const at = (id: string) => out.findIndex((block) => block.id === id);
  for (const step of steps) {
    if (step.kind === 'set' || step.kind === 'remove') {
      const index = at(step.id);
      if (index < 0) continue;
      if (step.kind === 'set') out[index] = step.block;
      else out.splice(index, 1);
      continue;
    }
    const anchor = step.after === null ? -1 : at(step.after);
    const target = step.after !== null && anchor < 0 ? out.length : anchor + 1;
    if (step.kind === 'insert') {
      out.splice(target, 0, step.block);
      continue;
    }
    const from = at(step.id);
    if (from < 0) continue;
    const [block] = out.splice(from, 1);
    out.splice(from < target ? target - 1 : target, 0, block);
  }
  return out;
}

/** Copies a bind merges, oldest first (another closed tab's, then this
 * tab's own): each against the room's blocks as the ones before left them. */
export interface CopyPair {
  base: MaterialElement[];
  mine: MaterialElement[];
}

/** The steps and conflicts of merging `pairs` in order into `theirs`. Runs
 * in the merge worker (mergeWorker.ts, Q397), off the main thread. */
export function mergeCopies(pairs: CopyPair[], theirs: MaterialElement[]) {
  let current = theirs;
  const steps: MergeStep[] = [];
  const conflicts: BlockConflict[] = [];
  for (const { base, mine } of pairs) {
    const merged = mergeBlocks(base, mine, current);
    steps.push(...merged.steps);
    conflicts.push(...merged.conflicts);
    current = applyToBlocks(current, merged.steps);
  }
  return { conflicts, steps };
}

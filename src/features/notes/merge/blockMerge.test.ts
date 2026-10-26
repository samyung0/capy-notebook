import { describe, expect, it } from 'vitest';
import type { MaterialElement } from '@/features/materials/document';
import { type MergeStep, mergeBlocks, sameBlock } from './blockMerge';

/* Q229: a note's copy edited before its room joined merges into the room's
 * document by top-level block id. `apply` runs the steps on plain arrays as
 * applyBlocks.ts does on the editor. */

const p = (id: string | undefined, text: string): MaterialElement => ({
  children: [{ text }],
  ...(id === undefined ? {} : { id }),
  type: 'p',
});
const BASE = [p('a', 'A'), p('b', 'B'), p('c', 'C'), p('d', 'D')];

function apply(blocks: MaterialElement[], steps: MergeStep[]) {
  const out = [...blocks];
  const at = (id: string) => out.findIndex((block) => block.id === id);
  for (const step of steps) {
    if (step.kind === 'set') out[at(step.id)] = step.block;
    else if (step.kind === 'remove') out.splice(at(step.id), 1);
    else {
      const target = step.after === null ? 0 : at(step.after) + 1;
      if (step.kind === 'insert') out.splice(target, 0, step.block);
      else {
        const from = at(step.id);
        const [block] = out.splice(from, 1);
        out.splice(from < target ? target - 1 : target, 0, block);
      }
    }
  }
  return out;
}

const text = (blocks: MaterialElement[]) =>
  blocks.map((block) => (block.children[0] as { text: string }).text);

function merge(mine: MaterialElement[], theirs: MaterialElement[]) {
  let fresh = 0;
  const { conflicts, steps } = mergeBlocks(
    BASE,
    mine,
    theirs,
    () => `new${++fresh}`
  );
  return { conflicts, result: apply(theirs, steps), steps };
}

describe('mergeBlocks', () => {
  it("applies the user's edit, insert and delete to the room's document", () => {
    const mine = [p('a', 'A mine'), p('n', 'N'), p('b', 'B'), p('d', 'D')];
    const { conflicts, result } = merge(mine, BASE);
    expect(conflicts).toEqual([]);
    expect(text(result)).toEqual(['A mine', 'N', 'B', 'D']);
  });

  it("keeps the room's own edit, insert, delete and move", () => {
    const theirs = [p('d', 'D'), p('a', 'A room'), p('r', 'R'), p('b', 'B')];
    const { conflicts, result, steps } = merge(BASE, theirs);
    expect(conflicts).toEqual([]);
    expect(steps).toEqual([]);
    expect(result).toEqual(theirs);
  });

  it('merges edits of different blocks from both sides', () => {
    const mine = [p('a', 'A mine'), p('b', 'B'), p('c', 'C'), p('d', 'D')];
    const theirs = [p('a', 'A'), p('b', 'B room'), p('d', 'D')];
    const { result } = merge(mine, theirs);
    expect(text(result)).toEqual(['A mine', 'B room', 'D']);
  });

  it("moves a block the user moved, after the block before it in the user's version", () => {
    const mine = [p('b', 'B'), p('c', 'C'), p('a', 'A'), p('d', 'D')];
    const theirs = [p('a', 'A'), p('b', 'B room'), p('c', 'C'), p('d', 'D')];
    const { result } = merge(mine, theirs);
    expect(text(result)).toEqual(['B room', 'C', 'A', 'D']);
  });

  it('keeps the room’s place for a block both sides moved', () => {
    const mine = [p('b', 'B'), p('c', 'C'), p('a', 'A'), p('d', 'D')];
    const theirs = [p('b', 'B'), p('c', 'C'), p('d', 'D'), p('a', 'A')];
    expect(text(merge(mine, theirs).result)).toEqual(['B', 'C', 'D', 'A']);
  });

  it('puts an insert after the nearest block before it that the room still holds, else at the start', () => {
    const mine = [p('t', 'Top'), p('a', 'A'), p('b', 'B'), p('n', 'N')];
    const theirs = [p('a', 'A'), p('c', 'C'), p('d', 'D')];
    // The user deleted c and d (unchanged in the room: deleted); b, which n
    // followed, the room deleted.
    const { result } = merge(mine, theirs);
    expect(text(result)).toEqual(['Top', 'A', 'N']);
  });

  it('makes a block both sides changed differently a conflict, keeping the room’s', () => {
    // The user edited a and b and deleted c; the room edited a and c and
    // deleted b.
    const mine = [p('a', 'A mine'), p('b', 'B mine'), p('d', 'D')];
    const theirs = [p('a', 'A room'), p('c', 'C room'), p('d', 'D')];
    const { conflicts, result } = merge(mine, theirs);
    expect(text(result)).toEqual(['A room', 'C room', 'D']);
    expect(conflicts).toEqual([
      {
        after: null,
        base: p('a', 'A'),
        id: 'a',
        mine: p('a', 'A mine'),
        theirs: p('a', 'A room'),
      },
      {
        after: 'a',
        base: p('b', 'B'),
        id: 'b',
        mine: p('b', 'B mine'),
        theirs: null,
      },
      {
        after: null,
        base: p('c', 'C'),
        id: 'c',
        mine: null,
        theirs: p('c', 'C room'),
      },
    ]);
  });

  it('takes a change both sides made the same way without a conflict', () => {
    const mine = [p('a', 'Same'), p('b', 'B'), p('c', 'C')];
    const theirs = [p('a', 'Same'), p('b', 'B'), p('c', 'C')];
    const { conflicts, steps } = merge(mine, theirs);
    expect(conflicts).toEqual([]);
    expect(steps).toEqual([]);
  });

  it('counts a change nested inside a top-level block as that block', () => {
    const column = (cell: string): MaterialElement => ({
      children: [
        { children: [p('x', cell)], id: 'col1', type: 'column' },
        { children: [p('y', 'right')], id: 'col2', type: 'column' },
      ],
      id: 'g',
      type: 'column_group',
    });
    const base = [p('a', 'A'), column('left')];
    const mine = [p('a', 'A'), column('left mine')];
    const theirs = [p('a', 'A room'), column('left')];
    const { conflicts, steps } = mergeBlocks(base, mine, theirs);
    expect(conflicts).toEqual([]);
    expect(steps).toEqual([
      { block: column('left mine'), id: 'g', kind: 'set' },
    ]);
    // Both sides inside the same block: one conflict for the whole block.
    expect(
      mergeBlocks(base, mine, [p('a', 'A'), column('left room')]).conflicts
    ).toHaveLength(1);
  });

  it('matches blocks without an id by content: an equal one is unchanged, a new one goes in under a new id', () => {
    const base = [p('a', 'A'), p(undefined, 'Loose')];
    const mine = [p('a', 'A'), p(undefined, 'Loose'), p(undefined, 'Typed')];
    const theirs = [p('a', 'A'), p('r', 'R')];
    const { conflicts, steps } = mergeBlocks(base, mine, theirs, () => 'new1');
    expect(conflicts).toEqual([]);
    expect(steps).toEqual([
      { after: 'a', block: p('new1', 'Typed'), kind: 'insert' },
    ]);
    expect(text(apply(theirs, steps))).toEqual(['A', 'Typed', 'R']);
  });
});

describe('sameBlock', () => {
  it('ignores key order and keys holding undefined', () => {
    expect(
      sameBlock(
        { children: [{ bold: true, text: 'x' }], id: 'a', type: 'p' },
        { children: [{ bold: true, text: 'x' }], id: 'a', type: 'p' }
      )
    ).toBe(true);
    expect(sameBlock({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(sameBlock({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(sameBlock(undefined, null)).toBe(false);
  });
});

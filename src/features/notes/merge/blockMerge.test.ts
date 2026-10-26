import { describe, expect, it } from 'vitest';
import type { MaterialElement } from '@/features/materials/document';
import {
  applyToBlocks,
  mergeBlocks,
  mergeCopies,
  sameBlock,
} from './blockMerge';

/* Q229: a note's copy edited before its room joined merges into the room's
 * document by top-level block id. `apply` runs the steps on plain arrays as
 * applyBlocks.ts does on the editor (`applyToBlocks`). */

const p = (id: string | undefined, text: string): MaterialElement => ({
  children: [{ text }],
  ...(id === undefined ? {} : { id }),
  type: 'p',
});
const BASE = [p('a', 'A'), p('b', 'B'), p('c', 'C'), p('d', 'D')];

const apply = applyToBlocks;

const text = (blocks: MaterialElement[]) =>
  blocks.map((block) => (block.children[0] as { text: string }).text);

function merge(mine: MaterialElement[], theirs: MaterialElement[]) {
  const { conflicts, steps } = mergeBlocks(BASE, mine, theirs);
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

  // Review r1 L5: a block without an id is left as the room has it, never
  // duplicated (an edited one used to go in beside the old one).
  it('leaves blocks without an id as the room has them', () => {
    const base = [p(undefined, 'A'), p('b', 'B')];
    const mine = [p(undefined, 'A edited'), p('b', 'B'), p(undefined, 'New')];
    const theirs = [p(undefined, 'A'), p('b', 'B')];
    const { conflicts, steps } = mergeBlocks(base, mine, theirs);
    expect(conflicts).toEqual([]);
    expect(steps).toEqual([]);
  });

  // Review r1 H1: the copy's elements below the block got ids from
  // normalization, the room's have none; only the cell's text differs.
  it('compares blocks without their inner element ids', () => {
    const table = (text: string, ids: boolean): MaterialElement => ({
      children: [
        {
          children: [
            {
              children: [{ children: [{ text }], type: 'p' }],
              type: 'td',
              ...(ids ? { id: 'cell' } : {}),
            },
          ],
          type: 'tr',
          ...(ids ? { id: 'row' } : {}),
        },
      ],
      id: 't',
      type: 'table',
    });
    const base = [p('a', 'A'), table('cell', true)];
    const mine = [p('a', 'A'), table('cell fixed', true)];
    const theirs = [p('a', 'A'), table('cell', false)];
    const { conflicts, steps } = mergeBlocks(base, mine, theirs);
    expect(conflicts).toEqual([]);
    expect(steps).toEqual([
      { block: table('cell fixed', true), id: 't', kind: 'set' },
    ]);
    // A deleted table goes, not left as a conflict.
    expect(mergeBlocks(base, [p('a', 'A')], theirs).steps).toEqual([
      { id: 't', kind: 'remove' },
    ]);
  });
});

describe('mergeCopies', () => {
  // An older copy merges first; the next one meets the room as it left it.
  it('merges copies in order, each against what the ones before left', () => {
    const older = { base: BASE, mine: [...BASE, p('n', 'N')] };
    const own = {
      base: BASE,
      mine: [p('a', 'A mine'), p('b', 'B'), p('c', 'C'), p('d', 'D')],
    };
    const { conflicts, steps } = mergeCopies([older, own], BASE);
    expect(conflicts).toEqual([]);
    expect(text(apply(BASE, steps))).toEqual(['A mine', 'B', 'C', 'D', 'N']);
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
    // Inner ids aside; the block's own id counts.
    expect(
      sameBlock(
        { children: [{ id: 'x', text: '' }], id: 'a' },
        { children: [{ text: '' }], id: 'a' }
      )
    ).toBe(true);
    expect(sameBlock({ id: 'a' }, { id: 'b' })).toBe(false);
  });
});

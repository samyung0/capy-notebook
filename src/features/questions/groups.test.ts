import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { QUESTION_BLOCKS_MAX } from '@/api/limits.generated';
import {
  addPart,
  addSubPart,
  canMoveItem,
  canPlaceItem,
  canRemoveGroup,
  canRemovePart,
  canUngroup,
  fullPartLabel,
  isLonePart,
  moveItem,
  partPlaces,
  placeItem,
  questionItems,
  removeGroup,
  removePart,
  repairGroups,
  splitPart,
  ungroup,
  ungroupCanvasIssue,
  withKeptPart,
} from './groups';
import { exampleQuestion } from './questionFixtures';
import type { Question, QuestionPart } from './types';

const part = (id: string, group?: string): QuestionPart => ({
  ...exampleQuestion(id).parts[0],
  id,
  ...(group ? { group } : {}),
});
const fig = { text: 'Fig. 3.2', type: 'text' as const };
/** (a), (b) over (i) and (ii), (c). */
const question = (): Question => ({
  ...exampleQuestion('q'),
  groups: [{ blocks: [fig], id: 'g' }],
  parts: [part('a'), part('i', 'g'), part('ii', 'g'), part('c')],
});
const ids = (q: Question) => q.parts.map((item) => item.id);

describe('labels', () => {
  it("gives top-level items the question's labels and a group's parts roman numerals", () => {
    const labels = questionItems(question()).map((item) =>
      item.kind === 'part'
        ? item.label
        : [item.label, ...item.parts.map((sub) => sub.label)]
    );
    expect(labels).toEqual(['(a)', ['(b)', '(i)', '(ii)'], '(c)']);
    const numbers = questionItems({ ...question(), labels: 'numbers' }).map(
      (item) => item.label
    );
    expect(numbers).toEqual(['1.', '2.', '3.']);
  });

  it('counts roman numerals as far as a bank question goes', () => {
    const many = Array.from({ length: 26 }, (_, i) => part(`p${i}`, 'g'));
    const [item] = questionItems({ ...question(), parts: many });
    if (item.kind !== 'group') throw new Error('no group');
    expect(item.parts.map((sub) => sub.label).slice(0, 10)).toEqual([
      '(i)',
      '(ii)',
      '(iii)',
      '(iv)',
      '(v)',
      '(vi)',
      '(vii)',
      '(viii)',
      '(ix)',
      '(x)',
    ]);
    expect(item.parts.at(-1)?.label).toBe('(xxvi)');
  });

  it('names a part in full where nothing beside it shows its group', () => {
    expect(fullPartLabel(question(), 'a')).toBe('(a)');
    expect(fullPartLabel(question(), 'ii')).toBe('(b)(ii)');
    expect(fullPartLabel({ ...question(), labels: 'numbers' }, 'ii')).toBe(
      '2(ii)'
    );
    expect(partPlaces(question()).get('c')).toEqual({ item: 2 });
  });

  it('calls a part lone only when no group is printed beside it', () => {
    expect(isLonePart({ parts: [part('a')] })).toBe(true);
    expect(isLonePart({ parts: [part('a', 'g')] })).toBe(false);
    expect(isLonePart({ parts: [part('a'), part('b')] })).toBe(false);
  });
});

describe('repairGroups', () => {
  const cases = JSON.parse(
    readFileSync(
      new URL(
        '../../../server/internal/questions/testdata/repairs/groups.json',
        import.meta.url
      ),
      'utf8'
    )
  ) as { name: string; question: Question; repaired: Question }[];
  it.each(cases.map((c) => [c.name, c] as const))('%s', (_, c) => {
    expect(repairGroups(c.question)).toEqual(c.repaired);
  });
});

describe("the editor's actions", () => {
  it('moves a group past a part as a whole, and a part past a whole group', () => {
    const q = question();
    expect(ids(moveItem(q, { group: 'g' }, 1))).toEqual(['a', 'c', 'i', 'ii']);
    expect(ids(moveItem(q, { group: 'g' }, -1))).toEqual(['i', 'ii', 'a', 'c']);
    expect(ids(moveItem(q, { part: 'a' }, 1))).toEqual(['i', 'ii', 'a', 'c']);
    expect(ids(moveItem(q, { part: 'c' }, -1))).toEqual(['a', 'c', 'i', 'ii']);
    expect(canMoveItem(q, { part: 'a' }, -1)).toBe(false);
    expect(canMoveItem(q, { part: 'c' }, 1)).toBe(false);
  });

  it('moves a sub-part inside its group only', () => {
    const q = question();
    expect(ids(moveItem(q, { part: 'i' }, 1))).toEqual(['a', 'ii', 'i', 'c']);
    expect(canMoveItem(q, { part: 'i' }, -1)).toBe(false);
    expect(canMoveItem(q, { part: 'ii' }, 1)).toBe(false);
  });

  it('places a top-level item beside another, and a sub-part beside its siblings', () => {
    const q = question();
    expect(ids(placeItem(q, { part: 'c' }, { group: 'g' }, false))).toEqual([
      'a',
      'c',
      'i',
      'ii',
    ]);
    expect(ids(placeItem(q, { group: 'g' }, { part: 'c' }, true))).toEqual([
      'a',
      'c',
      'i',
      'ii',
    ]);
    expect(ids(placeItem(q, { part: 'ii' }, { part: 'i' }, false))).toEqual([
      'a',
      'ii',
      'i',
      'c',
    ]);
    // Nothing moves in or out of a group by dragging.
    expect(canPlaceItem(q, { part: 'a' }, { part: 'i' })).toBe(false);
    expect(canPlaceItem(q, { part: 'i' }, { part: 'a' })).toBe(false);
    expect(canPlaceItem(q, { part: 'a' }, { part: 'a' })).toBe(false);
  });

  it("adds a sub-part after the group's last", () => {
    const sub = addSubPart(question(), 'g', part('iii'));
    expect(ids(sub)).toEqual(['a', 'i', 'ii', 'iii', 'c']);
    expect(sub.parts[3].group).toBe('g');
  });

  // Epo 2026-11-24: Add sub-part follows Add part. The part's blocks become
  // the group's text, both sub-parts start blank, and what it held is kept,
  // back in (i) once the group is undone, its canvas answer on its own
  // canvas again.
  it("moves a part's blocks into its new group's text and keeps what it held", () => {
    const canvas = { board: 'b', image: 'i', type: 'canvas' } as const;
    const held: QuestionPart = {
      ...part('a'),
      answer: { type: 'canvas' },
      blocks: [fig, canvas],
      markscheme: [{ marks: 1, text: 'Shades the cell.' }],
    };
    const q = { ...question(), parts: [held, ...question().parts.slice(1)] };
    const { kept, question: split } = splitPart(
      q,
      'a',
      'h',
      part('x'),
      part('y')
    );
    expect(ids(split)).toEqual(['x', 'y', 'i', 'ii', 'c']);
    expect(split.groups?.[0]).toEqual({ blocks: [fig, canvas], id: 'h' });
    expect(split.parts.slice(0, 2)).toEqual([
      { ...part('x'), group: 'h' },
      { ...part('y'), group: 'h' },
    ]);
    if (!kept) throw new Error('nothing kept');
    expect(kept.parts).toEqual(['x', 'y']);
    const back = withKeptPart(removePart(split, 'y'), 'x', kept);
    expect(back.parts[0]).toEqual({
      ...part('x'),
      answer: held.answer,
      blocks: [fig, canvas, ...part('x').blocks],
      markscheme: held.markscheme,
    });
    // A fill in the blanks part stays (i) whole.
    const gaps = {
      ...q,
      parts: [
        { ...held, answer: { accepted: [['ATP']], type: 'gaps' as const } },
      ],
    };
    const blanks = splitPart(gaps, 'a', 'h', part('x'), part('y'));
    expect(blanks.kept).toBeUndefined();
    expect(ids(blanks.question)).toEqual(['a', 'y']);
  });

  it('turns a group left with one sub-part back into the part it was', () => {
    const gaps = {
      ...question(),
      parts: [
        {
          ...part('a'),
          answer: { accepted: [['ATP']], type: 'gaps' as const },
        },
        ...question().parts.slice(1),
      ],
    };
    const { question: split } = splitPart(
      gaps,
      'a',
      'h',
      part('x'),
      part('new')
    );
    expect(removePart(split, 'new')).toEqual(gaps);
  });

  it("ungroups without losing the group's text and figures", () => {
    const q = ungroup(question(), 'g');
    expect(q).not.toHaveProperty('groups');
    expect(ids(q)).toEqual(['a', 'i', 'ii', 'c']);
    expect(q.parts.every((item) => item.group === undefined)).toBe(true);
    expect(q.parts[1].blocks[0]).toEqual(fig);
    expect(q.parts[1].blocks).toHaveLength(part('i').blocks.length + 1);
    expect(q.parts[2].blocks).toEqual(part('ii').blocks);
  });

  // Epo 2026-11-24: the group's canvas goes to its first sub-part on Ungroup;
  // one that answered in it answers in it as its own then.
  it('gives a sub-part answering in its group canvas that canvas as its own', () => {
    const canvas = { board: 'b', image: 'i', type: 'canvas' } as const;
    const shared: QuestionPart = {
      ...part('i', 'g'),
      answer: { shared: true, type: 'canvas' },
      markscheme: [{ marks: 1, text: 'Shades it.' }],
    };
    const q = {
      ...question(),
      groups: [{ blocks: [fig, canvas], id: 'g' }],
      parts: [part('a'), shared, part('ii', 'g'), part('c')],
    };
    expect(ungroupCanvasIssue(q, 'g')).toBeNull();
    const [, first] = ungroup(q, 'g').parts;
    expect(first.answer).toEqual({ type: 'canvas' });
    expect(first.blocks).toEqual([fig, canvas, ...shared.blocks]);
    // (ii) answering in it too: Ungroup would take its canvas away.
    const both = {
      ...q,
      parts: [part('a'), shared, { ...shared, id: 'ii' }, part('c')],
    };
    expect(ungroupCanvasIssue(both, 'g')).toBe('answered');
  });

  // Epo 2026-11-24: one canvas a list, so a first sub-part holding its own
  // can't take the group's.
  it("holds Ungroup back when its first part holds a canvas beside the group's", () => {
    const canvas = { type: 'canvas' } as const;
    const q = {
      ...question(),
      groups: [{ blocks: [fig, canvas], id: 'g' }],
      parts: [
        part('a'),
        { ...part('i', 'g'), blocks: [...part('i').blocks, canvas] },
        part('ii', 'g'),
        part('c'),
      ],
    };
    expect(ungroupCanvasIssue(q, 'g')).toBe('canvas');
  });

  it('holds Ungroup back when the text would not fit its first part', () => {
    const q = question();
    expect(canUngroup(q, 'g')).toBe(true);
    const full = {
      ...q,
      groups: [
        {
          blocks: Array.from({ length: QUESTION_BLOCKS_MAX }, () => fig),
          id: 'g',
        },
      ],
    };
    expect(canUngroup(full, 'g')).toBe(false);
    // A blank text takes no room.
    const blank = { text: '  ', type: 'text' as const };
    const blanks = {
      ...q,
      groups: [
        {
          blocks: Array.from({ length: QUESTION_BLOCKS_MAX }, () => blank),
          id: 'g',
        },
      ],
    };
    expect(canUngroup(blanks, 'g')).toBe(true);
    expect(ungroup(blanks, 'g').parts[1].blocks).toEqual(part('i').blocks);
  });

  it('removes a group with its parts, unless they are all the question has', () => {
    const q = removeGroup(question(), 'g');
    expect(q).not.toHaveProperty('groups');
    expect(ids(q)).toEqual(['a', 'c']);
    expect(canRemoveGroup(question(), 'g')).toBe(true);
    const alone = { ...question(), parts: [part('i', 'g')] };
    expect(canRemoveGroup(alone, 'g')).toBe(false);
  });

  it("keeps a group's last part: its Ungroup or Remove takes it", () => {
    const q = question();
    expect(canRemovePart(q, 'i')).toBe(true);
    expect(canRemovePart(q, 'a')).toBe(true);
    const one = { ...q, parts: [part('a'), part('i', 'g')] };
    expect(canRemovePart(one, 'i')).toBe(false);
    expect(canRemovePart(one, 'a')).toBe(true);
    expect(canRemovePart({ ...q, groups: [], parts: [part('a')] }, 'a')).toBe(
      false
    );
  });
});

// Epo 2026-11-23 (E1): no block moves to the new part; the lone part's
// blocks join the stem, both parts start blank, and what it held is kept.
describe('Add part', () => {
  const canvas = { board: 'b', image: 'i', type: 'canvas' } as const;
  const lone = (): Question => ({
    ...exampleQuestion('q'),
    parts: [
      {
        ...part('a'),
        answer: { sample: { board: 's', image: 't' }, type: 'canvas' },
        blocks: [fig, canvas],
        marks: 2,
        markscheme: [{ marks: 2, text: 'Fills the square.' }],
        solution: [{ text: 'AA, Aa, Aa, aa', type: 'text' }],
      },
    ],
    stem: [{ text: 'Aa × Aa', type: 'text' }],
  });

  it("moves a lone part's blocks into the stem and blanks both parts", () => {
    const [blank, next] = [part('x'), part('y')];
    const { kept, question: q } = addPart(lone(), next, blank);
    expect(q.stem).toEqual([...lone().stem, fig, canvas]);
    expect(q.parts).toEqual([blank, next]);
    const [held] = lone().parts;
    expect(kept).toEqual({
      answer: held.answer,
      from: 'a',
      marks: 2,
      markscheme: held.markscheme,
      parts: ['x', 'y'],
      solution: held.solution,
    });
  });

  it('adds a part after the others when there are several', () => {
    const { kept, question: q } = addPart(question(), part('d'), part('x'));
    expect(kept).toBeUndefined();
    expect(ids(q)).toEqual(['a', 'i', 'ii', 'c', 'd']);
    expect(q.stem).toEqual(question().stem);
  });

  it('puts back what it kept once the question is down to one part', () => {
    const { kept, question: q } = addPart(lone(), part('y'), part('x'));
    if (!kept) throw new Error('nothing kept');
    const back = withKeptPart(removePart(q, 'y'), 'x', kept);
    const { from: _from, parts: _made, ...held } = kept;
    // Its canvas is the stem's now: it answers in the canvas above.
    expect(back.parts).toEqual([
      {
        ...part('x'),
        ...held,
        answer: { ...held.answer, shared: true },
      },
    ]);
  });

  // Epo 2026-11-24: its blanks live in its text, which can't sit in the stem.
  it('keeps a lone fill in the blanks part whole as (a)', () => {
    const gaps = {
      ...lone(),
      parts: [
        {
          ...part('a'),
          answer: { accepted: [['AA']], type: 'gaps' as const },
          blocks: [
            { text: 'Aa × Aa gives (1) ______.', type: 'text' as const },
          ],
        },
      ],
    };
    const { kept, question: q } = addPart(gaps, part('y'), part('x'));
    expect(kept).toBeUndefined();
    expect(q.stem).toEqual(gaps.stem);
    expect(q.parts).toEqual([gaps.parts[0], part('y')]);
  });

  // Epo 2026-11-24: one canvas a list, so with the stem's own the lone part's
  // canvas waits in the tab's memory with its answer, back with it later.
  it("keeps a lone part's canvas when the stem holds one already", () => {
    const stem = [{ text: 'Aa × Aa', type: 'text' as const }, canvas];
    const own = { ...lone(), stem };
    const { kept, question: q } = addPart(own, part('y'), part('x'));
    expect(q.stem).toEqual([...stem, fig]);
    if (!kept) throw new Error('nothing kept');
    expect(kept.canvas).toEqual({ block: canvas, index: 1 });
    expect(kept.answer).toEqual(lone().parts[0].answer);
    const back = withKeptPart(removePart(q, 'y'), 'x', kept);
    expect(back.parts[0].blocks).toEqual([...part('x').blocks, canvas]);
    expect(back.parts[0].answer).toEqual(lone().parts[0].answer);
  });
});

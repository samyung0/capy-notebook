import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { QUESTION_BLOCKS_MAX } from '@/api/limits.generated';
import {
  addSubPart,
  appendGroup,
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
  repairGroups,
  ungroup,
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

  it('adds a group with its first part at the end, and a sub-part after its last', () => {
    const added = appendGroup(question(), { blocks: [], id: 'h' }, part('new'));
    expect(added.groups?.map((group) => group.id)).toEqual(['g', 'h']);
    expect(added.parts.at(-1)).toMatchObject({ group: 'h', id: 'new' });
    const sub = addSubPart(question(), 'g', part('iii'));
    expect(ids(sub)).toEqual(['a', 'i', 'ii', 'iii', 'c']);
    expect(sub.parts[3].group).toBe('g');
    const first = appendGroup(
      exampleQuestion('q'),
      { blocks: [], id: 'h' },
      part('p')
    );
    expect(first.groups).toEqual([{ blocks: [], id: 'h' }]);
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

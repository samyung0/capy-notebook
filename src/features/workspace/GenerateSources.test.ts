import { describe, expect, it } from 'vitest';
import type { Chapter, MaterialRef, SourceFile } from '@/api/types';
import { scopeOf, sourceGroups } from './GenerateSources';

const chapter = (id: string, order: number) =>
  ({ id, name: id, order }) as Chapter;
const file = (id: string, chapterId: string | null, indexed = true) =>
  ({
    addedAt: '2026-10-25T00:00:00Z',
    chapterId,
    id,
    indexed,
    kind: 'pdf',
    name: `${id}.pdf`,
    position: 0,
  }) as SourceFile;
const material = (
  id: string,
  type: MaterialRef['type'],
  chapterId: string | null
) =>
  ({
    chapterId,
    createdAt: '2026-10-25T00:00:00Z',
    id,
    position: 1,
    title: id,
    type,
  }) as MaterialRef;

const groups = sourceGroups(
  [chapter('genetics', 2), chapter('cells', 1), chapter('empty', 3)],
  [
    file('a', 'cells'),
    file('b', 'cells'),
    file('c', 'genetics'),
    file('d', null),
    file('wip', 'cells', false),
  ],
  [material('note', 'note', 'cells'), material('quiz', 'quiz', 'genetics')]
);

describe('sourceGroups', () => {
  it('lists indexed files and notes by chapter order, then Others', () => {
    expect(groups.map((g) => [g.id, g.items.map((it) => it.id)])).toEqual([
      ['cells', ['a', 'b', 'note']],
      ['genetics', ['c']],
      [null, ['d']],
    ]);
  });
});

describe('scopeOf', () => {
  it('sends nothing for the whole workspace', () => {
    expect(scopeOf(groups, new Set(['a', 'b', 'note', 'c', 'd']))).toEqual({
      chapters: [],
      fileIds: [],
    });
  });

  it('sends whole chapters by id and the other ticked items by id', () => {
    expect(scopeOf(groups, new Set(['c', 'a', 'd']))).toEqual({
      chapters: ['genetics'],
      fileIds: ['a', 'd'],
    });
  });
});

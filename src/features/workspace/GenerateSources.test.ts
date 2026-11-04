import { describe, expect, it } from 'vitest';
import type { MaterialRef, SourceFile, Topic } from '@/api/types';
import { scopeOf, sourceGroups } from './GenerateSources';

const topic = (id: string, order: number) => ({ id, name: id, order }) as Topic;
const file = (id: string, topicId: string | null, indexed = true) =>
  ({
    addedAt: '2026-10-25T00:00:00Z',
    id,
    indexed,
    kind: 'pdf',
    name: `${id}.pdf`,
    position: 0,
    topicId,
  }) as SourceFile;
const material = (
  id: string,
  type: MaterialRef['type'],
  topicId: string | null
) =>
  ({
    createdAt: '2026-10-25T00:00:00Z',
    id,
    position: 1,
    title: id,
    topicId,
    type,
  }) as MaterialRef;

const groups = sourceGroups(
  [topic('genetics', 2), topic('cells', 1), topic('empty', 3)],
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
  it('lists indexed files and notes by topic order, then Others', () => {
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
      fileIds: [],
      topics: [],
    });
  });

  it('sends whole topics by id and the other ticked items by id', () => {
    expect(scopeOf(groups, new Set(['c', 'a', 'd']))).toEqual({
      fileIds: ['a', 'd'],
      topics: ['genetics'],
    });
  });
});

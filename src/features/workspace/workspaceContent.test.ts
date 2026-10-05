import { describe, expect, it } from 'vitest';
import type { Chapter, MaterialRef, SourceFile } from '@/api/types';
import { readingOrder } from './workspaceContent';

const file = (id: string, chapterId: string | null, position: number) =>
  ({ addedAt: '2026-10-01T00:00:00Z', chapterId, id, position }) as SourceFile;
const material = (id: string, chapterId: string | null, position: number) =>
  ({
    chapterId,
    createdAt: '2026-10-01T00:00:00Z',
    id,
    position,
  }) as MaterialRef;
const chapter = (id: string, order: number) => ({ id, order }) as Chapter;

describe('readingOrder', () => {
  it('walks chapters by order, each in tree order, then unfiled items', () => {
    const order = readingOrder(
      [chapter('second', 1), chapter('first', 0)],
      [
        file('f_unfiled', null, 0),
        file('f_b', 'first', 1),
        file('f_c', 'second', 0),
      ],
      [material('m_a', 'first', 0), material('m_unfiled', null, 1)]
    ).map((item) => item.id);
    expect(order).toEqual(['m_a', 'f_b', 'f_c', 'f_unfiled', 'm_unfiled']);
  });
});

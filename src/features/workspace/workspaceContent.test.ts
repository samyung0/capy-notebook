import { describe, expect, it } from 'vitest';
import type { MaterialRef, SourceFile, Topic } from '@/api/types';
import { readingOrder } from './workspaceContent';

const file = (id: string, topicId: string | null, position: number) =>
  ({ addedAt: '2026-10-01T00:00:00Z', id, position, topicId }) as SourceFile;
const material = (id: string, topicId: string | null, position: number) =>
  ({
    createdAt: '2026-10-01T00:00:00Z',
    id,
    position,
    topicId,
  }) as MaterialRef;
const topic = (id: string, order: number) => ({ id, order }) as Topic;

describe('readingOrder', () => {
  it('walks topics by order, each in tree order, then unfiled items', () => {
    const order = readingOrder(
      [topic('second', 1), topic('first', 0)],
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

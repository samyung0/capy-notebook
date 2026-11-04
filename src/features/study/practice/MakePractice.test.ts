import { describe, expect, it } from 'vitest';
import type { MaterialRef, SourceFile, Topic } from '@/api/types';
import { practiceSources } from './MakePractice';

const topic = (id: string, order: number) => ({ id, name: id, order }) as Topic;

describe('practiceSources', () => {
  it('offers the topics with indexed text, and every source for Files', () => {
    const files = [
      { id: 'f1', indexed: true, name: 'f1', topicId: 'read' },
      { id: 'f2', indexed: false, name: 'f2', topicId: 'waiting' },
      { id: 'f3', indexed: true, name: 'f3', topicId: null },
    ] as SourceFile[];
    const materials = [
      { id: 'n1', title: 'n1', topicId: 'noted', type: 'note' },
      { id: 'q1', title: 'q1', topicId: 'quizzes', type: 'quiz' },
    ] as MaterialRef[];
    const got = practiceSources(
      ['noted', 'read', 'waiting', 'quizzes'].map(topic),
      files,
      materials
    );
    expect(got.topics.map((t) => t.id)).toEqual(['noted', 'read']);
    expect(got.items.map((i) => i.id)).toEqual(['n1', 'f1', 'f3']);
  });
});

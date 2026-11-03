import { expect, it } from 'vitest';
import type { BankProgress } from '@/api/types';
import { newlyFinishedTopics } from './finishToasts';

const topic = (topicId: string, next: string | null) =>
  ({ nextQuestionId: next, topicId }) as BankProgress['topics'][number];

it('toasts a topic finished by the refetch, not one finished before', () => {
  const prev = { topics: [topic('a', 'q3'), topic('b', null)] };
  const next = {
    // c: its only question answered, so it was not listed before.
    topics: [topic('a', null), topic('b', null), topic('c', null)],
  };
  expect(newlyFinishedTopics(prev, next).map((t) => t.topicId)).toEqual([
    'a',
    'c',
  ]);
  // Reopened by a new question, then finished again.
  const reopened = { topics: [topic('b', 'q9')] };
  expect(newlyFinishedTopics(reopened, next).map((t) => t.topicId)).toEqual([
    'a',
    'b',
    'c',
  ]);
});

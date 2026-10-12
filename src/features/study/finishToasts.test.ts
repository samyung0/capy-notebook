import { expect, it } from 'vitest';
import type { BankProgress, LearningProgress } from '@/api/types';
import { newlyFinishedTopics, newlyFinishedWorkspaces } from './finishToasts';

const topic = (topicId: string, next: string | null) =>
  ({ nextQuestionId: next, topicId }) as BankProgress['topics'][number];
const workspace = (workspaceId: string) =>
  ({ workspaceId }) as LearningProgress['finished'][number];

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

it('toasts a workspace that moved into finished', () => {
  const prev = {
    active: [workspace('w1')],
    finished: [workspace('w2')],
  } as LearningProgress;
  const next = {
    active: [],
    finished: [workspace('w1'), workspace('w2')],
  } as LearningProgress;
  expect(newlyFinishedWorkspaces(prev, next).map((w) => w.workspaceId)).toEqual(
    ['w1']
  );
});

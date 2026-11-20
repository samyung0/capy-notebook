import { expect, it } from 'vitest';
import { changedAttempts } from './hooks';
import type { AssignmentReport } from './types';

const row = (attemptId: string, questionId: string, waiting: boolean) => ({
  aiAwarded: 0,
  aiMarked: false,
  aiWarning: '',
  attemptId,
  attemptNumber: 1,
  awarded: 0,
  handMarking: false,
  marks: 2,
  questionId,
  userId: 'u1',
  waiting,
});
const report = (answers: ReturnType<typeof row>[]) =>
  ({ answers, members: [], questions: [] }) as unknown as AssignmentReport;

// Epo 2026-11-19: an answer the AI just marked reads its attempt again.
it('names the attempts whose answer rows moved', () => {
  const before = report([row('at1', 'q1', true), row('at2', 'q1', true)]);
  const after = report([
    { ...row('at1', 'q1', true), aiAwarded: 2, aiMarked: true },
    row('at2', 'q1', true),
    row('at3', 'q1', false),
  ]);
  expect([...changedAttempts(before, after)]).toEqual(['at1', 'at3']);
});

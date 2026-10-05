import { expect, it, vi } from 'vitest';
import type { RateReviewItemReq } from '@/api/types';
import { exampleQuestion } from '@/features/questions/questionFixtures';
import { gradeReviewQuestion, ratingQueue } from './ratings';

it('posts card ratings and question scores, and saved waits for every one', async () => {
  const posted: RateReviewItemReq[] = [];
  const settle: (() => void)[] = [];
  const failed = vi.fn();
  const queue = ratingQueue((body) => {
    posted.push(body);
    return new Promise<void>((resolve, reject) =>
      settle.push(body.score === undefined ? resolve : () => reject())
    );
  }, failed);
  queue.rate({ itemId: 'c1', materialId: 'set', rating: 3 });
  queue.rate({ itemId: 'q1', materialId: 'quiz', score: 0.5 });
  expect(posted).toEqual([
    { itemId: 'c1', materialId: 'set', rating: 3 },
    { itemId: 'q1', materialId: 'quiz', score: 0.5 },
  ]);

  let saved = false;
  const done = queue.saved().then(() => {
    saved = true;
  });
  settle[0]();
  await Promise.resolve();
  expect(saved).toBe(false);
  // A failed rating is reported and does not hold the next batch back.
  settle[1]();
  await done;
  expect(saved).toBe(true);
  expect(failed).toHaveBeenCalledOnce();
});

it('scores a review question as its awarded share of the marks', async () => {
  const closed = exampleQuestion('short', {
    accepted: ['osmosis'],
    type: 'short',
  });
  const right = await gradeReviewQuestion(
    closed,
    { 'short-part': 'osmosis' },
    async () => {
      throw new Error('closed parts never call the grader');
    }
  );
  expect(right.score).toBe(1);

  const open = exampleQuestion('open', {
    accepted: ['Folds increase the surface area.'],
    hints: [],
    type: 'open',
  });
  open.parts[0].marks = 2;
  open.parts[0].markscheme = [{ marks: 2, text: 'Surface area' }];
  const half = await gradeReviewQuestion(
    open,
    { 'open-part': 'More area' },
    async () => ({ 'open-part': { awarded: 1, itemAwards: [1] } })
  );
  expect(half.score).toBe(0.5);
  expect(half.graded.parts[0].awarded).toBe(1);
});

import { expect, it, vi } from 'vitest';
import type { RateReviewItemReq } from '@/api/types';
import { ratingQueue } from './ratings';

it('posts card ratings in the background, and saved waits for every one', async () => {
  const posted: RateReviewItemReq[] = [];
  const settle: (() => void)[] = [];
  const failed = vi.fn();
  const queue = ratingQueue((body) => {
    posted.push(body);
    return new Promise<void>((resolve, reject) =>
      settle.push(body.rating === 3 ? resolve : () => reject())
    );
  }, failed);
  queue.rate({ itemId: 'c1', materialId: 'set', rating: 3 });
  queue.rate({ itemId: 'c2', materialId: 'set', rating: 1 });
  expect(posted).toEqual([
    { itemId: 'c1', materialId: 'set', rating: 3 },
    { itemId: 'c2', materialId: 'set', rating: 1 },
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

import type { RateReviewItemReq } from '@/api/types';
import { m } from '@/i18n';
import type { SrsRating } from '@/lib/srs';

export const RATING_LABEL: Record<SrsRating, () => string> = {
  again: m.srs_again,
  easy: m.srs_easy,
  good: m.srs_good,
  hard: m.srs_hard,
};
export const RATING_STYLE: Record<SrsRating, string> = {
  again: 'border-tint-error text-tint-error-fg hover:bg-tint-error',
  easy: 'border-tint-success text-tint-success-fg hover:bg-tint-success',
  good: 'border-tint-accent-1 text-tint-accent-1-fg hover:bg-tint-accent-1',
  hard: 'border-tint-warning text-tint-warning-fg hover:bg-tint-warning',
};

/** A review session's ratings: each posts in the background, and `saved`
 * resolves once every one has settled, so the next batch is chosen from them. */
export function ratingQueue(
  post: (body: RateReviewItemReq) => Promise<unknown>,
  failed: () => void
) {
  let pending: Promise<unknown>[] = [];
  return {
    rate(body: RateReviewItemReq) {
      pending.push(post(body).catch(failed));
    },
    async saved() {
      const ratings = pending;
      pending = [];
      await Promise.all(ratings);
    },
  };
}

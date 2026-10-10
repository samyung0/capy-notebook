import type { RateReviewItemReq, ReviewItem } from '@/api/types';
import type { FlashcardContent } from '@/features/materials/blocks';
import { m } from '@/i18n';
import type { SrsRating } from '@/lib/srs';

export const RATING_LABEL: Record<SrsRating, () => string> = {
  again: m.srs_again,
  easy: m.srs_easy,
  good: m.srs_good,
  hard: m.srs_hard,
};

/** A review card item as the shared card shows it. */
export function reviewCard(item: ReviewItem): FlashcardContent {
  return {
    back: item.back ?? '',
    front: item.front ?? '',
    id: item.itemId,
    ...(item.image ? { image: item.image } : {}),
  };
}

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

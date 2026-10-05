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

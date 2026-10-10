import type { CSSProperties } from 'react';
import { cn } from '@/lib/cn';
import { SRS_RATINGS, type SrsRating } from '@/lib/srs';
import { RATING_LABEL } from './ratings';

const TILE: Record<SrsRating, string> = {
  again: 'bg-tint-error text-tint-error-fg',
  easy: 'bg-tint-success text-tint-success-fg',
  good: 'bg-tint-info text-tint-info-fg',
  hard: 'bg-tint-warning text-tint-warning-fg',
};

/** A flashcard's four ratings as tinted text buttons, rising in one after
 * another as the back shows. `chosen` shows a rating already given: that
 * tile is ringed and every tile is disabled, so nothing is rated twice. */
export function RatingTiles({
  onRate,
  disabled,
  chosen,
}: {
  onRate: (rating: SrsRating) => void;
  disabled?: boolean;
  chosen?: SrsRating;
}) {
  return (
    <div className="grid grid-cols-4 gap-2">
      {SRS_RATINGS.map((rating, index) => (
        <button
          aria-pressed={chosen ? rating === chosen : undefined}
          className={cn(
            'motion-safe:motion-card-tile-in rounded-input py-2.5 font-semibold text-sm transition-[filter] hover:brightness-95 focus-visible:ring-2 focus-visible:ring-action disabled:opacity-50',
            TILE[rating],
            rating === chosen &&
              'ring-2 ring-current ring-inset disabled:opacity-100'
          )}
          disabled={disabled || !!chosen}
          key={rating}
          onClick={() => onRate(rating)}
          style={{ '--motion-stagger-index': index } as CSSProperties}
          type="button"
        >
          {RATING_LABEL[rating]()}
        </button>
      ))}
    </div>
  );
}

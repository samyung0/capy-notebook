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
 * another as the back shows. */
export function RatingTiles({
  onRate,
  disabled,
}: {
  onRate: (rating: SrsRating) => void;
  disabled?: boolean;
}) {
  return (
    <div className="grid grid-cols-4 gap-2">
      {SRS_RATINGS.map((rating, index) => (
        <button
          className={cn(
            'motion-safe:motion-card-tile-in rounded-input py-2.5 font-semibold text-sm transition-[filter] hover:brightness-95 focus-visible:ring-2 focus-visible:ring-action disabled:opacity-50',
            TILE[rating]
          )}
          disabled={disabled}
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

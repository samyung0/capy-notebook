import { Icon, type IconName } from '@/components/ui/Icon';
import { cn } from '@/lib/cn';
import { SRS_RATINGS, type SrsRating } from '@/lib/srs';
import { RATING_LABEL } from './ratings';

const TILE: Record<SrsRating, { icon: IconName; className: string }> = {
  again: { className: 'bg-tint-error text-tint-error-fg', icon: 'retry' },
  easy: {
    className: 'bg-tint-success text-tint-success-fg',
    icon: 'tickDouble',
  },
  good: { className: 'bg-tint-info text-tint-info-fg', icon: 'tick' },
  hard: { className: 'bg-tint-warning text-tint-warning-fg', icon: 'wave' },
};

/** A flashcard's four ratings as tinted tiles, the icon over the label. */
export function RatingTiles({
  onRate,
  disabled,
}: {
  onRate: (rating: SrsRating) => void;
  disabled?: boolean;
}) {
  return (
    <div className="grid grid-cols-4 gap-2">
      {SRS_RATINGS.map((rating) => (
        <button
          className={cn(
            'flex flex-col items-center gap-1.5 rounded-input py-3 font-semibold text-sm transition-[filter] hover:brightness-95 focus-visible:ring-2 focus-visible:ring-action disabled:opacity-50',
            TILE[rating].className
          )}
          disabled={disabled}
          key={rating}
          onClick={() => onRate(rating)}
          type="button"
        >
          <Icon name={TILE[rating].icon} size={20} />
          {RATING_LABEL[rating]()}
        </button>
      ))}
    </div>
  );
}

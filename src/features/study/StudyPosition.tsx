import { m } from '@/i18n';
import { cn } from '@/lib/cn';

/** A one-at-a-time run's place, "4 of 12" beside a bar: flashcard study and
 * review sessions (a quiz lists every question, so it has none). */
export function StudyPosition({
  className,
  position,
  total,
}: {
  className?: string;
  position: number;
  total: number;
}) {
  const label = m.flashcards_card_position({ position, total });
  return (
    <div className={cn('flex items-center gap-3', className)}>
      {/* Sized for "N of N", so the bar keeps its width as the count moves. */}
      <span className="grid shrink-0 text-fg-muted">
        <span aria-hidden className="invisible col-start-1 row-start-1">
          {m.flashcards_card_position({ position: total, total })}
        </span>
        <span className="col-start-1 row-start-1">{label}</span>
      </span>
      <div
        aria-label={label}
        aria-valuemax={total}
        aria-valuemin={0}
        aria-valuenow={position}
        className="h-2 flex-1 overflow-hidden rounded-full bg-fg/8"
        role="progressbar"
      >
        <div
          className="h-full rounded-full bg-action-accent transition-[width] duration-(--motion-duration-slow) ease-(--motion-ease-smooth-out)"
          style={{ width: `${(position / total) * 100}%` }}
        />
      </div>
    </div>
  );
}

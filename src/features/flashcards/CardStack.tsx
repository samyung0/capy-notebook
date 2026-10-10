import { type ReactNode, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import type { FlashcardContent } from '@/features/materials/blocks';
import { RatingTiles } from '@/features/study/RatingTiles';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import type { SrsRating } from '@/lib/srs';
import { CardBack, CardFront } from './CardView';

/* The card on its stack, shared by flashcard study (study page, shared page,
   note embed), the review session and Quick review. Compact is the note
   embed's and Quick review's shorter card. */

type Leaving = { card: FlashcardContent; flipped: boolean };

/** The stack's flip and move state. `move` remounts the card so it animates
 * in: rising from the stack while the card it replaces swipes away to the top
 * left, or for `back` swiping back from there. */
export function useCardStack() {
  const [flipped, setFlipped] = useState(false);
  const [turn, setTurn] = useState({ back: false, n: 0 });
  const [leaving, setLeaving] = useState<Leaving | null>(null);
  return {
    flipped,
    leaving,
    move(from: FlashcardContent | undefined, back = false) {
      setLeaving(from && !back ? { card: from, flipped } : null);
      setTurn((t) => ({ back, n: t.n + 1 }));
      setFlipped(false);
    },
    reset() {
      setFlipped(false);
      setLeaving(null);
    },
    setFlipped,
    setLeaving,
    turn,
  };
}

export type CardStackState = ReturnType<typeof useCardStack>;

export function CardStack({
  card,
  compact,
  onRate,
  rated,
  stack,
}: {
  card: FlashcardContent;
  compact?: boolean;
  onRate: (rating: SrsRating) => void;
  /** A card shown again after it was rated: its ratings are read only. */
  rated?: SrsRating;
  stack: CardStackState;
}) {
  const { flipped, leaving, setFlipped, setLeaving, turn } = stack;
  return (
    <div className={cn('relative', compact ? 'pt-5' : 'pt-6')}>
      <div
        className={cn(
          'absolute top-0 rounded-card-lg bg-solid-accent-1/20',
          compact ? 'inset-x-8 h-10' : 'inset-x-12 h-15'
        )}
      />
      <div
        className={cn(
          'absolute rounded-card-lg bg-solid-accent-1/40',
          compact ? 'inset-x-4 top-2.5 h-10' : 'inset-x-6 top-3 h-15'
        )}
      />
      <StudyCard
        card={card}
        className={cn(
          turn.n > 0 &&
            (turn.back
              ? 'motion-safe:motion-card-swipe-in'
              : 'motion-safe:motion-card-rise')
        )}
        compact={compact}
        flipped={flipped}
        key={turn.n}
        onFlip={() => setFlipped((f) => !f)}
        onRate={onRate}
        rated={rated}
      />
      {leaving && (
        <StudyCard
          card={leaving.card}
          className={cn(
            // Its ratings stay put instead of rising in again.
            'motion-safe:motion-card-swipe-out pointer-events-none absolute inset-x-0 motion-reduce:hidden [&_button]:[animation:none]',
            compact ? 'top-5' : 'top-6'
          )}
          compact={compact}
          flipped={leaving.flipped}
          inert
          key={`leaving-${turn.n}`}
          onAnimationEnd={() => setLeaving(null)}
        />
      )}
    </div>
  );
}

/** One card face in the stack: clicking flips it, and its back carries the
 * ratings. A flip swaps the text in place: the new face enters while a copy
 * of the old one leaves over it. */
function StudyCard({
  card,
  className,
  compact,
  flipped,
  inert,
  onAnimationEnd,
  onFlip,
  onRate,
  rated,
}: {
  card: FlashcardContent;
  className?: string;
  compact?: boolean;
  flipped: boolean;
  rated?: SrsRating;
  /** The copy swiping away: shown only, never focused or clicked. */
  inert?: boolean;
  onAnimationEnd?: () => void;
  onFlip?: () => void;
  onRate?: (rating: SrsRating) => void;
}) {
  // Flips since this card mounted; the face before the latest one leaves.
  const [flip, setFlip] = useState({ flipped, n: 0 });
  const [leaving, setLeaving] = useState<boolean | null>(null);
  if (flip.flipped !== flipped) {
    setLeaving(flip.flipped);
    setFlip({ flipped, n: flip.n + 1 });
  }
  const padding = compact ? 'p-5' : 'p-8';
  const face = (back: boolean): ReactNode =>
    back ? (
      <div className={cn(!compact && 'text-lg')}>
        <CardBack card={card} />
      </div>
    ) : (
      <CardFront card={card} size={compact ? 'compact' : 'large'} />
    );
  return (
    <div
      aria-hidden={inert}
      className={cn(
        'relative flex w-full flex-col overflow-hidden rounded-card-lg border border-line bg-surface shadow-card',
        compact ? 'h-[clamp(220px,30vh,260px)]' : 'h-[clamp(300px,48vh,400px)]',
        className
      )}
      inert={inert}
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget) onAnimationEnd?.();
      }}
    >
      <button
        aria-label={
          flipped ? m.flashcards_answer() : m.flashcards_show_answer()
        }
        className={cn(
          'relative flex min-h-0 w-full flex-1 flex-col items-center justify-center overflow-auto',
          padding
        )}
        onClick={onFlip}
        type="button"
      >
        <div
          className={cn(flip.n > 0 && 'motion-safe:motion-card-face-in')}
          key={flip.n}
        >
          {face(flipped)}
        </div>
        {!flipped && (
          <Icon
            className={cn(
              'absolute text-fg-muted opacity-60',
              compact ? 'bottom-3' : 'bottom-4'
            )}
            name="refresh"
            size={compact ? 16 : 20}
          />
        )}
      </button>
      {flipped && (
        <div className={cn(compact ? 'px-3 pb-3' : 'px-4 pb-4')}>
          <RatingTiles chosen={rated} onRate={(rating) => onRate?.(rating)} />
        </div>
      )}
      {leaving !== null && (
        // Laid out like the face it was, the ratings' room kept but unseen.
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 flex flex-col motion-reduce:hidden"
          inert
        >
          <div
            className={cn(
              'flex min-h-0 flex-1 flex-col items-center justify-center',
              padding
            )}
          >
            <div
              className="motion-safe:motion-card-face-out"
              key={flip.n}
              onAnimationEnd={() => setLeaving(null)}
            >
              {face(leaving)}
            </div>
          </div>
          {leaving && (
            <div
              className={cn('invisible', compact ? 'px-3 pb-3' : 'px-4 pb-4')}
            >
              <RatingTiles onRate={() => undefined} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

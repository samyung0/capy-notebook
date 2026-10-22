import { type ReactNode, useState } from 'react';
import type { FlashcardContent } from '@/features/materials/blocks';
import { RatingTiles } from '@/features/study/RatingTiles';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import type { SrsRating } from '@/lib/srs';
import { CardBackFace, CardFront } from './CardView';

/* The study card, shared by flashcard study (study page, shared page, note
   embed), the review session and Quick review. Its front reads the card's
   chapter where the page shows it nowhere else, the text and "Click to
   flip". Compact is the
   note embed's shorter card; panel is Quick review's, visibly smaller still
   (narrower, shorter, smaller front text) so it sits clear of the study
   panel's sides. */

export type CardStackSize = 'large' | 'compact' | 'panel';

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
  label,
  onRate,
  rated,
  size,
  stack,
}: {
  card: FlashcardContent;
  /** The front's label: the card's chapter, where the page names it
   * nowhere else. */
  label?: string;
  onRate: (rating: SrsRating) => void;
  /** A card shown again after it was rated: its ratings are read only. */
  rated?: SrsRating;
  size: CardStackSize;
  stack: CardStackState;
}) {
  const { flipped, leaving, setFlipped, setLeaving, turn } = stack;
  return (
    <div
      className={cn(
        'relative',
        size === 'panel' && 'mx-auto w-full max-w-[360px]'
      )}
    >
      <StudyCard
        card={card}
        className={cn(
          turn.n > 0 &&
            (turn.back
              ? 'motion-safe:motion-card-swipe-in'
              : 'motion-safe:motion-card-rise')
        )}
        flipped={flipped}
        key={turn.n}
        label={label}
        onFlip={() => setFlipped((f) => !f)}
        onRate={onRate}
        rated={rated}
        size={size}
      />
      {leaving && (
        <StudyCard
          card={leaving.card}
          className={cn(
            // Its ratings stay put instead of rising in again.
            'motion-safe:motion-card-swipe-out pointer-events-none absolute inset-x-0 top-0 motion-reduce:hidden [&_button]:[animation:none]'
          )}
          flipped={leaving.flipped}
          inert
          key={`leaving-${turn.n}`}
          label={label}
          onAnimationEnd={() => setLeaving(null)}
          size={size}
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
  flipped,
  inert,
  label,
  onAnimationEnd,
  onFlip,
  onRate,
  rated,
  size,
}: {
  card: FlashcardContent;
  className?: string;
  flipped: boolean;
  rated?: SrsRating;
  /** The copy swiping away: shown only, never focused or clicked. */
  inert?: boolean;
  label?: string;
  onAnimationEnd?: () => void;
  onFlip?: () => void;
  onRate?: (rating: SrsRating) => void;
  size: CardStackSize;
}) {
  const compact = size !== 'large';
  // Flips since this card mounted; the face before the latest one leaves.
  const [flip, setFlip] = useState({ flipped, n: 0 });
  const [leaving, setLeaving] = useState<boolean | null>(null);
  if (flip.flipped !== flipped) {
    setLeaving(flip.flipped);
    setFlip({ flipped, n: flip.n + 1 });
  }
  const padding = size === 'large' ? 'p-8' : size === 'compact' ? 'p-5' : 'p-4';
  // Each face fills the card: the front centred in its padding, the back with
  // the front's text pinned on top.
  const face = (back: boolean): ReactNode =>
    back ? (
      <CardBackFace card={card} className="flex-1" size={size} />
    ) : (
      <div
        className={cn(
          'flex flex-1 flex-col items-center justify-center text-center text-fg-muted',
          compact ? 'gap-2 text-sm' : 'gap-4',
          size === 'panel' && 'gap-1.5 text-xs',
          padding
        )}
      >
        {label && <span className="line-clamp-1">{label}</span>}
        <CardFront card={card} className="text-fg" size={size} />
        <span>{m.flashcards_click_to_flip()}</span>
      </div>
    );
  return (
    <div
      aria-hidden={inert}
      className={cn(
        'relative flex w-full flex-col overflow-hidden rounded-card-lg border border-line bg-surface shadow-card',
        size === 'large' && 'h-[clamp(300px,48vh,400px)]',
        size === 'compact' && 'h-[clamp(220px,30vh,260px)]',
        size === 'panel' && 'h-[clamp(160px,22vh,190px)]',
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
          // Inset ring: the card's overflow clips an outer one to a bar.
          // No scrollbar: the ratings arriving with a flip briefly overflow it.
          'relative flex min-h-0 w-full flex-1 flex-col overflow-auto rounded-t-card-lg [scrollbar-width:none] focus-visible:ring-inset [&::-webkit-scrollbar]:hidden',
          !flipped && 'rounded-b-card-lg'
        )}
        onClick={onFlip}
        type="button"
      >
        <div
          className={cn(
            'flex w-full flex-1 flex-col',
            // The back scrolls its answer under the pinned front.
            flipped && 'min-h-0',
            flip.n > 0 && 'motion-safe:motion-card-face-in'
          )}
          key={flip.n}
        >
          {face(flipped)}
        </div>
      </button>
      {flipped && (
        <div className={cn(compact ? 'px-3 pb-3' : 'px-4 pb-4')}>
          <RatingTiles
            chosen={rated}
            dense={size === 'panel'}
            onRate={(rating) => onRate?.(rating)}
          />
        </div>
      )}
      {leaving !== null && (
        // Laid out like the face it was, the ratings' room kept but unseen.
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 flex flex-col motion-reduce:hidden"
          inert
        >
          <div className="flex min-h-0 flex-1 flex-col">
            <div
              className="motion-safe:motion-card-face-out flex min-h-0 w-full flex-1 flex-col"
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
              <RatingTiles dense={size === 'panel'} onRate={() => undefined} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

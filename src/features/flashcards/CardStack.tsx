import { type ReactNode, useState } from 'react';
import type { FlashcardContent } from '@/features/materials/blocks';
import { RatingTiles } from '@/features/study/RatingTiles';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import type { SrsRating } from '@/lib/srs';
import { CardBackFace, CardFront } from './CardView';

/* The study card, shared by flashcard study (study page, shared page, note
   embed), the review session and the card dialog's preview. Its front reads
   the card's chapter where the page shows it nowhere else, the text and
   "Click to flip". */

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
  stack,
}: {
  card: FlashcardContent;
  /** The front's label: the card's chapter, where the page names it
   * nowhere else. */
  label?: string;
  onRate: (rating: SrsRating) => void;
  /** A card shown again after it was rated: its ratings are read only. */
  rated?: SrsRating;
  stack: CardStackState;
}) {
  const { flipped, leaving, setFlipped, setLeaving, turn } = stack;
  return (
    <div className="relative">
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
        />
      )}
    </div>
  );
}

/** The card dialog's preview: the study card turned to the answer, front
 * pinned on top, until a click flips it to the front (Epo 2026-10-25). */
export function CardPreview({ card }: { card: FlashcardContent }) {
  const [flipped, setFlipped] = useState(true);
  return (
    <StudyCard
      card={card}
      flipped={flipped}
      onFlip={() => setFlipped((f) => !f)}
      ratings={false}
    />
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
  ratings = true,
}: {
  card: FlashcardContent;
  className?: string;
  flipped: boolean;
  rated?: SrsRating;
  /** Off for a preview: the back shows no ratings. */
  ratings?: boolean;
  /** The copy swiping away: shown only, never focused or clicked. */
  inert?: boolean;
  label?: string;
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
  // Each face fills the card: the front centred in its padding, the back with
  // the front's text pinned on top.
  const face = (back: boolean): ReactNode =>
    back ? (
      <CardBackFace card={card} className="flex-1" size="compact" />
    ) : (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-5 text-center text-fg-muted text-sm">
        {label && <span className="line-clamp-1">{label}</span>}
        <CardFront card={card} className="text-fg" size="compact" />
        <span>{m.flashcards_click_to_flip()}</span>
      </div>
    );
  return (
    <div
      aria-hidden={inert}
      className={cn(
        'relative flex w-full flex-col overflow-hidden rounded-flashcard border border-line bg-surface frosted:bg-(--frost-fill) shadow-card',
        // Grows with a long back up to its cap, then the answer scrolls under
        // the front.
        'max-h-[clamp(320px,50vh,440px)] min-h-[clamp(220px,30vh,260px)]',
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
          !(flipped && ratings) && 'rounded-b-card-lg'
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
      {flipped && ratings && (
        <div className="px-3 pt-2 pb-3">
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
          <div className="flex min-h-0 flex-1 flex-col">
            <div
              className="motion-safe:motion-card-face-out flex min-h-0 w-full flex-1 flex-col"
              key={flip.n}
              onAnimationEnd={() => setLeaving(null)}
            >
              {face(leaving)}
            </div>
          </div>
          {leaving && ratings && (
            <div className="invisible px-3 pt-2 pb-3">
              <RatingTiles onRate={() => undefined} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

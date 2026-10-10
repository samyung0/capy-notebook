import { type ReactNode, useState } from 'react';
import type { Provenance } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import type { FlashcardContent } from '@/features/materials/blocks';
import { MaterialAttributionFooter } from '@/features/materials/MaterialAttributionFooter';
import { type Frame, NoFrame } from '@/features/quizzes/AttemptBody';
import { type Crumb, QuizPageHeader } from '@/features/quizzes/QuizPage';
import { RatingTiles } from '@/features/study/RatingTiles';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import type { SrsRating } from '@/lib/srs';
import { CardBack, CardFront } from './CardView';

/* Studying a flashcard set, shared by the app page and the public /share page.
   It knows no router or session: callers pass the frame and where ratings go. */

/** One study session over every card in order: Again sends a card to the end,
 * the others move on. A card with both faces blank (a new set's placeholder)
 * takes no rating. */
export function StudyBody({
  actions,
  byline,
  cards,
  embedded,
  footer,
  frame,
  name,
  onBack,
  onFinished,
  onRate,
  provenance,
  topBar,
  trail,
}: {
  actions?: ReactNode;
  /** Public pages: the owner under the title. */
  byline?: ReactNode;
  cards: FlashcardContent[];
  /** Inside a note: no header, frame or page padding. */
  embedded?: boolean;
  footer?: ReactNode;
  frame?: Frame;
  name: string;
  onBack?: () => void;
  onFinished?: (total: number) => void;
  onRate: (card: FlashcardContent, rating: SrsRating) => void;
  provenance?: Provenance;
  /** The app's top bar; public pages have their own header and pass none. */
  topBar?: ReactNode;
  trail: Crumb[];
}) {
  const Shell = frame ?? NoFrame;
  const studyIds = () =>
    cards.filter((c) => c.front.trim() || c.back.trim()).map((c) => c.id);
  const [queue, setQueue] = useState(studyIds);
  // Cards shown before the current one, most recent last, for Previous.
  const [history, setHistory] = useState<string[]>([]);
  const [total, setTotal] = useState(queue.length);
  const [flipped, setFlipped] = useState(false);
  // Each move remounts the card so it animates in: rising from the stack,
  // or for Previous swiping back from the top left.
  const [turn, setTurn] = useState({ back: false, n: 0 });
  // The card swiping away on top of the next one.
  const [leaving, setLeaving] = useState<{
    card: FlashcardContent;
    flipped: boolean;
  } | null>(null);
  const card = cards.find((c) => c.id === queue[0]);

  function move(next: string[], nextHistory: string[], back = false) {
    setLeaving(card && !back ? { card, flipped } : null);
    setTurn((t) => ({ back, n: t.n + 1 }));
    setQueue(next);
    setHistory(nextHistory);
    setFlipped(false);
  }

  function rate(rating: SrsRating) {
    if (!card) return;
    onRate(card, rating);
    const [head, ...rest] = queue;
    const next = rating === 'again' ? [...rest, head] : rest;
    move(next, [...history, head]);
    if (next.length === 0) onFinished?.(total);
  }

  /** Skips without rating: the card waits at the end of the session. */
  function skip() {
    const [head, ...rest] = queue;
    move([...rest, head], [...history, head]);
  }

  function previous() {
    const prev = history.at(-1);
    if (!prev) return;
    move(
      [prev, ...queue.filter((id) => id !== prev)],
      history.slice(0, -1),
      true
    );
  }

  function studyAgain() {
    const ids = studyIds();
    setQueue(ids);
    setHistory([]);
    setTotal(ids.length);
    setFlipped(false);
    setLeaving(null);
  }

  const position =
    card &&
    m.flashcards_card_of_total({ position: total - queue.length + 1, total });

  return (
    <Shell
      header={
        !embedded && (
          <QuizPageHeader
            actions={actions}
            byline={byline}
            // Public pages have no label row, so the title sits higher.
            className={byline ? 'pt-2 sm:pt-2' : undefined}
            onBack={onBack}
            title={name}
            topBar={topBar}
            trail={trail}
          />
        )
      }
    >
      <div
        className={cn(!embedded && 'px-4 pt-8 pb-8 sm:px-6 lg:px-10 xl:px-16')}
      >
        <div className="mx-auto flex max-w-160 flex-col gap-6">
          {card ? (
            <>
              <div>
                <p className="t-meta mb-1 text-center text-fg-muted">
                  {position}
                </p>
                <div className="relative pt-6">
                  <div className="absolute inset-x-12 top-0 h-15 rounded-card-lg bg-solid-accent-1/20" />
                  <div className="absolute inset-x-6 top-3 h-15 rounded-card-lg bg-solid-accent-1/40" />
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
                    onFlip={() => setFlipped((f) => !f)}
                    onRate={rate}
                  />
                  {leaving && (
                    <StudyCard
                      card={leaving.card}
                      className="motion-safe:motion-card-swipe-out pointer-events-none absolute inset-x-0 top-6 motion-reduce:hidden"
                      flipped={leaving.flipped}
                      inert
                      key={`leaving-${turn.n}`}
                      onAnimationEnd={() => setLeaving(null)}
                    />
                  )}
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  disabled={history.length === 0}
                  iconLeft="navigationBack"
                  onClick={previous}
                  rounded="large"
                  variant="outline"
                >
                  {m.action_previous()}
                </Button>
                <Button
                  disabled={queue.length < 2}
                  iconRight="navigationForward"
                  onClick={skip}
                  rounded="large"
                  variant="outline"
                >
                  {m.action_next()}
                </Button>
              </div>
            </>
          ) : (
            <div className="flex flex-col items-center gap-4 py-16 text-center">
              <span className="flex h-16 w-16 items-center justify-center rounded-card-lg bg-tint-success text-tint-success-fg">
                <Icon className="non-scaling-svg" name="check" size={30} />
              </span>
              <h2 className="t-large-card-title">
                {total === 0
                  ? m.flashcards_empty_flashcards()
                  : m.flashcards_session_done()}
              </h2>
              {total > 0 && (
                <Button
                  iconLeft="flashcards"
                  onClick={studyAgain}
                  rounded="large"
                  variant="accent"
                >
                  {m.flashcards_study_again()}
                </Button>
              )}
            </div>
          )}
          {footer}
          <MaterialAttributionFooter provenance={provenance} />
        </div>
      </div>
    </Shell>
  );
}

/** One card face in the stack: clicking flips it, and its back carries the
 * ratings. */
function StudyCard({
  card,
  className,
  flipped,
  inert,
  onAnimationEnd,
  onFlip,
  onRate,
}: {
  card: FlashcardContent;
  className?: string;
  flipped: boolean;
  /** The copy swiping away: shown only, never focused or clicked. */
  inert?: boolean;
  onAnimationEnd?: () => void;
  onFlip?: () => void;
  onRate?: (rating: SrsRating) => void;
}) {
  return (
    <div
      aria-hidden={inert}
      className={cn(
        'relative flex h-[clamp(300px,48vh,400px)] w-full flex-col overflow-hidden rounded-card-lg border border-line bg-surface shadow-card',
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
        className="relative flex min-h-0 w-full flex-1 flex-col items-center justify-center overflow-auto p-8"
        onClick={onFlip}
        type="button"
      >
        {flipped ? (
          <div className="text-lg">
            <CardBack card={card} />
          </div>
        ) : (
          <>
            <CardFront card={card} large />
            <Icon
              className="absolute bottom-4 text-fg-muted opacity-60"
              name="refresh"
              size={20}
            />
          </>
        )}
      </button>
      {flipped && (
        <div className="px-4 pb-4">
          <RatingTiles onRate={(rating) => onRate?.(rating)} />
        </div>
      )}
    </div>
  );
}

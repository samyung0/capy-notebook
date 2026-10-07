import { Fragment, type ReactNode, useState } from 'react';
import type { MaterialAuthor, Provenance } from '@/api/types';
import { PublicByline } from '@/components/app/PublicHeader';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import type { FlashcardContent } from '@/features/materials/blocks';
import { MaterialAttributionFooter } from '@/features/materials/MaterialAttributionFooter';
import { QuizPageHeader } from '@/features/quizzes/QuizPage';
import { RatingTiles } from '@/features/study/RatingTiles';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import type { SrsRating } from '@/lib/srs';
import { CardBack, CardFront } from './CardView';

/* Studying a flashcard set, shared by the app page and the public /share page.
   It knows no router or session: callers pass the frame and where ratings go. */

type Frame = (props: { children: ReactNode }) => ReactNode;

/** One study session over every card in order: Again sends a card to the end,
 * the others move on. A card with both faces blank (a new set's placeholder)
 * takes no rating. */
export function StudyBody({
  actions,
  author,
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
  /** Public pages: the owner under the title, and the card count above the
   * card instead of in the header. */
  author?: MaterialAuthor;
  cards: FlashcardContent[];
  /** Inside a note: no header, frame or page padding, and no Show answer
   * button (the card flips when clicked); the card count sits above it. */
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
  trail: string[];
}) {
  const Shell = frame ?? Fragment;
  const studyIds = () =>
    cards.filter((c) => c.front.trim() || c.back.trim()).map((c) => c.id);
  const [queue, setQueue] = useState(studyIds);
  const [total, setTotal] = useState(queue.length);
  const [flipped, setFlipped] = useState(false);
  const card = cards.find((c) => c.id === queue[0]);

  function rate(rating: SrsRating) {
    if (!card) return;
    onRate(card, rating);
    setFlipped(false);
    const [head, ...rest] = queue;
    const next = rating === 'again' ? [...rest, head] : rest;
    setQueue(next);
    if (next.length === 0) onFinished?.(total);
  }

  function studyAgain() {
    const ids = studyIds();
    setQueue(ids);
    setTotal(ids.length);
    setFlipped(false);
  }

  const position =
    card &&
    m.flashcards_card_of_total({ position: total - queue.length + 1, total });

  return (
    <Shell>
      {!embedded && (
        <QuizPageHeader
          actions={actions}
          byline={author && <PublicByline author={author} />}
          // Public pages have no label row, so the title sits higher.
          className={author ? 'pt-2 sm:pt-2' : undefined}
          meta={
            !author &&
            position && <span className="t-subtitle">{position}</span>
          }
          onBack={onBack}
          title={name}
          topBar={topBar}
          trail={trail}
        />
      )}
      <div
        className={cn(!embedded && 'px-4 pt-8 pb-8 sm:px-6 lg:px-10 xl:px-16')}
      >
        <div className="mx-auto flex max-w-160 flex-col gap-6">
          {card ? (
            <>
              <div>
                {(author || embedded) && (
                  <p className="t-subtitle mb-1 text-fg-muted">{position}</p>
                )}
                <div className="relative pt-6">
                  <div className="absolute inset-x-12 top-0 h-15 rounded-card-lg bg-solid-accent-1/20" />
                  <div className="absolute inset-x-6 top-3 h-15 rounded-card-lg bg-solid-accent-1/40" />
                  <button
                    aria-label={
                      flipped ? m.flashcards_answer() : m.flashcards_term()
                    }
                    className="relative flex h-[clamp(300px,48vh,400px)] w-full flex-col items-center justify-center overflow-auto rounded-card-lg border border-line bg-surface p-8 shadow-card"
                    onClick={() => setFlipped((f) => !f)}
                    type="button"
                  >
                    {flipped ? (
                      <div className="text-lg">
                        <CardBack card={card} />
                      </div>
                    ) : (
                      <CardFront card={card} large />
                    )}
                    <Icon
                      className="absolute bottom-4 text-fg-muted opacity-60"
                      name="refresh"
                      size={20}
                    />
                  </button>
                </div>
              </div>
              {flipped ? (
                <RatingTiles onRate={rate} />
              ) : (
                !embedded && (
                  <Button
                    fullWidth
                    iconLeft="view"
                    onClick={() => setFlipped(true)}
                    rounded="large"
                  >
                    {m.flashcards_show_answer()}
                  </Button>
                )
              )}
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

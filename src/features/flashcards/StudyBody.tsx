import { type ReactNode, useState } from 'react';
import type { Provenance } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import type { FlashcardContent } from '@/features/materials/blocks';
import { MaterialAttributionFooter } from '@/features/materials/MaterialAttributionFooter';
import { type Frame, NoFrame } from '@/features/quizzes/AttemptBody';
import { type Crumb, QuizPageHeader } from '@/features/quizzes/QuizPage';
import { StepNav } from '@/features/study/StepNav';
import { currentStep, useSteps } from '@/features/study/steps';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import type { SrsRating } from '@/lib/srs';
import { CardStack, useCardStack } from './CardStack';

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
  const [ids, setIds] = useState(studyIds);
  const steps = useSteps<SrsRating>(ids);
  const stack = useCardStack();
  const shown = steps.current;
  const card = shown && cards.find((c) => c.id === shown.key);

  function rate(rating: SrsRating) {
    if (!card) return;
    onRate(card, rating);
    const next = steps.answer(rating, { requeue: rating === 'again' });
    stack.move(card);
    if (!currentStep(next)) onFinished?.(ids.length);
  }

  /** Skips without rating, or moves forward again after Previous. */
  function next() {
    stack.move(card ?? undefined);
    steps.next();
  }

  function previous() {
    stack.move(card ?? undefined, true);
    steps.previous();
  }

  function studyAgain() {
    const fresh = studyIds();
    setIds(fresh);
    steps.reset(fresh);
    stack.reset();
  }

  // The card's own place in the set, which stays put as it is skipped or
  // shown again.
  const position =
    card &&
    m.flashcards_card_of_total({
      position: ids.indexOf(card.id) + 1,
      total: ids.length,
    });
  const total = ids.length;

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
                <CardStack
                  card={card}
                  compact={embedded}
                  onRate={rate}
                  rated={shown.record}
                  stack={stack}
                />
              </div>
              <StepNav
                canNext={!!shown?.past || steps.steps.queue.length > 1}
                canPrevious={steps.steps.cursor > 0}
                className="pt-2"
                onNext={next}
                onPrevious={previous}
              />
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

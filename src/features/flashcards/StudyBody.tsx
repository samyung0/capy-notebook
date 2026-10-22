import { type ReactNode, useEffect, useState } from 'react';
import type { AttemptCard, PreviousAttempt, Provenance } from '@/api/types';
import { TabContent } from '@/components/app/tabPanel';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import type { FlashcardContent } from '@/features/materials/blocks';
import { SourcesLine } from '@/features/materials/MaterialAttributionFooter';
import {
  type Crumb,
  type Frame,
  NoFrame,
  QuizPageHeader,
} from '@/features/quizzes/QuizPageHeader';
import { attemptMinutes } from '@/features/study/attempts';
import { StepNav } from '@/features/study/StepNav';
import { StudyPosition } from '@/features/study/StudyPosition';
import { currentStep, useSteps } from '@/features/study/steps';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { SRS_RATINGS, type SrsRating } from '@/lib/srs';
import { CardStack, useCardStack } from './CardStack';
import { FlashcardResult } from './FlashcardResult';

/** One study run, which the server records as a flashcard attempt from its
 * first rating (workspace sets only). */
export interface StudyAttempt {
  id: string;
  startedAt: string;
}

const newAttempt = (): StudyAttempt => ({
  id: crypto.randomUUID(),
  startedAt: new Date().toISOString(),
});

/* Studying a flashcard set, shared by the app page and the public /share page.
   It knows no router or session: callers pass the frame, where ratings go and,
   for a run the server records, how its result reads the previous attempt. */

/** The cards a study session holds, in set order: those with a face, and
 * any the session holds already (`held`) even while blank, so a card an
 * editor retypes keeps its place and is not rated twice (REVIEW3 N6). */
export function studyIds(cards: FlashcardContent[], held: string[] = []) {
  const kept = new Set(held);
  return cards
    .filter((c) => kept.has(c.id) || c.front.trim() || c.back.trim())
    .map((c) => c.id);
}

/** One study session over every card in order: Again sends a card to the end,
 * the others move on. A card with both faces blank (a new set's placeholder)
 * takes no rating. */
export function StudyBody({
  actions,
  byline,
  cards,
  chapter,
  embedded,
  footer,
  frame,
  name,
  onBack,
  onFinished,
  onRate,
  provenance,
  usePrevious,
  trail,
}: {
  actions?: ReactNode;
  /** Public pages: the owner under the title. */
  byline?: ReactNode;
  cards: FlashcardContent[];
  /** The set's chapter, the cards' label. */
  chapter?: string;
  /** Inside a note: no header, frame or page padding. */
  embedded?: boolean;
  footer?: ReactNode;
  frame?: Frame;
  name: string;
  onBack?: () => void;
  onFinished?: (total: number) => void;
  onRate: (
    card: FlashcardContent,
    rating: SrsRating,
    attempt: StudyAttempt
  ) => void;
  provenance?: Provenance;
  /** A recorded run's result reads the set's attempt before it (a hook: the
   * app reads the run's attempt back; share pages pass none). */
  usePrevious?: (attemptId: string) => PreviousAttempt | undefined;
  trail: Crumb[];
}) {
  const Shell = frame ?? NoFrame;
  const [ids, setIds] = useState(() => studyIds(cards));
  const [attempt, setAttempt] = useState(newAttempt);
  // The run's cards in the order first rated, for its result.
  const [rated, setRated] = useState<AttemptCard[]>([]);
  const steps = useSteps<SrsRating>(ids);
  const stack = useCardStack();
  const shown = steps.current;
  const card = shown && cards.find((c) => c.id === shown.key);
  // Cards change while studying (Epo 2026-10-10): a removed card leaves the
  // session, an added one joins its end; edits show on the cards in place.
  useEffect(() => {
    const live = studyIds(cards, ids);
    if (live.join('\u0000') === ids.join('\u0000')) return;
    setIds(live);
    steps.follow(live);
  }, [cards]);

  function rate(rating: SrsRating) {
    if (!card) return;
    onRate(card, rating, attempt);
    const n = SRS_RATINGS.indexOf(rating) + 1;
    setRated((list) =>
      list.some((c) => c.id === card.id)
        ? list.map((c) =>
            c.id === card.id ? { ...c, ratings: [...c.ratings, n] } : c
          )
        : [
            ...list,
            {
              back: card.back,
              front: card.front,
              id: card.id,
              image: card.image,
              ratings: [n],
            },
          ]
    );
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
    const fresh = studyIds(cards);
    setIds(fresh);
    steps.reset(fresh);
    stack.reset();
    setAttempt(newAttempt());
    setRated([]);
  }

  // The card's own place in the set, which stays put as it is skipped or
  // shown again.
  const position = card ? ids.indexOf(card.id) + 1 : 0;
  const total = ids.length;
  const header = !embedded && (
    <QuizPageHeader
      actions={actions}
      byline={byline}
      // Public pages have no label row, so the title sits higher.
      className={byline ? 'pt-4 sm:pt-2' : undefined}
      onBack={onBack}
      title={name}
      trail={trail}
    />
  );

  // The run's result, laid out as a quiz's (human/study-progress.md,
  // 2026-10-19); a fresh panel so it opens at the top.
  if (!card && total > 0) {
    const Body = embedded ? 'div' : TabContent;
    return (
      <Shell header={header} key="result">
        <Body>
          <RunResult
            attempt={attempt}
            cards={rated}
            usePrevious={usePrevious}
          />
          {/* Where a quiz result has Redo quiz, sized like it. */}
          <div className="mt-12 flex justify-end">
            <Button
              className="h-7 gap-1 px-2.5 text-xs sm:h-7.5 sm:gap-1.75 sm:px-4 sm:text-sm"
              iconLeft="refresh"
              onClick={studyAgain}
              rounded="large"
              size="sm"
              variant="outline"
            >
              {m.flashcards_study_again()}
            </Button>
          </div>
          {footer}
          <SourcesLine
            className={embedded ? 'mt-3' : 'mt-16 pb-4'}
            provenance={provenance}
          />
        </Body>
      </Shell>
    );
  }

  return (
    <Shell header={header}>
      <div
        className={cn(!embedded && 'px-4 pt-8 pb-8 sm:px-6 lg:px-10 xl:px-16')}
      >
        <div className="mx-auto flex max-w-160 flex-col gap-6">
          {card ? (
            <>
              <div>
                {embedded ? (
                  <p className="t-meta mb-1 text-center text-fg-muted">
                    {m.flashcards_card_of_total({ position, total })}
                  </p>
                ) : (
                  <StudyPosition
                    className="mb-5"
                    position={position}
                    total={total}
                  />
                )}
                <CardStack
                  card={card}
                  label={chapter}
                  onRate={rate}
                  rated={shown.record}
                  size={embedded ? 'compact' : 'large'}
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
                {m.flashcards_empty_flashcards()}
              </h2>
            </div>
          )}
          {footer}
          <SourcesLine
            className={embedded ? 'mt-3' : 'mt-16 pb-4'}
            provenance={provenance}
          />
        </div>
      </div>
    </Shell>
  );
}

/** A finished run's result, timed to when it finished. */
function RunResult({
  attempt,
  cards,
  usePrevious = () => undefined,
}: {
  attempt: StudyAttempt;
  cards: AttemptCard[];
  usePrevious?: (attemptId: string) => PreviousAttempt | undefined;
}) {
  const [takenAt] = useState(() => new Date().toISOString());
  const previous = usePrevious(attempt.id);
  return (
    <FlashcardResult
      cards={cards}
      minutes={attemptMinutes({ startedAt: attempt.startedAt, takenAt })}
      previous={previous}
    />
  );
}

import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';
import { invalidateStudy, useRateReviewItem } from '@/api/hooks';
import type { ReviewItem, UnfinishedSession } from '@/api/types';
import { UnderlineLink } from '@/components/ui/UnderlineLink';
import { userToast } from '@/components/ui/userToast';
import { CardStack, useCardStack } from '@/features/flashcards/CardStack';
import { relativeTime } from '@/features/materials/MaterialListCard';
import type { Question } from '@/features/questions/types';
import type { Answers } from '@/features/quizzes/grade';
import { CheckedQuestion, QuestionItem } from '@/features/study/ReviewQuestion';
import { StepNav } from '@/features/study/StepNav';
import {
  answerStep,
  currentStep,
  nextStep,
  previousStep,
  type Steps,
  useSteps,
} from '@/features/study/steps';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { iconUrl } from '@/lib/icon-catalog';
import { SRS_RATINGS, type SrsRating } from '@/lib/srs';
import { useMediaQuery } from '@/lib/useMediaQuery';
import { reviewCard } from './ratings';

/* The Study page's quick actions (human/study-progress.md 2026-10-18/19):
 * the whole workspace's review and Quick review. */

function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col">
      <div className="flex items-baseline justify-between gap-3 pb-1.5">
        <h3 className="font-bold">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** The whole workspace's review: Continue review picks up its latest
 * unfinished session, otherwise Review starts a new one. Either way the
 * session is recorded with its first answer. */
export function WorkspaceReview({
  workspaceId,
  iconId,
  reviewable,
  unfinished,
}: {
  workspaceId: string;
  iconId?: string;
  reviewable: number;
  unfinished?: UnfinishedSession;
}) {
  const navigate = useNavigate();
  return (
    <div className="flex items-start gap-2">
      {iconId ? (
        <img
          alt=""
          className="mt-0.5 size-3.75 shrink-0 rounded-[3px]"
          height={15}
          src={iconUrl(iconId)}
          width={15}
        />
      ) : (
        <span className="size-3.75 shrink-0" />
      )}
      <span className="flex min-w-0 flex-1 translate-y-px flex-col gap-1">
        <span className="line-clamp-1">{m.study_whole_workspace()}</span>
        {unfinished && (
          <span className="text-fg-muted text-xs">
            {m.study_review_progress({
              answered: unfinished.answered,
              total: unfinished.total,
              when: relativeTime(unfinished.lastAnswerAt),
            })}
          </span>
        )}
      </span>
      <UnderlineLink
        disabled={!unfinished && !reviewable}
        onClick={() =>
          navigate({
            params: { workspaceId },
            search: unfinished
              ? { from: 'workspace', session: unfinished.id }
              : { from: 'workspace', group: 'workspace' },
            to: '/learning/review/$workspaceId',
          })
        }
      >
        {unfinished ? m.learning_continue_review() : m.study_review_button()}
      </UnderlineLink>
    </div>
  );
}

type QuickPhase = 'open' | 'leaving' | 'gone';

/** The Study tab's short practice: up to four flashcards and single-part
 * quick questions, picked by the server as a suggested review would. Ratings
 * and checks are recorded like any review. The round is the list as it was
 * when it began, kept while answers refresh the summary (answered items
 * leave it); once the last item is done the section dissolves into smoke and
 * stays gone until the workspace opens again. */
export function QuickReview({
  items,
  workspaceId,
}: {
  items: ReviewItem[];
  workspaceId: string;
}) {
  const [round, setRound] = useState(items);
  const [phase, setPhase] = useState<QuickPhase>('open');
  const reduceMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  // A round can only start once there is something to practise.
  if (round.length === 0 && items.length > 0 && phase === 'open')
    setRound(items);
  if (round.length === 0 || phase === 'gone') return null;
  // Reduced motion runs no animation, so there is no end to wait for.
  const finish = () => setPhase(reduceMotion ? 'gone' : 'leaving');
  const leaving = phase === 'leaving';

  return (
    <div
      className={cn(leaving ? 'motion-smoke-collapse' : 'grid grid-rows-[1fr]')}
      onTransitionEnd={(e) => {
        if (e.target === e.currentTarget) setPhase('gone');
      }}
    >
      <div
        className={cn('min-h-0', leaving && 'motion-smoke-out')}
        inert={leaving}
      >
        <QuickItems items={round} onDone={finish} workspaceId={workspaceId} />
      </div>
    </div>
  );
}

/** A card's rating, or a checked question with its key. */
type QuickRecord =
  | { rating: SrsRating }
  | { answers: Answers; question: Question };

/** One item at a time. Next skips an item to the end of the round; Previous
 * shows an answered one read only. A rated card moves on at once, and the
 * last rating keeps its card in place to dissolve with the section; a checked
 * question stays to show its result until Next. */
function QuickItems({
  items,
  onDone,
  workspaceId,
}: {
  items: ReviewItem[];
  onDone: () => void;
  workspaceId: string;
}) {
  const keyOf = (it: ReviewItem) => `${it.materialId}/${it.itemId}`;
  const steps = useSteps<QuickRecord>(items.map(keyOf));
  const [lastRating, setLastRating] = useState<SrsRating>();
  const stack = useCardStack();
  const qc = useQueryClient();
  const { mutateAsync: rateItem } = useRateReviewItem(workspaceId);
  const shown = steps.current;
  const item = shown && items.find((it) => keyOf(it) === shown.key);
  if (!item) return null;
  const record = shown.record;

  /** A card swipes away only over another card. */
  function move(after: Steps<QuickRecord>, back = false) {
    const to = currentStep(after);
    const next = to && items.find((it) => keyOf(it) === to.key);
    stack.move(
      item?.kind === 'card' && next?.kind === 'card'
        ? reviewCard(item)
        : undefined,
      back
    );
  }

  function rate(rating: SrsRating) {
    if (!item) return;
    rateItem({
      itemId: item.itemId,
      materialId: item.materialId,
      rating: SRS_RATINGS.indexOf(rating) + 1,
    }).catch(() =>
      userToast({
        id: 'quick-review-failed',
        title: m.flashcards_review_failed(),
        variant: 'error',
      })
    );
    const after = answerStep(steps.steps, { rating });
    if (!currentStep(after)) {
      setLastRating(rating);
      onDone();
      return;
    }
    move(after);
    steps.answer({ rating });
  }

  function next() {
    const after = nextStep(steps.steps);
    // Past the last checked question there is nothing left.
    if (!currentStep(after)) {
      onDone();
      return;
    }
    move(after);
    steps.next();
  }

  return (
    <Section
      aside={
        <span className="t-meta text-fg-muted">
          {m.study_quick_position({
            current: items.indexOf(item) + 1,
            total: items.length,
          })}
        </span>
      }
      title={m.study_quick_review()}
    >
      <div className="flex max-w-90 flex-col gap-2 pt-1">
        {item.kind === 'card' ? (
          <>
            <CardStack
              card={reviewCard(item)}
              onRate={rate}
              rated={record && 'rating' in record ? record.rating : lastRating}
              size="panel"
              stack={stack}
            />
            <p className="t-meta text-center text-fg-muted">
              {item.materialTitle}
            </p>
          </>
        ) : record && 'question' in record ? (
          <CheckedQuestion
            answers={record.answers}
            question={record.question}
            title={item.materialTitle}
          />
        ) : (
          <QuestionItem
            item={item}
            key={shown.key}
            onChecked={(graded, answers) => {
              void invalidateStudy(qc, workspaceId);
              steps.answer(
                { answers, question: graded.question },
                { stay: true }
              );
            }}
          />
        )}
        <StepNav
          canNext={shown.past || steps.steps.queue.length > 1 || !!record}
          canPrevious={steps.steps.cursor > 0}
          className="pt-2"
          onNext={next}
          onPrevious={() => {
            move(previousStep(steps.steps), true);
            steps.previous();
          }}
        />
      </div>
    </Section>
  );
}

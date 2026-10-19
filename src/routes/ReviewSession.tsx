import { useQueryClient } from '@tanstack/react-query';
import {
  linkOptions,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import {
  invalidateStudy,
  useFinishReviewSession,
  useRateReviewItem,
  useResumeReviewSession,
  useReviewOverview,
  useWorkspace,
  useWorkspaceReview,
} from '@/api/hooks';
import type {
  ReviewAnswer,
  ReviewItem,
  ReviewSessionRef,
  ReviewStart,
} from '@/api/types';
import { ErrorState } from '@/components/app/ErrorState';
import { PanelWithInvertedRadius } from '@/components/app/layout';
import { TopInsetBar } from '@/components/app/TopInsetBar';
import { ErrorAction } from '@/components/ui/Button';
import { SkeletonList } from '@/components/ui/feedback';
import { userToast } from '@/components/ui/userToast';
import { CardStack, useCardStack } from '@/features/flashcards/CardStack';
import { relativeTime } from '@/features/materials/MaterialListCard';
import type { Question } from '@/features/questions/types';
import type { Answers } from '@/features/quizzes/grade';
import { QuizPageHeader } from '@/features/quizzes/QuizPageHeader';
import { CheckedQuestion, QuestionItem } from '@/features/study/ReviewQuestion';
import {
  type ReviewRecord,
  ReviewSummary,
} from '@/features/study/ReviewSummary';
import { ratingQueue, reviewCard } from '@/features/study/ratings';
import type { ReviewSearch } from '@/features/study/reviewSearch';
import { StepNav } from '@/features/study/StepNav';
import {
  currentStep,
  recordOf,
  type Step,
  type Steps,
  useSteps,
} from '@/features/study/steps';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { unexpectedErrorId } from '@/lib/errors';
import { SRS_RATINGS } from '@/lib/srs';

/** A checked question's record keeps what it showed: the answers and the
 * graded question with its key. */
type ItemRecord = ReviewRecord & { answers?: Answers; question?: Question };

const keyOf = (it: { materialId: string; itemId: string }) =>
  `${it.materialId}/${it.itemId}`;

function recordOfAnswer(a: ReviewAnswer): ItemRecord {
  return a.kind === 'card'
    ? { rating: a.rating }
    : {
        answers: a.answers,
        correct: a.correct,
        question: a.question,
        rating: a.rating,
        total: a.total,
      };
}

function ratingFailed() {
  userToast({
    id: 'review-rating-failed',
    title: m.flashcards_review_failed(),
    variant: 'error',
  });
}

/** A review of one workspace: a suggestion's items, the whole workspace's,
 * or an unfinished session continued. Keyed by its search, so starting the
 * next suggestion from the summary is a new session. */
export default function ReviewSession() {
  const { workspaceId } = useParams({ strict: false }) as {
    workspaceId: string;
  };
  const search = useSearch({ strict: false }) as ReviewSearch;
  return (
    <Session
      key={[
        workspaceId,
        search.session,
        search.group,
        search.chapterId,
        search.reviewMode,
      ].join('|')}
      search={search}
      workspaceId={workspaceId}
    />
  );
}

/** The session is recorded with its first answer; Back returns to where it
 * started. Items come one at a time with Previous and Next: Next skips an
 * item to the end once, and an item rated or checked is read only when shown
 * again. The last item opens the summary. */
function Session({
  search,
  workspaceId,
}: {
  search: ReviewSearch;
  workspaceId: string;
}) {
  const navigate = useNavigate();
  const { data: ws } = useWorkspace(workspaceId);
  // Continue reads the recorded session; Review more starts a new one on
  // the same group.
  const [source, setSource] = useState<
    { resume: string } | { start: ReviewStart }
  >(() =>
    search.session
      ? { resume: search.session }
      : {
          start: {
            chapterId: search.chapterId,
            group: search.group ?? 'workspace',
            mode: search.reviewMode,
          },
        }
  );
  const fresh = useWorkspaceReview(
    workspaceId,
    'start' in source ? source.start : { group: 'workspace' },
    { enabled: 'start' in source }
  );
  const resumed = useResumeReviewSession(
    'resume' in source ? source.resume : '',
    { enabled: 'resume' in source }
  );
  const { data, error, isFetching, isError, refetch } =
    'resume' in source ? resumed : fresh;
  const steps = useSteps<ItemRecord>([], { skipOnce: true });
  // The session is the batch fetched when it began: ratings change the order
  // the server would give, and the learner should not see it reshuffle. A
  // continued session starts after its answered items, which Previous reaches.
  const [session, setSession] = useState<{
    ref: ReviewSessionRef;
    /** Items still to answer, questions answer-free. */
    live: Map<string, ReviewItem>;
    /** A continued session's answered items, questions graded. */
    done: Map<string, ReviewAnswer>;
    order: string[];
  } | null>(null);
  if (session === null && data && !isFetching && !isError) {
    const live = new Map(data.items.map((it) => [keyOf(it), it]));
    const done = new Map(data.done.map((it) => [keyOf(it), it]));
    const doneSteps: Step<ItemRecord>[] = data.done.map((a) => ({
      key: keyOf(a),
      record: recordOfAnswer(a),
    }));
    setSession({
      done,
      live,
      order: [...done.keys(), ...live.keys()],
      ref: {
        chapterId: data.chapterId,
        evidence: data.evidence,
        group: data.group,
        id: 'resume' in source ? source.resume : crypto.randomUUID(),
        items: data.items.map(({ itemId, materialId }) => ({
          itemId,
          materialId,
        })),
        mode: data.mode,
        workspaceId,
      },
    });
    steps.reset([...live.keys()], doneSteps);
  }
  const [loadingMore, setLoadingMore] = useState(false);
  // Cards rise from one stack across the session, the rated one swiping away.
  const stack = useCardStack();

  // Ratings save in the background and refresh progress once, when the
  // session is left or Review more asks for the next batch.
  const qc = useQueryClient();
  const { mutateAsync: rateItem } = useRateReviewItem(null);
  const { mutate: finish } = useFinishReviewSession();
  const [ratings] = useState(() => ratingQueue(rateItem, ratingFailed));
  useEffect(
    () => () => {
      void ratings.saved().then(() => invalidateStudy(qc, workspaceId));
    },
    [qc, ratings, workspaceId]
  );
  const shown = steps.current;
  const itemOf = (key: string) =>
    session?.live.get(key) ?? session?.done.get(key);
  const item = shown ? itemOf(shown.key) : undefined;
  const liveItem = shown ? session?.live.get(shown.key) : undefined;
  const ended = !!session && !shown;
  // A session ends once its answers are saved, skipped items or not; one
  // whose items all left their material is finished here too.
  const sessionId = session?.ref.id;
  const answeredAny = steps.steps.timeline.some((step) => step.record);
  useEffect(() => {
    if (!ended || !answeredAny || !sessionId) return;
    void ratings.saved().then(() => finish(sessionId));
  }, [ended, answeredAny, sessionId, ratings, finish]);
  const { data: overview } = useReviewOverview();
  const nextSuggestion = overview?.suggestions.find(
    (s) =>
      !(
        s.workspaceId === workspaceId &&
        s.group === session?.ref.group &&
        s.chapterId === session?.ref.chapterId
      )
  );

  /** A card swipes away only over another card. */
  function animate(after: Steps<ItemRecord>, back: boolean, from = item) {
    const to = currentStep(after);
    const nextItem = to ? itemOf(to.key) : undefined;
    stack.move(
      from?.kind === 'card' && nextItem?.kind === 'card'
        ? reviewCard(from)
        : undefined,
      back
    );
  }

  function back() {
    if (search.from === 'review')
      navigate({ search: { tab: 'review' }, to: '/learning' });
    else navigate({ params: { workspaceId }, to: '/workspaces/$workspaceId' });
  }
  async function more() {
    // The next batch is chosen from every rating saved so far.
    setLoadingMore(true);
    try {
      await ratings.saved();
      await invalidateStudy(qc, workspaceId);
      if (session)
        setSource({
          start: {
            chapterId: session.ref.chapterId,
            group: session.ref.group,
            mode: session.ref.mode,
          },
        });
      setSession(null);
      stack.reset();
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <PanelWithInvertedRadius
      header={
        <QuizPageHeader
          meta={item?.materialTitle}
          onBack={back}
          title={m.review_title({ workspace: ws?.name ?? '' })}
          topBar={<TopInsetBar className="hidden shrink-0 xl:flex" />}
          trail={[
            search.from === 'review'
              ? {
                  label: m.nav_learning(),
                  link: linkOptions({
                    search: { tab: 'review' },
                    to: '/learning',
                  }),
                }
              : {
                  label: ws?.name ?? '',
                  link: linkOptions({
                    params: { workspaceId },
                    to: '/workspaces/$workspaceId',
                  }),
                },
          ]}
        />
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-4 py-5 sm:px-6 lg:px-10 xl:px-16">
        {shown && !shown.past && (
          <span className="t-meta self-end text-fg-muted">
            {m.review_left({ count: steps.steps.queue.length })}
          </span>
        )}
        {session === null || loadingMore ? (
          isError ? (
            <ErrorState
              action={
                <ErrorAction onClick={() => void refetch()}>
                  {m.action_retry()}
                </ErrorAction>
              }
              errorId={unexpectedErrorId(error)}
              title={m.review_load_failed()}
              variant="panel"
            />
          ) : (
            <SkeletonList count={3} rowHeight={64} />
          )
        ) : item && shown ? (
          <div
            className={cn(
              'mx-auto flex w-full flex-col gap-4',
              item.kind === 'card' ? 'max-w-160' : 'max-w-3xl'
            )}
          >
            {item.kind === 'card' ? (
              <CardStack
                card={reviewCard(item)}
                onRate={(rating) => {
                  const value = SRS_RATINGS.indexOf(rating) + 1;
                  ratings.rate({
                    itemId: item.itemId,
                    materialId: item.materialId,
                    rating: value,
                    session: session.ref,
                  });
                  animate(steps.answer({ rating: value }), false);
                }}
                rated={
                  shown.record?.rating
                    ? SRS_RATINGS[shown.record.rating - 1]
                    : undefined
                }
                size="large"
                stack={stack}
              />
            ) : shown.record?.question || !liveItem ? (
              <CheckedQuestion
                answers={shown.record?.answers ?? {}}
                question={shown.record?.question}
                title={item.materialTitle}
              />
            ) : (
              <QuestionItem
                item={liveItem}
                key={shown.key}
                onChecked={(graded, answers) =>
                  steps.answer(
                    {
                      answers,
                      correct: graded.correct,
                      question: graded.question,
                      total: graded.total,
                    },
                    { stay: true }
                  )
                }
                session={session.ref}
              />
            )}
            <StepNav
              canNext
              canPrevious={steps.steps.cursor > 0}
              className="pt-4"
              onNext={() => animate(steps.next(), false)}
              onPrevious={() => animate(steps.previous(), true)}
            />
          </div>
        ) : session.order.length === 0 ? (
          <p className="t-card-title m-auto">{m.review_nothing()}</p>
        ) : (
          <ReviewSummary
            items={session.order.flatMap((key) => {
              const it = itemOf(key);
              return it
                ? [{ item: it, record: recordOf(steps.steps, key) }]
                : [];
            })}
            mode={session.ref.mode}
            next={nextSuggestion}
            onMore={() => void more()}
            onNext={(s) =>
              navigate({
                params: { workspaceId: s.workspaceId },
                search: {
                  chapterId: s.chapterId,
                  from: search.from,
                  group: s.group,
                  reviewMode: s.mode,
                },
                to: '/learning/review/$workspaceId',
              })
            }
            onOpen={(it) =>
              navigate({
                params: { workspaceId },
                // The read view, where a question scrolls into view and a
                // card opens in its preview.
                search: {
                  item: it.itemId,
                  material: it.materialId,
                  mode: 'view',
                },
                to: '/workspaces/$workspaceId',
              })
            }
            title={ws?.name ?? ''}
            when={relativeTime(new Date().toISOString())}
          />
        )}
      </div>
    </PanelWithInvertedRadius>
  );
}

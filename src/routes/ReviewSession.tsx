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
  useReviewResult,
  useWorkspace,
  useWorkspaceReview,
} from '@/api/hooks';
import type {
  ReviewAnswer,
  ReviewItem,
  ReviewSessionRef,
  ReviewStart,
  ReviewSuggestion,
} from '@/api/types';
import { ErrorState } from '@/components/app/ErrorState';
import { PagePanel } from '@/components/app/layout';
import { ErrorAction } from '@/components/ui/Button';
import { SkeletonList } from '@/components/ui/feedback';
import { UnderlineLink } from '@/components/ui/UnderlineLink';
import { userToast } from '@/components/ui/userToast';
import { CardStack, useCardStack } from '@/features/flashcards/CardStack';
import { sampleReview } from '@/features/guide/tourSamples';
import { useRunningTour } from '@/features/guide/tourStore';
import {
  RemovedAssetsContext,
  useRemovedAssets,
} from '@/features/materials/MediaAssetView';
import type { Question } from '@/features/questions/types';
import type { Answers } from '@/features/quizzes/grade';
import { QuizPageHeader } from '@/features/quizzes/QuizPageHeader';
import { CheckedQuestion, QuestionItem } from '@/features/study/ReviewQuestion';
import { ReviewResultBody } from '@/features/study/ReviewResult';
import { ratingQueue, reviewCard } from '@/features/study/ratings';
import type { ReviewSearch } from '@/features/study/reviewSearch';
import { groupName, itemCount, REVIEW_MODE } from '@/features/study/reviewText';
import { StepNav } from '@/features/study/StepNav';
import { StudyPosition } from '@/features/study/StudyPosition';
import {
  currentStep,
  type Step,
  type Steps,
  useSteps,
} from '@/features/study/steps';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { unexpectedErrorId } from '@/lib/errors';
import { SRS_RATINGS } from '@/lib/srs';

/** What an item recorded: a card's rating (1 Again to 4 Easy), or a checked
 * question's marks with what it showed, the answers and the graded question
 * with its key. */
type ItemRecord = {
  rating?: number;
  correct?: number;
  total?: number;
  answers?: Answers;
  question?: Question;
};

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
        search.planId,
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
            planId: search.planId,
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
        planId: data.planId,
        workspaceId,
      },
    });
    steps.reset([...live.keys()], doneSteps);
  }
  const [loadingMore, setLoadingMore] = useState(false);
  // Cards rise from one stack across the session, the rated one swiping away.
  const stack = useCardStack();

  // Ratings save in the background and refresh progress once, in every
  // workspace (a plan's items span several), when the session is left or
  // Review more asks for the next batch.
  const qc = useQueryClient();
  const { mutateAsync: rateItem } = useRateReviewItem(null);
  const { mutate: finish } = useFinishReviewSession();
  const [ratings] = useState(() => ratingQueue(rateItem, ratingFailed));
  useEffect(
    () => () => {
      void ratings.saved().then(() => invalidateStudy(qc));
    },
    [qc, ratings]
  );
  const shown = steps.current;
  const itemOf = (key: string) =>
    session?.live.get(key) ?? session?.done.get(key);
  const item = shown ? itemOf(shown.key) : undefined;
  const liveItem = shown ? session?.live.get(shown.key) : undefined;
  const ended = !!session && !shown;
  // A fresh workspace with nothing to review shows the tour its sample.
  const tour = useRunningTour();
  const sample =
    tour?.workspaceId === workspaceId && session?.order.length === 0;
  // A session ends once its answers are saved, skipped items or not; one
  // whose items all left their material is finished here too.
  const sessionId = session?.ref.id;
  const answeredAny = steps.steps.timeline.some((step) => step.record);
  useEffect(() => {
    if (!ended || !answeredAny || !sessionId) return;
    void ratings.saved().then(() => finish(sessionId));
  }, [ended, answeredAny, sessionId, ratings, finish]);
  const { data: overview } = useReviewOverview();
  // Images their uploader deleted read as removed (M16). No recheck: fetching
  // a new session again would replace this one.
  const removed = useRemovedAssets(data?.removedAssetIds);
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

  // A plan's review returns to its Study page with the plan picked.
  const planId = search.planId ?? session?.ref.planId;
  const studySearch = {
    study: true as const,
    ...(planId ? { plan: planId } : {}),
  };
  function back() {
    if (search.from === 'review')
      navigate({ search: { tab: 'review' }, to: '/learning' });
    // A workspace review starts on its Study page and returns there.
    else
      navigate({
        params: { workspaceId },
        search: studySearch,
        to: '/workspaces/$workspaceId',
      });
  }
  async function more() {
    // The next batch is chosen from every rating saved so far.
    setLoadingMore(true);
    try {
      await ratings.saved();
      await invalidateStudy(qc);
      if (session)
        setSource({
          start: {
            chapterId: session.ref.chapterId,
            group: session.ref.group,
            mode: session.ref.mode,
            planId: session.ref.planId,
          },
        });
      setSession(null);
      stack.reset();
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <RemovedAssetsContext.Provider value={removed}>
      <PagePanel
        header={
          <QuizPageHeader
            meta={sample ? m.tour_example() : item?.materialTitle}
            onBack={back}
            title={m.review_title({ workspace: ws?.name ?? '' })}
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
                      search: studySearch,
                      to: '/workspaces/$workspaceId',
                    }),
                  },
            ]}
          />
        }
      >
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-4 py-5 sm:px-6 lg:px-10 xl:px-16">
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
            <div className="flex w-full flex-col gap-4">
              {/* The card's width for every item, so it never jumps. */}
              <StudyPosition
                className="mx-auto mb-1 w-full max-w-160"
                position={session.order.indexOf(shown.key) + 1}
                total={session.order.length}
              />
              <div
                className={cn(
                  'mx-auto flex w-full flex-col gap-4',
                  item.kind === 'card' && 'max-w-160'
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
                    stack={stack}
                  />
                ) : (
                  // Questions differ in height: each one, and the step row under
                  // it, reveal with the text-swap tokens instead of jumping.
                  <div
                    className="motion-safe:motion-text-in flex flex-col gap-4"
                    key={shown.key}
                  >
                    {shown.record?.question || !liveItem ? (
                      <CheckedQuestion
                        answers={shown.record?.answers ?? {}}
                        question={shown.record?.question}
                      />
                    ) : (
                      <QuestionItem
                        item={liveItem}
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
                        source={false}
                      />
                    )}
                  </div>
                )}
                <StepNav
                  canNext
                  canPrevious={steps.steps.cursor > 0}
                  className="motion-safe:motion-text-in pt-4"
                  key={`nav-${shown.key}`}
                  onNext={() => animate(steps.next(), false)}
                  onPrevious={() => animate(steps.previous(), true)}
                />
              </div>
            </div>
          ) : sample ? (
            <SampleReview />
          ) : session.order.length === 0 ? (
            <p className="t-card-title m-auto">{m.review_nothing()}</p>
          ) : (
            <SessionResult
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
              saved={answeredAny ? ratings.saved : undefined}
              sessionId={session.ref.id}
            />
          )}
        </div>
      </PagePanel>
    </RemovedAssetsContext.Provider>
  );
}

/** The tour's sample: a card turned to its ratings, laid out as a session's
 * first item, display-only. */
function SampleReview() {
  const stack = useCardStack();
  const { card, total } = sampleReview();
  return (
    <div className="flex w-full flex-col gap-4" inert>
      <StudyPosition
        className="mx-auto mb-1 w-full max-w-160"
        position={1}
        total={total}
      />
      <div className="mx-auto w-full max-w-160">
        <CardStack
          card={card}
          onRate={() => undefined}
          stack={{ ...stack, flipped: true }}
        />
      </div>
    </div>
  );
}

/** The end of a session: its result once every answer is saved, with the
 * next suggestion under it. A session with nothing answered has none. */
function SessionResult({
  sessionId,
  saved,
  next,
  onMore,
  onNext,
}: {
  sessionId: string;
  saved?: () => Promise<unknown>;
  next?: ReviewSuggestion;
  onMore: () => void;
  onNext: (suggestion: ReviewSuggestion) => void;
}) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    void saved?.().then(() => setReady(true));
  }, [saved]);
  const { data } = useReviewResult(sessionId, { enabled: ready });
  if (!saved)
    return <p className="t-card-title m-auto">{m.review_nothing()}</p>;
  if (!data) return <SkeletonList count={4} rowHeight={52} />;
  return (
    <div className="mx-auto w-full max-w-4xl">
      <ReviewResultBody
        footer={
          next && (
            <section className="mt-9">
              <h3 className="mb-1.5 font-bold text-fg-muted text-sm">
                {m.review_result_next()}
              </h3>
              <div className="flex items-center justify-between gap-4 border-divider border-y py-3">
                <div className="min-w-0">
                  <div className="truncate font-semibold">
                    {[
                      next.workspaceName,
                      groupName(next.group, next.chapterName),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                  <div className="text-fg-muted text-xs">
                    <span className={REVIEW_MODE[next.mode].className}>
                      {REVIEW_MODE[next.mode].label()}
                    </span>
                    {` · ${itemCount(next.items)}`}
                  </div>
                </div>
                <UnderlineLink onClick={() => onNext(next)}>
                  {m.review_start()}
                </UnderlineLink>
              </div>
            </section>
          )
        }
        onAgain={onMore}
        result={data}
      />
    </div>
  );
}

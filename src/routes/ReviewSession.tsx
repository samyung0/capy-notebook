import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { api } from '@/api/client';
import {
  invalidateStudy,
  useFinishReviewSession,
  useRateReviewItem,
  useResumeReviewSession,
  useWorkspace,
  useWorkspaceReview,
} from '@/api/hooks';
import type {
  CheckReviewItemReq,
  GradedQuestion,
  ReviewItem,
  ReviewSessionRef,
  ReviewStart,
} from '@/api/types';
import { ErrorState } from '@/components/app/ErrorState';
import { PageHeader, PanelWithInvertedRadius } from '@/components/app/layout';
import { Button, ErrorAction } from '@/components/ui/Button';
import { SkeletonList } from '@/components/ui/feedback';
import { userToast } from '@/components/ui/userToast';
import { CardStack, useCardStack } from '@/features/flashcards/CardStack';
import type { Answers } from '@/features/quizzes/grade';
import { QuestionRunner } from '@/features/quizzes/QuestionRunner';
import { ratingQueue, reviewCard } from '@/features/study/ratings';
import type { ReviewSearch } from '@/features/study/reviewSearch';
import { m } from '@/i18n';
import { SRS_RATINGS } from '@/lib/srs';

function ratingFailed() {
  userToast({
    id: 'review-rating-failed',
    title: m.flashcards_review_failed(),
    variant: 'error',
  });
}

/** A review of one workspace: a suggestion's items, the whole workspace's,
 * or an unfinished session continued. The session is recorded with its first
 * answer; Back returns to where it started. */
export default function ReviewSession() {
  const { workspaceId } = useParams({ strict: false }) as {
    workspaceId: string;
  };
  const search = useSearch({ strict: false }) as ReviewSearch;
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
  const { data, isFetching, isError, refetch } =
    'resume' in source ? resumed : fresh;
  // The session is the batch fetched when it began: ratings change the order
  // the server would give, and the learner should not see it reshuffle.
  const [session, setSession] = useState<{
    ref: ReviewSessionRef;
    items: ReviewItem[];
  } | null>(null);
  const [index, setIndex] = useState(0);
  if (session === null && data && !isFetching && !isError)
    setSession({
      items: data.items,
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
  const item = session?.items[index];
  const ended = !!session && !item;
  // At the end every item is answered; a continued session whose items left
  // their material is finished here, once its answers are saved.
  const sessionId = session?.ref.id;
  const answeredAny = index > 0;
  useEffect(() => {
    if (!ended || !answeredAny || !sessionId) return;
    void ratings.saved().then(() => finish(sessionId));
  }, [ended, answeredAny, sessionId, ratings, finish]);

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
      setIndex(0);
      stack.reset();
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <PanelWithInvertedRadius
      header={
        <PageHeader
          subtitle={item?.materialTitle}
          title={m.review_title({ workspace: ws?.name ?? '' })}
        />
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-4 py-5 sm:px-6">
        <div className="flex items-center justify-between">
          <Button
            iconLeft="navigationBack"
            onClick={back}
            variant="ghost-hover"
          >
            {m.review_back()}
          </Button>
          {item && session && (
            <span className="t-meta text-fg-muted">
              {m.review_left({ count: session.items.length - index })}
            </span>
          )}
        </div>
        {session === null ? (
          isError ? (
            <ErrorState
              action={
                <ErrorAction onClick={() => void refetch()}>
                  {m.action_retry()}
                </ErrorAction>
              }
              title={m.review_load_failed()}
              variant="panel"
            />
          ) : (
            <SkeletonList count={3} rowHeight={64} />
          )
        ) : item ? (
          item.kind === 'card' ? (
            <div className="mx-auto w-full max-w-160">
              <CardStack
                card={reviewCard(item)}
                onRate={(rating) => {
                  ratings.rate({
                    itemId: item.itemId,
                    materialId: item.materialId,
                    rating: SRS_RATINGS.indexOf(rating) + 1,
                    session: session.ref,
                  });
                  // Only a card swipes away over the next card.
                  const next = session.items[index + 1];
                  stack.move(
                    next?.kind === 'card' ? reviewCard(item) : undefined
                  );
                  setIndex(index + 1);
                }}
                stack={stack}
              />
            </div>
          ) : (
            <QuestionItem
              item={item}
              key={`${item.materialId}/${item.itemId}`}
              onNext={() => setIndex(index + 1)}
              session={session.ref}
            />
          )
        ) : (
          <div className="m-auto flex flex-col items-center gap-4 text-center">
            <p className="t-card-title">
              {session.items.length
                ? m.review_done({ count: session.items.length })
                : m.review_nothing()}
            </p>
            <div className="flex gap-2">
              <Button onClick={back} variant="outline">
                {m.review_finish()}
              </Button>
              {session.items.length > 0 && (
                <Button disabled={loadingMore} onClick={() => void more()}>
                  {m.review_more()}
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </PanelWithInvertedRadius>
  );
}

/** A question answered the quiz page's way. Check sends the answers; the
 * server grades them, records the rating and returns the question's key. */
function QuestionItem({
  item,
  onNext,
  session,
}: {
  item: ReviewItem;
  onNext: () => void;
  session: ReviewSessionRef;
}) {
  const [answers, setAnswers] = useState<Answers>({});
  const {
    data: checked,
    isPending: grading,
    mutate: check,
  } = useMutation({
    meta: { errorToast: false },
    mutationFn: () =>
      api.post<GradedQuestion>('/review/check', {
        answers,
        itemId: item.itemId,
        materialId: item.materialId,
        session,
      } satisfies CheckReviewItemReq),
    onError: () =>
      userToast({
        id: 'review-grade-failed',
        title: m.review_grade_failed(),
        variant: 'error',
      }),
  });
  const graded = checked?.question;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      <QuestionRunner
        answers={answers}
        disabled={!!graded || grading}
        onChange={(partId, value) =>
          setAnswers((a) => ({ ...a, [partId]: value }))
        }
        question={graded ?? item.question!}
        review={!!graded}
      />
      <div className="flex items-center justify-between gap-3">
        <span className="t-meta text-fg-muted">
          {m.review_from({ title: item.materialTitle })}
        </span>
        {graded ? (
          <Button onClick={onNext}>{m.review_next()}</Button>
        ) : (
          <Button disabled={grading} onClick={() => check()}>
            {m.review_check()}
          </Button>
        )}
      </div>
    </div>
  );
}

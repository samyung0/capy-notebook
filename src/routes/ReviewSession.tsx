import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { api } from '@/api/client';
import {
  invalidateStudy,
  useRateReviewItem,
  useWorkspace,
  useWorkspaceReview,
} from '@/api/hooks';
import type {
  CheckReviewItemReq,
  GradedQuestion,
  RateReviewItemReq,
  ReviewItem,
} from '@/api/types';
import { ErrorState } from '@/components/app/ErrorState';
import { PageHeader, PanelWithInvertedRadius } from '@/components/app/layout';
import { Button, ErrorAction } from '@/components/ui/Button';
import { SkeletonList } from '@/components/ui/feedback';
import { userToast } from '@/components/ui/userToast';
import type { Answers } from '@/features/quizzes/grade';
import { QuestionRunner } from '@/features/quizzes/QuestionRunner';
import {
  RATING_LABEL,
  RATING_STYLE,
  ratingQueue,
} from '@/features/study/ratings';
import type { ReviewFrom } from '@/features/study/reviewSearch';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { SRS_RATINGS, type SrsRating } from '@/lib/srs';

function ratingFailed() {
  userToast({
    id: 'review-rating-failed',
    title: m.flashcards_review_failed(),
    variant: 'error',
  });
}

/** A mixed review of one workspace: its least retained cards and questions,
 * one at a time, twenty per session. Back returns to where it started. */
export default function ReviewSession() {
  const { workspaceId } = useParams({ strict: false }) as {
    workspaceId: string;
  };
  const { from } = useSearch({ strict: false }) as { from?: ReviewFrom };
  const navigate = useNavigate();
  const { data: ws } = useWorkspace(workspaceId);
  const { data, isFetching, isError, refetch } =
    useWorkspaceReview(workspaceId);
  // The session is the batch fetched when it began: ratings change the order
  // the server would give, and the learner should not see it reshuffle.
  const [session, setSession] = useState<ReviewItem[] | null>(null);
  const [index, setIndex] = useState(0);
  if (session === null && data && !isFetching && !isError)
    setSession(data.items);
  const [loadingMore, setLoadingMore] = useState(false);

  // Ratings save in the background and refresh progress once, when the
  // session is left or Review more asks for the next batch.
  const qc = useQueryClient();
  const { mutateAsync: rateItem } = useRateReviewItem(null);
  const [ratings] = useState(() => ratingQueue(rateItem, ratingFailed));
  useEffect(
    () => () => {
      void ratings.saved().then(() => invalidateStudy(qc, workspaceId));
    },
    [qc, ratings, workspaceId]
  );

  function back() {
    if (from === 'learning')
      navigate({ search: { tab: 'review' }, to: '/learning' });
    else navigate({ params: { workspaceId }, to: '/workspaces/$workspaceId' });
  }
  async function more() {
    // The next batch is chosen from every rating saved so far.
    setLoadingMore(true);
    try {
      await ratings.saved();
      await invalidateStudy(qc, workspaceId);
      setSession(null);
      setIndex(0);
    } finally {
      setLoadingMore(false);
    }
  }

  const item = session?.[index];
  return (
    <PanelWithInvertedRadius>
      <PageHeader
        subtitle={item?.materialTitle}
        title={m.review_title({ workspace: ws?.name ?? '' })}
      />
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-6 py-5">
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
              {m.review_left({ count: session.length - index })}
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
            <CardItem
              item={item}
              key={`${item.materialId}/${item.itemId}`}
              onNext={() => setIndex(index + 1)}
              onRate={ratings.rate}
            />
          ) : (
            <QuestionItem
              item={item}
              key={`${item.materialId}/${item.itemId}`}
              onNext={() => setIndex(index + 1)}
            />
          )
        ) : (
          <div className="m-auto flex flex-col items-center gap-4 text-center">
            <p className="t-card-title">
              {session.length
                ? m.review_done({ count: session.length })
                : m.review_nothing()}
            </p>
            <div className="flex gap-2">
              <Button onClick={back} variant="outline">
                {m.review_finish()}
              </Button>
              {session.length > 0 && (
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

function CardItem({
  item,
  onNext,
  onRate,
}: {
  item: ReviewItem;
  onNext: () => void;
  onRate: (body: RateReviewItemReq) => void;
}) {
  const [flipped, setFlipped] = useState(false);
  function rate(rating: SrsRating) {
    onRate({
      itemId: item.itemId,
      materialId: item.materialId,
      rating: SRS_RATINGS.indexOf(rating) + 1,
    });
    onNext();
  }
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-3">
      <button
        className="flex min-h-56 flex-col items-center justify-center gap-3 rounded-card border border-line bg-surface px-6 py-8 text-center"
        onClick={() => setFlipped(true)}
        type="button"
      >
        <p className="t-label text-fg-muted">{item.front}</p>
        {flipped && <p className="t-card-title">{item.back}</p>}
      </button>
      {flipped ? (
        <div className="grid grid-cols-4 gap-2">
          {SRS_RATINGS.map((r) => (
            <button
              className={cn(
                'rounded-card border px-2 py-2.5 font-semibold text-sm transition-colors',
                RATING_STYLE[r]
              )}
              key={r}
              onClick={() => rate(r)}
              type="button"
            >
              {RATING_LABEL[r]()}
            </button>
          ))}
        </div>
      ) : (
        <Button fullWidth onClick={() => setFlipped(true)}>
          {m.flashcards_show_answer()}
        </Button>
      )}
    </div>
  );
}

/** A question answered the quiz page's way. Check sends the answers; the
 * server grades them, records the rating and returns the question's key. */
function QuestionItem({
  item,
  onNext,
}: {
  item: ReviewItem;
  onNext: () => void;
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

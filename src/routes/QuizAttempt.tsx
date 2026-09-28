import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { isApiError } from '@/api/client';
import { useCloneQuiz, useQuiz, useSubmitAttempt } from '@/api/hooks';
import { Panel } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { WorkspaceError } from '@/components/app/WorkspaceError';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { userToast } from '@/components/ui/userToast';
import { MaterialAttributionFooter } from '@/features/materials/MaterialAttributionFooter';
import {
  type Answer,
  formatPoints,
  scoreQuestion,
} from '@/features/quizzes/grade';
import { QuestionRunner } from '@/features/quizzes/QuestionRunner';
import { gradeAttemptQuestions } from '@/features/quizzes/scoreAttempt';
import { m } from '@/i18n';
import { scoreBucket } from '@/lib/analytics';
import { toastCloneError, toastSignInRequired } from '@/lib/authToasts';
import { describeError, llmKeyUserMessage } from '@/lib/errors';
import { track } from '@/lib/observability';

export default function QuizAttempt() {
  const params = useParams({ strict: false });
  const quizId = (params as { quizId: string }).quizId;
  return <Attempt key={quizId} quizId={quizId} />;
}

function Attempt({ quizId }: { quizId: string }) {
  const {
    data: quiz,
    error,
    fetchStatus,
    isError,
    isLoading,
    isFetchedAfterMount,
  } = useQuiz(quizId, {
    errorBoundary: false,
    fresh: true,
  });
  const { isPending: submitIsPending, mutate: submit } = useSubmitAttempt({
    errorToast: false,
  });
  const { isPending: cloneQuizIsPending, mutate: cloneQuiz } = useCloneQuiz({
    errorToast: false,
  });
  const navigate = useNavigate();

  const [idx, setIdx] = useState(0);
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [done, setDone] = useState(false);
  const [graded, setGraded] = useState<Awaited<
    ReturnType<typeof gradeAttemptQuestions>
  > | null>(null);
  const [grading, setGrading] = useState(false);

  const liveScore = useMemo(() => {
    if (!quiz) return { awarded: 0, max: 0 };
    return quiz.questions
      .map((q) => scoreQuestion(q, answers))
      .reduce(
        (acc, s) => ({
          awarded: acc.awarded + s.awarded,
          max: acc.max + s.max,
        }),
        { awarded: 0, max: 0 }
      );
  }, [quiz, answers]);
  const score = graded ?? liveScore;

  if (fetchStatus === 'paused') {
    return (
      <Panel sectionClassName="h-full">
        <QueryPausedState className="h-full" />
      </Panel>
    );
  }

  if (isLoading || (!isFetchedAfterMount && !isError)) {
    return (
      <Panel sectionClassName="h-full">
        <div className="h-full p-6">
          <Skeleton className="h-full w-full" />
        </div>
      </Panel>
    );
  }

  if (isError || !quiz) {
    const denied =
      isApiError(error) && (error.status === 404 || error.status === 401);
    return (
      <WorkspaceError
        backLabel={m.quiz_back()}
        backTo="/quizzes"
        title={denied ? m.error_private_title() : m.quiz_unable_load()}
      />
    );
  }

  if (!quiz.questions.length) {
    return (
      <Panel sectionClassName="h-full">
        <div className="mx-auto flex h-full max-w-2xl flex-col items-center justify-center gap-4 px-6 text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-card-lg bg-tint-success text-tint-success-fg">
            <Icon className="non-scaling-svg" name="check" size={30} />
          </span>
          <p className="t-large-card-title">{m.quiz_no_questions()}</p>
          <Link preload="intent" to="/create">
            <Button iconLeft="navigationBack">{m.quiz_back()}</Button>
          </Link>
        </div>
      </Panel>
    );
  }

  const q = quiz.questions[idx];

  async function finish() {
    if (!quiz) return;
    setGrading(true);
    try {
      const result = await gradeAttemptQuestions(quiz.questions, answers, {
        workspaceId: quiz.workspaceId,
      });
      setGraded(result);
      const pct = result.max > 0 ? (result.awarded / result.max) * 100 : 0;
      track('quiz_attempt_finished', { scoreBucket: scoreBucket(pct) });
      const wrong = result.questions.filter((qq) => {
        const s = scoreQuestion(qq, answers);
        return s.awarded < s.max;
      });
      submit(
        {
          answers,
          correct: result.awarded,
          questions: result.questions,
          quizId,
          total: result.max,
          wrong,
        },
        {
          onError: (err) => {
            if (isApiError(err) && err.status === 401) {
              toastSignInRequired(
                m.quiz_signin_save_title(),
                m.quiz_signin_save_body()
              );
              return;
            }
            userToast({
              description:
                err instanceof Error
                  ? err.message
                  : m.quiz_save_attempt_retry(),
              title: m.quiz_save_attempt_failed(),
              variant: 'error',
            });
          },
          onSuccess: () => setDone(true),
        }
      );
    } catch (err) {
      const keyMessage = llmKeyUserMessage(err);
      const described = keyMessage ? describeError(err) : null;
      userToast({
        description:
          keyMessage ??
          (err instanceof Error ? err.message : m.quiz_grade_failed_body()),
        title: described?.title ?? m.quiz_grade_failed(),
        variant: 'error',
      });
    } finally {
      setGrading(false);
    }
  }

  if (done) {
    const pct = Math.round((score.awarded / Math.max(0.5, score.max)) * 100);
    return (
      <Panel sectionClassName="h-full">
        <div className="mx-auto flex h-full w-full max-w-2xl flex-col items-center gap-5 overflow-auto px-6 py-6 text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-card-lg bg-tint-accent-1 text-tint-accent-1-fg">
            <Icon className="non-scaling-svg" name="quiz" size={30} />
          </span>
          <p className="t-page-title">
            {formatPoints(score.awarded)} / {formatPoints(score.max)}
          </p>
          <p className="t-body text-fg-muted">
            {m.quiz_you_scored({ name: quiz.name, pct: String(pct) })}
          </p>
          <p className="t-meta text-fg-muted">{m.quiz_score_reference()}</p>
          <div className="w-full max-w-sm">
            <ProgressBar
              height={8}
              tone={pct >= 70 ? 'green' : pct >= 55 ? 'amber' : 'coral'}
              value={pct}
            />
          </div>
          <div className="mt-4 w-full space-y-6 text-left">
            {(graded?.questions ?? quiz.questions).map((question, i) => (
              <div className="border-divider border-b pb-6" key={question.id}>
                <QuestionRunner
                  answers={answers}
                  onChange={() => {}}
                  question={question}
                  questionNumber={i + 1}
                  review
                />
              </div>
            ))}
          </div>
          <Link preload="intent" to="/create">
            <Button iconLeft="navigationBack">{m.quiz_back()}</Button>
          </Link>
        </div>
      </Panel>
    );
  }

  return (
    <Panel sectionClassName="h-full">
      <div className="mx-auto flex h-full w-full max-w-2xl flex-col px-6 py-6">
        <div className="mb-4 flex items-center gap-3">
          <Link
            className="text-fg-muted hover:text-fg"
            preload="intent"
            to="/create"
          >
            <Icon name="x" size={20} />
          </Link>
          <div className="flex-1">
            <ProgressBar
              tone="purple"
              value={((idx + 1) / quiz.questions.length) * 100}
            />
          </div>
          <p className="t-meta text-fg-muted tabular-nums">
            {idx + 1} / {quiz.questions.length}
          </p>
          {!quiz.canEdit && (
            <Button
              disabled={cloneQuizIsPending}
              iconLeft="plus"
              onClick={() =>
                cloneQuiz(quizId, {
                  onError: (err) => toastCloneError(err, 'quiz'),
                  onSuccess: (copy) => {
                    navigate({
                      params: { quizId: copy.id },
                      to: '/quizzes/$quizId/attempt',
                    });
                  },
                })
              }
              size="sm"
            >
              {cloneQuizIsPending ? m.action_cloning() : m.action_clone()}
            </Button>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-auto py-4">
          <QuestionRunner
            answers={answers}
            onChange={(partId, a) => setAnswers((s) => ({ ...s, [partId]: a }))}
            question={q}
            questionNumber={idx + 1}
          />
        </div>

        <div className="flex items-center justify-between pt-4">
          <Button
            disabled={idx === 0}
            iconLeft="navigationBack"
            onClick={() => setIdx((i) => i - 1)}
            variant="ghost"
          >
            {m.action_previous()}
          </Button>
          {idx < quiz.questions.length - 1 ? (
            <Button
              iconRight="navigationForward"
              onClick={() => setIdx((i) => i + 1)}
            >
              {m.action_next()}
            </Button>
          ) : (
            <Button
              disabled={submitIsPending || grading}
              iconRight="check"
              onClick={() => void finish()}
              variant="accent"
            >
              {grading
                ? m.quiz_grading()
                : submitIsPending
                  ? m.canvas_saving()
                  : m.action_finish()}
            </Button>
          )}
        </div>
        <MaterialAttributionFooter provenance={quiz.provenance} />
      </div>
    </Panel>
  );
}

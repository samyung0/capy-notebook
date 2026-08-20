import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { isApiError } from '@/api/client';
import {
  useCloneQuiz,
  useMe,
  useModels,
  useQuiz,
  useSubmitAttempt,
} from '@/api/hooks';
import { PanelWithInvertedRadius } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { WorkspaceError } from '@/components/app/WorkspaceError';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { userToast } from '@/components/ui/userToast';
import {
  type Answer,
  emptyAnswer,
  formatPoints,
  scoreQuestion,
} from '@/features/quizzes/grade';
import { QuestionRunner } from '@/features/quizzes/QuestionRunner';
import { gradeAttemptQuestions } from '@/features/quizzes/scoreAttempt';
import { m } from '@/i18n';
import { toastCloneError, toastSignInRequired } from '@/lib/authToasts';

export default function QuizAttempt() {
  const params = useParams({ strict: false });
  const quizId = (params as { quizId: string }).quizId;
  const {
    data: quiz,
    error,
    fetchStatus,
    isError,
    isLoading,
  } = useQuiz(quizId, {
    errorBoundary: false,
  });
  const { isPending: submitIsPending, mutate: submit } = useSubmitAttempt({
    errorToast: false,
  });
  const { isPending: cloneQuizIsPending, mutate: cloneQuiz } = useCloneQuiz({
    errorToast: false,
  });
  const navigate = useNavigate();

  const { data: me } = useMe();
  const { data: quizModels } = useModels('quiz', { errorBoundary: false });
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
      .map((q) => scoreQuestion(q, answers[q.id]))
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
      <PanelWithInvertedRadius>
        <QueryPausedState className="h-full" />
      </PanelWithInvertedRadius>
    );
  }

  if (isLoading) {
    return (
      <PanelWithInvertedRadius>
        <div className="h-full p-6">
          <Skeleton className="h-full w-full" />
        </div>
      </PanelWithInvertedRadius>
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
      <PanelWithInvertedRadius>
        <div className="mx-auto flex h-full max-w-2xl flex-col items-center justify-center gap-4 px-6 text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-card-lg bg-tint-success text-tint-success-fg">
            <Icon name="check" size={30} />
          </span>
          <p className="t-large-card-title">{m.quiz_no_questions()}</p>
          <Link preload="intent" to="/quizzes">
            <Button iconLeft="chevronLeft">{m.quiz_back()}</Button>
          </Link>
        </div>
      </PanelWithInvertedRadius>
    );
  }

  const q = quiz.questions[idx];
  const answer = answers[q.id] ?? emptyAnswer(q);

  async function finish() {
    if (!quiz) return;
    setGrading(true);
    try {
      const result = await gradeAttemptQuestions(quiz.questions, answers, {
        modelKey:
          me?.quizModelKey || quizModels?.selectedKey || 'deepseek-flash',
        workspaceId: quiz.workspaceId,
      });
      setGraded(result);
      const wrong = result.questions.filter((qq) => {
        const s = scoreQuestion(qq, answers[qq.id]);
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
      userToast({
        description:
          err instanceof Error ? err.message : m.quiz_grade_failed_body(),
        title: m.quiz_grade_failed(),
        variant: 'error',
      });
    } finally {
      setGrading(false);
    }
  }

  if (done) {
    const pct = Math.round((score.awarded / Math.max(0.5, score.max)) * 100);
    return (
      <PanelWithInvertedRadius>
        <div className="mx-auto flex h-full max-w-2xl flex-col items-center justify-center gap-5 px-6 text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-card-lg bg-tint-accent-1 text-tint-accent-1-fg">
            <Icon name="quiz" size={30} />
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
          <div className="mt-4 flex w-full max-w-md flex-col gap-2 text-left">
            {(graded?.questions ?? quiz.questions).map((qq, i) => {
              const s = scoreQuestion(qq, answers[qq.id]);
              const ok = s.awarded >= s.max && s.max > 0;
              return (
                <div
                  className="flex items-start gap-2 rounded-card border border-line bg-surface px-3 py-2"
                  key={qq.id}
                >
                  <Icon
                    className={
                      ok ? 'text-tint-success-fg' : 'text-tint-error-fg'
                    }
                    name={ok ? 'check' : 'x'}
                    size={16}
                  />
                  <div className="flex-1">
                    <p className="t-meta">
                      {i + 1}. {qq.prompt}
                    </p>
                    {!ok && qq.explanation && (
                      <p className="t-meta mt-1 text-fg-muted">
                        {qq.explanation}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <Link preload="intent" to="/quizzes">
            <Button iconLeft="chevronLeft">{m.quiz_back()}</Button>
          </Link>
        </div>
      </PanelWithInvertedRadius>
    );
  }

  return (
    <PanelWithInvertedRadius>
      <div className="mx-auto flex h-full w-full max-w-2xl flex-col px-6 py-6">
        <div className="mb-4 flex items-center gap-3">
          <Link
            className="text-fg-muted hover:text-fg"
            preload="intent"
            to="/quizzes"
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
          {!quiz.isOwner && (
            <Button
              disabled={cloneQuizIsPending}
              iconLeft="plus"
              onClick={() =>
                cloneQuiz(quizId, {
                  onError: (err) => toastCloneError(err, 'quiz'),
                  onSuccess: (copy) =>
                    navigate({
                      params: { quizId: copy.id },
                      to: '/quizzes/$quizId/attempt',
                    }),
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
            answer={answer}
            onChange={(a) => setAnswers((s) => ({ ...s, [q.id]: a }))}
            question={q}
          />
        </div>

        <div className="flex items-center justify-between border-divider border-t pt-4">
          <Button
            disabled={idx === 0}
            iconLeft="chevronLeft"
            onClick={() => setIdx((i) => i - 1)}
            variant="ghost"
          >
            {m.action_previous()}
          </Button>
          {idx < quiz.questions.length - 1 ? (
            <Button
              iconRight="chevronRight"
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
      </div>
    </PanelWithInvertedRadius>
  );
}

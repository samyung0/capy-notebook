import {
  Link,
  useCanGoBack,
  useNavigate,
  useParams,
  useRouter,
} from '@tanstack/react-router';
import { type ReactNode, useCallback, useState } from 'react';
import { isApiError } from '@/api/client';
import { useCloneQuiz, useQuiz, useSubmitAttempt } from '@/api/hooks';
import { PanelWithInvertedRadius } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { TabContent } from '@/components/app/tabPanel';
import { WorkspaceError } from '@/components/app/WorkspaceError';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/feedback';
import { userToast } from '@/components/ui/userToast';
import { MaterialAttributionFooter } from '@/features/materials/MaterialAttributionFooter';
import { type Answer, scoreQuestion } from '@/features/quizzes/grade';
import { isAnswered } from '@/features/quizzes/QuestionRunner';
import {
  QuizPageHeader,
  QuizQuestionList,
  QuizScore,
  quizMeta,
} from '@/features/quizzes/QuizPage';
import { gradeAttemptQuestions } from '@/features/quizzes/scoreAttempt';
import { useAccountFrozen } from '@/features/workspace/WorkspaceHealth';
import { m } from '@/i18n';
import { scoreBucket } from '@/lib/analytics';
import { toastCloneError, toastSignInRequired } from '@/lib/authToasts';
import { describeError, errorCopy, llmKeyUserMessage } from '@/lib/errors';
import { track } from '@/lib/observability';

export default function QuizAttempt() {
  return <QuizAttemptPage shared={false} />;
}

/** A shared link renders outside the app shell, so it brings the shell's
 * padding and has nowhere to go back to. */
export function SharedQuizAttempt() {
  return (
    <div
      className="t-body h-dvh bg-page p-1.5 text-fg sm:p-2.5"
      data-slot="shared-quiz-page"
    >
      <QuizAttemptPage shared />
    </div>
  );
}

function QuizAttemptPage({ shared }: { shared: boolean }) {
  const params = useParams({ strict: false });
  const quizId = (params as { quizId: string }).quizId;
  return <Attempt key={quizId} quizId={quizId} shared={shared} />;
}

function Attempt({ quizId, shared }: { quizId: string; shared: boolean }) {
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
  const frozen = useAccountFrozen();
  const navigate = useNavigate();
  const router = useRouter();
  const canGoBack = useCanGoBack();

  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [done, setDone] = useState(false);
  const [graded, setGraded] = useState<Awaited<
    ReturnType<typeof gradeAttemptQuestions>
  > | null>(null);
  const [grading, setGrading] = useState(false);
  const setAnswer = useCallback(
    (partId: string, value: Answer) =>
      setAnswers((current) => ({ ...current, [partId]: value })),
    []
  );

  const back = shared
    ? undefined
    : () =>
        canGoBack ? router.history.back() : void navigate({ to: '/create' });

  if (fetchStatus === 'paused') {
    return (
      <PanelWithInvertedRadius>
        <QueryPausedState className="h-full" />
      </PanelWithInvertedRadius>
    );
  }

  if (isLoading || (!isFetchedAfterMount && !isError)) {
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

  const header = (actions?: ReactNode) => (
    <QuizPageHeader
      actions={actions}
      meta={quizMeta(quiz.questions)}
      onBack={back}
      title={quiz.name}
      trail={
        shared
          ? [m.quiz_shared()]
          : [quiz.workspaceName || m.nav_create(), m.quiz_quizzes()]
      }
    />
  );

  if (!quiz.questions.length) {
    return (
      <PanelWithInvertedRadius>
        {header()}
        <TabContent>
          <p className="text-fg-muted">{m.quiz_no_questions()}</p>
          <Link className="mt-6 inline-flex" preload="intent" to="/create">
            <Button className="rounded-input" iconLeft="navigationBack">
              {m.quiz_back()}
            </Button>
          </Link>
        </TabContent>
      </PanelWithInvertedRadius>
    );
  }

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
              description: errorCopy(err, m.quiz_save_attempt_retry()),
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
        description: keyMessage ?? errorCopy(err, m.quiz_grade_failed_body()),
        title: described?.title ?? m.quiz_grade_failed(),
        variant: 'error',
      });
    } finally {
      setGrading(false);
    }
  }

  if (done && graded) {
    return (
      // A fresh panel so the result opens at the top, not at the quiz's scroll.
      <PanelWithInvertedRadius key="result">
        {header()}
        <TabContent>
          <QuizScore
            answers={answers}
            awarded={graded.awarded}
            confetti
            max={graded.max}
            questions={graded.questions}
          />
          <div className="mt-12">
            <QuizQuestionList
              answers={answers}
              questions={graded.questions}
              review
            />
          </div>
          <Button
            className="mt-12 rounded-input"
            iconLeft="refresh"
            onClick={() => {
              setAnswers({});
              setGraded(null);
              setDone(false);
            }}
            size="lg"
            variant="outline"
          >
            {m.quiz_redo()}
          </Button>
          <MaterialAttributionFooter provenance={quiz.provenance} />
        </TabContent>
      </PanelWithInvertedRadius>
    );
  }

  const partCount = quiz.questions.reduce((n, q) => n + q.parts.length, 0);
  const answered = quiz.questions
    .flatMap((q) => q.parts)
    .filter((part) => isAnswered(answers[part.id])).length;

  return (
    <PanelWithInvertedRadius>
      {header(
        !quiz.canEdit && (
          <Button
            className="rounded-input"
            disabled={frozen || cloneQuizIsPending}
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
            variant="outline"
          >
            {cloneQuizIsPending ? m.action_cloning() : m.quiz_clone()}
          </Button>
        )
      )}
      <TabContent>
        <QuizQuestionList
          answers={answers}
          onChange={setAnswer}
          questions={quiz.questions}
        />
        <div className="mt-12 grid gap-3">
          <p className="t-meta text-fg-muted">
            {m.quiz_answered_count({ answered, total: partCount })}
          </p>
          <Button
            className="rounded-input"
            disabled={submitIsPending || grading}
            fullWidth
            onClick={() => void finish()}
            size="lg"
          >
            {grading
              ? m.quiz_grading()
              : submitIsPending
                ? m.canvas_saving()
                : m.quiz_submit()}
          </Button>
        </div>
        <MaterialAttributionFooter provenance={quiz.provenance} />
      </TabContent>
    </PanelWithInvertedRadius>
  );
}

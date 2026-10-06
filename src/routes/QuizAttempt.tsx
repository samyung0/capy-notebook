import { useQuery } from '@tanstack/react-query';
import {
  Link,
  useCanGoBack,
  useNavigate,
  useParams,
  useRouter,
} from '@tanstack/react-router';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import {
  anonymousAssetUrl,
  anonymousQuizQuery,
  gradeAnonymousQuiz,
  isAnonymousGradingLimit,
} from '@/api/anonymous';
import { isApiError } from '@/api/client';
import { useCloneQuiz, useQuiz, useSubmitAttempt } from '@/api/hooks';
import type { Provenance, Question } from '@/api/types';
import { SessionSwitch } from '@/components/app/AuthProvider';
import { PanelWithInvertedRadius } from '@/components/app/layout';
import { PublicPage } from '@/components/app/PublicHeader';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { TabContent } from '@/components/app/tabPanel';
import { WorkspaceError } from '@/components/app/WorkspaceError';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/feedback';
import { userToast } from '@/components/ui/userToast';
import { MaterialAttributionFooter } from '@/features/materials/MaterialAttributionFooter';
import { PublicAssetUrlContext } from '@/features/questions/QuestionView';
import type { LearnerQuestion } from '@/features/questions/types';
import type { Answer } from '@/features/quizzes/grade';
import { isAnswered } from '@/features/quizzes/QuestionRunner';
import {
  QuizPageHeader,
  QuizQuestionList,
  QuizScore,
  quizMeta,
} from '@/features/quizzes/QuizPage';
import { useAccountFrozen } from '@/features/workspace/WorkspaceHealth';
import { m } from '@/i18n';
import { scoreBucket } from '@/lib/analytics';
import { toastCloneError, toastSignInRequired } from '@/lib/authToasts';
import { errorCopy } from '@/lib/errors';
import {
  anonymousId,
  type LocalQuizAttempt,
  localQuizAttempts,
  saveLocalQuizAttempt,
} from '@/lib/localDb';
import { track } from '@/lib/observability';

type Answers = Record<string, Answer>;
/** An attempt graded on the server: its questions with their keys and each
 * part's award, and the marks over the quiz's total. */
type Graded = { questions: Question[]; awarded: number; max: number };

export default function QuizAttempt() {
  const params = useParams({ strict: false });
  const quizId = (params as { quizId: string }).quizId;
  return <Attempt key={quizId} quizId={quizId} shared={false} />;
}

/** A shared link renders outside the app shell, so it brings the shell's
 * padding and has nowhere to go back to. The route param is the signed share
 * token `{id}.{signature}`; signed-out visitors take the quiz anonymously. */
export function SharedQuizAttempt() {
  const params = useParams({ strict: false });
  const token = (params as { quizId: string }).quizId;
  const quizId = token.split('.')[0];
  return (
    <SessionSwitch
      anonymous={<AnonymousAttempt key={token} token={token} />}
      signedIn={
        <div className="t-body h-dvh bg-page p-1.5 text-fg sm:p-2.5">
          <Attempt key={quizId} quizId={quizId} shared />
        </div>
      }
    />
  );
}

function LoadingPanel() {
  return (
    <PanelWithInvertedRadius>
      <div className="h-full p-6">
        <Skeleton className="h-full w-full" />
      </div>
    </PanelWithInvertedRadius>
  );
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
  const { mutateAsync: submit } = useSubmitAttempt({ errorToast: false });
  const { isPending: cloneQuizIsPending, mutate: cloneQuiz } = useCloneQuiz({
    errorToast: false,
  });
  const frozen = useAccountFrozen();
  const navigate = useNavigate();
  const router = useRouter();
  const canGoBack = useCanGoBack();

  if (fetchStatus === 'paused') {
    return (
      <PanelWithInvertedRadius>
        <QueryPausedState className="h-full" />
      </PanelWithInvertedRadius>
    );
  }
  if (isLoading || (!isFetchedAfterMount && !isError)) return <LoadingPanel />;
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

  return (
    <AttemptBody
      actions={
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
      }
      grade={async (answers) => {
        const attempt = await submit({ answers, quizId });
        return {
          awarded: attempt.correct,
          max: attempt.total,
          questions: attempt.questions,
        };
      }}
      name={quiz.name}
      onBack={
        shared
          ? undefined
          : () =>
              canGoBack
                ? router.history.back()
                : void navigate({ search: { tab: 'blocks' }, to: '/files' })
      }
      provenance={quiz.provenance}
      questions={quiz.questions}
      trail={
        shared
          ? [m.quiz_shared()]
          : [quiz.workspaceName || m.files_tab_blocks(), m.quiz_quizzes()]
      }
    />
  );
}

/** Signed-out attempt: graded by the share route and kept in this browser. */
function AnonymousAttempt({ token }: { token: string }) {
  const {
    data: quiz,
    error,
    isError,
    isLoading,
  } = useQuery({
    ...anonymousQuizQuery(token),
    retry: false,
  });
  const [past, setPast] = useState<LocalQuizAttempt[]>([]);
  const quizId = quiz?.id;
  useEffect(() => {
    if (!quizId) return;
    localQuizAttempts(quizId)
      .then(setPast)
      .catch(() => setPast([]));
  }, [quizId]);

  if (isLoading)
    return (
      <PublicQuizFrame>
        <Skeleton className="h-[60vh] w-full" />
      </PublicQuizFrame>
    );
  if (isError || !quiz)
    return (
      <PublicQuizFrame>
        <WorkspaceError
          title={
            isApiError(error) && error.status === 404
              ? m.error_private_title()
              : m.quiz_unable_load()
          }
        />
      </PublicQuizFrame>
    );

  return (
    <PublicAssetUrlContext.Provider
      value={(assetId) => anonymousAssetUrl(token, assetId)}
    >
      <AttemptBody
        footer={
          <div className="mt-6 grid gap-2 text-fg-muted">
            <p className="t-meta">{m.quiz_saved_in_browser()}</p>
            {past.length > 0 && (
              <>
                <p className="t-meta font-semibold">{m.quiz_past_attempts()}</p>
                <ul className="t-meta grid gap-1">
                  {past.map((attempt) => (
                    <li key={attempt.id}>
                      {new Date(attempt.takenAt).toLocaleString()} ·{' '}
                      {attempt.correct} / {attempt.total}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        }
        frame={PublicQuizFrame}
        grade={async (answers) =>
          gradeAnonymousQuiz(token, {
            answers,
            localId: await anonymousId().catch(() => undefined),
          })
        }
        name={quiz.name}
        onGraded={(answers, graded) => {
          const attempt: LocalQuizAttempt = {
            answers,
            correct: graded.awarded,
            id: crypto.randomUUID(),
            questions: graded.questions,
            quizId: quiz.id,
            quizName: quiz.name,
            takenAt: new Date().toISOString(),
            total: graded.max,
          };
          saveLocalQuizAttempt(attempt)
            .then(() => setPast((current) => [attempt, ...current]))
            .catch(() =>
              userToast({
                title: m.quiz_browser_save_failed(),
                variant: 'error',
              })
            );
        }}
        provenance={quiz.provenance}
        questions={quiz.questions}
        trail={[m.quiz_shared()]}
      />
    </PublicAssetUrlContext.Provider>
  );
}

/** Signed-out pages use the summary page's public layout and header. */
function PublicQuizFrame({ children }: { children: ReactNode }) {
  return (
    <PublicPage returnTo={window.location.pathname}>{children}</PublicPage>
  );
}

function AttemptBody({
  actions,
  footer,
  frame: Frame = PanelWithInvertedRadius,
  grade,
  name,
  onBack,
  onGraded,
  provenance,
  questions,
  trail,
}: {
  actions?: ReactNode;
  footer?: ReactNode;
  /** The surrounding panel; the result view remounts it to open at the top. */
  frame?: (props: { children: ReactNode }) => ReactNode;
  /** Grades every part on the server; signed in, this also records the attempt. */
  grade: (answers: Answers) => Promise<Graded>;
  name: string;
  onBack?: () => void;
  /** Signed out: keeps the graded attempt in this browser. */
  onGraded?: (answers: Answers, graded: Graded) => void;
  provenance?: Provenance;
  /** Answer-free: the key arrives with the graded attempt. */
  questions: (Question | LearnerQuestion)[];
  trail: string[];
}) {
  const [answers, setAnswers] = useState<Answers>({});
  const [graded, setGraded] = useState<Graded | null>(null);
  const [grading, setGrading] = useState(false);
  const setAnswer = useCallback(
    (partId: string, value: Answer) =>
      setAnswers((current) => ({ ...current, [partId]: value })),
    []
  );

  const header = (headerActions?: ReactNode) => (
    <QuizPageHeader
      actions={headerActions}
      meta={quizMeta(questions)}
      onBack={onBack}
      title={name}
      // The app bar belongs in the panel's notch; public pages have their own header.
      topBar={Frame === PanelWithInvertedRadius}
      trail={trail}
    />
  );

  if (!questions.length) {
    return (
      <Frame>
        {header()}
        <TabContent>
          <p className="text-fg-muted">{m.quiz_no_questions()}</p>
          <Link
            className="mt-6 inline-flex"
            preload="intent"
            search={{ tab: 'blocks' }}
            to="/files"
          >
            <Button className="rounded-input" iconLeft="navigationBack">
              {m.quiz_back()}
            </Button>
          </Link>
        </TabContent>
      </Frame>
    );
  }

  async function finish() {
    setGrading(true);
    try {
      const result = await grade(answers);
      const pct = result.max > 0 ? (result.awarded / result.max) * 100 : 0;
      track('quiz_attempt_finished', { scoreBucket: scoreBucket(pct) });
      setGraded(result);
      onGraded?.(answers, result);
    } catch (err) {
      if (isAnonymousGradingLimit(err)) {
        toastSignInRequired(
          m.quiz_anonymous_limit_title(),
          m.quiz_anonymous_limit_body()
        );
        return;
      }
      userToast({
        description: errorCopy(err, m.quiz_grade_failed_body()),
        title: m.quiz_grade_failed(),
        variant: 'error',
      });
    } finally {
      setGrading(false);
    }
  }

  if (graded) {
    return (
      // A fresh panel so the result opens at the top, not at the quiz's scroll.
      <Frame key="result">
        {header()}
        <TabContent>
          <QuizScore
            awarded={graded.awarded}
            confetti
            max={graded.max}
            questions={graded.questions}
          />
          <div className="mt-12">
            <QuizQuestionList
              answers={answers}
              credits={provenance?.questions}
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
            }}
            size="lg"
            variant="outline"
          >
            {m.quiz_redo()}
          </Button>
          {footer}
          <MaterialAttributionFooter provenance={provenance} />
        </TabContent>
      </Frame>
    );
  }

  const parts = questions.flatMap((q) => q.parts.map((part) => part.id));
  const answered = parts.filter((id) => isAnswered(answers[id])).length;

  return (
    <Frame>
      {header(actions)}
      <TabContent>
        <QuizQuestionList
          answers={answers}
          credits={provenance?.questions}
          onChange={setAnswer}
          questions={questions}
        />
        <div className="mt-12 grid gap-3">
          <p className="t-meta text-fg-muted">
            {m.quiz_answered_count({ answered, total: parts.length })}
          </p>
          <Button
            className="rounded-input"
            disabled={grading}
            fullWidth
            onClick={() => void finish()}
            size="lg"
          >
            {grading ? m.quiz_grading() : m.quiz_submit()}
          </Button>
        </div>
        {footer}
        <MaterialAttributionFooter provenance={provenance} />
      </TabContent>
    </Frame>
  );
}

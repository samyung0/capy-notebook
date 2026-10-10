import {
  Link,
  linkOptions,
  useNavigate,
  useParams,
} from '@tanstack/react-router';
import { useAttempt, useQuiz } from '@/api/hooks';
import { ErrorState } from '@/components/app/ErrorState';
import { PanelWithInvertedRadius } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { TopInsetBar } from '@/components/app/TopInsetBar';
import { TabContent } from '@/components/app/tabPanel';
import { ErrorAction } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/feedback';
import { UnderlineLink } from '@/components/ui/UnderlineLink';
import { MaterialAttributionFooter } from '@/features/materials/MaterialAttributionFooter';
import type { Answer } from '@/features/quizzes/grade';
import {
  QuizPageHeader,
  QuizQuestionList,
  QuizScore,
} from '@/features/quizzes/QuizPage';
import { getLocale, m } from '@/i18n';

export default function AttemptResult() {
  const params = useParams({ strict: false });
  const attemptId = (params as { attemptId: string }).attemptId;
  const navigate = useNavigate();
  const {
    data: attempt,
    fetchStatus,
    isLoading,
    isError,
  } = useAttempt(attemptId, {
    errorBoundary: false,
  });
  // The attempt snapshot carries no provenance; the quiz it was taken from
  // does, and the credit has to survive onto the result page. The query is
  // disabled until the attempt names its material, and a deleted quiz simply
  // renders no footer.
  const { data: quiz } = useQuiz(attempt?.materialId ?? '', {
    errorBoundary: false,
  });

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

  if (isError || !attempt) {
    return (
      <PanelWithInvertedRadius>
        <ErrorState
          action={
            <ErrorAction
              asChild
              iconLeft="navigationBack"
              iconLeftClassName="me-1"
            >
              <Link preload="intent" to="/learning">
                {m.quiz_back()}
              </Link>
            </ErrorAction>
          }
          title={m.quiz_attempt_unavailable()}
          variant="page"
        />
      </PanelWithInvertedRadius>
    );
  }

  const answers = attempt.answers as Record<string, Answer>;
  const hasBreakdown = attempt.questions.length > 0;

  return (
    <PanelWithInvertedRadius
      header={
        <QuizPageHeader
          actions={
            attempt.materialId && (
              <UnderlineLink accent asChild>
                <Link
                  params={{ quizId: attempt.materialId }}
                  preload="intent"
                  to="/quizzes/$quizId/attempt"
                >
                  {m.quiz_redo()}
                </Link>
              </UnderlineLink>
            )
          }
          meta={[
            new Date(attempt.takenAt).toLocaleDateString(getLocale(), {
              day: 'numeric',
              month: 'short',
              year: 'numeric',
            }),
            attempt.workspaceName,
          ]
            .filter(Boolean)
            .join(' · ')}
          onBack={() =>
            void navigate({ search: { tab: 'results' }, to: '/learning' })
          }
          title={attempt.quizName}
          topBar={<TopInsetBar className="hidden shrink-0 lg:flex" />}
          trail={[
            { label: m.nav_learning(), link: linkOptions({ to: '/learning' }) },
            {
              label: m.learning_tab_results(),
              link: linkOptions({
                search: { tab: 'results' },
                to: '/learning',
              }),
            },
          ]}
        />
      }
    >
      <TabContent>
        {hasBreakdown ? (
          <>
            <QuizScore
              awarded={attempt.correct}
              max={attempt.total}
              questions={attempt.questions}
            />
            <div className="mt-12">
              <QuizQuestionList
                answers={answers}
                credits={quiz?.provenance?.questions}
                questions={attempt.questions}
                review
              />
            </div>
          </>
        ) : (
          <p className="text-fg-muted">{m.quiz_no_breakdown()}</p>
        )}
        <MaterialAttributionFooter provenance={quiz?.provenance} />
      </TabContent>
    </PanelWithInvertedRadius>
  );
}

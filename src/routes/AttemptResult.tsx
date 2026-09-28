import { Link, useParams } from '@tanstack/react-router';
import { useAttempt, useQuiz } from '@/api/hooks';
import { ErrorState } from '@/components/app/ErrorState';
import { Panel } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { Badge } from '@/components/ui/Badge';
import { Button, ErrorAction } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { MaterialAttributionFooter } from '@/features/materials/MaterialAttributionFooter';
import { type Answer, formatPoints } from '@/features/quizzes/grade';
import { QuestionRunner } from '@/features/quizzes/QuestionRunner';
import { m } from '@/i18n';

function scoreTone(pct: number): 'green' | 'amber' | 'coral' {
  return pct >= 70 ? 'green' : pct >= 55 ? 'amber' : 'coral';
}

export default function AttemptResult() {
  const params = useParams({ strict: false });
  const attemptId = (params as { attemptId: string }).attemptId;
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
      <Panel sectionClassName="h-full">
        <QueryPausedState className="h-full" />
      </Panel>
    );
  }

  if (isLoading) {
    return (
      <Panel sectionClassName="h-full">
        <div className="h-full p-6">
          <Skeleton className="h-full w-full" />
        </div>
      </Panel>
    );
  }

  if (isError || !attempt) {
    return (
      <Panel sectionClassName="h-full">
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
      </Panel>
    );
  }

  const answers = attempt.answers as Record<string, Answer>;
  const hasBreakdown = attempt.questions.length > 0;

  return (
    <Panel sectionClassName="h-full">
      <div className="mx-auto flex h-full w-full max-w-2xl flex-col overflow-auto px-4 py-6 md:px-6">
        <div className="mb-4 flex items-center gap-3">
          <Link
            className="text-fg-muted hover:text-fg"
            preload="intent"
            to="/learning"
          >
            <Icon name="navigationBack" size={20} />
          </Link>
          <div className="flex-1">
            <h2 className="t-large-card-title">{attempt.quizName}</h2>
            <p className="t-meta text-fg-muted">
              {attempt.workspaceName} ·{' '}
              {new Date(attempt.takenAt).toLocaleString()}
            </p>
          </div>
          <Badge
            tone={
              attempt.pct >= 70
                ? 'success'
                : attempt.pct >= 55
                  ? 'warning'
                  : 'error'
            }
          >
            {formatPoints(attempt.correct)}/{formatPoints(attempt.total)} ·{' '}
            {attempt.pct}%
          </Badge>
        </div>

        <div className="mb-6">
          <ProgressBar
            height={8}
            tone={scoreTone(attempt.pct)}
            value={attempt.pct}
          />
          <p className="t-meta mt-2 text-fg-muted">
            {m.quiz_score_reference()}
          </p>
        </div>

        {hasBreakdown ? (
          <div className="flex flex-col gap-4">
            {attempt.questions.map((question, i) => (
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
        ) : (
          <p className="py-8 text-center text-fg-muted">
            {m.quiz_no_breakdown()}
          </p>
        )}

        <div className="mt-6">
          <Link preload="intent" to="/learning">
            <Button iconLeft="navigationBack">{m.quiz_back()}</Button>
          </Link>
        </div>
        <MaterialAttributionFooter provenance={quiz?.provenance} />
      </div>
    </Panel>
  );
}

import {
  Link,
  linkOptions,
  useNavigate,
  useParams,
} from '@tanstack/react-router';
import { useAttempt, useFlashcardSet, useQuiz } from '@/api/hooks';
import { ErrorState } from '@/components/app/ErrorState';
import { PanelWithInvertedRadius } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { TopInsetBar } from '@/components/app/TopInsetBar';
import { TabContent } from '@/components/app/tabPanel';
import { ErrorAction } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/feedback';
import { UnderlineLink } from '@/components/ui/UnderlineLink';
import { FlashcardResult } from '@/features/flashcards/FlashcardResult';
import { SourcesLine } from '@/features/materials/MaterialAttributionFooter';
import type { Answer } from '@/features/quizzes/grade';
import { QuizQuestionList, QuizScore } from '@/features/quizzes/QuizPage';
import { QuizPageHeader } from '@/features/quizzes/QuizPageHeader';
import { attemptMeta, attemptMinutes } from '@/features/study/attempts';
import { m } from '@/i18n';
import { unexpectedErrorId } from '@/lib/errors';
import { waitsForConnection } from '@/lib/online';

/** A quiz or flashcard attempt's result, under Learning / All results. */
export default function AttemptResult() {
  const params = useParams({ strict: false });
  const attemptId = (params as { attemptId: string }).attemptId;
  const navigate = useNavigate();
  const {
    data: attempt,
    error,
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
  const cards = attempt?.kind === 'flashcards';
  const { data: quiz } = useQuiz(cards ? '' : (attempt?.materialId ?? ''), {
    errorBoundary: false,
  });
  const { data: set } = useFlashcardSet(
    cards ? (attempt?.materialId ?? '') : '',
    { errorBoundary: false }
  );

  if (waitsForConnection(fetchStatus, attempt)) {
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
            <ErrorAction asChild back>
              <Link preload="intent" to="/learning">
                {m.quiz_back()}
              </Link>
            </ErrorAction>
          }
          errorId={unexpectedErrorId(error)}
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
          meta={attemptMeta(attempt)}
          // The date and workspace match the score's minutes and stat line.
          metaClassName="text-fg-secondary text-sm"
          onBack={() =>
            void navigate({ search: { tab: 'results' }, to: '/learning' })
          }
          title={attempt.quizName}
          topBar={<TopInsetBar className="hidden shrink-0 xl:flex" />}
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
      <TabContent wide>
        {/* In the gap under the header, flush with the content's right edge. */}
        {attempt.materialId && (
          <div className="-mt-2 mb-6 flex justify-end sm:-mt-5 sm:mb-3">
            <UnderlineLink accent asChild>
              {cards ? (
                <Link
                  params={{ flashcardSetId: attempt.materialId }}
                  preload="intent"
                  to="/flashcards/$flashcardSetId"
                >
                  {m.flashcards_study_again()}
                </Link>
              ) : (
                <Link
                  params={{ quizId: attempt.materialId }}
                  preload="intent"
                  to="/quizzes/$quizId/attempt"
                >
                  {m.quiz_redo()}
                </Link>
              )}
            </UnderlineLink>
          </div>
        )}
        {cards ? (
          <FlashcardResult
            cards={attempt.cards}
            minutes={attempt.startedAt ? attemptMinutes(attempt) : undefined}
            previous={attempt.previous}
          />
        ) : hasBreakdown ? (
          <>
            <QuizScore
              awarded={attempt.correct}
              max={attempt.total}
              minutes={attempt.startedAt ? attemptMinutes(attempt) : undefined}
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
        <SourcesLine
          className="mt-16 pb-4"
          provenance={(cards ? set : quiz)?.provenance}
        />
      </TabContent>
    </PanelWithInvertedRadius>
  );
}

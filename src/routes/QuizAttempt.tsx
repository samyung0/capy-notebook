import {
  Link,
  useCanGoBack,
  useNavigate,
  useParams,
  useRouter,
} from '@tanstack/react-router';
import { useState } from 'react';
import { useQuiz, useSubmitAttempt, useWorkspace } from '@/api/hooks';
import { isMissing } from '@/api/queryClient';
import { PagePanel } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { WorkspaceError } from '@/components/app/WorkspaceError';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/feedback';
import {
  RemovedAssetsContext,
  useRemovedAssets,
} from '@/features/materials/MediaAssetView';
import type { LearnerQuestion } from '@/features/questions/types';
import { AttemptBody } from '@/features/quizzes/AttemptBody';
import { blockHomeCrumb } from '@/features/quizzes/crumbs';
import { useLiveQuizQuestions } from '@/features/quizzes/liveQuizReads';
import { CloneItemDialog } from '@/features/workspace/CloneItemDialog';
import { useAccountFrozen } from '@/features/workspace/WorkspaceHealth';
import { m } from '@/i18n';

const NO_QUESTIONS: LearnerQuestion[] = [];

/** `/quizzes/$quizId/attempt`, inside the app. Shared links open the public
 * page instead (src/share/SharedQuiz.tsx). */
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
    refetch,
  } = useQuiz(quizId, {
    errorBoundary: 'unlessMissing',
    fresh: true,
  });
  const { mutateAsync: submit } = useSubmitAttempt({ errorToast: false });
  // The questions follow the quiz's live room as editors change them (D9).
  const questions = useLiveQuizQuestions(
    quizId,
    quiz?.questions ?? NO_QUESTIONS,
    !!quiz
  );
  const [cloning, setCloning] = useState(false);
  // In a workspace only its members and editors clone, and an embedded item
  // goes with its note.
  const { data: workspace } = useWorkspace(quiz?.workspaceId ?? '', {
    errorBoundary: false,
  });
  const frozen = useAccountFrozen();
  const navigate = useNavigate();
  const router = useRouter();
  const canGoBack = useCanGoBack();
  const removed = useRemovedAssets(quiz?.removedAssetIds, refetch);

  if (fetchStatus === 'paused') {
    return (
      <PagePanel>
        <QueryPausedState className="h-full" />
      </PagePanel>
    );
  }
  if (isLoading || (!isFetchedAfterMount && !isError))
    return (
      <PagePanel>
        <div className="h-full p-6">
          <Skeleton className="h-full w-full" />
        </div>
      </PagePanel>
    );
  // Other failures without data go to the error boundary.
  if (isMissing(error) || !quiz)
    return <WorkspaceError backLabel={m.quiz_back()} backTo="/quizzes" />;

  return (
    <RemovedAssetsContext.Provider value={removed}>
      <AttemptBody
        actions={
          !quiz.canEdit &&
          !quiz.parentMaterialId &&
          (!quiz.workspaceId || workspace?.canClone) && (
            <>
              <Button
                disabled={frozen}
                iconLeft="plus"
                onClick={() => setCloning(true)}
                rounded="large"
                size="sm"
                variant="outline"
              >
                {m.action_clone_quiz()}
              </Button>
              {cloning && (
                <CloneItemDialog
                  item={{
                    id: quiz.id,
                    kind: 'quiz',
                    name: quiz.name,
                    type: 'material',
                    workspaceId: quiz.workspaceId,
                  }}
                  onClose={() => setCloning(false)}
                />
              )}
            </>
          )
        }
        emptyAction={
          <Link
            className="mt-6 inline-flex"
            preload="intent"
            search={{ tab: 'blocks' }}
            to="/files"
          >
            <Button iconLeft="navigationBack" rounded="large">
              {m.quiz_back()}
            </Button>
          </Link>
        }
        frame={PagePanel}
        grade={async (answers, startedAt) => {
          const attempt = await submit({ answers, quizId, startedAt });
          return {
            awarded: attempt.correct,
            max: attempt.total,
            questions: attempt.questions,
          };
        }}
        inApp
        name={quiz.name}
        onBack={() =>
          canGoBack
            ? router.history.back()
            : void navigate({ search: { tab: 'blocks' }, to: '/files' })
        }
        provenance={quiz.provenance}
        questions={questions}
        trail={[blockHomeCrumb(quiz)]}
      />
    </RemovedAssetsContext.Provider>
  );
}

import {
  Link,
  useCanGoBack,
  useNavigate,
  useParams,
  useRouter,
} from '@tanstack/react-router';
import { isApiError } from '@/api/client';
import { useCloneQuiz, useQuiz, useSubmitAttempt } from '@/api/hooks';
import { PanelWithInvertedRadius } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { TopInsetBar } from '@/components/app/TopInsetBar';
import { WorkspaceError } from '@/components/app/WorkspaceError';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/feedback';
import { AttemptBody } from '@/features/quizzes/AttemptBody';
import { blockHomeCrumb, blockKindCrumb } from '@/features/quizzes/QuizPage';
import { useAccountFrozen } from '@/features/workspace/WorkspaceHealth';
import { m } from '@/i18n';
import { toastCloneError } from '@/lib/authToasts';

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
  if (isLoading || (!isFetchedAfterMount && !isError))
    return (
      <PanelWithInvertedRadius>
        <div className="h-full p-6">
          <Skeleton className="h-full w-full" />
        </div>
      </PanelWithInvertedRadius>
    );
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
            rounded="large"
            size="sm"
            variant="outline"
          >
            {cloneQuizIsPending ? m.action_cloning() : m.quiz_clone()}
          </Button>
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
      frame={PanelWithInvertedRadius}
      grade={async (answers) => {
        const attempt = await submit({ answers, quizId });
        return {
          awarded: attempt.correct,
          max: attempt.total,
          questions: attempt.questions,
        };
      }}
      name={quiz.name}
      onBack={() =>
        canGoBack
          ? router.history.back()
          : void navigate({ search: { tab: 'blocks' }, to: '/files' })
      }
      provenance={quiz.provenance}
      questions={quiz.questions}
      topBar={<TopInsetBar className="hidden shrink-0 lg:flex" />}
      trail={[blockHomeCrumb(quiz), blockKindCrumb(m.quiz_quizzes(), 'quiz')]}
    />
  );
}

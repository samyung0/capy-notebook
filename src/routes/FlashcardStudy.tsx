import {
  useCanGoBack,
  useNavigate,
  useParams,
  useRouter,
} from '@tanstack/react-router';
import { isApiError } from '@/api/client';
import {
  useCards,
  useCloneFlashcardSet,
  useFlashcardSet,
  useRateReviewItem,
} from '@/api/hooks';
import { PanelWithInvertedRadius } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { TopInsetBar } from '@/components/app/TopInsetBar';
import { WorkspaceError } from '@/components/app/WorkspaceError';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/feedback';
import { userToast } from '@/components/ui/userToast';
import { StudyBody } from '@/features/flashcards/StudyBody';
import { useAccountFrozen } from '@/features/workspace/WorkspaceHealth';
import { m } from '@/i18n';
import { cardCountBucket, flashcardsStudySource } from '@/lib/analytics';
import { toastCloneError } from '@/lib/authToasts';
import { track } from '@/lib/observability';
import { SRS_RATINGS } from '@/lib/srs';

/** `/flashcards/$flashcardSetId`, inside the app. Shared links open the public
 * page instead (src/share/SharedFlashcards.tsx). */
export default function FlashcardStudy() {
  const params = useParams({ strict: false });
  const setId = (params as { flashcardSetId: string }).flashcardSetId;
  return <Study key={setId} setId={setId} />;
}

function Study({ setId }: { setId: string }) {
  const {
    data: set,
    fetchStatus: setFetchStatus,
    isFetchedAfterMount: setFetched,
    error: setError,
  } = useFlashcardSet(setId, { errorBoundary: false, fresh: true });
  const {
    data: cards,
    fetchStatus: cardsFetchStatus,
    isFetchedAfterMount: cardsFetched,
    error: cardsError,
  } = useCards(setId, { errorBoundary: false, fresh: true });
  const { mutateAsync: rateItem } = useRateReviewItem();
  const { isPending: cloneIsPending, mutate: cloneSet } = useCloneFlashcardSet({
    errorToast: false,
  });
  const frozen = useAccountFrozen();
  const navigate = useNavigate();
  const router = useRouter();
  const canGoBack = useCanGoBack();

  if (setFetchStatus === 'paused' || cardsFetchStatus === 'paused') {
    return (
      <PanelWithInvertedRadius>
        <QueryPausedState className="h-full" />
      </PanelWithInvertedRadius>
    );
  }
  const error = setError ?? cardsError;
  if (error) {
    const denied =
      isApiError(error) && (error.status === 404 || error.status === 401);
    return (
      <WorkspaceError
        backLabel={m.flashcards_back_to()}
        backTo="/flashcards"
        title={denied ? m.error_private_title() : m.flashcards_unable_load()}
      />
    );
  }
  if (!set || !cards || !setFetched || !cardsFetched)
    return (
      <PanelWithInvertedRadius>
        <div className="h-full p-6">
          <Skeleton className="h-full w-full" />
        </div>
      </PanelWithInvertedRadius>
    );

  return (
    <StudyBody
      actions={
        !set.canEdit && (
          <Button
            disabled={frozen || cloneIsPending}
            iconLeft="plus"
            onClick={() =>
              cloneSet(setId, {
                onError: (err) => toastCloneError(err, 'flashcards'),
                onSuccess: (copy) => {
                  navigate({
                    params: { flashcardSetId: copy.id },
                    to: '/flashcards/$flashcardSetId',
                  });
                },
              })
            }
            rounded="large"
            size="sm"
            variant="outline"
          >
            {cloneIsPending ? m.action_cloning() : m.action_clone_flashcards()}
          </Button>
        )
      }
      cards={cards}
      frame={PanelWithInvertedRadius}
      name={set.name}
      onBack={() =>
        canGoBack
          ? router.history.back()
          : void navigate({ search: { tab: 'blocks' }, to: '/files' })
      }
      onFinished={(total) =>
        track('flashcards_study_finished', {
          cardCountBucket: cardCountBucket(total),
          source: flashcardsStudySource(window.location.pathname),
        })
      }
      onRate={(card, rating) =>
        // Every reader records their own progress, except in a set embedded in
        // a note, which records nothing. One toast however many ratings fail
        // in a row.
        !set.parentMaterialId &&
        rateItem({
          itemId: card.id,
          materialId: setId,
          rating: SRS_RATINGS.indexOf(rating) + 1,
        }).catch(() =>
          userToast({
            button: {
              label: m.error_action_reload(),
              onClick: () => window.location.reload(),
            },
            id: 'flashcard-review-failed',
            title: m.flashcards_review_failed(),
            variant: 'error',
          })
        )
      }
      provenance={set.provenance}
      topBar={<TopInsetBar className="hidden shrink-0 lg:flex" />}
      trail={[set.workspaceName || m.files_tab_blocks(), m.editor_flashcards()]}
    />
  );
}

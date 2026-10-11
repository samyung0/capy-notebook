import {
  useCanGoBack,
  useNavigate,
  useParams,
  useRouter,
} from '@tanstack/react-router';
import { useState } from 'react';
import {
  useCards,
  useFlashcardSet,
  useRateReviewItem,
  useWorkspace,
} from '@/api/hooks';
import { isMissing } from '@/api/queryClient';
import { PanelWithInvertedRadius } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { TopInsetBar } from '@/components/app/TopInsetBar';
import { WorkspaceError } from '@/components/app/WorkspaceError';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/feedback';
import { userToast } from '@/components/ui/userToast';
import { StudyBody } from '@/features/flashcards/StudyBody';
import { blockHomeCrumb, blockKindCrumb } from '@/features/quizzes/crumbs';
import { CloneItemDialog } from '@/features/workspace/CloneItemDialog';
import { useAccountFrozen } from '@/features/workspace/WorkspaceHealth';
import { m } from '@/i18n';
import { cardCountBucket, flashcardsStudySource, track } from '@/lib/analytics';
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
  } = useFlashcardSet(setId, { errorBoundary: 'unlessMissing', fresh: true });
  const {
    data: cards,
    fetchStatus: cardsFetchStatus,
    isFetchedAfterMount: cardsFetched,
    error: cardsError,
  } = useCards(setId, { errorBoundary: 'unlessMissing', fresh: true });
  const { mutateAsync: rateItem } = useRateReviewItem();
  const [cloning, setCloning] = useState(false);
  // In a workspace only its members and editors clone, and an embedded item
  // goes with its note.
  const { data: workspace } = useWorkspace(set?.workspaceId ?? '', {
    errorBoundary: false,
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
  // Other failures without data go to the error boundary.
  if (isMissing(setError) || isMissing(cardsError))
    return (
      <WorkspaceError backLabel={m.flashcards_back_to()} backTo="/flashcards" />
    );
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
        !set.canEdit &&
        !set.parentMaterialId &&
        (!set.workspaceId || workspace?.canClone) && (
          <>
            <Button
              disabled={frozen}
              iconLeft="plus"
              onClick={() => setCloning(true)}
              rounded="large"
              size="sm"
              variant="outline"
            >
              {m.action_clone_flashcards()}
            </Button>
            {cloning && (
              <CloneItemDialog
                item={{
                  id: set.id,
                  kind: 'flashcards',
                  name: set.name,
                  type: 'material',
                  workspaceId: set.workspaceId,
                }}
                onClose={() => setCloning(false)}
              />
            )}
          </>
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
      trail={[
        blockHomeCrumb(set),
        blockKindCrumb(m.editor_flashcards(), 'flashcards'),
      ]}
    />
  );
}

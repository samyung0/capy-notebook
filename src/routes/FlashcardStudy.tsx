import {
  useCanGoBack,
  useNavigate,
  useParams,
  useRouter,
} from '@tanstack/react-router';
import { useState } from 'react';
import {
  useAttempt,
  useCards,
  useFlashcardSet,
  useRateReviewItem,
  useWorkspace,
} from '@/api/hooks';
import { isMissing } from '@/api/queryClient';
import { PagePanel } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { WorkspaceError } from '@/components/app/WorkspaceError';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/feedback';
import { userToast } from '@/components/ui/userToast';
import { useLiveSetCards } from '@/features/flashcards/liveReads';
import { StudyBody } from '@/features/flashcards/StudyBody';
import type { FlashcardContent } from '@/features/materials/blocks';
import { blockHomeCrumb } from '@/features/quizzes/crumbs';
import { CloneItemDialog } from '@/features/workspace/CloneItemDialog';
import { useAccountFrozen } from '@/features/workspace/WorkspaceHealth';
import { m } from '@/i18n';
import { cardCountBucket, flashcardsStudySource, track } from '@/lib/analytics';
import { SRS_RATINGS } from '@/lib/srs';

const NO_CARDS: FlashcardContent[] = [];

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
  // The study session follows the set's live room (Epo 2026-10-10): edits
  // show as they land, added cards join the end of the session.
  const liveCards = useLiveSetCards(setId, cards ?? NO_CARDS, !!cards);
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
      <PagePanel>
        <QueryPausedState className="h-full" />
      </PagePanel>
    );
  }
  // Other failures without data go to the error boundary.
  if (isMissing(setError) || isMissing(cardsError))
    return (
      <WorkspaceError backLabel={m.flashcards_back_to()} backTo="/flashcards" />
    );
  if (!set || !cards || !setFetched || !cardsFetched)
    return (
      <PagePanel>
        <div className="h-full p-6">
          <Skeleton className="h-full w-full" />
        </div>
      </PagePanel>
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
      cards={liveCards}
      frame={PagePanel}
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
      onRate={(card, rating, attempt) =>
        // Every reader records their own progress, except in a set embedded in
        // a note, which records nothing; the server keeps the attempt for a
        // workspace set. One toast however many ratings fail in a row.
        !set.parentMaterialId &&
        rateItem({
          attempt,
          itemId: card.id,
          materialId: setId,
          rating: SRS_RATINGS.indexOf(rating) + 1,
        }).catch(() =>
          userToast({
            id: 'flashcard-review-failed',
            title: m.flashcards_review_failed(),
            variant: 'error',
          })
        )
      }
      provenance={set.provenance}
      trail={[blockHomeCrumb(set)]}
      usePrevious={
        set.workspaceId && !set.parentMaterialId
          ? usePreviousAttempt
          : undefined
      }
    />
  );
}

/** A recorded run's attempt read back for the set's attempt before it. */
function usePreviousAttempt(attemptId: string) {
  const { data } = useAttempt(attemptId, { errorBoundary: false });
  return data?.previous;
}

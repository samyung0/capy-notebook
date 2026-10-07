import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useEffect, useRef } from 'react';
import {
  anonymousFlashcardAssetUrl,
  anonymousFlashcardsQuery,
} from '@/api/anonymous';
import { api } from '@/api/client';
import { PublicActionMenu } from '@/components/app/PublicActionMenu';
import { PublicPage } from '@/components/app/PublicHeader';
import { Skeleton } from '@/components/ui/feedback';
import { userToast } from '@/components/ui/userToast';
import { StudyBody } from '@/features/flashcards/StudyBody';
import { AssetUrlContext } from '@/features/materials/MediaAssetView';
import { m } from '@/i18n';
import { cardCountBucket } from '@/lib/analytics';
import { localCardStates, recordLocalCardReview } from '@/lib/localDb';
import { track } from '@/lib/observability';
import {
  newSrsState,
  reviewSrs,
  SRS_RATINGS,
  type SrsRating,
  type SrsState,
} from '@/lib/srs';
import { failureStatus, ShareError } from './ShareError';
import { signedIn, useSignedIn } from './session';

function Frame({ children }: { children: ReactNode }) {
  return <PublicPage>{children}</PublicPage>;
}

/** `/share/flashcards/{token}`: every visitor studies the same cached cards.
 * Each rating asks the session: signed in, it goes to the account's review
 * state; signed out, ts-fsrs runs here and IndexedDB keeps it. */
export function SharedFlashcards({ token }: { token: string }) {
  const {
    data: set,
    error,
    isError,
    isLoading,
  } = useQuery({
    ...anonymousFlashcardsQuery(token),
    // Failures render the summary's failure panel here, not the boundary.
    meta: { errorBoundary: false },
    retry: false,
  });
  const session = useSignedIn();
  const states = useRef(new Map<string, SrsState>());
  // One notice per page however many saves fail.
  const saveFailed = useRef(false);
  const setId = set?.id;

  useEffect(() => {
    if (!setId) return;
    localCardStates(setId)
      .then((rows) => {
        states.current = new Map(rows.map((row) => [row.cardId, row.srs]));
      })
      .catch(() => {});
  }, [setId]);

  if (isLoading)
    return (
      <Frame>
        <Skeleton className="h-[60vh] w-full" />
      </Frame>
    );
  if (isError || !set) return <ShareError status={failureStatus(error)} />;

  const failed = (title: string) => {
    if (saveFailed.current) return;
    saveFailed.current = true;
    userToast({ title, variant: 'error' });
  };

  async function save(cardId: string, rating: SrsRating) {
    if (!set) return;
    if (await signedIn()) {
      await api
        .post<void>('/review/ratings', {
          itemId: cardId,
          materialId: set.id,
          rating: SRS_RATINGS.indexOf(rating) + 1,
        })
        .catch(() => failed(m.flashcards_review_failed()));
      return;
    }
    const srs = reviewSrs(states.current.get(cardId) ?? newSrsState(), rating);
    states.current.set(cardId, srs);
    await recordLocalCardReview(
      {
        cardId,
        rating,
        reviewedAt: srs.last_review ?? new Date().toISOString(),
        setId: set.id,
      },
      srs
    ).catch(() => failed(m.flashcards_browser_save_failed()));
  }

  return (
    <AssetUrlContext.Provider
      value={(assetId) => anonymousFlashcardAssetUrl(token, assetId)}
    >
      <StudyBody
        actions={<PublicActionMenu id={set.id} kind="flashcards" />}
        author={set.author}
        cards={set.cards}
        footer={
          session === false && (
            <p className="t-meta text-center text-fg-muted">
              {m.flashcards_saved_in_browser()}
            </p>
          )
        }
        frame={Frame}
        name={set.name}
        onFinished={(total) =>
          track('flashcards_study_finished', {
            cardCountBucket: cardCountBucket(total),
            source: 'share',
          })
        }
        onRate={(card, rating) => void save(card.id, rating)}
        provenance={set.provenance}
        trail={[]}
      />
    </AssetUrlContext.Provider>
  );
}

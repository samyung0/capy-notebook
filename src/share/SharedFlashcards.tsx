import { type ReactNode, useEffect, useRef } from 'react';
import { anonymousFlashcardAssetUrl } from '@/api/anonymous';
import type { AnonymousFlashcards } from '@/api/types';
import { PublicActionMenu } from '@/components/app/PublicActionMenu';
import { PublicByline, PublicPage } from '@/components/app/PublicHeader';
import { userToast } from '@/components/ui/userToast';
import { useKeptFlashcardRun } from '@/features/flashcards/flashcardRun';
import { StudyBody } from '@/features/flashcards/StudyBody';
import { AssetUrlContext } from '@/features/materials/MediaAssetView';
import { m } from '@/i18n';
import { cardCountBucket, track } from '@/lib/analytics';
import { localCardStates, recordLocalCardReview } from '@/lib/localDb';
import {
  newSrsState,
  reviewSrs,
  type SrsRating,
  type SrsState,
} from '@/lib/srs';

function Frame({
  children,
  header,
}: {
  children: ReactNode;
  header?: ReactNode;
}) {
  return (
    <PublicPage>
      {header}
      {children}
    </PublicPage>
  );
}

/** `/share/flashcards/{token}`: the Worker renders it from the same
 * edge-cached cards for every visitor and the browser hydrates it. Nothing here
 * counts, signed in or out (Epo 2026-11-06, Q663 A): ts-fsrs runs here and only
 * this browser keeps each rating. */
export function SharedFlashcards({
  set,
  token,
}: {
  set: AnonymousFlashcards;
  token: string;
}) {
  const states = useRef(new Map<string, SrsState>());
  // One notice per page however many saves fail.
  const saveFailed = useRef(false);
  const setId = set.id;
  // The run resumes once the page is live; reading it earlier would not match
  // the server's render.
  const kept = useKeptFlashcardRun('share', setId, set.cards, {
    afterHydration: true,
  });

  useEffect(() => {
    localCardStates(setId)
      .then((rows) => {
        states.current = new Map(rows.map((row) => [row.cardId, row.srs]));
      })
      .catch(() => {});
  }, [setId]);

  async function save(cardId: string, rating: SrsRating) {
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
    ).catch(() => {
      if (saveFailed.current) return;
      saveFailed.current = true;
      userToast({
        title: m.flashcards_browser_save_failed(),
        variant: 'error',
      });
    });
  }

  return (
    <AssetUrlContext.Provider
      value={(assetId) => anonymousFlashcardAssetUrl(token, assetId)}
    >
      <StudyBody
        actions={<PublicActionMenu kind="flashcards" token={token} />}
        byline={<PublicByline author={set.author} updatedAt={set.updatedAt} />}
        cards={set.cards}
        footer={
          <p className="t-meta text-center text-fg-muted">
            {m.flashcards_saved_in_browser()}
          </p>
        }
        frame={Frame}
        key={kept.ready && kept.resume ? 'kept' : 'server'}
        name={set.name}
        onFinished={(total) =>
          track('flashcards_study_finished', {
            cardCountBucket: cardCountBucket(total),
            source: 'share',
          })
        }
        onRate={(card, rating, _attempt, run) => {
          kept.keep(run);
          void save(card.id, rating);
        }}
        onRestart={kept.forget}
        provenance={set.provenance}
        resume={kept.resume}
        trail={[]}
      />
    </AssetUrlContext.Provider>
  );
}

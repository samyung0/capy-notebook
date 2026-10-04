import { useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { anonymousFlashcardsQuery } from '@/api/anonymous';
import { isApiError } from '@/api/client';
import { PublicPage } from '@/components/app/PublicHeader';
import { WorkspaceError } from '@/components/app/WorkspaceError';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { userToast } from '@/components/ui/userToast';
import { MaterialAttributionFooter } from '@/features/materials/MaterialAttributionFooter';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { localCardStates, recordLocalCardReview } from '@/lib/localDb';
import {
  isDue,
  newSrsState,
  ratingPreviews,
  reviewSrs,
  SRS_RATINGS,
  type SrsRating,
  type SrsState,
} from '@/lib/srs';
import { RATING_LABEL, RATING_STYLE } from './FlashcardStudy';

/** Signed-out study of a shared flashcard set: ts-fsrs runs in the browser
 * and every rating is logged to IndexedDB, never to the server. */
export function AnonymousFlashcardStudy({ token }: { token: string }) {
  const {
    data: set,
    error,
    isError,
    isLoading,
  } = useQuery({
    ...anonymousFlashcardsQuery(token),
    retry: false,
  });
  const [states, setStates] = useState<Map<string, SrsState> | null>(null);
  const [queue, setQueue] = useState<string[] | null>(null);
  const [sessionTotal, setSessionTotal] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const saveFailed = useRef(false);
  const setId = set?.id;

  useEffect(() => {
    if (!setId) return;
    localCardStates(setId)
      .then((rows) => new Map(rows.map((row) => [row.cardId, row.srs])))
      .catch(() => new Map<string, SrsState>())
      .then(setStates);
  }, [setId]);

  const srsOf = (cardId: string) => states?.get(cardId) ?? newSrsState();

  // Seed the session once, from the cards due in this browser.
  useEffect(() => {
    if (!set || !states || queue !== null) return;
    const due = set.cards
      .filter((card) => isDue(states.get(card.id) ?? newSrsState()))
      .map((card) => card.id);
    setQueue(due);
    setSessionTotal(due.length);
  }, [set, states, queue]);

  if (isLoading || (set && (!states || queue === null)))
    return (
      <PublicPage returnTo={window.location.pathname}>
        <Skeleton className="h-[60vh] w-full" />
      </PublicPage>
    );
  if (isError || !set || !states || queue === null)
    return (
      <PublicPage returnTo={window.location.pathname}>
        <WorkspaceError
          title={
            isApiError(error) && error.status === 404
              ? m.error_private_title()
              : m.flashcards_unable_load()
          }
        />
      </PublicPage>
    );

  const card = set.cards.find((c) => c.id === queue[0]);

  function rate(rating: SrsRating) {
    if (!card || !set) return;
    const srs = reviewSrs(srsOf(card.id), rating);
    setStates((current) => new Map(current).set(card.id, srs));
    recordLocalCardReview(
      {
        cardId: card.id,
        rating,
        reviewedAt: srs.last_review ?? new Date().toISOString(),
        setId: set.id,
      },
      srs
    ).catch(() => {
      // One notice per session however many ratings fail.
      if (saveFailed.current) return;
      saveFailed.current = true;
      userToast({
        title: m.flashcards_browser_save_failed(),
        variant: 'error',
      });
    });
    setFlipped(false);
    setQueue((q) => {
      if (!q) return q;
      const [head, ...rest] = q;
      return rating === 'again' ? [...rest, head] : rest;
    });
  }

  const header = <h1 className="t-subtitle mb-4 truncate">{set.name}</h1>;
  const note = (
    <p className="t-meta mt-4 text-center text-fg-muted">
      {m.flashcards_saved_in_browser()}
    </p>
  );

  if (!card) {
    const startAll = () => {
      setQueue(set.cards.map((c) => c.id));
      setSessionTotal(set.cards.length);
      setFlipped(false);
    };
    return (
      <PublicPage returnTo={window.location.pathname}>
        <div className="flex flex-1 flex-col">
          {header}
          <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
            <span className="flex h-16 w-16 items-center justify-center rounded-card-lg bg-tint-success text-tint-success-fg">
              <Icon className="non-scaling-svg" name="check" size={30} />
            </span>
            <h2 className="t-large-card-title">
              {set.cards.length === 0
                ? m.flashcards_empty_flashcards()
                : m.flashcards_all_caught_up()}
            </h2>
            {set.cards.length > 0 && (
              <Button iconLeft="flashcards" onClick={startAll} variant="accent">
                {m.flashcards_study_all()}
              </Button>
            )}
          </div>
          {note}
          <MaterialAttributionFooter provenance={set.provenance} />
        </div>
      </PublicPage>
    );
  }

  const previews = ratingPreviews(srsOf(card.id));
  return (
    <PublicPage returnTo={window.location.pathname}>
      <div className="flex flex-1 flex-col">
        {header}
        <div className="mb-4 flex items-center gap-3">
          <div className="flex-1">
            <ProgressBar
              tone="purple"
              value={
                ((sessionTotal - queue.length) / Math.max(1, sessionTotal)) *
                100
              }
            />
          </div>
          <Badge size="sm">
            {queue.length} {m.flashcards_left()}
          </Badge>
        </div>
        <button
          className="flex min-h-[320px] flex-1 flex-col items-center justify-center rounded-card-lg border border-line bg-surface p-8 text-center shadow-card transition-transform active:scale-[0.99]"
          onClick={() => setFlipped((f) => !f)}
          type="button"
        >
          <p className="t-label text-fg-muted">
            {flipped ? m.flashcards_answer() : m.flashcards_term()}
          </p>
          <h2 className="t-section mt-3">{flipped ? card.back : card.front}</h2>
          <p className="t-meta mt-6 flex items-center gap-1 text-fg-muted">
            <Icon name="message" size={13} /> {m.flashcards_tap_flip()}
          </p>
        </button>
        {flipped ? (
          <div className="mt-3 grid grid-cols-4 gap-2">
            {SRS_RATINGS.map((r) => (
              <button
                className={cn(
                  'flex flex-col items-center gap-0.5 rounded-card border px-2 py-2.5 font-semibold text-sm transition-colors',
                  RATING_STYLE[r]
                )}
                key={r}
                onClick={() => rate(r)}
                type="button"
              >
                {RATING_LABEL[r]()}
                <span className="font-normal text-[11px] tabular-nums opacity-70">
                  {previews[r]}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="mt-3">
            <Button fullWidth onClick={() => setFlipped(true)}>
              {m.flashcards_show_answer()}
            </Button>
          </div>
        )}
        {note}
        <MaterialAttributionFooter provenance={set.provenance} />
      </div>
    </PublicPage>
  );
}

/** `/share/flashcards/$flashcardSetId` for signed-out visitors; the param is
 * the signed share token. */
export function AnonymousFlashcardStudyRoute() {
  const params = useParams({ strict: false });
  const token = (params as { flashcardSetId: string }).flashcardSetId;
  return <AnonymousFlashcardStudy key={token} token={token} />;
}

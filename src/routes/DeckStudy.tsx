import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { isApiError } from '@/api/client';
import {
  useCards,
  useCloneDeck,
  useDeck,
  useDeleteCard,
  useReviewCard,
  useUpdateDeck,
} from '@/api/hooks';
import type { Flashcard } from '@/api/types';
import { PanelWithInvertedRadius } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { WorkspaceError } from '@/components/app/WorkspaceError';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { CardEditModal } from '@/features/flashcards/CardEditModal';
import { ShareDialog } from '@/features/workspace/ShareDialog';
import { m } from '@/i18n';
import { toastCloneError } from '@/lib/authToasts';
import { cn } from '@/lib/cn';
import {
  isDue,
  isKnown,
  ratingPreviews,
  reviewSrs,
  SRS_RATINGS,
  type SrsRating,
} from '@/lib/srs';

const RATING_LABEL: Record<SrsRating, string> = {
  again: 'Again',
  easy: 'Easy',
  good: 'Good',
  hard: 'Hard',
};
const RATING_STYLE: Record<SrsRating, string> = {
  again: 'border-tint-error text-tint-error-fg hover:bg-tint-error',
  easy: 'border-tint-success text-tint-success-fg hover:bg-tint-success',
  good: 'border-tint-accent-1 text-tint-accent-1-fg hover:bg-tint-accent-1',
  hard: 'border-tint-warning text-tint-warning-fg hover:bg-tint-warning',
};

export default function DeckStudy() {
  const params = useParams({ strict: false });
  const deckId = (params as { deckId: string }).deckId;
  const {
    data: deck,
    fetchStatus: deckFetchStatus,
    isLoading: deckLoading,
    isError: deckError,
    error: deckErr,
  } = useDeck(deckId, { errorBoundary: false });
  const {
    data: cards,
    fetchStatus: cardsFetchStatus,
    isLoading,
    isError: cardsError,
    error: cardsErr,
  } = useCards(deckId, { errorBoundary: false });
  const { mutate: reviewCard } = useReviewCard(deckId);
  const { mutate: deleteCard } = useDeleteCard(deckId);
  const { isPending: cloneDeckIsPending, mutate: cloneDeck } = useCloneDeck({
    errorToast: false,
  });
  const { isPending: updateDeckIsPending, mutateAsync: updateDeck } =
    useUpdateDeck();
  const navigate = useNavigate();
  const isOwner = deck?.isOwner === true;

  const [queue, setQueue] = useState<string[] | null>(null);
  const [sessionTotal, setSessionTotal] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [editing, setEditing] = useState<Flashcard | 'new' | null>(null);
  const [shareOpen, setShareOpen] = useState(false);

  const dueIds = useMemo(
    () => (cards ? cards.filter((c) => isDue(c.srs)).map((c) => c.id) : []),
    [cards]
  );

  // Seed the session queue once, from the currently-due cards.
  useEffect(() => {
    if (cards && queue === null) {
      setQueue(dueIds);
      setSessionTotal(dueIds.length);
    }
  }, [cards, queue, dueIds]);

  function startSession(ids: string[]) {
    setQueue(ids);
    setSessionTotal(ids.length);
    setFlipped(false);
  }

  if (deckFetchStatus === 'paused' || cardsFetchStatus === 'paused') {
    return (
      <PanelWithInvertedRadius>
        <QueryPausedState className="h-full" />
      </PanelWithInvertedRadius>
    );
  }

  if (deckLoading || isLoading || !deck || !cards || queue === null) {
    if (
      !deckLoading &&
      !isLoading &&
      (deckError || cardsError || !deck || !cards)
    ) {
      const err = deckErr ?? cardsErr;
      const denied =
        isApiError(err) && (err.status === 404 || err.status === 401);
      return (
        <WorkspaceError
          backLabel="Back to flashcards"
          backTo="/flashcards"
          title={
            denied
              ? 'This item is private or unavailable.'
              : 'Unable to load deck.'
          }
        />
      );
    }
    return (
      <PanelWithInvertedRadius>
        <div className="h-full p-6">
          <Skeleton className="h-full w-full" />
        </div>
      </PanelWithInvertedRadius>
    );
  }

  const card = cards.find((c) => c.id === queue[0]);

  function rate(rating: SrsRating) {
    if (!card) return;
    const srs = reviewSrs(card.srs, rating);
    if (isOwner) reviewCard({ id: card.id, known: isKnown(srs), srs });
    setFlipped(false);
    setQueue((q) => {
      if (!q) return q;
      const [head, ...rest] = q;
      // "Again" cycles the card back to the end of this session.
      return rating === 'again' ? [...rest, head] : rest;
    });
  }

  function removeCurrent() {
    if (!card) return;
    deleteCard(card.id);
    setFlipped(false);
    setQueue((q) => (q ? q.filter((id) => id !== card.id) : q));
  }

  const header = (
    <div className="mb-4 flex items-center gap-3">
      <Link
        className="text-fg-muted hover:text-fg"
        preload="intent"
        to="/flashcards"
      >
        <Icon name="chevronLeft" size={20} />
      </Link>
      <h1 className="t-subtitle flex-1 truncate">{deck?.name}</h1>
      {isOwner ? (
        <>
          <IconButton
            icon="link"
            label="Share deck"
            onClick={() => setShareOpen(true)}
            size="sm"
            variant="outline"
          />
          <IconButton
            icon="plus"
            label={m.flashcards_add_card()}
            onClick={() => setEditing('new')}
            size="sm"
            variant="outline"
          />
        </>
      ) : (
        <Button
          disabled={cloneDeckIsPending}
          iconLeft="plus"
          onClick={() =>
            cloneDeck(deckId, {
              onError: (err) => toastCloneError(err, 'deck'),
              onSuccess: (copy) =>
                navigate({
                  params: { deckId: copy.id },
                  to: '/flashcards/$deckId',
                }),
            })
          }
          size="sm"
        >
          {cloneDeckIsPending ? 'Cloning…' : 'Clone deck'}
        </Button>
      )}
    </div>
  );

  // Nothing left in the session (or an empty/new deck).
  if (!card) {
    const notDue = cards.length - dueIds.length;
    return (
      <PanelWithInvertedRadius>
        <div className="mx-auto flex h-full w-full max-w-2xl flex-col px-6 py-6">
          {header}
          <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
            <span className="flex h-16 w-16 items-center justify-center rounded-card-lg bg-tint-success text-tint-success-fg">
              <Icon name="check" size={30} />
            </span>
            <h2 className="t-large-card-title">
              {cards.length === 0
                ? m.flashcards_empty_deck()
                : m.flashcards_all_caught_up()}
            </h2>
            {cards.length > 0 && (
              <p className="text-fg-muted">
                {m.flashcards_scheduled_hint({ count: notDue })}
              </p>
            )}
            <div className="mt-2 flex gap-3">
              {isOwner && (
                <Button
                  iconLeft="plus"
                  onClick={() => setEditing('new')}
                  variant="outline"
                >
                  {m.flashcards_add_card()}
                </Button>
              )}
              {cards.length > 0 && (
                <Button
                  iconLeft="flashcards"
                  onClick={() => startSession(cards.map((c) => c.id))}
                  variant="accent"
                >
                  {m.flashcards_study_all()}
                </Button>
              )}
            </div>
          </div>
        </div>
        {isOwner && (
          <CardEditModal
            card={null}
            deckId={deckId}
            onClose={() => setEditing(null)}
            open={editing !== null}
          />
        )}
      </PanelWithInvertedRadius>
    );
  }

  const done = sessionTotal - queue.length;
  const previews = ratingPreviews(card.srs);

  return (
    <PanelWithInvertedRadius>
      <div className="mx-auto flex h-full w-full max-w-2xl flex-col px-6 py-6">
        {header}
        <div className="mb-4 flex items-center gap-3">
          <div className="flex-1">
            <ProgressBar
              tone="purple"
              value={(done / Math.max(1, sessionTotal)) * 100}
            />
          </div>
          <Badge size="sm">
            {queue.length} {m.flashcards_left()}
          </Badge>
        </div>

        <button
          className="flex min-h-0 flex-1 flex-col items-center justify-center rounded-card-lg border border-line bg-surface p-8 text-center shadow-card transition-transform active:scale-[0.99]"
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

        {isOwner && (
          <div className="mt-3 flex items-center justify-center gap-4">
            <button
              className="flex items-center gap-1 text-fg-muted text-xs hover:text-fg"
              onClick={() => setEditing(card)}
              type="button"
            >
              <Icon name="write" size={13} /> {m.action_edit()}
            </button>
            <button
              className="flex items-center gap-1 text-fg-muted text-xs hover:text-tint-error-fg"
              onClick={removeCurrent}
              type="button"
            >
              <Icon name="trash" size={13} /> {m.action_delete()}
            </button>
          </div>
        )}

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
                {RATING_LABEL[r]}
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
      </div>

      {isOwner && (
        <CardEditModal
          card={editing === 'new' ? null : editing}
          deckId={deckId}
          onClose={() => setEditing(null)}
          open={editing !== null}
        />
      )}
      {deck && (
        <ShareDialog
          link={`/share/decks/${deck.id}`}
          onClose={() => setShareOpen(false)}
          onPrivacyChange={(privacy) => updateDeck({ id: deck.id, privacy })}
          open={shareOpen}
          privacy={deck.privacy ?? 'private'}
          saving={updateDeckIsPending}
          title={`Share ${deck.name}`}
        />
      )}
    </PanelWithInvertedRadius>
  );
}

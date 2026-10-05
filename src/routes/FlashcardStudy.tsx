import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { isApiError } from '@/api/client';
import {
  cardsQuery,
  flashcardSetQuery,
  useCards,
  useCloneFlashcardSet,
  useDeleteCard,
  useFlashcardSet,
  useRateReviewItem,
  useUpdateFlashcardSetSharing,
} from '@/api/hooks';
import { showErrorToast } from '@/api/queryClient';
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
import { userToast } from '@/components/ui/userToast';
import { CardEditModal } from '@/features/flashcards/CardEditModal';
import { MaterialAttributionFooter } from '@/features/materials/MaterialAttributionFooter';
import { RATING_LABEL, RATING_STYLE } from '@/features/study/ratings';
import { ShareDialog } from '@/features/workspace/ShareDialog';
import { useAccountFrozen } from '@/features/workspace/WorkspaceHealth';
import { m } from '@/i18n';
import { cardCountBucket, flashcardsStudySource } from '@/lib/analytics';
import { toastCloneError } from '@/lib/authToasts';
import { cn } from '@/lib/cn';
import { track } from '@/lib/observability';
import { SRS_RATINGS, type SrsRating } from '@/lib/srs';

export default function FlashcardStudy() {
  const params = useParams({ strict: false });
  // A share link's param is the signed token `{id}.{signature}`.
  const flashcardSetId = (
    params as { flashcardSetId: string }
  ).flashcardSetId.split('.')[0];
  const {
    data: flashcardSet,
    fetchStatus: flashcardSetFetchStatus,
    isLoading: flashcardSetLoading,
    isFetchedAfterMount: setFetched,
    isError: flashcardSetError,
    error: flashcardSetErr,
  } = useFlashcardSet(flashcardSetId, { errorBoundary: false, fresh: true });
  const {
    data: cards,
    fetchStatus: cardsFetchStatus,
    isLoading,
    isFetchedAfterMount: cardsFetched,
    isError: cardsError,
    error: cardsErr,
  } = useCards(flashcardSetId, { errorBoundary: false, fresh: true });
  const { mutateAsync: rateItem } = useRateReviewItem();
  const { mutateAsync: deleteCard } = useDeleteCard(flashcardSetId);
  const queryClient = useQueryClient();
  const { isPending: cloneFlashcardSetIsPending, mutate: cloneFlashcardSet } =
    useCloneFlashcardSet({
      errorToast: false,
    });
  const frozen = useAccountFrozen();
  const {
    isPending: updateFlashcardSetIsPending,
    mutateAsync: updateFlashcardSet,
  } = useUpdateFlashcardSetSharing();
  const navigate = useNavigate();
  const isOwner = flashcardSet?.isOwner === true;
  const canEdit = flashcardSet?.canEdit === true;
  // Card edits are content, off while the storage owner is at its limit.
  const canEditCards = flashcardSet?.canEditContent === true;

  const [queue, setQueue] = useState<string[] | null>(null);
  const [sessionTotal, setSessionTotal] = useState(0);
  const studyFinished = useRef(false);
  const [flipped, setFlipped] = useState(false);
  const [editing, setEditing] = useState<Flashcard | 'new' | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [editRevision, setEditRevision] = useState<number>();

  async function openEdit(card: Flashcard | 'new') {
    if (card === 'new') {
      const latest = await queryClient.fetchQuery({
        ...flashcardSetQuery(flashcardSetId),
        staleTime: 0,
      });
      setEditRevision(latest.revision);
      setEditing('new');
    } else {
      const latest = await queryClient.fetchQuery({
        ...cardsQuery(flashcardSetId),
        staleTime: 0,
      });
      const found = latest.find((item) => item.id === card.id);
      if (!found) return;
      setEditRevision(found.revision);
      setEditing(found);
    }
  }

  // A session goes through every card in order; mixed review lives in Learning.
  // Both sides blank is a new set's placeholder, which takes no rating.
  const sessionIds = (list: Flashcard[]) =>
    list.filter((c) => c.front.trim() || c.back.trim()).map((c) => c.id);

  useEffect(() => {
    if (cards && cardsFetched && queue === null) {
      const ids = sessionIds(cards);
      setQueue(ids);
      setSessionTotal(ids.length);
    }
  }, [cards, cardsFetched, queue]);

  function studyAgain() {
    if (!cards) return;
    const ids = sessionIds(cards);
    studyFinished.current = false;
    setQueue(ids);
    setSessionTotal(ids.length);
    setFlipped(false);
  }

  useEffect(() => {
    if (!queue || queue.length > 0 || sessionTotal === 0) return;
    if (studyFinished.current) return;
    studyFinished.current = true;
    track('flashcards_study_finished', {
      cardCountBucket: cardCountBucket(sessionTotal),
      source: flashcardsStudySource(window.location.pathname),
    });
  }, [queue, sessionTotal]);

  if (flashcardSetFetchStatus === 'paused' || cardsFetchStatus === 'paused') {
    return (
      <PanelWithInvertedRadius>
        <QueryPausedState className="h-full" />
      </PanelWithInvertedRadius>
    );
  }

  if (
    !setFetched ||
    !cardsFetched ||
    flashcardSetError ||
    cardsError ||
    flashcardSetLoading ||
    isLoading ||
    !flashcardSet ||
    !cards ||
    queue === null
  ) {
    if (
      !flashcardSetLoading &&
      !isLoading &&
      (flashcardSetError || cardsError || !flashcardSet || !cards)
    ) {
      const err = flashcardSetErr ?? cardsErr;
      const denied =
        isApiError(err) && (err.status === 404 || err.status === 401);
      return (
        <WorkspaceError
          backLabel={m.flashcards_back_to()}
          backTo="/flashcards"
          title={denied ? m.error_private_title() : m.flashcards_unable_load()}
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
    // Every reader records their own progress. One toast however many
    // ratings fail in a row.
    rateItem({
      itemId: card.id,
      materialId: flashcardSetId,
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
    );
    setFlipped(false);
    setQueue((q) => {
      if (!q) return q;
      const [head, ...rest] = q;
      // "Again" cycles the card back to the end of this session.
      return rating === 'again' ? [...rest, head] : rest;
    });
  }

  async function removeCurrent() {
    if (!card) return;
    try {
      await deleteCard({ expectedRevision: card.revision, id: card.id });
    } catch {
      return;
    }
    setFlipped(false);
    setQueue((q) => (q ? q.filter((id) => id !== card.id) : q));
  }

  const header = (
    <div className="mb-4 flex items-center gap-3">
      <Link
        className="text-fg-muted hover:text-fg"
        preload="intent"
        search={{ tab: 'blocks' }}
        to="/files"
      >
        <Icon name="chevronLeft" size={20} />
      </Link>
      <h1 className="t-subtitle flex-1 truncate">{flashcardSet?.name}</h1>
      {canEdit ? (
        <>
          {isOwner && !flashcardSet.workspaceId && (
            <IconButton
              icon="link"
              label={m.flashcards_share_flashcards()}
              onClick={() => setShareOpen(true)}
              size="sm"
              variant="outline"
            />
          )}
          <IconButton
            icon="plus"
            label={m.flashcards_add_card()}
            onClick={() => void openEdit('new').catch(showErrorToast)}
            size="sm"
            variant="outline"
          />
        </>
      ) : (
        <Button
          disabled={frozen || cloneFlashcardSetIsPending}
          iconLeft="plus"
          onClick={() =>
            cloneFlashcardSet(flashcardSetId, {
              onError: (err) => toastCloneError(err, 'flashcards'),
              onSuccess: (copy) => {
                navigate({
                  params: { flashcardSetId: copy.id },
                  to: '/flashcards/$flashcardSetId',
                });
              },
            })
          }
          size="sm"
        >
          {cloneFlashcardSetIsPending
            ? m.action_cloning()
            : m.action_clone_flashcards()}
        </Button>
      )}
    </div>
  );

  // Nothing left in the session (or a new set without cards).
  if (!card) {
    return (
      <PanelWithInvertedRadius>
        <div className="mx-auto flex h-full w-full max-w-2xl flex-col px-6 py-6">
          {header}
          <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
            <span className="flex h-16 w-16 items-center justify-center rounded-card-lg bg-tint-success text-tint-success-fg">
              <Icon className="non-scaling-svg" name="check" size={30} />
            </span>
            <h2 className="t-large-card-title">
              {cards.length === 0
                ? m.flashcards_empty_flashcards()
                : m.flashcards_session_done()}
            </h2>
            <div className="mt-2 flex gap-3">
              {canEditCards && (
                <Button
                  iconLeft="plus"
                  onClick={() => void openEdit('new').catch(showErrorToast)}
                  variant="outline"
                >
                  {m.flashcards_add_card()}
                </Button>
              )}
              {cards.length > 0 && (
                <Button
                  iconLeft="flashcards"
                  onClick={studyAgain}
                  variant="accent"
                >
                  {m.flashcards_study_again()}
                </Button>
              )}
            </div>
          </div>
        </div>
        {canEditCards && editing !== null && editRevision !== undefined && (
          <CardEditModal
            card={editing === 'new' ? null : editing}
            expectedRevision={editRevision}
            flashcardSetId={flashcardSetId}
            key={editing === 'new' ? 'new' : editing.id}
            onClose={() => setEditing(null)}
            open
          />
        )}
      </PanelWithInvertedRadius>
    );
  }

  const done = sessionTotal - queue.length;

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

        {canEditCards && (
          <div className="mt-3 flex items-center justify-center gap-4">
            <button
              className="flex items-center gap-1 text-fg-muted text-xs hover:text-fg"
              onClick={() => void openEdit(card).catch(showErrorToast)}
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
                {RATING_LABEL[r]()}
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
        <MaterialAttributionFooter provenance={flashcardSet?.provenance} />
      </div>

      {canEditCards && editing !== null && editRevision !== undefined && (
        <CardEditModal
          card={editing === 'new' ? null : editing}
          expectedRevision={editRevision}
          flashcardSetId={flashcardSetId}
          key={editing === 'new' ? 'new' : editing.id}
          onClose={() => setEditing(null)}
          open
        />
      )}
      {isOwner && flashcardSet?.sharePath && (
        <ShareDialog
          link={flashcardSet.sharePath}
          onClose={() => setShareOpen(false)}
          onPrivacyChange={(privacy) =>
            updateFlashcardSet({ id: flashcardSet.id, privacy })
          }
          open={shareOpen}
          privacy={flashcardSet.privacy ?? 'private'}
          saving={updateFlashcardSetIsPending}
          title={m.flashcards_share_title({ name: flashcardSet.name })}
        />
      )}
    </PanelWithInvertedRadius>
  );
}

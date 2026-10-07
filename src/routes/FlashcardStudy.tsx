import { useQuery } from '@tanstack/react-query';
import {
  useCanGoBack,
  useNavigate,
  useParams,
  useRouter,
} from '@tanstack/react-router';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import {
  anonymousFlashcardAssetUrl,
  anonymousFlashcardsQuery,
} from '@/api/anonymous';
import { isApiError } from '@/api/client';
import {
  useCards,
  useCloneFlashcardSet,
  useFlashcardSet,
  useRateReviewItem,
} from '@/api/hooks';
import type { MaterialAuthor, Provenance } from '@/api/types';
import { SessionSwitch } from '@/components/app/AuthProvider';
import { PanelWithInvertedRadius } from '@/components/app/layout';
import { PublicActionMenu } from '@/components/app/PublicActionMenu';
import { PublicByline, PublicPage } from '@/components/app/PublicHeader';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { WorkspaceError } from '@/components/app/WorkspaceError';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { userToast } from '@/components/ui/userToast';
import { CardBack, CardFront } from '@/features/flashcards/CardView';
import type { FlashcardContent } from '@/features/materials/blocks';
import { MaterialAttributionFooter } from '@/features/materials/MaterialAttributionFooter';
import { AssetUrlContext } from '@/features/materials/MediaAssetView';
import { QuizPageHeader } from '@/features/quizzes/QuizPage';
import { RatingTiles } from '@/features/study/RatingTiles';
import { useAccountFrozen } from '@/features/workspace/WorkspaceHealth';
import { m } from '@/i18n';
import { cardCountBucket, flashcardsStudySource } from '@/lib/analytics';
import { toastCloneError } from '@/lib/authToasts';
import { localCardStates, recordLocalCardReview } from '@/lib/localDb';
import { track } from '@/lib/observability';
import {
  newSrsState,
  reviewSrs,
  SRS_RATINGS,
  type SrsRating,
  type SrsState,
} from '@/lib/srs';

type Frame = (props: { children: ReactNode }) => ReactNode;

/** `/flashcards/$flashcardSetId`, inside the app. */
export default function FlashcardStudy() {
  const params = useParams({ strict: false });
  const setId = (params as { flashcardSetId: string }).flashcardSetId;
  return <SignedInStudy key={setId} setId={setId} shared={false} />;
}

/** `/share/flashcards/$flashcardSetId`: the param is the signed share token
 * `{id}.{signature}`. Signed in, ratings go to the server; signed out, they
 * stay in this browser, as on a shared quiz. */
export function SharedFlashcardStudy() {
  const params = useParams({ strict: false });
  const token = (params as { flashcardSetId: string }).flashcardSetId;
  const setId = token.split('.')[0];
  return (
    <SessionSwitch
      anonymous={<AnonymousStudy key={token} token={token} />}
      signedIn={<SignedInStudy key={setId} setId={setId} shared />}
    />
  );
}

function LoadingPanel({ frame: Frame }: { frame: Frame }) {
  return (
    <Frame>
      <div className="h-full p-6">
        <Skeleton className="h-full w-full" />
      </div>
    </Frame>
  );
}

function SignedInStudy({ setId, shared }: { setId: string; shared: boolean }) {
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
  // A shared link opens in the public layout, signed in or out.
  const frame = shared ? PublicStudyFrame : PanelWithInvertedRadius;
  const Frame = frame;

  if (setFetchStatus === 'paused' || cardsFetchStatus === 'paused') {
    return (
      <Frame>
        <QueryPausedState className="h-full" />
      </Frame>
    );
  }
  const error = setError ?? cardsError;
  if (error) {
    const denied =
      isApiError(error) && (error.status === 404 || error.status === 401);
    const title = denied ? m.error_private_title() : m.flashcards_unable_load();
    return shared ? (
      <PublicStudyFrame>
        <WorkspaceError title={title} />
      </PublicStudyFrame>
    ) : (
      <WorkspaceError
        backLabel={m.flashcards_back_to()}
        backTo="/flashcards"
        title={title}
      />
    );
  }
  if (!set || !cards || !setFetched || !cardsFetched)
    return <LoadingPanel frame={frame} />;

  return (
    <StudyBody
      actions={
        shared ? (
          <PublicActionMenu id={setId} kind="flashcards" />
        ) : (
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
              {cloneIsPending
                ? m.action_cloning()
                : m.action_clone_flashcards()}
            </Button>
          )
        )
      }
      author={shared ? set.author : undefined}
      cards={cards}
      frame={frame}
      name={set.name}
      onBack={
        shared
          ? undefined
          : () =>
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
      trail={
        shared
          ? []
          : [set.workspaceName || m.files_tab_blocks(), m.editor_flashcards()]
      }
    />
  );
}

/** Signed-out study of a shared set: ts-fsrs runs in the browser and every
 * rating is logged to IndexedDB, never to the server. */
function AnonymousStudy({ token }: { token: string }) {
  const {
    data: set,
    error,
    isError,
    isLoading,
  } = useQuery({ ...anonymousFlashcardsQuery(token), retry: false });
  const states = useRef(new Map<string, SrsState>());
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

  if (isLoading) return <LoadingPanel frame={PublicStudyFrame} />;
  if (isError || !set)
    return (
      <PublicStudyFrame>
        <WorkspaceError
          title={
            isApiError(error) && error.status === 404
              ? m.error_private_title()
              : m.flashcards_unable_load()
          }
        />
      </PublicStudyFrame>
    );

  return (
    <AssetUrlContext.Provider
      value={(assetId) => anonymousFlashcardAssetUrl(token, assetId)}
    >
      <StudyBody
        actions={<PublicActionMenu id={set.id} kind="flashcards" />}
        author={set.author}
        cards={set.cards}
        footer={
          <p className="t-meta text-center text-fg-muted">
            {m.flashcards_saved_in_browser()}
          </p>
        }
        frame={PublicStudyFrame}
        name={set.name}
        onRate={(card, rating) => {
          const srs = reviewSrs(
            states.current.get(card.id) ?? newSrsState(),
            rating
          );
          states.current.set(card.id, srs);
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
        }}
        provenance={set.provenance}
        trail={[]}
      />
    </AssetUrlContext.Provider>
  );
}

/** Shared links use the public layout and header, as shared quizzes do. */
function PublicStudyFrame({ children }: { children: ReactNode }) {
  return <PublicPage>{children}</PublicPage>;
}

/** One study session over every card in order: Again sends a card to the end,
 * the others move on. A card with both faces blank (a new set's placeholder)
 * takes no rating. */
function StudyBody({
  actions,
  author,
  cards,
  footer,
  frame: Frame,
  name,
  onBack,
  onFinished,
  onRate,
  provenance,
  trail,
}: {
  actions?: ReactNode;
  /** Public pages: the owner under the title, and the card count above the
   * card instead of in the header. */
  author?: MaterialAuthor;
  cards: FlashcardContent[];
  footer?: ReactNode;
  frame: Frame;
  name: string;
  onBack?: () => void;
  onFinished?: (total: number) => void;
  onRate: (card: FlashcardContent, rating: SrsRating) => void;
  provenance?: Provenance;
  trail: string[];
}) {
  const studyIds = () =>
    cards.filter((c) => c.front.trim() || c.back.trim()).map((c) => c.id);
  const [queue, setQueue] = useState(studyIds);
  const [total, setTotal] = useState(queue.length);
  const [flipped, setFlipped] = useState(false);
  const card = cards.find((c) => c.id === queue[0]);

  function rate(rating: SrsRating) {
    if (!card) return;
    onRate(card, rating);
    setFlipped(false);
    const [head, ...rest] = queue;
    const next = rating === 'again' ? [...rest, head] : rest;
    setQueue(next);
    if (next.length === 0) onFinished?.(total);
  }

  function studyAgain() {
    const ids = studyIds();
    setQueue(ids);
    setTotal(ids.length);
    setFlipped(false);
  }

  const position =
    card &&
    m.flashcards_card_of_total({ position: total - queue.length + 1, total });

  return (
    <Frame>
      <QuizPageHeader
        actions={actions}
        byline={author && <PublicByline author={author} />}
        // Public pages have no label row, so the title sits higher.
        className={author ? 'pt-2 sm:pt-2' : undefined}
        meta={
          !author && position && <span className="t-subtitle">{position}</span>
        }
        onBack={onBack}
        title={name}
        // The app bar belongs in the panel's notch; public pages have their own header.
        topBar={Frame === PanelWithInvertedRadius}
        trail={trail}
      />
      <div className="px-4 pt-8 pb-8 sm:px-6 lg:px-10 xl:px-16">
        <div className="mx-auto flex max-w-160 flex-col gap-6">
          {card ? (
            <>
              <div>
                {author && (
                  <p className="t-subtitle mb-1 text-fg-muted">{position}</p>
                )}
                <div className="relative pt-6">
                  <div className="absolute inset-x-12 top-0 h-15 rounded-card-lg bg-solid-accent-1/20" />
                  <div className="absolute inset-x-6 top-3 h-15 rounded-card-lg bg-solid-accent-1/40" />
                  <button
                    aria-label={
                      flipped ? m.flashcards_answer() : m.flashcards_term()
                    }
                    className="relative flex h-[clamp(300px,48vh,400px)] w-full flex-col items-center justify-center overflow-auto rounded-card-lg border border-line bg-surface p-8 shadow-card"
                    onClick={() => setFlipped((f) => !f)}
                    type="button"
                  >
                    {flipped ? (
                      <div className="text-lg">
                        <CardBack card={card} />
                      </div>
                    ) : (
                      <CardFront card={card} large />
                    )}
                    <Icon
                      className="absolute bottom-4 text-fg-muted opacity-60"
                      name="refresh"
                      size={20}
                    />
                  </button>
                </div>
              </div>
              {flipped ? (
                <RatingTiles onRate={rate} />
              ) : (
                <Button
                  fullWidth
                  iconLeft="view"
                  onClick={() => setFlipped(true)}
                  rounded="large"
                >
                  {m.flashcards_show_answer()}
                </Button>
              )}
            </>
          ) : (
            <div className="flex flex-col items-center gap-4 py-16 text-center">
              <span className="flex h-16 w-16 items-center justify-center rounded-card-lg bg-tint-success text-tint-success-fg">
                <Icon className="non-scaling-svg" name="check" size={30} />
              </span>
              <h2 className="t-large-card-title">
                {total === 0
                  ? m.flashcards_empty_flashcards()
                  : m.flashcards_session_done()}
              </h2>
              {total > 0 && (
                <Button
                  iconLeft="flashcards"
                  onClick={studyAgain}
                  rounded="large"
                  variant="accent"
                >
                  {m.flashcards_study_again()}
                </Button>
              )}
            </div>
          )}
          {footer}
          <MaterialAttributionFooter provenance={provenance} />
        </div>
      </div>
    </Frame>
  );
}

import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import {
  useCloneDeck,
  useCreateDeck,
  useDecks,
  useUpdateDeck,
} from '@/api/hooks';
import type { Deck } from '@/api/types';
import { PageHeader, PanelWithInvertedRadius } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { SkeletonCardGrid } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { Menu } from '@/components/ui/Menu';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { ShareDialog } from '@/features/workspace/ShareDialog';
import { m } from '@/i18n';
import { userColorPair } from '@/lib/userColor';

export default function Flashcards() {
  const { data, fetchStatus, isLoading } = useDecks();
  const { isPending: createDeckIsPending, mutate: createDeck } =
    useCreateDeck();
  const { mutate: cloneDeck } = useCloneDeck();
  const { isPending: updateDeckIsPending, mutateAsync: updateDeck } =
    useUpdateDeck();
  const navigate = useNavigate();
  const [sharing, setSharing] = useState<Deck | null>(null);

  function newDeck() {
    createDeck(
      { color: 'purple', name: m.flashcards_new_deck() },
      {
        onSuccess: (deck) =>
          navigate({ params: { deckId: deck.id }, to: '/flashcards/$deckId' }),
      }
    );
  }

  return (
    <PanelWithInvertedRadius>
      <PageHeader
        actions={
          <IconButton
            disabled={createDeckIsPending}
            icon="plus"
            label={m.flashcards_new_deck()}
            onClick={newDeck}
            variant="dark"
          />
        }
        title={m.nav_flashcards()}
      />
      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        {fetchStatus === 'paused' ? (
          <QueryPausedState />
        ) : isLoading ? (
          <SkeletonCardGrid cardHeight={190} count={6} />
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {data?.map((d) => {
              const c = userColorPair(d.color);
              return (
                <div className="relative" key={d.id}>
                  <Link
                    params={{ deckId: d.id }}
                    preload="intent"
                    to="/flashcards/$deckId"
                  >
                    <Card className="h-full p-5.5" interactive radius="card-lg">
                      <div className="flex items-start justify-between">
                        <span
                          className="flex h-11 w-11 items-center justify-center rounded-card"
                          style={{ background: c.bg, color: c.fg }}
                        >
                          <Icon name="flashcards" size={20} />
                        </span>
                        {d.dueCount > 0 && (
                          <Badge size="sm" tone="accent-1">
                            {m.flashcards_due_count({ count: d.dueCount })}
                          </Badge>
                        )}
                      </div>
                      <p className="t-card-title mt-3 truncate">{d.name}</p>
                      <p className="t-meta mt-0.5 text-fg-muted">
                        {d.workspaceName || m.quiz_standalone()}
                      </p>
                      <div className="mt-4">
                        <div className="mb-1 flex justify-between text-fg-muted text-xs">
                          <span>{d.cardCount} cards</span>
                          <span>{d.knownPct}% known</span>
                        </div>
                        <ProgressBar
                          height={5}
                          tone="green"
                          value={d.knownPct}
                        />
                      </div>
                    </Card>
                  </Link>
                  <div className="absolute top-3 right-3 z-10">
                    <Menu
                      items={[
                        {
                          icon: 'link',
                          label: m.action_share(),
                          onClick: () => setSharing(d),
                        },
                        {
                          icon: 'plus',
                          label: m.action_clone(),
                          onClick: () => cloneDeck(d.id),
                        },
                      ]}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {sharing && (
        <ShareDialog
          link={`/share/decks/${sharing.id}`}
          onClose={() => setSharing(null)}
          onPrivacyChange={async (privacy) => {
            const deck = await updateDeck({
              id: sharing.id,
              privacy,
            });
            setSharing(deck);
          }}
          open
          privacy={sharing.privacy ?? 'private'}
          saving={updateDeckIsPending}
          title={m.flashcards_share_title({ name: sharing.name })}
        />
      )}
    </PanelWithInvertedRadius>
  );
}

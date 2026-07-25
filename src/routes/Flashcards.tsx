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
import {
  Badge,
  Card,
  Icon,
  IconButton,
  Menu,
  ProgressBar,
  SkeletonCardGrid,
  Text,
} from '@/components/ui';
import { ShareDialog } from '@/features/workspace/ShareDialog';
import { m } from '@/i18n';
import { userColorPair } from '@/lib/userColor';

export default function Flashcards() {
  const { data, isLoading } = useDecks();
  const createDeck = useCreateDeck();
  const cloneDeck = useCloneDeck();
  const updateDeck = useUpdateDeck();
  const navigate = useNavigate();
  const [sharing, setSharing] = useState<Deck | null>(null);

  function newDeck() {
    createDeck.mutate(
      { color: 'purple', name: 'New deck' },
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
            disabled={createDeck.isPending}
            icon="plus"
            label={m.flashcards_new_deck()}
            onClick={newDeck}
            variant="dark"
          />
        }
        title={m.nav_flashcards()}
      />
      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        {isLoading ? (
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
                      <Text className="mt-3 truncate" variant="card-title">
                        {d.name}
                      </Text>
                      <Text className="mt-0.5" tone="muted" variant="meta">
                        {d.workspaceName || 'Standalone'}
                      </Text>
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
                          label: 'Share',
                          onClick: () => setSharing(d),
                        },
                        {
                          icon: 'plus',
                          label: 'Clone',
                          onClick: () => cloneDeck.mutate(d.id),
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
            const deck = await updateDeck.mutateAsync({
              id: sharing.id,
              privacy,
            });
            setSharing(deck);
          }}
          open
          privacy={sharing.privacy ?? 'private'}
          saving={updateDeck.isPending}
          title={`Share ${sharing.name}`}
        />
      )}
    </PanelWithInvertedRadius>
  );
}

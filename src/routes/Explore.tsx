import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import {
  useCloneDeck,
  useCloneQuiz,
  useCloneWorkspace,
  useExploreDecks,
  useExploreQuizzes,
  useExploreWorkspaces,
} from '@/api/hooks';
import { PageHeader, PanelWithInvertedRadius } from '@/components/app/layout';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { SkeletonCardGrid } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { Tabs } from '@/components/ui/Tabs';
import { m } from '@/i18n';
import { userColorPair } from '@/lib/userColor';

export default function Explore() {
  const [tab, setTab] = useState('workspaces');
  const { data: workspaces, isLoading: workspacesIsLoading } =
    useExploreWorkspaces();
  const { data: quizzes, isLoading: quizzesIsLoading } = useExploreQuizzes();
  const { data: decks, isLoading: decksIsLoading } = useExploreDecks();
  const { isPending: cloneWorkspaceIsPending, mutate: cloneWorkspace } =
    useCloneWorkspace();
  const { isPending: cloneQuizIsPending, mutate: cloneQuiz } = useCloneQuiz();
  const { isPending: cloneDeckIsPending, mutate: cloneDeck } = useCloneDeck();
  const navigate = useNavigate();

  return (
    <PanelWithInvertedRadius>
      <PageHeader
        subtitle="Discover public study sets from the community."
        title={m.nav_explore()}
      />
      <div className="px-6">
        <Tabs
          onChange={setTab}
          tabs={[
            { label: m.explore_tab_workspaces(), value: 'workspaces' },
            { label: m.explore_tab_quizzes(), value: 'quizzes' },
            { label: 'Flashcards', value: 'decks' },
          ]}
          value={tab}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        {tab === 'workspaces' ? (
          workspacesIsLoading ? (
            <SkeletonCardGrid cardHeight={170} count={6} />
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {workspaces?.map((w) => {
                const c = userColorPair(w.color);
                return (
                  <Card className="p-5.5" key={w.id} radius="card-lg">
                    <span
                      className="flex h-11 w-11 items-center justify-center rounded-card"
                      style={{ background: c.bg, color: c.fg }}
                    >
                      <Icon name="workspaces" size={20} />
                    </span>
                    <p className="t-card-title mt-3 truncate">{w.name}</p>
                    <p className="t-meta mt-1 text-fg-muted">
                      by {w.author} · {w.clones.toLocaleString()} clones
                    </p>
                    <Button
                      className="mt-3"
                      disabled={cloneWorkspaceIsPending}
                      iconLeft="plus"
                      onClick={() =>
                        cloneWorkspace(w.id, {
                          onSuccess: ({ workspace }) =>
                            navigate({
                              params: { workspaceId: workspace.id },
                              to: '/workspaces/$workspaceId',
                            }),
                        })
                      }
                      size="sm"
                      variant="outline"
                    >
                      Clone workspace
                    </Button>
                  </Card>
                );
              })}
            </div>
          )
        ) : tab === 'quizzes' && quizzesIsLoading ? (
          <SkeletonCardGrid cardHeight={190} count={6} />
        ) : tab === 'quizzes' ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {quizzes?.map((q) => (
              <Card className="p-5.5" key={q.id} radius="card-lg">
                <span className="flex h-11 w-11 items-center justify-center rounded-card bg-tint-accent-1 text-tint-accent-1-fg">
                  <Icon name="quiz" size={20} />
                </span>
                <p className="t-card-title mt-3 truncate">{q.name}</p>
                <p className="t-meta mt-1 text-fg-muted">
                  by {q.author} · {q.clones.toLocaleString()} clones
                </p>
                <div className="mt-2">
                  <Badge size="sm">{q.questions.length} questions</Badge>
                </div>
                <Button
                  className="mt-3"
                  disabled={cloneQuizIsPending}
                  iconLeft="plus"
                  onClick={() =>
                    cloneQuiz(q.id, {
                      onSuccess: (copy) =>
                        navigate({
                          params: { quizId: copy.id },
                          to: '/quizzes/$quizId/attempt',
                        }),
                    })
                  }
                  size="sm"
                  variant="outline"
                >
                  Clone quiz
                </Button>
              </Card>
            ))}
          </div>
        ) : decksIsLoading ? (
          <SkeletonCardGrid cardHeight={190} count={6} />
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {decks?.map((deck) => (
              <Card className="p-5.5" key={deck.id} radius="card-lg">
                <span className="flex h-11 w-11 items-center justify-center rounded-card bg-tint-accent-2 text-tint-accent-2-fg">
                  <Icon name="flashcards" size={20} />
                </span>
                <p className="t-card-title mt-3 truncate">{deck.name}</p>
                <p className="t-meta mt-1 text-fg-muted">
                  by {deck.author} · {deck.clones.toLocaleString()} clones
                </p>
                <div className="mt-2">
                  <Badge size="sm">{deck.cardCount} cards</Badge>
                </div>
                <Button
                  className="mt-3"
                  disabled={cloneDeckIsPending}
                  iconLeft="plus"
                  onClick={() =>
                    cloneDeck(deck.id, {
                      onSuccess: (copy) =>
                        navigate({
                          params: { deckId: copy.id },
                          to: '/flashcards/$deckId',
                        }),
                    })
                  }
                  size="sm"
                  variant="outline"
                >
                  Clone deck
                </Button>
              </Card>
            ))}
          </div>
        )}
      </div>
    </PanelWithInvertedRadius>
  );
}

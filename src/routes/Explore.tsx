import { useState } from 'react';
import {
  useExploreFlashcardSets,
  useExploreQuizzes,
  useExploreWorkspaces,
} from '@/api/hooks';
import type { PublicWorkspace } from '@/api/types';
import { PageHeader, PanelWithInvertedRadius } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { SkeletonCardGrid } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { Tabs } from '@/components/ui/Tabs';
import {
  type CloneItem,
  CloneItemDialog,
} from '@/features/workspace/CloneItemDialog';
import { CloneWorkspaceDialog } from '@/features/workspace/CloneWorkspaceDialog';
import {
  AccountStatusButton,
  useAccountFrozen,
} from '@/features/workspace/WorkspaceHealth';
import { m } from '@/i18n';
import { iconUrl } from '@/lib/icon-catalog';
import { userColorPair } from '@/lib/userColor';

export default function Explore() {
  const [tab, setTab] = useState('workspaces');
  const {
    data: workspaces,
    fetchStatus: workspacesFetchStatus,
    isLoading: workspacesIsLoading,
  } = useExploreWorkspaces();
  const {
    data: quizzes,
    fetchStatus: quizzesFetchStatus,
    isLoading: quizzesIsLoading,
  } = useExploreQuizzes();
  const {
    data: flashcardSets,
    fetchStatus: flashcardSetsFetchStatus,
    isLoading: flashcardSetsIsLoading,
  } = useExploreFlashcardSets();
  const [cloneSource, setCloneSource] = useState<PublicWorkspace | null>(null);
  const [cloneItem, setCloneItem] = useState<CloneItem | null>(null);
  const frozen = useAccountFrozen();

  return (
    <PanelWithInvertedRadius
      header={
        <PageHeader
          actions={<AccountStatusButton />}
          subtitle={m.explore_subtitle()}
          title={m.nav_explore()}
        />
      }
    >
      <div className="px-1 sm:px-6">
        <Tabs
          onChange={setTab}
          tabs={[
            { label: m.explore_tab_workspaces(), value: 'workspaces' },
            { label: m.explore_tab_quizzes(), value: 'quizzes' },
            { label: m.explore_tab_flashcards(), value: 'flashcardSets' },
          ]}
          value={tab}
        />
      </div>
      <div className="flex-1 px-4 py-5 sm:px-6">
        {tab === 'workspaces' ? (
          workspacesFetchStatus === 'paused' ? (
            <QueryPausedState />
          ) : workspacesIsLoading ? (
            <SkeletonCardGrid cardHeight={170} count={6} />
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {workspaces?.map((w) => {
                const c = userColorPair('purple');
                return (
                  <Card className="p-5.5" key={w.id} radius="card-lg">
                    <span
                      className="flex h-11 w-11 items-center justify-center rounded-card"
                      style={{ background: c.bg, color: c.fg }}
                    >
                      <img
                        alt=""
                        className="size-10 rounded-button"
                        height={40}
                        src={iconUrl(w.iconId)}
                        width={40}
                      />
                    </span>
                    <a
                      className="t-card-title mt-3 block truncate hover:underline"
                      href={w.sharePath}
                      title={m.summary_view()}
                    >
                      {w.name}
                    </a>
                    <p className="t-meta mt-1 text-fg-muted">
                      by {w.author} · {w.clones.toLocaleString()} clones
                    </p>
                    {w.canClone && (
                      <Button
                        className="mt-3"
                        iconLeft="clone"
                        onClick={() => setCloneSource(w)}
                        size="sm"
                        variant="outline"
                      >
                        {m.action_clone_workspace()}
                      </Button>
                    )}
                  </Card>
                );
              })}
            </div>
          )
        ) : tab === 'quizzes' && quizzesFetchStatus === 'paused' ? (
          <QueryPausedState />
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
                {q.canClone && (
                  <Button
                    className="mt-3"
                    disabled={frozen}
                    iconLeft="plus"
                    onClick={() =>
                      setCloneItem({
                        id: q.id,
                        kind: 'quiz',
                        name: q.name,
                        type: 'material',
                        workspaceId: q.workspaceId,
                      })
                    }
                    size="sm"
                    variant="outline"
                  >
                    {m.action_clone_quiz()}
                  </Button>
                )}
              </Card>
            ))}
          </div>
        ) : flashcardSetsFetchStatus === 'paused' ? (
          <QueryPausedState />
        ) : flashcardSetsIsLoading ? (
          <SkeletonCardGrid cardHeight={190} count={6} />
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {flashcardSets?.map((flashcardSet) => (
              <Card className="p-5.5" key={flashcardSet.id} radius="card-lg">
                <span className="flex h-11 w-11 items-center justify-center rounded-card bg-tint-accent-2 text-tint-accent-2-fg">
                  <Icon name="flashcards" size={20} />
                </span>
                <p className="t-card-title mt-3 truncate">
                  {flashcardSet.name}
                </p>
                <p className="t-meta mt-1 text-fg-muted">
                  by {flashcardSet.author} ·{' '}
                  {flashcardSet.clones.toLocaleString()} clones
                </p>
                <div className="mt-2">
                  <Badge size="sm">{flashcardSet.cardCount} cards</Badge>
                </div>
                {flashcardSet.canClone && (
                  <Button
                    className="mt-3"
                    disabled={frozen}
                    iconLeft="plus"
                    onClick={() =>
                      setCloneItem({
                        id: flashcardSet.id,
                        kind: 'flashcards',
                        name: flashcardSet.name,
                        type: 'material',
                        workspaceId: flashcardSet.workspaceId,
                      })
                    }
                    size="sm"
                    variant="outline"
                  >
                    {m.action_clone_flashcards()}
                  </Button>
                )}
              </Card>
            ))}
          </div>
        )}
      </div>
      {cloneItem && (
        <CloneItemDialog item={cloneItem} onClose={() => setCloneItem(null)} />
      )}
      {cloneSource && (
        <CloneWorkspaceDialog
          open
          setOpen={(open) => !open && setCloneSource(null)}
          workspace={cloneSource}
        />
      )}
    </PanelWithInvertedRadius>
  );
}

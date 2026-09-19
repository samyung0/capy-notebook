import { useState } from 'react';
import { useCreateWorkspace, useTags, useWorkspaces } from '@/api/hooks';
import {
  ListToolbar,
  type SortOption,
  toggleValue,
} from '@/components/app/ListToolbar';
import { PageHeader, PanelWithInvertedRadius } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { SkeletonCardGrid } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { WorkspaceCard } from '@/components/ui/WorkspaceCard';
import { WorkspaceFormCreateDialog } from '@/features/workspace/WorkspaceFormCreateDialog';
import { m } from '@/i18n';
import { track } from '@/lib/observability';
import { useLoadingReveal } from '@/lib/useLoadingReveal';

type WorkspaceSort = 'accessed' | 'created' | 'chapters' | 'files';

export default function Workspaces() {
  const sorts: SortOption<WorkspaceSort>[] = [
    {
      icon: 'clock',
      label: m.workspaces_sort_accessed(),
      order: 'time',
      value: 'accessed',
    },
    {
      icon: 'schedule',
      label: m.workspaces_sort_created(),
      order: 'time',
      value: 'created',
    },
    {
      icon: 'chapter',
      label: m.workspaces_sort_chapters(),
      order: 'count',
      value: 'chapters',
    },
    {
      icon: 'files',
      label: m.workspaces_sort_files(),
      order: 'count',
      value: 'files',
    },
  ];
  const [sort, setSort] = useState<WorkspaceSort>('accessed');
  const [ascending, setAscending] = useState(false);
  const [tagFilters, setTagFilters] = useState<string[]>([]);
  const [createOpen, setCreateOpen] = useState(false);

  const { data, fetchStatus, isLoading } = useWorkspaces({
    sort,
    tag: tagFilters,
  });
  const revealRef = useLoadingReveal(isLoading);
  const { data: tags = [] } = useTags('workspace', { errorBoundary: false });
  const { mutateAsync: createWorkspace } = useCreateWorkspace();
  const sortedWorkspaces = ascending ? data?.slice().reverse() : data;

  return (
    <PanelWithInvertedRadius>
      <PageHeader title={m.workspaces_title()} />
      <ListToolbar
        action={
          <Button
            className="rounded-card font-bold text-link"
            iconLeft="plus"
            onClick={() => setCreateOpen(true)}
            size="md"
            variant="ghost-hover"
          >
            {m.action_new_workspace()}
          </Button>
        }
        ascending={ascending}
        filters={[
          {
            emptyLabel: m.workspaces_filter_no_tags(),
            key: 'tags',
            label: m.workspaces_filter_tags(),
            onToggle: (value) =>
              setTagFilters((prev) => toggleValue(prev, value)),
            options: tags.map((t) => ({ label: t.value, value: t.value })),
            selected: tagFilters,
          },
        ]}
        onResetFilters={() => setTagFilters([])}
        onSortChange={(next, asc) => {
          setSort(next);
          setAscending(asc);
        }}
        sort={sort}
        sorts={sorts}
      />

      <div className="min-h-0 w-full flex-1 overflow-auto px-6 pt-2 pb-6">
        {fetchStatus === 'paused' ? (
          <QueryPausedState />
        ) : isLoading ? (
          <SkeletonCardGrid count={6} />
        ) : (
          <div
            className="grid w-full auto-rows-fr grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4"
            ref={revealRef}
          >
            {sortedWorkspaces?.map((w) => (
              <WorkspaceCard key={w.id} workspace={w} />
            ))}
            <Card
              border="dashed"
              className="min-h-40 cursor-pointer items-center justify-center focus-visible:border-0 focus-visible:ring-2 focus-visible:ring-action focus-visible:transition-none"
              interactive
              onClick={() => setCreateOpen(true)}
              radius="card-lg"
              tabIndex={0}
            >
              <span className="flex flex-col items-center gap-2 text-fg-muted">
                <Icon name="plus" size={24} />
                <span className="t-meta text-fg-muted">
                  {m.action_new_workspace()}
                </span>
              </span>
            </Card>
          </div>
        )}
      </div>
      <WorkspaceFormCreateDialog
        onSubmit={async (v) => {
          await createWorkspace(v);
          track('workspace_created', { source: 'sidebar' });
        }}
        open={createOpen}
        setOpen={setCreateOpen}
        workspace={{ name: '', tags: [] }}
      />
    </PanelWithInvertedRadius>
  );
}

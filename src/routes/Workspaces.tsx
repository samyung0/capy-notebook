import { useNavigate, useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import { USE_MSW } from '@/api/auth';
import { useCreateWorkspace, useTags, useWorkspaces } from '@/api/hooks';
import { CloneLinkDialog } from '@/components/app/CloneLinkDialog';
import {
  ListToolbar,
  type SortOption,
  toggleValue,
} from '@/components/app/ListToolbar';
import { PageBody, PageHeader, PagePanel } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { AccountStatusBanner } from '@/components/banners/AccountStatusBanner';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Icon } from '@/components/ui/Icon';
import {
  WorkspaceCard,
  WorkspaceCardSkeleton,
} from '@/components/ui/WorkspaceCard';
import { OnboardingDialog } from '@/features/auth/OnboardingDialog';
import { WorkspaceFormCreateDialog } from '@/features/workspace/WorkspaceFormCreateDialog';
import {
  AccountStatusButton,
  useAccountFrozen,
} from '@/features/workspace/WorkspaceHealth';
import { m } from '@/i18n';
import { track } from '@/lib/analytics';
import {
  csv,
  sortSearch,
  WORKSPACE_SORT_DEFAULT,
  type WorkspaceSort,
  type WorkspacesSearch,
  workspaceListParams,
} from '@/lib/listSearch';
import { waitsForConnection } from '@/lib/online';
import { useLoadingReveal } from '@/lib/useLoadingReveal';

const CLERK_ACTIVE = !USE_MSW && !!import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

export default function Workspaces() {
  const sorts: SortOption<WorkspaceSort>[] = [
    {
      icon: 'clock',
      label: m.workspaces_sort_accessed(),
      value: 'accessed',
    },
    {
      icon: 'schedule',
      label: m.workspaces_sort_created(),
      value: 'created',
    },
    {
      icon: 'topic',
      label: m.workspaces_sort_topics(),
      value: 'topics',
    },
    {
      icon: 'files',
      label: m.workspaces_sort_files(),
      value: 'files',
    },
  ];
  // Sort and tags live in the URL; picks replace the entry, not add to it.
  const search = useSearch({ from: '/auth-shell/' });
  const navigate = useNavigate({ from: '/' });
  const setSearch = (patch: WorkspacesSearch) =>
    void navigate({ replace: true, search: (prev) => ({ ...prev, ...patch }) });
  const params = workspaceListParams(search);
  const { sort } = params;
  const tagFilters = params.tag ?? [];
  const ascending = search.dir === 'asc';
  const [createOpen, setCreateOpen] = useState(false);

  const { data, fetchStatus, isLoading } = useWorkspaces(params);
  const revealRef = useLoadingReveal(isLoading);
  const { data: tags = [] } = useTags('workspace', { errorBoundary: false });
  const { mutateAsync: createWorkspace } = useCreateWorkspace();
  const frozen = useAccountFrozen();
  const sortedWorkspaces = ascending ? data?.slice().reverse() : data;

  return (
    <PagePanel
      header={
        <PageHeader
          actions={<AccountStatusButton />}
          title={m.workspaces_title()}
        />
      }
    >
      <div className="page-px empty:hidden">
        <AccountStatusBanner />
      </div>
      <ListToolbar
        action={
          <Button
            className="-mx-1 h-fit rounded-card px-2 py-1.5 font-bold text-link sm:mx-0 sm:h-(--control-h) sm:px-5 sm:py-0"
            disabled={frozen}
            iconLeft="plus"
            onClick={() => setCreateOpen(true)}
            size="md"
            variant="ghost-hover"
          >
            {m.action_new_workspace()}
          </Button>
        }
        filters={[
          {
            emptyLabel: m.workspaces_filter_no_tags(),
            key: 'tags',
            label: m.workspaces_filter_tags(),
            onToggle: (value) =>
              setSearch({ tag: csv(toggleValue(tagFilters, value)) }),
            options: tags.map((t) => ({ label: t.value, value: t.value })),
            selected: tagFilters,
          },
        ]}
        onResetFilters={() => setSearch({ tag: undefined })}
        sortMenu={{
          ascending,
          onSortChange: (next, asc) =>
            setSearch(
              sortSearch('workspaces', next, asc, WORKSPACE_SORT_DEFAULT)
            ),
          sort,
          sorts,
        }}
      />

      <PageBody belowToolbar className="pt-4 sm:pt-2">
        {waitsForConnection(fetchStatus, data) ? (
          <QueryPausedState />
        ) : isLoading ? (
          <div
            aria-label={m.a11y_loading()}
            className="grid w-full grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-2.5 sm:gap-4"
            role="status"
          >
            {Array.from({ length: 6 }, (_, i) => (
              <WorkspaceCardSkeleton key={i} />
            ))}
          </div>
        ) : (
          <div
            className="grid w-full grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-2.5 sm:gap-4"
            ref={revealRef}
          >
            {sortedWorkspaces?.map((w) => (
              <WorkspaceCard key={w.id} workspace={w} />
            ))}
            <Card
              border="dashed"
              className="min-h-16 cursor-pointer items-center justify-center frosted:bg-transparent p-2 focus-visible:border-0 focus-visible:ring-2 focus-visible:ring-action focus-visible:transition-none sm:min-h-34 sm:p-5.5"
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
      </PageBody>
      <WorkspaceFormCreateDialog
        onSubmit={async (v) => {
          await createWorkspace(v);
          track('workspace_created', { source: 'sidebar' });
        }}
        open={createOpen}
        setOpen={setCreateOpen}
        workspace={{ kind: 'personal', name: '', tags: [] }}
      />
      {CLERK_ACTIVE && <OnboardingDialog />}
      <CloneLinkDialog />
    </PagePanel>
  );
}

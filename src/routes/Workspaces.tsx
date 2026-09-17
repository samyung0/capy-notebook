import { useMemo, useState } from 'react';
import { useCreateWorkspace, useTags, useWorkspaces } from '@/api/hooks';
import { PageHeader, PanelWithInvertedRadius } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { Badge } from '@/components/ui/Badge';
import { BASE_BUTTON_STYLE, Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { SkeletonCardGrid } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { Menu } from '@/components/ui/Menu';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/Popover';
import { WorkspaceCard } from '@/components/ui/WorkspaceCard';
import { WorkspaceFormCreateDialog } from '@/features/workspace/WorkspaceFormCreateDialog';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { track } from '@/lib/observability';
import { useLoadingReveal } from '@/lib/useLoadingReveal';

const SORTS = [
  { icon: 'clock', label: m.workspaces_sort_accessed, value: 'accessed' },
  { icon: 'schedule', label: m.workspaces_sort_created, value: 'created' },
  { icon: 'chapter', label: m.workspaces_sort_chapters, value: 'chapters' },
  { icon: 'files', label: m.workspaces_sort_files, value: 'files' },
] as const;

function toggleIn(list: string[], value: string) {
  return list.includes(value)
    ? list.filter((v) => v !== value)
    : [...list, value];
}

export default function Workspaces() {
  const [sort, setSort] = useState('accessed');
  const [tagFilters, setTagFilters] = useState<string[]>([]);
  const [filterOpen, setFilterOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const { data, fetchStatus, isLoading } = useWorkspaces({
    sort,
    tag: tagFilters,
  });
  const revealRef = useLoadingReveal(isLoading);
  const { data: tags = [] } = useTags('workspace', { errorBoundary: false });
  const { mutateAsync: createWorkspace } = useCreateWorkspace();

  const sortLabel = useMemo(
    () => SORTS.find((s) => s.value === sort)?.label() ?? '',
    [sort]
  );
  const hasFilters = tagFilters.length > 0;
  const filterLabel = useMemo(() => {
    const parts = tagFilters;
    if (!parts.length) return m.workspaces_filter();
    if (parts.length <= 2) return parts.join(' · ');
    return `${parts.slice(0, 2).join(' · ')} +${parts.length - 2}`;
  }, [tagFilters]);

  return (
    <PanelWithInvertedRadius>
      <PageHeader title={m.workspaces_title()} />

      <div className="-mb-3 flex items-center justify-between gap-3 px-6">
        <div className="flex items-center gap-2 pt-2 pb-3">
          <Menu
            align="start"
            items={SORTS.map((s) => ({
              icon: s.icon,
              label: s.label(),
              onClick: () => setSort(s.value),
            }))}
            trigger={
              <Button
                className="h-fit px-1 py-1.5"
                iconRight="chevronDown"
                size="md"
                variant="ghost"
              >
                {m.workspaces_sort_prefix({ label: sortLabel })}
              </Button>
            }
          />
          <Popover onOpenChange={setFilterOpen} open={filterOpen}>
            <PopoverTrigger asChild>
              <Button
                className="h-fit px-1 py-1.5"
                iconLeft="filter"
                iconRight="chevronDown"
                size="md"
                variant="ghost"
              >
                {filterLabel}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="max-h-80 w-72 gap-0 p-0">
              <Card
                border="solid"
                className="max-h-80 gap-3 overflow-y-auto p-3.5"
                radius="card"
              >
                <section className="flex flex-col gap-2">
                  <p>{m.workspaces_filter_tags()}</p>
                  {tags.length === 0 ? (
                    <p className="text-fg-muted">
                      {m.workspaces_filter_no_tags()}
                    </p>
                  ) : (
                    <div className="-ml-0.5 flex flex-wrap gap-1.5">
                      {tags.map((t) => {
                        const active = tagFilters.includes(t.value);
                        return (
                          <button
                            className={BASE_BUTTON_STYLE}
                            key={t.id}
                            onClick={() =>
                              setTagFilters((prev) => toggleIn(prev, t.value))
                            }
                            type="button"
                          >
                            <Badge
                              className={cn(
                                'transition-colors',
                                !active && 'hover:bg-surface-dark'
                              )}
                              size="sm"
                              tone={active ? 'dark' : 'page'}
                            >
                              {t.value}
                            </Badge>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </section>

                <Button
                  className="mx-auto w-fit"
                  disabled={!hasFilters}
                  fullWidth
                  onClick={() => {
                    setTagFilters([]);
                  }}
                  size="sm"
                  variant="ghost-hover"
                >
                  {m.workspaces_filter_reset()}
                </Button>
              </Card>
            </PopoverContent>
          </Popover>
        </div>
        <Button
          className="rounded-card font-bold text-link"
          iconLeft="plus"
          onClick={() => setCreateOpen(true)}
          size="md"
          variant="ghost-hover"
        >
          {m.action_new_workspace()}
        </Button>
      </div>

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
            {data?.map((w) => (
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

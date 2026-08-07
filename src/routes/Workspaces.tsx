import { useMemo, useState } from 'react';
import { useTags, useWorkspaces } from '@/api/hooks';
import { PageHeader, PanelWithInvertedRadius } from '@/components/app/layout';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { SkeletonCardGrid } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { Menu } from '@/components/ui/Menu';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/Popover';
import { UserColorChooser } from '@/components/ui/UserColorChooser';
import { WorkspaceCard } from '@/components/ui/WorkspaceCard';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { type USER_COLORS, USER_COLORS_DISPLAY } from '@/lib/userColor';
import { usePortals } from '@/stores/portals';

const SORTS = [
  { label: m.workspaces_sort_accessed, value: 'accessed' },
  { label: m.workspaces_sort_created, value: 'created' },
  { label: m.workspaces_sort_chapters, value: 'chapters' },
  { label: m.workspaces_sort_files, value: 'files' },
];

function toggleIn(list: string[], value: string) {
  return list.includes(value)
    ? list.filter((v) => v !== value)
    : [...list, value];
}

export default function Workspaces() {
  const [sort, setSort] = useState('accessed');
  const [colorFilters, setColorFilters] = useState<string[]>([]);
  const [tagFilters, setTagFilters] = useState<string[]>([]);
  const [filterOpen, setFilterOpen] = useState(false);

  const { data, isLoading } = useWorkspaces({
    color: colorFilters,
    sort,
    tag: tagFilters,
  });
  const { data: tags = [] } = useTags('workspace');
  const openWorkspaceCreate = usePortals((s) => s.openWorkspaceCreate);

  const sortLabel = useMemo(
    () => SORTS.find((s) => s.value === sort)?.label() ?? '',
    [sort]
  );
  const hasFilters = colorFilters.length > 0 || tagFilters.length > 0;
  const filterLabel = useMemo(() => {
    const parts = [
      ...colorFilters.map(
        (color) =>
          USER_COLORS_DISPLAY[color as (typeof USER_COLORS)[number]] ?? color
      ),
      ...tagFilters,
    ];
    if (!parts.length) return m.workspaces_filter();
    if (parts.length <= 2) return parts.join(' · ');
    return `${parts.slice(0, 2).join(' · ')} +${parts.length - 2}`;
  }, [colorFilters, tagFilters]);

  return (
    <PanelWithInvertedRadius>
      <PageHeader
        actions={
          <IconButton
            icon="plus"
            label={m.action_new_workspace()}
            onClick={() => openWorkspaceCreate()}
            size="lg"
            variant="page"
          />
        }
        title={m.workspaces_title()}
      />

      <div className="-mb-3 flex items-center justify-between gap-3 px-6">
        <div className="flex items-center gap-2 pt-2 pb-3">
          <Menu
            align="start"
            items={SORTS.map((s) => ({
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
                Sort: {sortLabel}
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
                className="max-h-80 gap-5 overflow-y-auto p-3"
                radius="card"
              >
                <section className="mt-1 flex flex-col gap-2">
                  <p className="t-label text-fg-muted">
                    {m.workspaces_filter_color()}
                  </p>
                  <UserColorChooser
                    onChange={(c) =>
                      setColorFilters((prev) => toggleIn(prev, c))
                    }
                    selected={colorFilters}
                  />
                </section>

                <section className="flex flex-col gap-2">
                  <p className="t-label text-fg-muted">
                    {m.workspaces_filter_tags()}
                  </p>
                  {tags.length === 0 ? (
                    <p className="text-fg-muted text-sm">
                      {m.workspaces_filter_no_tags()}
                    </p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {tags.map((t) => {
                        const active = tagFilters.includes(t.value);
                        return (
                          <button
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
                    setColorFilters([]);
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
      </div>

      <div className="min-h-0 w-full flex-1 overflow-auto px-6 pt-2 pb-6">
        {isLoading ? (
          <SkeletonCardGrid count={9} />
        ) : (
          <div className="grid w-full auto-rows-fr grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4">
            {data?.map((w) => (
              <WorkspaceCard key={w.id} workspace={w} />
            ))}
            <Card
              border="dashed"
              className="min-h-40 cursor-pointer items-center justify-center focus-visible:border-0 focus-visible:ring-2 focus-visible:ring-action focus-visible:transition-none"
              interactive
              onClick={() => openWorkspaceCreate()}
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
    </PanelWithInvertedRadius>
  );
}

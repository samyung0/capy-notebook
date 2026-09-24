import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { BASE_BUTTON_STYLE, Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import type { IconName } from '@/components/ui/Icon';
import { Menu } from '@/components/ui/Menu';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/Popover';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';

/** The sort menu, filter popover and view toggle shared by the list pages
 * (Workspaces, Create, Files). State lives in the page; this only renders. */

export interface SortOption<V extends string = string> {
  icon: IconName;
  label: string;
  /** Picks the direction wording: dates get newest/oldest, counts get
   * most/fewest, names get A to Z. */
  order: 'time' | 'count' | 'name';
  value: V;
}

export interface FilterSection {
  emptyLabel?: string;
  key: string;
  label: string;
  onToggle: (value: string) => void;
  options: { label: string; value: string }[];
  selected: string[];
}

export type ListView = 'grid' | 'list';

export function sortDirectionLabel(
  order: SortOption['order'],
  ascending: boolean
): string {
  switch (order) {
    case 'time':
      return ascending
        ? m.workspaces_sort_oldest_first()
        : m.workspaces_sort_newest_first();
    case 'count':
      return ascending
        ? m.workspaces_sort_fewest_first()
        : m.workspaces_sort_most_first();
    default:
      return ascending ? m.list_sort_a_to_z() : m.list_sort_z_to_a();
  }
}

export function ListToolbar<V extends string>({
  sorts,
  sort,
  ascending,
  onSortChange,
  filters,
  onResetFilters,
  view,
  onViewChange,
  action,
  selectionActions,
}: {
  sorts: readonly SortOption<V>[];
  sort: V;
  ascending: boolean;
  onSortChange: (sort: V, ascending: boolean) => void;
  filters: FilterSection[];
  onResetFilters: () => void;
  view?: ListView;
  onViewChange?: (view: ListView) => void;
  /** Primary action rendered at the right edge. */
  action?: ReactNode;
  /** Replaces the entire sort/filter group, including its styled container. */
  selectionActions?: ReactNode;
}) {
  const [filterOpen, setFilterOpen] = useState(false);
  const current = sorts.find((option) => option.value === sort) ?? sorts[0];
  const selectedLabels = useMemo(
    () =>
      filters.flatMap((section) =>
        section.options
          .filter((option) => section.selected.includes(option.value))
          .map((option) => option.label)
      ),
    [filters]
  );
  const hasFilters = selectedLabels.length > 0;
  const filterLabel = hasFilters
    ? selectedLabels.length <= 2
      ? selectedLabels.join(' · ')
      : `${selectedLabels.slice(0, 2).join(' · ')} +${selectedLabels.length - 2}`
    : m.workspaces_filter();

  return (
    <div className="-mb-3 flex flex-wrap items-center justify-between gap-x-3 px-6">
      <div className="flex h-11.5 items-center py-2">
        {selectionActions ?? (
          <div className="flex flex-wrap items-center gap-2">
            <Menu
              align="start"
              items={sorts.map((option) => ({
                closeOnSelect: false,
                description: sortDirectionLabel(
                  option.order,
                  option.value === sort && ascending
                ),
                icon: option.icon,
                label: option.label,
                onClick: () =>
                  onSortChange(
                    option.value,
                    option.value === sort ? !ascending : false
                  ),
              }))}
              trigger={
                <Button
                  className="h-fit px-1 py-1.5"
                  iconRight="chevronDown"
                  size="md"
                  variant="ghost"
                >
                  {m.workspaces_sort_prefix({ label: current.label })}
                  <span className="font-normal text-fg-muted text-xs">
                    {sortDirectionLabel(current.order, ascending)}
                  </span>
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
              <PopoverContent
                align="start"
                className="max-h-96 w-72 gap-0 border-0 bg-transparent p-0 shadow-none!"
              >
                <Card
                  border="solid"
                  className="max-h-96 gap-3 overflow-y-auto p-3.5"
                  radius="card"
                >
                  {filters.map((section) => (
                    <section className="flex flex-col gap-2" key={section.key}>
                      <p>{section.label}</p>
                      {section.options.length === 0 ? (
                        <p className="text-fg-muted">{section.emptyLabel}</p>
                      ) : (
                        <div className="-ml-0.5 flex flex-wrap gap-1.5">
                          {section.options.map((option) => {
                            const active = section.selected.includes(
                              option.value
                            );
                            return (
                              <button
                                className={BASE_BUTTON_STYLE}
                                key={option.value}
                                onClick={() => section.onToggle(option.value)}
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
                                  {option.label}
                                </Badge>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </section>
                  ))}
                  <Button
                    className="mx-auto w-fit"
                    disabled={!hasFilters}
                    fullWidth
                    onClick={onResetFilters}
                    size="sm"
                    variant="ghost-hover"
                  >
                    {m.workspaces_filter_reset()}
                  </Button>
                </Card>
              </PopoverContent>
            </Popover>
          </div>
        )}
      </div>
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">{action}</div>
        {view && onViewChange && (
          <ListViewToggle onViewChange={onViewChange} view={view} />
        )}
      </div>
    </div>
  );
}

export function ListViewToggle({
  view,
  onViewChange,
}: {
  view: ListView;
  onViewChange: (view: ListView) => void;
}) {
  return (
    <div className="flex items-center gap-0">
      <ViewButton
        active={view === 'grid'}
        icon="grid"
        label={m.list_view_grid()}
        onClick={() => onViewChange('grid')}
      />
      <ViewButton
        active={view === 'list'}
        icon="list"
        label={m.list_view_list()}
        onClick={() => onViewChange('list')}
      />
    </div>
  );
}

function ViewButton({
  active,
  icon,
  label,
  onClick,
  className,
}: {
  active: boolean;
  icon: IconName;
  label: string;
  onClick: () => void;
  className?: string;
}) {
  return (
    <Button
      aria-label={label}
      aria-pressed={active}
      className={cn(
        'px-1.5',
        !active && 'text-fg-muted hover:text-fg',
        className,
        active && 'bg-surface-hover-bg hover:bg-surface-hover-bg'
      )}
      iconLeft={icon}
      onClick={onClick}
      size="sm"
      variant="ghost-hover"
    />
  );
}

/** Add or remove a value from a filter selection. */
export function toggleValue(list: string[], value: string): string[] {
  return list.includes(value)
    ? list.filter((item) => item !== value)
    : [...list, value];
}

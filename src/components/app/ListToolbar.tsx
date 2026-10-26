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
import { useLocalPref } from '@/lib/localPrefs';
import { usePointerDownPress } from '@/lib/usePointerDownPress';

/** The sort menu, filter popover and view toggle shared by the list pages
 * (Workspaces, Create, Files). State lives in the page; this only renders. */

export interface SortOption<V extends string = string> {
  icon: IconName;
  /** Names the default order, e.g. "Newest created". Clicking the active
   * option reverses it without changing the label. */
  label: string;
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

const isListView = (value: unknown): value is ListView =>
  value === 'grid' || value === 'list';

/** The page's grid or list choice, remembered per viewer under `key`. */
export function useListView(key: string): [ListView, (view: ListView) => void] {
  return useLocalPref<ListView>(key, 'grid', isListView);
}

/** The sort menu's options and state. A table header can take its place:
 * `hiddenFromMd` hides the menu where a list view's sortable header shows. */
export interface SortMenuProps<V extends string> {
  ascending: boolean;
  hiddenFromMd?: boolean;
  onSortChange: (sort: V, ascending: boolean) => void;
  sort: V;
  sorts: readonly SortOption<V>[];
}

export function ListToolbar<V extends string>({
  sortMenu,
  filters,
  onResetFilters,
  view,
  onViewChange,
  action,
  selection,
  wide,
}: {
  /** Left out where every sort lives in the table's header. */
  sortMenu?: SortMenuProps<V>;
  filters: FilterSection[];
  onResetFilters: () => void;
  view?: ListView;
  onViewChange?: (view: ListView) => void;
  /** Primary action rendered at the right edge. */
  action?: ReactNode;
  /** The SelectionBar, shown instead of the whole toolbar while anything is
   * selected. */
  selection?: ReactNode;
  /** Under a page's tabs: the tab body's gutter, like PageBody's `wide`. */
  wide?: boolean;
}) {
  // The toolbar stays mounted under the selection bar, so a first pick or a
  // last deselect does not rebuild its menus.
  return (
    <>
      {selection && (
        <div className={cn('-mb-3 flex', wide ? 'page-px-wide' : 'page-px')}>
          {selection}
        </div>
      )}
      {/* Phones: icon-only sort and filter with the action on one row, the
          view toggle on its own row at the right (or on the first, without
          an action). From sm, one labelled row. */}
      <div
        className={cn(
          '-mb-3 flex flex-wrap items-center gap-x-3',
          wide ? 'page-px-wide' : 'page-px',
          selection && 'hidden'
        )}
      >
        <div className="flex min-h-10 items-center sm:min-h-11.5 sm:py-2">
          {/* -ml-1 with the buttons' -mx-1 puts the first icon on the
              gutter, over the list's first column. */}
          <div className="-ml-1 flex flex-wrap items-center gap-2">
            {/* Hidden whole, so its wrapper leaves no gap before Filter. */}
            {sortMenu && (
              <div
                className={cn('contents', sortMenu.hiddenFromMd && 'md:hidden')}
              >
                <SortMenu {...sortMenu} />
              </div>
            )}
            <FilterPopover filters={filters} onResetFilters={onResetFilters} />
          </div>
        </div>
        {action && (
          <div className="ml-auto flex min-h-10 items-center gap-2 sm:min-h-11.5">
            {action}
          </div>
        )}
        {/* On phones the toggle takes its own row only when an action shares
          the first one. -mr-1.5 puts its icon on the gutter, like Filter's
          on the left. */}
        {view && onViewChange && (
          <div
            className={cn(
              '-mr-1.5 flex min-h-10 items-center justify-end sm:min-h-11.5',
              action ? 'w-full sm:w-auto' : 'ml-auto'
            )}
          >
            <ListViewToggle onViewChange={onViewChange} view={view} />
          </div>
        )}
      </div>
    </>
  );
}

export function SortMenu<V extends string>({
  sorts,
  sort,
  ascending,
  onSortChange,
}: SortMenuProps<V>) {
  const current = sorts.find((option) => option.value === sort) ?? sorts[0];
  return (
    <Menu
      align="start"
      alignWidthToTrigger
      itemClassName="gap-2.5"
      items={sorts.map((option) => ({
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
          aria-label={m.workspaces_sort_prefix({
            label: current.label,
          })}
          className="-mx-1 h-fit px-2 py-1.5"
          data-order={ascending ? 'ascending' : 'descending'}
          data-sort={current.value}
          iconLeft="sort"
          iconLeftClassName="sm:hidden!"
          iconRight="chevronDown"
          iconRightClassName="max-sm:hidden!"
          size="md"
          variant="ghost-hover"
        >
          <span className="hidden sm:inline">
            {m.workspaces_sort_prefix({ label: current.label })}
          </span>
        </Button>
      }
    />
  );
}

/** The list pages' filter: a trigger naming the active filters and a popover
 * of toggle badges per section. */
export function FilterPopover({
  filters,
  onResetFilters,
}: {
  filters: FilterSection[];
  onResetFilters: () => void;
}) {
  const [filterOpen, setFilterOpen] = useState(false);
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
    <Popover onOpenChange={setFilterOpen} open={filterOpen}>
      <PopoverTrigger asChild>
        <Button
          aria-label={filterLabel}
          className="-mx-1 h-fit px-2 py-1.5"
          iconLeft="filter"
          iconRight="chevronDown"
          iconRightClassName="max-sm:hidden!"
          size="md"
          variant="ghost-hover"
        >
          <span className="hidden sm:inline">{filterLabel}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="max-h-96 gap-0 border-0 bg-transparent p-0 shadow-none!"
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
                    const active = section.selected.includes(option.value);
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
  const { onClick: onPress, onPointerDown } = usePointerDownPress()(onClick);
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
      onClick={onPress}
      onPointerDown={onPointerDown}
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

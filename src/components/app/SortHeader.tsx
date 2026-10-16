import { cn } from '@/lib/cn';

export type SortDirection = 'asc' | 'desc';

/** A server-sorted list's column sort: the active column, its direction, and
 * the columns whose first click sorts ascending (text, A to Z); the rest
 * start descending (dates and numbers, newest or largest first). */
export interface ColumnSort<S extends string> {
  ascending: boolean;
  ascendingFirst: readonly S[];
  onSortChange: (sort: S, ascending: boolean) => void;
  sort: S;
}

/** The up and down solid arrows beside a sortable column's label; the
 * active direction is filled. */
export function SortChevrons({
  direction,
}: {
  direction: SortDirection | null;
}) {
  return (
    <span aria-hidden className="flex shrink-0 flex-col gap-0.5">
      <svg
        className={cn(
          'h-[4.5px] w-[7px]',
          direction === 'asc' ? 'fill-fg' : 'fill-placeholder/50'
        )}
        viewBox="0 0 8 5"
      >
        <path d="M4 0 8 5H0z" />
      </svg>
      <svg
        className={cn(
          'h-[4.5px] w-[7px]',
          direction === 'desc' ? 'fill-fg' : 'fill-placeholder/50'
        )}
        viewBox="0 0 8 5"
      >
        <path d="M0 0h8L4 5z" />
      </svg>
    </span>
  );
}

export function sortDirection<S extends string>(
  sorting: ColumnSort<S>,
  value: S
): SortDirection | null {
  if (sorting.sort !== value) return null;
  return sorting.ascending ? 'asc' : 'desc';
}

/** `aria-sort` for the column's header cell. */
export function ariaSort(direction: SortDirection | null) {
  return direction === 'asc'
    ? 'ascending'
    : direction === 'desc'
      ? 'descending'
      : 'none';
}

/** A column label that sorts the list: a click on the active column flips
 * its direction, on another starts it in its natural direction. */
export function SortHeader<S extends string>({
  label,
  value,
  sorting,
  fit,
}: {
  label: string;
  value: S;
  sorting: ColumnSort<S>;
  /** Size the column to the whole label instead of truncating it, for tables
   * that scroll sideways. */
  fit?: boolean;
}) {
  const direction = sortDirection(sorting, value);
  return (
    <button
      className={cn(
        '-mx-1 -my-1 inline-flex cursor-pointer items-center gap-4 rounded-button px-1 py-1 [text-transform:inherit] hover:text-fg focus-visible:outline-2 focus-visible:outline-action',
        !fit && 'max-w-full',
        direction && 'text-fg'
      )}
      onClick={() =>
        sorting.onSortChange(
          value,
          direction
            ? direction === 'desc'
            : sorting.ascendingFirst.includes(value)
        )
      }
      type="button"
    >
      <span className={cn(!fit && 'min-w-0 truncate')}>{label}</span>
      <SortChevrons direction={direction} />
    </button>
  );
}

import type { ReactNode } from 'react';
import {
  ariaSort,
  type ColumnSort,
  SortHeader,
  sortDirection,
} from '@/components/app/SortHeader';
import { Skeleton } from '@/components/ui/feedback';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';

export interface BillingColumn<S extends string = string> {
  align?: 'right';
  /** Long names: wrap to at most two lines in a bounded width. */
  clamp?: boolean;
  id: string;
  label: string;
  muted?: boolean;
  /** With the table's `sorting`, the header sorts the list by this. */
  sort?: S;
}

/** The one table design on Billing & usage: muted header, divider rows,
 * scrolling sideways. Detailed usage and Invoices use it, and Learning's Past
 * reviews and All results on smaller screens. */
export function BillingTable<S extends string = string>({
  columns,
  rows,
  sorting,
}: {
  columns: BillingColumn<S>[];
  sorting?: ColumnSort<S>;
  rows: {
    key: string;
    cells: Record<string, ReactNode>;
    /** E.g. `relative` for a cell link stretched over the row. */
    className?: string;
  }[];
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-divider border-b">
            {columns.map((c) => (
              <th
                aria-sort={
                  sorting && c.sort
                    ? ariaSort(sortDirection(sorting, c.sort))
                    : undefined
                }
                className={cn(
                  't-meta whitespace-nowrap py-2.5 pr-4 font-medium text-fg-muted',
                  c.align === 'right' && 'pr-0 text-right'
                )}
                key={c.id}
              >
                {sorting && c.sort ? (
                  <SortHeader
                    label={c.label}
                    sorting={sorting}
                    value={c.sort}
                  />
                ) : (
                  c.label
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              className={cn('border-divider border-b', row.className)}
              key={row.key}
            >
              {columns.map((c) => (
                <td
                  className={cn(
                    'whitespace-nowrap py-3 pr-4',
                    c.align === 'right' && 'pr-0 text-right',
                    c.muted && 'text-fg-muted',
                    c.clamp && 'min-w-36 max-w-56 whitespace-normal'
                  )}
                  key={c.id}
                >
                  {c.clamp ? (
                    <div className="wrap-break-word line-clamp-2">
                      {row.cells[c.id]}
                    </div>
                  ) : (
                    row.cells[c.id]
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function BillingTableSkeleton({
  columns,
}: {
  columns: BillingColumn[];
}) {
  return (
    <div aria-busy="true" aria-label={m.a11y_loading()} role="status">
      <BillingTable
        columns={columns}
        rows={Array.from({ length: 6 }, (_, i) => ({
          cells: Object.fromEntries(
            columns.map((column) => [
              column.id,
              <Skeleton
                className={cn(
                  'h-5 w-3/4 min-w-12 animate-none',
                  column.align === 'right' && 'ml-auto'
                )}
                key={column.id}
              />,
            ])
          ),
          key: `loading-${i}`,
        }))}
      />
    </div>
  );
}

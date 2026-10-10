import type { ReactNode } from 'react';
import { Skeleton } from '@/components/ui/feedback';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';

export interface BillingColumn {
  align?: 'right';
  id: string;
  label: string;
  muted?: boolean;
}

/** The one table design on Billing & usage: muted header, divider rows,
 * scrolling sideways. Detailed usage and Invoices use it, and Learning's Past
 * reviews and All results on smaller screens. */
export function BillingTable({
  columns,
  rows,
}: {
  columns: BillingColumn[];
  rows: { key: string; cells: Record<string, ReactNode> }[];
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-divider border-b">
            {columns.map((c) => (
              <th
                className={cn(
                  't-meta whitespace-nowrap py-2.5 pr-4 font-medium text-fg-muted',
                  c.align === 'right' && 'pr-0 text-right'
                )}
                key={c.id}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr className="border-divider border-b" key={row.key}>
              {columns.map((c) => (
                <td
                  className={cn(
                    'whitespace-nowrap py-3 pr-4',
                    c.align === 'right' && 'pr-0 text-right',
                    c.muted && 'text-fg-muted'
                  )}
                  key={c.id}
                >
                  {row.cells[c.id]}
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

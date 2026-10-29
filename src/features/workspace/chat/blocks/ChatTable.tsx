import type { ReactNode } from 'react';
import type { RowProps, TableProps } from '../schema';
import { CiteFooter, Cites, elements } from './Cite';

/** The chat's table look, Billing & usage's at the chat's 12px table text
 * (11px header): no frame, muted header labels, a divider under the header
 * and every row, scrolling sideways. The Table component and Markdown tables
 * both draw with these parts. */
export function TableFrame({
  caption,
  children,
}: {
  caption?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        {caption ? (
          <caption className="pb-2 text-left font-semibold text-[13.5px] text-fg">
            {caption}
          </caption>
        ) : null}
        {children}
      </table>
    </div>
  );
}

export function TableRow({ children }: { children?: ReactNode }) {
  return <tr className="border-divider border-b">{children}</tr>;
}

export function TableHead({ children }: { children?: ReactNode }) {
  return (
    <th
      className="py-2.5 pr-4 align-bottom font-medium text-[11px] text-fg-muted last:pr-0"
      scope="col"
    >
      {children}
    </th>
  );
}

export function TableCell({ children }: { children?: ReactNode }) {
  return <td className="py-3 pr-4 align-top last:pr-0">{children}</td>;
}

/** A read-only table. A row's citations are raised numbers at the end of its
 * last cell, as in running text; the table's own sources sit under it. */
export function ChatTable({ props }: { props: TableProps }) {
  const rows = elements<RowProps>(props.rows);
  const columns = props.columns ?? [];
  return (
    <div className="flex flex-col gap-1.5">
      <TableFrame caption={props.caption}>
        <thead>
          <TableRow>
            {columns.map((column, index) => (
              <TableHead key={index}>{column}</TableHead>
            ))}
          </TableRow>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <TableRow key={index}>
              {columns.map((_, cell) => (
                <TableCell key={cell}>
                  {row.props.cells[cell] ?? ''}
                  {cell === columns.length - 1 ? (
                    <Cites passages={row.props.passages} />
                  ) : null}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </tbody>
      </TableFrame>
      <CiteFooter passages={props.passages} />
    </div>
  );
}

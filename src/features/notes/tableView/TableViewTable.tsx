import { Icon } from '@/components/ui/Icon';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import {
  COLUMN_ICON,
  OPTION_CHIP_CLASS,
  OPTION_CHIP_SHAPE,
  tableViewDate,
} from './display';
import {
  cellOption,
  cellValue,
  drawnColumns,
  firstViewRows,
  plainNumber,
  type TableViewBlock,
  type TableViewColumn,
  type TableViewRow,
} from './model';

/* A table view as the read-only renderers draw it (a note's View and Preview,
   share pages, which render it in the Worker): its first view as a table,
   whatever its kind (spec "How readers draw it"). Plain markup with no state
   or browser API. On a phone the table scrolls sideways in its own box with
   the title column kept in view. */

const CELL = 'h-9 border-line border-b px-2.5 text-left align-middle';
/** Each cell but a row's first has a line on its left. */
const DIVIDED = 'border-l';
/** The title column stays in view while the rest scroll under it, with its
 * own right edge: a collapsed table paints borders where the cell started. */
const STICKY =
  'sticky left-0 z-[1] bg-surface shadow-[inset_-1px_0_0_var(--color-line)]';

/** A checkbox cell, drawn as the editor's box. */
function CheckboxCell({ checked }: { checked: boolean }) {
  return checked ? (
    <span
      aria-label={m.table_view_checked()}
      className="inline-flex size-4 items-center justify-center rounded bg-fg align-middle text-surface"
      role="img"
    >
      <Icon name="tick" size={12} strokeWidth={3} />
    </span>
  ) : (
    <span
      aria-label={m.table_view_unchecked()}
      className="inline-block size-4 rounded border-[1.5px] border-line-strong align-middle"
      role="img"
    />
  );
}

function Cell({ column, row }: { column: TableViewColumn; row: TableViewRow }) {
  if (column.kind === 'checkbox')
    return <CheckboxCell checked={cellValue(column, row) === true} />;
  if (column.kind === 'select') {
    const option = cellOption(column, row);
    return option ? (
      <span className={cn(OPTION_CHIP_SHAPE, OPTION_CHIP_CLASS[option.color])}>
        {option.name}
      </span>
    ) : null;
  }
  const value = cellValue(column, row);
  if (value === undefined) return null;
  const text =
    column.kind === 'date'
      ? tableViewDate(String(value))
      : typeof value === 'number'
        ? plainNumber(value)
        : String(value);
  // Long text wraps inside a bounded cell instead of widening the table.
  return (
    <div className="max-w-[200px] whitespace-pre-wrap break-words py-1.5 sm:max-w-[320px]">
      {text}
    </div>
  );
}

export function TableViewTable({ block }: { block: TableViewBlock }) {
  const columns = drawnColumns(block);
  const rows = firstViewRows(block);
  const title = block.title.trim();
  return (
    <section aria-label={title || undefined}>
      {title && (
        <div className="mb-1.5 flex min-h-8 items-center font-semibold text-lg">
          {title}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse border-line border-t text-sm">
          <thead>
            <tr>
              {columns.map((column, index) => (
                <th
                  className={cn(
                    CELL,
                    'whitespace-nowrap font-medium text-fg-muted',
                    index === 0 ? STICKY : DIVIDED
                  )}
                  key={column.id}
                  scope="col"
                >
                  <span className="inline-flex items-center gap-1.5">
                    <Icon name={COLUMN_ICON[column.kind]} size={16} />
                    {column.name}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                {columns.map((column, index) => (
                  <td
                    className={cn(
                      CELL,
                      index === 0 ? cn(STICKY, 'font-semibold') : DIVIDED
                    )}
                    key={column.id}
                  >
                    <Cell column={column} row={row} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

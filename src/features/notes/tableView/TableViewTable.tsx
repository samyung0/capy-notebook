import { cn } from '@/lib/cn';
import { CellText, ColumnLabel } from './cells';
import {
  CELL_CLASS,
  CELL_CONTENT_CLASS,
  COLUMN_WIDTH,
  DIVIDED_CLASS,
  HEADER_CLASS,
  STICKY_CLASS,
  TABLE_CLASS,
  tableWidth,
  WIDTH_CLASS,
  widthVars,
} from './display';
import { drawnColumns, firstViewRows, type TableViewBlock } from './model';

/* A table view as the read-only renderers draw it (a note's View and Preview,
   share pages, which render it in the Worker): its first view as a table,
   whatever its kind (spec "How readers draw it"). Plain markup with no state
   or browser API, laid out as the editor's table (display.ts: the same fixed
   column widths, cells and ellipsis), so a note keeps its table's shape when
   it switches between View and the editor. On a phone the table scrolls
   sideways in its own box with the title column kept in view. */

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
      <div className="overflow-x-auto border-line border-t">
        <table className={TABLE_CLASS} style={widthVars(tableWidth(columns))}>
          <colgroup>
            {columns.map((column) => (
              <col
                className={WIDTH_CLASS}
                key={column.id}
                style={widthVars(COLUMN_WIDTH[column.kind])}
              />
            ))}
          </colgroup>
          <thead>
            <tr>
              {columns.map((column, index) => (
                <th
                  className={cn(
                    CELL_CLASS,
                    HEADER_CLASS,
                    index === 0 ? STICKY_CLASS : DIVIDED_CLASS
                  )}
                  key={column.id}
                  scope="col"
                >
                  <div className={CELL_CONTENT_CLASS}>
                    <ColumnLabel column={column} />
                  </div>
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
                      CELL_CLASS,
                      index === 0 ? STICKY_CLASS : DIVIDED_CLASS
                    )}
                    key={column.id}
                  >
                    <div
                      className={cn(
                        CELL_CONTENT_CLASS,
                        index === 0 && 'font-semibold'
                      )}
                    >
                      <CellText column={column} row={row} />
                    </div>
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

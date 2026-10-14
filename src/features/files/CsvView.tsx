import { useEffect, useMemo, useState } from 'react';
import {
  ariaSort,
  SortChevrons,
  type SortDirection,
} from '@/components/app/SortHeader';
import { Skeleton } from '@/components/ui/feedback';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import {
  CSV_PREVIEW_MAX_COLUMNS,
  CSV_PREVIEW_MAX_ROWS,
  type CsvPreviewColumn,
  type CsvPreviewResult,
} from './csvPreviewCore';
import { FileError } from './FileStates';

/** The first column's extra left padding (pl-5 over px-3) on top of the
 *  measured width, so it truncates at the same point as the others. */
const FIRST_COLUMN_INSET_PX = 8;

interface Sort {
  column: number;
  direction: SortDirection;
}

const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

/** Sorts body rows; empty cells stay last in both directions. */
function sortRows(rows: string[][], sort: Sort, numeric: boolean): string[][] {
  const sign = sort.direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = a[sort.column]?.trim() ?? '';
    const y = b[sort.column]?.trim() ?? '';
    if (!(x && y)) return Number(!x) - Number(!y);
    const order = numeric ? Number(x) - Number(y) : collator.compare(x, y);
    return order * sign;
  });
}

function nextSort(current: Sort | null, column: number): Sort | null {
  if (current?.column !== column) return { column, direction: 'asc' };
  return current.direction === 'asc' ? { column, direction: 'desc' } : null;
}

type WorkerResponse =
  | { result: CsvPreviewResult; type: 'result' }
  | { message: string; type: 'error' };

/** Lightweight, read-only CSV preview. Modern Office files use BetterOffice. */
export default function CsvView({
  url,
  onRetry,
}: {
  url: string;
  onRetry: () => void;
}) {
  const [result, setResult] = useState<CsvPreviewResult | null>(null);
  const [error, setError] = useState(false);
  const [sort, setSort] = useState<Sort | null>(null);

  useEffect(() => {
    const worker = new Worker(new URL('./CsvView.worker.ts', import.meta.url), {
      type: 'module',
    });
    setResult(null);
    setError(false);
    setSort(null);
    worker.addEventListener(
      'message',
      (event: MessageEvent<WorkerResponse>) => {
        if (event.data.type === 'result') setResult(event.data.result);
        else setError(true);
      }
    );
    worker.addEventListener('error', () => setError(true));
    worker.postMessage({ type: 'preview', url });
    return () => {
      worker.terminate();
    };
  }, [url]);

  const body = useMemo(() => {
    if (!result) return [];
    const rows = result.rows.slice(1);
    if (!sort) return rows;
    return sortRows(rows, sort, result.columns[sort.column]?.numeric ?? false);
  }, [result, sort]);

  if (error) {
    return (
      <FileError
        kind="sheet"
        onRetry={onRetry}
        title={m.files_sheet_failed()}
      />
    );
  }
  if (!result) return <Skeleton className="h-[60vh] w-full" />;
  if (result.rows.length === 0) {
    return (
      <p className="py-8 text-center text-fg-muted">{m.files_sheet_empty()}</p>
    );
  }

  const header = result.rows[0] ?? [];
  return (
    <div className="flex h-full flex-col gap-2">
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-max table-fixed border-separate border-spacing-0 text-sm">
          <colgroup>
            {result.columns.map((column, index) => (
              <col
                key={index}
                style={{
                  width:
                    column.width + (index === 0 ? FIRST_COLUMN_INSET_PX : 0),
                }}
              />
            ))}
          </colgroup>
          <thead>
            <tr>
              {result.columns.map((column, index) => (
                <HeaderCell
                  column={column}
                  direction={sort?.column === index ? sort.direction : null}
                  key={index}
                  label={header[index] ?? ''}
                  onSort={() => setSort((current) => nextSort(current, index))}
                />
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {result.columns.map((column, columnIndex) => {
                  const text = row[columnIndex] ?? '';
                  // Clicking focuses the cell (tabIndex -1 keeps it out of
                  // the tab order) and lifts the clamp; clicking away
                  // blurs it and clamps again.
                  return (
                    <td
                      className={cn(
                        'border-line border-b px-3 py-1.5 align-top outline-none first:pl-5 last:border-r',
                        column.numeric && 'text-right'
                      )}
                      key={columnIndex}
                      tabIndex={-1}
                    >
                      <div className="line-clamp-3 in-focus:line-clamp-none whitespace-pre-wrap break-words">
                        {text}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {result.truncated && (
        <p className="t-meta text-fg-muted">
          {m.files_sheet_truncated({
            columns: CSV_PREVIEW_MAX_COLUMNS,
            rows: CSV_PREVIEW_MAX_ROWS,
          })}
        </p>
      )}
    </div>
  );
}

function HeaderCell({
  column,
  direction,
  label,
  onSort,
}: {
  column: CsvPreviewColumn;
  direction: SortDirection | null;
  label: string;
  onSort: () => void;
}) {
  return (
    <th
      aria-sort={ariaSort(direction)}
      className="sticky top-0 z-1 border-line bg-page p-0 text-left font-medium first:*:pl-5 last:border-r"
    >
      <button
        className={cn(
          'flex w-full cursor-pointer items-center gap-1.5 px-3 py-2 focus-visible:outline-2 focus-visible:outline-action focus-visible:-outline-offset-2',
          column.numeric && 'flex-row-reverse'
        )}
        onClick={onSort}
        title={label}
        type="button"
      >
        <span className="min-w-0 truncate">{label}</span>
        <SortChevrons direction={direction} />
      </button>
    </th>
  );
}

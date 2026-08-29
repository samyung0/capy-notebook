import { useEffect, useState } from 'react';
import { Skeleton } from '@/components/ui/feedback';
import { m } from '@/i18n';

type Cell = boolean | number | string | null;

const MAX_ROWS = 500;
const MAX_COLS = 50;

/** Lightweight, read-only CSV preview. Modern Office files use BetterOffice. */
export default function CsvView({ url }: { url: string }) {
  const [rows, setRows] = useState<Cell[][] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(false);
    void Promise.all([
      import('xlsx'),
      fetch(url).then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.arrayBuffer();
      }),
    ]).then(
      ([XLSX, bytes]) => {
        const workbook = XLSX.read(bytes);
        const first = workbook.Sheets[workbook.SheetNames[0] ?? ''];
        const parsed = first
          ? XLSX.utils.sheet_to_json<Cell[]>(first, {
              defval: null,
              header: 1,
            })
          : [];
        if (!cancelled) setRows(parsed);
      },
      () => {
        if (!cancelled) setError(true);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (error) {
    return (
      <p className="py-8 text-center text-tint-error-fg">
        {m.files_sheet_failed()}
      </p>
    );
  }
  if (!rows) return <Skeleton className="h-[60vh] w-full" />;
  if (rows.length === 0) {
    return (
      <p className="py-8 text-center text-fg-muted">{m.files_sheet_empty()}</p>
    );
  }

  const visibleRows = rows.slice(0, MAX_ROWS);
  const truncated =
    rows.length > MAX_ROWS || visibleRows.some((row) => row.length > MAX_COLS);
  return (
    <div className="flex h-full flex-col gap-2">
      <div className="min-h-0 flex-1 overflow-auto rounded-card border border-line">
        <table className="w-max min-w-full border-collapse text-sm">
          <tbody>
            {visibleRows.map((row, rowIndex) => (
              <tr
                className={
                  rowIndex === 0 ? 'bg-surface-dark font-medium' : undefined
                }
                key={rowIndex}
              >
                {row.slice(0, MAX_COLS).map((cell, columnIndex) => (
                  <td
                    className="max-w-90 truncate border border-line px-2.5 py-1.5"
                    key={columnIndex}
                  >
                    {cell == null ? '' : String(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {truncated && (
        <p className="t-meta text-fg-muted">
          {m.files_sheet_truncated({ columns: MAX_COLS, rows: MAX_ROWS })}
        </p>
      )}
    </div>
  );
}

import { useEffect, useState } from 'react';
import { Skeleton } from '@/components/ui';
import { cn } from '@/lib/cn';

type Cell = string | number | boolean | null;
interface SheetData {
  name: string;
  rows: Cell[][];
}

// Render caps so a huge workbook can't lock up the tab.
const MAX_ROWS = 500;
const MAX_COLS = 50;

/** Spreadsheet viewer (xlsx/xls/csv). SheetJS is imported on demand so it
 * stays out of the main bundle. */
export default function SheetView({ url }: { url: string }) {
  const [sheets, setSheets] = useState<SheetData[] | null>(null);
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSheets(null);
    setError(null);
    setActive(0);
    (async () => {
      try {
        const [XLSX, buf] = await Promise.all([
          import('xlsx'),
          fetch(url).then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.arrayBuffer();
          }),
        ]);
        const wb = XLSX.read(buf);
        const parsed = wb.SheetNames.map((name) => ({
          name,
          rows: XLSX.utils.sheet_to_json<Cell[]>(wb.Sheets[name], {
            defval: null,
            header: 1,
          }),
        }));
        if (!cancelled) setSheets(parsed);
      } catch (e) {
        if (!cancelled)
          setError(
            e instanceof Error ? e.message : 'failed to load spreadsheet'
          );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (error) {
    return (
      <p className="py-8 text-center text-tint-error-fg">
        Couldn't load this spreadsheet ({error}).
      </p>
    );
  }
  if (!sheets) {
    return <Skeleton className="h-[60vh] w-full" />;
  }
  if (sheets.length === 0) {
    return (
      <p className="py-8 text-center text-fg-muted">
        This spreadsheet is empty.
      </p>
    );
  }

  const sheet = sheets[Math.min(active, sheets.length - 1)];
  const rows = sheet.rows.slice(0, MAX_ROWS);
  const truncated =
    sheet.rows.length > MAX_ROWS || rows.some((r) => r.length > MAX_COLS);

  return (
    <div className="flex h-full flex-col gap-2">
      {sheets.length > 1 && (
        <div className="flex flex-wrap gap-1">
          {sheets.map((s, i) => (
            <button
              className={cn(
                'rounded-button px-2.5 py-1 text-sm transition-colors',
                i === active
                  ? 'bg-surface-dark font-medium text-fg'
                  : 'text-fg-muted hover:bg-surface-hover-bg'
              )}
              key={s.name}
              onClick={() => setActive(i)}
              type="button"
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto rounded-card border border-line">
        <table className="w-max min-w-full border-collapse text-sm">
          <tbody>
            {rows.map((row, ri) => (
              <tr
                className={ri === 0 ? 'bg-surface-dark font-medium' : undefined}
                key={ri}
              >
                {row.slice(0, MAX_COLS).map((cell, ci) => (
                  <td
                    className="max-w-90 truncate border border-line px-2.5 py-1.5"
                    key={ci}
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
          Preview truncated to {MAX_ROWS} rows × {MAX_COLS} columns.
        </p>
      )}
    </div>
  );
}

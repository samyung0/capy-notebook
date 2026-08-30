import { useEffect, useState } from 'react';
import { Skeleton } from '@/components/ui/feedback';
import { m } from '@/i18n';
import {
  CSV_PREVIEW_MAX_COLUMNS,
  CSV_PREVIEW_MAX_ROWS,
  type CsvPreviewCell,
  type CsvPreviewResult,
} from './csvPreviewCore';

type WorkerResponse =
  | { result: CsvPreviewResult; type: 'result' }
  | { message: string; type: 'error' };

/** Lightweight, read-only CSV preview. Modern Office files use BetterOffice. */
export default function CsvView({ url }: { url: string }) {
  const [result, setResult] = useState<CsvPreviewResult | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const worker = new Worker(new URL('./CsvView.worker.ts', import.meta.url), {
      type: 'module',
    });
    setResult(null);
    setError(false);
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

  if (error) {
    return (
      <p className="py-8 text-center text-tint-error-fg">
        {m.files_sheet_failed()}
      </p>
    );
  }
  if (!result) return <Skeleton className="h-[60vh] w-full" />;
  if (result.rows.length === 0) {
    return (
      <p className="py-8 text-center text-fg-muted">{m.files_sheet_empty()}</p>
    );
  }

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="min-h-0 flex-1 overflow-auto rounded-card border border-line">
        <table className="w-max min-w-full border-collapse text-sm">
          <tbody>
            {result.rows.map((row: CsvPreviewCell[], rowIndex) => (
              <tr
                className={
                  rowIndex === 0 ? 'bg-surface-dark font-medium' : undefined
                }
                key={rowIndex}
              >
                {row.map((cell, columnIndex) => (
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

import type { SourceFile } from '@/api/types';
import { ErrorState } from '@/components/app/ErrorState';
import { Spinner } from '@/components/ui/feedback';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { useOnlineStatus } from '@/lib/online';
import { fileIsIngesting } from './fileUtils';

export function FileLoading({
  message = m.files_loading_preview(),
}: {
  message?: string;
}) {
  const online = useOnlineStatus();
  return (
    <div className="flex h-full flex-1 flex-col items-center justify-center gap-3">
      <Spinner className="size-6.5" />
      <p>{online ? message : m.connection_waiting()}</p>
    </div>
  );
}

export function FileError({
  title = m.error_file_title(),
  message = m.error_file_body(),
}: {
  title?: string;
  message?: string;
}) {
  return <ErrorState description={message} title={title} variant="panel" />;
}

export function FileEmpty({
  title = m.error_file_empty_title(),
  message = m.error_file_empty_body(),
}: {
  title?: string;
  message?: string;
}) {
  return <ErrorState description={message} title={title} variant="panel" />;
}

/** Shown under the file header when ingest did not write retrieval chunks. */
export function FileNotIndexedBanner({
  file,
}: {
  file: Pick<SourceFile, 'indexed' | 'status'>;
}) {
  if (fileIsIngesting(file.status) || file.indexed) return null;
  const failed = file.status === 'failed';
  return (
    <div
      className={cn(
        'shrink-0 border-b px-4 py-2 text-sm',
        failed
          ? 'border-solid-error/40 bg-tint-error text-tint-error-fg'
          : 'border-divider bg-surface-hover-bg text-fg-secondary'
      )}
      data-testid="file-not-indexed"
      role="status"
    >
      {failed ? m.files_not_indexed_failed() : m.files_not_indexed()}
    </div>
  );
}

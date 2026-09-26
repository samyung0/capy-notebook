import type { SourceFile } from '@/api/types';
import { ErrorState } from '@/components/app/ErrorState';
import { WarningBanner } from '@/components/banners/WarningBanner';
import { ErrorAction } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/feedback';
import type { IconName } from '@/components/ui/Icon';
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
  icon = 'fileError',
  title = m.error_file_title(),
  message = m.error_file_body(),
  onRetry,
}: {
  icon?: IconName;
  title?: string;
  message?: string;
  onRetry?: () => void;
}) {
  return (
    <ErrorState
      action={
        onRetry && (
          <ErrorAction iconLeftClassName="me-1.5" onClick={onRetry}>
            {m.error_action_retry()}
          </ErrorAction>
        )
      }
      description={message}
      icon={icon}
      title={title}
      variant="panel"
    />
  );
}

export function FileEmpty({
  title = m.error_file_empty_title(),
  message = m.error_file_empty_body(),
}: {
  title?: string;
  message?: string;
}) {
  return (
    <ErrorState
      description={message}
      icon="fileError"
      title={title}
      variant="panel"
    />
  );
}

/**
 * A newer version was published while this saved editor stayed open, or the
 * maintenance pause closed it (`paused`). The view stays as it is, read-only;
 * reloading the page opens the new version.
 */
export function SourceReplacedBanner({ paused }: { paused?: boolean }) {
  return (
    <WarningBanner
      action={
        <ErrorAction
          iconLeftClassName="me-1"
          onClick={() => window.location.reload()}
          size="sm"
        >
          {m.error_action_reload()}
        </ErrorAction>
      }
      icon="info"
      message={paused ? m.source_edit_paused() : m.source_edit_replaced()}
    />
  );
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

import type { SourceFile, StorageFullBy } from '@/api/types';
import { ErrorState } from '@/components/app/ErrorState';
import {
  FileBanner,
  type FileBannerAction,
} from '@/components/banners/FileBanner';
import {
  isRecoveryBanner,
  SaveBanner,
  type SaveBannerState,
} from '@/components/banners/SaveBanner';
import { ErrorAction } from '@/components/ui/Button';
import { PaneLoading } from '@/components/ui/feedback';
import type { IconName } from '@/components/ui/Icon';
import { useSlowedLine } from '@/features/collaboration/SlowedOpen';
import { m } from '@/i18n';
import { useOnlineStatus } from '@/lib/online';
import { fileIsIngesting, notIndexedMessage } from './fileUtils';

export function FileLoading({
  message = m.files_loading_preview(),
  slowed = false,
}: {
  message?: string;
  /** A room's open waits on the user's open budget: after 5 s it says so. */
  slowed?: boolean;
}) {
  const online = useOnlineStatus();
  const line = useSlowedLine(slowed);
  return (
    <PaneLoading
      detail={line ? m.editor_open_slowed() : undefined}
      message={online ? message : m.connection_waiting()}
    />
  );
}

export function FileError({
  errorId,
  icon = 'fileError',
  kind,
  title = m.error_file_title(),
  message = m.error_file_body(),
  onRetry,
  retryLabel = m.error_action_retry(),
}: {
  /** An unexpected API failure's trace id (`unexpectedErrorId`). */
  errorId?: string | null;
  icon?: IconName;
  kind?: 'sheet' | 'text';
  title?: string;
  message?: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <ErrorState
      action={
        onRetry && <ErrorAction onClick={onRetry}>{retryLabel}</ErrorAction>
      }
      description={message}
      errorId={errorId}
      icon={icon}
      kind={kind}
      title={title}
      variant="panel"
    />
  );
}

/**
 * The open file was trashed or deleted, or access to it lost, while editing;
 * or (`outdated`) the Office runtime speaks another protocol version after a
 * deploy, which only a reload resolves.
 */
export function FileUnavailable({
  kind,
}: {
  kind: 'notFound' | 'forbidden' | 'outdated';
}) {
  if (kind === 'outdated')
    return (
      <FileError
        message={m.error_chunk_body()}
        onRetry={() => window.location.reload()}
        retryLabel={m.error_action_reload()}
        title={m.error_chunk_title()}
      />
    );
  return kind === 'notFound' ? (
    <FileError
      message={m.files_missing_body()}
      title={m.files_missing_title()}
    />
  ) : (
    <FileError
      icon="securityWarning"
      message={m.editor_access_lost_body()}
      title={m.editor_access_lost()}
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
 * reloading the page opens the new version. One row, with Reload in the close
 * button's place, as the recovery banner.
 */
export function SourceReplacedBanner({ paused }: { paused?: boolean }) {
  return (
    <FileBanner
      actions={[
        {
          label: m.error_action_reload(),
          onClick: () => window.location.reload(),
        },
      ]}
      inline
      message={paused ? m.source_edit_paused() : m.source_edit_replaced()}
    />
  );
}

/** Shown under the file header when ingest did not write retrieval chunks. */
export function FileNotIndexedBanner({
  file,
}: {
  file: Pick<SourceFile, 'indexed' | 'indexLimit' | 'status'>;
}) {
  if (fileIsIngesting(file.status) || file.indexed) return null;
  const failed = file.status === 'failed';
  return (
    <FileBanner
      message={failed ? m.files_not_indexed_failed() : notIndexedMessage(file)}
      testId="file-not-indexed"
      tone={failed ? 'error' : 'neutral'}
    />
  );
}

/** The source editor's banners: pause at open, replaced session, save
 * state, errors. */
export function SourceBanners({
  actions,
  banner,
  error,
  onReload,
  paused,
  pausedAtOpen,
  readOnly = false,
  reloading,
  replaced,
  slowed = false,
  storageFull,
}: {
  actions: FileBannerAction[];
  banner: SaveBannerState | null;
  error: string | null;
  /** Leaves the recovery view for the last saved version. */
  onReload: () => void;
  paused: boolean;
  pausedAtOpen: boolean;
  /** The room turned read-only (a frozen account). */
  readOnly?: boolean;
  reloading: boolean;
  replaced: boolean;
  /** The edit session's open waits on the user's open budget: after 5 s a
   * strip says so while the file loads. */
  slowed?: boolean;
  /** The file's payer is at its storage limit, so it opens view-only. */
  storageFull?: StorageFullBy;
}) {
  const slowedLine = useSlowedLine(slowed);
  return (
    <>
      {slowedLine && <FileBanner message={m.editor_open_slowed()} />}
      {storageFull ? (
        <StorageFullBanner by={storageFull} />
      ) : (
        readOnly && <FileBanner message={m.editor_read_only_strip()} />
      )}
      {banner && (
        <SaveBanner onReload={onReload} reloading={reloading} state={banner} />
      )}
      {/* Recovery content is only copied: no download. */}
      {error && (
        <FileBanner
          actions={isRecoveryBanner(banner) ? [] : actions}
          message={error}
          tone="error"
        />
      )}
      {pausedAtOpen ? (
        <FileBanner message={m.source_edit_paused_error()} />
      ) : (
        replaced && <SourceReplacedBanner paused={paused} />
      )}
    </>
  );
}

/** The strip under an item's header while its payer (whoever uploaded or
 * created it) is at its storage limit: the item is view-only. */
export function StorageFullBanner({ by }: { by: StorageFullBy }) {
  return (
    <FileBanner
      message={
        by === 'self'
          ? m.storage_self_full_strip()
          : m.storage_payer_full_strip()
      }
    />
  );
}

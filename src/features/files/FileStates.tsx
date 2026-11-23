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
import {
  failedNotIndexedMessage,
  fileIsIngesting,
  notIndexedMessage,
} from './fileUtils';

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
      // Up by half the file header (h-12, sm:h-14): centred in the pane,
      // not just the body under the header.
      className="-translate-y-6 sm:-translate-y-7"
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
  return <UnavailableItem />;
}

/** A refused read's page: it never says blocked rather than gone (Epo
 * 2026-11-05, Q644). */
export function UnavailableItem() {
  return (
    <FileError
      message={m.error_not_found_body()}
      title={m.error_not_found_title()}
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
      className="-translate-y-6 sm:-translate-y-7"
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
 * button's place.
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
  file: Pick<SourceFile, 'indexed' | 'indexLimit' | 'name' | 'status'>;
}) {
  if (fileIsIngesting(file.status) || file.indexed) return null;
  const failed = file.status === 'failed';
  return (
    <FileBanner
      message={failed ? failedNotIndexedMessage(file) : notIndexedMessage(file)}
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
  discarding,
  onDiscard,
  onDownload,
  onRetry,
  paused,
  pausedAtOpen,
  readOnly = false,
  replaced,
  retrying,
  storageFull,
}: {
  actions: FileBannerAction[];
  banner: SaveBannerState | null;
  /** A Discard is under way. */
  discarding: boolean;
  error: string | null;
  /** Recovery's and the `unsynced` strip's Discard: the edits go, for the
   * last saved version (Epo 2026-11-23). */
  onDiscard: () => void;
  /** Recovery's Download: the editor's draft as it shows. */
  onDownload?: () => void;
  /** The `unsynced` strip's Retry. */
  onRetry?: () => void;
  /** Its join is pending. */
  retrying?: boolean;
  paused: boolean;
  pausedAtOpen: boolean;
  /** The room turned read-only (a frozen account). */
  readOnly?: boolean;
  replaced: boolean;
  /** The file's payer is at its storage limit, so it opens view-only. */
  storageFull?: StorageFullBy;
}) {
  return (
    <>
      {storageFull ? (
        <StorageFullBanner by={storageFull} />
      ) : (
        readOnly && <FileBanner message={m.editor_read_only_strip()} />
      )}
      {banner && (
        <SaveBanner
          discarding={discarding}
          onDiscard={onDiscard}
          onDownload={onDownload}
          onRetry={onRetry}
          retrying={retrying}
          state={banner}
        />
      )}
      {/* Recovery's strip has its own Download: none here. */}
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

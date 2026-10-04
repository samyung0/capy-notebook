import type { SourceFile } from '@/api/types';
import { ErrorState } from '@/components/app/ErrorState';
import {
  FileBanner,
  type FileBannerAction,
} from '@/components/banners/FileBanner';
import {
  SaveBanner,
  type SaveBannerState,
} from '@/components/banners/SaveBanner';
import { ErrorAction } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/feedback';
import type { IconName } from '@/components/ui/Icon';
import { m } from '@/i18n';
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
  retryLabel = m.error_action_retry(),
}: {
  icon?: IconName;
  title?: string;
  message?: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <ErrorState
      action={
        onRetry && (
          <ErrorAction iconLeftClassName="me-1.5" onClick={onRetry}>
            {retryLabel}
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
 * reloading the page opens the new version.
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
    <FileBanner
      message={failed ? m.files_not_indexed_failed() : m.files_not_indexed()}
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
}) {
  return (
    <>
      {readOnly && <FileBanner message={m.editor_read_only_strip()} />}
      {banner && (
        <SaveBanner onReload={onReload} reloading={reloading} state={banner} />
      )}
      {/* Recovery content is only copied: no download. */}
      {error && (
        <FileBanner
          actions={banner === 'recovery' ? [] : actions}
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

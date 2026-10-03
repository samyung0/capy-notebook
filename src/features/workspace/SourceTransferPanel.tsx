import { useQueries } from '@tanstack/react-query';
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { filesQuery } from '@/api/hooks';
import type { SourceFile } from '@/api/types';
import {
  GoogleDriveMonoIcon,
  OneDriveMonoIcon,
} from '@/components/ui/BrandIcons';
import { Card } from '@/components/ui/Card';
import { FileIcon } from '@/components/ui/FileIcon';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { fileIconName } from '@/lib/fileIcons';
import {
  dismissSourceTransfers,
  type SourceProvider,
  type SourceTransfer,
  useSourceTransfers,
} from './sourceTransfers';
import { fileReachedTerminal } from './sourceUpload';

export type TransferStatus =
  | { kind: 'progress'; label: string; value: number }
  | { kind: 'indeterminate'; label: string }
  | {
      detail?: string;
      kind: 'done' | 'background' | 'warning' | 'error';
      label: string;
    };

/** One row's status: the transfer stage until the file exists, then the
 * file's own ingest status from the files cache. */
export function transferStatus(
  transfer: SourceTransfer,
  file: SourceFile | undefined
): TransferStatus {
  switch (transfer.stage) {
    case 'waiting':
      return { kind: 'progress', label: m.source_transfer_waiting(), value: 0 };
    case 'uploading':
      return {
        kind: 'progress',
        label: m.source_transfer_uploading(),
        value: transfer.uploadPct,
      };
    case 'importing':
      return { kind: 'indeterminate', label: m.source_transfer_importing() };
    case 'background':
      return {
        detail: m.source_transfer_background_detail(),
        kind: 'background',
        label: m.source_transfer_background(),
      };
    case 'failed':
      return {
        detail: transfer.error,
        kind: 'error',
        label: m.source_transfer_not_added(),
      };
    case 'added':
      break;
  }
  if (file?.status === 'failed') {
    return {
      detail: m.files_not_indexed_failed(),
      kind: 'error',
      label: m.source_transfer_parse_failed(),
    };
  }
  if (file?.status === 'ready') {
    return transfer.indexes && !file.indexed
      ? {
          detail: m.files_not_indexed(),
          kind: 'warning',
          label: m.source_transfer_not_searchable(),
        }
      : { kind: 'done', label: m.source_transfer_ready() };
  }
  if (file?.status === 'processing') {
    return {
      kind: 'progress',
      label: m.source_transfer_parsing(),
      value: file.ingestPct ?? 0,
    };
  }
  return { kind: 'progress', label: m.source_transfer_queued(), value: 0 };
}

const TERMINAL_ICON = {
  background: { className: 'text-fg-muted', name: 'clock' },
  done: { className: 'text-tint-success-fg', name: 'check' },
  error: { className: 'text-tint-error-fg', name: 'error' },
  warning: { className: 'text-tint-warning-fg', name: 'alert' },
} as const;

export function ProviderIcon({
  className,
  provider,
}: {
  className?: string;
  provider: SourceProvider;
}) {
  return provider === 'google' ? (
    <GoogleDriveMonoIcon className={cn('size-3.25 shrink-0', className)} />
  ) : (
    <OneDriveMonoIcon className={cn('h-2.5 w-4 shrink-0', className)} />
  );
}

function TransferRow({
  file,
  transfer,
}: {
  file: SourceFile | undefined;
  transfer: SourceTransfer;
}) {
  const status = transferStatus(transfer, file);
  return (
    <li
      className="flex flex-col gap-1 border-divider border-b px-4 py-1.5 last:border-0"
      data-transfer-status={status.kind}
    >
      <div className="flex items-center gap-2">
        <FileIcon
          className="size-4 shrink-0 -translate-y-px"
          name={fileIconName(transfer)}
        />
        <span className="min-w-0 flex-1 truncate font-medium text-sm">
          {transfer.name}
        </span>
        {transfer.provider && (
          <ProviderIcon
            className="text-fg-muted"
            provider={transfer.provider}
          />
        )}
      </div>
      <div className="flex items-center gap-2 pl-6">
        {status.kind === 'progress' || status.kind === 'indeterminate' ? (
          <>
            <ProgressBar
              className="flex-1"
              height={4}
              indeterminate={status.kind === 'indeterminate'}
              value={status.kind === 'progress' ? status.value : undefined}
            />
            <span className="t-meta w-18 shrink-0 text-right text-fg-muted">
              {status.label}
            </span>
          </>
        ) : (
          <>
            <Icon
              className={cn(
                'size-3.5 shrink-0',
                TERMINAL_ICON[status.kind].className
              )}
              name={TERMINAL_ICON[status.kind].name}
              strokeWidth={2}
            />
            <span
              className={cn('t-meta text-fg-muted', {
                'text-tint-error-fg': status.kind === 'error',
              })}
            >
              {status.label}
            </span>
          </>
        )}
      </div>
      {'detail' in status && status.detail && (
        <p
          className={cn('t-meta pl-6', {
            'text-fg-muted': status.kind === 'background',
            'text-tint-error-fg': status.kind === 'error',
            'text-tint-warning-fg': status.kind === 'warning',
          })}
        >
          {status.detail}
        </p>
      )}
    </li>
  );
}

function useUnsentBeforeUnload(unsent: number) {
  useEffect(() => {
    if (unsent === 0) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [unsent]);
}

/** Bottom-right list of every upload and import, from the first byte to the
 * parsed file. Closing it only hides the rows; the transfers keep running. */
export function SourceTransferPanel() {
  const transfers = useSourceTransfers((state) => state.transfers);
  const unsent = useSourceTransfers((state) => state.unsent);
  useUnsentBeforeUnload(unsent);
  const fileIdsByWorkspace = new Map<string, string[]>();
  for (const { fileId, workspaceId } of transfers) {
    if (!fileId) continue;
    fileIdsByWorkspace.set(workspaceId, [
      ...(fileIdsByWorkspace.get(workspaceId) ?? []),
      fileId,
    ]);
  }
  const workspaceIds = [...fileIdsByWorkspace.keys()];
  const fileLists = useQueries({
    queries: workspaceIds.map((workspaceId) => ({
      ...filesQuery(workspaceId),
      // The event stream only follows the open workspace; poll the others.
      refetchInterval: (query: { state: { data?: SourceFile[] } }) =>
        fileIdsByWorkspace
          .get(workspaceId)
          ?.some((id) => !fileReachedTerminal(query.state.data, id))
          ? 4000
          : false,
    })),
  });
  if (transfers.length === 0) return null;
  const files = new Map(
    fileLists.flatMap(({ data }) => data ?? []).map((file) => [file.id, file])
  );
  const rows = transfers.map((transfer) => ({
    file: transfer.fileId ? files.get(transfer.fileId) : undefined,
    transfer,
  }));
  const finished = rows.filter(({ file, transfer }) => {
    const { kind } = transferStatus(transfer, file);
    return kind !== 'progress' && kind !== 'indeterminate';
  }).length;

  return createPortal(
    <Card
      border="solid"
      // Same overlay surface, line and shadow as dialogs and dropdowns.
      className="pointer-events-auto fixed right-6 bottom-6 z-40 block w-80 max-w-[calc(100vw-2rem)] border-overlay-line bg-overlay p-1 shadow-pop max-sm:right-4 max-sm:bottom-4"
      data-testid="source-transfer-panel"
      radius="card"
    >
      <IconButton
        className="absolute -top-2 -left-2 size-5 rounded-full border border-divider bg-surface p-0 text-fg-secondary shadow-card hover:bg-surface-hover-bg [&>svg]:size-3"
        icon="x"
        label={m.action_close()}
        onClick={dismissSourceTransfers}
        size="xs"
        strokeWidth={2}
      />
      <div className="flex h-9 items-center border-divider border-b px-4 py-2">
        <span className="t-label text-fg-muted">
          {m.source_transfers_heading({
            count: transfers.length,
            done: finished,
          })}
        </span>
      </div>
      <ul className="max-h-60 overflow-y-auto">
        {rows.map(({ file, transfer }) => (
          <TransferRow file={file} key={transfer.key} transfer={transfer} />
        ))}
      </ul>
    </Card>,
    document.body
  );
}

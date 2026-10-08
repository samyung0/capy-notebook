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
import { fileIsIngesting } from '@/features/files/fileUtils';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { fileIconName } from '@/lib/fileIcons';
import {
  dismissSourceTransfers,
  type SourceProvider,
  type SourceTransfer,
  useSourceTransfers,
} from './sourceTransfers';
import { transferStatus } from './transferStatus';

const TERMINAL_ICON = {
  background: { className: 'text-fg-muted', name: 'clock' },
  done: { className: 'text-tint-success-fg', name: 'check' },
  error: { className: 'text-tint-error-fg', name: 'error' },
  info: { className: 'text-fg-muted', name: 'info' },
} as const;

export function ProviderIcon({
  className,
  provider,
}: {
  className?: string;
  provider: SourceProvider;
}) {
  return provider === 'google' ? (
    <GoogleDriveMonoIcon className={cn('size-4.25 shrink-0', className)} />
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
      className="flex flex-col gap-1 border-divider border-b px-4 py-2 last:border-0"
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
      <div className="flex items-center gap-2">
        {status.kind === 'progress' || status.kind === 'indeterminate' ? (
          <div className="-mt-1 flex w-full items-center pl-6">
            <ProgressBar
              className="flex-1"
              height={4}
              indeterminate={status.kind === 'indeterminate'}
              value={status.kind === 'progress' ? status.value : undefined}
            />
            <span className="t-meta w-18 shrink-0 text-right text-fg-muted">
              {status.label}
            </span>
          </div>
        ) : (
          <div className="mt-1 flex w-full items-center gap-2 pl-0.5">
            <Icon
              className={cn(
                'size-3.5 shrink-0',
                TERMINAL_ICON[status.kind].className
              )}
              name={TERMINAL_ICON[status.kind].name}
              strokeWidth={2}
            />
            {/* The label takes its icon's colour. */}
            <span
              className={cn(
                't-meta translate-y-px',
                TERMINAL_ICON[status.kind].className
              )}
            >
              {status.label}
            </span>
          </div>
        )}
      </div>
      {'detail' in status && status.detail && (
        <p
          className={cn('t-meta pl-6', {
            'text-fg-muted': status.kind !== 'error',
            'text-tint-error-fg': status.kind === 'error',
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
        fileIdsByWorkspace.get(workspaceId)?.some((id) => {
          const file = query.state.data?.find((entry) => entry.id === id);
          return !file || fileIsIngesting(file.status);
        })
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
      className="pointer-events-auto fixed right-4 bottom-4 z-40 block w-96 max-w-[calc(100vw-2rem)] border-overlay-line bg-overlay p-1 shadow-pop sm:right-6 sm:bottom-6"
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

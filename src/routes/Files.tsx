import { useState } from 'react';
import {
  useAllFiles,
  useFile,
  usePurgeTrashed,
  useRestoreTrashed,
  useTrash,
} from '@/api/hooks';
import type { TrashItem } from '@/api/types';
import { PageHeader, PanelWithInvertedRadius } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog, SimpleDialog } from '@/components/ui/Dialog';
import { SkeletonCardGrid } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { Tabs } from '@/components/ui/Tabs';
import {
  FileError,
  FileLoading,
  FileNotIndexedBanner,
} from '@/features/files/FileStates';
import { FileViewer } from '@/features/files/FileViewer';
import { formatFileSize } from '@/features/files/fileUtils';
import { useOfficeEditGuard } from '@/features/files/useOfficeEditGuard';
import { getLocale, m } from '@/i18n';

type FilesTab = 'files' | 'trash';

export default function Files() {
  const [tab, setTab] = useState<FilesTab>('files');
  return (
    <PanelWithInvertedRadius>
      <PageHeader title={m.nav_files()} />
      <Tabs
        className="px-6"
        onChange={(value) => setTab(value as FilesTab)}
        tabs={[
          { label: m.files_tab_files(), value: 'files' },
          { label: m.files_tab_trash(), value: 'trash' },
        ]}
        value={tab}
      />
      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        {tab === 'trash' ? <TrashTab /> : <ActiveFiles />}
      </div>
    </PanelWithInvertedRadius>
  );
}

function ActiveFiles() {
  const { data, fetchStatus, isLoading } = useAllFiles();
  const [openFileId, setOpenFileId] = useState<string | null>(null);
  const [officeEditDirty, setOfficeEditDirty] = useState(false);
  const confirmViewerReplacement = useOfficeEditGuard(officeEditDirty);
  const open = data?.find((file) => file.id === openFileId) ?? null;
  // The list omits `content`, so the viewer needs the full row. The header and
  // the indexed banner render from the list entry meanwhile.
  const {
    data: viewerFile,
    isError: viewerError,
    isPending: viewerPending,
    refetch: refetchViewer,
  } = useFile(openFileId, { errorBoundary: false });

  const openFile = (fileId: string) => {
    if (openFileId !== fileId && !confirmViewerReplacement()) return;
    setOfficeEditDirty(false);
    setOpenFileId(fileId);
  };

  const closeFile = () => {
    if (!confirmViewerReplacement()) return;
    setOfficeEditDirty(false);
    setOpenFileId(null);
  };

  if (fetchStatus === 'paused') return <QueryPausedState />;
  if (isLoading) return <SkeletonCardGrid cardHeight={72} count={6} />;
  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {data?.map((f) => (
          <Card
            className="flex items-center gap-3 p-5.5"
            interactive
            key={f.id}
            onClick={() => openFile(f.id)}
            radius="card-lg"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-card bg-surface-hover-bg text-fg-secondary">
              <Icon name="files" size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="t-subtitle truncate">{f.name}</p>
              <p className="t-meta text-fg-muted">
                {formatFileSize(f.sizeBytes)}
              </p>
            </div>
            <Badge size="sm">{f.kind}</Badge>
          </Card>
        ))}
      </div>
      <SimpleDialog
        onClose={closeFile}
        open={!!open}
        title={open?.name}
        width={760}
      >
        <div className="flex min-h-[50vh] flex-col">
          {open && <FileNotIndexedBanner file={open} />}
          <div className="min-h-0 flex-1">
            {viewerFile ? (
              <FileViewer
                file={viewerFile}
                onDirtyChange={setOfficeEditDirty}
              />
            ) : viewerError ? (
              <FileError onRetry={() => void refetchViewer()} />
            ) : (
              openFileId && viewerPending && <FileLoading />
            )}
          </div>
        </div>
      </SimpleDialog>
    </>
  );
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium' }).format(
    new Date(iso)
  );
}

/** Owner-only bin. Rows are metadata only: a trashed row is never a preview
 * or a download. Restore and permanent deletion are the only actions. */
function TrashTab() {
  const {
    data,
    error,
    fetchNextPage,
    fetchStatus,
    hasNextPage,
    isError,
    isFetchingNextPage,
    isLoading,
    refetch,
  } = useTrash(undefined, true);
  const { mutate: restore } = useRestoreTrashed();
  const { mutate: purge } = usePurgeTrashed();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [purgeTarget, setPurgeTarget] = useState<TrashItem | null>(null);
  const items = data?.pages.flatMap((page) => page.items) ?? [];

  const act = (item: TrashItem, run: typeof restore) => {
    if (busyId) return;
    setBusyId(item.id);
    run(item, { onSettled: () => setBusyId(null) });
  };

  if (fetchStatus === 'paused' && !data) return <QueryPausedState />;
  if (isLoading) return <SkeletonCardGrid cardHeight={72} count={3} />;
  if (isError && !data) {
    return (
      <div
        className="rounded-card border border-tint-error bg-tint-error px-3 py-2 text-sm text-solid-error"
        data-error-surface="panel"
        role="alert"
      >
        <p>{m.trash_load_failed()}</p>
        <p className="t-meta">{error?.message}</p>
        <Button onClick={() => refetch()} size="sm" variant="ghost-hover">
          {m.trash_retry()}
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="t-meta text-fg-muted" role="note">
        {m.trash_notice()}
      </p>
      {items.length === 0 ? (
        <p className="text-fg-muted">{m.trash_empty()}</p>
      ) : null}
      {items.map((item) => {
        const busy = busyId === item.id;
        return (
          <Card
            className="flex items-center gap-3 p-4"
            key={`${item.kind}:${item.id}:${item.episodeId}`}
            radius="card-lg"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-card bg-surface-hover-bg text-fg-secondary">
              <Icon
                name={item.kind === 'material' ? 'message' : 'files'}
                size={18}
              />
            </span>
            <div className="min-w-0 flex-1">
              <p className="t-subtitle truncate">{item.title}</p>
              <p className="t-meta text-fg-muted">
                {item.workspaceName || m.trash_standalone()} ·{' '}
                {formatFileSize(item.sizeBytes)} ·{' '}
                {m.trash_expires({ date: formatDate(item.purgeAfter) })}
              </p>
            </div>
            <Badge size="sm">
              {item.kind === 'material'
                ? item.materialKind || m.trash_kind_material()
                : item.fileKind || m.trash_kind_source()}
            </Badge>
            <Button
              disabled={busy}
              onClick={() => act(item, restore)}
              size="sm"
              variant="ghost-hover"
            >
              {m.trash_restore()}
            </Button>
            <Button
              disabled={busy}
              onClick={() => setPurgeTarget(item)}
              size="sm"
              variant="danger"
            >
              {m.trash_delete_forever()}
            </Button>
          </Card>
        );
      })}
      {hasNextPage ? (
        <Button
          disabled={isFetchingNextPage}
          onClick={() => fetchNextPage()}
          size="sm"
          variant="ghost-hover"
        >
          {m.trash_load_more()}
        </Button>
      ) : null}
      <ConfirmDialog
        body={m.trash_delete_confirm_body({ name: purgeTarget?.title ?? '' })}
        confirmLabel={m.trash_delete_forever()}
        onClose={() => setPurgeTarget(null)}
        onConfirm={() => {
          if (purgeTarget) act(purgeTarget, purge);
        }}
        open={!!purgeTarget}
        title={m.trash_delete_confirm_title()}
      />
    </div>
  );
}

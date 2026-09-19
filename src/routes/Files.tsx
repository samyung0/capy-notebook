import { useMemo, useState } from 'react';
import {
  useFile,
  useOwnedFiles,
  usePurgeTrashed,
  useRestoreTrashed,
  useTrash,
  useWorkspaces,
} from '@/api/hooks';
import type {
  FileKind,
  FileListParams,
  FileListSort,
  TrashItem,
} from '@/api/types';
import {
  ListToolbar,
  type SortOption,
  toggleValue,
} from '@/components/app/ListToolbar';
import { PageHeader, PanelWithInvertedRadius } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog, SimpleDialog } from '@/components/ui/Dialog';
import { FileIcon } from '@/components/ui/FileIcon';
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
import { fileIconName } from '@/lib/fileIcons';
import { useLoadingReveal } from '@/lib/useLoadingReveal';

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
      {tab === 'trash' ? (
        <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
          <TrashTab />
        </div>
      ) : (
        <ActiveFiles />
      )}
    </PanelWithInvertedRadius>
  );
}

const FILE_KINDS: FileKind[] = [
  'pdf',
  'doc',
  'md',
  'image',
  'txt',
  'sheet',
  'slides',
  'audio',
  'json',
  'unknown',
];

function fileKindLabel(kind: FileKind): string {
  switch (kind) {
    case 'pdf':
      return m.file_kind_pdf();
    case 'doc':
      return m.file_kind_doc();
    case 'md':
      return m.file_kind_md();
    case 'image':
      return m.file_kind_image();
    case 'txt':
      return m.file_kind_txt();
    case 'sheet':
      return m.file_kind_sheet();
    case 'slides':
      return m.file_kind_slides();
    case 'audio':
      return m.file_kind_audio();
    case 'json':
      return m.file_kind_json();
    default:
      return m.file_kind_unknown();
  }
}

function ActiveFiles() {
  const sorts: SortOption<FileListSort>[] = [
    {
      icon: 'clock',
      label: m.files_sort_added(),
      order: 'time',
      value: 'added',
    },
    {
      icon: 'pencil',
      label: m.files_sort_name(),
      order: 'name',
      value: 'name',
    },
    {
      icon: 'files',
      label: m.files_sort_size(),
      order: 'count',
      value: 'size',
    },
    {
      icon: 'chapter',
      label: m.files_sort_kind(),
      order: 'name',
      value: 'kind',
    },
  ];
  const [sort, setSort] = useState<FileListSort>('added');
  const [ascending, setAscending] = useState(false);
  const [kinds, setKinds] = useState<string[]>([]);
  const [workspaceIds, setWorkspaceIds] = useState<string[]>([]);
  const params = useMemo<FileListParams>(
    () => ({
      dir: ascending ? 'asc' : 'desc',
      sort,
      ...(kinds.length ? { kinds: kinds as FileKind[] } : {}),
      ...(workspaceIds.length ? { workspaceIds } : {}),
    }),
    [ascending, kinds, sort, workspaceIds]
  );
  const {
    data,
    fetchNextPage,
    fetchStatus,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
  } = useOwnedFiles(params);
  const files = data?.pages.flatMap((page) => page.items) ?? [];
  const { data: workspaces = [] } = useWorkspaces(
    { sort: 'accessed' },
    { errorBoundary: false }
  );
  const revealRef = useLoadingReveal(isLoading);
  const [openFileId, setOpenFileId] = useState<string | null>(null);
  const [officeEditDirty, setOfficeEditDirty] = useState(false);
  const confirmViewerReplacement = useOfficeEditGuard(officeEditDirty);
  const open = files.find((file) => file.id === openFileId) ?? null;
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

  return (
    <>
      <ListToolbar
        ascending={ascending}
        filters={[
          {
            key: 'kind',
            label: m.files_filter_kind(),
            onToggle: (value) => setKinds((prev) => toggleValue(prev, value)),
            options: FILE_KINDS.map((kind) => ({
              label: fileKindLabel(kind),
              value: kind,
            })),
            selected: kinds,
          },
          {
            emptyLabel: m.create_filter_no_workspaces(),
            key: 'workspace',
            label: m.files_filter_workspace(),
            onToggle: (value) =>
              setWorkspaceIds((prev) => toggleValue(prev, value)),
            options: workspaces
              .filter((ws) => ws.isOwner)
              .map((ws) => ({ label: ws.name, value: ws.id })),
            selected: workspaceIds,
          },
        ]}
        onResetFilters={() => {
          setKinds([]);
          setWorkspaceIds([]);
        }}
        onSortChange={(next, asc) => {
          setSort(next);
          setAscending(asc);
        }}
        sort={sort}
        sorts={sorts}
      />
      <div className="min-h-0 flex-1 overflow-auto px-6 pt-2 pb-5">
        {fetchStatus === 'paused' && !data ? (
          <QueryPausedState />
        ) : isLoading ? (
          <SkeletonCardGrid cardHeight={72} count={6} />
        ) : files.length === 0 ? (
          <p className="py-10 text-center text-fg-muted">{m.files_empty()}</p>
        ) : (
          <div className="flex flex-col gap-3" ref={revealRef}>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {files.map((f) => (
                <Card
                  className="flex items-center gap-3 p-5.5"
                  interactive
                  key={f.id}
                  onClick={() => openFile(f.id)}
                  radius="card-lg"
                >
                  <span className="flex h-10 w-10 items-center justify-center rounded-card bg-surface-hover-bg text-fg-secondary">
                    <FileIcon className="size-4.5" name={fileIconName(f)} />
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
            {hasNextPage && (
              <Button
                className="self-center"
                disabled={isFetchingNextPage}
                onClick={() => fetchNextPage()}
                size="sm"
                variant="ghost-hover"
              >
                {m.list_load_more()}
              </Button>
            )}
          </div>
        )}
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

import { useMemo, useState } from 'react';
import {
  useDeleteOwnedFile,
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
  SourceFile,
  TrashItem,
} from '@/api/types';
import {
  ListToolbar,
  type ListView,
  ListViewToggle,
  type SortOption,
  toggleValue,
} from '@/components/app/ListToolbar';
import { PageHeader, PanelWithInvertedRadius } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog, SimpleDialog } from '@/components/ui/Dialog';
import { FileIcon } from '@/components/ui/FileIcon';
import { SkeletonCardGrid } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { Menu } from '@/components/ui/Menu';
import { Tabs } from '@/components/ui/Tabs';
import {
  FileSelectionActions,
  FileSelectionMark,
} from '@/features/files/FileSelectionActions';
import {
  FileError,
  FileLoading,
  FileNotIndexedBanner,
} from '@/features/files/FileStates';
import { FileViewer } from '@/features/files/FileViewer';
import { formatFileSize } from '@/features/files/fileUtils';
import {
  collectSelectionPages,
  useFileSelection,
} from '@/features/files/useFileSelection';
import { useOfficeEditGuard } from '@/features/files/useOfficeEditGuard';
import { relativeTime } from '@/features/materials/MaterialListCard';
import { getLocale, m } from '@/i18n';
import { cn } from '@/lib/cn';
import { fileIconName, materialIconName } from '@/lib/fileIcons';
import { useLoadingReveal } from '@/lib/useLoadingReveal';

type FilesTab = 'files' | 'trash';
const VIEW_KEY = 'capy.files.view';

function readView(): ListView {
  try {
    return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}

export default function Files() {
  const [tab, setTab] = useState<FilesTab>('files');
  const [view, setView] = useState<ListView>(readView);
  const [busy, setBusy] = useState(false);

  function changeView(next: ListView) {
    setView(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      // per-viewer convenience only
    }
  }

  return (
    <PanelWithInvertedRadius>
      <PageHeader title={m.nav_files()} />
      <fieldset className="min-w-0" disabled={busy}>
        <Tabs
          className="px-6"
          onChange={(value) => setTab(value as FilesTab)}
          tabs={[
            { label: m.files_tab_files(), value: 'files' },
            { label: m.files_tab_trash(), value: 'trash' },
          ]}
          value={tab}
        />
      </fieldset>
      {tab === 'trash' ? (
        <TrashTab
          onBusyChange={setBusy}
          onViewChange={changeView}
          view={view}
        />
      ) : (
        <ActiveFiles
          onBusyChange={setBusy}
          onViewChange={changeView}
          view={view}
        />
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

function ActiveFiles({
  view,
  onViewChange,
  onBusyChange,
}: {
  view: ListView;
  onViewChange: (view: ListView) => void;
  onBusyChange: (busy: boolean) => void;
}) {
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
  const selection = useFileSelection(
    files,
    (file) => file.id,
    () =>
      collectSelectionPages(data?.pages ?? [], () =>
        fetchNextPage({ throwOnError: true })
      ),
    onBusyChange
  );
  const { mutateAsync: deleteFile } = useDeleteOwnedFile();
  const [deleteTargets, setDeleteTargets] = useState<SourceFile[] | null>(null);
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
        action={
          <>
            {selection.selecting && (
              <Button
                className="px-1.5"
                disabled={
                  selection.busy ||
                  isFetchingNextPage ||
                  selection.selected.length === 0
                }
                iconLeft="trash"
                onClick={() => setDeleteTargets([...selection.selected])}
                size="sm"
                variant="danger-light"
              >
                {m.action_delete()}
              </Button>
            )}
            <Button
              className="px-1.5"
              disabled={
                selection.busy || (!selection.selecting && files.length === 0)
              }
              iconLeft={selection.selecting ? 'x' : 'check'}
              onClick={selection.selecting ? selection.exit : selection.start}
              size="sm"
              variant="ghost-hover"
            >
              {selection.selecting ? m.action_cancel() : m.files_select()}
            </Button>
          </>
        }
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
        onViewChange={onViewChange}
        selectionActions={
          selection.selecting ? (
            <FileSelectionActions
              allSelected={
                !hasNextPage &&
                files.length > 0 &&
                selection.selected.length === files.length
              }
              busy={selection.busy || isFetchingNextPage}
              count={selection.selected.length}
              onClear={selection.clear}
              onSelectAll={() => void selection.selectAll()}
            />
          ) : undefined
        }
        sort={sort}
        sorts={sorts}
        view={view}
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
            {view === 'grid' ? (
              <div className="grid w-full grid-cols-[repeat(auto-fill,minmax(min(100%,250px),1fr))] gap-3">
                {files.map((file) => (
                  <ActiveFileCard
                    busy={selection.busy}
                    file={file}
                    key={file.id}
                    onOpen={() =>
                      selection.selecting
                        ? selection.toggle(file)
                        : openFile(file.id)
                    }
                    selected={selection.isSelected(file)}
                    selecting={selection.selecting}
                    view="grid"
                    workspaceName={
                      workspaces.find(
                        (workspace) => workspace.id === file.workspaceId
                      )?.name ?? ''
                    }
                  />
                ))}
              </div>
            ) : (
              <div className="overflow-hidden rounded-card border border-line">
                <div className="hidden bg-surface-hover-bg px-4 py-2.5 font-bold text-fg-muted text-xs uppercase tracking-wide md:grid md:grid-cols-[minmax(200px,2.4fr)_minmax(160px,2fr)_1.5fr_1fr] md:gap-3">
                  <div>{m.list_col_name()}</div>
                  <div>{m.create_filter_workspace()}</div>
                  <div>{m.list_col_details()}</div>
                  <div>{m.files_sort_added()}</div>
                </div>
                {files.map((file) => (
                  <ActiveFileCard
                    busy={selection.busy}
                    file={file}
                    key={file.id}
                    onOpen={() =>
                      selection.selecting
                        ? selection.toggle(file)
                        : openFile(file.id)
                    }
                    selected={selection.isSelected(file)}
                    selecting={selection.selecting}
                    view="list"
                    workspaceName={
                      workspaces.find(
                        (workspace) => workspace.id === file.workspaceId
                      )?.name ?? ''
                    }
                  />
                ))}
              </div>
            )}
            {hasNextPage && (
              <Button
                className="self-center"
                disabled={isFetchingNextPage || selection.busy}
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
      <ConfirmDialog
        body={m.files_delete_selected_body({
          count: deleteTargets?.length ?? 0,
        })}
        confirmLabel={m.action_delete()}
        onClose={() => setDeleteTargets(null)}
        onConfirm={() => {
          if (deleteTargets) void selection.run(deleteTargets, deleteFile);
        }}
        open={!!deleteTargets}
        title={m.files_delete_selected_title()}
      />
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

function ActiveFileCard({
  file,
  workspaceName,
  view,
  onOpen,
  selecting,
  selected,
  busy,
}: {
  file: SourceFile;
  workspaceName: string;
  view: ListView;
  onOpen: () => void;
  selecting: boolean;
  selected: boolean;
  busy: boolean;
}) {
  if (view === 'list') {
    return (
      <button
        aria-label={
          selecting ? m.files_select_item({ name: file.name }) : undefined
        }
        aria-pressed={selecting ? selected : undefined}
        className={cn(
          'grid w-full grid-cols-1 gap-1 border-divider border-t px-4 py-2.5 text-left hover:bg-surface-hover-bg md:grid-cols-[minmax(200px,2.4fr)_minmax(160px,2fr)_1.5fr_1fr] md:items-center md:gap-3',
          selecting && selected && 'bg-surface-hover-bg'
        )}
        disabled={busy}
        onClick={onOpen}
        type="button"
      >
        <span className="flex min-w-0 items-center gap-3.5">
          {selecting && <FileSelectionMark selected={selected} />}
          <FileIcon
            className="size-4 -translate-y-px"
            name={fileIconName(file)}
          />
          <span className="truncate font-bold">{file.name}</span>
        </span>
        <span className="truncate text-fg-secondary text-sm">
          {workspaceName}
        </span>
        <span className="text-fg-muted text-sm">
          {formatFileSize(file.sizeBytes)}
        </span>
        <span className="text-fg-muted text-sm">
          {relativeTime(file.addedAt)}
        </span>
      </button>
    );
  }

  return (
    <Card
      asChild
      border="solid"
      className={cn(
        'relative gap-3 p-4.5 text-left leading-tight xl:p-5.5',
        selecting && selected && 'ring-2 ring-accent'
      )}
      interactive
    >
      <button
        aria-label={
          selecting ? m.files_select_item({ name: file.name }) : undefined
        }
        aria-pressed={selecting ? selected : undefined}
        disabled={busy}
        onClick={onOpen}
        type="button"
      >
        {selecting && (
          <span className="absolute top-3 right-3">
            <FileSelectionMark selected={selected} />
          </span>
        )}
        <FileIcon className="size-5" name={fileIconName(file)} />
        <span className="flex flex-1 flex-col gap-1">
          <span className="t-subtitle line-clamp-2">{file.name}</span>
          <span className="mt-1 flex min-w-0 items-center gap-1 text-fg-secondary text-xs">
            <Icon
              className="shrink-0 -translate-y-px text-fg-muted"
              name="workspaces"
              size={12}
            />
            <span className="truncate">
              {workspaceName} · {formatFileSize(file.sizeBytes)}
            </span>
          </span>
          <span className="t-meta text-fg-muted">
            {relativeTime(file.addedAt)}
          </span>
        </span>
      </button>
    </Card>
  );
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium' }).format(
    new Date(iso)
  );
}

/** Owner-only bin. Rows are metadata only: a trashed row is never a preview
 * or a download. Restore and permanent deletion are the only actions. */
function TrashTab({
  view,
  onViewChange,
  onBusyChange,
}: {
  view: ListView;
  onViewChange: (view: ListView) => void;
  onBusyChange: (busy: boolean) => void;
}) {
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
  const { mutateAsync: restore } = useRestoreTrashed();
  const { mutateAsync: purge } = usePurgeTrashed();
  const [purgeRequest, setPurgeRequest] = useState<{
    items: TrashItem[];
    empty: boolean;
  } | null>(null);
  const items = data?.pages.flatMap((page) => page.items) ?? [];
  const selection = useFileSelection(
    items,
    (item) => `${item.kind}:${item.id}:${item.episodeId}`,
    () =>
      collectSelectionPages(data?.pages ?? [], () =>
        fetchNextPage({ throwOnError: true })
      ),
    onBusyChange
  );

  async function prepareEmptyTrash() {
    selection.start();
    const all = await selection.selectAll();
    if (all?.length) setPurgeRequest({ empty: true, items: all });
  }

  if (fetchStatus === 'paused' && !data) return <QueryPausedState />;
  if (isLoading)
    return (
      <SkeletonCardGrid cardHeight={view === 'grid' ? 150 : 72} count={3} />
    );
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
    <>
      <div className="-mb-3 flex flex-wrap items-center justify-between gap-x-3 px-6">
        {selection.selecting ? (
          <FileSelectionActions
            allSelected={
              !hasNextPage &&
              items.length > 0 &&
              selection.selected.length === items.length
            }
            busy={selection.busy || isFetchingNextPage}
            count={selection.selected.length}
            onClear={selection.clear}
            onRestore={() =>
              void selection.run([...selection.selected], restore)
            }
            onSelectAll={() => void selection.selectAll()}
          />
        ) : (
          <div aria-hidden className="h-11.5" />
        )}
        <div className="flex flex-wrap items-center gap-1">
          {!selection.selecting && (
            <Button
              className="px-1.5"
              disabled={
                selection.busy || isFetchingNextPage || items.length === 0
              }
              iconLeft="trash"
              onClick={() => void prepareEmptyTrash()}
              size="md"
              variant="danger-light"
            >
              {m.trash_empty_action()}
            </Button>
          )}
          {selection.selecting && (
            <Button
              className="px-1.5"
              disabled={
                selection.busy ||
                isFetchingNextPage ||
                selection.selected.length === 0
              }
              iconLeft="trash"
              onClick={() =>
                setPurgeRequest({
                  empty: false,
                  items: [...selection.selected],
                })
              }
              size="md"
              variant="danger-light"
            >
              {m.trash_delete_forever()}
            </Button>
          )}
          <Button
            className="px-1.5"
            disabled={
              selection.busy || (!selection.selecting && items.length === 0)
            }
            iconLeft={selection.selecting ? 'x' : 'check'}
            onClick={selection.selecting ? selection.exit : selection.start}
            size="md"
            variant="ghost-hover"
          >
            {selection.selecting ? m.action_cancel() : m.files_select()}
          </Button>
          <ListViewToggle onViewChange={onViewChange} view={view} />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-6 pt-2 pb-5">
        <div className="flex flex-col gap-3">
          <p className="t-meta text-fg-muted" role="note">
            {m.trash_notice()}
          </p>
          {items.length === 0 ? (
            <p className="text-fg-muted">{m.trash_empty()}</p>
          ) : null}
          {items.length > 0 &&
            (view === 'grid' ? (
              <div className="grid w-full grid-cols-[repeat(auto-fill,minmax(min(100%,250px),1fr))] gap-3">
                {items.map((item) => (
                  <TrashCard
                    busy={selection.busy}
                    item={item}
                    key={`${item.kind}:${item.id}:${item.episodeId}`}
                    onPurge={() =>
                      setPurgeRequest({ empty: false, items: [item] })
                    }
                    onRestore={() => void selection.run([item], restore)}
                    onSelect={() => selection.toggle(item)}
                    selected={selection.isSelected(item)}
                    selecting={selection.selecting}
                    view="grid"
                  />
                ))}
              </div>
            ) : (
              <div className="overflow-hidden rounded-card border border-line">
                <div className="hidden bg-surface-hover-bg px-4 py-2.5 font-bold text-fg-muted text-xs uppercase tracking-wide md:grid md:grid-cols-[minmax(200px,2.4fr)_minmax(160px,2fr)_1.5fr_1fr_40px] md:gap-3">
                  <div>{m.list_col_name()}</div>
                  <div>{m.create_filter_workspace()}</div>
                  <div>{m.list_col_details()}</div>
                  <div>{m.trash_expires({ date: '' }).trim()}</div>
                  <div />
                </div>
                {items.map((item) => (
                  <TrashCard
                    busy={selection.busy}
                    item={item}
                    key={`${item.kind}:${item.id}:${item.episodeId}`}
                    onPurge={() =>
                      setPurgeRequest({ empty: false, items: [item] })
                    }
                    onRestore={() => void selection.run([item], restore)}
                    onSelect={() => selection.toggle(item)}
                    selected={selection.isSelected(item)}
                    selecting={selection.selecting}
                    view="list"
                  />
                ))}
              </div>
            ))}
          {hasNextPage ? (
            <Button
              disabled={isFetchingNextPage || selection.busy}
              onClick={() => fetchNextPage()}
              size="sm"
              variant="ghost-hover"
            >
              {m.trash_load_more()}
            </Button>
          ) : null}
          <ConfirmDialog
            body={
              purgeRequest?.empty
                ? m.trash_empty_confirm_body({
                    count: purgeRequest.items.length,
                  })
                : purgeRequest?.items.length === 1
                  ? m.trash_delete_confirm_body({
                      name: purgeRequest.items[0].title,
                    })
                  : m.trash_delete_selected_body({
                      count: purgeRequest?.items.length ?? 0,
                    })
            }
            confirmLabel={m.trash_delete_forever()}
            onClose={() => setPurgeRequest(null)}
            onConfirm={() => {
              if (purgeRequest) void selection.run(purgeRequest.items, purge);
            }}
            open={!!purgeRequest}
            title={
              purgeRequest?.empty
                ? m.trash_empty_confirm_title()
                : m.trash_delete_confirm_title()
            }
          />
        </div>
      </div>
    </>
  );
}

function TrashCard({
  item,
  busy,
  view,
  onRestore,
  onPurge,
  selecting,
  selected,
  onSelect,
}: {
  item: TrashItem;
  busy: boolean;
  view: ListView;
  onRestore: () => void;
  onPurge: () => void;
  selecting: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const icon = trashIconName(item);
  const workspaceName = item.workspaceName || m.trash_standalone();
  const expires = formatDate(item.purgeAfter);
  const selectButton = selecting && (
    <button
      aria-label={m.files_select_item({ name: item.title })}
      aria-pressed={selected}
      className="absolute inset-0 z-10 rounded-[inherit] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-inset"
      disabled={busy}
      onClick={onSelect}
      type="button"
    />
  );
  const menu = (
    <Menu
      iconContainerClassName="p-0 size-fit"
      items={[
        {
          disabled: busy,
          icon: 'undo',
          label: m.trash_restore(),
          onClick: onRestore,
        },
        {
          danger: true,
          disabled: busy,
          icon: 'trash',
          label: m.trash_delete_forever(),
          onClick: onPurge,
        },
      ]}
    />
  );

  if (view === 'list') {
    return (
      <div
        className={cn(
          'relative grid grid-cols-1 gap-1 border-divider border-t px-4 py-2.5 md:grid-cols-[minmax(200px,2.4fr)_minmax(160px,2fr)_1.5fr_1fr_40px] md:items-center md:gap-3',
          selecting && selected && 'bg-surface-hover-bg'
        )}
      >
        {selectButton}
        <div className="flex min-w-0 items-center gap-3.5">
          {selecting && <FileSelectionMark selected={selected} />}
          <FileIcon className="size-4 -translate-y-px" name={icon} />
          <span className="truncate font-bold">{item.title}</span>
        </div>
        <span className="truncate text-fg-secondary text-sm">
          {workspaceName}
        </span>
        <span className="text-fg-muted text-sm">
          {formatFileSize(item.sizeBytes)}
        </span>
        <span className="text-fg-muted text-sm">{expires}</span>
        <div className="relative z-10 flex justify-self-end">
          {!selecting && menu}
        </div>
      </div>
    );
  }

  return (
    <Card
      border="solid"
      className={cn(
        'relative gap-3 p-4.5 leading-tight xl:p-5.5',
        selecting && selected && 'ring-2 ring-accent'
      )}
    >
      {selectButton}
      <FileIcon className="size-5" name={icon} />
      {selecting ? (
        <div className="absolute top-3 right-3">
          <FileSelectionMark selected={selected} />
        </div>
      ) : (
        <div className="absolute top-2 right-2">{menu}</div>
      )}
      <div className="flex flex-1 flex-col gap-1">
        <p className="t-subtitle line-clamp-2">{item.title}</p>
        <p className="mt-1 flex min-w-0 items-center gap-1 text-fg-secondary text-xs">
          <Icon
            className="shrink-0 -translate-y-px text-fg-muted"
            name="workspaces"
            size={12}
          />
          <span className="truncate">
            {workspaceName} · {formatFileSize(item.sizeBytes)}
          </span>
        </p>
        <p className="t-meta text-fg-muted">{expires}</p>
      </div>
    </Card>
  );
}

function trashIconName(item: TrashItem) {
  if (item.kind === 'material') {
    switch (item.materialKind) {
      case 'quiz':
        return materialIconName('quiz');
      case 'flashcards':
        return materialIconName('flashcards');
      case 'mindmap':
        return materialIconName('mindmap');
      case 'diagram':
        return materialIconName('diagram');
      default:
        return materialIconName('note');
    }
  }
  const kind = FILE_KINDS.find((value) => value === item.fileKind) ?? 'unknown';
  return fileIconName({ kind, name: item.title });
}

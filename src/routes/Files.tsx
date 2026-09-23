import { useMemo, useState } from 'react';
import {
  useDeleteOwnedFile,
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
import { ItemCard, ItemList } from '@/components/app/ItemCard';
import {
  ListToolbar,
  type ListView,
  ListViewToggle,
  type SortOption,
  toggleValue,
} from '@/components/app/ListToolbar';
import { PageHeader, PanelWithInvertedRadius } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { Button, ErrorAction } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { SkeletonCardGrid } from '@/components/ui/feedback';
import { Menu } from '@/components/ui/Menu';
import { Tabs } from '@/components/ui/Tabs';
import { FileSelectionActions } from '@/features/files/FileSelectionActions';
import { formatFileSize } from '@/features/files/fileUtils';
import {
  collectSelectionPages,
  useFileSelection,
} from '@/features/files/useFileSelection';
import { relativeTime } from '@/features/materials/MaterialListCard';
import { ContentActions } from '@/features/workspace/ContentActions';
import { toFileActionTarget } from '@/features/workspace/contentActionTarget';
import { getLocale, m } from '@/i18n';
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
            <ItemList
              columns={[
                m.list_col_name(),
                m.create_filter_workspace(),
                m.list_col_details(),
                m.files_sort_added(),
              ]}
              view={view}
            >
              {files.map((file) => (
                <ItemCard
                  actions={
                    <ContentActions
                      chapters={[]}
                      content={toFileActionTarget(file)}
                      display="menu"
                      renameFieldLabel={m.files_file_name()}
                      renameTitle={m.files_rename()}
                      showMove={false}
                      workspaceId={file.workspaceId}
                    />
                  }
                  details={formatFileSize(file.sizeBytes)}
                  icon={fileIconName(file)}
                  key={file.id}
                  link={{ params: { fileId: file.id }, to: '/files/$fileId' }}
                  meta={relativeTime(file.addedAt)}
                  selection={
                    selection.selecting
                      ? {
                          busy: selection.busy,
                          label: m.files_select_item({ name: file.name }),
                          onToggle: () => selection.toggle(file),
                          selected: selection.isSelected(file),
                        }
                      : undefined
                  }
                  title={file.name}
                  view={view}
                  workspace={
                    workspaces.find(
                      (workspace) => workspace.id === file.workspaceId
                    )?.name ?? ''
                  }
                />
              ))}
            </ItemList>
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
        <ErrorAction
          iconLeftClassName="me-1"
          onClick={() => refetch()}
          size="sm"
        >
          {m.trash_retry()}
        </ErrorAction>
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
          {items.length > 0 && (
            <ItemList
              columns={[
                m.list_col_name(),
                m.create_filter_workspace(),
                m.list_col_details(),
                m.trash_expires({ date: '' }).trim(),
              ]}
              view={view}
            >
              {items.map((item) => (
                <ItemCard
                  actions={
                    <Menu
                      items={[
                        {
                          disabled: selection.busy,
                          icon: 'undo',
                          label: m.trash_restore(),
                          onClick: () => void selection.run([item], restore),
                        },
                        {
                          danger: true,
                          disabled: selection.busy,
                          icon: 'trash',
                          label: m.trash_delete_forever(),
                          onClick: () =>
                            setPurgeRequest({ empty: false, items: [item] }),
                        },
                      ]}
                    />
                  }
                  details={formatFileSize(item.sizeBytes)}
                  icon={trashIconName(item)}
                  key={`${item.kind}:${item.id}:${item.episodeId}`}
                  meta={formatDate(item.purgeAfter)}
                  selection={
                    selection.selecting
                      ? {
                          busy: selection.busy,
                          label: m.files_select_item({ name: item.title }),
                          onToggle: () => selection.toggle(item),
                          selected: selection.isSelected(item),
                        }
                      : undefined
                  }
                  title={item.title}
                  view={view}
                  workspace={item.workspaceName || m.trash_standalone()}
                />
              ))}
            </ItemList>
          )}
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

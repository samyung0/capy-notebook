import { useNavigate, useSearch } from '@tanstack/react-router';
import { memo, useCallback, useContext, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMediaQuery } from 'usehooks-ts';
import {
  useDeleteOwnedFile,
  useOwnedFiles,
  usePurgeTrashed,
  useRestoreTrashed,
  useRetryFileProcessing,
  useRetryingFileIds,
  useTrash,
  useWorkspaces,
} from '@/api/hooks';
import type {
  FileKind,
  FileListLocation,
  FileListSort,
  SourceFile,
  TrashItem,
  Workspace,
} from '@/api/types';
import { ErrorState } from '@/components/app/ErrorState';
import {
  ItemCard,
  ItemList,
  ItemPick,
  ItemSkeletonGrid,
  itemMenuIcon,
} from '@/components/app/ItemCard';
import { ListEnd } from '@/components/app/ListEnd';
import {
  ListToolbar,
  type ListView,
  ListViewToggle,
  type SortOption,
  toggleValue,
  useListView,
} from '@/components/app/ListToolbar';
import { PageBody, PageHeader, PagePanel } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import type { ColumnSort } from '@/components/app/SortHeader';
import { Button, ErrorAction } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { SkeletonCardGrid } from '@/components/ui/feedback';
import { Menu } from '@/components/ui/Menu';
import { Tabs } from '@/components/ui/Tabs';
import { AddFileDestinationDialog } from '@/features/files/AddFileDestinationDialog';
import { EmbedsTab } from '@/features/files/EmbedsTab';
import { fileKindLabel } from '@/features/files/fileKindLabel';
import { formatFileSize } from '@/features/files/fileUtils';
import { toastLostAccess } from '@/features/files/lostAccess';
import {
  clearOnBlank,
  SelectionAction,
  SelectionBar,
} from '@/features/files/SelectionBar';
import {
  collectSelectionPages,
  useFileSelection,
} from '@/features/files/useFileSelection';
import {
  cardCountLabel,
  questionCountLabel,
} from '@/features/materials/countLabels';
import { relativeTime } from '@/features/materials/MaterialListCard';
import { locationLabel, MaterialsTab } from '@/features/materials/MaterialsTab';
import {
  AddSourceDialog,
  resumedConnect,
} from '@/features/workspace/AddSourceDialog';
import { ContentActions } from '@/features/workspace/ContentActions';
import { toFileActionTarget } from '@/features/workspace/contentActionTarget';
import {
  type RetryProcessing,
  retryFailedFile,
} from '@/features/workspace/retryProcessing';
import {
  AccountStatusButton,
  useAccountFrozen,
} from '@/features/workspace/WorkspaceHealth';
import { getLocale, m } from '@/i18n';
import { describeError } from '@/lib/errors';
import { fileIconName, materialIconName } from '@/lib/fileIcons';
import {
  csv,
  FILE_KINDS,
  FILE_SORT_DEFAULT,
  type FilesSearch,
  fileListParams,
  MATERIAL_LOCATIONS,
  sortSearch,
} from '@/lib/listSearch';
import { PREF_KEYS } from '@/lib/localPrefs';
import { waitsForConnection } from '@/lib/online';
import type { FilesTab } from '@/lib/tabSearch';
import { useLoadingReveal } from '@/lib/useLoadingReveal';

export default function Files() {
  const navigate = useNavigate();
  const { tab = 'files', access } = useSearch({ from: '/auth-shell/files' });
  const [view, changeView] = useListView(PREF_KEYS.filesView);
  const [busy, setBusy] = useState(false);
  const [headerSlot, setHeaderSlot] = useState<HTMLDivElement | null>(null);

  return (
    <PagePanel
      header={
        <PageHeader
          actions={
            <>
              <AccountStatusButton />
              {/* Blocks' New block and Files' Add file move here on phones,
                  so the toolbar keeps one row. */}
              <div className="sm:hidden" ref={setHeaderSlot} />
            </>
          }
          className="justify-between"
          title={m.nav_files()}
        />
      }
    >
      <fieldset className="min-w-0" disabled={busy}>
        <Tabs
          className="page-tabs-px"
          onChange={(value) => {
            void navigate({
              replace: true,
              search: value === 'files' ? {} : { tab: value as FilesTab },
              to: '/files',
            });
          }}
          tabs={[
            { label: m.files_tab_files(), value: 'files' },
            { label: m.files_tab_blocks(), value: 'blocks' },
            { label: m.files_tab_embeds(), value: 'embeds' },
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
      ) : tab === 'embeds' ? (
        <EmbedsTab
          access={access}
          onAccessChange={(next) =>
            void navigate({
              replace: true,
              search: { access: next, tab: 'embeds' },
              to: '/files',
            })
          }
          onViewChange={changeView}
          view={view}
        />
      ) : tab === 'blocks' ? (
        <MaterialsTab
          headerSlot={headerSlot}
          onBusyChange={setBusy}
          onViewChange={changeView}
          view={view}
        />
      ) : (
        <ActiveFiles
          headerSlot={headerSlot}
          onBusyChange={setBusy}
          onViewChange={changeView}
          view={view}
        />
      )}
    </PagePanel>
  );
}

function ActiveFiles({
  headerSlot,
  view,
  onViewChange,
  onBusyChange,
}: {
  /** Where Add file goes on phones (beside the page title). */
  headerSlot: HTMLElement | null;
  view: ListView;
  onViewChange: (view: ListView) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const phone = !useMediaQuery('(min-width: 640px)');
  const sorts: SortOption<FileListSort>[] = [
    {
      icon: 'clock',
      label: m.files_sort_newest(),
      value: 'added',
    },
    {
      icon: 'pencil',
      label: m.files_sort_name(),
      value: 'name',
    },
    {
      icon: 'files',
      label: m.files_sort_size(),
      value: 'size',
    },
    {
      icon: 'chapter',
      label: m.files_sort_kind(),
      value: 'kind',
    },
  ];
  // Sort and filters live in the URL; picks replace the entry.
  const search = useSearch({ from: '/auth-shell/files' });
  const navigate = useNavigate({ from: '/files' });
  const setSearch = (patch: FilesSearch) =>
    void navigate({ replace: true, search: (prev) => ({ ...prev, ...patch }) });
  const params = useMemo(() => fileListParams(search), [search]);
  const { sort = FILE_SORT_DEFAULT, kinds = [], workspaceIds = [] } = params;
  const location = search.location;
  const sorting: ColumnSort<FileListSort> = {
    ascending: params.dir === 'asc',
    ascendingFirst: ['name', 'workspace', 'kind'],
    onSortChange: (next, asc) =>
      setSearch(sortSearch('files', next, asc, FILE_SORT_DEFAULT)),
    sort,
  };
  const {
    data,
    fetchNextPage,
    fetchStatus,
    hasNextPage,
    isFetchNextPageError,
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
  // A standalone file's Retry processing, one mutation for the whole list.
  const { mutateAsync: retryStandalone } = useRetryFileProcessing(null);
  const retryingIds = useRetryingFileIds(null);

  // Add file: the destination chooser, then the Add file dialog aimed at the
  // pick. A drive connected for No workspace comes back here on Import.
  const frozen = useAccountFrozen();
  const [choosing, setChoosing] = useState(false);
  const [resumeProvider] = useState(() => resumedConnect(null));
  const [adding, setAdding] = useState<{
    resume: boolean;
    workspaceId: string | null;
  } | null>(resumeProvider ? { resume: true, workspaceId: null } : null);
  const addFile = (
    <Button
      className="px-1.5 font-bold text-link"
      disabled={frozen}
      iconLeft="plus"
      onClick={() => setChoosing(true)}
      size="sm"
      variant="ghost-hover"
    >
      {m.action_add_file()}
    </Button>
  );
  const addFileInHeader = phone && !!headerSlot;

  return (
    <>
      {addFileInHeader && createPortal(addFile, headerSlot)}
      <ListToolbar
        action={addFileInHeader ? undefined : addFile}
        filters={[
          {
            key: 'kind',
            label: m.files_filter_kind(),
            onToggle: (value) =>
              setSearch({ kind: csv(toggleValue(kinds, value)) }),
            options: FILE_KINDS.map((kind) => ({
              label: fileKindLabel(kind),
              value: kind,
            })),
            selected: kinds,
          },
          {
            key: 'location',
            label: m.create_filter_location(),
            onToggle: (value) =>
              setSearch({
                location:
                  location === value ? undefined : (value as FileListLocation),
              }),
            options: MATERIAL_LOCATIONS.map((value) => ({
              label: locationLabel(value),
              value,
            })),
            selected: location ? [location] : [],
          },
          {
            emptyLabel: m.create_filter_no_workspaces(),
            key: 'workspace',
            label: m.files_filter_workspace(),
            onToggle: (value) =>
              setSearch({ workspace: csv(toggleValue(workspaceIds, value)) }),
            options: workspaces
              .filter((ws) => ws.isOwner)
              .map((ws) => ({ label: ws.name, value: ws.id })),
            selected: workspaceIds,
          },
        ]}
        onResetFilters={() =>
          setSearch({
            kind: undefined,
            location: undefined,
            workspace: undefined,
          })
        }
        onViewChange={onViewChange}
        selection={
          selection.selecting && (
            <SelectionBar
              allSelected={
                !hasNextPage && selection.selected.length === files.length
              }
              busy={selection.busy || isFetchingNextPage}
              count={selection.selected.length}
              onClear={selection.clear}
              onSelectAll={() => void selection.selectAll()}
            >
              <SelectionAction
                danger
                disabled={selection.busy || isFetchingNextPage}
                icon="trash"
                label={m.action_delete()}
                onClick={() => setDeleteTargets([...selection.selected])}
              />
            </SelectionBar>
          )
        }
        sortMenu={{ ...sorting, hiddenFromMd: view === 'list', sorts }}
        view={view}
        wide
      />
      {/* Mouse only: the selection bar's clear button is the keyboard way. */}
      <PageBody belowToolbar onClick={clearOnBlank(selection.clear)} wide>
        {waitsForConnection(fetchStatus, data) ? (
          <QueryPausedState />
        ) : isLoading ? (
          view === 'grid' ? (
            <ItemSkeletonGrid count={8} />
          ) : (
            <SkeletonCardGrid cardHeight={72} count={6} />
          )
        ) : files.length === 0 ? (
          <p className="py-10 text-center text-fg-muted">
            {kinds.length || workspaceIds.length || location
              ? m.files_empty()
              : m.files_none()}
          </p>
        ) : (
          <div className="flex flex-col gap-3" ref={revealRef}>
            <ItemPick.Provider value={selection.pickContext}>
              <ItemList
                columns={[
                  { label: m.list_col_name(), sort: 'name' },
                  { label: m.create_filter_workspace(), sort: 'workspace' },
                  { label: m.common_size(), sort: 'size' },
                  { label: m.files_sort_added(), sort: 'added' },
                ]}
                sorting={sorting}
                view={view}
              >
                {files.map((file) => (
                  <FileItem
                    file={file}
                    key={file.id}
                    onDelete={setDeleteTargets}
                    retry={retryStandalone}
                    retryPending={retryingIds.includes(file.id)}
                    selected={selection.isSelected(file)}
                    view={view}
                    workspace={workspaces.find(
                      (workspace) => workspace.id === file.workspaceId
                    )}
                  />
                ))}
              </ItemList>
            </ItemPick.Provider>
            <ListEnd
              fetchNextPage={fetchNextPage}
              hasNextPage={hasNextPage}
              isFetchingNextPage={isFetchingNextPage}
              isFetchNextPageError={isFetchNextPageError}
            />
          </div>
        )}
      </PageBody>
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
      {choosing && (
        <AddFileDestinationDialog
          onClose={() => setChoosing(false)}
          onPick={(workspaceId) => {
            setChoosing(false);
            setAdding({ resume: false, workspaceId });
          }}
        />
      )}
      {adding && (
        <AddSourceDialog
          initialMode={adding.resume ? 'import' : 'upload'}
          onClose={() => setAdding(null)}
          onOpenItem={(item) => {
            // The Create tab's file or block, in the workspace it went to.
            if (!adding.workspaceId) return;
            void navigate({
              params: { workspaceId: adding.workspaceId },
              search:
                item.kind === 'file'
                  ? { file: item.id }
                  : { material: item.id },
              to: '/workspaces/$workspaceId',
            });
          }}
          open
          resumeProvider={adding.resume ? resumeProvider : null}
          workspaceId={adding.workspaceId}
        />
      )}
    </>
  );
}

/** One file in the Files tab; memoised so a pick re-renders only the cards
 * whose selection changed. */
const FileItem = memo(function FileItem({
  file,
  onDelete,
  retry,
  retryPending,
  selected,
  view,
  workspace,
}: {
  file: SourceFile;
  /** A file in a workspace the viewer lost access to can only be deleted. */
  onDelete: (files: SourceFile[]) => void;
  /** Retry processing of a failed standalone file (its owner is the viewer). */
  retry: RetryProcessing;
  retryPending: boolean;
  selected: boolean;
  view: ListView;
  workspace?: Workspace;
}) {
  const busy = !!useContext(ItemPick)?.busy;
  // No workspace: the viewer's own file, never shared on its own.
  const standalone = !file.workspaceId;
  const [retrying, setRetrying] = useState(false);
  return (
    <>
      <ItemCard
        actions={
          file.lostAccess ? (
            <Menu
              items={[
                {
                  danger: true,
                  disabled: busy,
                  icon: 'trash',
                  label: m.action_delete(),
                  onClick: () => onDelete([file]),
                },
              ]}
              triggerIcon={itemMenuIcon(view)}
            />
          ) : (
            <ContentActions
              canClone={
                file.status === 'ready' && (standalone || !!workspace?.canClone)
              }
              // The Files page lists what the viewer pays for, which the
              // payer may always move.
              canMoveTo
              chapters={[]}
              content={toFileActionTarget(file)}
              display="menu"
              leadingItems={
                standalone && file.status === 'failed'
                  ? [
                      {
                        disabled: retryPending,
                        icon: 'refresh',
                        label: m.files_retry_processing(),
                        onClick: () =>
                          retryFailedFile(file, retry, () => setRetrying(true)),
                        warning: true,
                      },
                    ]
                  : []
              }
              menuAlign="end"
              menuTriggerIcon={itemMenuIcon(view)}
              renameFieldLabel={m.files_file_name()}
              renameTitle={m.files_rename()}
              showMove={false}
              workspaceId={file.workspaceId}
              workspaceName={workspace?.name ?? file.workspaceName}
            />
          )
        }
        details={formatFileSize(file.sizeBytes)}
        icon={fileIconName(file)}
        link={
          file.lostAccess
            ? undefined
            : { params: { fileId: file.id }, to: '/files/$fileId' }
        }
        meta={relativeTime(file.addedAt)}
        onOpen={file.lostAccess ? toastLostAccess : undefined}
        pickKey={file.id}
        selected={selected}
        thumbnail={{
          fileKind: file.kind,
          preview: file.preview,
          thumbnailUrl: file.thumbnailUrl,
        }}
        title={file.name}
        view={view}
        workspace={workspace?.name ?? file.workspaceName ?? ''}
        workspaceIconId={workspace?.iconId}
        workspaceLost={file.lostAccess}
      />
      {retrying && (
        <AddSourceDialog
          onClose={() => setRetrying(false)}
          open
          retryFile={file}
          workspaceId={null}
        />
      )}
    </>
  );
});

/** One trashed item; memoised like FileItem. */
const TrashCard = memo(function TrashCard({
  item,
  onPurge,
  onRestore,
  selected,
  view,
  workspaceIconId,
}: {
  item: TrashItem;
  onPurge: (item: TrashItem) => void;
  onRestore: (item: TrashItem) => void;
  selected: boolean;
  view: ListView;
  workspaceIconId?: string;
}) {
  const busy = !!useContext(ItemPick)?.busy;
  return (
    <ItemCard
      actions={
        <Menu
          items={[
            // Restoring needs edit access to its workspace.
            ...(item.canRestore
              ? [
                  {
                    disabled: busy,
                    icon: 'undo' as const,
                    label: m.trash_restore(),
                    onClick: () => onRestore(item),
                  },
                ]
              : []),
            {
              danger: true,
              disabled: busy,
              icon: 'trash',
              label: m.trash_delete_forever(),
              onClick: () => onPurge(item),
            },
          ]}
          triggerIcon={itemMenuIcon(view)}
        />
      }
      details={formatFileSize(item.sizeBytes)}
      icon={trashIconName(item)}
      meta={formatDate(item.purgeAfter)}
      pickKey={`${item.kind}:${item.id}:${item.episodeId}`}
      selected={selected}
      thumbnail={{
        fileKind: trashFileKind(item),
        pill: trashPill(item),
        preview: item.preview,
        thumbnailUrl: item.thumbnailUrl,
      }}
      title={item.title}
      view={view}
      workspace={item.workspaceName}
      workspaceIconId={workspaceIconId}
      workspaceLost={item.lostAccess}
    />
  );
});

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
    isFetchNextPageError,
    isFetchingNextPage,
    isLoading,
    refetch,
  } = useTrash(undefined, true);
  // Icons for the list's Workspace column; a deleted workspace has none.
  const { data: workspaces = [] } = useWorkspaces(
    { sort: 'accessed' },
    { errorBoundary: false }
  );
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

  const { run } = selection;
  const restoreOne = useCallback(
    (item: TrashItem) => void run([item], restore),
    [run, restore]
  );
  const purgeOne = useCallback(
    (item: TrashItem) => setPurgeRequest({ empty: false, items: [item] }),
    []
  );

  async function prepareEmptyTrash() {
    const all = await selection.selectAll();
    if (all?.length) setPurgeRequest({ empty: true, items: all });
  }

  if (waitsForConnection(fetchStatus, data)) return <QueryPausedState />;
  if (isError && !data) {
    return (
      <ErrorState
        {...describeError(error)}
        action={
          <ErrorAction onClick={() => refetch()}>{m.trash_retry()}</ErrorAction>
        }
        className="py-16"
        title={m.trash_load_failed()}
        variant="panel"
      />
    );
  }
  return (
    <>
      <div className="page-px-wide -mb-3 flex items-center">
        {selection.selecting ? (
          <SelectionBar
            allSelected={
              !hasNextPage && selection.selected.length === items.length
            }
            busy={selection.busy || isFetchingNextPage}
            count={selection.selected.length}
            onClear={selection.clear}
            onSelectAll={() => void selection.selectAll()}
          >
            <SelectionAction
              disabled={selection.busy || isFetchingNextPage}
              icon="undo"
              label={m.trash_restore()}
              onClick={() =>
                void selection.run(
                  // Restoring needs edit access to its workspace.
                  selection.selected.filter((item) => item.canRestore),
                  restore
                )
              }
            />
            <SelectionAction
              danger
              disabled={selection.busy || isFetchingNextPage}
              icon="trash"
              label={m.trash_delete_forever()}
              onClick={() =>
                setPurgeRequest({
                  empty: false,
                  items: [...selection.selected],
                })
              }
            />
          </SelectionBar>
        ) : (
          // -mr-1.5: the view toggle's icon on the gutter, as in ListToolbar.
          <div className="-mr-1.5 ml-auto flex min-h-10 items-center gap-1 sm:min-h-11.5">
            <Button
              className="px-1.5"
              disabled={
                selection.busy || isFetchingNextPage || items.length === 0
              }
              iconLeft="trash"
              onClick={() => void prepareEmptyTrash()}
              size="sm"
              variant="danger-light"
            >
              {m.trash_empty_action()}
            </Button>
            <ListViewToggle onViewChange={onViewChange} view={view} />
          </div>
        )}
      </div>
      {/* Mouse only: the selection bar's clear button is the keyboard way. */}
      <PageBody belowToolbar onClick={clearOnBlank(selection.clear)} wide>
        <div className="flex flex-col gap-3">
          <p className="t-meta text-fg-muted" role="note">
            {m.trash_notice()}
          </p>
          {/* The bar and notice render while loading, so the cards land
           * where the skeletons were. */}
          {isLoading ? (
            view === 'grid' ? (
              <ItemSkeletonGrid count={8} />
            ) : (
              <SkeletonCardGrid cardHeight={72} count={3} />
            )
          ) : items.length === 0 ? (
            <p className="text-fg-muted">{m.trash_empty()}</p>
          ) : (
            <ItemPick.Provider value={selection.pickContext}>
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
                  <TrashCard
                    item={item}
                    key={`${item.kind}:${item.id}:${item.episodeId}`}
                    onPurge={purgeOne}
                    onRestore={restoreOne}
                    selected={selection.isSelected(item)}
                    view={view}
                    workspaceIconId={
                      workspaces.find((ws) => ws.id === item.workspaceId)
                        ?.iconId
                    }
                  />
                ))}
              </ItemList>
            </ItemPick.Provider>
          )}
          <ListEnd
            fetchNextPage={fetchNextPage}
            hasNextPage={hasNextPage}
            isFetchingNextPage={isFetchingNextPage}
            isFetchNextPageError={isFetchNextPageError}
          />
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
      </PageBody>
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
  return fileIconName({
    kind: trashFileKind(item) ?? 'unknown',
    name: item.title,
  });
}

/** Trash rows carry no counts of their own; a trashed quiz or set's preview
 * does. */
function trashPill(item: TrashItem): string | undefined {
  const { preview } = item;
  if (preview && 'kind' in preview) {
    if (preview.kind === 'quiz')
      return questionCountLabel(preview.questionCount);
    if (preview.kind === 'flashcards') return cardCountLabel(preview.cardCount);
  }
}

function trashFileKind(item: TrashItem): FileKind | undefined {
  if (item.kind === 'material') return;
  return FILE_KINDS.find((value) => value === item.fileKind) ?? 'unknown';
}

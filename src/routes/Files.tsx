import { useNavigate, useSearch } from '@tanstack/react-router';
import { memo, useCallback, useContext, useState } from 'react';
import {
  usePurgeTrashed,
  useRestoreTrashed,
  useTrash,
  useWorkspaces,
} from '@/api/hooks';
import type { FileKind, TrashItem } from '@/api/types';
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
  type ListView,
  ListViewToggle,
  useListView,
} from '@/components/app/ListToolbar';
import { PageBody, PageHeader, PagePanel } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { Button, ErrorAction } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { SkeletonCardGrid } from '@/components/ui/feedback';
import { Menu } from '@/components/ui/Menu';
import { Tabs } from '@/components/ui/Tabs';
import { CanvasTab } from '@/features/files/CanvasTab';
import { formatFileSize } from '@/features/files/fileUtils';
import { ItemsList } from '@/features/files/ItemsList';
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
import { AccountStatusButton } from '@/features/workspace/WorkspaceHealth';
import { getLocale, m } from '@/i18n';
import { describeError } from '@/lib/errors';
import { fileIconName, materialIconName } from '@/lib/fileIcons';
import { FILE_KINDS } from '@/lib/listSearch';
import { PREF_KEYS } from '@/lib/localPrefs';
import { waitsForConnection } from '@/lib/online';
import type { FilesTab } from '@/lib/tabSearch';

export default function Files() {
  const navigate = useNavigate();
  const { tab = 'files' } = useSearch({ from: '/auth-shell/files' });
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
              {/* Add file and New block move here on phones, so the toolbar
                  keeps one row. */}
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
            { label: m.files_tab_canvas(), value: 'canvas' },
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
      ) : tab === 'canvas' ? (
        <CanvasTab onViewChange={changeView} view={view} />
      ) : (
        <ItemsList
          headerSlot={headerSlot}
          onBusyChange={setBusy}
          onViewChange={changeView}
          view={view}
        />
      )}
    </PagePanel>
  );
}

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
      <div className="page-px -mb-3 flex items-center">
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
      <PageBody belowToolbar onClick={clearOnBlank(selection.clear)}>
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

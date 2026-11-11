import { useNavigate, useSearch } from '@tanstack/react-router';
import { useCallback, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMediaQuery } from 'usehooks-ts';
import {
  useDeleteEditorAsset,
  useDeleteOwnedFile,
  useDeleteOwnedMaterial,
  useDeletePaper,
  useItems,
  useRetryFileProcessing,
  useRetryingFileIds,
  useWorkspaces,
} from '@/api/hooks';
import type {
  EditorAssetItem,
  FileKind,
  Item,
  ItemListSort,
  SourceFile,
  SubmittedPaper,
} from '@/api/types';
import {
  ItemList,
  ItemPick,
  ItemSkeletonGrid,
} from '@/components/app/ItemCard';
import { ListEnd } from '@/components/app/ListEnd';
import {
  ListToolbar,
  type ListView,
  type SortOption,
  toggleValue,
} from '@/components/app/ListToolbar';
import { PageBody } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import type { ColumnSort } from '@/components/app/SortHeader';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { SkeletonCardGrid } from '@/components/ui/feedback';
import { Menu } from '@/components/ui/Menu';
import { AddFileDestinationDialog } from '@/features/files/AddFileDestinationDialog';
import { EmbedItem } from '@/features/files/EmbedItem';
import { canDeleteFile, FileItem } from '@/features/files/FileItem';
import { fileKindLabel } from '@/features/files/fileKindLabel';
import {
  clearOnBlank,
  SelectionAction,
  SelectionBar,
} from '@/features/files/SelectionBar';
import { SubmissionItem } from '@/features/files/SubmissionItem';
import {
  collectSelectionPages,
  useFileSelection,
} from '@/features/files/useFileSelection';
import {
  MaterialCard,
  materialKindLabel,
} from '@/features/materials/MaterialListCard';
import {
  blockLink,
  useBlockActions,
} from '@/features/materials/useBlockActions';
import { resumedConnect } from '@/features/workspace/connectResume';
import {
  AddSourceDialog,
  addSourceIntent,
} from '@/features/workspace/LazyAddSourceDialog';
import { m } from '@/i18n';
import {
  csv,
  FILE_KINDS,
  type FilesSearch,
  ITEM_KINDS,
  ITEM_SORT_DEFAULT,
  itemListParams,
  sortSearch,
} from '@/lib/listSearch';
import { waitsForConnection } from '@/lib/online';
import { useLoadingReveal } from '@/lib/useLoadingReveal';

function itemId(item: Item): string {
  switch (item.type) {
    case 'file':
      return item.file.id;
    case 'submission':
      return item.submission.id;
    case 'material':
      return item.material.id;
    case 'embed':
      return item.embed.assetId;
  }
}
/** Ids repeat across tables, so a row's key names its type too. */
const keyOf = (item: Item) => `${item.type}:${itemId(item)}`;

/** Files and blocks go to the trash; embeds and submissions go for good. */
const goesToTrash = (item: Item) =>
  item.type === 'file' || item.type === 'material';

/** A deletion's confirmation: one embed or submission by name, else whether
 * everything goes to the trash. */
export function deleteCopy(targets: Item[]): { title: string; body: string } {
  const [only] = targets;
  if (targets.length === 1 && only.type === 'embed')
    return {
      body: m.files_lost_media_delete_body({ name: only.embed.name }),
      title: m.trash_delete_confirm_title(),
    };
  if (targets.length === 1 && only.type === 'submission')
    return {
      body: m.submissions_delete_body({ name: only.submission.name }),
      title: m.submissions_delete_title(),
    };
  if (targets.every(goesToTrash))
    return {
      body: m.files_delete_selected_body({ count: targets.length }),
      title: m.files_delete_selected_title(),
    };
  return {
    body: m.files_delete_mixed_body({ count: targets.length }),
    title: m.files_delete_mixed_title(),
  };
}

/** What a selection may delete: a file its rights let it trash, a block it
 * owns or lost access to, and every embed and submission (its own). */
function canDelete(item: Item): boolean {
  switch (item.type) {
    case 'file':
      return canDeleteFile(item.file);
    case 'material':
      return !!item.material.isOwner || !!item.material.lostAccess;
    default:
      return true;
  }
}

/**
 * The Files page's one list (Epo 2026-11-09): to the user a file is any of
 * them, so uploaded files, handed-in submissions, notes, quizzes, flashcard
 * sets and the images and audio in notes page, sort and filter together. Add
 * file and New block start the two ways to make one.
 */
export function ItemsList({
  headerSlot,
  view,
  onViewChange,
  onBusyChange,
}: {
  /** Where Add file and New block go on phones (beside the page title). */
  headerSlot: HTMLElement | null;
  view: ListView;
  onViewChange: (view: ListView) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const phone = !useMediaQuery('(min-width: 640px)');
  const sorts: SortOption<ItemListSort>[] = [
    { icon: 'clock', label: m.files_sort_newest(), value: 'added' },
    { icon: 'pencil', label: m.files_sort_name(), value: 'name' },
    { icon: 'files', label: m.files_sort_size(), value: 'size' },
    { icon: 'topic', label: m.files_sort_kind(), value: 'kind' },
  ];
  // Sort and filters live in the URL; picks replace the entry.
  const search = useSearch({ from: '/auth-shell/files' });
  const navigate = useNavigate({ from: '/files' });
  const setSearch = (patch: FilesSearch) =>
    void navigate({ replace: true, search: (prev) => ({ ...prev, ...patch }) });
  const params = useMemo(() => itemListParams(search), [search]);
  const { sort = ITEM_SORT_DEFAULT, kinds = [], workspaceIds = [] } = params;
  const { location, owner } = search;
  const sorting: ColumnSort<ItemListSort> = {
    ascending: params.dir === 'asc',
    ascendingFirst: ['name', 'workspace', 'kind'],
    onSortChange: (next, asc) =>
      setSearch(sortSearch('files', next, asc, ITEM_SORT_DEFAULT)),
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
  } = useItems(params);
  const items = data?.pages.flatMap((page) => page.items) ?? [];
  const selection = useFileSelection(
    items,
    keyOf,
    () =>
      collectSelectionPages(data?.pages ?? [], () =>
        fetchNextPage({ throwOnError: true })
      ),
    onBusyChange
  );
  const { data: workspaces = [] } = useWorkspaces(
    { sort: 'accessed' },
    { errorBoundary: false }
  );
  const iconOf = (workspaceId?: string | null) =>
    workspaces.find((ws) => ws.id === workspaceId)?.iconId;
  const revealRef = useLoadingReveal(isLoading);
  // A standalone file's Retry processing, one mutation for the whole list.
  const { mutateAsync: retryStandalone } = useRetryFileProcessing(null);
  const retryingIds = useRetryingFileIds(null);

  // Deleting: one confirmation for a selection, its own for one embed or
  // submission (files and blocks confirm in their menus).
  const { mutateAsync: deleteFile } = useDeleteOwnedFile();
  const { mutateAsync: deleteMaterial } = useDeleteOwnedMaterial();
  const { mutateAsync: deleteEmbed } = useDeleteEditorAsset();
  const { mutateAsync: deletePaper } = useDeletePaper();
  const deleteItem = (item: Item): Promise<unknown> => {
    switch (item.type) {
      case 'file':
        return deleteFile(item.file);
      case 'material':
        return deleteMaterial(item.material);
      case 'embed':
        return deleteEmbed(item.embed.assetId);
      case 'submission':
        return deletePaper(item.submission.id);
    }
  };
  const [deleteTargets, setDeleteTargets] = useState<Item[] | null>(null);
  // Stable, so a pick re-renders only the cards whose selection changed.
  const deleteFileRows = useCallback(
    (files: SourceFile[]) =>
      setDeleteTargets(files.map((file) => ({ file, type: 'file' }))),
    []
  );
  const deleteEmbedRow = useCallback(
    (embed: EditorAssetItem) => setDeleteTargets([{ embed, type: 'embed' }]),
    []
  );
  const deleteSubmissionRow = useCallback(
    (submission: SubmittedPaper) =>
      setDeleteTargets([{ submission, type: 'submission' }]),
    []
  );
  const blocks = useBlockActions();

  // Add file: the destination chooser, then the Add file dialog aimed at the
  // pick. A drive connected for No workspace comes back here on Import.
  const [choosing, setChoosing] = useState(false);
  const [resumeProvider] = useState(() => resumedConnect(null));
  const [adding, setAdding] = useState<{
    resume: boolean;
    workspaceId: string | null;
  } | null>(resumeProvider ? { resume: true, workspaceId: null } : null);
  const actions = (
    <div className="flex items-center gap-1">
      <Button
        {...addSourceIntent}
        className="px-1.5 font-bold text-link"
        disabled={blocks.frozen}
        iconLeft="plus"
        onClick={() => setChoosing(true)}
        size="sm"
        variant="ghost-hover"
      >
        {m.action_add_file()}
      </Button>
      <Menu
        align="end"
        items={blocks.newMenu}
        trigger={
          <Button
            className="px-1.5 font-bold text-link"
            disabled={blocks.frozen}
            iconLeft="plus"
            size="sm"
            variant="ghost-hover"
          >
            {m.files_new_block()}
          </Button>
        }
      />
    </div>
  );
  const actionsInHeader = phone && !!headerSlot;

  return (
    <>
      {actionsInHeader && createPortal(actions, headerSlot)}
      <ListToolbar
        action={actionsInHeader ? undefined : actions}
        filters={[
          {
            defaultValue: 'mine',
            key: 'owner',
            label: m.files_filter_owner(),
            onToggle: (value) =>
              setSearch({ owner: value === 'all' ? 'all' : undefined }),
            options: [
              { label: m.files_owner_mine(), value: 'mine' },
              { label: m.files_owner_all(), value: 'all' },
            ],
            selected: [owner ?? 'mine'],
          },
          {
            key: 'kind',
            label: m.files_filter_kind(),
            onToggle: (value) =>
              setSearch({ kind: csv(toggleValue(kinds, value)) }),
            options: ITEM_KINDS.map((kind) => ({
              label: FILE_KINDS.includes(kind as FileKind)
                ? fileKindLabel(kind as FileKind)
                : materialKindLabel(kind as 'note' | 'quiz' | 'flashcards'),
              value: kind,
            })),
            selected: kinds,
          },
          // One switch (Epo 2026-10-30): off lists everything, on only what
          // sits in a workspace.
          {
            key: 'location',
            label: m.create_filter_location(),
            onToggle: () =>
              setSearch({
                location: location === 'workspace' ? undefined : 'workspace',
              }),
            options: [
              { label: m.files_location_workspace(), value: 'workspace' },
            ],
            selected: location === 'workspace' ? ['workspace'] : [],
          },
          {
            emptyLabel: m.create_filter_no_workspaces(),
            key: 'workspace',
            label: m.files_filter_workspace(),
            onToggle: (value) =>
              setSearch({ workspace: csv(toggleValue(workspaceIds, value)) }),
            // All files reaches member workspaces too.
            options: workspaces
              .filter((ws) => ws.isOwner || (owner === 'all' && !!ws.role))
              .map((ws) => ({ label: ws.name, value: ws.id })),
            selected: workspaceIds,
          },
        ]}
        onResetFilters={() =>
          setSearch({
            kind: undefined,
            location: undefined,
            owner: undefined,
            workspace: undefined,
          })
        }
        onViewChange={onViewChange}
        selection={
          selection.selecting && (
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
                danger
                disabled={selection.busy || isFetchingNextPage}
                icon="trash"
                label={m.action_delete()}
                // All files lists what the caller may only open or clone.
                onClick={() =>
                  setDeleteTargets(selection.selected.filter(canDelete))
                }
              />
            </SelectionBar>
          )
        }
        sortMenu={{ ...sorting, hiddenFromMd: view === 'list', sorts }}
        view={view}
      />
      {/* Mouse only: the selection bar's clear button is the keyboard way. */}
      <PageBody belowToolbar onClick={clearOnBlank(selection.clear)}>
        {waitsForConnection(fetchStatus, data) ? (
          <QueryPausedState />
        ) : isLoading ? (
          view === 'grid' ? (
            <ItemSkeletonGrid count={8} />
          ) : (
            <SkeletonCardGrid cardHeight={72} count={6} />
          )
        ) : items.length === 0 ? (
          <p className="py-10 text-center text-fg-muted">
            {kinds.length || workspaceIds.length || location || owner
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
                {items.map((item) => {
                  const key = keyOf(item);
                  const selected = selection.isSelected(item);
                  switch (item.type) {
                    case 'file':
                      return (
                        <FileItem
                          file={item.file}
                          key={key}
                          onDelete={deleteFileRows}
                          pickKey={key}
                          retry={retryStandalone}
                          retryPending={retryingIds.includes(item.file.id)}
                          selected={selected}
                          view={view}
                          workspace={workspaces.find(
                            (ws) => ws.id === item.file.workspaceId
                          )}
                        />
                      );
                    case 'material':
                      return (
                        <MaterialCard
                          item={item.material}
                          key={key}
                          linkFor={blockLink}
                          menuFor={blocks.menuFor}
                          pickKey={key}
                          selected={selected}
                          view={view}
                          workspaceIconId={iconOf(item.material.workspaceId)}
                        />
                      );
                    case 'embed':
                      return (
                        <EmbedItem
                          item={item.embed}
                          key={key}
                          onDelete={deleteEmbedRow}
                          pickKey={key}
                          selected={selected}
                          view={view}
                          workspaceIconId={iconOf(item.embed.workspaceId)}
                        />
                      );
                    default:
                      return (
                        <SubmissionItem
                          item={item.submission}
                          key={key}
                          onDelete={deleteSubmissionRow}
                          pickKey={key}
                          selected={selected}
                          view={view}
                          workspaceIconId={iconOf(item.submission.workspaceId)}
                        />
                      );
                  }
                })}
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
        {...deleteCopy(deleteTargets ?? [])}
        confirmLabel={m.action_delete()}
        onClose={() => setDeleteTargets(null)}
        onConfirm={() => {
          if (deleteTargets) void selection.run(deleteTargets, deleteItem);
        }}
        open={!!deleteTargets}
      />
      {blocks.dialogs}
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

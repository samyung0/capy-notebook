import { linkOptions, useNavigate, useSearch } from '@tanstack/react-router';
import { useCallback, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMediaQuery } from 'usehooks-ts';
import { updateMaterialBodyTitleMax } from '@/api/gen/validators';
import {
  useCreateFlashcardSet,
  useCreateQuiz,
  useCreateStandaloneNote,
  useDeleteMaterial,
  useDeleteOwnedMaterial,
  useOwnedMaterials,
  useUpdateMaterial,
  useWorkspaces,
} from '@/api/hooks';
import type {
  MaterialListItem,
  MaterialListLocation,
  MaterialListSort,
} from '@/api/types';
import {
  ItemList,
  ItemPick,
  ItemSkeletonGrid,
} from '@/components/app/ItemCard';
import { ListEnd } from '@/components/app/ListEnd';
import {
  type FilterSection,
  ListToolbar,
  type ListView,
  type SortOption,
  toggleValue,
} from '@/components/app/ListToolbar';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import type { ColumnSort } from '@/components/app/SortHeader';
import { TrashConfirmDialog } from '@/components/app/TrashConfirmDialog';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { SkeletonCardGrid } from '@/components/ui/feedback';
import type { MenuItem } from '@/components/ui/Menu';
import { Menu } from '@/components/ui/Menu';
import { NameFormDialog } from '@/components/ui/NameFormDialog';
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
  MaterialCard,
  materialKindLabel,
} from '@/features/materials/MaterialListCard';
import { MaterialShareDialog } from '@/features/materials/MaterialShareDialog';
import { CloneItemDialog } from '@/features/workspace/CloneItemDialog';
import { ContentPropertiesDialog } from '@/features/workspace/ContentActions';
import { toMaterialActionTarget } from '@/features/workspace/contentActionTarget';
import { useAccountFrozen } from '@/features/workspace/WorkspaceHealth';
import { m } from '@/i18n';
import {
  csv,
  type FilesSearch,
  MATERIAL_KINDS,
  MATERIAL_LOCATIONS,
  MATERIAL_SORT_DEFAULT,
  materialListParams,
  sortSearch,
} from '@/lib/listSearch';
import { waitsForConnection } from '@/lib/online';
import { useLoadingReveal } from '@/lib/useLoadingReveal';

/** A Location filter option, shared by the Files and Blocks tabs. */
export function locationLabel(location: MaterialListLocation): string {
  switch (location) {
    case 'workspace':
      return m.create_location_workspace();
    default:
      return m.create_location_standalone();
  }
}

function materialLink(item: MaterialListItem) {
  return linkOptions({
    params: { materialId: item.id },
    to: '/materials/$materialId',
  });
}

/** The Files page's Blocks tab: every note, quiz and flashcard set the user
 * owns or reaches through a workspace, plus New block for standalone ones. */
export function MaterialsTab({
  headerSlot,
  view,
  onBusyChange,
  onViewChange,
}: {
  /** Where New block goes on phones (beside the page title). */
  headerSlot?: HTMLElement | null;
  view: ListView;
  onBusyChange: (busy: boolean) => void;
  onViewChange: (view: ListView) => void;
}) {
  const phone = !useMediaQuery('(min-width: 640px)');
  const sorts: SortOption<MaterialListSort>[] = [
    {
      icon: 'clock',
      label: m.create_sort_updated(),
      value: 'updated',
    },
    {
      icon: 'schedule',
      label: m.create_sort_created(),
      value: 'created',
    },
    {
      icon: 'pencil',
      label: m.create_sort_title(),
      value: 'title',
    },
    {
      icon: 'chapter',
      label: m.create_sort_kind(),
      value: 'kind',
    },
  ];
  // Sort and filters live in the URL; picks replace the entry.
  const search = useSearch({ from: '/auth-shell/files' });
  const navigate = useNavigate({ from: '/files' });
  const setSearch = (patch: FilesSearch) =>
    void navigate({ replace: true, search: (prev) => ({ ...prev, ...patch }) });
  const params = useMemo(() => materialListParams(search), [search]);
  const {
    sort = MATERIAL_SORT_DEFAULT,
    kinds = [],
    workspaceIds = [],
  } = params;
  const sorting: ColumnSort<MaterialListSort> = {
    ascending: params.dir === 'asc',
    ascendingFirst: ['title', 'workspace', 'kind'],
    onSortChange: (next, asc) =>
      setSearch(sortSearch('blocks', next, asc, MATERIAL_SORT_DEFAULT)),
    sort,
  };
  const location = search.location;

  const {
    data,
    fetchNextPage,
    fetchStatus,
    hasNextPage,
    isFetchNextPageError,
    isFetchingNextPage,
    isLoading,
  } = useOwnedMaterials(params);
  const items = data?.pages.flatMap((page) => page.items) ?? [];
  const selection = useFileSelection(
    items,
    (item) => item.id,
    () =>
      collectSelectionPages(data?.pages ?? [], () =>
        fetchNextPage({ throwOnError: true })
      ),
    onBusyChange
  );
  const { mutateAsync: deleteOwnedMaterial } = useDeleteOwnedMaterial();
  const [deleteTargets, setDeleteTargets] = useState<MaterialListItem[] | null>(
    null
  );
  const revealRef = useLoadingReveal(isLoading);
  const { data: workspaces = [] } = useWorkspaces(
    { sort: 'accessed' },
    { errorBoundary: false }
  );
  const owned = workspaces.filter((ws) => ws.isOwner);

  const filters: FilterSection[] = [
    {
      key: 'kind',
      label: m.create_filter_kind(),
      onToggle: (value) => setSearch({ kind: csv(toggleValue(kinds, value)) }),
      options: MATERIAL_KINDS.map((kind) => ({
        label: materialKindLabel(kind),
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
            location === value ? undefined : (value as MaterialListLocation),
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
      label: m.create_filter_workspace(),
      onToggle: (value) =>
        setSearch({ workspace: csv(toggleValue(workspaceIds, value)) }),
      options: owned.map((ws) => ({ label: ws.name, value: ws.id })),
      selected: workspaceIds,
    },
  ];

  // Creation of standalone materials from the New menu.
  const { mutate: createNote } = useCreateStandaloneNote();
  const { mutate: createQuiz } = useCreateQuiz();
  const { mutate: createFlashcardSet } = useCreateFlashcardSet();
  const frozen = useAccountFrozen();
  const newMenu: MenuItem[] = [
    {
      icon: 'newNote',
      label: m.create_kind_note(),
      onClick: () =>
        createNote(
          {},
          {
            onSuccess: (material) =>
              navigate({
                params: { materialId: material.id },
                search: { mode: 'edit' },
                to: '/materials/$materialId',
              }),
          }
        ),
    },
    {
      icon: 'quiz',
      label: m.editor_quiz(),
      onClick: () =>
        createQuiz(
          { name: m.quiz_untitled(), questions: [] },
          {
            onSuccess: (quiz) =>
              navigate({
                params: { materialId: quiz.id },
                search: { mode: 'edit' },
                to: '/materials/$materialId',
              }),
          }
        ),
    },
    {
      icon: 'flashcards',
      label: m.editor_flashcards(),
      onClick: () =>
        createFlashcardSet(
          { color: 'purple', name: m.flashcards_new_flashcards() },
          {
            onSuccess: (set) =>
              navigate({
                params: { flashcardSetId: set.id },
                to: '/flashcards/$flashcardSetId',
              }),
          }
        ),
    },
  ];

  // Item actions. Dialogs are hoisted so one instance serves every card.
  const [renaming, setRenaming] = useState<MaterialListItem | null>(null);
  const [sharing, setSharing] = useState<MaterialListItem | null>(null);
  const [deleting, setDeleting] = useState<MaterialListItem | null>(null);
  const { mutateAsync: rename } = useUpdateMaterial(
    renaming?.workspaceId ?? ''
  );
  const { mutate: deleteMaterial } = useDeleteMaterial(
    deleting?.workspaceId ?? ''
  );
  const [cloning, setCloning] = useState<MaterialListItem | null>(null);
  const [inspecting, setInspecting] = useState<MaterialListItem | null>(null);

  // Stable while `frozen` holds, so the memoised cards skip a pick's render.
  const menuFor = useCallback(
    (item: MaterialListItem): MenuItem[] => {
      const remove: MenuItem = {
        danger: true,
        icon: 'trash',
        label: m.action_delete(),
        onClick: () => setDeleting(item),
      };
      // In a workspace the viewer left it can only be deleted (it still pays).
      if (item.lostAccess) return [remove];
      const standalone = !item.workspaceId;
      const items: MenuItem[] = [];
      if (item.kind === 'quiz') {
        items.push({
          icon: 'quiz',
          label: m.action_study(),
          onClick: () =>
            navigate({
              params: { quizId: item.id },
              to: '/quizzes/$quizId/attempt',
            }),
        });
      } else if (item.kind === 'flashcards') {
        items.push({
          icon: 'flashcards',
          label: m.action_study(),
          onClick: () =>
            navigate({
              params: { flashcardSetId: item.id },
              to: '/flashcards/$flashcardSetId',
            }),
        });
      }
      items.push({
        icon: 'pencil',
        label: m.action_rename(),
        onClick: () => setRenaming(item),
      });
      if (standalone) {
        items.push({
          icon: 'link',
          label: m.action_share(),
          onClick: () => setSharing(item),
        });
      }
      items.push({
        disabled: frozen,
        icon: 'clone',
        label: m.action_clone_to(),
        onClick: () => setCloning(item),
      });
      items.push({
        icon: 'help',
        label: m.content_properties(),
        onClick: () => setInspecting(item),
      });
      items.push(remove);
      return items;
    },
    [frozen, navigate]
  );

  const newBlock = (
    <Menu
      align="end"
      items={newMenu}
      trigger={
        <Button
          className="px-1.5 font-bold text-link"
          disabled={frozen}
          iconLeft="plus"
          size="sm"
          variant="ghost-hover"
        >
          {m.files_new_block()}
        </Button>
      }
    />
  );
  const newBlockInHeader = phone && !!headerSlot;

  return (
    <>
      {newBlockInHeader && createPortal(newBlock, headerSlot)}
      <ListToolbar
        action={newBlockInHeader ? undefined : newBlock}
        filters={filters}
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
      <div
        className="page-px-wide w-full shrink-0 grow pt-2 pb-6"
        onClick={clearOnBlank(selection.clear)}
      >
        {waitsForConnection(fetchStatus, data) ? (
          <QueryPausedState />
        ) : isLoading ? (
          view === 'grid' ? (
            <ItemSkeletonGrid count={16} />
          ) : (
            <SkeletonCardGrid cardHeight={150} count={16} />
          )
        ) : items.length === 0 ? (
          <p className="py-10 text-center text-fg-muted">
            {kinds.length || workspaceIds.length || location
              ? m.create_empty()
              : m.create_none()}
          </p>
        ) : (
          <div className="flex flex-col gap-3" ref={revealRef}>
            <ItemPick.Provider value={selection.pickContext}>
              <ItemList
                columns={[
                  { label: m.list_col_name(), sort: 'title' },
                  { label: m.create_filter_workspace(), sort: 'workspace' },
                  // Question and card counts and sizes do not sort together.
                  m.list_col_details(),
                  { label: m.list_col_updated(), sort: 'updated' },
                ]}
                sorting={sorting}
                view={view}
              >
                {items.map((item) => (
                  <MaterialCard
                    item={item}
                    key={item.id}
                    linkFor={materialLink}
                    menuFor={menuFor}
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
            <ListEnd
              fetchNextPage={fetchNextPage}
              hasNextPage={hasNextPage}
              isFetchingNextPage={isFetchingNextPage}
              isFetchNextPageError={isFetchNextPageError}
            />
          </div>
        )}
      </div>

      <NameFormDialog
        defaultName={renaming?.title ?? ''}
        fieldLabel={m.material_rename()}
        maxLength={updateMaterialBodyTitleMax}
        onClose={() => setRenaming(null)}
        onSubmit={async (title) => {
          if (!renaming) return;
          await rename({ id: renaming.id, patch: { title } });
          setRenaming(null);
        }}
        open={!!renaming}
        title={m.material_rename()}
      />
      {sharing && (
        <MaterialShareDialog
          material={sharing}
          onClose={() => setSharing(null)}
        />
      )}
      {cloning && (
        <CloneItemDialog
          item={{
            id: cloning.id,
            kind: cloning.kind,
            name: cloning.title,
            type: 'material',
            workspaceId: cloning.workspaceId,
          }}
          onClose={() => setCloning(null)}
        />
      )}
      {inspecting && (
        <ContentPropertiesDialog
          content={toMaterialActionTarget(inspecting)}
          onClose={() => setInspecting(null)}
          open
        />
      )}
      <ConfirmDialog
        body={m.blocks_delete_selected_body({
          count: deleteTargets?.length ?? 0,
        })}
        confirmLabel={m.action_delete()}
        onClose={() => setDeleteTargets(null)}
        onConfirm={() => {
          if (deleteTargets)
            void selection.run(deleteTargets, deleteOwnedMaterial);
        }}
        open={!!deleteTargets}
        title={m.blocks_delete_selected_title()}
      />
      <TrashConfirmDialog
        name={deleting?.title ?? ''}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) deleteMaterial(deleting.id);
          setDeleting(null);
        }}
        open={!!deleting}
      />
    </>
  );
}

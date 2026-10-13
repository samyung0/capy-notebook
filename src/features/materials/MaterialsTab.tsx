import { linkOptions, useNavigate, useSearch } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { updateMaterialBodyTitleMax } from '@/api/gen/validators';
import {
  useCreateFlashcardSet,
  useCreateQuiz,
  useCreateStandaloneNote,
  useDeleteMaterial,
  useOwnedMaterials,
  useUpdateMaterial,
  useWorkspaces,
} from '@/api/hooks';
import type {
  MaterialListItem,
  MaterialListLocation,
  MaterialListSort,
} from '@/api/types';
import { ItemList, ItemSkeletonGrid } from '@/components/app/ItemCard';
import { ListEnd } from '@/components/app/ListEnd';
import {
  type FilterSection,
  ListToolbar,
  type ListView,
  type SortOption,
  toggleValue,
} from '@/components/app/ListToolbar';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { TrashConfirmDialog } from '@/components/app/TrashConfirmDialog';
import { Button } from '@/components/ui/Button';
import { SkeletonCardGrid } from '@/components/ui/feedback';
import type { MenuItem } from '@/components/ui/Menu';
import { Menu } from '@/components/ui/Menu';
import { NameFormDialog } from '@/components/ui/NameFormDialog';
import {
  MaterialCard,
  materialKindLabel,
} from '@/features/materials/MaterialListCard';
import { MaterialShareDialog } from '@/features/materials/MaterialShareDialog';
import { CloneItemDialog } from '@/features/workspace/CloneItemDialog';
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
import { useLoadingReveal } from '@/lib/useLoadingReveal';

function locationLabel(location: MaterialListLocation): string {
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
  view,
  onViewChange,
}: {
  view: ListView;
  onViewChange: (view: ListView) => void;
}) {
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
  const ascending = params.dir === 'asc';
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

  function menuFor(item: MaterialListItem): MenuItem[] {
    const standalone = !item.workspaceId;
    const items: MenuItem[] = [];
    if (item.kind === 'quiz') {
      items.push(
        {
          icon: 'quiz',
          label: m.quiz_start(),
          onClick: () =>
            navigate({
              params: { quizId: item.id },
              to: '/quizzes/$quizId/attempt',
            }),
        },
        {
          icon: 'settings',
          label: m.action_edit(),
          onClick: () =>
            navigate({ ...materialLink(item), search: { mode: 'edit' } }),
        }
      );
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
    } else {
      items.push({
        icon: 'newNote',
        label: m.action_open(),
        onClick: () => navigate(materialLink(item)),
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
      label: m.action_clone(),
      onClick: () => setCloning(item),
    });
    items.push({
      danger: true,
      icon: 'trash',
      label: m.action_delete(),
      onClick: () => setDeleting(item),
    });
    return items;
  }

  return (
    <>
      <ListToolbar
        action={
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
        }
        ascending={ascending}
        filters={filters}
        onResetFilters={() =>
          setSearch({
            kind: undefined,
            location: undefined,
            workspace: undefined,
          })
        }
        onSortChange={(next, asc) =>
          setSearch(sortSearch('blocks', next, asc, MATERIAL_SORT_DEFAULT))
        }
        onViewChange={onViewChange}
        sort={sort}
        sorts={sorts}
        view={view}
      />
      <div className="w-full shrink-0 grow px-6 pt-2 pb-6">
        {fetchStatus === 'paused' && !data ? (
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
            <ItemList
              columns={[
                m.list_col_name(),
                m.create_filter_workspace(),
                m.list_col_details(),
                m.list_col_updated(),
              ]}
              view={view}
            >
              {items.map((item) => (
                <MaterialCard
                  item={item}
                  key={item.id}
                  link={materialLink(item)}
                  menu={menuFor(item)}
                  view={view}
                  workspaceIconId={
                    workspaces.find((ws) => ws.id === item.workspaceId)?.iconId
                  }
                />
              ))}
            </ItemList>
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
      <TrashConfirmDialog
        name={deleting?.title ?? ''}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) deleteMaterial(deleting.id);
        }}
        open={!!deleting}
      />
    </>
  );
}

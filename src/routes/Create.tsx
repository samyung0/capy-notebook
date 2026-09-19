import { useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { updateMaterialBodyTitleMax } from '@/api/gen/validators';
import {
  useCloneFlashcardSet,
  useCloneMaterial,
  useCloneQuiz,
  useCreateFlashcardSet,
  useCreateQuiz,
  useCreateStandaloneNote,
  useDeleteMaterial,
  useOwnedMaterials,
  useUpdateFlashcardSetSharing,
  useUpdateMaterial,
  useUpdateMaterialSharing,
  useUpdateQuizSharing,
  useWorkspaces,
} from '@/api/hooks';
import type {
  MaterialListItem,
  MaterialListKind,
  MaterialListLocation,
  MaterialListParams,
  MaterialListSort,
} from '@/api/types';
import {
  type FilterSection,
  ListToolbar,
  type ListView,
  type SortOption,
  toggleValue,
} from '@/components/app/ListToolbar';
import { PageHeader, PanelWithInvertedRadius } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { SkeletonCardGrid } from '@/components/ui/feedback';
import type { MenuItem } from '@/components/ui/Menu';
import { Menu } from '@/components/ui/Menu';
import { NameFormDialog } from '@/components/ui/NameFormDialog';
import {
  MaterialCard,
  materialKindLabel,
} from '@/features/materials/MaterialListCard';
import { createBlankQuestion } from '@/features/quizzes/QuizForm';
import { ShareDialog } from '@/features/workspace/ShareDialog';
import { m } from '@/i18n';
import { toastCloneError } from '@/lib/authToasts';
import { trackItemCloned } from '@/lib/observability';
import { useLoadingReveal } from '@/lib/useLoadingReveal';

const VIEW_KEY = 'capy.create.view';
const KINDS: MaterialListKind[] = ['note', 'quiz', 'flashcards'];
const LOCATIONS: MaterialListLocation[] = [
  'workspace',
  'embedded',
  'standalone',
];

function locationLabel(location: MaterialListLocation): string {
  switch (location) {
    case 'workspace':
      return m.create_location_workspace();
    case 'embedded':
      return m.create_location_embedded();
    default:
      return m.create_location_standalone();
  }
}

function readView(): ListView {
  try {
    return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}

export default function Create() {
  const sorts: SortOption<MaterialListSort>[] = [
    {
      icon: 'clock',
      label: m.create_sort_updated(),
      order: 'time',
      value: 'updated',
    },
    {
      icon: 'schedule',
      label: m.create_sort_created(),
      order: 'time',
      value: 'created',
    },
    {
      icon: 'pencil',
      label: m.create_sort_title(),
      order: 'name',
      value: 'title',
    },
    {
      icon: 'chapter',
      label: m.create_sort_kind(),
      order: 'name',
      value: 'kind',
    },
  ];
  const [sort, setSort] = useState<MaterialListSort>('updated');
  const [ascending, setAscending] = useState(false);
  const [kinds, setKinds] = useState<string[]>([]);
  const [location, setLocation] = useState<MaterialListLocation | ''>('');
  const [workspaceIds, setWorkspaceIds] = useState<string[]>([]);
  const [view, setView] = useState<ListView>(readView);
  const navigate = useNavigate();

  const params = useMemo<MaterialListParams>(
    () => ({
      dir: ascending ? 'asc' : 'desc',
      sort,
      ...(kinds.length ? { kinds: kinds as MaterialListKind[] } : {}),
      ...(location ? { location } : {}),
      ...(workspaceIds.length ? { workspaceIds } : {}),
    }),
    [ascending, kinds, location, sort, workspaceIds]
  );
  const {
    data,
    fetchNextPage,
    fetchStatus,
    hasNextPage,
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
  const workspaceIcons = new Map(owned.map((ws) => [ws.id, ws.iconId]));

  const filters: FilterSection[] = [
    {
      key: 'kind',
      label: m.create_filter_kind(),
      onToggle: (value) => setKinds((prev) => toggleValue(prev, value)),
      options: KINDS.map((kind) => ({
        label: materialKindLabel(kind),
        value: kind,
      })),
      selected: kinds,
    },
    {
      key: 'location',
      label: m.create_filter_location(),
      onToggle: (value) =>
        setLocation((prev) =>
          prev === value ? '' : (value as MaterialListLocation)
        ),
      options: LOCATIONS.map((value) => ({
        label: locationLabel(value),
        value,
      })),
      selected: location ? [location] : [],
    },
    {
      emptyLabel: m.create_filter_no_workspaces(),
      key: 'workspace',
      label: m.create_filter_workspace(),
      onToggle: (value) => setWorkspaceIds((prev) => toggleValue(prev, value)),
      options: owned.map((ws) => ({ label: ws.name, value: ws.id })),
      selected: workspaceIds,
    },
  ];

  function changeView(next: ListView) {
    setView(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      // per-viewer convenience only
    }
  }

  // Creation of standalone materials from the New menu.
  const { mutate: createNote } = useCreateStandaloneNote();
  const { mutate: createQuiz } = useCreateQuiz();
  const { mutate: createFlashcardSet } = useCreateFlashcardSet();
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
          { name: m.quiz_untitled(), questions: [createBlankQuestion()] },
          {
            onSuccess: (quiz) =>
              navigate({
                params: { quizId: quiz.id },
                to: '/quizzes/$quizId/edit',
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
  const { isPending: quizSharingIsPending, mutateAsync: shareQuiz } =
    useUpdateQuizSharing();
  const {
    isPending: flashcardsSharingIsPending,
    mutateAsync: shareFlashcards,
  } = useUpdateFlashcardSetSharing();
  const { isPending: noteSharingIsPending, mutateAsync: shareNote } =
    useUpdateMaterialSharing();
  const { mutate: cloneQuiz } = useCloneQuiz();
  const { mutate: cloneFlashcardSet } = useCloneFlashcardSet();
  const { mutate: cloneMaterial } = useCloneMaterial();

  function open(item: MaterialListItem) {
    if (item.kind === 'quiz') {
      navigate({ params: { quizId: item.id }, to: '/quizzes/$quizId/attempt' });
    } else if (item.kind === 'flashcards') {
      navigate({
        params: { flashcardSetId: item.id },
        to: '/flashcards/$flashcardSetId',
      });
    } else if (item.workspaceId) {
      navigate({
        params: { workspaceId: item.workspaceId },
        search: { material: item.id },
        to: '/workspaces/$workspaceId',
      });
    } else {
      navigate({
        params: { materialId: item.id },
        to: '/materials/$materialId',
      });
    }
  }

  function clone(item: MaterialListItem) {
    const onError = (err: unknown) => toastCloneError(err, 'material');
    if (item.kind === 'quiz') {
      cloneQuiz(item.id, {
        onError,
        onSuccess: (quiz) => {
          trackItemCloned('quiz');
          navigate({
            params: { quizId: quiz.id },
            to: '/quizzes/$quizId/attempt',
          });
        },
      });
    } else if (item.kind === 'flashcards') {
      cloneFlashcardSet(item.id, {
        onError,
        onSuccess: (set) => {
          trackItemCloned('flashcards');
          navigate({
            params: { flashcardSetId: set.id },
            to: '/flashcards/$flashcardSetId',
          });
        },
      });
    } else {
      cloneMaterial(item.id, {
        onError,
        onSuccess: (material) => {
          trackItemCloned('material');
          navigate({
            params: { materialId: material.id },
            to: '/materials/$materialId',
          });
        },
      });
    }
  }

  function menuFor(item: MaterialListItem): MenuItem[] {
    const embedded = !!item.parentMaterialId;
    const standalone = !item.workspaceId && !embedded;
    const items: MenuItem[] = [];
    if (item.kind === 'quiz') {
      items.push(
        { icon: 'quiz', label: m.quiz_start(), onClick: () => open(item) },
        {
          icon: 'settings',
          label: m.action_edit(),
          onClick: () =>
            navigate({
              params: { quizId: item.id },
              to: '/quizzes/$quizId/edit',
            }),
        }
      );
    } else if (item.kind === 'flashcards') {
      items.push({
        icon: 'flashcards',
        label: m.action_study(),
        onClick: () => open(item),
      });
    } else {
      items.push({
        icon: 'newNote',
        label: m.action_open(),
        onClick: () => open(item),
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
      icon: 'clone',
      label: m.action_clone(),
      onClick: () => clone(item),
    });
    if (!embedded) {
      items.push({
        danger: true,
        icon: 'trash',
        label: m.action_delete(),
        onClick: () => setDeleting(item),
      });
    }
    return items;
  }

  return (
    <PanelWithInvertedRadius>
      <PageHeader title={m.nav_create()} />
      <ListToolbar
        action={
          <Menu
            align="end"
            items={newMenu}
            trigger={
              <Button
                className="rounded-card font-bold text-link"
                iconLeft="plus"
                size="md"
                variant="ghost-hover"
              >
                {m.create_new()}
              </Button>
            }
          />
        }
        ascending={ascending}
        filters={filters}
        onResetFilters={() => {
          setKinds([]);
          setLocation('');
          setWorkspaceIds([]);
        }}
        onSortChange={(next, asc) => {
          setSort(next);
          setAscending(asc);
        }}
        onViewChange={changeView}
        sort={sort}
        sorts={sorts}
        view={view}
      />
      <div className="min-h-0 w-full flex-1 overflow-auto px-6 pt-2 pb-6">
        {fetchStatus === 'paused' && !data ? (
          <QueryPausedState />
        ) : isLoading ? (
          <SkeletonCardGrid cardHeight={150} count={8} />
        ) : items.length === 0 ? (
          <p className="py-10 text-center text-fg-muted">{m.create_empty()}</p>
        ) : (
          <div className="flex flex-col gap-3" ref={revealRef}>
            {view === 'grid' ? (
              <div className="grid w-full grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
                {items.map((item) => (
                  <MaterialCard
                    item={item}
                    key={item.id}
                    menu={menuFor(item)}
                    onOpen={() => open(item)}
                    view="grid"
                    workspaceIconId={workspaceIcons.get(item.workspaceId)}
                  />
                ))}
              </div>
            ) : (
              <div className="overflow-hidden rounded-card border border-line">
                <div className="hidden bg-surface-hover-bg px-4 py-2.5 font-bold text-fg-muted text-xs uppercase tracking-wide md:grid md:grid-cols-[minmax(200px,2.4fr)_1.1fr_minmax(160px,2fr)_1.5fr_1fr_40px] md:gap-3">
                  <div>{m.list_col_name()}</div>
                  <div>{m.list_col_kind()}</div>
                  <div>{m.list_col_location()}</div>
                  <div>{m.list_col_details()}</div>
                  <div>{m.list_col_updated()}</div>
                  <div />
                </div>
                {items.map((item) => (
                  <MaterialCard
                    item={item}
                    key={item.id}
                    menu={menuFor(item)}
                    onOpen={() => open(item)}
                    view="list"
                    workspaceIconId={workspaceIcons.get(item.workspaceId)}
                  />
                ))}
              </div>
            )}
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
        <ShareDialog
          link={
            sharing.kind === 'quiz'
              ? `/share/quizzes/${sharing.id}`
              : sharing.kind === 'flashcards'
                ? `/share/flashcards/${sharing.id}`
                : `/materials/${sharing.id}`
          }
          onClose={() => setSharing(null)}
          onPrivacyChange={async (privacy) => {
            const id = sharing.id;
            if (sharing.kind === 'quiz') await shareQuiz({ id, privacy });
            else if (sharing.kind === 'flashcards')
              await shareFlashcards({ id, privacy });
            else await shareNote({ id, privacy });
            setSharing({ ...sharing, privacy });
          }}
          open
          privacy={sharing.privacy}
          saving={
            quizSharingIsPending ||
            flashcardsSharingIsPending ||
            noteSharingIsPending
          }
          title={m.flashcards_share_title({ name: sharing.title })}
        />
      )}
      <ConfirmDialog
        body={m.confirm_delete_body()}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) deleteMaterial(deleting.id);
        }}
        open={!!deleting}
        title={m.confirm_delete_title({ name: deleting?.title ?? '' })}
      />
    </PanelWithInvertedRadius>
  );
}

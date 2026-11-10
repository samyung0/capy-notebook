import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  type CanvasListItem,
  canvasById,
  canvasesQuery,
  createCanvas,
  saveCanvas,
} from '@/api/canvas';
import { qk } from '@/api/client';
import { updateMaterialBodyTitleMax } from '@/api/gen/validators';
import { useDeleteMaterial, useUpdateMaterial } from '@/api/hooks';
import { pagedRows } from '@/api/paged';
import { MobileNavDrawer } from '@/components/app/Sidebar';
import { TrashConfirmDialog } from '@/components/app/TrashConfirmDialog';
import { NameFormDialog } from '@/components/ui/NameFormDialog';
import { CanvasSwitcher } from '@/features/canvas/CanvasSwitcher';
import { useCanvasBoard } from '@/features/canvas/useCanvasBoard';
import { useAccountFrozen } from '@/features/workspace/WorkspaceHealth';
import { m } from '@/i18n';

/** A name no other of the person's canvases has: "Untitled canvas", then
 * "Untitled canvas 2". */
function newTitle(taken: string[]) {
  const base = m.canvas_untitled();
  for (let n = 1; ; n++) {
    const title = n === 1 ? base : `${base} ${n}`;
    if (!taken.includes(title)) return title;
  }
}

/** One of the person's own canvases as the page's board, saved as a
 * workspace's is, with no workspace. */
function OwnCanvas({ gone, id }: { gone: () => boolean; id: string }) {
  const container = useRef<HTMLDivElement>(null);
  const failed = useCanvasBoard(
    container,
    {
      key: id,
      open: () => canvasById(id),
      save: (body) => saveCanvas(id, body),
    },
    { gone }
  );
  return (
    <div
      className="h-full w-full overflow-hidden rounded-card-xl [&>div]:h-full"
      ref={container}
    >
      {failed && (
        <p className="t-body m-6 pt-14 text-fg-muted" role="alert">
          {failed}
        </p>
      )}
    </div>
  );
}

/** The account's Canvas page (Epo 2026-11-10, mock KNPB4pYUhSSYUJvuKN1ct7 B):
 * the page is a board, one of the person's own canvases in no workspace, with
 * a panel at the top left that lists every canvas they have and makes a new
 * one. The URL names the canvas shown; without one (the sidebar's link) the
 * one already shown stays, else the latest saved of their own, and a first one
 * is made for a person who has none. A workspace's canvas opens in its
 * workspace, where its quiz and flashcard cards work. A frozen account draws
 * on what it has and makes nothing new. */
export default function CanvasPage() {
  const { c } = useSearch({ from: '/auth-shell/canvas' });
  const navigate = useNavigate();
  const qc = useQueryClient();
  const frozen = useAccountFrozen();
  // A list that can't be read goes to the page's error boundary, as any does.
  // It comes a page at a time, the person's own canvases first.
  const {
    data: canvases,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    refetch,
  } = useInfiniteQuery({ ...canvasesQuery(), select: pagedRows });
  const own = useMemo(
    () => canvases?.filter(({ workspaceId }) => !workspaceId),
    [canvases]
  );
  /** The canvas shown last: a link without `c` keeps it on the page. */
  const shown = useRef<CanvasListItem | undefined>(undefined);
  /** A canvas just deleted: not shown again, though the list may hold it yet. */
  const [removed, setRemoved] = useState<string>();
  const asked = c ?? shown.current?.id;
  const wanted = asked === removed ? undefined : asked;
  const listed = own?.find(({ id }) => id === wanted);
  // The pages loaded may not reach the wanted canvas (newer ones pushed it down
  // the list, or a link names an old one): they load on until it shows or they
  // end, and the one already on the page stays there meanwhile. A page that
  // fails stops the loading and changes nothing shown: the menu's Load more, or
  // its next open, tries again.
  const unlisted = !!wanted && !listed && hasNextPage;
  const seeking = unlisted && !isFetchNextPageError;
  const current =
    listed ??
    (unlisted && shown.current?.id === wanted ? shown.current : undefined);
  if (current) shown.current = current;
  /** The canvas being deleted: its board saves and keeps nothing more. */
  const deleted = useRef<string | null>(null);
  const { mutateAsync: create } = useMutation({ mutationFn: createCanvas });
  const { mutateAsync: rename } = useUpdateMaterial('');
  const { mutateAsync: remove } = useDeleteMaterial('');
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const relist = () => qc.invalidateQueries({ queryKey: qk.canvases });
  const show = (id: string, replace = false) =>
    navigate({ replace, search: { c: id }, to: '/canvas' });
  // A refusal is said by the mutation's own toast.
  const add = (title: string, replace = false) =>
    create(title)
      .then(async (made) => {
        await relist();
        await show(made.id, replace);
      })
      .catch(() => undefined);
  // One first canvas, however often this runs before the list has it.
  const making = useRef(false);
  useEffect(() => {
    if (!own) return;
    if (seeking) {
      if (!isFetchingNextPage) void fetchNextPage();
      return;
    }
    if (current) {
      making.current = false;
      // The URL names what is shown, so a reload and a shared tab open it.
      if (c !== current.id) void show(current.id, true);
      return;
    }
    // A link's canvas not found yet, behind a page that failed: the link stays.
    if (unlisted) return;
    // Their own come first, so a first page without one means they have none.
    const first = own.find(({ id }) => id !== removed);
    if (first) void show(first.id, true);
    else if (!(making.current || frozen)) {
      making.current = true;
      void add(m.canvas_first_title(), true);
    }
    // `show`, `add` and `fetchNextPage` are this render's; the list, its
    // paging, the canvas shown and the URL's are what it follows.
  }, [own, current, c, frozen, seeking, unlisted, isFetchingNextPage, removed]);

  const open = (canvas: CanvasListItem) =>
    canvas.workspaceId
      ? navigate({
          params: { workspaceId: canvas.workspaceId },
          search: { panel: 'canvas' },
          to: '/workspaces/$workspaceId',
        })
      : show(canvas.id);

  return (
    <div className="relative h-full w-full">
      {current && (
        <OwnCanvas
          gone={() => deleted.current === current.id}
          id={current.id}
          key={current.id}
        />
      )}
      {own?.length === 0 && frozen && (
        <p className="t-body m-6 pt-14 text-fg-muted">{m.canvas_none()}</p>
      )}
      {canvases && (
        // A phone has no sidebar: its navigation opens beside the panel, and the
        // row stops short of the board's own menu at the top right.
        <div className="absolute top-2 right-14 left-2 flex gap-2 sm:top-4 sm:right-auto sm:left-4 [&>[data-slot=dropdown-menu-anchor]]:flex-1 sm:[&>[data-slot=dropdown-menu-anchor]]:flex-none">
          <MobileNavDrawer account className="shrink-0 bg-surface sm:hidden" />
          <CanvasSwitcher
            canvases={canvases}
            current={current}
            frozen={frozen}
            onDelete={() => setDeleting(true)}
            onNew={() =>
              void add(newTitle((own ?? []).map(({ title }) => title)))
            }
            onOpen={(canvas) => void open(canvas)}
            onOpenChange={(opened) => {
              if (opened) void refetch();
            }}
            onRename={() => setRenaming(true)}
            paging={{
              fetchNextPage,
              hasNextPage,
              isFetchingNextPage,
              isFetchNextPageError,
            }}
          />
        </div>
      )}
      {/* Mounted for each rename: the form reads its first name once. */}
      {renaming && current && (
        <NameFormDialog
          defaultName={current.title}
          fieldLabel={m.material_rename()}
          maxLength={updateMaterialBodyTitleMax}
          onClose={() => setRenaming(false)}
          onSubmit={async (title) => {
            await rename({ id: current.id, patch: { title } });
            await relist();
          }}
          open
          title={m.material_rename()}
        />
      )}
      <TrashConfirmDialog
        name={current?.title ?? ''}
        onClose={() => setDeleting(false)}
        onConfirm={() => {
          setDeleting(false);
          if (!current) return;
          const { id } = current;
          deleted.current = id;
          remove(id)
            .then(() => {
              setRemoved(id);
              return relist();
            })
            // Refused: the canvas is still there and saves again.
            .catch(() => {
              deleted.current = null;
            });
        }}
        open={deleting}
      />
    </div>
  );
}

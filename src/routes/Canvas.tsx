import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  type CanvasListItem,
  canvasById,
  canvasesQuery,
  createCanvas,
  saveCanvas,
} from '@/api/canvas';
import { updateMaterialBodyTitleMax } from '@/api/gen/validators';
import { useDeleteMaterial, useUpdateMaterial } from '@/api/hooks';
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
  const { data: canvases, refetch } = useQuery(canvasesQuery());
  const own = useMemo(
    () => canvases?.filter(({ workspaceId }) => !workspaceId),
    [canvases]
  );
  /** The canvas shown last: a link without `c` keeps it on the page. */
  const shown = useRef<string | undefined>(undefined);
  const current = own?.find(({ id }) => id === (c ?? shown.current));
  if (current) shown.current = current.id;
  /** The canvas being deleted: its board saves and keeps nothing more. */
  const deleted = useRef<string | null>(null);
  const { mutateAsync: create } = useMutation({ mutationFn: createCanvas });
  const { mutateAsync: rename } = useUpdateMaterial('');
  const { mutateAsync: remove } = useDeleteMaterial('');
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const relist = () => qc.invalidateQueries(canvasesQuery());
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
    if (current) {
      making.current = false;
      // The URL names what is shown, so a reload and a shared tab open it.
      if (c !== current.id) void show(current.id, true);
      return;
    }
    if (own.length) void show(own[0].id, true);
    else if (!(making.current || frozen)) {
      making.current = true;
      void add(m.canvas_first_title(), true);
    }
    // `show` and `add` are this render's; the list, the canvas shown and the
    // URL's are what it follows.
  }, [own, current, c, frozen]);

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
          deleted.current = current.id;
          remove(current.id)
            .then(relist)
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

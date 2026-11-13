import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { type CanvasListItem, canvasesQuery, createCanvas } from '@/api/canvas';
import { qk } from '@/api/client';
import { updateMaterialBodyTitleMax } from '@/api/gen/validators';
import { useDeleteMaterial, useUpdateMaterial } from '@/api/hooks';
import { pagedRows } from '@/api/paged';
import { TrashConfirmDialog } from '@/components/app/TrashConfirmDialog';
import { NameFormDialog } from '@/components/ui/NameFormDialog';
import { CanvasSwitcher } from '@/features/canvas/CanvasSwitcher';
import { useAccountFrozen } from '@/features/workspace/WorkspaceHealth';
import { m } from '@/i18n';

/** A name no other of the person's canvases here has: "Untitled canvas", then
 * "Untitled canvas 2". */
function newTitle(taken: string[]) {
  const base = m.canvas_untitled();
  for (let n = 1; ; n++) {
    const title = n === 1 ? base : `${base} ${n}`;
    if (!taken.includes(title)) return title;
  }
}

/** Which canvas a canvas page shows, and its picker (Epo 2026-11-10: the
 * account's Canvas page; Epo 2026-11-12: a workspace's Canvas tab too). The
 * page's canvases are the person's own, or the ones they drew in `workspaceId`.
 * The URL's `c` names the one shown; without one the one already shown stays,
 * else the latest saved, and a first one (`firstTitle`) is made for a person
 * who has none. A frozen account draws on what it has and makes nothing new.
 * `picker` goes over the board, `dialogs` anywhere in the page. */
export function useCanvasPicker({
  c,
  firstTitle,
  openOther,
  show,
  workspaceId,
}: {
  c: string | undefined;
  firstTitle: string;
  /** A canvas listed here that another page shows: the account page's
   * workspace canvases, which open in their workspace. */
  openOther?: (canvas: CanvasListItem) => void;
  /** Names a canvas of this page's in the URL. */
  show: (id: string, replace?: boolean) => Promise<unknown>;
  workspaceId?: string;
}) {
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
  } = useInfiniteQuery({ ...canvasesQuery(workspaceId), select: pagedRows });
  const own = useMemo(
    () =>
      workspaceId
        ? canvases
        : canvases?.filter((canvas) => !canvas.workspaceId),
    [canvases, workspaceId]
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
  const { mutateAsync: create } = useMutation({
    mutationFn: (title: string) => createCanvas(title, workspaceId),
  });
  const { mutateAsync: rename } = useUpdateMaterial('');
  const { mutateAsync: remove } = useDeleteMaterial('');
  /** Bumped by a failed board's Retry, which mounts it again. */
  const [attempt, setAttempt] = useState(0);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const relist = () => qc.invalidateQueries({ queryKey: qk.canvases });
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
      void add(firstTitle, true);
    }
    // `show`, `add` and `fetchNextPage` are this render's; the list, its
    // paging, the canvas shown and the URL's are what it follows.
  }, [own, current, c, frozen, seeking, unlisted, isFetchingNextPage, removed]);

  const picker = canvases && (
    <CanvasSwitcher
      canvases={canvases}
      current={current}
      frozen={frozen}
      inWorkspace={!!workspaceId}
      onDelete={() => setDeleting(true)}
      onNew={() => void add(newTitle((own ?? []).map(({ title }) => title)))}
      onOpen={(canvas) =>
        workspaceId || !canvas.workspaceId
          ? void show(canvas.id)
          : openOther?.(canvas)
      }
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
  );
  const dialogs = (
    <>
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
    </>
  );
  return {
    /** The board's key: the canvas, and each Retry after it failed to open. */
    boardKey: current && `${current.id}:${attempt}`,
    current,
    dialogs,
    /** The canvas shown is being deleted: its board saves nothing more. */
    gone: (id: string) => deleted.current === id,
    /** A frozen account with no canvas here: nothing to show. */
    none: own?.length === 0 && frozen,
    picker,
    retry: () => setAttempt((count) => count + 1),
  };
}

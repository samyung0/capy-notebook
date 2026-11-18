import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  type CanvasListItem,
  canvasById,
  canvasesQuery,
  createCanvas,
  shareCanvas,
} from '@/api/canvas';
import { qk } from '@/api/client';
import { updateMaterialBodyTitleMax } from '@/api/gen/validators';
import {
  useDeleteMaterial,
  useUpdateMaterial,
  useWorkspace,
} from '@/api/hooks';
import { pagedRows } from '@/api/paged';
import { TrashConfirmDialog } from '@/components/app/TrashConfirmDialog';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { NameFormDialog } from '@/components/ui/NameFormDialog';
import { CanvasSwitcher } from '@/features/canvas/CanvasSwitcher';
import { canvasRights } from '@/features/canvas/canvasRights';
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
 * page's canvases are the person's own, or in `workspaceId` the ones they drew
 * there and the other members' shared ones (Epo 2026-11-18). The URL's `c`
 * names the one shown; without one the one already shown stays, else the
 * latest saved, and a first one (`firstTitle`) is made for a person with none
 * to show. A frozen account draws on what it has and makes nothing new.
 * `picker` goes over the board, `dialogs` anywhere in the page.
 *
 * A `c` the list does not hold once its pages ended may be one in the
 * person's Trash, which opens read-only from there as a trashed note does,
 * with no Rename, sharing or Delete; Restore brings it back into the list.
 *
 * Nothing tells the other members when a canvas is shared or taken back (as
 * for a hidden file), so the list is read again each time the picker opens
 * and after the person's own change. Sharing asks first, as a file's switch
 * does (Epo 2026-11-16); taking it back does not. */
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
    isFetching: listing,
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
  // Its pages ended without it: it may be in the Trash. Keyed under the
  // material, so Restore's refresh of an item open from the Trash asks again.
  const asksTrash = !!wanted && !!own && !listed && !hasNextPage;
  const { data: inTrash, isFetching: askingTrash } = useQuery({
    enabled: asksTrash,
    meta: { errorBoundary: false },
    queryFn: ({ signal }) => canvasById(wanted ?? '', signal),
    queryKey: [...qk.material(wanted ?? ''), 'canvas'],
    retry: false,
  });
  const fromTrash: CanvasListItem | undefined =
    asksTrash &&
    inTrash?.id === wanted &&
    inTrash.trash &&
    (inTrash.workspaceId ?? undefined) === workspaceId
      ? {
          id: inTrash.id,
          own: inTrash.own,
          shared: inTrash.shared,
          title: inTrash.title,
          updatedAt: inTrash.updatedAt,
          workspaceId: inTrash.workspaceId,
        }
      : undefined;
  // Restored: the list holds it once read again.
  const restored =
    asksTrash && inTrash?.id === wanted && !inTrash.trash ? inTrash.id : null;
  const [relisted, setRelisted] = useState<string | null>(null);
  const current =
    listed ??
    fromTrash ??
    (unlisted && shown.current?.id === wanted ? shown.current : undefined);
  const trashed = !!fromTrash && current === fromTrash;
  if (current) shown.current = current;
  /** The canvas being deleted: its room's refusal is no news to its board. */
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
  // What the picker offers for the canvas shown, by the person's role in its
  // workspace (none on the account's page, whose canvases have no workspace).
  const { data: workspace } = useWorkspace(workspaceId ?? '');
  // One in the Trash is only read until restored.
  const rights = trashed
    ? { manage: false, share: false }
    : canvasRights(current, workspace?.role);
  /** The canvas whose sharing the person is asked to confirm. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const {
    isPending: sharing,
    mutate: share,
    variables: sharingTo,
  } = useMutation({
    mutationFn: ({ id, shared }: { id: string; shared: boolean }) =>
      shareCanvas(id, shared),
    // A refusal is said by the mutation's own toast; either way the list says
    // what the canvas is now.
    onSettled: () => relist(),
  });
  // A refusal is said by the mutation's own toast.
  const add = (title: string, replace = false) =>
    create(title)
      .then(async (made) => {
        await relist();
        await show(made.id, replace);
      })
      .catch(() => undefined);
  useEffect(() => {
    if (!restored) return;
    void relist().then(() => setRelisted(restored));
    // `relist` is this render's; the restored canvas is what it follows.
  }, [restored]);
  // One first canvas, however often this runs before the list has it.
  const making = useRef(false);
  useEffect(() => {
    if (!own) return;
    if (seeking) {
      if (!isFetchingNextPage) void fetchNextPage();
      return;
    }
    // Asking whether it is in the Trash, or reading the list again for a
    // restored one: the link stays meanwhile.
    if (
      !current &&
      asksTrash &&
      (askingTrash || (restored && (relisted !== restored || listing)))
    )
      return;
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
  }, [
    own,
    current,
    c,
    frozen,
    seeking,
    unlisted,
    isFetchingNextPage,
    removed,
    asksTrash,
    askingTrash,
    restored,
    relisted,
    listing,
  ]);

  const picker = canvases && (
    <CanvasSwitcher
      canvases={canvases}
      current={current}
      frozen={frozen}
      inWorkspace={!!workspaceId}
      manage={rights.manage}
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
      onShare={
        current && rights.share
          ? (shared) =>
              shared
                ? setConfirming(current.id)
                : share({ id: current.id, shared })
          : undefined
      }
      paging={{
        fetchNextPage,
        hasNextPage,
        isFetchingNextPage,
        isFetchNextPageError,
      }}
      // The switch shows where it is going while the change is on its way.
      shared={
        sharing && sharingTo?.id === current?.id
          ? sharingTo?.shared
          : current?.shared
      }
      sharing={sharing}
    />
  );
  const dialogs = (
    <>
      <ConfirmDialog
        body={m.canvas_share_body()}
        confirmLabel={m.content_share_with_members()}
        danger={false}
        onClose={() => setConfirming(null)}
        onConfirm={() => {
          if (confirming) share({ id: confirming, shared: true });
        }}
        open={!!confirming}
        title={m.canvas_share_title()}
      />
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
            // Refused: the canvas is still there.
            .catch(() => {
              deleted.current = null;
            });
        }}
        open={deleting}
      />
    </>
  );
  return {
    /** The board's key: the canvas, each Retry after it failed to open, and
     * whether it is in the Trash (Restore opens it live). */
    boardKey: current && `${current.id}:${attempt}${trashed ? ':trash' : ''}`,
    current,
    dialogs,
    /** The canvas shown is being deleted. */
    gone: (id: string) => deleted.current === id,
    /** A frozen account with no canvas here: nothing to show. */
    none: own?.length === 0 && frozen,
    picker,
    retry: () => setAttempt((count) => count + 1),
  };
}

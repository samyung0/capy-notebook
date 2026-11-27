import { useEffect, useMemo, useRef, useState } from 'react';
import { useOwnedFiles, useOwnedMaterials } from '@/api/hooks';
import type { MaterialListItem } from '@/api/types';
import type { DrawingBoardOptions } from '@/features/blocksuite/drawingBoard';
import type { CanvasBoard } from '@/features/canvas/useCanvasBoard';

type WorkspaceLinks = NonNullable<DrawingBoardOptions['workspace']>;

/** The quizzes and sets a canvas's cards and its Misc panel draw from, every
 * page of them: a card whose material sits past the first page is still listed,
 * and a new title is checked against every existing one. `undefined` until the
 * last page is in, so the cards and the grid load rather than read as gone. A
 * workspace canvas reads its workspace's; the account's Canvas page every one
 * the person can open (Epo 2026-11-13). `readAt` is when the list was last
 * read. */
export function useCanvasMaterials(workspaceId?: string) {
  const {
    data: pages,
    dataUpdatedAt,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useOwnedMaterials({
    kinds: ['quiz', 'flashcards'],
    scope: 'member',
    ...(workspaceId && { workspaceIds: [workspaceId] }),
  });
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);
  const materials = useMemo(
    () =>
      pages && !hasNextPage
        ? pages.pages
            .flatMap((page) => page.items)
            // Kept only to be deleted from the Files page.
            .filter((item) => !item.lostAccess)
        : undefined,
    [pages, hasNextPage]
  );
  return { materials, readAt: dataUpdatedAt };
}

/** The workspace's films for the film cards and the Misc panel's Film
 * (Epo 2026-11-27), every page, as the board's links carry them: `undefined`
 * until the last page is in. */
export function useCanvasFilms(workspaceId: string) {
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useOwnedFiles({
      kinds: ['film'],
      scope: 'member',
      workspaceIds: [workspaceId],
    });
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);
  return useMemo(
    () =>
      data && !hasNextPage
        ? data.pages
            .flatMap((page) => page.items)
            .filter((file) => !file.lostAccess)
            .map(
              ({ id, name }): LinkMaterial => ({
                id,
                kind: 'film',
                title: name,
              })
            )
        : undefined,
    [data, hasNextPage]
  );
}

type LinkMaterial = NonNullable<
  ReturnType<WorkspaceLinks['materials']>
>[number];
type Made = { at: number; material: LinkMaterial };

/** The quizzes and sets New made in this tab, each with when, by the list that
 * reads them (a workspace's id, '' for the account's): listed until that list
 * is read after the create, which then keeps or drops each (one deleted
 * meanwhile reads as gone). A canvas left and opened again before that read
 * still runs their cards. Not in the query cache: a list row needs fields
 * (size, topic name, a set's dates) no create returns. */
const madeHere = new Map<string, Made[]>();
const NONE: Made[] = [];

/** Another account signed in, or none: what this one made goes with its
 * query cache. */
export const forgetMadeMaterials = () => madeHere.clear();

/** `listed` with what `made` adds to it. */
function withMade(listed: LinkMaterial[] | undefined, made: LinkMaterial[]) {
  if (!listed) return listed;
  const extra = made.filter(({ id }) => !listed.some((item) => item.id === id));
  return extra.length ? [...listed, ...extra] : listed;
}

/** What the board borrows for its cards: the board mounts once and reads the
 * latest of these when it needs them, and its cards redraw only when the list
 * changes, not on each render of the page. A quiz or set New made is listed
 * from the moment the create returns, before the list's next read holds it:
 * its card runs and opens rather than reading as gone while the list catches
 * up. `materials` is that list, for the page's cards. */
export function useCanvasLinks({
  account = false,
  create,
  materials,
  open,
  readAt,
  workspaceId = '',
}: Omit<WorkspaceLinks, 'materials'> & {
  materials: LinkMaterial[] | undefined;
  /** When `materials` was read (`useCanvasMaterials`). */
  readAt: number;
  /** The workspace whose list `materials` is; none for the account's. */
  workspaceId?: string;
}) {
  const [, setMadeSeen] = useState(0);
  const made = madeHere.get(workspaceId) ?? NONE;
  // A read after the create has it or not: the list decides from then on.
  useEffect(() => {
    const held = madeHere.get(workspaceId);
    if (!(materials && held)) return;
    const left = held.filter(({ at }) => at >= readAt);
    if (left.length === held.length) return;
    madeHere.set(workspaceId, left);
    setMadeSeen((n) => n + 1);
  }, [materials, readAt, workspaceId]);
  const listed = useMemo(
    () =>
      withMade(
        materials,
        made.map(({ material }) => material)
      ),
    [materials, made]
  );
  const latest = useRef({ create, materials: listed, open });
  const board = useRef<CanvasBoard | null>(null);
  useEffect(() => {
    latest.current.materials = listed;
    board.current?.refreshCards();
  }, [listed]);
  useEffect(() => {
    latest.current.create = create;
    latest.current.open = open;
  }, [create, open]);
  const links = useMemo<WorkspaceLinks>(
    () => ({
      account,
      create: async (kind) => {
        const item = await latest.current.create(kind);
        const entry = { id: item.id, kind, title: item.title };
        // After the create's own invalidation started the list's next read.
        madeHere.set(workspaceId, [
          ...(madeHere.get(workspaceId) ?? NONE),
          { at: Date.now(), material: entry },
        ]);
        // The board places its card as this returns, before React renders.
        latest.current.materials = withMade(latest.current.materials, [entry]);
        setMadeSeen((n) => n + 1);
        return item;
      },
      materials: () => latest.current.materials,
      open: (id, kind) => latest.current.open(id, kind),
    }),
    [account, workspaceId]
  );
  return {
    links,
    materials: listed,
    onBoard: (mounted: CanvasBoard | null) => {
      board.current = mounted;
    },
  };
}

/** A listed quiz or set as the board's links carry it. */
export const linkMaterial = (
  { id, kind, preview, title }: MaterialListItem,
  workspace?: LinkMaterial['workspace']
): LinkMaterial[] =>
  kind === 'quiz' || kind === 'flashcards'
    ? [{ id, kind, preview, title, workspace }]
    : [];

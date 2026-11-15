import { useEffect, useMemo, useRef } from 'react';
import { useOwnedMaterials } from '@/api/hooks';
import type { MaterialListItem } from '@/api/types';
import type { DrawingBoardOptions } from '@/features/blocksuite/drawingBoard';
import type { CanvasBoard } from '@/features/canvas/useCanvasBoard';

type WorkspaceLinks = NonNullable<DrawingBoardOptions['workspace']>;

/** The quizzes and sets a canvas's cards and its Misc panel draw from, every
 * page of them: a card whose material sits past the first page is still listed,
 * and a new title is checked against every existing one. `undefined` until the
 * last page is in, so the cards and the grid load rather than read as gone. A
 * workspace canvas reads its workspace's; the account's Canvas page every one
 * the person can open (Epo 2026-11-13). */
export function useCanvasMaterials(workspaceId?: string) {
  const {
    data: pages,
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
  return useMemo(
    () =>
      pages && !hasNextPage
        ? pages.pages
            .flatMap((page) => page.items)
            // Kept only to be deleted from the Files page.
            .filter((item) => !item.lostAccess)
        : undefined,
    [pages, hasNextPage]
  );
}

type LinkMaterial = NonNullable<
  ReturnType<WorkspaceLinks['materials']>
>[number];

/** What the board borrows for its cards: the board mounts once and reads the
 * latest of these when it needs them, and its cards redraw only when the list
 * changes, not on each render of the page. */
export function useCanvasLinks({
  account = false,
  create,
  materials,
  open,
}: Omit<WorkspaceLinks, 'materials'> & {
  materials: LinkMaterial[] | undefined;
}) {
  const latest = useRef({ create, materials, open });
  const board = useRef<CanvasBoard | null>(null);
  useEffect(() => {
    latest.current.materials = materials;
    board.current?.refreshCards();
  }, [materials]);
  useEffect(() => {
    latest.current.create = create;
    latest.current.open = open;
  }, [create, open]);
  const links = useMemo<WorkspaceLinks>(
    () => ({
      account,
      create: (kind) => latest.current.create(kind),
      materials: () => latest.current.materials,
      open: (id) => latest.current.open(id),
    }),
    [account]
  );
  return {
    links,
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

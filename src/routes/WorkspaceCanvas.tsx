import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useMemo, useRef } from 'react';
import { canvasById, saveCanvas } from '@/api/canvas';
import { qk } from '@/api/client';
import { useCreateMaterial, useOwnedMaterials } from '@/api/hooks';
import { CanvasMaterialCards } from '@/features/canvas/CanvasMaterialCards';
import { useCanvasBoard } from '@/features/canvas/useCanvasBoard';
import { useCanvasPicker } from '@/features/canvas/useCanvasPicker';
import { FileError } from '@/features/files/FileStates';
import type { WorkspaceOpenSearch } from '@/features/materials/openItem';
import { nextGenerateTitle } from '@/features/workspace/generateTitle';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';

type BoardProps = {
  onOpenMaterial: (materialId: string) => void;
  /** The material the workspace's item dialog shows, if any. */
  openMaterialId: string | null;
  workspaceId: string;
  /** For a new quiz's or set's default title. */
  workspaceName: string;
};

/** A member's canvases in the workspace (Epo 2026-11-09,
 * todo-workspace-canvas-storage.md; several since Epo 2026-11-12): the one the
 * URL's `c` names, under the canvas picker the account's Canvas page has. The
 * first is made with the workspace's name. */
export default function WorkspaceCanvas({
  besideBack,
  ...props
}: BoardProps & {
  /** A phone's Back floats on the board's top left: the picker sits after it. */
  besideBack: boolean;
}) {
  const { c } = useSearch({ strict: false }) as WorkspaceOpenSearch;
  const navigate = useNavigate();
  const { boardKey, current, dialogs, gone, none, picker, retry } =
    useCanvasPicker({
      c,
      firstTitle: props.workspaceName,
      show: (id, replace = false) =>
        navigate({
          replace,
          search: (previous) => ({ ...previous, c: id, view: 'canvas' }),
          to: '.',
        }),
      workspaceId: props.workspaceId,
    });
  return (
    // The board's ☰ is the picker's height (32px).
    <div className="relative h-full [--capy-board-menu-size:32px]">
      {current && (
        <CanvasBoard
          {...props}
          gone={() => gone(current.id)}
          id={current.id}
          key={boardKey}
          onRetry={retry}
        />
      )}
      {none && (
        <p className="t-body m-6 pt-14 text-fg-muted">{m.canvas_none()}</p>
      )}
      {picker && (
        // On a phone the row stops short of the board's own menu at the top right.
        <div
          className={cn(
            'absolute top-2 right-12 flex sm:right-auto [&>[data-slot=popover-anchor]]:flex-1 sm:[&>[data-slot=popover-anchor]]:flex-none [[data-workspace-canvas]:has(.capy-board[data-editor-open])_&]:hidden',
            besideBack ? 'left-12' : 'left-2'
          )}
        >
          {picker}
        </div>
      )}
      {dialogs}
    </div>
  );
}

/** One canvas's drawing board (`useCanvasBoard`), with the workspace's quizzes
 * and sets for its cards. */
function CanvasBoard({
  gone,
  id,
  onRetry,
  onOpenMaterial,
  openMaterialId,
  workspaceId,
  workspaceName,
}: BoardProps & { gone: () => boolean; id: string; onRetry: () => void }) {
  const container = useRef<HTMLDivElement>(null);
  // The canvas mounts once and reads the latest of these when it needs them. The
  // Files list carries each quiz's and set's stored preview, for the panel's grid.
  const {
    data: pages,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useOwnedMaterials({
    kinds: ['quiz', 'flashcards'],
    scope: 'member',
    workspaceIds: [workspaceId],
  });
  // Every page: a card whose material sits past the first page is still listed, and
  // a new title is checked against every existing one. Until the last page is in,
  // the list is unknown, and the cards and the grid load rather than read as gone.
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);
  const materials = useMemo(
    () =>
      pages && !hasNextPage
        ? pages.pages.flatMap((page) => page.items)
        : undefined,
    [pages, hasNextPage]
  );
  // The item dialog's saves go through its live room, not the cards' snapshot
  // query: when the dialog closes or moves on, the material it showed is read
  // again by any card in view (a card's own Edit does the same on Done).
  const qc = useQueryClient();
  const lastOpen = useRef(openMaterialId);
  useEffect(() => {
    const previous = lastOpen.current;
    lastOpen.current = openMaterialId;
    if (!previous || previous === openMaterialId) return;
    void qc.invalidateQueries({ queryKey: qk.quiz(previous) });
    void qc.invalidateQueries({ queryKey: qk.material(previous) });
  }, [openMaterialId, qc]);
  const { mutateAsync: createMaterial } = useCreateMaterial(workspaceId);
  const latest = useRef({
    createMaterial,
    materials,
    onOpenMaterial,
    workspaceName,
  });
  const mounted = useRef<{ refreshCards: () => void } | null>(null);
  // Cards redraw only when the list changes, not on each render of the page.
  useEffect(() => {
    latest.current.materials = materials;
    mounted.current?.refreshCards();
  }, [materials]);
  useEffect(() => {
    latest.current.onOpenMaterial = onOpenMaterial;
    latest.current.createMaterial = createMaterial;
    latest.current.workspaceName = workspaceName;
  }, [onOpenMaterial, createMaterial, workspaceName]);
  const failed = useCanvasBoard(
    container,
    {
      key: id,
      open: () => canvasById(id),
      save: (body) => saveCanvas(id, body),
    },
    {
      gone,
      onBoard: (board) => {
        mounted.current = board;
      },
      // Its quiz and flashcard cards (Epo 2026-11-09).
      workspace: {
        // The New tile: an unfiled quiz or set, named as the Create page names
        // one ("Biology 101 quiz 2").
        create: async (kind) => {
          const { materials: current = [], workspaceName: name } =
            latest.current;
          const made = await latest.current.createMaterial({
            kind,
            title: nextGenerateTitle(
              kind,
              name,
              current.map(({ title }) => title)
            ),
          });
          return { id: made.id, title: made.title };
        },
        materials: () =>
          latest.current.materials?.flatMap(({ id, kind, preview, title }) =>
            kind === 'quiz' || kind === 'flashcards'
              ? [{ id, kind, preview, title }]
              : []
          ),
        open: (id) => latest.current.onOpenMaterial(id),
      },
    }
  );
  // The placed quizzes and sets run in the page's own tree, through portals into the
  // board's card hosts (Epo 2026-11-09).
  const listed = useMemo(
    () => materials && new Set(materials.map(({ id }) => id)),
    [materials]
  );
  return (
    <div
      className="h-full w-full overflow-hidden rounded-card-xl [&>div]:h-full"
      ref={container}
    >
      {/* Reopening the canvas tries again. */}
      {failed && <FileError message={failed} onRetry={onRetry} />}
      <CanvasMaterialCards listed={listed} workspaceId={workspaceId} />
    </div>
  );
}

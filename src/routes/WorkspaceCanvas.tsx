import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef } from 'react';
import { saveWorkspaceCanvas, workspaceCanvas } from '@/api/canvas';
import { qk } from '@/api/client';
import { useCreateMaterial, useOwnedMaterials } from '@/api/hooks';
import { CanvasMaterialCards } from '@/features/canvas/CanvasMaterialCards';
import { useCanvasBoard } from '@/features/canvas/useCanvasBoard';
import { nextGenerateTitle } from '@/features/workspace/generateTitle';

/** A member's own canvas in the workspace (Epo 2026-11-09,
 * todo-workspace-canvas-storage.md): the drawing board over their canvas
 * material (`useCanvasBoard`), with the workspace's quizzes and sets for its
 * cards. */
export default function WorkspaceCanvas({
  onOpenMaterial,
  openMaterialId,
  workspaceId,
  workspaceName,
}: {
  onOpenMaterial: (materialId: string) => void;
  /** The material the workspace's item dialog shows, if any. */
  openMaterialId: string | null;
  workspaceId: string;
  /** For a new quiz's or set's default title. */
  workspaceName: string;
}) {
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
  // Editing happens in the item dialog, whose saves go through its live room, not
  // the card's snapshot query: when the dialog closes or moves on, the material it
  // showed is read again by any card in view.
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
      key: workspaceId,
      open: () => workspaceCanvas(workspaceId),
      save: (body) => saveWorkspaceCanvas(workspaceId, body),
    },
    {
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
      {failed && (
        <p className="t-body m-6 text-fg-muted" role="alert">
          {failed}
        </p>
      )}
      <CanvasMaterialCards listed={listed} workspaceId={workspaceId} />
    </div>
  );
}

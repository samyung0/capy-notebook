import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useMemo, useRef } from 'react';
import { qk } from '@/api/client';
import { useCreateMaterial } from '@/api/hooks';
import { BoardPresenceMarks } from '@/features/canvas/BoardPresenceMarks';
import {
  CanvasBoardPanel,
  CanvasBoardStrip,
  CanvasOpening,
} from '@/features/canvas/CanvasBoardStates';
import { CanvasMaterialCards } from '@/features/canvas/CanvasMaterialCards';
import { useCanvasBoard } from '@/features/canvas/useCanvasBoard';
import {
  linkMaterial,
  useCanvasFilms,
  useCanvasLinks,
  useCanvasMaterials,
} from '@/features/canvas/useCanvasMaterials';
import { useCanvasPicker } from '@/features/canvas/useCanvasPicker';
import type { WorkspaceOpenSearch } from '@/features/materials/openItem';
import { usePlaneEditor } from '@/features/questions/PlaneEditorHost';
import { nextGenerateTitle } from '@/features/workspace/generateTitle';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { useOpenLink } from '@/lib/openLink';

type BoardProps = {
  /** A film card's Open: the file viewer. */
  onOpenFile: (fileId: string) => void;
  onOpenMaterial: (materialId: string) => void;
  /** The material the workspace's item dialog shows, if any. */
  openMaterialId: string | null;
  workspaceId: string;
  /** For a new quiz's or set's default title. */
  workspaceName: string;
};

/** A member's canvases in the workspace and the other members' shared ones
 * (Epo 2026-11-09, todo-workspace-canvas-storage.md; several since Epo
 * 2026-11-12; shared since Epo 2026-11-18): the one the URL's `c` names, under
 * the canvas picker the account's Canvas page has. A member's first is made
 * with the workspace's name. */
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
      {!(current || none) && <CanvasOpening />}
      {picker && (
        // The row stops 8px short of the board's status and ☰ at the top right
        // (--capy-board-chrome, useCanvasBoard): a phone's picker fills it, a
        // wider screen's shrinks into it.
        <div
          className={cn(
            'absolute top-2 right-[calc(var(--capy-board-chrome,32px)+16px)] flex sm:right-auto [&>[data-slot=popover-anchor]]:min-w-0 [&>[data-slot=popover-anchor]]:flex-1 sm:[&>[data-slot=popover-anchor]]:flex-initial [[data-workspace-canvas]:has(.capy-board[data-editor-open])_&]:hidden',
            besideBack
              ? 'left-12 sm:max-w-[calc(100%-var(--capy-board-chrome,32px)-64px)]'
              : 'left-2 sm:max-w-[calc(100%-var(--capy-board-chrome,32px)-24px)]'
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
  onOpenFile,
  onOpenMaterial,
  openMaterialId,
  workspaceId,
  workspaceName,
}: BoardProps & { gone: () => boolean; id: string; onRetry: () => void }) {
  const container = useRef<HTMLDivElement>(null);
  const { open } = useSearch({ strict: false }) as WorkspaceOpenSearch;
  const navigate = useNavigate();
  const link = useOpenLink(
    open,
    (next, replace) =>
      void navigate({
        replace,
        search: (previous) => ({ ...previous, open: next }),
        to: '.',
      })
  );
  const { materials, readAt } = useCanvasMaterials(workspaceId);
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
  const films = useCanvasFilms(workspaceId);
  const linked = useMemo(
    () =>
      materials &&
      films && [...materials.flatMap((item) => linkMaterial(item)), ...films],
    [materials, films]
  );
  // Its quiz, flashcard and film cards (Epo 2026-11-09, 2026-11-27).
  const {
    links,
    materials: listed,
    onBoard,
  } = useCanvasLinks({
    // The New tile: an unfiled quiz or set, named as the Create page names
    // one ("Biology 101 quiz 2"), past one just made too.
    create: async (kind) => {
      const made = await createMaterial({
        kind,
        title: nextGenerateTitle(
          kind,
          workspaceName,
          (links.materials() ?? []).map(({ title }) => title)
        ),
      });
      return { id: made.id, title: made.title };
    },
    materials: linked,
    open: (id, kind) => (kind === 'film' ? onOpenFile(id) : onOpenMaterial(id)),
    readAt,
    workspaceId,
  });
  const { openPlane, planeEditor } = usePlaneEditor();
  const state = useCanvasBoard(container, id, {
    gone,
    link,
    onBoard,
    openPlane,
    workspace: links,
  });
  // The placed quizzes and sets run in the page's own tree, through portals into the
  // board's card hosts (Epo 2026-11-09).
  return (
    <>
      <div
        className="h-full w-full overflow-hidden rounded-card-xl [&>div]:h-full"
        ref={container}
      >
        {/* Reopening the canvas tries again. */}
        <CanvasBoardPanel onRetry={onRetry} state={state} />
        <CanvasMaterialCards link={link} materials={listed} />
        <BoardPresenceMarks presence={state.presence} />
        {planeEditor}
      </div>
      <CanvasBoardStrip strip={state.strip} />
    </>
  );
}

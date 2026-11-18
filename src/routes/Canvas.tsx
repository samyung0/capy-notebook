import { useNavigate, useSearch } from '@tanstack/react-router';
import { useMemo, useRef, useState } from 'react';
import {
  useCreateFlashcardSet,
  useCreateQuiz,
  useWorkspaces,
} from '@/api/hooks';
import { PagePanel } from '@/components/app/layout';
import { userToast } from '@/components/ui/userToast';
import { BoardPresenceMarks } from '@/features/canvas/BoardPresenceMarks';
import {
  CanvasBoardPanel,
  CanvasBoardStrip,
  CanvasOpening,
} from '@/features/canvas/CanvasBoardStates';
import { CanvasMaterialCards } from '@/features/canvas/CanvasMaterialCards';
import {
  CanvasMaterialDialog,
  type DialogMaterial,
} from '@/features/canvas/CanvasMaterialDialog';
import { useCanvasBoard } from '@/features/canvas/useCanvasBoard';
import {
  linkMaterial,
  useCanvasLinks,
  useCanvasMaterials,
} from '@/features/canvas/useCanvasMaterials';
import { useCanvasPicker } from '@/features/canvas/useCanvasPicker';
import { m } from '@/i18n';
import { useOpenLink } from '@/lib/openLink';

/** One of the person's own canvases as the page's board, in its room as a
 * workspace's is, with no workspace. Its cards are every quiz and set the person
 * can open, each tile in Misc saying its workspace; New makes one in no
 * workspace, and a card opens in a dialog (Epo 2026-11-13, mock
 * DnhMYffHEjdxiUansbBDde A + W1). */
function OwnCanvas({
  gone,
  id,
  onRetry,
}: {
  gone: () => boolean;
  id: string;
  onRetry: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const { open } = useSearch({ from: '/auth-shell/canvas' });
  const navigate = useNavigate();
  const link = useOpenLink(
    open,
    (next, replace) =>
      void navigate({
        replace,
        search: (previous) => ({ ...previous, open: next }),
        to: '/canvas',
      }),
    () => userToast({ title: m.canvas_open_gone() })
  );
  const materials = useCanvasMaterials();
  const { data: workspaces } = useWorkspaces();
  const linked = useMemo(() => {
    const icons = new Map(workspaces?.map(({ id, iconId }) => [id, iconId]));
    return materials?.flatMap((item) =>
      linkMaterial(
        item,
        item.workspaceId
          ? { iconId: icons.get(item.workspaceId), name: item.workspaceName }
          : undefined
      )
    );
  }, [materials, workspaces]);
  const { mutateAsync: createQuiz } = useCreateQuiz();
  const { mutateAsync: createSet } = useCreateFlashcardSet();
  const [editing, setEditing] = useState<DialogMaterial | null>(null);
  // What New just made, which the list does not hold yet.
  const made = useRef<DialogMaterial | null>(null);
  const { links, onBoard } = useCanvasLinks({
    account: true,
    // Quiz 1, Quiz 2…: the first number no listed one has.
    create: async (kind) => {
      const taken = new Set(materials?.map(({ title }) => title));
      const title = (n: number) =>
        kind === 'quiz'
          ? m.drawing_board_new_quiz_title({ n })
          : m.drawing_board_new_set_title({ n });
      let n = 1;
      while (taken.has(title(n))) n++;
      const { id, name } =
        kind === 'quiz'
          ? await createQuiz({ name: title(n) })
          : await createSet({ name: title(n) });
      made.current = { id, kind, title: name };
      return { id, title: name };
    },
    materials: linked,
    // A card's header opens a listed one, New the one it made: the dialog needs
    // no read of its own to know which editor to show.
    open: (materialId) => {
      const known =
        made.current?.id === materialId
          ? made.current
          : linked?.find(({ id }) => id === materialId);
      // A card whose quiz or set is not listed (gone, or the list is still
      // loading) says so itself and opens nothing.
      if (!known) return;
      setEditing({ id: known.id, kind: known.kind, title: known.title });
    },
  });
  const state = useCanvasBoard(container, id, {
    gone,
    link,
    onBoard,
    workspace: links,
  });
  return (
    <>
      <div
        className="h-full w-full overflow-hidden [&>div]:h-full"
        ref={container}
      >
        <CanvasBoardPanel onRetry={onRetry} state={state} />
        <CanvasMaterialCards link={link} materials={materials} />
        <BoardPresenceMarks presence={state.presence} />
        <CanvasMaterialDialog
          material={editing}
          onClose={() => setEditing(null)}
        />
      </div>
      <CanvasBoardStrip strip={state.strip} />
    </>
  );
}

/** The account's Canvas page (Epo 2026-11-10, mock KNPB4pYUhSSYUJvuKN1ct7 B):
 * the page is a board, one of the person's own canvases in no workspace, with
 * the canvas picker at the top left (`useCanvasPicker`), which also lists their
 * workspaces' canvases; one of those opens in its workspace. */
export default function CanvasPage() {
  const { c } = useSearch({ from: '/auth-shell/canvas' });
  const navigate = useNavigate();
  const { boardKey, current, dialogs, gone, none, picker, retry } =
    useCanvasPicker({
      c,
      firstTitle: m.canvas_first_title(),
      openOther: (canvas) =>
        void navigate({
          params: { workspaceId: canvas.workspaceId ?? '' },
          search: { c: canvas.id, view: 'canvas' },
          to: '/workspaces/$workspaceId',
        }),
      show: (id, replace = false) =>
        navigate({ replace, search: { c: id }, to: '/canvas' }),
    });

  // In the page panel every account page has, without its phone row: the board
  // fills the panel (Epo 2026-11-12).
  return (
    <PagePanel fill phoneRow={false}>
      {/* The board and the picker over it, level with its ☰ (32px); an open card
          hides the picker, as on a workspace's canvas. */}
      <div
        className="relative min-h-0 flex-1 [--capy-board-menu-size:32px]"
        data-canvas-board
      >
        {current && (
          <OwnCanvas
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
          // On a phone the row stops short of the board's own menu at the top right.
          <div className="absolute top-2 right-12 left-2 flex sm:right-auto [&>[data-slot=popover-anchor]]:flex-1 sm:[&>[data-slot=popover-anchor]]:flex-none [[data-canvas-board]:has(.capy-board[data-editor-open])_&]:hidden">
            {picker}
          </div>
        )}
      </div>
      {dialogs}
    </PagePanel>
  );
}

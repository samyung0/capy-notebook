import { useNavigate, useSearch } from '@tanstack/react-router';
import { useRef } from 'react';
import { canvasById, saveCanvas } from '@/api/canvas';
import { PagePanel } from '@/components/app/layout';
import { useCanvasBoard } from '@/features/canvas/useCanvasBoard';
import { useCanvasPicker } from '@/features/canvas/useCanvasPicker';
import { FileError } from '@/features/files/FileStates';
import { m } from '@/i18n';

/** One of the person's own canvases as the page's board, saved as a
 * workspace's is, with no workspace. */
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
      className="h-full w-full overflow-hidden [&>div]:h-full"
      ref={container}
    >
      {failed && <FileError message={failed} onRetry={onRetry} />}
    </div>
  );
}

/** The account's Canvas page (Epo 2026-11-10, mock KNPB4pYUhSSYUJvuKN1ct7 B):
 * the page is a board, one of the person's own canvases in no workspace, with
 * the canvas picker at the top left (`useCanvasPicker`), which also lists their
 * workspaces' canvases; one of those opens in its workspace, where its quiz and
 * flashcard cards work. */
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
          search: { c: canvas.id, panel: 'canvas' },
          to: '/workspaces/$workspaceId',
        }),
      show: (id, replace = false) =>
        navigate({ replace, search: { c: id }, to: '/canvas' }),
    });

  // In the page panel every account page has, without its phone row: the board
  // fills the panel (Epo 2026-11-12).
  return (
    <PagePanel fill phoneRow={false}>
      {/* The board and the picker over it, level with its ☰ (32px). */}
      <div className="relative min-h-0 flex-1 [--capy-board-menu-size:32px]">
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
        {picker && (
          // On a phone the row stops short of the board's own menu at the top right.
          <div className="absolute top-2 right-12 left-2 flex sm:right-auto [&>[data-slot=popover-anchor]]:flex-1 sm:[&>[data-slot=popover-anchor]]:flex-none">
            {picker}
          </div>
        )}
      </div>
      {dialogs}
    </PagePanel>
  );
}

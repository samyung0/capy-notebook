import {
  type ReactNode,
  Suspense,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { IconButton } from '@/components/ui/IconButton';
import { boardFromAsset } from '@/features/blocksuite/boardAsset';
import {
  boardCode,
  DrawingBoardScreen,
  useCodeFailed,
} from '@/features/materials/blockCode';
import { CannotShow } from '@/features/materials/CannotShow';
import { AssetUrlContext } from '@/features/materials/MediaAssetView';
import { CanvasPicture } from '@/features/questions/QuestionView';
import type { CanvasBlock } from '@/features/questions/types';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import type { PinnedQuestion } from './DrawingBoardScreen';
import { drawingPreviewUrl } from './DrawingPreview';

/** A board kept as a quiz's `board` editor asset (a drawn canvas, a drawn
 * sample answer), base64, once fetched: `board` is null while it loads or
 * when there is none, and `failed` says its fetch failed (asked again on the
 * next mount). A shared page names where its assets load from
 * (`AssetUrlContext`), the signed-in resolve being refused there. Fetched in
 * the browser only. */
export function useBoardAsset(id: string | undefined) {
  const assetUrl = useContext(AssetUrlContext);
  const url = id ? assetUrl?.(id) : undefined;
  const [held, setHeld] = useState<{ board: string | null; id: string } | null>(
    null
  );
  useEffect(() => {
    if (!id) return;
    let live = true;
    boardFromAsset(id, url).then(
      (board) => live && setHeld({ board, id }),
      () => live && setHeld({ board: null, id })
    );
    return () => {
      live = false;
    };
  }, [id, url]);
  const here = held?.id === id ? held : null;
  return { board: here?.board ?? null, failed: here?.board === null };
}

/** `value` as it was once `open` and `ready`, kept until it closes, else
 * null: a board open full screen keeps the boards it opened from while the
 * block under it changes (a co-editor's Done), so it is not closed or
 * reloaded, and its own Done, the later one, wins (Epo 2026-11-23). */
export function useHeldWhileOpen<T>(open: boolean, ready: boolean, value: T) {
  const [held, setHeld] = useState<{ value: T } | null>(null);
  if (open && ready && !held) setHeld({ value });
  if (!open && held) setHeld(null);
  return open ? held : null;
}

/** A drawn canvas's board asset; none for an empty canvas. */
export const canvasBoard = (block: CanvasBlock) =>
  'board' in block ? block.board : undefined;

/**
 * A canvas as a quiz shows it (Epo 2026-11-23, E1, S1): its area, 16:10 as
 * the board's is, at the column's width. Drawn (`drawn`), it is the board
 * drawn as previews draw it, on white, `board` being what to draw once here;
 * empty, the board's dots with `placeholder`. `children` sit over it: its
 * buttons.
 */
export function CanvasFrame({
  board,
  children,
  drawn,
  label,
  placeholder,
}: {
  board: string | null;
  children?: ReactNode;
  drawn: boolean;
  /** What the drawn canvas is, for screen readers. */
  label: string;
  placeholder?: string;
}) {
  // At about a wide column's size; the picture scales with it.
  const src = useMemo(
    () => (board ? drawingPreviewUrl(board, 960, 600, 0, true) : null),
    [board]
  );
  return (
    <div
      className={cn(
        'relative aspect-[8/5] w-full overflow-hidden border border-line',
        drawn ? 'bg-white' : 'canvas-dots bg-surface'
      )}
    >
      {board &&
        (src ? (
          <img alt={label} className="block size-full" src={src} />
        ) : (
          <p className="t-meta absolute inset-0 grid place-items-center text-fg-muted">
            {m.drawing_answer_unreadable()}
          </p>
        ))}
      {!drawn && placeholder && (
        <span className="absolute inset-0 grid place-items-center text-fg-muted">
          {placeholder}
        </span>
      )}
      {children}
    </div>
  );
}

/**
 * A canvas a student only looks at (S3): any part's but the Canvas part's
 * own, which is answered on. Drawn, it has Open canvas at its top right, the
 * whole board read only to pan and zoom; empty, it shows nothing. A board
 * that could not be fetched says it cannot be shown.
 */
export function CanvasView({
  block,
  pinned,
}: {
  block: CanvasBlock;
  pinned: PinnedQuestion;
}) {
  const id = canvasBoard(block);
  const { board, failed: lost } = useBoardAsset(id);
  const [open, setOpen] = useState(false);
  const failed = useCodeFailed(boardCode);
  if (!id) return null;
  return (
    <CanvasFrame board={board} drawn label={m.question_ui_canvas()}>
      {lost ? (
        <CannotShow className="absolute top-2 right-2 rounded-input bg-surface px-2 py-1" />
      ) : (
        board &&
        !failed && (
          <IconButton
            className="absolute top-2 right-2"
            icon="maximize"
            label={m.question_canvas_open()}
            onClick={() => setOpen(true)}
            size="sm"
            tooltip
            variant="outline"
          />
        )
      )}
      {open && board && !failed && (
        <Suspense fallback={null}>
          <DrawingBoardScreen
            onClose={() => setOpen(false)}
            pinned={pinned}
            readOnly
            saved={board}
          />
        </Suspense>
      )}
    </CanvasFrame>
  );
}

/** A canvas as the quiz editor's closed card and its stray places show it:
 * drawn, its stored picture (exactly its area) at the open card's width, so
 * no board is fetched or drawn for it; empty, with "Start drawing". */
export function CanvasPreview({ block }: { block: CanvasBlock }) {
  return 'board' in block ? (
    <CanvasPicture className="max-w-full" image={block.image} />
  ) : (
    <CanvasFrame
      board={null}
      drawn={false}
      label={m.question_ui_canvas()}
      placeholder={m.question_canvas_start_drawing()}
    />
  );
}

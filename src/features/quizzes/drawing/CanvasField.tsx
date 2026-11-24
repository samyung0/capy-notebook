import { Suspense, useState } from 'react';
import { Button } from '@/components/ui/Button';
import {
  boardFromAsset,
  rememberBoardAsset,
} from '@/features/blocksuite/boardAsset';
import {
  boardCode,
  DrawingBoardScreen,
  useCodeFailed,
} from '@/features/materials/blockCode';
import { CannotShow } from '@/features/materials/CannotShow';
import { assetLink } from '@/features/materials/resolvedAssetLinks';
import type { CanvasBlock } from '@/features/questions/types';
import { m } from '@/i18n';
import { useBoardAhead } from './boardPrefetch';
import {
  CanvasFrame,
  canvasBoard,
  useBoardAsset,
  useHeldWhileOpen,
} from './CanvasFrame';
import type { PinnedQuestion } from './DrawingBoardScreen';
import type { UploadDrawnSample } from './DrawnSample';

/**
 * A canvas block in the quiz editor (Epo 2026-11-23, E1, E2, E4): the canvas
 * drawn from its board, or the empty one with "Start drawing", and Edit canvas
 * at its top right, which opens the teacher's board full screen, its area
 * movable (E3). Done stores the board and its picture as the quiz's assets and
 * hands back the drawn block, or the empty one for an emptied board; the later
 * Done wins: an open board keeps the canvas it opened from while a co-editor's
 * Done changes the block under it. `hint` under it says what goes in it: a
 * Canvas part's own canvas's, or the stem's or a group's. If the board's code
 * or the canvas's board could not load, Edit canvas is "This block cannot be
 * shown".
 */
export function CanvasField({
  block,
  hint,
  onChange,
  pinned,
  tools,
  upload,
}: {
  block: CanvasBlock;
  hint?: string;
  onChange: (block: CanvasBlock) => void;
  pinned: PinnedQuestion;
  /** The block's own tools (move, remove), at the end of the row under it. */
  tools?: React.ReactNode;
  upload: UploadDrawnSample;
}) {
  const id = canvasBoard(block);
  const { board, failed: lost } = useBoardAsset(id);
  const [open, setOpen] = useState(false);
  // A drawn canvas opens once its board is here.
  const here = !id || !!board;
  const opened = useHeldWhileOpen(open, here, board ?? undefined);
  // The board's code loads in idle time; the board mounts on Edit canvas,
  // leaving the page's one board ahead to a sample answer.
  useBoardAhead(false);
  const codeFailed = useCodeFailed(boardCode);
  const failed = codeFailed || (lost && !opened);
  return (
    <div className="flex flex-col gap-1.5">
      <CanvasFrame
        board={board}
        drawn={!!id}
        label={m.question_ui_canvas()}
        placeholder={m.question_canvas_start_drawing()}
      >
        {failed ? (
          <CannotShow className="absolute top-2 right-2 rounded-input bg-surface px-2 py-1" />
        ) : (
          <Button
            className="absolute top-2 right-2"
            disabled={!here}
            iconLeft="pencil"
            onClick={() => setOpen(true)}
            size="sm"
            type="button"
            variant="outline"
          >
            {m.question_canvas_edit()}
          </Button>
        )}
      </CanvasFrame>
      {(hint || tools) && (
        <div className="flex min-h-(--toolbar-button) items-center gap-2">
          {hint && (
            <p className="t-meta min-w-0 flex-1 text-fg-muted">{hint}</p>
          )}
          {tools}
        </div>
      )}
      {opened && !codeFailed && (
        <Suspense fallback={null}>
          <DrawingBoardScreen
            canvas
            onClose={() => setOpen(false)}
            onDone={() => setOpen(false)}
            pinned={pinned}
            saved={opened.value}
            store={async (value) => {
              if (!value) {
                onChange({ type: 'canvas' });
                return null;
              }
              const stored = await upload(value);
              // Its board is already here: no fetch back.
              rememberBoardAsset(stored.board, value.board);
              onChange({ ...stored, type: 'canvas' });
              return null;
            }}
          />
        </Suspense>
      )}
    </div>
  );
}

/** Whether a canvas kept for the tab still loads, its board and its picture
 * (an empty one has neither): the server trashes the assets a quiz's saves
 * stop naming and purges them a day later. A board or link this page already
 * holds counts as loaded. */
export async function canvasLoads(block: CanvasBlock): Promise<boolean> {
  if (!('board' in block)) return true;
  try {
    await Promise.all([
      boardFromAsset(block.board),
      assetLink(block.image, new AbortController().signal, false),
    ]);
    return true;
  } catch {
    return false;
  }
}

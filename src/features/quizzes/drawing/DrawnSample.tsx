import { Suspense, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import {
  boardFile,
  gzipBoard,
  rememberBoardAsset,
} from '@/features/blocksuite/boardAsset';
import {
  boardCode,
  DrawingBoardScreen,
  useCodeFailed,
} from '@/features/materials/blockCode';
import { CannotShow } from '@/features/materials/CannotShow';
import type { DrawnSample } from '@/features/questions/types';
import { m } from '@/i18n';
import { useBoardAhead } from './boardPrefetch';
import { useBoardAsset, useHeldWhileOpen } from './CanvasFrame';
import type { PinnedQuestion } from './DrawingBoardScreen';
import { DrawingPreview } from './DrawingPreview';
import type { DrawingValue } from './drawingValue';

/** Stores a drawn board, a sample answer's or a canvas's, as the quiz's own
 * assets and returns them. */
export type UploadDrawnSample = (value: DrawingValue) => Promise<DrawnSample>;

/** A quiz's drawn board upload (a sample answer, Q3; a canvas, Epo
 * 2026-11-23): the board gzipped as a `board` asset, beside its image as an
 * ordinary quiz image. */
export function quizSampleUpload(quizId: string): UploadDrawnSample {
  return async ({ board, image }) => {
    // Its module holds the upload code, which learners never load.
    const { uploadEditorAsset } = await import('@/api/editorAssets');
    const packed = await gzipBoard(board);
    const picture = await (await fetch(image)).blob();
    const [stored, shown] = await Promise.all([
      uploadEditorAsset(quizId, boardFile(packed, 'sample.ydoc.gz'), 'board'),
      uploadEditorAsset(
        quizId,
        new File([picture], 'sample-answer', { type: picture.type }),
        'image'
      ),
    ]);
    return { board: stored.assetId, image: shown.assetId };
  };
}

/**
 * A canvas part's optional drawn sample answer in the quiz editor, in its own
 * Sample answer section (Epo 2026-11-15): the drawing and Edit sample answer,
 * or Draw sample answer while there is none. Either opens the full board for
 * the author with the question pinned (A3); Done stores it, and Done on an
 * emptied board removes it. A new sample starts as a copy of the part's canvas
 * as it is then (`question`, its board asset), the canvas's parts held as on a
 * student's board, with no sync after (Epo 2026-11-23). Open, the board keeps
 * the boards it opened from while a co-editor's Done changes the sample or the
 * canvas, so its own Done, the later one, wins. The board's open state may be
 * held outside, where a menu opens it directly. If the board's code, or a
 * board it opens from, could not load, the button is "This block cannot be
 * shown" and the field closes.
 */
export function DrawnSampleField({
  defaultOpen = false,
  onChange,
  onOpenChange,
  open: openProp,
  pinned,
  question,
  sample,
  upload,
}: {
  defaultOpen?: boolean;
  onChange: (sample: DrawnSample | undefined) => void;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  pinned: PinnedQuestion;
  /** The part's drawn canvas's board asset; none for an empty canvas. */
  question: string | undefined;
  sample: DrawnSample | undefined;
  upload: UploadDrawnSample;
}) {
  const [openState, setOpenState] = useState(defaultOpen);
  const open = openProp ?? openState;
  const setOpen = (next: boolean) => {
    setOpenState(next);
    onOpenChange?.(next);
  };
  const { board, failed: sampleLost } = useBoardAsset(sample?.board);
  const { board: canvas, failed: canvasLost } = useBoardAsset(question);
  // Either board, the sample's or the canvas it starts from, is here first.
  const here = (!sample || !!board) && (!question || !!canvas);
  const live = { question: canvas ?? undefined, saved: board ?? undefined };
  const opened = useHeldWhileOpen(open, here, live);
  // Mounted ahead once its boards are here; open, as it opened.
  const ahead = useBoardAhead(here);
  const boards = opened?.value ?? live;
  const codeFailed = useCodeFailed(boardCode);
  const failed = codeFailed || ((sampleLost || canvasLost) && !opened);
  // A board that could not load closes, telling whoever holds the open state.
  useEffect(() => {
    if (failed && open) setOpen(false);
  }, [failed, open]);
  const button = failed ? (
    <CannotShow />
  ) : (
    <Button
      disabled={!here}
      iconLeft="pencil"
      onClick={() => setOpen(true)}
      variant="outline"
    >
      {sample ? m.drawing_sample_edit() : m.drawing_sample_draw()}
    </Button>
  );
  return (
    <>
      {sample ? (
        <div className="flex flex-col items-start gap-2">
          {board && <DrawingPreview board={board} />}
          {button}
        </div>
      ) : (
        <div>{button}</div>
      )}
      {(opened || (ahead && here)) && !failed && (
        <Suspense fallback={null}>
          <DrawingBoardScreen
            hidden={!open}
            noPictures
            onClose={() => setOpen(false)}
            onDone={() => setOpen(false)}
            pinned={{
              ...pinned,
              title: `${m.question_ui_sample_answer_heading()} · ${pinned.short || pinned.title}`,
            }}
            question={boards.question}
            saved={boards.saved}
            store={async (value) => {
              if (!value) {
                onChange(undefined);
                return null;
              }
              const stored = await upload(value);
              // Its board is already here: no fetch back.
              rememberBoardAsset(stored.board, value.board);
              onChange(stored);
              return null;
            }}
          />
        </Suspense>
      )}
    </>
  );
}

/** A checked canvas part's sample answer, drawn from its board (R1), or
 * "This block cannot be shown" when its board could not be fetched. */
export function DrawnSampleView({ sample }: { sample: DrawnSample }) {
  const { board, failed } = useBoardAsset(sample.board);
  if (failed) return <CannotShow />;
  return board ? <DrawingPreview board={board} /> : null;
}

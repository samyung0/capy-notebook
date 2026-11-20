import { Suspense, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import {
  boardFile,
  boardFromAsset,
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
import type { PinnedQuestion } from './DrawingBoardScreen';
import { DrawingPreview } from './DrawingPreview';
import type { DrawingValue } from './drawingValue';

/** Stores a drawn sample answer as the quiz's own assets and returns them. */
export type UploadDrawnSample = (value: DrawingValue) => Promise<DrawnSample>;

/** A quiz's drawn sample answer upload (Q3): the board gzipped as a `board`
 * asset, beside its image as an ordinary quiz image. */
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

/** A drawn sample answer's board, base64, once fetched; null while it loads,
 * or when there is none or it can't be read. Fetched in the browser only. */
export function useSampleBoard(sample: DrawnSample | undefined) {
  const id = sample?.board;
  const [held, setHeld] = useState<{ board: string; id: string } | null>(null);
  useEffect(() => {
    if (!id) return;
    let live = true;
    boardFromAsset(id)
      .then((board) => live && setHeld({ board, id }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [id]);
  return held && held.id === id ? held.board : null;
}

/**
 * A drawing part's optional drawn sample answer in the quiz editor and the
 * question dialog, in its own Sample answer section (Epo 2026-11-15): the
 * drawing and Edit sample answer, or Draw sample answer while there is none. Either opens the full board for the author with the question
 * pinned (A3); Done stores it, and Done on an emptied board removes it. The
 * board's open state may be held outside, where a menu opens it directly. If
 * the board's code could not load, the button is "This block cannot be shown"
 * and the field closes.
 */
export function DrawnSampleField({
  defaultOpen = false,
  onChange,
  onOpenChange,
  open: openProp,
  pinned,
  sample,
  upload,
}: {
  defaultOpen?: boolean;
  onChange: (sample: DrawnSample | undefined) => void;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  pinned: PinnedQuestion;
  sample: DrawnSample | undefined;
  upload: UploadDrawnSample;
}) {
  const [openState, setOpenState] = useState(defaultOpen);
  const open = openProp ?? openState;
  const setOpen = (next: boolean) => {
    setOpenState(next);
    onOpenChange?.(next);
  };
  const board = useSampleBoard(sample);
  // An existing sample is mounted ahead once its board is here.
  const ahead = useBoardAhead(!sample || !!board);
  const failed = useCodeFailed(boardCode);
  // A board that could not load closes, telling whoever holds the open state.
  useEffect(() => {
    if (failed && open) setOpen(false);
  }, [failed, open]);
  const button = failed ? (
    <CannotShow />
  ) : (
    <Button
      // An existing sample opens once its board is here.
      disabled={!!sample && !board}
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
      {(open || ahead) && !failed && (
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
            saved={board ?? undefined}
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

/** A checked drawing part's sample answer, drawn from its board (R1). */
export function DrawnSampleView({ sample }: { sample: DrawnSample }) {
  const board = useSampleBoard(sample);
  return board ? <DrawingPreview board={board} /> : null;
}

import { Suspense, useContext } from 'react';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import {
  boardCode,
  DrawingBoardScreen,
  useCodeFailed,
} from '@/features/materials/blockCode';
import { CannotShow } from '@/features/materials/CannotShow';
import { stripMarks } from '@/features/questions/parseMarkedText';
import { QuestionBlockView } from '@/features/questions/QuestionView';
import type { CanvasBlock, QuestionBlock } from '@/features/questions/types';
import { m } from '@/i18n';
import { useOpenView } from '@/lib/openLink';
import type { Answer } from '../grade';
import { useBoardAhead } from './boardPrefetch';
import { CanvasFrame, canvasBoard, useBoardAsset } from './CanvasFrame';
import type { PinnedQuestion } from './DrawingBoardScreen';
import { storedDrawingId, useDrawingBoard } from './DrawingPreview';
import { DRAWING_DELETED, fetchDrawingPicture } from './drawingBoards';
import {
  DrawingDraftScope,
  DrawingUploader,
  type DrawingValue,
  drawingDraftKey,
  heldDrawingPictures,
  isDrawingValue,
} from './drawingValue';

/**
 * A Canvas part's canvas, answered in place (Epo 2026-11-23, S1, S2): the
 * part's canvas, or the stem's or group's its parts answer in (`hint` naming
 * them, `partId` the first's, which keeps the one drawing), with "Answer
 * inside the canvas" under it and Answer in Canvas centred below; once
 * answered, the answer drawn from its board, area only,
 * Answer in Canvas still under it; checked or read by staff (`review`), the answer (or the canvas,
 * when none) with Open canvas, the whole board read only. Answer in Canvas
 * opens the board full screen as a copy of the canvas, its parts the
 * question's and held as the teacher left them. A preview (`disabled`) shows
 * the buttons, taking no press. If the board's code could not load for a
 * press or Preview (an idle preload's failure leaves them), or the canvas
 * not yet answered on could not be fetched, the button is "This block cannot
 * be shown"; what is drawn stays (Epo 2026-11-20).
 */
export function CanvasAnswer({
  canvas,
  canvasName,
  disabled,
  hint = m.question_canvas_hint_student(),
  onChange,
  partId,
  pinned,
  review,
  value,
}: {
  /** The canvas the answer is drawn on, its question; none where only the
   * answer is read (results). */
  canvas?: CanvasBlock;
  /** Its name in the quiz (`canvasName`): its open board and device draft
   * are kept under it, whichever part its drawing is kept under. */
  canvasName: string;
  disabled: boolean;
  /** Under the canvas until answered: a shared canvas names its parts. */
  hint?: string;
  onChange: (value: Answer) => void;
  partId: string;
  pinned: PinnedQuestion;
  review: boolean;
  value: Answer;
}) {
  const scope = useContext(DrawingDraftScope);
  const upload = useContext(DrawingUploader);
  // In the page's URL where it keeps one (a canvas card's), so Back closes it.
  const [open, setOpen] = useOpenView(canvasName);
  const questionId = canvas && canvasBoard(canvas);
  const { board: question, failed: lost } = useBoardAsset(questionId);
  // The device's board, or the stored one once the server keeps it.
  const fetched = useDrawingBoard(value);
  const deleted = fetched === DRAWING_DELETED;
  const answer = deleted ? null : fetched;
  const storedId = storedDrawingId(value);
  const answered = isDrawingValue(value) || storedId !== null;
  const taking = !(review || disabled);
  // The board opens once what it opens from is here: the answer, else the
  // canvas it starts as.
  const ready = answered ? !!answer : !questionId || !!question;
  const ahead = useBoardAhead(taking && ready);
  // The board's code, or the canvas it starts as, could not load.
  const failed = useCodeFailed(boardCode) || (!answered && lost);
  // What the frame draws, and a read-only board opens.
  const shown = answered ? answer : question;
  const done = (next: DrawingValue | null) => {
    onChange(next);
    setOpen(false);
  };
  if (answered && deleted)
    return <p className="t-meta text-fg-muted">{m.drawing_answer_deleted()}</p>;
  // Read with nothing drawn, there is nothing to show.
  if (review && !(answered || questionId)) return null;
  // On the canvas: its notice, or a checked answer's Open canvas.
  const corner = failed ? (
    <CannotShow className="absolute top-2 right-2 rounded-input bg-surface px-2 py-1" />
  ) : (
    review &&
    shown && (
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
  );
  return (
    <div className="flex flex-col gap-1.5">
      <CanvasFrame
        board={shown}
        drawn={answered || !!questionId}
        label={answered ? m.drawing_answer_image() : m.question_ui_canvas()}
      >
        {corner}
      </CanvasFrame>
      {/* The hint under the canvas until answered, then Answer in Canvas
          centred under it, answered or not, so it never covers what is drawn
          (Epo 2026-11-23). */}
      {!(review || failed) && (
        <>
          {!answered && <p className="t-meta text-fg-muted">{hint}</p>}
          <Button
            className="mt-1 self-center"
            disabled={!(taking && ready)}
            iconLeft="pencil"
            onClick={() => setOpen(true)}
            size="md"
            variant="outline"
          >
            {m.question_canvas_answer()}
          </Button>
        </>
      )}
      {(open || ahead) && ready && (taking || review) && !failed && (
        <Suspense fallback={null}>
          <DrawingBoardScreen
            draft={
              taking && scope ? drawingDraftKey(scope, canvasName) : undefined
            }
            hidden={!open}
            onClose={() => setOpen(false)}
            onDone={taking ? done : undefined}
            pictures={{
              held: isDrawingValue(value)
                ? heldDrawingPictures(value)
                : undefined,
              load: storedId
                ? (id) => fetchDrawingPicture(storedId, id)
                : undefined,
            }}
            pinned={pinned}
            question={(taking && question) || undefined}
            readOnly={!taking}
            saved={
              (answered ? answer : taking ? undefined : question) ?? undefined
            }
            store={upload ? (next) => upload.store(partId, next) : undefined}
            withImage={upload?.withImage ?? true}
          />
        </Suspense>
      )}
    </div>
  );
}

/** A canvas answer as staff and results read it, outside the question runner
 * (R2, R3, S4): the answer drawn from its board, area only, with Open canvas,
 * the whole board read only. `blocks` are the part's text, pinned over the
 * board. */
export function ReviewedDrawing({
  blocks,
  marks,
  title,
  value,
}: {
  blocks: QuestionBlock[];
  marks: string;
  title: string;
  value: Answer;
}) {
  const first = blocks.find((block) => block.type === 'text');
  return (
    <CanvasAnswer
      canvasName=""
      disabled={false}
      onChange={() => undefined}
      partId=""
      pinned={{
        body: (
          <div className="flex flex-col gap-2 text-fg-secondary">
            {/* Its canvas is on the board. */}
            {blocks.map(
              (block, i) =>
                block.type !== 'canvas' && (
                  <QuestionBlockView block={block} key={i} />
                )
            )}
          </div>
        ),
        marks,
        short: title,
        summary: first?.type === 'text' ? stripMarks(first.text) : '',
        title,
      }}
      review
      value={value}
    />
  );
}

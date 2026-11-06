import {
  lazy,
  type ReactNode,
  Suspense,
  useContext,
  useEffect,
  useState,
} from 'react';
import { Button } from '@/components/ui/Button';
import { QuestionBlockView } from '@/features/questions/QuestionView';
import type { QuestionBlock } from '@/features/questions/types';
import { m } from '@/i18n';
import type { Answer } from '../grade';
import type { PinnedQuestion } from './DrawingBoardScreen';
import {
  DrawingPreview,
  storedDrawingId,
  useDrawingBoard,
} from './DrawingPreview';
import { DRAWING_DELETED } from './drawingBoards';
import {
  DrawingDraftScope,
  DrawingUploader,
  type DrawingValue,
  drawingDraftKey,
  isDrawingValue,
} from './drawingValue';

// BlockSuite loads only for a drawing part: the chunk (about 1.16 MB) is fetched
// when the part shows, in idle time, so Draw answer opens without waiting on it.
const loadBoard = () => import('./DrawingBoardScreen');
const DrawingBoardScreen = lazy(loadBoard);

function usePrefetchedBoard() {
  useEffect(() => {
    const idle = window.requestIdleCallback ?? ((run) => setTimeout(run, 200));
    const cancel = window.cancelIdleCallback ?? clearTimeout;
    const handle = idle(() => void loadBoard().catch(() => undefined));
    return () => cancel(handle);
  }, []);
}

/**
 * A drawing part's answer area. Before drawing, one generic squared grid with
 * Draw answer (E1, Epo 2026-11-06); after Done, the drawing with Edit drawing
 * (D1); checked, the drawing under its verdict with Open drawing, which opens
 * the whole board read only (R1, R4).
 */
export function DrawingAnswer({
  disabled,
  onChange,
  partId,
  pinned,
  review,
  value,
  verdict,
}: {
  disabled: boolean;
  onChange: (value: Answer) => void;
  partId: string;
  pinned: PinnedQuestion;
  review: boolean;
  value: Answer;
  /** Checked: the part's verdict line, above the drawing. */
  verdict?: ReactNode;
}) {
  const scope = useContext(DrawingDraftScope);
  const upload = useContext(DrawingUploader);
  const [open, setOpen] = useState(false);
  // The device's board, or the stored one once the server keeps it.
  const fetched = useDrawingBoard(value);
  const deleted = fetched === DRAWING_DELETED;
  const board = deleted ? null : fetched;
  const answered = isDrawingValue(value) || storedDrawingId(value) !== null;
  usePrefetchedBoard();
  const taking = !(review || disabled);
  const close = () => setOpen(false);
  const done = (next: DrawingValue | null) => {
    onChange(next);
    setOpen(false);
  };
  return (
    <div className="flex flex-col items-start gap-3">
      {verdict}
      {answered ? (
        deleted ? (
          <p className="t-meta text-fg-muted">{m.drawing_answer_deleted()}</p>
        ) : (
          board && <DrawingPreview board={board} />
        )
      ) : review ? null : (
        // A generic grid, the same for every drawing part.
        <div className="drawing-grid relative aspect-[52/30] w-full max-w-[520px]">
          {taking && (
            <Button
              className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2"
              iconLeft="pencil"
              onClick={() => setOpen(true)}
              variant="outline"
            >
              {m.drawing_answer_draw()}
            </Button>
          )}
        </div>
      )}
      {answered && taking && (
        <Button
          iconLeft="pencil"
          onClick={() => setOpen(true)}
          variant="outline"
        >
          {m.drawing_answer_edit()}
        </Button>
      )}
      {board && review && (
        <Button
          iconRight="navigationForward"
          onClick={() => setOpen(true)}
          size="sm"
          variant="outline"
        >
          {m.drawing_answer_open()}
        </Button>
      )}
      {open && (
        <Suspense fallback={null}>
          <DrawingBoardScreen
            draft={taking && scope ? drawingDraftKey(scope, partId) : undefined}
            onClose={close}
            onDone={taking ? done : undefined}
            pinned={pinned}
            readOnly={!taking}
            saved={board ?? undefined}
            store={upload ? (next) => upload(partId, next) : undefined}
          />
        </Suspense>
      )}
    </div>
  );
}

/** A drawing answer as staff and results read it, outside the question runner:
 * the drawing drawn from its board, and Open drawing, the whole board read only
 * (R2, R3, Epo 2026-11-06). `blocks` are the part's text, pinned over the board. */
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
    <DrawingAnswer
      disabled={false}
      onChange={() => undefined}
      partId=""
      pinned={{
        body: (
          <div className="flex flex-col gap-2 text-fg-secondary">
            {blocks.map((block, i) => (
              <QuestionBlockView block={block} key={i} />
            ))}
          </div>
        ),
        marks,
        short: title,
        summary: first?.type === 'text' ? first.text : '',
        title,
      }}
      review
      value={value}
    />
  );
}
